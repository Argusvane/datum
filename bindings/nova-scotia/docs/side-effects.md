# Nova Scotia UI Pattern Library binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own files, does
beyond that is listed here, with how it is undone. Pinned release: nsgov/patternlibrary at commit
663c256 (`vendor/saltire/saltire.css`, Bootstrap v3.3.5 trimmed by the province; Font Awesome 4.7.0
for the glyphs its snippets write).

## Document-level styles and fonts

The renderer, not the binding, puts one sheet of `@font-face` rules in `document.adoptedStyleSheets`
for the host's stylesheets (a shadow root cannot register a font), and releases it on the last
unmount. saltire.css declares Open Sans and Roboto faces whose `.eot`, `.ttf` and `.svg` sources are
absolute `https://novascotia.ca/clf/fonts/...` URLs and whose `.woff` sources are relative
(`fonts/<file>`, the copies vendored beside the sheet); Font Awesome's stylesheet declares its own
face with a relative `../fonts/` URL. The renderer resolves the relative ones against each
stylesheet's address, so the host serves `fonts/` beside the saltire stylesheet and Font Awesome's
`fonts/` beside its css. A browser takes the first face it can read, so a host that serves the
`.woff` copies never asks novascotia.ca. The binding adds no other sheet to the document and none to
the shadow root beyond the renderer's own adoption of the host's stylesheets and its `css`.

## Listeners, timers and observers on window, document or body

None. The library ships no script, so the binding starts none and has no `connect` hook: nothing is
registered on `window`, `document` or `<body>`, and nothing needs a cleanup. Every handler is a lit
event binding on an element inside the form (`@input`, `@change`, `@blur`, `@click`, `@focusout` on
the date), removed with the element.

## Why no design-system script is started

Decision 12 starts a design system's script scoped to the form where the design system has one and
offers a scope. The pattern library has neither: its published files are `saltire.css` and the
snippets, and the snippets are plain HTML. Every component is therefore its no-JavaScript baseline,
which is its only form, so the capability answers are `drawn` wherever the markup is drawn (the
renderer counts a character count and announces it; the library has no count of its own). The
library has no tooltip or loading pattern, so those two are `degraded`: the renderer folds the
help and the "Checking this answer" word into the hint.

## Markers on `<body>` or `<html>`

None. saltire.css needs no body class.

## Nodes added outside the form's root

None.

## Globals

None.

## What the host must provide

- `saltire.css` of the release the binding was written against, as a stylesheet asset, with its
  `fonts/` folder served beside it, and Font Awesome 4.7.0's css (`font-awesome.min.css`) with its
  `fonts/` served beside that. Without Font Awesome the glyphs (the error, warning, info and success
  marks) draw nothing; every message still reads in words, and the glyphs are `aria-hidden`.
- The release's rules for the page are the host's: saltire.css styles the bare elements `body`,
  `label`, `legend`, `fieldset`, `input[type=text]` and `textarea`. The renderer maps `body` and
  `html` selectors to the shadow host, so the face, size, colour and line height arrive; descendant
  selectors that name `html` (`html input[disabled]`) are not mapped and do nothing in the form.
- One release per page. saltire.css is a plain stylesheet, not a custom-element library, so this
  is a convention rather than a collision, but a form is drawn against one sheet.

## Choices the binding makes where the library is silent or has more than one answer

- **saltire.css leaves out layout classes its own snippets write.** It keeps the feedback states
  (`.has-error`, `.has-warning`, `.has-success`) and the bare-element rules, and drops `.form-group`,
  `.form-control`, `.help-block`, `.radio`, `.checkbox`, `.sr-only` and `.input-group`.
  `src/css.ts` restates the few a form needs from Bootstrap 3.3.5's own sources
  (`RESTATED_CSS`) and keeps what the library has no markup for in `OWN_CSS`. The kit's references
  carry that sheet too (the kit draws a reference with the design system's files only), so the
  equality gate covers the markup, the renderer's wrapper and the shadow transfer, not those rules.
- **`.visually-hidden` is not used.** In saltire.css it is `visibility: hidden`, which hides text
  from assistive technology too. Hidden text is Bootstrap 3's `.sr-only`, restated.
- **Hint and error are both `.help-block`** (the library's own pattern); the error state is
  `has-error` on the group, never on the control, and the glyph sits after the box as in
  `forms/form-group-has-error.html`. In a group of choices the glyph goes in front of the message,
  since there is no single box to put it beside.
- **A warning is the library's warning pattern** (`has-warning`, `fa-exclamation-triangle`,
  `forms/form-group-has-warning.html`) and info a help block with `fa-info-circle`
  (`feedback/feedback-info.html`). Neither is an alert, neither marks the field invalid, neither
  enters the summary. When a field has an error and a warning, `has-error` wins on the group and the
  warning keeps its own colour.
- **Required is marked, not optional.** The library marks neither. Its Drupal forms mark the
  required fields with an asterisk, so the binding writes `abbr[title=required]` and
  `aria-required`, and a sentence above the fields that says what the asterisk means.
- **The error summary is the library's alert block** (`feedback/feedback-error.html`): a glyph and
  an `.alert-message`. Its snippet words the message as a paragraph; the binding draws a heading
  element at the level the form's place in the page gives it, in the block's bold line, and leaves
  out the snippet's `aria-label="alert"` (the role names it).
- **Radios and checkboxes are `.radio > label > input`** (the checkbox snippet's own structure,
  `forms/form-checkbox.html`), not the radio snippet's box followed by a block label on its own line.
- **Buttons carry `.btn`** with the snippet's variant (`btn-default`, `btn-success`, `btn-clear`).
  `.btn-lg` carries a page-level margin (`54px auto`); inside a form the binding sets it to zero.
- **Steps are the progress tracker** (`navigation/progress-tracker.html`, a `ul.pagination`): the
  shown step `active`, a step that can be opened a link, the others `disabled`.
- **A data grid is the library's table** (`table table-condensed`); left to the form it is a table
  while its box is wide and blocks with the labels shown when it is narrow (a container query).
- **Not drawn by the library, drawn by Datum and reported by `unsupported()`:** tabs (the library
  has none), files, signatures, chrome parts, the submitting line. They carry the library's colours
  through `fallbackTokens`.
