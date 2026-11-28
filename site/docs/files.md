# Files you host

Everything the form and the builder need ships as files in one folder. This page says how to get the folder, what each file in it is for, and how to serve it. Serve the folder yourself, or load it from a CDN; either way the element fetches its optional parts from beside the bundle it was loaded from, so keep the folder together. Datum's own code fetches nothing from a third party at runtime.

## Getting the files

The folder is `dist/` in the npm package `@argusvane/datum`:

```sh
npm install @argusvane/datum
```

It lands in `node_modules/@argusvane/datum/dist/`. That folder is what this page describes: copy it to your static files and serve it. Each [GitHub release](https://github.com/Argusvane/datum/releases) attaches the same files, all but `types/`, as an archive, for a machine without npm, and a page can load them from a CDN instead: see [From a CDN](#from-a-cdn).

To build the folder from the repository instead, you need Node 22, npm and git. From a clone, `npm run setup` installs the packages you name, each in its own folder and in dependency order, and builds the PDF program; then the build runs:

<<< @/snippets/get-the-files.sh{sh}

The build writes `packages/datum/dist/`, the same folder. A Datum host builds the same folder into its own distribution; see [Server hosts](/server-hosts).

A page that only shows a form asks for three of these files: `datum-form.css`, `datum-form.js` and the core chunk that loads with it. Everything else is fetched when a form first needs it, so copy the whole folder and let the element choose.

Other builds:

- `npm run plugins:build` writes the Font Awesome icon set to `plugins/icons-fontawesome/dist/`.
- Each design-system binding builds in its own folder: see [Design-system bindings](/bindings).
- `npm run offline:bundle` assembles the folder, the bindings and the host packages into one archive, to carry a release to a network with no route to the Internet: see [Air-gapped deployments](/air-gapped).

## What is in the folder

| File | What it is | Loaded | Size (gzip) |
|---|---|---|---|
| `datum-form.js` | The form element, as a module. It defines `<datum-form>` and exports the API behind it | By your page | 150 KB, and a core chunk of 51 KB that loads with it |
| `datum-form.css` | An optional companion sheet: it gives the element a block box and keeps it unpainted until the script has defined it. Leaving it out does not change the form's look, which is inside the element | By your page | under 1 KB |
| `datum-form.iife.js` | The same element as a classic script, for a page without modules | Instead of the module | 340 KB |
| `datum-builder.js` | The builder, the PDF designer and the form, as a module | By a page that builds forms | 281 KB, and a core chunk of 214 KB |
| `datum-builder.css` | The same kind of companion sheet for the builder | By a page that builds forms | under 1 KB |
| `datum-builder.iife.js` | The same elements as a classic script | Instead of the module | 1.8 MB |
| `datum-wasm.js` | The in-page validation sandbox, with the sandbox engine inside | Once the form is live, when `wasm="auto"` | 357 KB |
| `datum-pdf.js` | The PDF kernel for the page, and `renderPdf` for a runtime | On the first PDF when `pdf="auto"` | 598 KB |
| `datum-engine.js` | The runtime with no element, as one module: for a web worker, a test or a script in Node. A page that shows a form does not need it | By your own script, never by the element | 92 KB |
| `datum-pdf-pages.js` | Page images of a PDF template, for the designer's preview | By the builder's PDF workspace | 156 KB |
| `datum-webauthn.js` | The passkey functions with no element, for a script that registers or signs with a passkey itself. The element loads its own passkey chunk instead | By your own script, never by the element | 7 KB |
| `datum-sandbox-program.js`, `datum-pdf-program.js` | The programs a server host runs inside its own WASM runtime | By your server, never by the page | 134 KB, 483 KB |
| `pdfjs/` | The PDF viewer the builder uses to show a template: its worker `pdf.worker.min.mjs` and the `cmaps/`, `iccs/`, `standard_fonts/` and `wasm/` folders it reads | By the builder's PDF workspace | 203 files, about 5 MB |
| `fonts/` | The faces the PDF module embeds: DejaVu Sans, Serif and Mono, seven files. Needed only with `pdf` | By the PDF module | about 3.4 MB |
| `builder-fonts/` | The builder's typeface, Geist and Geist Mono, with `builder-fonts.css` and its licence text | By the builder, when it has `load-fonts` | about 156 KB |
| `feature-files.json` | Which files each feature name loads, for a host that serves only what its `features` list needs | By your build or server | 18 KB |
| `types/` | TypeScript declarations for the elements, their properties and events: see [React, Vue and Angular](/frameworks#typescript) | By your build | about 350 KB |
| `datum-form-<name>-<hash>.js` and `datum-builder-<name>-<hash>.js` | Chunks the elements split off for themselves | By the element, when it needs the part | Between 1 KB and 250 KB each |
| `<bundle>.LICENSE.txt` | Beside each entry file: the third-party packages that bundle carries and their licence texts | Never. Keep them with what you serve | |
| `*.map` | A source map beside every script. Not in the folder unless the build was asked for them: `DATUM_SOURCE_MAPS=1 npm run datum:build` | By a browser's developer tools | about 75 MB in all |

The sizes are those of one build and change with the next. The `features` list decides which of them a page ever asks for; see [Leaving parts out](/leaving-parts-out).

### The chunks

A chunk's name says what it is.

- **The form's chunks.** `journey-engine-chunk` and `journey-diagnostics` (multi-page flows), `pdf-service` and `pdf-values` (the PDF action), `print-pipeline` (printing), `server-validator` (a journey's server check), `webauthn` (the passkey client) and `agent` (browser assistant tools).
- **The builder's chunks.** One chunk or more for each of its surfaces and panels: `logic-surface`, `data-surface`, `languages-surface`, `builder-variables-panel`, `builder-chrome-panel`, `builder-tests-panel`, `journey-designer`, `pdf-designer-chunk`, `command-palette`, `try-it`, `json-viewer` and the agent's.
- **Loaded with the entry file.** `core` and `assets`.
- **Shared.** A few small chunks are shared between parts.

`feature-files.json` says which chunks belong to which feature.

Each chunk carries a hash of its content in its name, so a name never changes what it holds. Serve them with the rest and let your cache headers treat them as immutable.

## Serving the folder

The form is static files. Serve the folder from any static host with correct MIME types, and keep its files beside each other, because the `auto` loaders look beside the bundle.

- **Caching.** Give the hashed chunks a long `Cache-Control` such as `public, max-age=31536000, immutable`. The entry files (`datum-form.js`, `datum-builder.js`, `datum-pdf.js`, `datum-wasm.js`, `datum-engine.js`) keep their names from release to release. Either serve each release from its own versioned folder and cache everything long, or let the entries revalidate. The Spring Boot and FastAPI hosts serve the bundle this way, under a versioned path.
- **A definition on another origin** needs CORS. A definition longer than 2 MiB is refused unless `max-definition-bytes` says otherwise.
- **The origin of the files.** `pdf`, `wasm`, `draft-store` and `validate-url` are held to the page's own origin unless [`allow-origins`](/security-headers#allow-origins) lists another. The headers a page needs for its own files are on [Security headers](/security-headers).

## From a CDN

Any CDN that serves npm packages serves the folder, at the package's version. With jsDelivr:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.js"></script>

<datum-form src="/forms/contact.json"></datum-form>
```

`unpkg.com/@argusvane/datum@0.1.0/dist/` serves the same files.

- **Pin the exact version** (`@0.1.0`), never a range or `latest`: the files under a version never change, and a page should not take a new release before you have tried it.
- **The parts load from the CDN too.** The chunks, the fonts and `wasm="auto"` / `pdf="auto"` resolve beside the bundle, so they come from the same CDN folder with no other setting.
- **A URL you write still follows the origin rule.** A `wasm`, `pdf`, `draft-store` or `validate-url` attribute that names a full URL on the CDN's origin needs that origin in [`allow-origins`](/security-headers#allow-origins). A definition in `src` on another origin needs CORS, as on any host.
- **Security headers.** A page with a Content-Security-Policy lists the CDN's origin in `script-src`, `style-src`, `font-src` and `connect-src`: see [Security headers](/security-headers).
- **A third party serves your code.** The CDN sees every visitor's address and decides what bytes arrive. For a form that collects records, host the folder yourself; for a network with no route to the Internet, see [Air-gapped deployments](/air-gapped). If you do load from a CDN, pin each file to its hash: see [Pinning the files](#pinning-the-files).

## Pinning the files

`integrity.json`, beside the folder in the npm package (`node_modules/@argusvane/datum/integrity.json`, or `@argusvane/datum@0.1.0/integrity.json` on a CDN), lists the sha384 Subresource Integrity of every file in the folder a page can load, by its path in the folder. Each [GitHub release](https://github.com/Argusvane/datum/releases) attaches the same list as `datum-integrity-<version>.json`. Hosting the folder yourself is the stronger choice for production; on a CDN, pin each file the page loads.

```json
{ "algorithm": "sha384", "files": { "datum-form.css": "sha384-…", "datum-form.js": "sha384-…", "datum-form-core-<hash>.js": "sha384-…", "datum-wasm.js": "sha384-…" } }
```

- **The entry files.** Give the bundle and the stylesheet their hash and `crossorigin`:

  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.css"
        integrity="sha384-…" crossorigin="anonymous">
  <script type="module" src="https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form.js"
          integrity="sha384-…" crossorigin="anonymous"></script>
  ```

  A classic script (`datum-form.iife.js`) takes the same two attributes.
- **The chunks a bundle imports.** The core chunk and the lazy chunks are imported by the bundle, not by a tag you write. List them in an import map's `integrity`, before the bundle's `<script>`; a browser that supports the key checks each one it imports:

  ```html
  <script type="importmap">
  { "integrity": {
      "https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form-core-<hash>.js": "sha384-…",
      "https://cdn.jsdelivr.net/npm/@argusvane/datum@0.1.0/dist/datum-form-pdf-service-<hash>.js": "sha384-…"
  } }
  </script>
  ```

  Take the names and hashes from `integrity.json`; `feature-files.json` says which chunks your `features` load. A browser without import-map integrity loads the chunks unchecked.
- **The sandbox module.** `wasm-integrity` holds the module `wasm` names to a hash: the form fetches it, checks its bytes and imports exactly those bytes, on every load and every retry, in every browser with Web Crypto (a secure context). A module that does not match is never run, and a submit reports the sandbox unavailable. The page's Content-Security-Policy then needs `blob:` in `script-src`, and the module's origin in `connect-src`:

  ```html
  <datum-form wasm="auto" wasm-integrity="sha384-…"></datum-form>
  ```

- **The PDF module and the builder's page images.** `datum-pdf.js` and `datum-pdf-pages.js` are imported by URL: an import map's `integrity` pins the first load, but after a failed load the element asks again with `?retry=n`, a URL the map does not list, and the PDF viewer's worker and data files cannot carry a hash. Serve these from your own origin.

## Classic scripts

`datum-form.iife.js` is the same element as a classic script, for a page that cannot load modules.

- It defines `<datum-form>` when it loads and exposes the API as `window.DatumForm`.
- `datum-builder.iife.js` does the same for the builder and the PDF designer, as `window.DatumBuilder`, which includes everything the form's global has.
- A classic script cannot split, so each carries its parts inline: there is nothing to delete from it, and `features` still decides what the element runs.

```html
<link rel="stylesheet" href="datum-form.css">
<script src="datum-form.iife.js"></script>
<datum-form id="f" language-switcher></datum-form>
<script>
  fetch("/forms/intake.json")
    .then(function (r) { return r.json(); })
    .then(function (definition) { document.getElementById("f").definition = definition; });
</script>
```

The PDF kernel and the sandbox are still separate files, fetched when the form asks for them. A registry such as the builder's themes is on the global, for example `DatumBuilder.builderThemes.register({ … })`.

## Plugins, bindings and icons

Plugins are built apart from this folder and served beside it. The Font Awesome icon set, `datum-icons-fontawesome.js` (and `datum-icons-fontawesome.iife.js`), is one: the page loads it and registers it on the element. A design-system binding is also its own file, `<id>.js` with an `.iife.js` twin, built in its own folder.

## Browser support

- The scripts are built for ES2020, and the PDF page module for ES2022.
- The builder uses CSS `color-mix()`.
- The validation sandbox needs WebAssembly.
- Signing with a passkey needs WebAuthn.

A browser without one of them loses that part and nothing else.

## Licence and notices

Datum is MIT licensed. The folder carries code and files with terms of their own:

- The DejaVu fonts in `fonts/`.
- The PDF viewer in `pdfjs/`.
- Geist in `builder-fonts/` (its licence text is beside it).
- Font Awesome's icons in the plugin.

Keep their notices with what you serve: `THIRD_PARTY_NOTICES.md` in the repository lists each, and the offline bundle carries it beside the licence.
