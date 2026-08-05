/* Auto List — smart list continuation in the message composer.
   • The continuation key is an Enter chord that Core does NOT send for the current
     `window._sendKey` setting — so the send action is NEVER hijacked. Mirrors Core's
     own send predicate (boot.js), including the coarse-pointer `_mobileDefault` path:
       send_key = enter        → continuation is Shift+Enter (non-Numpad). On desktop
                                  (fine pointer) plain/Alt/Ctrl/Meta/Numpad Enter all send;
                                  on coarse-only mobile Core sends only Ctrl/Meta/Numpad
                                  Enter (plain and Alt+Enter are newline there). Either way
                                  Shift+Enter (non-Numpad) is never a Core send chord.
       send_key = shift+enter  → any non-Shift Enter continues/breaks (Shift+Enter sends)
       send_key = ctrl+enter   → plain non-Numpad Enter continues/breaks (Ctrl+Enter AND
                                  Numpad Enter still send — Numpad is never continuation)
   • On a list line the continuation key inserts the next marker (2., next bullet),
     preserving indent; on an EMPTY item it breaks OUT of the list.
   • Tab indents the current list item by 2 spaces; Shift+Tab outdents; outside a
     list Tab inserts 2 spaces at the caret.
   Contract-safe by design:
   • Never intercepts the configured send chord (it binds to the OTHER key), so send
     always reaches Core. Defaults to send_key=enter when `window._sendKey` is unset.
   • Defers to Core's IME guard (`window._isImeEnter`) so a Safari/CJK commit Enter
     after compositionend is never consumed.
   • Stays out of the way while the command dropdown (`#cmdDropdown.open`) owns
     Enter/Tab for completion.
   • Never rewrites a ranged selection on Tab (no data loss).
   • Composer textarea only — the real composer `#msg` inside `#composerWrap`.
   Capture phase; no sidecar, no core edits. Reads Core's `window._sendKey` and
   `window._isImeEnter`; sets a single idempotency flag `window.__autoList`. */
(function () {
  'use strict';
  if (window.__autoList) return; window.__autoList = true;

  var INDENT = '  ';                               // two spaces
  // marker, then OPTIONAL " content". Bare "1." / "-" match (content undefined);
  // "1.foo" (no space) does NOT match, so ordinary text is never treated as a list.
  var ORD = /^(\s*)(\d+)([.)])(?:[ \t]+(.*))?$/;    // 1) indent 2) number 3) . or ) 4) content?
  var UN  = /^(\s*)([-*+])(?:[ \t]+(.*))?$/;        // 1) indent 2) bullet 3) content?

  // Scope tightly to the real composer — the `#msg` textarea inside `#composerWrap`
  // — so a future secondary textarea can never be rewritten.
  function isComposer(el) {
    return !!(el && el.tagName === 'TEXTAREA' && el.id === 'msg'
      && !el.readOnly && !el.disabled && el.closest('#composerWrap'));
  }

  // Core's authoritative send key (it reads the same global at send time). The
  // list-continuation key is an Enter chord Core does NOT send, so we never
  // intercept the send chord.
  function sendKey() {
    var k = window._sendKey;
    return (k === 'shift+enter' || k === 'ctrl+enter') ? k : 'enter';
  }
  // Numpad Enter — mirror Core's `_isNumpadEnter` exactly. Core SENDS on Numpad
  // Enter in ctrl+enter mode, so it must never be treated as a continuation key.
  function isNumpadEnter(e) {
    return e.key === 'Enter'
      && (e.code === 'NumpadEnter'
        || e.location === (typeof KeyboardEvent !== 'undefined' && KeyboardEvent.DOM_KEY_LOCATION_NUMPAD));
  }
  // Is THIS Enter event a continuation key Core would NOT send for the current
  // send-key setting? Derived from Core's send predicate (boot.js), including the
  // coarse-pointer `_mobileDefault` path where default mode routes into the
  // ctrl-branch and Core SENDS every Numpad Enter. Continuation is only ever a
  // chord Core never sends in ANY of its branches, so the send action always
  // reaches Core:
  //   send_key=enter        → desktop sends every non-Shift Enter; mobile
  //                           (_mobileDefault) also sends Ctrl/Meta/Numpad Enter.
  //                           The only never-sent chord is Shift+Enter that is NOT
  //                           Numpad → continuation is Shift+Enter, non-Numpad.
  //   send_key=shift+enter  → Core sends ONLY Shift+Enter → continuation is ANY
  //                           non-Shift Enter (Ctrl/Meta/Alt/Numpad all continue).
  //   send_key=ctrl+enter   → Core sends Ctrl/Meta/Numpad Enter → continuation is
  //                           plain Enter with NO modifier and NOT Numpad.
  function isContinuationKey(e) {
    if (e.key !== 'Enter') return false;
    var mode = sendKey();
    if (mode === 'enter') {
      // Shift+Enter is unsent on desktop; on mobile Numpad Enter is always sent,
      // so exclude Numpad even with Shift held.
      return e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !isNumpadEnter(e);
    }
    if (mode === 'ctrl+enter') {
      // Core sends Ctrl/Meta AND Numpad Enter here — never intercept those.
      return !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !isNumpadEnter(e);
    }
    // shift+enter mode: Core sends ONLY Shift+Enter, so ANY non-Shift Enter
    // (incl. Ctrl/Meta/Alt/Numpad Enter) is a safe continuation key.
    return !e.shiftKey;
  }

  // Command dropdown owns Enter/Tab for completion — mirror Core's own `.open` signal.
  function cmdDropdownOpen() {
    var dd = document.getElementById('cmdDropdown');
    return !!(dd && dd.classList.contains('open'));
  }

  // Reuse Core's IME guard when present (covers Safari's trailing Enter after
  // compositionend via its `_imeComposing` flag); fall back to the state-free check.
  function imeEnter(e) {
    return (typeof window._isImeEnter === 'function')
      ? window._isImeEnter(e)
      : (e.isComposing || e.keyCode === 229);
  }

  function curLine(ta) {
    var v = ta.value, pos = ta.selectionStart;
    var s = v.lastIndexOf('\n', pos - 1) + 1;
    var e = v.indexOf('\n', pos); if (e === -1) e = v.length;
    return { start: s, end: e, text: v.slice(s, e) };
  }

  function fire(ta) { ta.dispatchEvent(new Event('input', { bubbles: true })); }

  function onKeydown(e) {
    var ta = e.target;
    if (!isComposer(ta)) return;

    // ── Command dropdown open: it owns Enter/Tab for completion — never steal them.
    if ((e.key === 'Enter' || e.key === 'Tab') && cmdDropdownOpen()) return;

    // ── Tab / Shift+Tab: indent / outdent by 2 spaces (collapsed caret only) ────
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (ta.selectionStart !== ta.selectionEnd) return;   // ranged selection → leave to Core/browser (no data loss)
      var ln = curLine(ta), caret = ta.selectionStart;
      var onList = ORD.test(ln.text) || UN.test(ln.text);
      if (e.shiftKey) {                                    // outdent: strip ≤2 leading spaces
        var strip = ln.text.startsWith(INDENT) ? 2 : (ln.text.charAt(0) === ' ' ? 1 : 0);
        if (!strip) return;                               // nothing to outdent → let Tab do its thing
        e.preventDefault(); e.stopImmediatePropagation();
        ta.setRangeText('', ln.start, ln.start + strip, 'end');
        ta.selectionStart = ta.selectionEnd = Math.max(ln.start, caret - strip);
        fire(ta); return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      if (onList) {                                        // indent the whole item
        ta.setRangeText(INDENT, ln.start, ln.start, 'end');
        ta.selectionStart = ta.selectionEnd = caret + INDENT.length;
      } else {                                             // plain caret indent (selection is collapsed here)
        ta.setRangeText(INDENT, ta.selectionStart, ta.selectionStart, 'end');
      }
      fire(ta); return;
    }

    // ── Continuation key on a LIST line: continue / break. Binds to whichever Enter
    //    chord is NOT the send key (see isContinuationKey), so the configured send
    //    chord always reaches Core and sends — never intercepted here. ────────────
    if (!isContinuationKey(e)) return;
    if (imeEnter(e)) return;                               // IME composition in progress
    if (ta.selectionStart !== ta.selectionEnd) return;     // ignore ranged selections
    var line = curLine(ta);
    if (ta.selectionStart < line.start) return;
    var mo = ORD.exec(line.text);
    var mu = mo ? null : UN.exec(line.text);
    var m = mo || mu; if (!m) return;                      // not a list line → let Enter send/newline
    var content = mo ? m[4] : m[3];
    e.preventDefault(); e.stopImmediatePropagation();
    if (!content || !content.trim()) {                     // empty item → break out of the list
      ta.setRangeText('', line.start, line.end, 'end');
      fire(ta); return;
    }
    var indent = m[1];
    var marker = mo ? (indent + (parseInt(m[2], 10) + 1) + m[3] + ' ')
                    : (indent + m[2] + ' ');
    ta.setRangeText('\n' + marker, ta.selectionStart, ta.selectionEnd, 'end');
    fire(ta);
  }

  document.addEventListener('keydown', onKeydown, true);    // capture phase
})();
