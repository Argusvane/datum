# U.S. Web Design System binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. Pinned release: USWDS 3.14.0.

## Document-level styles and fonts

The renderer, not the binding, puts one sheet of `@font-face` rules in `document.adoptedStyleSheets`
for the host's USWDS stylesheet (a shadow root cannot register a font), and releases it on the last
unmount. USWDS's stylesheet declares Source Sans Pro Web, Merriweather, Public Sans and Roboto Mono
with relative `url()`s, which the renderer resolves against the stylesheet's address, so the host
serves `dist/fonts/` beside `dist/css/`. The binding adds no other sheet to the document and none to
the shadow root beyond the renderer's own adoption of the host's stylesheet and its `css`.

## Listeners, timers and observers on window, document or body

None. The binding starts no USWDS script (below), registers nothing on `window`, `document` or
`<body>`, and has no `connect` hook, so nothing needs a cleanup. Every handler is a lit event
binding on an element inside the form (`@input`, `@change`, `@click`, `@focusout` on the memorable
date), removed with the element.

## Why no USWDS script is started

Decision 12 starts a design system's script scoped to the form where the design system offers a
scope. USWDS offers none through its published files:

- `dist/js/uswds.min.js` (the package's `main`) is one browserify bundle that starts itself on
  `document.body` when it loads (`start.js`: `behavior.on(document.body)` for every component) and
  exports nothing: `uswds.components` is set on a module-private object, and the only global it
  defines is `window.uswdsPresent`.
- Its handlers are delegated from `document.body` and match `event.target.closest(selector)`.
  An event inside a shadow root is retargeted to the host element at the body, so no selector
  matches: loaded by the host, the script finds nothing in the form and changes nothing in it
  (checked by `src/checks.mjs`: a character count in a form with the script on the page is
  counted by the renderer alone, and the script adds no `data-enhanced`, no live status).
- `behavior.on(root)` exists in USWDS's source (`@uswds/uswds/js` is the CommonJS component map),
  but using it means bundling that source into the binding, which would ship the design system's
  own files; the binding never does. A host that wants a USWDS component the binding does not
  draw (combo box, date picker, time picker, input mask, file input) can bundle `@uswds/uswds/js`
  itself and call `behavior.on(<form element>)`. Those behaviours look elements up through
  `document` and fail in a shadow root, so the binding does not offer them.

So every component is drawn as its no-JavaScript baseline, or as its script leaves it where the
behaviour is the renderer's. The capability answers follow what is drawn: the character count is
`drawn` (USWDS's markup after its script, the renderer counting and announcing); the tooltip is
`degraded` (USWDS's tooltip is a script's, so the renderer folds the help into the hint).

## Markers on `<body>` or `<html>`

None. USWDS's stylesheet needs no body class (GOV.UK's does).

## Nodes added outside the form's root

None by the binding. USWDS's own script, if the host loads it, may add overlays (a modal's
wrapper, for one) to `document.body` for the components it finds on the page; it finds none
inside the form.

## Globals

None defined by the binding. A host that loads `uswds.min.js` gets `window.uswdsPresent`.

## What the host must provide

- `uswds.min.css` of the release the binding was written against (3.14.0) as a stylesheet asset, with
  `dist/fonts/` served where its `@font-face` rules point (`../fonts/` from `dist/css/`). The sheet
  carries no custom properties; the binding reads none.
- Nothing else. A page language is the host's (`lang`), as for any form.

## Choices the binding makes where USWDS is silent or has more than one answer

- **Inline errors are alerts, as USWDS writes them.** USWDS's templates give
  `span.usa-error-message` `role="alert"` (usa-input.twig and every form pattern), and the binding
  draws it so: the role is the design system's choice, not the binding's to remove. The summary
  is an alert too, so a screen reader may read an error twice after a refused submit; that is
  USWDS's markup. The input carries `aria-invalid="true"` and is described by the message.
- **Required, not optional, is marked.** USWDS's address form marks the required fields with an
  asterisk (`abbr[title=required].usa-hint--required`) and says so in a sentence above the fields
  (`requiredNote`, drawn when the form has a required field); the binding does the same and sets
  `required` on the control, as that template does.
- **The error summary is an alert.** USWDS has no summary component; its guidance for a failed form
  is an error alert, so the summary is `usa-alert--error` with a `usa-list` of `usa-link`s.
- **Tabs are the segmented button group.** USWDS has no tabs; the nearest piece is
  `usa-button-group--segmented`, so the strip is built from it (roles, selection and keys are the
  renderer's).
- **A language selector of three or more languages is a list of unstyled buttons**, not USWDS's
  menu, which is a script's.
- **The form is USWDS's `usa-form usa-form--large`** (30rem), as USWDS's own form templates open.
