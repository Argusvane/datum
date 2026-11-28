# Security headers

A form runs under a strict Content-Security-Policy. The plain form needs very little. Each optional part (the sandbox, the PDF kernel, a design-system binding) adds a directive of its own.

## The plain form

Datum's own look bundles its styles into the module and loads nothing else. The form adopts its rules as a constructed stylesheet, which `style-src` does not govern, so `style-src 'self'` without `'unsafe-inline'` holds. The page needs:

- Scripts from its own origin.
- Permission to fetch the definition.

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  connect-src 'self'
```

- `script-src` covers `datum-form.js` and the lazy chunks it imports.
- `connect-src` covers the fetch of the definition from `src`. Add the address your page posts submissions to, if it is not the page's own origin.

## What each part adds

| Part | Directive | Why |
|---|---|---|
| In-page sandbox (`wasm="auto"`) | `script-src 'wasm-unsafe-eval'` | The sandbox is compiled from WebAssembly bytes. Without it the form draws, and raises `datum-error` that the validation sandbox could not be loaded |
| PDF kernel (`pdf="auto"`) | `connect-src` for the font and image addresses | Fonts under `fonts/` and the images a PDF embeds are fetched. Without it `renderPdf()` rejects with "Failed to fetch" |
| A module or the manifest held to a hash (`wasm-integrity`, `pdf-integrity`, `pdf-pages-integrity`, `pdf-manifest-integrity`) | `script-src blob:`, and `worker-src blob:` for the builder's page images | See [Subresource integrity](#subresource-integrity) |
| A definition or module on another origin | `connect-src` or `script-src` for that origin, and `allow-origins` | See below |
| A design-system binding | `connect-src`, `font-src`, `img-src`, `script-src` | See below |

The sandbox in the page is for development and testing. A production page that validates on the server needs none of it. [Running the sandbox](/wasm-running#in-the-page) has the steps.

## A design-system binding

A binding loads its design system's files, which you serve. Each kind needs its own directive:

- **Stylesheets and font sheets.** The design system's, and every sheet they `@import`, are fetched so the text can be rewritten for the form, so their addresses need `connect-src`.
- **Font files and images.** The ones those sheets name are loaded by the browser and need `font-src` and `img-src`.
- **Scripts.** The design system's scripts are `<script>` elements and need `script-src`.

A page that serves everything from its own origin changes nothing.

A form drawn with the GC Design System binding, with GCDS 1.7.0 served from the page's own origin, was measured in Chromium under this policy:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  connect-src 'self' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com https://cdn.design-system.canada.ca
```

The lines beyond `'self'` exist because of that design system's own files: its stylesheet begins with an `@import` of Google Fonts, and its components load an icon font from its CDN. Read your design system's files for the equivalents.

The design system's own code may add an inline `<style>`, which `style-src 'self'` reports as a violation. The form still draws. See [Design-system bindings](/bindings).

When a file cannot be had (a policy refusal, no CORS, a network error, an HTTP error, an integrity mismatch), the form is not drawn. An alert takes its place, and the element raises `datum-binding-error` with `{ hook: "assets", url }` and `datum-error`. The console names the address.

## CORS

- **Stylesheets and font sheets.** The form must read their text, so they come from the page's own origin or from an origin that answers with `Access-Control-Allow-Origin`.
- **Scripts.** Module scripts are always fetched with CORS. A script that carries `integrity` is loaded with `crossorigin="anonymous"` and needs CORS too.
- **Design-system CDNs.** A CDN that sends no CORS headers cannot be used directly: serve the files yourself.
- **Definitions.** A definition on another origin needs CORS as well, because `src` is fetched with the page's own rules.
- **Server hosts.** They add none of these headers and no CORS headers to their own replies. A form on another origin from the host's routes needs the application's CORS configuration on the host, and `connect-src` and `allow-origins` apply to the submit URL as well. See [Server hosts](/server-hosts#different-origins).

## Subresource integrity

Give `integrity` on every entry of a binding's `assets`:

- `{ url, integrity }` for stylesheets and font sheets.
- `{ url, integrity, classic? }` for scripts.

Integrity is a list of `sha256-`, `sha384-` or `sha512-` digests, and anything else is refused before any fetch. The form checks stylesheets and font sheets itself, and the browser checks scripts.

A sheet that a listed stylesheet `@import`s is fetched without an integrity check, because only the listed file carries one. Self-host it and list it yourself if that matters.

Datum's own files are pinned as [Pinning the files](/files#pinning-the-files) shows: `integrity` on the tags, an import map for the chunks, and attributes for the modules the elements import themselves. Each attribute adds to the policy:

| Attribute | Directive | Why |
|---|---|---|
| `wasm-integrity` (form and builder) | `script-src blob:`, `connect-src` for the module's origin | The element fetches the sandbox module and imports the bytes it checked from a `blob:` URL |
| `pdf-integrity` (form and builder), `pdf-pages-integrity` (builder) | `script-src blob:`, `connect-src` for the module's origin | The same, for `datum-pdf.js` and `datum-pdf-pages.js` |
| `pdf-manifest-integrity` | `connect-src` for the manifest's and the files' origin; on the builder, `worker-src blob:` | The manifest, the fonts and the viewer's files are fetched and checked. The viewer's worker is started from a `blob:` URL of the bytes checked |

A builder drawing a page image and a form rendering a PDF, each pinning every file above and served from the page's own origin, were checked in Chromium under this policy (`npm run integrity:browser` in `packages/datum`):

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' blob: 'wasm-unsafe-eval';
  worker-src blob:;
  connect-src 'self';
  style-src 'self';
  img-src 'self' blob: data:;
  font-src 'self' blob: data:
```

`'wasm-unsafe-eval'` is for the viewer's image decoders, as without pinning. Without `blob:` in `worker-src`, opening a PDF in the area editor fails, saying so, and the editor draws blank sheets. Without pinning, the viewer starts its worker from its URL: `worker-src` then names the folder's origin, and a folder on another origin is started through a `blob:` wrapper the viewer writes, so `blob:` as well.

## `allow-origins`

`pdf`, `wasm`, `draft-store` and `validate-url` are held to the page's own origin. A URL on another origin is reported as `datum-error` and the attribute is ignored, unless `allow-origins` lists that origin. It takes space-separated origins, each written as a URL, for example `allow-origins="https://cdn.example"`. Write the host with its scheme: `*` and a bare host are refused.

## Trusted Types

A page that enforces Trusted Types allows Datum's policies by name. It needs no `default` policy.

| Policy | Created by | Without it |
|---|---|---|
| `lit-html` | The renderer, when the bundle loads | The bundle does not load |
| `datum-print` | The print frame, when it parses the print document | `print()` rejects with a message naming the policy |
| `datum-assets` | The first design-system script a binding asks for | A form whose binding lists a script is not drawn |

```
require-trusted-types-for 'script'; trusted-types lit-html datum-print datum-assets
```

- A page whose bindings list no script never creates `datum-assets` and can leave it out.
- A page that loads both `datum-form.js` and `datum-builder.js` creates each policy once per bundle, so add `'allow-duplicates'`.
- The builder draws its panels from markup and does not run on a page that enforces Trusted Types: serve it from an authoring page that does not.

## Print

Print never runs a design system's JavaScript. The print document is static markup, carries its own `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`, and is presented through a hidden `about:blank` frame, which takes the page's policy. A design system's stylesheets and font sheets are linked into the print document when a print theme other than Datum's is used, so they fall under `style-src` and `font-src`. See [Printing](/print).

## Other limits

- A page opened from `file://` cannot draw a design-system binding, because the browser refuses the fetch. Serve the page and the design system's files over HTTP or HTTPS, even locally.
- Pin one release of each design system per page: the first release to define a custom element wins, and nothing reports a different one.

For every directive measured, see the [host security guide](https://github.com/argusvane/datum/blob/main/docs/host-security.md).
