# Alberta Design System binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Pinned release: `@abgov/web-components` 3.2.0.

The measurements below are from `tests/extras.mjs` and the kit's browser session (Chromium 158): a
form drawing every component the binding uses (`goa-form-item`, `goa-input`, `goa-textarea`,
`goa-dropdown`, `goa-radio-group`, `goa-checkbox-list`, `goa-checkbox`, `goa-button`, `goa-table`,
`goa-callout`, `goa-date-picker`) mounted on a page, then unmounted.

## Why the binding starts no script

Decision 12 starts a design system's script scoped to the form where the design system offers a
scope. Alberta's script (`index.js`) is a set of Svelte custom elements: each `goa-*` element
upgrades itself wherever it is connected, including inside the form's shadow root, so there is
nothing to scope and nothing to start. The binding has no `connect` and writes no `data-module`.
Components that look through `document` for something of their own (a popover's close event, the
accordion and data grid's pointer handling) are ones the binding does not draw.

## Document-level styles and fonts

The renderer, not the binding, puts one sheet of `@font-face` rules in `document.adoptedStyleSheets`
for the host's `index.css` (a shadow root cannot register a font) and releases it on the last
unmount. `index.css` declares Acumin (Adobe Typekit, `use.typekit.net`) and Roboto Mono
(`fonts.gstatic.com`) with absolute URLs, and `@import`s a Google Fonts stylesheet for Roboto Mono:
a host's Content Security Policy must allow those font and style origins, and a page offline shows
the stylesheet's fallback faces (`helvetica-neue`, `arial`). The binding adds no other sheet to the
document and none to the shadow root beyond the renderer's own adoption of the host's stylesheet and
its `css`.

## Listeners, timers and observers on window, document or body

None by the binding. The design system's script adds, while its elements are mounted: a `keydown`
and `pointerdown` / `pointerup` / `pointercancel` set on `document` and a `resize` on `window` (each
removed by the elements on unmount), and, never removed by 3.2.0: **a `goa:closePopover` listener on
`<body>`** (`goa-popover`'s close signal, added once by the first component that uses one) and **a `reset`
listener on `document`** (the Svelte runtime bundled in `index.js` adds it once, to keep a bound
control in step with a form reset). Both are the design system's, inert once no component needs them,
and not the binding's to remove: a binding that reached for them would be patching the design
system. Every handler the binding writes is a lit event binding or a `MutationObserver` on an
element inside the form (`keepDescription`), removed with the element or by the field's cleanup.

## Markers on `<body>` or `<html>`

None. The stylesheet needs no body class.

## Nodes added outside the form's root

None by the binding. Alberta's own overlays (a modal, a drawer, a popover's panel, a circular
progress with a message) append to `document.body` for the components that use them; none of those
is drawn by the binding. The dropdown's list (the package's `goa-dropdown` type, drawn non-native)
renders inside the component's own shadow root.

## Globals

`window.__svelte`, the Svelte runtime's version registry, is defined by the design system's script
once a page loads it. The binding defines none.

## What the host must provide

- `index.css` and `index.js` of the release the binding was written against (3.2.0), as a stylesheet
  and a script asset. **One release of the design system per page:** custom elements register once,
  so a second release's script is ignored or collides.
- Ionicons (`ionicons.esm.js`, the design system's README asks every page for it) for `goa-icon`:
  without it the error, callout and dropdown icons draw as empty boxes. The binding draws icons only
  through `goa-icon` and never ships one.
- Network access to the font origins above, or a font stylesheet of the host's own.
- A page language is the host's (`lang`), as for any form. Alberta's components are worded in
  English only (the "(required)" mark `goa-form-item` writes after a label, the "Previous" and
  "Next" words of a calendar): a form in another language keeps those words in English, and the
  binding's language pack carries English only (`src/texts.ts`).

## Choices the binding makes where Alberta is silent or has more than one answer

- **The label, help text and error message are `goa-form-item`'s.** It writes `aria-label`,
  `aria-required` and `aria-describedby` onto the control with ids inside its own shadow root, which
  the control (in `goa-input`'s own shadow root) cannot resolve: a screen reader on the control hears
  neither the help text nor the error from the design system's markup (the design system's own
  limit, `idsWrittenBy: "component"`). So that Datum's description reaches the control anyway, the
  binding writes the help text (with the tooltip, pending and worked-out words the renderer folds
  into it) and the blocking errors as the control's own `aria-description`, and what Datum describes
  the control by that lives in the form's tree (a field's notices, the count's limit sentence) is
  added by element reflection (`ariaDescribedByElements`). A group (radios, checkboxes) carries
  both on the element inside the component that has the group's role. A design-system release that
  resolves its own ids would read the help text and error twice (no version detection).
- **Warnings and info are `goa-callout`**, `type="important"` (warning) and `type="information"`,
  `emphasis="low"`, with the severity word read first for assistive technology. Never `emergency`,
  never an alert, never in the summary.
- **The error summary is `goa-callout type="emergency"`** over a list of links, as `goa-fieldset`
  draws a form's errors. A callout's heading is a property, not an element: the summary's heading
  level (`SummaryState.headingLevel`) cannot be honoured, and the callout is named by `aria-label`.
- **Native select.** `goa-dropdown` is drawn `native="true"` (a real `<select>` in the design
  system's face: the browser's listbox, keys and autofill), with an empty first choice worded as the
  placeholder (a native dropdown draws none of its own, and would show the first option as chosen).
  The component's own listbox is the package's `goa-dropdown` type.
- **A date is Datum's date in Alberta's pieces**: month, day, year in `goa-form-item`s with a
  `goa-dropdown` and two `goa-input`s. The official `goa-date-picker` is the package's type, read
  through its inner controls because it says a date only when whole.
- **Tabs and steps are Datum's own**, in Alberta's tokens: `goa-tabs` and `goa-form-stepper` keep
  their own selection and initialise once from their children, which a renderer-owned selection
  cannot drive. `unsupported()` reports it.
- **A data grid left to the form is stacked** (a fieldset per row, the cells keep their labels):
  `goa-table` cannot change with the width. An explicit `table` layout is `goa-table`.
- **A busy page or form draws `aria-disabled`, never `disabled`.** The form's own button writes no
  `disabled` attribute when it is not disabled: the renderer's button module reads the attribute's
  presence, and `goa-button` is told `disabled` by string.
