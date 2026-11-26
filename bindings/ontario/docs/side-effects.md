# Ontario Design System binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Pinned release: Ontario Design System 9.2.2
(`@ongov/ontario-design-system-component-library` and `-global-styles`). Measured in Chromium with a form
drawn with text, date, radio, select and button components on a page that loaded the component library.

The component library is a Stencil library. Each `ontario-*` element upgrades itself wherever it is
connected, a shadow root included, so there is no scope to start it in and nothing for the binding's
`connect` to do (no `connect` on the binding, no cleanup to write). Without the script the
`ontario-*` elements stay inert (no label, no box), so there is no separate no-JavaScript baseline to
draw: the binding needs the script, and its capability answers describe what the components draw once they
have upgraded. The binding starts nothing of its own on `window`, `document` or `<body>`; the field
adapters keep one `MutationObserver` per field (below).

## Document-level styles and fonts

- **The renderer's one font sheet.** `ontario-theme.min.css` declares its `@font-face` rules (Open Sans,
  Raleway Modified, Courier Prime) with addresses relative to the stylesheet (`../../../fonts/...`).
  Only `@font-face` rules go to `document.adoptedStyleSheets` (fonts must be document-level to reach a
  shadow root): one sheet for the binding, released on the last unmount (measured: 1 while mounted, 0
  after), page-wide while it is there. The fonts folder must be served next to the stylesheet at the path
  its addresses resolve to; the binding names no font URL.
- **Stencil's hydration style.** The loader adds one `<style data-styles>` to `document.head` (the
  `visibility: hidden` until `.hydrated` rule for `ontario-*`). It stays for the life of the page and is
  harmless to the host's own elements. The renderer does not touch it.
- **Stencil's shared sheet.** Stencil adopts its components' shared sheet into the nearest shadow root, here
  the form's, and never takes it away. The renderer notes the root's adopted sheets before it adopts its own
  and, on unmount, removes every sheet added since, so a page that mounts and unmounts forms leaves nothing
  behind (conformance MNT-05).
- **The binding's own sheets.** The tier-2 `ontario-date` adopts one constructed sheet (the invalid border)
  into `<ontario-date-input>`'s own shadow root; it goes with the element.

## Listeners, timers and observers on window, document or body

Stencil registers these for the components the binding draws and removes them when the element
disconnects (the form unmounting). Measured by wrapping `addEventListener` / `removeEventListener` on
`window`, `document`, `<body>` and `<html>` before the script loaded: net count after mounting and
unmounting.

- `window`: `setAppLanguage` and `headerLanguageToggled`, one pair per component instance (every
  `ontario-input`, `-textarea`, `-dropdown-list`, `-radio-buttons`, `-checkboxes`, `-date-input`,
  `-step-indicator`). Back to the load baseline after unmount.
- `document`: one `keydown` listener (removed on unmount) and one listener of type `e`, added once by the
  library and left for the life of the page (one per page, not per form).
- No timers. No listener on `<body>` or `<html>`.
- Observers the binding adds: a `MutationObserver` per field on the component's shadow root and its box's
  `aria-describedby` (`keepDescription`), to keep Datum's notices, the count's limit sentence and the
  component's own error line in the box's description after the component redraws. Disconnected when the
  field leaves.
- Observers the library adds: `ontario-language-toggle` observes `<html>`'s `lang`; `ontario-hint-text`
  and `ontario-button` observe their own host's attributes.

## The language toggle writes `<html lang>` and tells every component

The one place the design system reaches past its own element: **connecting an `<ontario-language-toggle>`
sets `lang` on `<html>` of the host page** to its `language` property (measured: a toggle drawn with
`language="fr"` on an English page left `<html lang="fr">`), and emits `setAppLanguage` (composed, so it
reaches `window`), which every Ontario component on the page listens to. Changing the `language` property
later repeats both. Nothing undoes it when the toggle disconnects.

What the binding does about it: its `languageSwitcher` hook draws the real toggle (the design system's own
control) and answers its click first, in the capture phase, before the component's own handler, so a
click never runs the component's switch: the form switches locale in place through `switchTo`, and
`<html lang>` and the window events follow only the toggle's `language` property, which is the form's
current language. A host that does not want the page's language to follow the form leaves the language
switcher part out of the form (the form then has no toggle and writes nothing). The toggle can only offer
the other of English and French, so it is drawn only for a form in exactly one English (`en`, `en-*`) and
one French (`fr`, `fr-*`) locale; any other set of locales (English and Spanish, three languages) is
Datum's switcher, which lists each locale and writes nothing outside the form.

## Reported by the binding

`designSystem.sideEffects` lists the changes this page describes that reach past the form's root
(`<html lang>`, the page's custom-element registry, Stencil's style in `document.head`, the library's
`document` listeners), so `selfCheck()` and the conformance suite's run header report them.
They are reports, never problems.

## Markers on `<body>` or `<html>`

None, bar `<html lang>` through the language toggle (above). Ontario's stylesheet needs no body class.

## Nodes added outside the form's root

None. Nothing the binding draws is an overlay: `ontario-callout`, `ontario-page-alert` and
`ontario-hint-expander` draw in place. `selfCheck` reports what the form relies on the components to have
drawn (a box with the id given as `element-id`, one input per option, a date's three boxes).

## Globals

None on `window`. The loader defines the `ontario-*` custom elements on the page's `customElements`
registry: one definition per tag per page, so a page draws every form with **one release** of the design
system (a second release's script is ignored or collides).

## What the host must provide

- `ontario-theme.min.css` (the global styles: typography, the grid, the buttons' type scale, the
  visibility helpers, and the fonts' `@font-face`) as a stylesheet asset, and the component library's
  ES module script (`ontario-design-system-components.esm.js`) as a script asset, both from the one pinned
  release, same-origin or CORS-enabled (the renderer fetches the stylesheet to rewrite it for the shadow
  root); `binding-check.json` is the list the kit uses.
- The component library's `assets/` folder next to its script (the select's arrow is an image at
  `assets/ontario-material-dropdown-arrow-48px.svg`, found relative to the script; a `<base href>` on
  the page moves it) and the global styles' `fonts/` folder at the path the stylesheet's addresses resolve to.
- Optionally the design tokens (`@ongov/ontario-design-system-design-tokens`, `dist/css/_variables.css`) as a
  stylesheet: the binding's own CSS reads `--ontario-*` custom properties with the release's values behind
  them, so it draws Ontario's look with or without the file, and follows the host's tokens when they are served.
- The page's language: components take `language` from the binding (`en` or `fr`, from the form's locale)
  and a form in French on an English page is marked on the form element.
- The fonts' licence: the global styles ship their fonts under the SIL Open Font License 1.1
  (`dist/fonts/license/OFL.txt`); nothing proprietary is served, and no Ontario logo is drawn by anything here.

## Choices the binding makes where Ontario is silent or has more than one answer

- **The component draws the flag.** Ontario marks both `(required)` and `(optional)` itself in each
  label; the engine's `required` and `optional` words are the same ones in the binding's pack so the
  tier-2 date reads like the components.
- **The error summary is a page alert of the error type.** Ontario has no summary component; its pattern for
  an error that needs attention is the error page alert (heading, then the message). The heading is
  a fixed `h2` of the component, so `SummaryState.headingLevel` cannot be honoured (the design system's);
  the list of links is slotted, in the design system's own list and link styles (blue links in a red alert:
  the alert's rules for its links reach only content it draws itself, so they do not reach slotted
  links). The summary's heading wording ("Errors were found on this page") is the binding's, since the design
  system words none.
- **Notices are callouts without a heading.** `ontario-callout` with its yellow highlight for a warning and
  teal for information, the severity word bold first; never the error colour, never `aria-invalid`.
- **Pending is `degraded`.** Ontario's small loading indicator is not finished ("still under development" in
  the release) and its large one is a full-page overlay with an assertive live region, so the renderer's
  word is folded into the field's hint.
- **The hint's description.** The components pass the hint's id to the box as `aria-describedby`, but the
  hint draws in its own shadow root, below the box's, so the id names nothing. The binding draws the same
  words once more in the form's own tree, out of sight (`hidden`: still read as a description when
  something names it), and names it, with Datum's notices, the count's limit sentence and the component's
  own error line, in the box's description by element reflection (`ariaDescribedByElements`). That is
  the binding's addition; the visible hint is untouched.
- **`aria-invalid`.** No Ontario component writes it; the binding sets it on the box (and on a date's parts)
  while the field has a blocking error.
- **Disabled and read-only.** No Ontario component takes either (the design system's policy: keep fields and
  the submit action available, guide with validation). The boxes inside take both after each draw; a button
  that cannot be pressed now draws `aria-disabled` on the button inside and on its host, dimmed.
- **A number is a text box** with `inputmode` numeric or decimal (`ontario-input` has `type` text, tel,
  email or password).
- **An option's help is the hint expander** (Ontario's only per-option help); its summary is the form's
  "Help" word. A radio or checkbox option has no visible line of help.
- **A field's tooltip is the hint expander too** (`tooltip: drawn`): the field-level `hint-expander` of
  `ontario-input`, `-textarea`, `-dropdown-list`, `-radio-buttons` and `-checkboxes`, opened by the form's
  "Help" word, its content the tooltip. The expander's content is hidden until opened and lives in the
  component's shadow root, so the same words are drawn once more out of sight, under the id the renderer
  names for a drawn tooltip, and describe the box after the hint. The dates take no expander
  (`<ontario-date-input>` has none), so there the tooltip is folded into the hint (`degraded`).
- **A group's hint and a grid's error describe the group.** `ontario-fieldset` draws its `<fieldset>` in
  its own shadow root, so an id in the form's tree cannot reach it; the binding draws the hint as Ontario's
  hint component plus the same words out of sight, and names that copy and the grid's error in the
  fieldset's description by element reflection.
- **Focus on an `ontario-button`.** Its host takes no focus (no `delegatesFocus`), so the binding sends
  the host's `focus()` to the button inside: the renderer puts focus back on a row's button after a move
  and on Add after the last row is removed by the element it finds in the form's tree, the host.
- **Echo copies are inert.** The second copy of a summary or a receipt placed at both ends of the form is
  `aria-hidden` and `inert`, so its links are no tab stop.
- **A date is Datum's in Ontario's markup** (tier 2), year first in every language. The official
  `<ontario-date-input>` validates by itself when a box is blurred and has no property for an error someone
  else found; it is the plugin's `ontario-date` type (base `date`) with its own check switched off
  (`dateValidator`) and Datum's error drawn beside it.
- **Not drawn with an Ontario component** (Datum's adapter, tinted by `fallbackTokens` and reported by
  `unsupported()`): tabs, a lone checkbox (`ontario-checkboxes` always draws its legend, which would
  repeat the one option's label), files, signatures, chrome parts, prefix and suffix, placeholder, a hidden
  label (the components take none).
- **No dark scheme.** Ontario ships none; the form draws light.
- **No button group, no danger button.** Ontario's buttons are primary, secondary and tertiary; a danger
  button is secondary.
