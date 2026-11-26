# Fluent UI binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone.

Measured on Fluent UI Web Components 3.2.1 (`dist/web-components.min.js`, the module the host loads)
in the kit's Chromium (158), on a page that loaded the script and then drew a form holding every
element the binding draws (`fluent-field`, text input, textarea, text, radio group, radio, checkbox,
dropdown with its listbox and options, button, message bar, tablist and tabs, badge) in a shadow
root, validated it, opened and closed the dropdown and switched a tab: `document.head` gained
nothing from Fluent (the one new child is the renderer's own `<script data-datum-binding-script>` for
the asset), `document.adoptedStyleSheets` gained nothing, `<html>` and `<body>` gained no attribute
and `<body>` no child, and no listener or observer from Fluent was added to `window`, `document`,
`<html>` or `<body>` (the one `document` `keydown` listener added while drawing is the renderer's,
from its own chunk). Opening the dropdown added no `window` or `document` listener that was still
there afterwards, and its list stayed in the form's tree. Loading the script defined two globals, 42 `fluent-*` elements
and one Trusted Types policy (below), re-measured on a blank page with `window` and `document` listener and
`customElements.define` and `trustedTypes.createPolicy` recording on: nothing else (the new `head` child is the
script tag). The binding declares them in `designSystem.sideEffects`. Removing the elements left nothing behind.

The script is a module that defines every `fluent-*` element on the page's registry when it loads.
Each element is a FAST element that renders itself wherever it connects, a shadow root included, so
there is no scope to start and no `connect` (no cleanup to write).

## Document-level styles and fonts

None. Fluent ships no CSS file: each element adopts its own styles into its own shadow root, and the
tokens come from the host's theme sheet (`theme/*.css`), which the renderer adopts into the form's
shadow root (`:root` rewritten to `:host`). The binding names no fonts (`fonts: []`): Fluent's
`fontFamilyBase` is a system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ...`), so
the renderer adds no font sheet to the document.

- A host that themes with Fluent's own `setTheme(theme)` (no node) writes the tokens as one sheet in
  `document.adoptedStyleSheets` (`html { --token: value }`): that is the host's choice and its sheet.
  `setTheme(theme, element)` writes them into that element's shadow root instead; on a `<datum-form>`
  that sheet is lost when the form unmounts (the renderer clears the root sheets added after mount),
  so a host themes the page or a light-DOM wrapper instead (README, Use).
- Only a positioned tooltip (`fluent-tooltip`, which the binding does not draw) appends a `<style>` to
  `document.head` for its anchor positioning.

## Listeners, timers and observers on window, document or body

None while the binding's elements are drawn. The binding adds none and has no `connect`.

- The `document` listeners in the bundle (`click` and `scroll` to close a menu) belong to
  `fluent-menu`; they are added only while a menu opens with `open-on-context` or `close-on-scroll`.
  The binding draws no menu. `fluent-dropdown` (the select) adds `scroll` and `resize`
  listeners on `window` while its list is open, under an `AbortController` it aborts when the list
  closes. `fluent-slider` adds pointer listeners on `window` and `document` during a drag only.
- The focusgroup polyfill (`globalThis.__FOCUSGROUP_POLYFILL__`, used where the browser has no native
  `focusgroup`; Chromium 158 has none) attaches to the element that carries the `focusgroup` attribute
  (`fluent-radio-group` writes `focusgroup="radiogroup wrap"` on itself; menus write it on their
  list): its key handling and `MutationObserver`s are on that element and under an
  `AbortController`, never on `document`. The global holds the set of those observers.
- Each `fluent-field` keeps a `MutationObserver` on its slotted control's `disabled`, `required` and
  `readonly`, disconnected when the field disconnects.
- The binding's own observers: none. It writes `ariaLabelledByElements`, `ariaDescribedByElements`,
  `aria-invalid` and `inputmode` on the box inside each text component after every draw (shared.ts,
  `describe`), which needs no observer: nothing in Fluent rewrites them.

## Markers on <body> or <html>

None. Fluent writes no class or attribute on either.

## Nodes added outside the form's root

None measured for the first set of elements (`fluent-field`, text input, textarea, text, radio group).
Fluent's dropdown and menu open their lists as popovers in the top layer, still in the form's tree.

## Globals

- `globalThis.Fluent`: `{ setTheme }`, Fluent's theme function for a page without a bundler.
- `globalThis.__FOCUSGROUP_POLYFILL__`: the focusgroup polyfill's shared state (`{ o: Set, b: boolean }`).
- A Trusted Types policy named `fast-element` (FAST's HTML policy), created when the script loads. A
  page that enforces Trusted Types lists it in `trusted-types` beside Datum's `datum-assets`.
- The `fluent-*` custom elements on the page's `customElements` registry: one definition per tag per
  page, so a page draws every form with **one release** of Fluent UI Web Components.

## Known defect of the release (not the binding's)

A data grid whose rows can be reordered reaches the same defect through its Move up and Move down:
the page raises one console exception per Fluent field in the moved row (values stay correct).

A `fluent-field` that is disconnected and connected again (the form element moved in the DOM, a
`mountLive` host moved, a keyed row moved) throws `TypeError: Cannot set property
slottedInputObserver of #<yo> which has only a getter` from FAST's `bindObservables` inside the
bundle: the FAST copy bundled into `web-components.min.js` treats the field's private
`_slottedInputObserver` as a value set before upgrade and writes it back through the getter-only
`slottedInputObserver`. Reproduced with Fluent's own markup and no Datum code (a field moved in a
shadow root, and a host moved in the document). The kit's behaviour cases MV-01 and MV-03 fail on it.
The binding does not work around it (defer to the design system); a host that moves forms waits for a
Fluent release that fixes it.

Upstream: no issue in microsoft/fluentui or microsoft/fast names `slottedInputObserver` or
describes this throw. `field.base.ts` on `master` still declares the getter beside `_slottedInputObserver`; `master`
moved to FAST Element v3 on 2026-06-26 (cb3684e3c), in no published release (npm `latest` is 3.2.1), and whether
that fixes it is unverified.

## What the host must provide

- A theme stylesheet from `theme/` (`teams-light.css` is what the kit uses; `teams-dark.css`,
  `teams-high-contrast.css`, `web-light.css`, `web-dark.css` are the others) as a stylesheet asset, or
  its own `setTheme()` on the page or on the `<datum-form>` element. Same-origin or CORS-enabled (the
  renderer fetches the stylesheet to rewrite it for the shadow root).
- `@fluentui/web-components@3.2.1`'s `dist/web-components.min.js` as a module script asset (it imports
  nothing).
- The page's language: Fluent words nothing a field shows; the form's own words are Datum's.
- No font files: the system font stack (Segoe UI on Windows). Nothing proprietary is served.
- For print and PDF: nothing; the form prints under Datum's themes (no Fluent print or PDF theme).
