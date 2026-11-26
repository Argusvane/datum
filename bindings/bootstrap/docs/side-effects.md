# Bootstrap binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Pinned release: Bootstrap 5.3.8.

## Document-level styles and fonts

The renderer, not the binding, adopts Bootstrap's stylesheet into the form's shadow root (the
`:root` and `body` rules become `:host` rules, so the page element's custom properties, font and
colour reach the form) and puts any `@font-face` rules in `document.adoptedStyleSheets`, released on
the last unmount. Bootstrap's stylesheet declares no `@font-face`: its body font is the system font
stack, so there is no font file to serve and no font sheet. The binding adds no other sheet to the
document and none to the shadow root beyond the renderer's own adoption of the host's stylesheet and
its `css`. The select's chevron and the validation icons are data URIs inside the stylesheet, so
they need nothing else.

## Listeners, timers and observers on window, document or body

None. The binding starts no Bootstrap script (below), registers nothing on `window`, `document` or
`<body>`, and has no `connect` hook, so nothing needs a cleanup. Every handler is a lit event
binding on an element inside the form (`@input`, `@change`, `@click`, `@focusout` on the date),
removed with the element.

If the host loads `bootstrap.bundle.min.js` anyway (for the rest of its page), the script adds, on
load: `click`, `keydown` and `keyup` listeners on `document` and `load` and `resize` listeners on
`window` (measured on 5.3.8: nothing is added to `<body>`, `<html>` or
`<head>`). They belong to the host's page; the form does not use them and does not remove them.

## Why no Bootstrap script is started

Decision 12 starts a design system's script scoped to the form where the design system offers a
scope. Bootstrap's behaviour is a set of plugins (`Tab`, `Collapse`, `Dropdown`, `Modal`,
`Tooltip`, ...):

- Its data API is `document.addEventListener('click', '[data-bs-toggle=...]')` delegated from the
  document, and each plugin finds its target with `document.querySelector`. An event inside a shadow
  root is retargeted to the host element at the document, so no selector matches, and a target in
  the shadow root is invisible to the lookup.
- Instantiating a plugin by hand (`new bootstrap.Tab(button)`) still resolves its panel through
  `document`, so it cannot be started on the form either; there is no `scope` option.
- Nothing the binding draws needs one: the renderer shows the tab, runs the arrow keys, Home and End,
  opens a tab for an error and counts characters; the grid, steps and alerts are static markup.

So every component is drawn as Bootstrap's no-JavaScript markup, and **no `data-bs-*` attribute is
drawn at all**, so Bootstrap's script, if the host loads it, finds nothing in the form to act on
(checked by `src/checks.mjs`: with the script on the page a tab strip still switches by the renderer
alone and no tooltip, popover or backdrop node is added to the page). The capability answers follow
what is drawn: notices, prefix, suffix, the count and the hidden label are `drawn`; the tooltip is
`degraded` (Bootstrap's tooltip is Popper and a script's, so the renderer folds the help into the
hint), and so is pending (Bootstrap's spinner beside the word the renderer folds into the hint).

## Markers on `<body>` or `<html>`

None. Bootstrap's stylesheet needs no body class.

## Nodes added outside the form's root

None by the binding. Bootstrap's own script, if the host loads it, may add overlays (a modal's
backdrop, a tooltip) to `document.body` for the components it finds on the page; it finds none
inside the form.

## Globals

None defined by the binding. A host that loads `bootstrap.bundle.min.js` gets `window.bootstrap` and
a stray `window.uidEvent`.

## What the host must provide

- `bootstrap.min.css` of the release the binding was written against (5.3.8) as a stylesheet asset
  (`bootstrap.rtl.min.css` for a right-to-left page). No fonts, no script.
- Nothing else. A page language is the host's (`lang`), as for any form.

## Choices the binding makes where Bootstrap is silent or has more than one answer

- **Required is marked, optional is not.** Bootstrap's documentation marks neither (its checkout
  example marks the optional fields); its validation page puts `required` on the control, on each
  radio of a group too. The binding does that and also draws the form's `required` word (an
  asterisk) after the label in `text-danger`: the mark is the binding's choice, not Bootstrap's. It
  is hidden from assistive technology where the control says required (a text box, a select, a
  single checkbox, each radio) and read out on the legend of a checkbox group and a date, which
  carry no required state. The form may word a note explaining it (`requiredNote`).
- **A pending check is `degraded`.** The renderer folds the form's word ("Checking this answer…")
  into the hint, so it describes the control; Bootstrap's `spinner-border-sm`, hidden from assistive
  technology, stands at the start of that line. The renderer writes `data-pending` and `aria-busy`.
- **The error is Bootstrap's feedback.** `is-invalid` on the control and `invalid-feedback` after
  it; for radios and checkboxes the feedback is the last option's, after the last `is-invalid` input,
  as the validation page writes it. The message carries no `role=alert`: the summary is the alert.
- **The error summary is an alert.** Bootstrap has no summary component; its component for a message
  that needs attention is `alert alert-danger`, so the summary is one, with `alert-link`s.
- **Notices are alerts without a role.** A warning is `alert-warning`, info `alert-info`, the
  severity word read first; never error styling, never announced as an alert.
- **A date is three form controls in Bootstrap's grid.** Bootstrap has no date component, so day,
  month and year are `form-control` boxes in a `row g-2` (Datum's parts model, tier 1). Datum's
  order (day, month, year) stands.
- **The character count is form text.** Bootstrap has none: the limit sentence is visually hidden
  and the status is `form-text` (`text-danger` over the limit); the renderer counts and announces.
- **Tabs are `nav-tabs`; steps are `nav-pills`.** Bootstrap has no stepper; a step already reached
  is a button, the shown step the active pill, one not yet reached a disabled pill.
- **A data grid is a `table` in `table-responsive`**, or one `card` per row when stacked.
- **A button group is a spaced row.** `btn-group` expects its buttons as direct children and joins
  them; each button here is the renderer's field, so the group is a `d-flex gap-2` list.
- **No dark mode.** Bootstrap's dark mode is `[data-bs-theme=dark]` on an ancestor element, which a
  stylesheet adopted into a shadow root cannot match, and the binding has no attribute to put on
  the form (`formClass` is a class). The form draws light.
