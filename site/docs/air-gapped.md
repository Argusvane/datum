# Air-gapped deployments

Datum runs on a network with no route to the Internet. Its own code fetches nothing from a third party: the form, the builder, the validation sandbox and the PDF kernel load only the files beside them, and the server hosts make no outbound call unless a setting names one.

Two things outside Datum's code still reach out unless you deal with them: some design systems' own stylesheets, and the package registries an install resolves from. Three commands, run from a checkout of Datum on a connected machine, close the difference.

| Command | What it does |
|---|---|
| `npm run offline:packs` | Writes each design-system binding with the design system's files, every reference to another host answered from the pack or taken out |
| `npm run offline:check` | Draws the form, the builder and every pack in a browser that can reach nothing else, and fails on any request that tries to leave |
| `npm run offline:bundle -- --version <x.y.z>` | Assembles a release into one folder and one archive to carry across the gap |

None of them uploads anything.

## The bundle

```
npm run offline:bundle -- --version 0.1.0 --build
```

- `--build` runs the two server hosts' release scripts as dry runs first; the JVM run takes about twenty minutes.
- `--skip python,maven` leaves a host out.
- The result is `dist/offline/datum-offline-<version>/` and the same folder as a `.tar.gz` with a `.sha256` beside it.

| Folder | Contents |
|---|---|
| `browser/` | `datum-form.js`, `datum-builder.js`, the PDF module with its fonts, the sandbox module, the plugins |
| `bindings/` | One pack per design-system binding, and `manifest.json` |
| `runtime/` | `qjs-wasi.wasm`, for building a server host from source without a download |
| `python/` | Datum for FastAPI as wheels and source distributions, and the third-party requirements with hashes |
| `maven/` | Datum for the JVM as a Maven repository |
| `tools/` | The conformance suite as an npm tarball |

On the far side:

1. Check the archive against its `.sha256`.
2. Unpack it.
3. Run `shasum -a 256 -c SHA256SUMS` in the folder.

The bundle's own `README.md` has the install lines. To draw the carried files in a browser that can reach nothing else, run `npm run offline:check -- --bundle <folder>` from a checkout, or from any machine that has the repository's scripts; see [Checking your deployment](#checking-your-deployment).

The browser files and the server packages in a bundle are one build. The script refuses a server release whose sandbox or PDF ABI is not the browser files' own.

Third-party dependencies are listed, not carried. Bring them through the mirror or repository manager you already use:

- `python/requirements-third-party.txt` pins every package the FastAPI host installs.
- The poms under `maven/` name theirs.

## Serving the files

Serve `browser/` from the page's own origin and keep its files beside each other. With Datum's own look, and with every pack, a page runs under a policy that names no other origin:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  connect-src 'self';
  font-src 'self';
  img-src 'self' data:
```

- `'wasm-unsafe-eval'` is needed only where the page runs the validation sandbox.
- Under this policy, measured in Chromium, every page of the check comes up.
- The policy refuses an inline style in the builder and in the GC Design System, Alberta and Ontario packs, whose components add one.

[Security headers](/security-headers) explains each directive.

## Design-system bindings

Some design systems' stylesheets reach for another host as they load. The GC Design System's begins with an `@import` of Google Fonts and takes its icon font from the design system's CDN. A form whose imported stylesheet cannot be fetched is not drawn, so on an isolated network the unmodified file leaves an error where the form should be.

A pack carries the binding's bundle and the design system's files with those references closed.

- A reference a pinned package can answer is answered from the pack: the fonts are copied in and the stylesheet points at them.
- A reference no package can answer is taken out, the text falls back along the stylesheet's font list, and the pack's manifest lists it under `dropped`.

| Pack | Answered from the pack | Taken out |
|---|---|---|
| `gcds` | Google Fonts import, icon font | nothing |
| `govuk`, `uswds`, `bootstrap`, `quebec`, `ontario` | nothing to answer | nothing |
| `alberta` | nothing | Acumin, which Adobe Fonts serves only from its own servers, and Roboto Mono |
| `nova-scotia` | nothing | Roboto, older font formats and two images on the province's site; Open Sans is in the pack |
| `fluent` | nothing to answer: no font, no CDN | nothing |

Register a binding from the pack's `manifest.json`, which gives each stylesheet and script with its `integrity`:

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

## The server hosts

Neither host makes an outbound call in its default configuration.

| Setting | On an isolated network |
|---|---|
| `datum.pdf.signing.tsa.url` | Leave it unset to use the in-process timestamp authority, which exists on Spring Boot only when the timestamp starter is on the class path and `datum.tsa.enabled` is true, or name a timestamp server inside the network. See [Timestamp server](/timestamps) |
| Revocation checking, FastAPI | The checker never fetches: it judges a chain from the CRLs and OCSP responses you hand it |
| Revocation checking, Spring Boot | Off by default. The JDK's checker fetches when switched on, so keep it off or give the trust policy `certStores` holding the CRLs |
| A form's data sources | Their URLs are the page's, so they must be inside the network |

Passkey verification asks nothing of the network.

## Checking your deployment

```
npm run offline:check -- --url https://forms.internal.example/intake --allow-host api.internal.example
```

Each page is loaded in a browser that refuses every request to a host other than the page's own and those you allow, and every refused host is reported. The check gives the same answer on an open network as behind a gap, so you can run it before the deployment moves.

### Flags

`npm run offline:packs`

| Flag | Meaning |
|---|---|
| `--binding <id>` | A binding to pack. Repeatable. Default: every reference binding. |
| `--out <dir>` | Where the packs go. Each pack's own folder and `manifest.json` are replaced and nothing else in the folder is touched. Default `dist/offline/bindings`. |
| `--fail-on-dropped` | Exit 1 when a reference to another host could not be answered from the pack. |

`npm run offline:bundle`

| Flag | Meaning |
|---|---|
| `--version <x.y.z>` | The release the bundle is of. The FastAPI and JVM release folders must be this version. Required. |
| `--build` | First run the hosts' release scripts as dry runs. |
| `--skip <a,b>` | Leave sections out: `browser`, `bindings`, `runtime`, `python`, `maven`, `tools`. |
| `--binding <id>` | Pack only this binding. Repeatable. |
| `--out <dir>` | Where the folder and the archive go. Default `dist/offline`. |
| `--qjs-wasm-file <path>` | Take `qjs-wasi.wasm` from this file. It is held to its pinned hash either way. |
| `--source-maps` | Keep the bundles' source maps (about 75 MB). The folder must have been built with them: `DATUM_SOURCE_MAPS=1 npm run datum:build`. |
| `--allow-stale` | Let a `packages/datum/dist` older than its sources through. |
| `--skip-check` | Do not draw the bundle in a browser before writing it. The check needs Playwright's Chromium. |
| `--no-archive` | Write the folder only. |

`npm run offline:check`

| Flag | Meaning |
|---|---|
| `--bundle <dir>` | Check an offline bundle: its `browser/` and `bindings/` folders. |
| `--browser-dir <dir>` | The built bundles to check. Default `packages/datum/dist`. |
| `--packs <dir>` | The binding packs. Default `dist/offline/bindings`. |
| `--binding <id>` | Only this binding's pack. Repeatable. Default every pack in the manifest. |
| `--url <url>` | Check a page of a running deployment instead of the files. Repeatable. |
| `--allow-host <host>` | With `--url`: another host the page may reach, such as your own API. Repeatable. |
| `--csp <policy>` | Serve the check's pages under this Content-Security-Policy, and list what it refuses. |
| `--report <file>` | Write the result as JSON. |
| `--timeout <ms>` | How long a page may take to come up. Default 30000. |

The check exits 0 when every page came up and none asked another host for anything, and 1 otherwise. `offline:packs` and `offline:bundle` exit 1 on any failure.
