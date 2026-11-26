# Air-gapped deployments

How to run Datum on a network with no route to the Internet: what already needs nothing from
outside, what does, and the three commands that close the difference.

Datum's own code fetches nothing from a third party. The form, the builder, the validation
sandbox and the PDF kernel load only the files beside them, and the server hosts make no
outbound call unless a setting names one. Two things still reach out unless you deal with them:
some design systems' own stylesheets, and the package registries an install resolves from.

| Command | What it does |
| --- | --- |
| `npm run offline:packs` | Writes each design-system binding with the design system's files, every reference to another host answered from the pack or taken out |
| `npm run offline:check` | Draws the form, the builder and every pack in a browser that can reach nothing else, and fails on any request that tries to leave |
| `npm run offline:bundle -- --version <x.y.z>` | Assembles everything Datum publishes for a release into one folder and one archive to carry across the gap |

All three run from a checkout of Datum on a connected machine. None of them uploads anything.

## The bundle

The bundle is built from the repository:

```
npm run offline:bundle -- --version 0.1.0 --build
```

`--build` first runs the two server hosts' release scripts as dry runs, which build and check
their packages and upload nothing. The JVM run takes about twenty minutes. Without `--build` the
bundle takes the release folders those scripts wrote earlier, and refuses them when they are
not the same build as the browser files (see "One build" below). `--skip python,maven` leaves a
host out.

The result is `dist/offline/datum-offline-<version>/` and the same folder as
`datum-offline-<version>.tar.gz` with a `.sha256` beside it:

| Folder | Contents | Used for |
| --- | --- | --- |
| `browser/` | `datum-form.js`, `datum-builder.js`, the PDF module with its fonts, the sandbox module, the plugins | Served to the page from your own origin |
| `bindings/` | One pack per design-system binding, and `manifest.json` | Served to the page; see "Design-system bindings" |
| `runtime/` | `qjs-wasi.wasm` (quickjs-ng) and the pin it is held to | Building a server host from source without a download |
| `python/` | Datum for FastAPI: a wheel and a source distribution of each package, and `requirements-third-party.txt` | `pip install --no-index --find-links` |
| `maven/` | Datum for the JVM, as a Maven repository | A `file://` repository, or an upload to your repository manager |
| `tools/` | The conformance suite as an npm tarball | `datum-host-check` against your server |

`README.md` in the bundle repeats the install lines. `manifest.json` lists every file with its
size and SHA-256, and `SHA256SUMS` is the same list in the form `shasum -a 256 -c SHA256SUMS`
reads. On the far side of the gap, check the archive against its `.sha256`, unpack it, and run
that command in the folder.

### One build

The browser files and the server packages of a bundle must come from one build. Each side
carries its own copy of the validation program and the PDF program, and Datum's promise that
the page and the server reach the same answer holds only when the copies are the same. A
bundle that mixed two builds would install cleanly and then disagree with itself. The bundle
script reads the sandbox and PDF ABI from the built programs and refuses a FastAPI or JVM
release that carries another. It also holds each wheel and jar to the digest its release
recorded, and `qjs-wasi.wasm` to the digest both hosts pin.

### What is not in it

Third-party dependencies are not in the bundle. Bring them through the mirror or repository
manager your organisation already uses for vetted software:

- **Python.** `python/requirements-third-party.txt` lists every package
  `argusvane-datum-fastapi[all]` installs, pinned with hashes, exported from the release's lock file.
  On a connected machine, `pip download -r requirements-third-party.txt` for the interpreter
  and platform you deploy on. `wasmtime` and a few others ship one wheel per platform.
- **JVM.** The poms under `maven/` name their dependencies (Spring Boot and the rest), which
  resolve through your repository manager.

## Serving the browser files

Serve `browser/` from the page's own origin and keep its files beside each other. The form
finds its lazy chunks, the PDF fonts under `fonts/`, the PDF program and the sandbox module by
relative address, so nothing needs configuring and nothing is fetched from elsewhere.

With Datum's own look, and with every pack, a page runs under a policy that names no other
origin:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  connect-src 'self';
  font-src 'self';
  img-src 'self' data:
```

`'wasm-unsafe-eval'` is needed only where the page runs the validation sandbox
(`wasm="auto"`). Under this policy, measured in Chromium, the form, the form with its PDF
module and sandbox, the builder and the form under each of the nine packs all come up. The
policy refuses an inline style in four of them: the builder, and the GC Design System, Alberta
and Ontario packs, whose own components add one. The pages come up regardless. Try a policy
before you set it:

```
npm run offline:check -- --csp "default-src 'self'; script-src 'self'; style-src 'self'"
```

## Design-system bindings

A form drawn with a design-system binding loads that design system's stylesheet, and some of
those stylesheets reach for another host as they load. The GC Design System's begins with an
`@import` of Google Fonts and takes its icon font from the design system's CDN. A form whose
imported stylesheet cannot be fetched is not drawn at all, so on an isolated network the
unmodified file leaves an error where the form should be.

A pack fixes that. `npm run offline:packs` writes, for each binding, its bundle and the design
system's files, then reads every stylesheet for references to another host:

- A reference that a pinned package can answer is answered from the pack. The font files are
  copied in, with their licences, and the stylesheet is rewritten to point at them. The GC
  Design System pack carries Lato, Noto Sans, Noto Sans Mono and the icon font this way.
- A reference that no package can answer is taken out, so the browser asks for nothing, and
  the pack's manifest lists it under `dropped` with the reason. The text falls back along the
  stylesheet's own font list.

How each kind of reference is rewritten:

- An address on the same host (relative or root-absolute), a `data:` URL and a fragment are left as
  they are.
- An `@import` that the stylesheets of a pinned package answer becomes an `@import` of a sheet written
  beside the importing one, made of those stylesheets with their `url()`s pointing at the package's
  font files. An `@import` that nothing answers is removed.
- A `url()` that a pinned package's files answer is rewritten to the copy in the pack.
- A `url()` in an `@font-face` that nothing answers loses that one source; a `src` left with no
  source is removed, and an `@font-face` left with no `src` is removed. Any other `url()` that
  nothing answers becomes `none`.

A pack's manifest entry lists its stylesheets and scripts each with a `sha384` `integrity`, the
references answered locally (`localized`) and the ones taken out (`dropped`, each with its reason).
The files are copied by the same code the design-system binding pages of the site use, so a pack
carries the same redactions as the published copy.

| Pack | Answered from the pack | Taken out |
| --- | --- | --- |
| `gcds` | Google Fonts import, icon font | nothing |
| `govuk`, `uswds`, `bootstrap`, `quebec`, `ontario` | nothing to answer: the files name no other host | nothing |
| `alberta` | nothing | Acumin (Adobe Fonts serves it only from its own servers) and Roboto Mono (Google Fonts) |
| `nova-scotia` | nothing | Roboto, older font formats and two images, all on the province's own site; Open Sans is in the pack |
| `fluent` | nothing to answer: no font, no CDN, no other host | nothing |

The GOV.UK pack, like every copy Datum publishes, leaves out GDS Transport, which is licensed
for GOV.UK services only, and the form falls back to Arial. Government signatures and logos
are left out of every pack for the same reason they are left out of Datum's own site.

Register a binding from the pack's `manifest.json`, which gives each stylesheet and script
with its `integrity`:

```html
<script type="module">
  import { bindings } from "/datum/browser/datum-form.js";
  import { createBinding } from "/datum/bindings/gcds/gcds.js";

  const pack = (await (await fetch("/datum/bindings/manifest.json")).json()).gcds;
  const at = (file) => ({ ...file, url: new URL(file.url, location.origin + "/datum/bindings/").pathname });
  bindings.register(bindings.fromFactory(createBinding), {
    assets: { stylesheets: pack.stylesheets.map(at), scripts: pack.scripts.map(at) }
  });
  document.querySelector("datum-form").binding = "gcds";
</script>
```

A pack with a `bodyClass` (GOV.UK) needs that class on `<body>`, and a script entry with
`attributes` needs any `./` address in them resolved the same way.

What decides whether a reference can be answered is the binding's own `binding-check.json`.
Its `routes` name the pinned package that holds a file another host would serve, and its
`network` entries name the hosts for which no package exists, each with the reason. The
binding kit already uses both to test a binding without the network, so a binding that passes
its kit offline packs without further work.

## The server hosts

Neither host makes an outbound call in its default configuration. The settings that can:

| Setting | Default | On an isolated network |
| --- | --- | --- |
| `datum.pdf.signing.tsa.url` (both hosts) | none | Leave it unset to use the in-process timestamp authority, or name a timestamp server inside the network |
| Revocation checking, FastAPI | off | The checker never fetches: it judges a chain from the CRLs and OCSP responses you hand it |
| Revocation checking, Spring Boot | off | The JDK's checker fetches CRLs and OCSP replies when it is switched on. Keep it off, or give the trust policy `certStores` holding the CRLs |
| Data sources of a form | none | A form's option lists come from the URLs its page assigns, so those must be inside the network |

Passkey verification asks nothing of the network: attestation is `none`, so no metadata
service is consulted.

Install from the bundle:

```
pip install --no-index --find-links python/ --find-links /path/to/your/wheels "argusvane-datum-fastapi[all]==0.1.0"
```

```xml
<repository>
  <id>datum-offline</id>
  <url>file:///path/to/datum-offline-0.1.0/maven</url>
</repository>
```

To build a host from source behind the gap, hand the build the runtime from the bundle. Both
builds still hold the file to the pinned digest.

```
npm run fastapi:assets -- --qjs-wasm-file runtime/qjs-wasi.wasm
./mvnw -Dqjs.wasm.file=/path/to/runtime/qjs-wasi.wasm -Ddownload.plugin.skip=true verify
```

## Checking a deployment

`npm run offline:check` draws eleven pages from the built files: the form, the form with its
PDF module and sandbox (a PDF is rendered, so the kernel, its program and its fonts are
fetched), the builder, and the form under each pack, registered the way a host page registers
it, with the `integrity` values the pack's manifest gives. The browser refuses every request to
a host other than the one serving the files, before it is sent, and the check fails on any such
request, on any local file the page asked for and did not get, and on a page that does not
come up: a form that never fires `datum-ready`, one that fires `datum-error` or
`datum-binding-error`, a builder with no drawn shadow tree, or a page that drew fewer controls
than it should. It gives the same answer on an open network as behind a gap. The bundle script runs
it over the staged bundle and writes nothing if it fails. CI's `offline` job builds the bundles, the plugins and every reference binding, assembles a bundle without the server sections and runs this check over it.

Point it at your own deployment to check the pages you built:

```
npm run offline:check -- --url https://forms.internal.example/intake --allow-host api.internal.example
```

Each `--url` page is loaded and left to settle, and every host it asked for other than its own
and those you allow is reported.

## Limits

- The packs cover the nine reference bindings under `bindings/`. A binding of your own is
  packed by the same code once it has an entry in `site/scripts/binding-assets-spec.mjs`
  saying which of its design system's files may be published.
- Scripts are not rewritten. A design system's script that fetches something when it runs is
  found by the check, not by the pack. None of the nine does.
- The check draws one form. It does not open every panel of the builder or walk a journey.
- Dependencies of the hosts are listed, not carried.
