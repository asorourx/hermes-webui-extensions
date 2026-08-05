# Auto List

Auto List is a trusted local Hermes WebUI extension that makes list typing in the
message composer behave like a modern editor: the continuation key continues the
list, an empty item exits it, and Tab indents by two spaces. Continuation binds to
whichever Enter chord is **not** your configured send key, so sending is never
hijacked (see "What It Does").

## What It Does

- **The continuation key is an Enter chord that Core does _not_ send** for your
  configured send key (read from Core's `window._sendKey`), so your send action is
  never intercepted:
  - `send_key = enter` → **Shift+Enter** continues the list. On desktop, plain
    **Enter** (and Alt/Ctrl/Meta/Numpad Enter) sends; on coarse-only mobile Core
    sends Ctrl/Meta/Numpad Enter while plain and Alt+Enter insert a newline. Either
    way the extension only ever binds **Shift+Enter** (non-Numpad), which Core never sends.
  - `send_key = shift+enter` → any non-Shift **Enter** continues; **Shift+Enter** still sends.
  - `send_key = ctrl+enter` → plain **Enter** continues; **Ctrl+Enter** (and **Numpad
    Enter**) still send.

  (When `window._sendKey` is unset it defaults to `enter`.)
- **Continues ordered and unordered lists**: on a line like `1. buy milk`, `- eggs`,
  `* note`, or `1) go`, the continuation key inserts the next marker (`2. `, `- `,
  `* `, `2) `) on a new line, preserving the line's indent.
- **Exits the list** when you press the continuation key on an empty marker (it is
  cleared, leaving a normal line) — so two in a row end the list.
- **Only ever binds the non-send key**, so whatever you've set as send always reaches
  Core and sends — whether or not you're on a list line.
- **Tab indents** the current list item by two spaces (nesting); **`Shift`+Tab**
  outdents; outside a list, Tab inserts two spaces at the caret.

## How It Works

```text
Hermes WebUI page
  -> manifest-bundled extension asset
  -> /extensions/assets/auto-list.js
  -> a capture-phase keydown listener on document, scoped to the composer
     <textarea id="msg"> (inside #composerWrap)
  -> reads Core's window._sendKey to pick the continuation chord (the non-send key)
  -> on the continuation key / Tab in a list context, edits the textarea via
     setRangeText(...) and dispatches an `input` event so the composer's autosize +
     send-enable react
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files, use native
host APIs, or use any storage.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/auto-list HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Type `1. buy milk` in the composer, then press the continuation key (Shift+Enter when
your send key is Enter, otherwise plain Enter) → the next line becomes `2. `.

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/auto-list/` directory.
It stores nothing, so there is no state to clean up.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- adds a single **capture-phase `keydown` listener on `document`**, but acts only
  when the event target is the composer `<textarea id="msg">` (inside
  `#composerWrap`) — every other element and every other key is passed through
  untouched
- on the **continuation key** (an Enter chord that Core does not send for your
  `window._sendKey` setting), calls `preventDefault()` / `stopImmediatePropagation()` **only
  when the caret is on a list line**; on any non-list line it is not touched
- **never intercepts your configured send chord** — the send key always reaches the app's send handler
- reads two Core globals: `window._sendKey` (to choose the continuation chord) and
  `window._isImeEnter` (to defer to Core's IME guard); it sets a single idempotency
  flag `window.__autoList` and reads/writes nothing else
- on **Tab** / **Shift+Tab** inside the composer, inserts / removes two spaces
- edits only the composer textarea's own value via `setRangeText(...)` and
  dispatches a synthetic `input` event; it creates no DOM of its own
- does not call WebUI HTTP APIs
- does not access cookies
- does not contact loopback or external network services
- does not read or write any storage (localStorage / cookies / files)
- does not use arbitrary filesystem or native host APIs

## Compatibility

- manifest-bundled extension asset + same-origin serving under `/extensions/`
- the composer `<textarea id="msg">` inside `#composerWrap` (the integration
  contract; if core renames these, the extension needs updating)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/auto-list/assets/auto-list.js
python3 -m json.tool extensions/auto-list/extension.json
python3 -m json.tool extensions/auto-list/manifest.json
```

Manual verification:

- `send_key=enter`: `1. milk` + **Shift+Enter** → next line is `2. `; plain **Enter** sends (desktop) / newlines (coarse-only mobile), and the extension leaves it to Core either way
- `send_key=shift+enter`/`ctrl+enter`: `1. milk` + **Enter** → next line is `2. `; the send chord sends
- `- eggs` + continuation key → next line is `- `; `* ` and `1)` behave the same
- the continuation key on an empty marker clears it and exits the list
- your configured send chord sends even while on a list line
- Tab indents the item two spaces; `Shift`+Tab outdents; nested items keep their
  number / bullet on continue

## Known Limitations

- Relies on the current composer markup (`<textarea id="msg">` inside
  `#composerWrap`); a core rename would require an update — standard for a
  composer-integration extension.
- Ordered lists increment the current line's number on continue; they are not
  renumbered if you insert or delete an item out of order.

## Interaction contracts (regression-tested)
The capture-phase handler runs ahead of the composer, so it deliberately yields on:
- **IME composition** — defers to Core's `window._isImeEnter(e)` when present (covers Safari's trailing Enter after `compositionend`), falling back to `isComposing`/keyCode 229.
- **Send chord** — continuation binds to the non-send key (`window._sendKey`), so the configured send chord is never intercepted.
- **Command dropdown** — while `#cmdDropdown.open`, Enter/Tab are left for completion.
- **Ranged selection** — Tab is left to Core/browser (never rewrites a selection).

Run the regression suite: `node --test scripts/test-auto-list-keyboard.mjs`.
