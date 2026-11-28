# @argusvane/datum

The Datum form renderer and builder as web components: `<datum-form>` draws a form definition and validates it, `<datum-form-builder>` is the builder that writes one. The package is the built bundles, so there is nothing to compile and no dependency to install: each bundle carries the engine it needs, and a page loads one with a `<script>`.

## Install

```sh
npm install @argusvane/datum
```

The bundles are plain ES modules (and, for the form and the builder, classic scripts) in `node_modules/@argusvane/datum/dist/`. A bundle loads its lazy chunks, fonts and data files from beside itself, so serve the whole `dist` folder (or the files you use) from one place and point a `<script>` at it:

```html
<link rel="stylesheet" href="/datum/datum-form.css">
<script type="module" src="/datum/datum-form.js"></script>

<datum-form src="/forms/intake.json"></datum-form>
```

`datum-builder.js` (with `datum-builder.css`) defines `<datum-form-builder>` and `<datum-form>` together. The same files are attached to each GitHub release as an archive, for a page that wants them without npm.

### From a CDN

Any npm CDN serves the same folder. Pin the exact version:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.js"></script>
```

The lazy chunks and `wasm="auto"` / `pdf="auto"` load from beside the bundle on the CDN, with no other setting. A `wasm`, `pdf`, `draft-store` or `validate-url` attribute that names a full URL on another origin needs that origin in `allow-origins`. [Files you host](https://datum.argusvane.com/docs/files#from-a-cdn) has the details.

Pin what a CDN serves to its hash. `integrity.json` in the package, beside `dist`, lists the sha384 of every file in `dist` (each release attaches it as `datum-integrity-<version>.json`):

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.css" integrity="sha384-…" crossorigin="anonymous">
<script type="module" src="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.js" integrity="sha384-…" crossorigin="anonymous"></script>
<datum-form wasm="auto" wasm-integrity="sha384-…"
  pdf="auto" pdf-integrity="sha384-…" pdf-manifest-integrity="sha384-…"></datum-form>
```

The chunks the bundle imports are pinned with an import map's `integrity`. The modules the elements import themselves are held to their hash by attributes: `wasm-integrity` for the sandbox (on the form and the builder), `pdf-integrity` for `datum-pdf.js`, and on the builder `pdf-pages-integrity` for `datum-pdf-pages.js`; the page's policy then needs `blob:` in `script-src`. `pdf-manifest-integrity` holds `integrity.json` itself to a hash, and every file the PDF modules fetch (the fonts, the PDF viewer's worker and its data) to the manifest; the builder's viewer worker then needs `blob:` in `worker-src`. A few files cannot be pinned (the viewer's colour profiles and its decoders' JavaScript fallbacks, which are then not loaded, and a PDF theme's own faces); [Pinning the files](https://datum.argusvane.com/docs/files#pinning-the-files) has every file and what cannot be pinned. For production, host the folder yourself.

## What is in `dist`

| File | What it is |
| --- | --- |
| `datum-form.js`, `datum-form.iife.js` | `<datum-form>` and the API beside it (the module, and a classic script that sets `window.DatumForm`) |
| `datum-builder.js`, `datum-builder.iife.js` | `<datum-form-builder>` and everything in the form bundle |
| `datum-engine.js` | the form runtime with no element and no DOM, for Node and workers |
| `datum-webauthn.js` | the WebAuthn functions with no element; no DOM needed, for Node, workers and pages |
| `datum-pdf.js`, `datum-pdf-pages.js` | the PDF module and the page imagery module, loaded on demand by the `pdf` attributes |
| `datum-wasm.js`, `datum-sandbox-program.js`, `datum-pdf-program.js` | the validation sandbox, and the programs a server evaluates in a QuickJS of its own |
| `<bundle>.LICENSE.txt` | the third-party licences of that bundle's code |
| `fonts/`, `pdfjs/`, `builder-fonts/` | fonts and data files the modules fetch, each with its licence |
| `types/` | TypeScript declarations for the entry points below |

## Importing from a bundler or Node

The package exports each module with its types:

| Import | Bundle |
| --- | --- |
| `@argusvane/datum` | `datum-builder.js`: everything |
| `@argusvane/datum/form` | `datum-form.js` |
| `@argusvane/datum/builder` | `datum-builder.js` |
| `@argusvane/datum/engine` | `datum-engine.js` (no DOM needed) |
| `@argusvane/datum/pdf` | `datum-pdf.js` |
| `@argusvane/datum/pdf-pages` | `datum-pdf-pages.js` |
| `@argusvane/datum/wasm` | `datum-wasm.js` |
| `@argusvane/datum/webauthn` | `datum-webauthn.js` (the WebAuthn functions with no element; no DOM needed) |
| `@argusvane/datum/dist/*` | any file in `dist` (stylesheets, fonts, programs) |

```js
import { createFormRuntime } from "@argusvane/datum/engine";
```

The declarations are self-contained. A few of them name types from `lit-html`, `@codemirror/autocomplete`, `@cantoo/pdf-lib` and `quickjs-emscripten-core`; those are optional peer dependencies, needed only by a project that type-checks without `skipLibCheck` and reads such a type.

## Documentation

Attributes, events, themes, bindings and the host guides: <https://datum.argusvane.com>. The source, the issue tracker and the licences of the repository: <https://github.com/argusvane/datum>.

## Licence

MIT, copyright Argusvane (`LICENSE`). The bundles carry third-party code under its own licences: `NOTICE` lists the packages and `dist/*.LICENSE.txt` holds their texts.
