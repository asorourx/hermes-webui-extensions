/* Regression tests for auto-list's keyboard interaction contracts.
   Self-contained: loads assets/auto-list.js into a minimal DOM stub and fires
   synthetic keydown events — no jsdom / no browser.
   Run: `node --test scripts/test-auto-list-keyboard.mjs`

   Covers the contracts the composer must keep:
     0. Adaptive send-key — continuation binds to an Enter chord Core does NOT send
        for the current window._sendKey (mirrors Core's send predicate), so the send
        chord is never intercepted. These tests have no Core send handler, so a
        "not intercepted" assertion proves only that the extension leaves the chord
        to Core (Core's own desktop/coarse-pointer send behavior is out of scope here):
          send_key=enter → Shift+Enter (non-Numpad) continues; Enter/Alt/Ctrl/Meta/Numpad left to Core.
          send_key=shift+enter → any non-Shift Enter continues; Shift+Enter left to Core.
          send_key=ctrl+enter → plain non-Numpad Enter continues; Ctrl/Meta/Numpad Enter left to Core.
     1. IME  — a commit Enter during composition (incl. Safari's trailing Enter via
               Core's window._isImeEnter) is NEVER consumed.
     2. Scope — only the real composer `#msg` inside `#composerWrap` is touched.
     3. Tab  — a ranged selection is left to Core/browser (no destructive rewrite).
     4. Cmd  — while #cmdDropdown.open, Enter/Tab are left for completion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../extensions/auto-list/assets/auto-list.js', import.meta.url)), 'utf8');

const UNSET = Symbol('unset');
function loadExtension({ sendKey = 'enter', imeComposing = false, dropdownOpen = false } = {}) {
  const handlers = [];
  const dd = { classList: { contains: (c) => c === 'open' && dropdownOpen } };
  globalThis.document = {
    getElementById: (id) => (id === 'cmdDropdown' ? dd : null),
    addEventListener: (type, fn) => { if (type === 'keydown') handlers.push(fn); },
  };
  globalThis.window = {
    _isImeEnter: (e) => e.isComposing || e.keyCode === 229 || imeComposing,
  };
  // Only define _sendKey when the caller supplied a concrete value; UNSET leaves
  // the global genuinely absent so the "defaults to enter" path is exercised.
  if (sendKey !== UNSET) globalThis.window._sendKey = sendKey;
  globalThis.Event = class { constructor(t) { this.type = t; } };
  globalThis.KeyboardEvent = { DOM_KEY_LOCATION_NUMPAD: 3 };
  // fresh module state each load
  (0, eval)(SRC);
  return (evt) => handlers.forEach((fn) => fn(evt));
}

function textarea(value, sel, { id = 'msg', inComposer = true } = {}) {
  let [start, end] = Array.isArray(sel) ? sel : [sel, sel];
  const ta = {
    tagName: 'TEXTAREA', id, readOnly: false, disabled: false,
    get value() { return value; }, set value(v) { value = v; },
    get selectionStart() { return start; }, set selectionStart(v) { start = v; },
    get selectionEnd() { return end; }, set selectionEnd(v) { end = v; },
    // Core composer is `#msg` inside `#composerWrap`; a non-composer stub returns null.
    closest: (s) => (inComposer && String(s).indexOf('#composerWrap') !== -1 ? {} : null),
    setRangeText(text, s, e, mode) {
      this.rangeCalls++;
      value = value.slice(0, s) + text + value.slice(e);
      if (mode === 'end') { start = end = s + text.length; }
    },
    dispatchEvent() {},
    rangeCalls: 0,
  };
  return ta;
}

function key(ta, k, mods = {}) {
  const e = {
    key: k, target: ta, isComposing: false, keyCode: 0,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
    ...mods,
  };
  return e;
}

// ── 0. Adaptive send-key: continuation binds to the NON-send key ─────────────
test('send_key=enter: plain Enter on a list line is NOT intercepted (left to Core)', () => {
  const fire = loadExtension({ sendKey: 'enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'plain Enter is left to Core (not intercepted)');
  assert.equal(ta.rangeCalls, 0);
});

test('send_key=enter: Shift+Enter continues the list', () => {
  const fire = loadExtension({ sendKey: 'enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { shift: true });
  fire(e);
  assert.equal(e.prevented, true, 'Shift+Enter is the continuation key here');
  assert.equal(ta.value, '1. milk\n2. ', 'inserts next marker');
});

test('send_key=enter: Alt+Enter is NOT intercepted (left to Core)', () => {
  const fire = loadExtension({ sendKey: 'enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { alt: true });
  fire(e);
  assert.equal(e.prevented, false, 'Alt+Enter is not a continuation chord in default mode — left to Core');
  assert.equal(ta.rangeCalls, 0);
});

test('send_key=enter: Shift+Enter on an empty item breaks out of the list', () => {
  const fire = loadExtension({ sendKey: 'enter' });
  const ta = textarea('1. milk\n2. ', 11);
  const e = key(ta, 'Enter', { shift: true });
  fire(e);
  assert.equal(e.prevented, true);
  assert.equal(ta.value, '1. milk\n', 'empty "2. " removed');
});

test('send_key=shift+enter: plain Enter continues the list', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, true, 'unmodified Enter is the continuation key here');
  assert.equal(ta.value, '1. milk\n2. ');
});

test('send_key=shift+enter: Shift+Enter is NOT intercepted (send chord preserved)', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { shift: true });
  fire(e);
  assert.equal(e.prevented, false, 'the configured shift+enter send chord must reach Core');
  assert.equal(ta.rangeCalls, 0);
});

test('send_key=ctrl+enter: plain Enter continues, Ctrl+Enter sends', () => {
  let fire = loadExtension({ sendKey: 'ctrl+enter' });
  let ta = textarea('- a', 3);
  let e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, true, 'plain Enter continues under ctrl+enter');
  assert.equal(ta.value, '- a\n- ');

  fire = loadExtension({ sendKey: 'ctrl+enter' });
  ta = textarea('- a', 3);
  e = key(ta, 'Enter', { ctrl: true });
  fire(e);
  assert.equal(e.prevented, false, 'Ctrl+Enter send chord must reach Core');
});

test('send_key=ctrl+enter: Numpad Enter is NOT intercepted (Core sends it)', () => {
  // Core's _isNumpadEnter sends on Numpad Enter in ctrl+enter mode, so the
  // extension must never treat it as continuation. Detect via e.code and e.location.
  let fire = loadExtension({ sendKey: 'ctrl+enter' });
  let ta = textarea('- a', 3);
  let e = key(ta, 'Enter', { code: 'NumpadEnter' });
  fire(e);
  assert.equal(e.prevented, false, 'Numpad Enter is a send chord under ctrl+enter — must reach Core');
  assert.equal(ta.rangeCalls, 0);

  // Also via KeyboardEvent.DOM_KEY_LOCATION_NUMPAD (=== 3).
  fire = loadExtension({ sendKey: 'ctrl+enter' });
  ta = textarea('- a', 3);
  e = key(ta, 'Enter', { location: 3 });
  fire(e);
  assert.equal(e.prevented, false, 'Numpad Enter (by location) must reach Core');
  assert.equal(ta.rangeCalls, 0);
});

test('unset window._sendKey defaults to enter (extension inert on plain Enter)', () => {
  const fire = loadExtension({ sendKey: UNSET });   // _sendKey genuinely absent
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'missing setting → treat as send_key=enter');
});

test('unset window._sendKey: Shift+Enter continues (default-mode continuation)', () => {
  const fire = loadExtension({ sendKey: UNSET });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { shift: true });
  fire(e);
  assert.equal(e.prevented, true, 'unset → default mode → Shift+Enter continues');
  assert.equal(ta.value, '1. milk\n2. ');
});

test('send_key=enter: Shift+Numpad Enter is NOT intercepted (mobile default sends it)', () => {
  // Core's _mobileDefault routes default mode into the ctrl-branch on coarse
  // pointers, where Numpad Enter is always sent — so never treat it as continuation.
  let fire = loadExtension({ sendKey: 'enter' });
  let ta = textarea('1. milk', 7);
  let e = key(ta, 'Enter', { shift: true, code: 'NumpadEnter' });
  fire(e);
  assert.equal(e.prevented, false, 'Shift+Numpad Enter must reach Core (mobile sends Numpad)');
  assert.equal(ta.rangeCalls, 0);

  fire = loadExtension({ sendKey: 'enter' });
  ta = textarea('1. milk', 7);
  e = key(ta, 'Enter', { shift: true, location: 3 });
  fire(e);
  assert.equal(e.prevented, false, 'Shift+Numpad Enter (by location) must reach Core');
});

test('send_key=shift+enter: Ctrl/Meta/Alt+Enter all continue (Core sends only Shift+Enter)', () => {
  for (const mods of [{ ctrl: true }, { meta: true }, { alt: true }]) {
    const fire = loadExtension({ sendKey: 'shift+enter' });
    const ta = textarea('1. milk', 7);
    const e = key(ta, 'Enter', mods);
    fire(e);
    assert.equal(e.prevented, true, `${JSON.stringify(mods)}+Enter continues under shift+enter (Core does not send it)`);
    assert.equal(ta.value, '1. milk\n2. ');
  }
});

test('Numpad Enter is treated as Enter (send_key=shift+enter → continues)', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { code: 'NumpadEnter' });   // e.key is 'Enter' for numpad too
  fire(e);
  assert.equal(e.prevented, true, 'numpad Enter is still Enter');
  assert.equal(ta.value, '1. milk\n2. ');
});

// ── 1. IME: composition Enter must NOT be intercepted (exercise the continuation path) ──
test('Enter during IME composition (isComposing) is not consumed', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. 日本語', 6);
  const e = key(ta, 'Enter', { isComposing: true });
  fire(e);
  assert.equal(e.prevented, false, 'IME commit Enter must reach Core');
  assert.equal(ta.rangeCalls, 0);
});

test("Safari trailing Enter (Core's _imeComposing flag) is not consumed", () => {
  const fire = loadExtension({ sendKey: 'shift+enter', imeComposing: true });
  const ta = textarea('1. 한국어', 6);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'must defer to window._isImeEnter');
});

// ── 2. Scope: only #msg inside #composerWrap ────────────────────────────────
test('a textarea that is NOT #msg is never handled', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. milk', 7, { id: 'notes' });
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'only #msg is the composer');
  assert.equal(ta.rangeCalls, 0);
});

test('a #msg textarea outside #composerWrap is never handled', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('1. milk', 7, { inComposer: false });
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'must live inside #composerWrap');
  assert.equal(ta.rangeCalls, 0);
});

// ── 3. Tab must not rewrite a ranged selection ──────────────────────────────
test('Tab with a ranged selection is left to Core/browser (no rewrite)', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('hello world', [0, 11]);          // whole line selected
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, false, 'ranged Tab must not be hijacked');
  assert.equal(ta.rangeCalls, 0, 'selection must never be replaced');
  assert.equal(ta.value, 'hello world');
});

test('Tab with a collapsed caret still indents (unchanged behavior)', () => {
  const fire = loadExtension({ sendKey: 'shift+enter' });
  const ta = textarea('hello', 5);
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, true);
  assert.equal(ta.value, 'hello  ');                    // two spaces inserted at caret
});

// ── 4. Command dropdown owns Enter/Tab while open ───────────────────────────
test('continuation Enter is left to the command dropdown when it is open', () => {
  const fire = loadExtension({ sendKey: 'shift+enter', dropdownOpen: true });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'dropdown completion must get Enter');
  assert.equal(ta.rangeCalls, 0);
});

test('Tab is left to the command dropdown when it is open', () => {
  const fire = loadExtension({ sendKey: 'shift+enter', dropdownOpen: true });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, false, 'dropdown completion must get Tab');
  assert.equal(ta.rangeCalls, 0);
});
