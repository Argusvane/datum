# Design-system bindings

Datum ships one official look, its own. A binding is how a form is drawn in another design system's look: a small package that draws each of the form's fields in that system's own markup and components. The renderer keeps the behaviour, so rules, errors, the error summary, journeys, grids, translations, read-only and disabled, print and the PDF layer all work through any binding.

## What is in the repository

Nine reference bindings, each in `bindings/<id>` with its tests:

- The GC Design System
- GOV.UK Frontend
- The U.S. Web Design System
- Bootstrap 5
- The Nova Scotia pattern library
- The Alberta Design System
- The Québec design system
- The Ontario Design System
- Fluent UI

They are references, demos and starting points. They validate the binding infrastructure against a broad range of design systems; they carry no support promise, no release matrix and no accessibility claim. They pass Datum's integration checks; each binding's page on this site gives the numbers.

Datum claims nothing about the accessibility of a design-system binding. The design system is the authority for its own look, markup and accessibility, and a binding draws it as the design system writes it. What Datum checks is the integration: what Datum passes in, owns or adds. The pages on the site list each binding's measured numbers.

Datum is not affiliated with or endorsed by any of these design systems or the organisations behind them; their names and artwork are theirs.

## Using one

The reference bindings live in Datum's repository and are not published as packages. To use one:

1. Build it with `npm run build` in `bindings/<id>`.
2. Serve its module (`dist/<id>.js`, or `dist/<id>.iife.js` for a classic script).
3. Make the binding with `bindings.fromFactory`, which calls the binding's factory with the page's lit and Datum's own binding.
4. Register it once with the design system's files as the host serves them.
5. Name it on any form.

For example:

```js
import { bindings } from "./datum-form.js";
import { createBinding } from "./bindings/gcds.js"; // bindings/gcds/dist/gcds.js

const binding = bindings.fromFactory(createBinding);
bindings.register(binding, {
  assets: {
    stylesheets: [{ url: "/design-system/gcds.css" }],
    scripts: [{ url: "/design-system/gcds.esm.js" }]
  }
});

// binding is a property of the element, not an attribute.
document.querySelector("datum-form").binding = "gcds";
```

- A form without a `binding` draws in Datum's own look.
- The builder's canvas takes the same registration and offers each registered binding in its picker.
- Choosing a binding changes how the form is drawn and nothing else: it writes nothing into the form's definition or its PDF layouts.

## Hosting the files

The host serves each design system's files, from the one release the binding was written against, and passes them as `assets` (see [Writing a binding](/writing-a-binding#assets)). What each reference binding needs from the page:

| Binding (release) | Stylesheet and fonts | Script | The page must also |
|---|---|---|---|
| GC Design System (1.7.0) | `gcds.css`. It imports Lato, Noto Sans and Noto Sans Mono from Google Fonts (`fonts.googleapis.com`, with the font files from `fonts.gstatic.com`), and the components load their icon font from `cdn.design-system.canada.ca`, so those hosts must be reachable, or the fonts served beside it. | `gcds.esm.js`, as a module. | Set `lang` to the form's language: the components take `en` or `fr` from the form's locale, and a form in French on an English page is marked. |
| GOV.UK Frontend (6.6.0) | `govuk-frontend.min.css`. Its typeface, GDS Transport, goes in `assets.fonts` only if the service is entitled to it; otherwise the form falls back to Arial. | `all.bundle.js`, as a classic script (`classic: true`). Optional: without it the complete no-script baseline is drawn. | Put `class="govuk-frontend-supported"` on `<body>`, or the script does not start. Match the page `lang` to the form's language. |
| U.S. Web Design System (3.14.0) | `uswds.min.css`, with `dist/fonts/` served where its `@font-face` rules point (`../fonts/` from `dist/css/`). | None. | Nothing else. |
| Bootstrap 5 (5.3.8) | `bootstrap.min.css` (`bootstrap.rtl.min.css` for a right-to-left page). No fonts. | None. | Nothing else. |
| Nova Scotia (saltire.css, release `663c256`) | `saltire.css` with its `fonts/` folder beside it, and Font Awesome 4.7.0's `font-awesome.min.css` with its `fonts/` beside that. Without Font Awesome the status glyphs draw nothing; every message still reads in words. `saltire.css` also names the Roboto and Font Awesome faces, other font formats and the icon sprite at `novascotia.ca`, and draws the footer background image from `beta.novascotia.ca`; both hosts must be reachable, or those files served beside it. | None. | Nothing else. One release of the sheet per page. |
| Alberta Design System (3.2.0) | `index.css`. It reaches `fonts.googleapis.com`, `fonts.gstatic.com` and `use.typekit.net` for its fonts; offline the form shows the sheet's fallback faces. | `index.js`, as a module. Also Ionicons (`ionicons.esm.js`): without it the error, callout and dropdown icons draw as empty boxes. | Know that Alberta's components word themselves in English only (the "required" mark, a calendar's "Previous" and "Next"). |
| Québec design system (1.6.1) | `qc-sdg-rfz100.min.css` with its `fonts/` folder at the sheet's `../fonts/`. | `qc-sdg.min.js`, as a classic script with two attributes: `sdg-css-path` (the stylesheet's URL) and `sdg-assets-base-path` (the `dist` folder's URL). | Set `<html lang>`: the toolkit reads the page's language, not the form's, for its own words. Use a 16px root font size, or pass `assets.rootFontSize: 10` for a 10px root (the plain sheets). |
| Ontario Design System (9.2.2) | `ontario-theme.min.css`, with its `fonts/` folder where its addresses resolve. Optionally the design tokens stylesheet. | `ontario-design-system-components.esm.js`, as a module, with the library's `assets/` folder beside it (the select's arrow is an image found relative to the script). | Set `lang` to the form's language. Ontario's language toggle writes the page's `lang`. |

```js
bindings.register(binding, {
  assets: {
    stylesheets: [{ url: "/ds/qc-sdg-rfz100.min.css" }],
    scripts: [{
      url: "/ds/qc-sdg.min.js",
      classic: true,
      attributes: { "sdg-css-path": "/ds/qc-sdg-rfz100.min.css", "sdg-assets-base-path": "/ds" }
    }],
    fonts: []
  }
});
```

- Each file must be same-origin or served with CORS: the renderer fetches the stylesheets to rewrite them for the form's shadow root.
- `integrity` is checked when given (`sha384-` followed by the digest).
- A file that cannot be had stops the form from drawing; an error takes its place and the element raises `datum-binding-error`.
- A page opened from `file://` cannot draw a design-system binding.

## Things to know

- Datum ships none of a design system's files. The host serves them, from the one pinned release the binding was tested against.
- A host with a Content-Security-Policy allows:
  - The design system's script addresses in `script-src`.
  - Its stylesheet addresses in `connect-src` (the sheets are fetched, then adopted).
- Where Trusted Types are enforced, a host allows these policies, and no `default` policy is needed:
  - The renderer's `lit-html` policy.
  - The print frame's `datum-print` policy.
  - For a binding that loads a script, the `datum-assets` policy the script's address is set through.
- A design system made of web components registers them once per page, so a page that draws forms with such a binding serves one release of it to every form.
- GOV.UK's typeface, GDS Transport, is licensed for GOV.UK services only. Datum never ships it, and neither does this site: the GOV.UK form on the site falls back to Arial.
- A design system's own script can reach outside the form (Ontario's language toggle writes the page's `lang`). Each binding's notes list what it does outside the form.

The full guide to writing and checking a binding, the binding kit and the conformance check are introduced in [Writing a binding](/writing-a-binding); this site's <a href="../bindings.html" target="_self">binding pages</a> show each reference binding live, with its measured numbers.
