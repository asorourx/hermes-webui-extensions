(() => {
  'use strict';

  // ── Custom User Avatar extension for Hermes WebUI ────────────────────────
  // Optional, disabled-by-default decoration that puts an avatar beside each
  // right-aligned USER turn. Hermes WebUI renders no avatar element on user
  // turns (position identifies the sender), so this is an explicitly unstable
  // DOM-mutation contract: it decorates real, visible user rows and no-ops (no
  // errors) if the transcript markup changes.
  //
  // Rendering: the extension NEVER injects child nodes into a user row. Core
  // rebuilds a row's innerHTML whenever it changes and skips unchanged rows;
  // an injected child would defeat that skip and be wiped on the next reconcile.
  // Instead it sets only element-level state core does not reconcile — a per-row
  // [data-hwx-uav] attribute and custom properties on :root — and the avatar is
  // drawn by a ::before pseudo-element (see user-avatar.css). Because attributes
  // survive innerHTML rebuilds and row recycling, decoration is inherently
  // idempotent and the MutationObserver only has to mark newly created rows.
  //
  // This is a sibling to `custom-avatar` (assistant) and independent of
  // `profile-avatars`; it does NOT read, write, or shadow their storage.
  // Pure client-side: no network, no sidecar, no core writes.

  const EXT = 'user-avatar';
  const VERSION = '0.2.0';
  if (window.__hermesUserAvatarLoaded) return;
  window.__hermesUserAvatarLoaded = true;

  // Owned storage (declared in extension.json permissions.storage.owned:true).
  // The image lives in the sanctioned scoped namespace so that Settings →
  // "Clear extension storage" and uninstall actually remove it. LEGACY_IMAGE_KEY
  // is the pre-0.2.0 raw key: read once, migrated, then deleted.
  const IMAGE_NAME = 'image';
  const LEGACY_IMAGE_KEY = 'hermes-ext-user-avatar';
  const FALLBACK = {                                     // used only when the sanctioned
    enabled: 'hermes-ext-user-avatar-enabled',          // settings system is unavailable
    size: 'hermes-ext-user-avatar-size',
    mobile: 'hermes-ext-user-avatar-mobile',
  };
  const ROW_ATTR = 'data-hwx-uav';
  const ROW_SELECTOR = '.msg-row[data-role="user"]';
  const SIZES = { small: 24, medium: 32, large: 44 };
  const MAX_DIM = 96;                                    // stored thumbnail is at most 96×96
  const MAX_BYTES = 128 * 1024;                          // cap on the stored data-URL
  // Source bounds, checked BEFORE any canvas work. A small compressed file can
  // still decode to an enormous bitmap, so bytes alone are not a bound. These
  // match the Profile Avatars boundary.
  const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
  const MAX_SOURCE_SIDE = 4096;
  const MAX_SOURCE_PIXELS = 16 * 1024 * 1024;
  // Issue #63 scopes this to PNG/JPEG/WebP. GIF is deliberately not accepted:
  // canonicalizing an animated GIF to a still first frame is a different feature.
  const ACCEPT_TYPES = /^image\/(png|jpeg|webp)$/;
  const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp';
  const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const RECONCILE_MS = 1500;

  function warn(msg) { try { console.warn('[' + EXT + '] ' + msg); } catch (_) {} }

  // ── scoped settings + storage (graceful degrade on older core) ────────────
  const scoped = (() => {
    const api = window.hermesExt;
    if (!api || typeof api.register !== 'function') return null;
    let ext;
    try { ext = api.register(EXT); } catch (_) { return null; }
    if (!ext || ext.id !== EXT) return null;
    return ext;
  })();
  const settings = scoped && scoped.settings;
  const settingsSupported = !!(settings
    && typeof settings.get === 'function'
    && typeof settings.set === 'function'
    && settings.supported !== false);
  const storage = scoped && scoped.storage;
  const storageSupported = !!(storage
    && typeof storage.get === 'function'
    && typeof storage.set === 'function'
    && typeof storage.remove === 'function');

  function readScalar(key, fallbackKey, dflt) {
    if (settingsSupported) {
      try {
        const v = settings.get(key);
        if (v !== undefined && v !== null) return v;
      } catch (_) {}
    }
    try {
      const raw = localStorage.getItem(fallbackKey);
      if (raw !== null) {
        if (dflt === true || dflt === false) return raw === 'true';
        return raw;
      }
    } catch (_) {}
    return dflt;
  }
  function writeScalar(key, fallbackKey, value) {
    let ok = false;
    if (settingsSupported) {
      try {
        const res = settings.set(key, value);
        ok = !!(res && typeof res === 'object' ? res.ok === true : res !== false);
      } catch (_) {}
    }
    try { localStorage.setItem(fallbackKey, String(value)); } catch (_) {}
    return ok || !settingsSupported;
  }

  function isEnabled() { return readScalar('enabled', FALLBACK.enabled, false) !== false; }
  function sizeName() {
    const s = readScalar('size', FALLBACK.size, 'medium');
    return SIZES[s] ? s : 'medium';
  }
  function mobileMode() {
    const m = readScalar('mobile', FALLBACK.mobile, 'hide');
    return (m === 'compact' || m === 'hide') ? m : 'hide';
  }

  // ── image storage: sanctioned scoped namespace, one publication path ──────
  function isDataImage(s) {
    return typeof s === 'string' && s.length <= MAX_BYTES && DATA_URL_RE.test(s);
  }
  function getImage() {
    if (storageSupported) {
      try { const v = storage.get(IMAGE_NAME, ''); return isDataImage(v) ? v : ''; }
      catch (_) { return ''; }
    }
    try { const v = localStorage.getItem(LEGACY_IMAGE_KEY) || ''; return isDataImage(v) ? v : ''; }
    catch (_) { return ''; }
  }

  // Move a pre-0.2.0 raw-key image into scoped storage exactly once, and only
  // drop the raw key once the scoped write succeeded (or the value was junk /
  // already superseded). Never leaves the image unreachable.
  function migrateLegacyImage() {
    if (!storageSupported) return;
    let legacy = '';
    try { legacy = localStorage.getItem(LEGACY_IMAGE_KEY) || ''; } catch (_) { return; }
    if (!legacy) return;
    let done = true;
    if (isDataImage(legacy) && !getImage()) {
      try { done = storage.set(IMAGE_NAME, legacy) !== false; } catch (_) { done = false; }
    }
    if (done) { try { localStorage.removeItem(LEGACY_IMAGE_KEY); } catch (_) {} }
  }

  // The ONLY writer. Returns a real result; on failure the previously stored
  // image is left untouched, because nothing is written unless the store accepts it.
  function publishImage(dataUrl) {
    const value = dataUrl || '';
    if (value && !isDataImage(value)) {
      return { ok: false, error: 'That image could not be stored (unsupported or too large).' };
    }
    let ok = false;
    if (storageSupported) {
      try { ok = (value ? storage.set(IMAGE_NAME, value) : storage.remove(IMAGE_NAME)) !== false; }
      catch (_) { ok = false; }
    } else {
      try {
        if (value) localStorage.setItem(LEGACY_IMAGE_KEY, value);
        else localStorage.removeItem(LEGACY_IMAGE_KEY);
        ok = true;
      } catch (_) { ok = false; }
    }
    apply();
    if (!ok) {
      return { ok: false, error: 'Could not save — browser storage is full or unavailable.' };
    }
    return { ok: true, image: getImage() };
  }

  // ── apply state to the document (attributes + custom properties only) ─────
  const rootEl = document.documentElement;

  function markRows() {
    let rows;
    try { rows = document.querySelectorAll(ROW_SELECTOR + ':not([' + ROW_ATTR + '])'); }
    catch (_) { return; }
    rows.forEach((row) => { try { row.setAttribute(ROW_ATTR, '1'); } catch (_) {} });
  }
  // Rows are recycled: a node marked while it was a user turn can come back as
  // another role. Drop the marker from anything that is no longer a user row.
  function pruneRows() {
    let marked;
    try { marked = document.querySelectorAll('[' + ROW_ATTR + ']'); }
    catch (_) { return; }
    marked.forEach((el) => {
      let stillUser = false;
      try { stillUser = typeof el.matches === 'function' && el.matches(ROW_SELECTOR); }
      catch (_) { stillUser = false; }
      if (!stillUser) { try { el.removeAttribute(ROW_ATTR); } catch (_) {} }
    });
  }
  // Teardown/disable must clear the marker from EVERY element that carries it,
  // regardless of what role it holds now.
  function unmarkRows() {
    let marked;
    try { marked = document.querySelectorAll('[' + ROW_ATTR + ']'); }
    catch (_) { return; }
    marked.forEach((el) => { try { el.removeAttribute(ROW_ATTR); } catch (_) {} });
  }

  let installed = false;

  function apply() {
    const on = installed && isEnabled();
    if (!on) {
      rootEl.removeAttribute('data-hwx-uav-on');
      rootEl.style.removeProperty('--hwx-uav-img');
      rootEl.style.removeProperty('--hwx-uav-size');
      rootEl.removeAttribute('data-hwx-uav-mobile');
      unmarkRows();
      return;
    }
    const img = getImage();
    rootEl.style.setProperty('--hwx-uav-size', SIZES[sizeName()] + 'px');
    rootEl.style.setProperty('--hwx-uav-img', img ? 'url("' + img + '")' : 'none');
    rootEl.setAttribute('data-hwx-uav-mobile', mobileMode());
    rootEl.setAttribute('data-hwx-uav-on', '1');
    pruneRows();
    markRows();
  }

  // ── observe transcript for newly created user rows ───────────────────────
  let observer = null;
  let raf = 0;
  function schedule() {
    if (raf || !installed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!installed) return;
      try { if (isEnabled()) { pruneRows(); markRows(); } } catch (_) {}
    });
  }
  function startObserver() {
    if (observer) return;
    const container = document.getElementById('messages') || document.body;
    // childList/subtree only — we never mutate child nodes, so this cannot self-loop.
    observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
  }

  // Pick up settings changes made in the native Settings → Extensions form
  // (no core change event is exposed) without a re-render, cheaply.
  let reconcileTimer = 0;
  let lastSig = '';
  function signature() {
    return [isEnabled(), sizeName(), mobileMode(), getImage() ? 1 : 0].join('|');
  }
  function reconcile() {
    if (!installed) return;
    const sig = signature();
    if (sig !== lastSig) { lastSig = sig; apply(); }
  }
  function startReconcile() {
    if (reconcileTimer) return;
    lastSig = signature();
    reconcileTimer = setInterval(reconcile, RECONCILE_MS);
  }
  function onStorage(ev) {
    if (!installed) return;
    if (!ev) { apply(); return; }
    if (ev.key === LEGACY_IMAGE_KEY || ev.key === FALLBACK.enabled
        || ev.key === FALLBACK.size || ev.key === FALLBACK.mobile
        || (typeof ev.key === 'string' && ev.key.indexOf('hermes.ext.storage.') === 0)) {
      apply();
    }
  }

  // ── image handling: one private canonicalization path ─────────────────────
  // Bounds the SOURCE (type, bytes, decoded dimensions/pixels) before any canvas
  // work, then always emits a bounded square PNG/JPEG data-URL. Nothing else may
  // write the image — there is no raw synchronous setter on the public API.
  function canonicalize(file, cb) {
    if (!file || !ACCEPT_TYPES.test(file.type || '')) {
      cb(null, 'Please choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (typeof file.size === 'number' && file.size > MAX_SOURCE_BYTES) {
      cb(null, 'Image too large (max 8 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => cb(null, 'Could not read the file.');
    reader.onload = () => {
      const im = new Image();
      im.onerror = () => cb(null, 'Could not decode the image.');
      im.onload = () => {
        const sw = Number(im.naturalWidth || im.width) || 0;
        const sh = Number(im.naturalHeight || im.height) || 0;
        if (!sw || !sh) { cb(null, 'The image has invalid dimensions.'); return; }
        if (sw > MAX_SOURCE_SIDE || sh > MAX_SOURCE_SIDE || sw * sh > MAX_SOURCE_PIXELS) {
          cb(null, 'Image dimensions are too large (max 4096px / 16 megapixels).');
          return;
        }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = MAX_DIM; canvas.height = MAX_DIM;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(MAX_DIM / sw, MAX_DIM / sh);
          const w = sw * scale, h = sh * scale;
          ctx.drawImage(im, (MAX_DIM - w) / 2, (MAX_DIM - h) / 2, w, h);
          let out = canvas.toDataURL('image/png');
          if (!isDataImage(out)) out = canvas.toDataURL('image/jpeg', 0.85);
          if (!isDataImage(out)) {
            cb(null, 'Image could not be reduced small enough.');
            return;
          }
          cb(out, null);
        } catch (_) { cb(null, 'Image processing failed.'); }
      };
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Canonicalize then publish. Resolves {ok, image} / {ok:false, error}; never rejects.
  function setImageFile(file) {
    return new Promise((resolve) => {
      canonicalize(file, (dataUrl, err) => {
        if (err) { resolve({ ok: false, error: err }); return; }
        resolve(publishImage(dataUrl));
      });
    });
  }
  function clearImage() { return publishImage(''); }

  // ── Configure: an extension-owned modal, settled exactly once ─────────────
  // Core invokes the handler with ONE frozen options object ({opener,
  // restoreFocus}) — never a DOM host — and the returned promise owns the
  // pending state. Core restores opener focus when it settles, so the panel
  // must not compete for focus restoration on close.
  const PANEL_ID = 'hwx-uav-panel';
  let configureSettle = null;
  let panelKeydown = null;

  function settleConfigure() {
    const fn = configureSettle;
    configureSettle = null;
    if (fn) { try { fn(); } catch (_) {} }
  }

  function panelCard() {
    try { return document.getElementById(PANEL_ID); } catch (_) { return null; }
  }

  function focusableControls(panel) {
    let list = [];
    try {
      const found = panel.querySelectorAll('button, select, input:not([type="file"])');
      list = Array.prototype.slice.call(found || []);
    } catch (_) { return []; }
    return list.filter((el) => el && !el.disabled && !el.hidden);
  }

  function focusPanel(panel) {
    const controls = focusableControls(panel);
    const target = controls[0];
    if (target && typeof target.focus === 'function') { try { target.focus(); } catch (_) {} }
  }

  function onPanelKeydown(ev) {
    const panel = panelCard();
    if (!panel || !ev) return;
    if (ev.key === 'Escape') {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
      closePanel();
      return;
    }
    if (ev.key !== 'Tab') return;
    const controls = focusableControls(panel);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    let active = null;
    try { active = document.activeElement; } catch (_) {}
    let inside = false;
    try { inside = typeof panel.contains === 'function' && panel.contains(active); } catch (_) {}
    if (!inside) {
      try { ev.preventDefault(); } catch (_) {}
      (ev.shiftKey ? last : first).focus();
      return;
    }
    if (ev.shiftKey && active === first) { try { ev.preventDefault(); } catch (_) {} last.focus(); }
    else if (!ev.shiftKey && active === last) { try { ev.preventDefault(); } catch (_) {} first.focus(); }
  }

  function closePanel() {
    const panel = panelCard();
    if (panel && typeof panel.remove === 'function') { try { panel.remove(); } catch (_) {} }
    if (panelKeydown) {
      try { document.removeEventListener('keydown', panelKeydown, true); } catch (_) {}
      panelKeydown = null;
    }
    settleConfigure();
  }

  function openPanel() {
    const existing = panelCard();
    if (existing) { focusPanel(existing); return true; }
    if (!document.body) return false;
    let overlay;
    try { overlay = buildPanel(); } catch (_) { return false; }
    if (!overlay) return false;
    try { document.body.appendChild(overlay); } catch (_) { return false; }
    panelKeydown = onPanelKeydown;
    try { document.addEventListener('keydown', panelKeydown, true); } catch (_) { panelKeydown = null; }
    focusPanel(overlay);
    return true;
  }

  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.className = 'hwx-uav-overlay';
    overlay.id = PANEL_ID;
    overlay.addEventListener('click', (ev) => { if (ev && ev.target === overlay) closePanel(); });

    const card = document.createElement('div');
    card.className = 'hwx-uav-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Custom User Avatar');
    overlay.appendChild(card);

    const head = document.createElement('div');
    head.className = 'hwx-uav-head';
    const title = document.createElement('span');
    title.className = 'hwx-uav-title';
    title.textContent = 'Custom User Avatar';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'hwx-uav-x';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePanel);
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const hint = document.createElement('p');
    hint.className = 'hwx-uav-hint';
    hint.textContent = 'Show an avatar beside your own messages. Off by default. '
      + 'The image is downscaled and stored only in this browser — it never leaves the '
      + 'device and is not written to your profile, personality, or core settings.';
    card.appendChild(hint);

    const status = document.createElement('div');
    status.className = 'hwx-uav-status';
    status.setAttribute('role', 'status');

    // preview + upload/clear
    const previewWrap = document.createElement('div');
    previewWrap.className = 'hwx-uav-preview-wrap';
    const preview = document.createElement('div');
    preview.className = 'hwx-uav-preview';
    const refreshPreview = () => {
      const img = getImage();
      preview.style.backgroundImage = img ? 'url("' + img + '")' : 'none';
    };
    refreshPreview();
    previewWrap.appendChild(preview);

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'hwx-uav-btn';
    uploadBtn.textContent = getImage() ? 'Change image…' : 'Upload image…';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = ACCEPT_ATTR;
    fileInput.className = 'hwx-uav-file';
    uploadBtn.addEventListener('click', () => fileInput.click());
    previewWrap.appendChild(uploadBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'hwx-uav-btn hwx-uav-btn--clear';
    clearBtn.textContent = 'Remove';
    clearBtn.addEventListener('click', () => {
      const res = clearImage();
      refreshPreview();
      uploadBtn.textContent = getImage() ? 'Change image…' : 'Upload image…';
      status.textContent = res.ok ? 'Image removed.' : res.error;
    });
    previewWrap.appendChild(clearBtn);
    previewWrap.appendChild(fileInput);
    card.appendChild(previewWrap);

    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      status.textContent = 'Processing…';
      setImageFile(f).then((res) => {
        refreshPreview();
        uploadBtn.textContent = getImage() ? 'Change image…' : 'Upload image…';
        // A failed publication keeps the previous image; say so instead of "Saved."
        status.textContent = res.ok ? 'Saved.' : res.error;
      });
    });

    // enable toggle
    const enableRow = document.createElement('label');
    enableRow.className = 'hwx-uav-check';
    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = isEnabled();
    const enableTxt = document.createElement('span');
    enableTxt.textContent = 'Show avatars on my messages';
    enableRow.appendChild(enableBox);
    enableRow.appendChild(enableTxt);
    enableBox.addEventListener('change', () => {
      writeScalar('enabled', FALLBACK.enabled, enableBox.checked);
      apply();
    });
    card.appendChild(enableRow);

    // size + mobile selects
    card.appendChild(makeSelect('Avatar size', [
      ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'],
    ], sizeName(), (v) => { writeScalar('size', FALLBACK.size, v); apply(); }));

    card.appendChild(makeSelect('On narrow screens', [
      ['hide', 'Hide'], ['compact', 'Compact'],
    ], mobileMode(), (v) => { writeScalar('mobile', FALLBACK.mobile, v); apply(); }));

    card.appendChild(status);
    return overlay;
  }

  function makeSelect(label, options, current, onChange) {
    const row = document.createElement('div');
    row.className = 'hwx-uav-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const id = 'hwx-uav-' + label.replace(/[^a-z]+/gi, '-').toLowerCase();
    lab.setAttribute('for', id);
    const select = document.createElement('select');
    select.className = 'hwx-uav-select';
    select.id = id;
    options.forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = text;
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(lab);
    row.appendChild(select);
    return row;
  }

  function registerConfigure() {
    if (!settings || typeof settings.registerConfigure !== 'function') return;
    try {
      settings.registerConfigure(() => new Promise((resolve) => {
        let opened = false;
        try { opened = openPanel(); } catch (_) { opened = false; }
        // Could not open, or an earlier invocation still owns settlement:
        // settle this one now so Core never hangs in "Opening…".
        if (!opened || configureSettle) { resolve(); return; }
        let done = false;
        configureSettle = () => {
          if (done) return;
          done = true;
          resolve();
        };
      }));
    } catch (_) {}
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  function teardown() {
    installed = false;                       // makes queued callbacks inert
    if (raf) { try { cancelAnimationFrame(raf); } catch (_) {} raf = 0; }
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    if (reconcileTimer) { try { clearInterval(reconcileTimer); } catch (_) {} reconcileTimer = 0; }
    try { window.removeEventListener('storage', onStorage); } catch (_) {}
    closePanel();                            // removes the modal and settles Configure
    rootEl.removeAttribute('data-hwx-uav-on');
    rootEl.removeAttribute('data-hwx-uav-mobile');
    rootEl.style.removeProperty('--hwx-uav-img');
    rootEl.style.removeProperty('--hwx-uav-size');
    unmarkRows();
    lastSig = '';
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.getElementById('messages') || document.querySelector(ROW_SELECTOR)) {
      installed = true;
      migrateLegacyImage();
      startObserver();
      startReconcile();
      try { window.addEventListener('storage', onStorage); } catch (_) {}
      apply();
      registerConfigure();
      window.HermesUserAvatarExtension = Object.freeze({
        version: VERSION,
        settingsBackend: settingsSupported ? 'hermes-settings' : 'localStorage',
        storageBackend: storageSupported ? 'hermes-ext-storage' : 'localStorage',
        isEnabled,
        setEnabled: (on) => { writeScalar('enabled', FALLBACK.enabled, !!on); apply(); return isEnabled(); },
        getImage,
        setImageFile,                        // canonicalizing, async — the only writer
        clearImage,
        refresh: apply,
        teardown,
      });
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    warn('messages container not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
