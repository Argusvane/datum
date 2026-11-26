# ADR 0167: Air-Gapped Deployments Are Checked, Packed and Bundled

## Status

Accepted.

## Context

Datum is a set of files its host serves, and its own code fetches nothing from a
third party. Two things outside its code still reach for the Internet.

- **A design system's stylesheet** can name another host: the GC Design System's `@import`s Google
  Fonts and takes an icon font from its CDN, Alberta's loads typefaces from Adobe Fonts, and Nova
  Scotia's names images on the province's site. The renderer fetches every imported sheet to
  rewrite it for the form's shadow root (ADR 0164), and a sheet that cannot be fetched leaves an
  error in the form's place, so on an isolated network such a form is not drawn.
- **Installation:** the server hosts resolve from PyPI and Maven Central, and their builds
  download the QuickJS runtime.

The binding kit already runs without the network (ADR 0164). A binding's `binding-check.json`
lists `routes`, which name the pinned package that holds a file another host would serve, and
`network`, the hosts for which no package exists.

## Decision

Three commands under `scripts/offline/`, none of which uploads anything.

### A pack is the published copy of a design system with its outside references closed

`offline:packs` (`lib/packs.mjs`) writes, per binding, the binding's bundle and the design
system's files. The files are the ones the binding pages publish, copied by the same code
(`site/scripts/binding-files.mjs` over `binding-assets-spec.mjs`), so a pack has the same
redactions: no typeface a licence keeps for the authority's own services, no government marks.

Every stylesheet in the copy is then read for references to another host (`lib/css.mjs`). A
reference a `routes` entry answers is answered from the pack, with the package's files and licences
copied in; a reference no route answers is taken out, and the manifest says which and why. The rules
for each kind of reference are in [docs/air-gapped.md](../air-gapped.md) ("Design-system bindings").

The routing data is the binding's own and is already held true by the kit, which fails a
binding whose page reaches a host that no route or `network` entry covers. Reusing it means a
binding that passes its kit offline packs with no second list to maintain. Taking an
unanswerable reference out, instead of leaving it to fail, is what keeps the form drawn: a
missing typeface falls back along the stylesheet's font list, while a failed `@import` stops
the whole binding.

Scripts are not rewritten. What a script asks for when it runs cannot be read from its text
with any confidence, so it is found by running it.

### The check runs the real files in a browser that can reach nothing else

`offline:check` (`check.mjs`) serves the built bundles and the packs from one local server and
draws the form, the form with the PDF module and the sandbox, the builder and the form under each
pack in Chromium, registered as a host page registers it. A route on the browser context
(`lib/watch.mjs`) aborts every request to another host before it is sent, and records it. A page
fails when it asked another host for anything, when a local file it asked for was not served, or when
it did not come up.

Refusing the request in the browser, instead of running on a machine without a network, makes
the result the same everywhere, so the check runs in CI and on a developer's machine. `--url`
points the same watch at pages of a running deployment, and `--csp` serves the check's pages
under a policy so a deployment can try one first.

### The bundle is one build, held to recorded digests

`offline:bundle` (`bundle.mjs`, `lib/bundle.mjs`) assembles a release (the browser files, the packs,
the sandbox runtime, the FastAPI and JVM releases and the conformance suite) into
`dist/offline/datum-offline-<version>/` and a `.tar.gz`, with a manifest and `SHA256SUMS` over every
file. The folders and their use are in [docs/air-gapped.md](../air-gapped.md) ("The bundle").

The server sections are taken from the folders the hosts' own release scripts write, so the
bundle carries exactly what a published release would. Each file is compared with the digest
its release recorded. The sandbox and PDF ABI are read from the built programs, and a host
release that carries another is refused: the page and the server each hold a copy of the
programs, and two builds in one bundle would install and then disagree.

The staged bundle is drawn by the check before it replaces the previous one, so a bundle
whose pages reach out is never written. The archive is written by the script itself with one
modification time and a fixed entry order, because the flags that give that differ between the
system `tar` of macOS and of Linux.

Third-party dependencies are listed, not carried: the Python requirements with hashes from the
lock, and the JVM poms. A complete closure is specific to a platform and an interpreter, and
an organisation with an isolated network already moves vetted third-party software through its
own mirror.

## Consequences

- A reference binding whose design system changes what it fetches is caught twice: by the kit
  when it runs offline, and by the check when the pack is drawn.
- A binding gains offline support by describing its design system's remote files in `routes`,
  the same edit that makes its kit run deterministic.
- A design system that publishes a file only on its own servers cannot be fully packed. Its
  pack says which references were taken out.
