# GOV.UK Frontend binding: side effects outside the form

The binding draws inside the form's shadow root and writes nothing outside it. What GOV.UK
Frontend's own script does beyond that, and how the binding undoes it, is listed here (6.6.0, the
release this package pins). Behaviour of the design system's script is read from that release's
source; the cross-checks are in `src/checks.mjs` (real Chromium) and `datum-binding-check`.

## Document-level styles and fonts

None from the binding. GOV.UK's stylesheet is the host's file (`assets.stylesheets`) and the
renderer adopts it into the form's shadow root. Its `@font-face` rules for GDS Transport name
`/assets/fonts/...` URLs: a font-face inside a shadow root does not load, so the host supplies the
fonts as `assets.fonts` (the renderer then adopts one document-level sheet, released on the last
unmount). GDS Transport is licensed for GOV.UK services only; the binding never ships it and the
form falls back to Arial (the stylesheet's own fallback) when the host gives none.

## Listeners, timers and observers on window, document or body

Only when the host loads `all.bundle.js` and the page carries the body class below. `connect` calls
`GOVUKFrontend.initAll({ scope: <form> })` and records what the start adds to `window` and
`document`: `pageshow`, `keyup` and `beforematch` listeners and `setInterval` timers, for the
components that add them. GOV.UK has no teardown, so `connect`'s cleanup removes the recorded
listeners and clears the recorded timers on unmount. A listener the script adds later than the
start (on a user action) is not recorded; the one component the binding starts, the button,
adds none.

The binding starts only `govuk-button` (it writes `data-module="govuk-button"` on the buttons it
draws and on the journey's buttons). Radios and checkboxes (conditional reveal), the character
count, tabs and the error summary look elements up through `document`, which a shadow root hides,
so they are never marked and stay on the no-JavaScript baseline with their behaviour the
renderer's.

## Markers on <body> or <html>

Reads `govuk-frontend-supported` on `<body>`: GOV.UK's `initAll` refuses to start without it, and
it is the host page's template (the form's own `formClass` carries the same class for the styles,
which does not count for the script). Without the class nothing starts and `selfCheck` says so.
The Exit this page component writes a `data-govuk-frontend-exit-this-page-keypress` marker on
`<body>`; the binding never draws that component, and `connect`'s cleanup removes the marker if
the start added it.

## Nodes added outside the form's root

None. The components the binding does not start are the ones that would append to the page
(character count writes its status beside the textarea, inside the form; the accordion and the
password input are not drawn). `datum-binding-check` asserts no node is added to `document.body`.

## Globals

`window.GOVUKFrontend`, defined by the host's classic `all.bundle.js`. The binding reads it and
defines nothing.

## What the host must provide

- GOV.UK Frontend's stylesheet in `assets.stylesheets`.
- Optionally its `all.bundle.js` in `assets.scripts` as a classic script (without it the baseline
  is drawn, which is complete).
- `class="govuk-frontend-supported"` on `<body>` for the script to start.
- GDS Transport as `assets.fonts`, if the service is entitled to it.
- A page `lang` that matches the form's language, or the form's own `lang` (the renderer marks a
  form whose language differs from the page's).
