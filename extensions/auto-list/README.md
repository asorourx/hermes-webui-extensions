# Auto List

Auto List is a trusted local Hermes WebUI extension that makes list typing in the
message composer behave like a modern editor: pressing Enter inside a list item
continues the list, an empty item exits it, and Tab indents by two spaces.

## What It Does

- **Continues ordered and unordered lists** on the newline key: on a line like
  `1. buy milk`, `- eggs`, `* note`, or `1) go`, pressing Enter inserts the next
  marker (`2. `, `- `, `* `, `2) `) on a new line, preserving the line's indent.
- **Smart Enter** — it intercepts Enter **only on a list line**, so a normal
  message still sends on Enter exactly as before. On a list line, Enter continues
  the list instead of sending.
- **Exits the list** when you press Enter on an empty marker (the marker is
  cleared, leaving a normal line) — so two newlines in a row end the list.
- **`Cmd`/`Ctrl`+Enter always sends**, even inside a list — the force-send escape.
- **Tab indents** the current list item by two spaces (nesting); **`Shift`+Tab**
  outdents; outside a list, Tab inserts two spaces at the caret.

## How It Works

```text
Hermes WebUI page
  -> manifest-bundled extension asset
  -> /extensions/assets/auto-list.js
  -> a capture-phase keydown listener on document, scoped to the composer
     <textarea id="msg"> (inside #composerWrap)
  -> on Enter/Tab in a list context, edits the textarea via setRangeText(...)
     and dispatches an `input` event so the composer's autosize + send-enable react
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

Type `1. buy milk` in the composer, press Enter → the next line becomes `2. `.

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
- on **Enter**, calls `preventDefault()` / `stopImmediatePropagation()` **only when
  the caret is on a list line** (to continue the list instead of sending); on any
  non-list line Enter is not touched and sends / inserts a newline as usual
- **never intercepts `Cmd`/`Ctrl`+Enter** — that always reaches the app's send handler
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

- `1. milk` + Enter → next line is `2. ` (message not sent)
- `- eggs` + Enter → next line is `- `; `* ` and `1)` behave the same
- Enter on an empty marker clears it and exits the list
- a normal (non-list) message still sends on Enter
- `Cmd`/`Ctrl`+Enter sends even while on a list line
- Tab indents the item two spaces; `Shift`+Tab outdents; nested items keep their
  number / bullet on continue

## Known Limitations

- Relies on the current composer markup (`<textarea id="msg">` inside
  `#composerWrap`); a core rename would require an update — standard for a
  composer-integration extension.
- Ordered lists increment the current line's number on continue; they are not
  renumbered if you insert or delete an item out of order.
