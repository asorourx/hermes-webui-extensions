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
  if (window.__hermesUserAvatarLoaded) return;
  window.__hermesUserAvatarLoaded = true;

  // Owned storage keys (declared in extension.json permissions.storage.owned:true).
  const IMAGE_KEY = 'hermes-ext-user-avatar';            // downscaled data-URL, or empty
  const FALLBACK = {                                     // used only when the sanctioned
    enabled: 'hermes-ext-user-avatar-enabled',          // settings system is unavailable
    size: 'hermes-ext-user-avatar-size',
    mobile: 'hermes-ext-user-avatar-mobile',
  };
  const ROW_ATTR = 'data-hwx-uav';
  const ROW_SELECTOR = '.msg-row[data-role="user"]';
  const SIZES = { small: 24, medium: 32, large: 44 };
  const MAX_DIM = 96;                                    // stored thumbnail is at most 96×96
  const MAX_BYTES = 128 * 1024;
  const RECONCILE_MS = 1500;

  function warn(msg) { try { console.warn('[' + EXT + '] ' + msg); } catch (_) {} }

  // ── scoped settings (graceful degrade to localStorage on older core) ──────
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

  function isDataImage(s) {
    return typeof s === 'string'
      && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
  }
  function getImage() {
    try { const v = localStorage.getItem(IMAGE_KEY) || ''; return isDataImage(v) ? v : ''; }
    catch (_) { return ''; }
  }
  function setImage(dataUrl) {
    try {
      if (dataUrl && isDataImage(dataUrl)) localStorage.setItem(IMAGE_KEY, dataUrl);
      else localStorage.removeItem(IMAGE_KEY);
    } catch (_) {}
    apply();
  }

  // ── apply state to the document (attributes + custom properties only) ─────
  const rootEl = document.documentElement;

  function markRows() {
    let rows;
    try { rows = document.querySelectorAll(ROW_SELECTOR + ':not([' + ROW_ATTR + '])'); }
    catch (_) { return; }
    rows.forEach((row) => { try { row.setAttribute(ROW_ATTR, '1'); } catch (_) {} });
  }
  function unmarkRows() {
    let rows;
    try { rows = document.querySelectorAll(ROW_SELECTOR + '[' + ROW_ATTR + ']'); }
    catch (_) { return; }
    rows.forEach((row) => { try { row.removeAttribute(ROW_ATTR); } catch (_) {} });
  }

  function apply() {
    const on = isEnabled();
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
    markRows();
  }

  // ── observe transcript for newly created user rows ───────────────────────
  let observer = null;
  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; try { if (isEnabled()) markRows(); } catch (_) {} });
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
  function reconcile() {
    const sig = [isEnabled(), sizeName(), mobileMode(), getImage() ? 1 : 0].join('|');
    if (sig !== lastSig) { lastSig = sig; apply(); }
  }
  function startReconcile() {
    if (reconcileTimer) return;
    lastSig = [isEnabled(), sizeName(), mobileMode(), getImage() ? 1 : 0].join('|');
    reconcileTimer = setInterval(reconcile, RECONCILE_MS);
  }
  function onStorage(ev) {
    if (!ev) { apply(); return; }
    if (ev.key === IMAGE_KEY || ev.key === FALLBACK.enabled
        || ev.key === FALLBACK.size || ev.key === FALLBACK.mobile) {
      apply();
    }
  }

  // ── image handling: downscale to a small square data-URL, in-browser ─────
  function downscale(file, cb) {
    if (!file || !/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
      cb(null, 'Please choose a PNG, JPEG, GIF, or WebP image.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) { cb(null, 'Image too large (max 8 MB).'); return; }
    const reader = new FileReader();
    reader.onerror = () => cb(null, 'Could not read the file.');
    reader.onload = () => {
      const im = new Image();
      im.onerror = () => cb(null, 'Could not decode the image.');
      im.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = MAX_DIM; canvas.height = MAX_DIM;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(MAX_DIM / im.width, MAX_DIM / im.height);
          const w = im.width * scale, h = im.height * scale;
          ctx.drawImage(im, (MAX_DIM - w) / 2, (MAX_DIM - h) / 2, w, h);
          let out = canvas.toDataURL('image/png');
          if (out.length > MAX_BYTES) out = canvas.toDataURL('image/jpeg', 0.85);
          if (out.length > MAX_BYTES || !isDataImage(out)) {
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

  // ── Configure panel (Settings → Extensions → Custom User Avatar) ─────────
  const PANEL_ID = 'hwx-uav-panel';
  function buildPanel(host, done) {
    const panel = document.createElement('div');
    panel.className = 'hwx-uav-panel';
    panel.id = PANEL_ID;

    const h = document.createElement('h3');
    h.textContent = 'Custom User Avatar';
    panel.appendChild(h);

    const hint = document.createElement('p');
    hint.className = 'hwx-uav-hint';
    hint.textContent = 'Show an avatar beside your own messages. Off by default. '
      + 'The image is downscaled and stored only in this browser — it never leaves the '
      + 'device and is not written to your profile, personality, or core settings.';
    panel.appendChild(hint);

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
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
    fileInput.style.display = 'none';
    uploadBtn.addEventListener('click', () => fileInput.click());
    previewWrap.appendChild(uploadBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'hwx-uav-btn hwx-uav-btn--clear';
    clearBtn.textContent = 'Remove';
    clearBtn.addEventListener('click', () => {
      setImage('');
      refreshPreview();
      uploadBtn.textContent = 'Upload image…';
      status.textContent = 'Image removed.';
    });
    previewWrap.appendChild(clearBtn);
    previewWrap.appendChild(fileInput);
    panel.appendChild(previewWrap);

    const status = document.createElement('div');
    status.className = 'hwx-uav-status';

    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      status.textContent = 'Processing…';
      downscale(f, (dataUrl, err) => {
        if (err) { status.textContent = err; return; }
        setImage(dataUrl);
        refreshPreview();
        uploadBtn.textContent = 'Change image…';
        status.textContent = 'Saved.';
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
    panel.appendChild(enableRow);

    // size + mobile selects
    panel.appendChild(makeSelect('Avatar size', [
      ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'],
    ], sizeName(), (v) => { writeScalar('size', FALLBACK.size, v); apply(); }));

    panel.appendChild(makeSelect('On narrow screens', [
      ['hide', 'Hide'], ['compact', 'Compact'],
    ], mobileMode(), (v) => { writeScalar('mobile', FALLBACK.mobile, v); apply(); }));

    panel.appendChild(status);

    host.appendChild(panel);
    if (typeof done === 'function') {
      const closeObs = new MutationObserver(() => {
        if (!host.contains(panel)) { closeObs.disconnect(); done(); }
      });
      try { closeObs.observe(host, { childList: true, subtree: true }); } catch (_) {}
    }
    enableBox.focus();
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
      settings.registerConfigure((host) => new Promise((resolve) => {
        const mount = (host && host.nodeType === 1) ? host : document.body;
        buildPanel(mount, resolve);
        // If the host is torn down without our observer catching it, don't hang.
        if (!document.getElementById(PANEL_ID)) resolve();
      }));
    } catch (_) {}
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  function teardown() {
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = 0; }
    try { window.removeEventListener('storage', onStorage); } catch (_) {}
    rootEl.removeAttribute('data-hwx-uav-on');
    rootEl.removeAttribute('data-hwx-uav-mobile');
    rootEl.style.removeProperty('--hwx-uav-img');
    rootEl.style.removeProperty('--hwx-uav-size');
    unmarkRows();
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.getElementById('messages') || document.querySelector(ROW_SELECTOR)) {
      startObserver();
      startReconcile();
      try { window.addEventListener('storage', onStorage); } catch (_) {}
      apply();
      registerConfigure();
      window.HermesUserAvatarExtension = Object.freeze({
        version: '0.1.0',
        settingsBackend: settingsSupported ? 'hermes-settings' : 'localStorage',
        isEnabled,
        setEnabled: (on) => { writeScalar('enabled', FALLBACK.enabled, !!on); apply(); return isEnabled(); },
        getImage,
        setImage: (dataUrl) => { if (isDataImage(dataUrl)) setImage(dataUrl); return getImage(); },
        clearImage: () => setImage(''),
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
