# ADR 0175: The MIT licence and package names under Argusvane

## Status

Accepted.

## Context

The project is offered as open source, so the licence has to exist and the wording everywhere has
to match it. One licence covers the whole repository rather than an open-core split. The
positioning (your forms, your keys, run it air-gapped, read the code) rules out gating features
behind a key, and nothing in the code is gated. The site has no priced tiers; commercial support,
when someone wants it, is arranged with Argusvane directly (`SUPPORT.md`) and is separate from the
licence: no feature and no right depends on it.

## Decision

**Names.** Datum is the product. Argusvane is the name that owns it on every registry. A published name
carries both, so a search for either finds the package and no registry is asked for the bare,
generic word "datum".

| Registry | Rule | Example |
| --- | --- | --- |
| npm | scope `@argusvane`, package `datum` or `datum-<part>` | `@argusvane/datum`, `@argusvane/datum-engine` |
| PyPI | distribution `argusvane-datum-<part>` | `argusvane-datum-fastapi` |
| Maven Central | group `com.argusvane`, artifact `datum-<part>` | `com.argusvane:datum-core` |
| GitHub | owner `argusvane`, repository `datum` | `github.com/argusvane/datum` |

1. **`@argusvane/datum` is the package a page installs.** It builds `<datum-form>` and
   `<datum-form-builder>` and the folder of bundles a host serves, and it lives in
   `packages/datum`. Every other npm package is a part with its own job (`datum-engine`,
   `datum-pdf-kernel`, `datum-submissions`, `datum-quickjs-wasm-host`, `datum-form-test`,
   `datum-conformance-suite`, `datum-icons-fontawesome`, `datum-binding-<id>`), so the short name
   goes to the one an application reaches for first.
2. **What code imports keeps the product's name alone.** A Python import is `datum_core`, not
   `argusvane_datum_core`; a Java package is `com.argusvane.datum.core`, where the group already
   says Argusvane. The owner name is for finding and installing a package, not for every line
   that uses it. The build hooks and release scripts that find a Python distribution's import
   package strip the `argusvane-` prefix from the distribution name.
3. **A Python distribution's folder has the distribution's name**
   (`integrations/fastapi/packages/argusvane-datum-core`). The release and test scripts read the
   members from the folder names and pass them to `uv --package`, so the two cannot differ.
4. **Names a page or a server sees at run time do not change.** Element names (`datum-form`),
   bundle files (`datum-form.js`), CSS classes, the command-line tools (`datum-host-check`,
   `datum-form-test`, `datum-binding-check`), the sandbox frame markers (`@@datum:`) and the Maven
   artifact ids are Datum's, and a host that has wired them is not asked to rewire for an owner
   name.

**The licence.**

5. **MIT**, copyright held by Argusvane, in `LICENSE` at the root (`Copyright (c) 2026 Argusvane`).
   Everything the repository holds that Datum wrote is under it: engine, builder, renderer,
   bindings, sandbox host, PDF kernel, submissions service, signing agent, site, scripts and docs.
6. **Every manifest says so.** `"license": "MIT"` in the root `package.json`, `engine`, `site`, every
   `packages/*/package.json` and every binding. The Python distributions and the signing agent use
   the PEP 639 form, `license = "MIT"` with `license-files` naming the licence file, and no licence
   classifier. The Maven poms declare the MIT License, and the jars carry `META-INF/LICENSE` and
   `META-INF/NOTICE`. Every published npm package gets `LICENSE` and `NOTICE` when it is packed.
   The `private` field says what is published: `false` in `packages/datum`,
   `packages/conformance-suite` and `packages/form-test`, which the npm release workflow publishes
   together with the four command forwarders under `packages/cli-forwarders` that carry the bare
   command names. `true` in `packages/pdf-kernel`, `packages/quickjs-wasm-host`,
   `packages/submissions` and `engine`, whose code the published bundles carry, and in the root,
   `site`, the bindings and `plugins/icons-fontawesome`, which are not published.
7. **Third-party assets keep their own licences**, listed in `THIRD_PARTY_NOTICES.md`: the fonts and
   design-system files vendored in the repository (the builder's Geist under OFL, what a reference
   binding vendors under its own licence) with their licence texts beside the files, what a
   reference binding cuts from its pinned release (the GC Design System tokens), and what the
   bundle build copies from npm (DejaVu, pdf.js with the data licences it carries). Font Awesome is
   not in the bundles; its icon set is the separate plugin, with its own notice. A package that
   vendors a new asset adds a row and the text.
8. **Contributions come in under the same licence, with a sign-off.** There is no contributor
   licence agreement. Every commit of a pull request carries a `Signed-off-by` line that names its
   author, which certifies the Developer Certificate of Origin: the contributor wrote the change,
   or has the right to submit it, under MIT. The `dco` workflow checks it and `CONTRIBUTING.md`
   explains it.
9. **The site says "open source".** It names no paid tier.

## Consequences

- The Maven group is a domain the owner holds (`argusvane.com`), which Maven Central verifies with
  a DNS record; it does not depend on a GitHub account name.
- A name that reads like a member of the family is one: `argusvane-datum-<anything>==` in a
  `pyproject.toml` is treated as a sibling pin by the release check.
- The longer Python names appear in error messages and hints, which name the distribution to
  install.
- Anyone can use, change and ship the code, including inside a product of their own.
- The lockfiles' root entries record the licence field; they are refreshed with
  `npm install --package-lock-only` in each project.
- The inbound terms are the outbound terms plus the sign-off. A contributor keeps the copyright in
  what they wrote and grants it under MIT by submitting it.
