# GC Design System binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Measured on release 1.7.0 (`gcds-components`,
`gcds-tokens` 1.6.0, `gcds-fonts` 1.1.1) in Chromium, with a form drawn with text, details, GC date
and notice components: the document's `<head>` gained one `<style data-styles>`, `document.adoptedStyleSheets`
gained the renderer's font sheet, `<body>` and `<html>` gained nothing, `window` gained no global.

GC Design System's script is a Stencil library. Each `gcds-*` element upgrades itself wherever it is
connected, a shadow root included, so there is no scope to start it in and nothing for the binding's
`connect` to do (no `connect`, no cleanup to write). Without the script the `gcds-*`
elements stay inert, so there is no separate no-JavaScript baseline to draw: the binding needs the
script, and its capability answers describe what the components draw once they have upgraded.

## Document-level styles and fonts

- **The renderer's one font sheet.** `gcds.css` imports its fonts from Google Fonts
  (`@import url("https://fonts.googleapis.com/css2?family=Lato…&family=Noto+Sans…")`) and carries its own
  tokens. Only `@font-face` rules go to `document.adoptedStyleSheets` (fonts must be document-level to reach
  a shadow root): one sheet for the binding, released on the last unmount, page-wide while it is there. The
  page therefore makes a request to `fonts.googleapis.com` and `fonts.gstatic.com`. A host that must not
  (a Canada.ca page serves its own) puts `@gcds-core/fonts` behind its own `gcds.css`; the binding names no font URL.
- **Stencil's hydration style.** The loader adds `<style data-styles>` to `document.head` (the
  `visibility: hidden` until `.hydrated` rule for `gcds-*`). It stays for the life of the page and is
  harmless to the host's own elements. The renderer does not touch it.
- **Stencil's shared sheet.** Stencil adopts its components' shared sheet (`@layer reset, default;`
  and the resets) into the nearest shadow root, here the form's, and never takes it away. The renderer notes
  the root's adopted sheets before it adopts its own and, on unmount, removes every sheet added since, so a
  page that mounts and unmounts forms leaves nothing behind (conformance MNT-05).

## Listeners, timers and observers on window, document or body

Stencil registers these for the components the binding draws, and removes them when the element
disconnects (the form unmounting). The binding adds none of its own and has no `connect`.

- `document`: `gcdsError`, `gcdsValid` and `submit` for `gcds-error-summary`, `submit` for each field component
  (`gcds-input`, `-textarea`, `-select`, `-radios`, `-checkboxes`, `-date-input`). A form submitted inside a
  shadow root does not reach `document` (`submit` is not composed). The binding sets `validate-on="other"` on
  every field and `listen="false"` on the summary: Datum is the validator, so the design system's own
  validation never runs and the summary draws only the links the renderer hands it.
- `window`: `beforeprint` and `afterprint` for `gcds-details` (the plugin's `gcds-details` type: it opens
  itself for print and closes again).
- `window.matchMedia('(max-width: 480px)')` change listener for `gcds-header` (the plugin's `gcds-header`),
  removed on disconnect.
- The error summary's own click handler looks the target up with `document.querySelector`, which cannot see
  into a shadow root; the binding answers the click first (capture) and moves focus itself, so that code never runs.
- Observers the binding adds: a `MutationObserver` per field on the inner control's `aria-describedby`
  (`keepDescription`), to keep Datum's notices and count sentence described after the component rewrites the
  attribute; disconnected when the field leaves.

## Markers on <body> or <html>

None. GC Design System writes no class or attribute on either.

## Nodes added outside the form's root

None. Nothing the binding draws is an overlay: `gcds-details`, `gcds-notice` and `gcds-card` draw in place,
and the renderer's tooltips mount in the shadow root. `selfCheck` reports a node a script adds to
`document.body`.

## Globals

None on `window`. The loader defines the `gcds-*` custom elements on the page's `customElements` registry:
one definition per tag per page, so a page draws every form with **one release** of the design system
(a second release's script is ignored or collides).

## What the host must provide

- `gcds.css` (tokens and the fonts `@import`) as a stylesheet asset, and the Stencil module script
  (`gcds.esm.js`) as a module script asset, both from the one pinned release, same-origin or CORS-enabled
  (the renderer fetches the stylesheet to rewrite it for the shadow root); `binding-check.json` is the list the kit uses.
- The page's language: components take `lang` from the binding (`en` or `fr`, from the form's locale) and a
  form in French on an English page is marked.
- The fonts' licence: Lato and Noto Sans are open (OFL); nothing proprietary is served.
- For **print**: the same stylesheet (`gcds.css`) as the print theme's asset; print links styles and fonts and never runs a script.
- For **PDF**: `pdfThemes.register(gcdsPdfTheme)` and the folder the `@gcds-core/fonts` WOFF files are served from
  (`createFaceFontProvider({ baseUrl })`).
- For **the builder's palette**: `plugins.register(gcdsPlugin)`; its types are listed only while the GCDS
  binding draws the canvas.
- Known limits of the design system, which are its own: `gcds-error-summary` heads itself with a fixed `h2`
  (the summary's `headingLevel` cannot be honoured); `gcds-stepper` takes `h1` to `h3`; `gcds-textarea` counts only
  from a `maxlength` Datum never writes, so the count is drawn beside it; GC Design System has no tabs, no table of
  inputs and no placeholder.
