# Host security for forms drawn with a binding

What a page that embeds a form needs to allow, and what it can lock down. Most of this
matters only when a form is drawn with a design-system binding (`bindings.register`), because
then the form loads the design system's files, which the host serves. Datum's own binding
(`datum`, the default) bundles its CSS into the module and loads nothing else.

The nine bindings under `bindings/` are reference implementations. A binding draws its
design system's markup, and the design system's own files and scripts are the host's to serve
and to vet. These notes cover what Datum loads and how; whatever a design system's script does
beyond that is the design system's business.

## What the page loads, and which directive governs it

| What | How it is loaded | Directive |
|---|---|---|
| Datum's bundles and their chunks (`datum-form.js`, the lazy feature files) | module scripts and `import()` | `script-src` |
| The binding module (`dist/<id>.js`, or your own bundle) | `import()`, or a classic `<script>` for the `.iife.js` | `script-src` |
| The design system's stylesheets (`assets.stylesheets`), font sheets (`assets.fonts`) and every sheet they `@import` | `fetch()`, so the text can be rewritten for the shadow root | `connect-src`, plus CORS |
| The rules of those sheets | adopted as constructed sheets in the form's shadow root; `@font-face` rules go into one sheet in `document.adoptedStyleSheets` | none: `style-src` does not govern constructed sheets |
| The files those rules name (font files, images) | by the browser, from the adopted rules | `font-src`, `img-src` |
| The design system's scripts (`assets.scripts`) | a `<script>` element in the document's `<head>`; a module unless `classic: true` | `script-src`, and the `datum-assets` Trusted Types policy (below) |
| The print document | a hidden `about:blank` frame, which takes the page's policy | below |
| The validation sandbox (`<datum-form wasm>`, `datum-wasm.js`) | QuickJS compiled from WebAssembly bytes in the module | `script-src 'wasm-unsafe-eval'` |
| The PDF fonts (`<datum-form pdf>`, `fonts/` beside `datum-pdf.js`) and the images a PDF embeds | `fetch()` | `connect-src` |

So a strict `style-src 'self'` without `'unsafe-inline'` does not stop the form's own sheets or
the design system's: `<datum-form>` adopts its own rules as a constructed sheet too.

Without `'wasm-unsafe-eval'` in `script-src`, the validation sandbox does not load: the form
draws and raises `datum-error` ("The validation sandbox could not be loaded"). Without
`connect-src` for the fonts' address, `renderPdf()` rejects ("Failed to fetch").

### A policy to start from

The GC Design System binding with GCDS 1.7.0 served from the page's own origin, measured in
Chromium:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  connect-src 'self' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com https://cdn.design-system.canada.ca
```

Each line beyond `'self'` is there because of the design system's own files. `gcds.css` begins
with an `@import` of Google Fonts. The renderer fetches imported sheets as well, so that address
needs `connect-src`. Without it the form is not drawn (see "When a file cannot be had"). GCDS's
components load their icon font from `cdn.design-system.canada.ca`, and they add an inline
`<style>` of their own, which `style-src 'self'` reports as a violation. Read your design
system's files for the equivalents: the `binding-check.json` of each binding lists the files it
was tested with. An offline pack of the binding ([Air-gapped deployments](air-gapped.md)) carries
those fonts itself, and then the policy names no origin but `'self'`. A form with the `wasm`
attribute adds `'wasm-unsafe-eval'` to `script-src`.

## CORS

The renderer must read a stylesheet's text, so a stylesheet or font sheet must come from the
page's own origin or from an origin that answers with `Access-Control-Allow-Origin`. Module
scripts are always fetched with CORS. A script that carries `integrity` is loaded with
`crossorigin="anonymous"`, so it needs CORS as well. A classic script without `integrity` does
not.

A design-system CDN that sends no CORS headers cannot be used directly: serve the files
yourself. Each binding's README names the release it pins. The site serves them
from the binding's pinned devDependency.

## Subresource integrity

Give `integrity` on every entry: `{ url, integrity }` for stylesheets and font sheets,
`{ url, integrity, classic? }` for scripts. Integrity is a list of `sha256-`, `sha384-` or
`sha512-` digests; anything else is refused before any fetch. `fetch()` checks the stylesheets
and font sheets, and the browser checks the scripts.

- A sheet that a listed stylesheet `@import`s is fetched without an integrity check, because
  only the listed file carries one. Self-host it and list it yourself if that matters to you
  (GCDS's Google Fonts import is an example).
- A script is loaded once per page, keyed by its absolute address. Naming the same address
  again with a different `integrity` is refused. A `<script>` with the same `src` that the page
  already carries counts as loaded: it is the page's own, so the renderer cannot check it. When
  you name an `integrity` for that address, the page's tag must carry the same one; a tag with
  another digest, or none, is refused (`AssetLoadError`), and the page's own value is what is
  remembered for the next form.

## When a file cannot be had

The renderer fails loudly. A stylesheet or script that cannot be fetched or run (a CSP
refusal, no CORS, a network error, an HTTP error status, an integrity mismatch) means the form
is not drawn. An alert takes its place ("This form could not be shown. Check the connection and
try again."). The element emits `datum-binding-error` with `{ hook: "assets", url }` and
`datum-error`, and the console names the address. There is no fallback to unrewritten links.
The builder's canvas fails the same way. A font sheet that cannot be had is reported and does
not stop the form: text falls back to another face.

## Trusted Types

A page that enforces Trusted Types (`require-trusted-types-for 'script'`) allows Datum's
policies by name in its `trusted-types` directive. It needs no `default` policy.

- `lit-html`: the renderer draws through lit-html, which creates this policy when the bundle
  loads. Without it the bundle does not load at all.
- `datum-print`: the print frame parses the print document through it. Without it, `print()`
  rejects with a message that names the policy.
- `datum-assets`: a design system's scripts (`assets.scripts`) are added as `<script>` elements
  whose `src` is set through it. It is created on the first script a binding asks for, so a page
  whose bindings list no script never creates it, and it passes only the addresses listed in
  `assets.scripts` (anything else handed to it throws). Without it in the directive, the form
  is not drawn: the alert takes its place, and `datum-binding-error` (hook `assets`) names the
  script and the policy.

```
require-trusted-types-for 'script'; trusted-types lit-html datum-print datum-assets
```

The names are exported as `PRINT_TRUSTED_TYPES_POLICY` and `ASSETS_TRUSTED_TYPES_POLICY`. Six
bindings list a script (GCDS, Alberta, Ontario, Québec, GOV.UK, Fluent); Bootstrap, USWDS and Nova
Scotia list none, and a page that draws only those can leave `datum-assets` out.

A page that loads both `datum-form.js` and `datum-builder.js` creates each policy once per
bundle. Add `'allow-duplicates'`, or the second bundle fails to load ("Policy with name
"lit-html" already exists").

What holds, measured in Chromium under that directive with `style-src 'self'`:

- `<datum-form>` and `<datum-form-renderer>` (given a runtime from `createFormRuntime`) draw,
  validate and print, with the Datum binding (also one made with `createDatumBinding`), a chrome
  `html` part, and the GCDS binding with its script. Datum itself raises no violation. The
  element's own rules are a constructed sheet, and its shadow tree is built from elements, never
  from markup.
- What a design system's own code does is the design system's: GCDS's components add an inline
  `<style>`, which `style-src 'self'` reports. They draw all the same.
- The builder (`datum-builder.js`, `<datum-form-builder>`) draws its panels from markup and does
  not run on a page that enforces Trusted Types: serve it from an authoring page that does not
  enforce them.

## Print

Print never runs a design system's JavaScript. The print document is static markup drawn by a
print theme from the print model, and it carries its own
`<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`. It is presented
through a hidden `about:blank` frame, which also takes the page's policy. Its `<style>` blocks
are applied as constructed sheets, so a strict `style-src` holds. A print theme's drawers
return `printHtml` markup, which escapes every value it is given. A drawer that returns a raw
string, or throws, sets the theme aside, and the form prints with the basic theme.

For a print theme other than Datum's two (`basicPrintTheme`, `datumPrintTheme`), the host's
`assets` stylesheets and font sheets are linked into the print document as
`<link rel="stylesheet">` (with `integrity` and `crossorigin="anonymous"` when an entry has
integrity). Scripts never are. Those links fall under the page's `style-src` and `font-src`.
[Print support](print-support.md) has the rest.

## `file://` pages

A page opened from `file://` cannot draw a form with a design-system binding: the browser
refuses `fetch()` of the stylesheet, and the form is not drawn. Serve the page and the design
system's files over HTTP(S), even locally.

## One release of each design system per page

Pin one release of a design system per page: the one the binding names in its README and in
`package.json` (`datumBinding.release` and the pinned devDependency).

- **Web-component design systems** (GCDS, Alberta, Québec, Ontario, Fluent UI) define custom elements,
  and a page has one custom-element registry. The first release to define a tag wins, and a
  second release's script loaded for another form is ignored or collides. Every form on the
  page then draws with whichever release defined its tags first.
- **Nothing reports a different release.** Datum reads no version from the design system's
  files. A page serving another release than the binding was written for draws with it
  silently, however far its markup or behaviour has moved. A binding's CI catches this before a
  page does: run `datum-binding-check --baseline` against the stored report of the last
  known-good release when the pinned release moves.
- **Page-wide state is shared.** The `@font-face` sheet (one per binding), the custom-element
  registry, a classic script's globals, and the changes each binding lists in its
  `docs/side-effects.md` (Ontario's language toggle writes `<html lang>`, for example) reach
  every form on the page.
