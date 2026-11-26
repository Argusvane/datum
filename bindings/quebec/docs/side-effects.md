# Québec design system binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Pinned release: `qc-trousse-sdg` 1.6.1 (ISC).

The measurements below are from `tests/extras.mjs` and the kit's browser session (Chromium 158): a
form drawing the components the binding uses (`qc-textfield`, `qc-choice-group`, `qc-checkbox`,
`qc-notice`, `qc-icon`, and the package's `qc-select`) mounted on a page, validated, then unmounted.

## Why the binding starts no script

Decision 12 starts a design system's script scoped to the form where the design system offers a
scope. The toolkit's script (`qc-sdg.min.js`) is a set of Svelte custom elements: each `qc-*` element
upgrades itself wherever it is connected, including inside the form's shadow root, so there is
nothing to scope and nothing to start. The binding has no `connect`.

The script must be a **classic script**: it reads `document.currentScript` for its own address and
two attributes when it loads, so it cannot be loaded as a module. The host gives it as
`{ url, classic: true, attributes: { "sdg-css-path": "<the stylesheet>", "sdg-assets-base-path": "<the dist folder>" } }`.
Every component links the stylesheet at `sdg-css-path` into its own shadow root, so that path and
the stylesheet the host gives as an asset must be the same file.

## Document-level styles and fonts

The renderer, not the binding, puts one sheet of `@font-face` rules in `document.adoptedStyleSheets`
for the host's stylesheet (a shadow root cannot register a font): 17 faces (Open Sans, Roboto and the
Material Symbols icon font), resolved against the stylesheet's address (`../fonts/*.woff2`), released
on the last unmount. The binding adds no other sheet to the document. In the form's shadow root the
renderer adopts the host's stylesheet and the binding's `css`; each `qc-*` element also draws a
`<link rel="stylesheet">` to `sdg-css-path` inside its own shadow root (the toolkit's doing: one cached
request, not the binding's).

## Listeners, timers and observers on window, document or body

None by the binding. Measured with the toolkit's script on the page and the components mounted, all
by the Svelte runtime inside `qc-sdg.min.js`: `document`: `click`, `keydown`, `keydown` (capture),
`change`, `focusout`, and (added once, the first time a field is drawn) `reset` (capture); `body`:
`click`, `keydown`; `window`: `scroll` and, from a component the binding does not draw, `resize`.
They are delegated handlers of the runtime and stay after the form is unmounted; none is the
binding's to remove. Every handler the binding writes is a lit event binding or a `MutationObserver`
on an element inside the form (`keepIds`, `keepGroup`), removed with the element or by the field's
cleanup.

## Reported by the binding

`designSystem.sideEffects` lists the changes above that reach past the form's root (the `qc-dark-theme`
class on `<html>`, the page's custom-element registry, `window.__svelte`, the runtime's delegated
listeners), so `selfCheck()` and the conformance suite's run header report them. They
are reports, never problems.

## Markers on `<body>` or `<html>`

**The toolkit's script adds the class `qc-dark-theme` to `<html>` when the page loads under a dark
operating-system preference** (`prefers-color-scheme: dark`), and never removes it. Nothing is written
to `<body>`. The class changes the page, not the form: the form draws the scheme the host asks for
(`colorScheme`), by setting the same class on the form element itself (`formClass`), so a form in a
dark page is not dark by accident.

## Nodes added outside the form's root

None by the binding or by the components it draws: the select's list (the package's `qc-select` type)
renders inside the component's own shadow root, and the notices are inline. Components the binding does
not draw (`qc-alert`'s banner, `qc-tooltip`, `qc-to-top`, `qc-piv-header` and `qc-piv-footer`) are the
page's.

## Globals

`window.__svelte`, the Svelte runtime's version registry, is defined by the script. The binding
defines none.

## What the host must provide

- `qc-sdg-rfz100.min.css` (or `qc-sdg.min.css`) and `qc-sdg.min.js` of the release the binding was
  written against (1.6.1), as a stylesheet and a classic script with the two attributes above, and the
  `fonts/` folder beside the stylesheet's `../fonts/`. **One release of the toolkit per page**: custom
  elements register once, so a second release's script is ignored or collides.
- A **root font size that matches the stylesheet**: the `rfz100` sheets size everything in `rem` for a
  16px root, the plain ones for a 10px root (a `62.5%` root). `designSystem.rootFontSize` is 16 (what
  the binding draws with); a host on a 10px root gives `assets.rootFontSize: 10` and the renderer
  rewrites the sheet's `rem`. `selfCheck` measures body text and reports a mismatch.
- A page language (`<html lang>`): the toolkit reads **the page's** language, not the form's, for its
  own words (the required-field default, a notice's icon label, the count). The binding hands it the
  form's words wherever the toolkit takes any (`label`, `description`, `invalid-text`, its own count is
  Datum's), so a French form on an English page reads French; what stays in the page's language is a
  notice's icon label ("Avis d'erreur" / "Error notice").
- Network access to the stylesheet's origin for the fonts, or the fonts served beside it.

## Choices the binding makes where Québec is silent or has more than one answer

- **The components wrap a native control the binding writes inside them.** `qc-textfield`,
  `qc-choice-group`, `qc-checkbox` and `qc-select` read their label, options and answer from the light
  DOM and move their own label, description, count and error nodes beside it. The templates keep the
  wrapped control as the element's static child, and put nothing of lit's between it and the nodes the
  component inserts.
- **`invalid` is bound as a property through `live()`.** The toolkit clears its own `invalid` when the
  person types; Datum decides when an error stands, so the property is written again whenever the
  element disagrees. The label, description and error strings are inserted as HTML by the toolkit and
  are escaped by the binding.
- **The description of the control.** `qc-textfield` writes `aria-describedby` itself
  (`idsWrittenBy: "component"`) with ids in the form's tree; Datum adds the ids the toolkit does not know
  (a field's notices, the count's limit sentence) and keeps them when the toolkit rewrites the
  attribute. `qc-choice-group` draws its error in its own shadow tree, whose ids a slotted control cannot
  name, so the fieldset the component draws names the error, the help text and the notices by element
  reflection (`ariaDescribedByElements`), and by `aria-description` where the browser has none. A lone
  `qc-checkbox` takes no description (the custom element does not pass the inner component's
  `description` through), so its hint is the toolkit's `.qc-description` slotted under the label and
  named by the checkbox (`aria-describedby`); its errors and notices are the checkbox's own
  `aria-description`, since its error is drawn in the component's shadow tree.
- **The character count is Datum's, in the toolkit's markup** (`.qc-textfield-charcount`). `max-length`
  counts from the component's own `input` listener, speaks on every keystroke and goes stale when a rule
  writes the value; Datum counts code points, announces once when typing pauses and tells assistive
  technology the limit as the field's description.
- **Warnings and info are `qc-notice`** (`type="warning"` and `type="information"`), the severity word
  read first, never `type="error"`, never an alert, never in the summary. The notice's box takes focus (a
  tab stop, the toolkit's own choice), one per notice.
- **The error summary is `qc-notice type="error"`** over a list of links, as the toolkit's documentation
  writes an error notice, with the heading as a slotted element at the level the form asks for. Its box
  takes focus after a refused submit.
- **No prefix, no suffix, no hidden group legend, no group or option hint of the toolkit's own.**
  Answered `none` or drawn in the toolkit's classes: the hints are `.qc-description`, the option hint of
  a selection button is `.qc-tile-description`. A hidden legend would need the legend in the component's
  shadow tree, so radios and checkboxes always show theirs.
- **Tier 2, the select.** `qc-select` is a custom listbox (a button and a list in its own shadow root,
  the native `<select>` hidden, its own keys, search and multiple choice). `select` is Datum's native
  select in the toolkit's face (its text box's tokens: `--qc-color-formfield-*`, the toolkit styles no
  native select); the official component is the package type `qc-select` (base `select`) in the
  package's FormPlugin, with a read-only guard of its own and the button as its focus target.
- **A date is Datum's date in the toolkit's pieces**: day, month and year in three `qc-textfield`s in a
  `fieldset.qc-fieldset`, as the toolkit's documentation lines fields up (`qc-formfield-row`). The toolkit
  has no date component.
- **A number is a text box** with a numeric keyboard (`inputmode`), never `type="number"`, as the box
  keeps what was typed.
- **A data grid is stacked**: the toolkit's `qc-table` clones and moves its rows for the small screen,
  which a table of live inputs cannot survive, and has no layout of inputs in a table.
- **The tooltip is folded into the description** (`degraded`), although the toolkit documents a
  `qc-tooltip` in a field's label (`Tooltip/_tooltip.html`, "Ajout dans un libellé de champ texte"). Inside
  the form it does not fit: its `description-id` is looked up with `document.getElementById`, which
  finds nothing in the form's shadow root (only the `description` attribute, inserted as HTML, would
  carry the words); on a window narrower than the toolkit's small breakpoint (the window's width, not
  the form's) it opens as a modal `<dialog>` and sets `overflow: hidden` on the host page's `<body>`
  until it closes; each instance adds a `resize` listener on `window` and never removes it, so an
  unmounted form would leave it behind; and its button, an `<a role="button" href="#top">` inside the
  `<label>`, would join the field's accessible name while nothing describes the field by the help.
- **Tabs and steps are Datum's own**, in the toolkit's tokens (`fallbackTokens`): the toolkit has neither.
  `unsupported()` reports it.
- **Dark scheme.** The toolkit sets its dark palette on `.qc-dark-theme`; the form element carries the class
  while the host's scheme is dark, and the binding declares again the toolkit's semantic tokens
  (background, text, form-field borders, links), which the toolkit resolves once on `:root` and which a
  class below the root would otherwise keep light.
- **A busy page or form draws `aria-disabled`, never `disabled`** (the toolkit's `qc-disabled` look).
