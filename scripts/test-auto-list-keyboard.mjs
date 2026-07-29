/* Regression tests for auto-list's keyboard interaction contracts.
   Self-contained: loads assets/auto-list.js into a minimal DOM stub and fires
   synthetic keydown events — no jsdom / no browser. Run: `node extensions/auto-list/tests/keyboard.test.mjs`.

   Covers the four contracts the composer must keep:
     1. IME  — a commit Enter during composition (incl. Safari's trailing Enter via
               Core's window._isImeEnter) is NEVER consumed.
     2. Send — the configured send chord (shift+enter / ctrl+enter / enter) always
               reaches Core; only UNMODIFIED Enter is intercepted on a list line.
     3. Tab  — a ranged selection is left to Core/browser (no destructive rewrite).
     4. Cmd  — while #cmdDropdown.open, Enter/Tab are left for completion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../extensions/auto-list/assets/auto-list.js', import.meta.url)), 'utf8');

function loadExtension({ imeComposing = false, dropdownOpen = false } = {}) {
  const handlers = [];
  const dd = { classList: { contains: (c) => c === 'open' && dropdownOpen } };
  globalThis.document = {
    getElementById: (id) => (id === 'cmdDropdown' ? dd : null),
    addEventListener: (type, fn) => { if (type === 'keydown') handlers.push(fn); },
  };
  globalThis.window = {
    _isImeEnter: (e) => e.isComposing || e.keyCode === 229 || imeComposing,
  };
  globalThis.Event = class { constructor(t) { this.type = t; } };
  // fresh module state each load
  (0, eval)(SRC);
  return (evt) => handlers.forEach((fn) => fn(evt));
}

function textarea(value, sel) {
  let [start, end] = Array.isArray(sel) ? sel : [sel, sel];
  const ta = {
    tagName: 'TEXTAREA', readOnly: false, disabled: false,
    get value() { return value; }, set value(v) { value = v; },
    get selectionStart() { return start; }, set selectionStart(v) { start = v; },
    get selectionEnd() { return end; }, set selectionEnd(v) { end = v; },
    closest: () => ({}),               // pretend it lives inside the composer
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

// ── happy path: plain Enter on a list line continues the list ───────────────
test('plain Enter on a numbered list line continues it', () => {
  const fire = loadExtension();
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, true, 'should intercept');
  assert.equal(ta.value, '1. milk\n2. ', 'inserts next marker');
});

// ── 1. IME: composition Enter must NOT be intercepted ───────────────────────
test('Enter during IME composition (isComposing) is not consumed', () => {
  const fire = loadExtension();
  const ta = textarea('1. 日本語', 6);
  const e = key(ta, 'Enter', { isComposing: true });
  fire(e);
  assert.equal(e.prevented, false, 'IME commit Enter must reach Core');
  assert.equal(ta.rangeCalls, 0);
});

test("Safari trailing Enter (Core's _imeComposing flag) is not consumed", () => {
  const fire = loadExtension({ imeComposing: true });   // isComposing already false, keyCode 0
  const ta = textarea('1. 한국어', 6);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'must defer to window._isImeEnter');
});

// ── 2. Send chord preserved: Shift+Enter on a list line is left to Core ──────
test('Shift+Enter on a list line is NOT intercepted (send chord preserved)', () => {
  const fire = loadExtension();
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter', { shift: true });
  fire(e);
  assert.equal(e.prevented, false, 'the configured shift+enter send chord must reach Core');
  assert.equal(ta.rangeCalls, 0);
});

test('Ctrl+Enter and Cmd+Enter on a list line are left to Core', () => {
  for (const mod of [{ ctrl: true }, { meta: true }]) {
    const fire = loadExtension();
    const ta = textarea('1. milk', 7);
    const e = key(ta, 'Enter', mod);
    fire(e);
    assert.equal(e.prevented, false);
  }
});

// ── 3. Tab must not rewrite a ranged selection ──────────────────────────────
test('Tab with a ranged selection is left to Core/browser (no rewrite)', () => {
  const fire = loadExtension();
  const ta = textarea('hello world', [0, 11]);          // whole line selected
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, false, 'ranged Tab must not be hijacked');
  assert.equal(ta.rangeCalls, 0, 'selection must never be replaced');
  assert.equal(ta.value, 'hello world');
});

test('Tab with a collapsed caret still indents (unchanged behavior)', () => {
  const fire = loadExtension();
  const ta = textarea('hello', 5);
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, true);
  assert.equal(ta.value, 'hello  ');                    // two spaces inserted at caret
});

// ── 4. Command dropdown owns Enter/Tab while open ───────────────────────────
test('Enter is left to the command dropdown when it is open', () => {
  const fire = loadExtension({ dropdownOpen: true });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Enter');
  fire(e);
  assert.equal(e.prevented, false, 'dropdown completion must get Enter');
  assert.equal(ta.rangeCalls, 0);
});

test('Tab is left to the command dropdown when it is open', () => {
  const fire = loadExtension({ dropdownOpen: true });
  const ta = textarea('1. milk', 7);
  const e = key(ta, 'Tab');
  fire(e);
  assert.equal(e.prevented, false, 'dropdown completion must get Tab');
  assert.equal(ta.rangeCalls, 0);
});
