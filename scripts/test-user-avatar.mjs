#!/usr/bin/env node
// Behavior tests for the `user-avatar` extension. Runs the real asset in a node:vm
// sandbox with a fake DOM (same approach as test-mobile-haptics.mjs), and asserts the
// load-bearing contracts: disabled by default, enable/size/mobile/image application via
// root attributes + custom properties only, NO child nodes injected into user rows,
// idempotency, and full teardown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(
  path.join(repoRoot, 'extensions/user-avatar/assets/user-avatar.js'),
  'utf8'
);

class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(k, v) { this.props.set(k, String(v)); }
  removeProperty(k) { this.props.delete(k); }
  getPropertyValue(k) { return this.props.get(k) || ''; }
}

class FakeEl {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.attrs = new Map();
    this.style = new FakeStyle();
    this.children = [];     // asserted to stay empty for user rows
    this.listeners = {};
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  focus() {}
  querySelector() { return null; }
  contains() { return false; }
  get nodeType() { return 1; }
}

function createHarness({ settingsSupported = true } = {}) {
  const store = new Map();               // localStorage
  const settingsBackend = new Map([['enabled', undefined], ['size', undefined], ['mobile', undefined]]);
  const intervals = [];
  const rafs = [];
  const observers = [];
  let configureHook = null;

  const settings = settingsSupported ? {
    supported: true,
    get(key) { return settingsBackend.get(key); },
    set(key, value) { settingsBackend.set(key, value); return { ok: true }; },
    registerConfigure(fn) { configureHook = fn; },
  } : undefined;

  const hermesExt = {
    register(id) { return { id, settings }; },
  };

  const rootEl = new FakeEl('html');
  const messages = new FakeEl('div');

  // user rows the fake transcript exposes
  const userRows = [makeUserRow(), makeUserRow(), makeUserRow()];
  function makeUserRow() {
    const r = new FakeEl('div');
    r.attrs.set('data-role', 'user');
    return r;
  }

  function matchRows(selector) {
    // supports the three forms the extension uses
    const wantMarked = selector.includes('[data-hwx-uav]') && !selector.includes(':not(');
    const wantUnmarked = selector.includes(':not([data-hwx-uav])');
    return userRows.filter((r) => {
      if (wantMarked) return r.hasAttribute('data-hwx-uav');
      if (wantUnmarked) return !r.hasAttribute('data-hwx-uav');
      return true;
    });
  }

  const document = {
    readyState: 'complete',
    documentElement: rootEl,
    addEventListener() {},
    getElementById(id) { return id === 'messages' ? messages : null; },
    querySelector(sel) { const m = matchRows(sel); return m[0] || null; },
    querySelectorAll(sel) { return matchRows(sel); },
    createElement(tag) { return new FakeEl(tag); },
    body: new FakeEl('body'),
  };

  const windowListeners = {};
  const window = {
    document,
    hermesExt,
    addEventListener(t, fn) { (windowListeners[t] = windowListeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = windowListeners[t]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
  };

  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }

  const context = {
    window,
    document,
    localStorage,
    MutationObserver,
    console: { warn() {}, info() {}, log() {}, error() {} },
    requestAnimationFrame(cb) { rafs.push(cb); return rafs.length; },
    cancelAnimationFrame() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'user-avatar.js' });

  return {
    context, window, rootEl, userRows, store, settingsBackend,
    intervals, observers, windowListeners,
    api: () => window.HermesUserAvatarExtension,
    configure: () => configureHook,
  };
}

function noChildrenInjected(h) {
  return h.userRows.every((r) => r.children.length === 0);
}

// ── disabled by default ─────────────────────────────────────────────────────
{
  const h = createHarness();
  assert.ok(h.api(), 'extension must expose window.HermesUserAvatarExtension');
  assert.equal(h.api().isEnabled(), false, 'must be disabled by default');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null,
    'root must not carry data-hwx-uav-on when disabled');
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')),
    'no user row may be marked when disabled');
  assert.ok(noChildrenInjected(h), 'must never inject child nodes into user rows');
}

// ── enabling decorates via attributes + custom properties only ──────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), '1', 'enabling sets the root flag');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '32px',
    'default (medium) size maps to 32px');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), 'hide',
    'default narrow-screen mode is hide');
  assert.ok(h.userRows.every((r) => r.getAttribute('data-hwx-uav') === '1'),
    'every visible user row is marked when enabled');
  assert.ok(noChildrenInjected(h), 'decoration must not inject child nodes');
}

// ── size + mobile settings map through ──────────────────────────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  h.settingsBackend.set('size', 'large');
  h.settingsBackend.set('mobile', 'compact');
  h.api().refresh();
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '44px', 'large -> 44px');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), 'compact', 'compact mobile mode applied');
  // an invalid size falls back to medium
  h.settingsBackend.set('size', 'gigantic');
  h.api().refresh();
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '32px', 'invalid size -> medium fallback');
}

// ── image: valid data-URL applied, invalid rejected ─────────────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  const good = 'data:image/png;base64,AAAABBBBCCCC==';
  h.api().setImage(good);
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-img'), 'url("' + good + '")',
    'a valid data-image is applied as a url() custom property');
  h.api().setImage('javascript:alert(1)');
  assert.equal(h.api().getImage(), good, 'a non data-image value must be rejected (previous kept)');
  h.api().clearImage();
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-img'), 'none', 'clearing resets the image var');
}

// ── idempotency: repeated apply does not duplicate or inject ─────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  h.api().refresh(); h.api().refresh();
  assert.ok(h.userRows.every((r) => r.getAttribute('data-hwx-uav') === '1'),
    'rows stay marked exactly once (attribute, not appended nodes)');
  assert.ok(noChildrenInjected(h), 'repeated apply must not inject child nodes');
}

// ── disable removes all decoration (pixel-identical to stock) ────────────────
{
  const h = createHarness();
  h.api().setEnabled(true);
  h.api().setEnabled(false);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null, 'disable clears the root flag');
  assert.equal(h.rootEl.style.getPropertyValue('--hwx-uav-size'), '', 'disable clears the size var');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-mobile'), null, 'disable clears the mobile attr');
  assert.ok(h.userRows.every((r) => !r.hasAttribute('data-hwx-uav')), 'disable unmarks all rows');
}

// ── teardown disconnects the observer, clears listeners and decoration ───────
{
  const h = createHarness();
  h.api().setEnabled(true);
  assert.ok(h.observers.length >= 1 && h.observers[0].connected, 'observer is connected while installed');
  assert.ok((h.windowListeners.storage || []).length === 1, 'a storage listener is registered');
  h.api().teardown();
  assert.ok(h.observers.every((o) => !o.connected), 'teardown disconnects the observer');
  assert.equal((h.windowListeners.storage || []).length, 0, 'teardown removes the storage listener');
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), null, 'teardown clears decoration');
}

// ── registers exact id, a configure hook, and an interval reconcile ─────────
{
  const h = createHarness();
  assert.equal(typeof h.configure(), 'function', 'a Configure hook is registered');
  assert.ok(h.intervals.length === 1, 'a single reconcile interval is installed');
}

// ── graceful degrade: no hermesExt settings -> localStorage fallback works ──
{
  const h = createHarness({ settingsSupported: false });
  assert.equal(h.api().settingsBackend, 'localStorage', 'reports the localStorage fallback backend');
  h.api().setEnabled(true);
  assert.equal(h.rootEl.getAttribute('data-hwx-uav-on'), '1',
    'enabling works through the localStorage fallback on older core');
  assert.equal(h.store.get('hermes-ext-user-avatar-enabled'), 'true',
    'fallback persists to the declared owned localStorage key');
}

console.log('test-user-avatar: all assertions passed');
