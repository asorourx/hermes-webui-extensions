# Custom User Avatar

Custom User Avatar is a trusted local Hermes WebUI extension that shows an optional
avatar beside your own (**user**) messages in the chat transcript. Hermes WebUI gives
user turns no avatar — right alignment identifies the speaker — so this adds a purely
personal, **opt-in** decoration. It is **disabled by default**.

This is the user-turn complement to
[`custom-avatar`](../custom-avatar) (assistant avatar) and is independent of
[`profile-avatars`](../profile-avatars): it does not read, write, migrate, or shadow
either extension's storage, and it adds no assistant-avatar path.

## What It Does

- Adds an avatar to the left of each right-aligned user bubble when enabled.
- The image is **downscaled to a 96×96 square and stored locally** as a data-URL in the
  extension's own scoped storage namespace; it never leaves the browser.
- Re-applies to current and newly rendered user turns through a bounded, idempotent
  `MutationObserver` — no duplicate nodes, no observer loops.
- Fully reversible: disabling, reloading, or uninstalling removes all decoration.

## Controls

Configure it in **Settings → Extensions → Custom User Avatar** (the Configure panel):

- **Show avatars on my messages** — the enable toggle (default off).
- **Upload image / Remove** — your avatar image (PNG / JPEG / WebP, per issue #63; SVG,
  GIF, and oversized/invalid files are rejected — see [Media bounds](#media-bounds)).
  Stored locally only.
- **Avatar size** — Small (24px), Medium (32px), Large (44px).
- **On narrow screens** — Hide (default) or Compact, so a phone keeps readable width.

The enable / size / narrow-screen options are also declared as native
`settings_schema` fields, so they appear directly in the extension's settings row;
the image lives in extension-owned storage (image blobs do not belong in settings).

Configure opens an **extension-owned modal**. Core invokes the handler with a single
`{opener, restoreFocus}` options object — never a DOM host — so the panel mounts its own
overlay with `role="dialog"`/`aria-modal`, traps Tab while open, closes on the X button,
Escape, or a backdrop click, and settles the Configure promise **exactly once** on close
or teardown. Core restores focus to the opener; the panel does not compete with it.

### Media bounds

One private canonicalization path bounds the source **before** any canvas work and
always emits a bounded square PNG/JPEG data-URL:

| Bound | Value |
| --- | --- |
| Accepted types | `image/png`, `image/jpeg`, `image/webp` |
| Source bytes | ≤ 8 MB |
| Decoded dimensions | ≤ 4096 px per side |
| Decoded pixels | ≤ 16 megapixels |
| Stored data-URL | ≤ 128 KiB, at most 96×96 |

The dimension and pixel caps match the Profile Avatars boundary and are checked on the
decoded bitmap, because a small compressed file can still decode to an enormous one.
There is **no raw synchronous image setter** on the public API — every write goes
through this path, and a refused write reports a real error and leaves the previous
image in place.

## How It Renders (and why it is safe against core re-renders)

Core rebuilds a user row's `innerHTML` whenever it changes and **skips** rows whose
markup is unchanged. Injecting a child node into a row would defeat that optimization
(forcing a rebuild every render) and be wiped on the next reconcile. So this extension
**never injects child nodes**. It sets only element-level state that core does not
reconcile:

- a per-row `data-hwx-uav` attribute (survives `innerHTML` rebuilds and row recycling);
- `--hwx-uav-img` / `--hwx-uav-size` custom properties and a `data-hwx-uav-on` flag on
  `:root`.

The avatar itself is drawn by a `::before` **pseudo-element** in the stylesheet, gated
on `:root[data-hwx-uav-on]`. User rows carry `content-visibility:auto`, whose paint
containment clips anything drawn outside the row box, so the avatar is drawn **inside**
the row and the bubble yields a little width for it (an intentional, small horizontal
cost). Because the decoration is attribute- and CSS-driven, the observer only has to
mark newly created user rows; a core `innerHTML` rebuild leaves the decoration intact.

This is an **explicitly unstable DOM-mutation contract**: it targets real, visible
`.msg-row[data-role="user"]` rows and no-ops harmlessly (no errors, no decoration) if
that markup ever changes.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/user-avatar.js + .css
  -> marks .msg-row[data-role="user"] with data-hwx-uav; sets :root custom properties
  -> ::before pseudo-element renders the avatar (no child nodes injected)
  -> scoped ext storage: window.hermesExt.register('user-avatar').storage['image']
     (downscaled data-URL; cleared by Settings -> Clear extension storage)
  -> scalars via window.hermesExt settings when available
  -> hermes-ext-user-avatar-{enabled,size,mobile} localStorage fallbacks on older core
```

`static-ui` / manifest-bundle only. No backend routes, no sidecar, no external network,
no native host. Image processing is entirely in-browser (canvas downscale).

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/user-avatar \
  HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open **Settings → Extensions → Custom User Avatar → Configure**, turn it on, and upload
an image. Send a message — the avatar appears beside your turn.

Also exposed on `window.HermesUserAvatarExtension`:

- `.isEnabled()` / `.setEnabled(bool)`
- `.getImage()` / `.setImageFile(file)` (async, canonicalizing) / `.clearImage()`
- `.refresh()` — re-apply to current rows
- `.teardown()` — remove all decoration, observers, and listeners

## Disable And Uninstall

- **Disable:** turn off "Show avatars on my messages" — all decoration is removed
  immediately and the transcript is pixel-identical to stock.
- **Uninstall:** restart Hermes WebUI without the `HERMES_WEBUI_EXTENSION_DIR` /
  `HERMES_WEBUI_EXTENSION_MANIFEST` variables, or remove the
  `extensions/user-avatar/` directory. Your image lives in the extension's scoped
  storage namespace, so **Settings → Clear extension storage** and uninstall remove it.
  A pre-0.2.0 image stored under the raw `hermes-ext-user-avatar` localStorage key is
  migrated into scoped storage once on load, and the raw key is then deleted.

## Trust And Permissions

Trusted local code. Disclosed behavior:

- sets extension-owned DOM state only: a `data-hwx-uav` attribute on user rows and
  custom properties / a flag on `:root`; the avatar is a CSS `::before` pseudo-element
  (no injected child nodes)
- reads the uploaded image locally (`FileReader`), downscales it via a `<canvas>`, and
  stores a small data-URL
- stores the image in the sanctioned scoped storage namespace (`permissions.storage.owned`
  is `true`), so Core's Clear-extension-storage and uninstall actually remove it; it
  reads `localStorage` only under its own `hermes-ext-user-avatar*` keys (the one-time
  legacy image migration and the scalar fallbacks on older core)
- reads/writes its own scalar settings through `window.hermesExt` when available, with a
  localStorage fallback on older core
- does **not** call WebUI HTTP APIs, read cookies, contact loopback or external
  networks (the image never leaves the browser), or use native host / arbitrary
  filesystem APIs (the picker is a standard `<input type=file>`)
- does **not** read, write, migrate, or shadow `custom-avatar` or `profile-avatars`
  storage, and does **not** write profile, personality, memory, or core settings

Only validated `data:image/(png|jpeg|webp);base64,...` values within the byte cap are
ever applied, so a malformed or oversized stored value cannot inject anything.

## Known Limitations

- User-turn only (assistant avatars are `custom-avatar` / `profile-avatars`).
- Per-browser (browser-local storage), not synced across devices.
- Relies on `.msg-row[data-role="user"]` and the user-row `content-visibility` layout;
  a core rename would need an update (fails harmlessly until then).
- The avatar is the same image for every user turn (single user avatar), by design.
- When enabled with no image chosen yet, a neutral placeholder circle is shown.

## Compatibility

- Manifest-bundled extension assets served same-origin under `/extensions/`.
- User rows rendered as `.msg-row[data-role="user"]` with a `.msg-body` bubble.
- Native settings (`settings_schema` + `window.hermesExt` scoped settings) when present;
  degrades to localStorage fallback keys otherwise.

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/user-avatar/assets/user-avatar.js
python3 -m json.tool extensions/user-avatar/extension.json
python3 -m json.tool extensions/user-avatar/manifest.json
```

Manual verification (realistic desktop + 390px mobile):

- enabling decorates every current and newly streamed user turn; the assistant avatar
  and message content are unchanged
- disabling / reload removes all decoration; the disabled transcript is pixel-identical
  to stock
- a non-image, SVG, or oversized file is rejected with a message, not applied
- narrow layout follows the Hide / Compact setting; the bubble stays readable at 390px
- repeated re-renders (streaming, scrolling) do not duplicate nodes or shift the avatar

## Attribution

Original user + assistant avatar request: **@kinower** in
[`nesquena/hermes-webui#2586`](https://github.com/nesquena/hermes-webui/issues/2586).
Wishlist and V2 scope: **@nesquena-hermes** in
[`hermes-webui-extensions#63`](https://github.com/hermes-webui/hermes-webui-extensions/issues/63).
Existing `custom-avatar` (assistant): **@nesquena-hermes**. Existing `profile-avatars`:
**@asorourx**. This user-turn V2 complements those without duplicating them.
