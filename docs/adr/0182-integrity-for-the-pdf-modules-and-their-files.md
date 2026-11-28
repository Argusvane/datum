# ADR 0182: Integrity for the PDF modules and their files

## Status

Accepted.

## Context

A page that loads Datum from a CDN pins what it loads to hashes: `integrity` on its tags, an import
map's `integrity` for the chunks the bundles import, and `wasm-integrity` for the sandbox module,
which the element fetches, checks and imports from a `blob:` URL of the bytes checked (ADR 0046).
The package's `integrity.json`, beside `dist`, lists the sha384 of every file in `dist`.

Three kinds of file were left out. `datum-pdf.js` (ADR 0045) and `datum-pdf-pages.js` (ADR 0057) are
imported by URL: an import map pins the first load, but the elements' retry asks for `<url>?retry=n`
(a browser keeps a failed import in its module map), which the map does not list, and the PDF module
imported a chunk beside it, so it could not be imported from a `blob:` URL. The files those modules
fetch (the PDF fonts, pdf.js's worker, standard fonts, CMaps, image decoders and colour profiles)
are fetched by URL, by the module or by pdf.js, and carry no hash. And `<datum-form-builder wasm>`
had no `wasm-integrity`.

## Decision

1. **Each PDF module is one file.** `datum-pdf.js` and `datum-pdf-pages.js` are built with no
   chunks (`vite.config.ts`, as the sandbox, engine and WebAuthn modules are), their dynamic imports
   inlined. `check-bundles.mjs` holds it: neither imports a file by a relative URL, neither has a
   chunk, and each has a size budget of its own. A module imported from a `blob:` URL has the blob as
   its `import.meta.url`, so each takes a `baseUrl` option (`createPdfSupport`,
   `createPdfPageRasterizer`) naming where it was fetched from, which the files beside it are found
   against.
2. **`pdf-integrity` and `pdf-pages-integrity` hold the modules to a hash.** `<datum-form>` and
   `<datum-form-builder>` take `pdf-integrity` (`pdfIntegrity`), the builder `pdf-pages-integrity`
   (`pdfPagesIntegrity`), as `wasm-integrity` is taken: the module is fetched, its bytes checked, and
   exactly those bytes imported from a `blob:` URL. The retry stays: after a failed load the element
   fetches `<url>?retry=n`, and those bytes are checked the same way. A module that does not match
   rejects as an `IntegrityError` that names the digest found, and is never run. Without the
   attribute a module is imported by its URL, as before. On the builder `pdf="auto"` means the
   bundle's own PDF chunk; with `pdf-integrity` it means `datum-pdf.js` beside the bundle instead, and
   with `pdf-pages-integrity` the imagery is `datum-pdf-pages.js` beside the PDF module, since only a
   module the element fetches can be checked by it. The no-element `renderPdf` takes the same three
   settings as options. The checks are `src/integrity.ts`, a lazy chunk of the element bundles that a
   page setting none of these never loads.
3. **One pinned hash for the manifest, then the manifest for the files.** `pdf-manifest-integrity`
   (`pdfManifestIntegrity`) holds `integrity.json` to a hash; `pdf-manifest` (`pdfManifest`) says
   where it is, by default `../integrity.json` from the PDF module, the npm package's layout that the
   CDNs serve. With it, every file a PDF module fetches is held to the hash the manifest lists for its
   path in `dist`, and a file it does not list is refused. The page pins one hash rather than one per
   file because the files a PDF needs are not known in advance (pdf.js asks for a CMap or a standard
   font by the document's contents) and are hundreds; the manifest is the release's own list, and its
   one hash covers every entry. The alternative, the module carrying its files' hashes in its own
   bytes, would pin the files with the module alone, but would grow each module by the table and tie
   the module to the exact assets copied beside it at build time; the manifest already exists and
   ships with each release. An unpinned manifest proves nothing, so `pdf-manifest` alone reads none.
   The manifest is not held to the page's origin, as the module attributes are: it is held to a hash.
4. **pdf.js's files go through hooks the module owns.** With the manifest, `datum-pdf-pages.js`
   fetches pdf.js's worker itself, checks it, and starts it as a module worker from a `blob:` URL of
   the bytes checked, handed to pdf.js as its `worker` (a `PDFWorker` over that port, not the global
   `workerSrc`, so a rasteriser without the manifest is unaffected). The worker is told not to fetch
   (`useWorkerFetch: false`), so pdf.js asks the page for its CMaps, standard fonts and wasm image
   decoders through its `BinaryDataFactory` (the one hook pdfjs-dist 6.5 has for all three), and the
   module's factory checks each against the manifest. The worker is told no wasm or ICC folder. pdf.js
   has no hook for its ICC profiles and their colour engine, and with the worker not fetching it does
   not load them, so page images are drawn without colour profiles. The decoders' JavaScript
   fallbacks, which pdf.js imports when WebAssembly cannot run, are not imported either: an image
   that needs one is left out of the page image. `datum-pdf.js` checks its fonts the same way, through
   the font pack's `read` hook. A PDF theme's own faces belong to another package and are fetched
   unchecked, as are a document's own images and templates.
5. **The builder takes `wasm-integrity`.** `<datum-form-builder>`'s Try it validates with the sandbox
   `wasm` names; `wasm-integrity` (`wasmIntegrity`) holds it to a hash exactly as on the form (ADR
   0046), and a module that does not match is reported unavailable in Try it.

## Consequences

- A page can hold every file of `dist` a PDF needs to a hash. What it still cannot pin is said in the
  docs (`site/docs/files.md`, "Pinning the files"): the files above that are then not loaded, a PDF
  theme's faces, the builder's `load-fonts` sheet, and the builder's own chunks, which the import map
  pins as before.
- A pinned module or worker needs `blob:` in the page's policy: `script-src` for the modules,
  `worker-src` for the viewer's worker (`site/docs/security-headers.md`). Under a policy without
  `blob:` in `worker-src` the area editor says why and draws blank sheets, rather than hanging.
  `npm run integrity:browser` checks both under a strict policy in Chromium.
- The single-file builds cost bytes: with the integrity check inlined, `datum-pdf.js` is about 8 KB
  and `datum-pdf-pages.js` about 4.5 KB larger than each would be as an entry with chunks. The
  element bundles carry only the attributes and the loader's branch for them (about 0.4 KB gzipped
  on the form); the checks are their lazy chunk.
- Every check needs Web Crypto, so a page pinning these files is served from a secure context, as
  `wasm-integrity` already required.
