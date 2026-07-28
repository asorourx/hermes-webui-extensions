/* Auto List — smart list continuation in the message composer.
   • Pressing Enter inside an ordered (`1.` / `1)`) or unordered (`-` / `*` / `+`)
     list item auto-inserts the next marker (2., next bullet), preserving indent.
   • An empty item + Enter breaks OUT of the list — two Enters in a row end it.
   • Tab indents the current list item by 2 spaces; Shift+Tab outdents; outside a
     list Tab inserts 2 spaces at the caret.
   Contract-safe by design:
   • Intercepts ONLY unmodified Enter on a list line, so every configured send
     chord (Enter / Shift+Enter / Ctrl+Enter) still reaches Core and sends.
   • Defers to Core's IME guard (`window._isImeEnter`) so a Safari/CJK commit Enter
     after compositionend is never consumed.
   • Stays out of the way while the command dropdown (`#cmdDropdown.open`) owns
     Enter/Tab for completion.
   • Never rewrites a ranged selection on Tab (no data loss).
   Composer textarea only; capture phase; no settings, no sidecar, no core edits. */
(function () {
  'use strict';
  if (window.__autoList) return; window.__autoList = true;

  var INDENT = '  ';                               // two spaces
  // marker, then OPTIONAL " content". Bare "1." / "-" match (content undefined);
  // "1.foo" (no space) does NOT match, so ordinary text is never treated as a list.
  var ORD = /^(\s*)(\d+)([.)])(?:[ \t]+(.*))?$/;    // 1) indent 2) number 3) . or ) 4) content?
  var UN  = /^(\s*)([-*+])(?:[ \t]+(.*))?$/;        // 1) indent 2) bullet 3) content?

  function isComposer(el) {
    return !!(el && el.tagName === 'TEXTAREA' && !el.readOnly && !el.disabled
      && el.closest('.composer-wrap, #composerWrap, .composer-flyout, .composer'));
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

    // ── Enter on a LIST line: continue / break. ONLY unmodified Enter, so every
    //    configured send chord (Enter / Shift+Enter / Ctrl+Enter) still reaches
    //    Core and sends — this handler never intercepts a modified Enter. ────────
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
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
