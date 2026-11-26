# Contributing to Datum

Datum is an MIT-licensed form platform: a TypeScript engine, web components, a PDF kernel, and server hosts for
Spring Boot and FastAPI. Issues and pull requests are welcome. Read this page first so your change lands quickly.

Questions go to GitHub Discussions, bugs to Issues, and vulnerabilities to the private route in
[SECURITY.md](SECURITY.md). [SUPPORT.md](SUPPORT.md) has the detail.

## Layout

| Path | What it is |
|---|---|
| `engine/` | the form engine (definitions, rules, validation, builder logic) |
| `site/` | the marketing site and the documentation site (`site/docs`) |
| `packages/*` | web components, the PDF kernel, the WebAssembly sandbox host, submissions, form tests, the conformance suite |
| `plugins/*` | optional plugin packages, such as the Font Awesome icon set |
| `bindings/*` | design-system bindings, one standalone package per design system; the core packages know none of them |
| `integrations/jvm` | Spring Boot host: framework-free libraries, Spring bindings, a host test kit, examples (Maven) |
| `integrations/fastapi` | FastAPI host: a uv workspace of Python distributions |
| `integrations/shared` | what the hosts share, such as the endpoint catalog |
| `tools/` | developer tools, such as the PIV signing agent |
| `docs/` | architecture decision records, generated references and the deep host references. See [docs/README.md](docs/README.md) |

There is no root build. Each package has its own `package.json` and lockfile, and the root `package.json` only
forwards to them (`npm run engine:test`, `npm run site:build`, and so on).

## Where the documentation lives

`site/docs` is the canonical user documentation: the pages a person reads to use Datum, published at
https://datum.argusvane.com/docs/. Change a user-facing behaviour there. `docs/` holds what the site does not: the
architecture decision records (`docs/adr`), the generated references (`docs/reference`, `docs/generated`) and the
deep host references for Spring Boot and FastAPI. Where a page in `docs/` and a page in `site/docs` disagree, the
site is right and the other one is the bug.

The release status (what is published and what is not) is written once, in
[Release status](https://datum.argusvane.com/docs/introduction#release-status). Link to it; do not copy it. How a release is cut, across Maven Central, npm and PyPI, is in
[docs/releasing.md](docs/releasing.md).

## Prerequisites

- Node 22 (`.nvmrc`) and npm. CI also runs the packages on Node 24 and 26.
- Java 17 or newer for `integrations/jvm`. Use the Maven wrapper at `integrations/jvm/mvnw`; do not install Maven.
- Python 3.12 or newer with [uv](https://docs.astral.sh/uv/) for `integrations/fastapi`. The PIV agent in
  `tools/piv-agent` runs on Python 3.11 to 3.14 and needs the PC/SC headers (`libpcsclite-dev`, `swig`).
- Playwright's browsers for the browser checks: `npx playwright install chromium` from `packages/conformance-suite`
  (Firefox and WebKit for the cross-browser binding checks).
- Optional: [veraPDF](https://verapdf.org/) for the PDF/A tests (set `VERAPDF` to its launcher; without it those tests
  skip), and [gitleaks](https://github.com/gitleaks/gitleaks) for the secret scan.
- CI runs on Linux. Develop and test on Linux.

## Installing

Install dependencies per package with `npm ci`, or run `npm run setup` at the root. A package that imports another reaches it through a `file:` link
that ships TypeScript source, so installing each package's own dependencies is all the build the bundler needs.
Install in dependency order. On a fresh clone `npm run setup` at the root does it for every unit, and
`npm run site:setup` for what the site needs; the table is what it does and what to run for one unit.

| To work on | Install, in this order |
|---|---|
| `engine` | `engine` |
| `packages/quickjs-wasm-host`, `packages/form-test` | `engine`, then the package |
| `packages/pdf-kernel` | `engine`, `packages/quickjs-wasm-host`, then the package |
| `packages/submissions` | `engine`, `packages/quickjs-wasm-host`, `packages/pdf-kernel`, then the package |
| `packages/conformance-suite` | `engine`, `packages/quickjs-wasm-host`, `packages/pdf-kernel`, `packages/submissions`, then the package |
| `packages/datum` | `engine`, `packages/quickjs-wasm-host`, `packages/pdf-kernel` (then `npm run build:program` there), then the package |
| `plugins/<id>` | the `packages/datum` chain, then `plugins/<id>` |
| `bindings/<id>` | `engine`, `packages/conformance-suite`, `packages/datum`, then `bindings/<id>` and `npm run build` in it |
| `site` | the `packages/datum` chain and `npm run build` there, every plugin and every binding built, then `site` |

The bindings install order matters because a binding is checked by the binding kit in `packages/datum`, which drives
Playwright from the conformance suite. A binding is standalone: nothing else installs it, and the core packages do not
depend on it.

## Running what CI runs

`.github/workflows/ci.yml` has one job per unit, and a push or pull request starts only the jobs for the paths it
touches. A change should pass the jobs for the units it touches. Every command below runs from the repository root
unless a directory is named, and assumes the installs above are done.

| CI job | What it checks | Run it locally |
|---|---|---|
| `secret-scan` | no credential in the tree | `gitleaks dir . --config .gitleaks.toml --redact` |
| `process-references` | tracked text names no records of how the code came to be | `cd packages/datum && npx vitest run --root . tests/process-references.test.ts` |
| `engine` | architecture lint, feature matrix, agent-tools reference, typecheck, tests, integration suites, release gates | `cd engine && npm run ci && npm run test:integration && npm run gates` |
| `feature-coverage` | the feature scenarios on both hosts, in a browser | `cd engine && node feature-coverage/selfcheck.mjs && npm run test:features` |
| `plugin-<id>` | one plugin: typecheck, tests, bundle | `cd plugins/<id> && npm run typecheck && npm test && npm run build` |
| `quickjs-wasm-host` | typecheck and tests | `cd packages/quickjs-wasm-host && npm run typecheck && npm test` |
| `pdf-kernel` | typecheck and tests, with veraPDF when installed | `cd packages/pdf-kernel && npm run typecheck && npm test` |
| `submissions` | typecheck and tests | `cd packages/submissions && npm run typecheck && npm test` |
| `conformance-suite` | typecheck, tests, build, and the release gate on the program built from source | `cd packages/conformance-suite && npm run typecheck && npm test && npm run build && npm run check:source -- --all --gate release --format json,md --out report` |
| `conformance-suite-artifacts` | the release gate on the built sandbox program | `npm run datum:build`, then `node packages/conformance-suite/dist/cli.mjs --program packages/datum/dist/datum-sandbox-program.js --all --gate release --out report` |
| `form-test` | typecheck, tests, build and the fixture forms | `cd packages/form-test && npm run typecheck && npm test && npm run build && node dist/cli.mjs fixtures/main.json fixtures/clock.json --report junit --report json --out out` |
| `datum` | typecheck, tests, the bundles, the generated attribute reference | `cd packages/datum && npm run typecheck && npm test && npm run build && npm run attributes:check` |
| `datum-a11y-browser` | the browser accessibility baseline | `cd packages/datum && npm run a11y:browser -- --check` (bundles built) |
| `datum-visual-browser` | the visual baseline | `cd packages/datum && npm run visual -- --check` (bundles built) |
| `bindings` | the binding kit, once per binding and for the Datum look; the GCDS unit tests | `cd bindings/<id> && npm run kit:check`, and `cd packages/datum && npm run kit:check:datum`; for GCDS also `../../engine/node_modules/.bin/vitest run --root . tests/panel.test.ts tests/plugin-urls.test.ts` in `bindings/gcds` |
| `bindings-browsers` | the binding kit in Firefox and WebKit, for the Datum look and GCDS | `npm run kit:check -- --browser firefox` (or `webkit`) in the same directories |
| `host-scripts` | the host build scripts' own tests, on Node 22, 24 and 26 | `npm run fastapi:test:scripts && npm run jvm:test:scripts && npm run offline:test` |
| `offline` | the offline bundle, drawn in a browser that can reach nothing else | `npm run offline:bundle -- --version 0.1.0 --skip runtime,python,maven,tools --no-archive` (the web components, plugins and bindings built first) |
| `piv-agent` | the signing agent's tests, on Python 3.11 to 3.14 | `cd tools/piv-agent && pip install -r requirements.txt && python -m unittest -v` |
| `jvm-runtime`, `jvm` (manual: `jvm.yml`) | the Maven reactor on Java 17, 21 and 25, then the conformance suite and the host-check kit against the examples; started by hand (`gh workflow run jvm.yml --ref <branch>`), not on every push | `npm run jvm:test`; the host-check steps are in `jvm.yml` |
| `fastapi` | the lockfile, the members' tests and the host-check kit against the examples | `npm run fastapi:prepare` on a fresh clone (installs, builds the assets, syncs the workspace), then `npm run fastapi:test`; the host-check steps are in `ci.yml` |
| `site` | the marketing site and docs build, and the site's tests | `cd site && npm run demo-assets && npm run build && npm test` |
| `dco` (pull requests) | every commit is signed off | `git log --format='%an <%ae>%n%B' main..HEAD \| grep Signed-off-by` |

The root `npm run ci` runs `npm run setup` first, then chains most of the JavaScript jobs. It is slow; run the packages you touched. To check one
page of the docs while you write it, `cd site && npm run docs:dev` (or `npm run site:docs-dev` from the root). The live
examples in the docs are checked in headless Chrome against the site's dev server, which serves the docs and the bundles
the examples load. Build the bundles (`npm run datum:build`), then in `site` run `npm run demo-assets`; start the server
with `npm run site:dev` (http://localhost:5173/docs/) and, in another terminal, name the pages or pass `--all`:
`cd site && npm run docs:examples -- --all`, or `npm run docs:examples -- form-on-your-page bootstrap`. The Chrome it
launches is the one at the macOS default path; set `CHROME=/path/to/chrome` elsewhere. `--base <url>` points the check at
a different server.

There is no root vitest config. Tests run per package, from the package directory or through the root forwarders;
running vitest from the repository root gives spurious failures.

## Generated files

Do not edit these by hand; change the source and regenerate. Each has a `--check` form that CI or a test runs.

| File | Regenerate | Check |
|---|---|---|
| `docs/reference/attributes.md`, `attributes.json` | `cd packages/datum && npm run attributes` | `npm run attributes:check` |
| `docs/reference/agent-tools.md` (notes per tool live in `engine/scripts/agent-tools-notes/`) | `cd engine && npm run docs:agent-tools` | `npm run docs:agent-tools:check` |
| `docs/reference/feature-matrix.md` (edit `engine/traceability/feature-matrix.json`) | `cd engine && node scripts/gen-feature-matrix.mjs` | `npm run check:traceability` |
| `docs/generated/theme-accessibility.md` | `cd packages/datum && npm run a11y:report` (`npm run a11y` first, when the baselines change) | the tests in `packages/datum` |
| `site/docs/_generated/*.md` (the element reference tables) | `cd site && npm run docs:reference` | `node scripts/gen-docs-reference.mjs --check`, run by `site/test` |
| `packages/conformance-suite/golden/agent-tools.json` | `cd packages/conformance-suite && npm run golden:agent` | the catalogue test in that package |
| `integrations/fastapi/packages/argusvane-datum-qjs-wasm/.../runtime.json` and the runtime pin in the JVM pom | `npm run fastapi:pin-runtime -- <tag>`, `npm run jvm:pin-runtime -- <tag>` | the pin tests of each host (`QjsPinTest`, the FastAPI script tests) |
| `bindings/gcds/tokens.json`, `bindings/gcds/pdf/tokens.generated.ts` | `cd bindings/gcds && npm run tokens:generate` | the binding's tests |
| `bindings/fluent/theme/*` | `cd bindings/fluent && npm run theme:generate` | review the diff; `npm run kit:check` |

Never commit what a build writes: `dist/`, `build/`, `target/`, the demo assets under `site/public/demo/`, and the
hosts' bundled assets (`npm run jvm:assets`, `npm run fastapi:assets`). If a generated file shows up in your diff,
say which command produced it in the pull request.

## Decisions and ADRs

`docs/adr` records decisions, one file per decision, numbered from 0001. An ADR explains how the thing works today
and the reasoning where there was a real choice. It is not a log. A change that alters a contract (the definition
format, a sandbox or PDF ABI, a wire endpoint, a binding seam, a public attribute) updates the body of the ADR that
owns it in the same pull request: no amendment sections, no history lists, no dates, no build notes. Write a new ADR
only for a new decision. Numbers are never reused: an ADR that is merged into another is deleted, and every citation
of it in the docs, the code and the comments is repointed in the same change. Find the next number with
`ls docs/adr | tail -1` and re-check right before you write, since other branches take numbers too. Follow the
shape of a recent ADR.

Comments, docs and test titles state the logic itself, neutrally. They do not cite ADR numbers (outside Markdown
links), review or finding ids, dates or who asked. The `process-references` job enforces it.

## Commits and pull requests

- Keep pull requests small and about one thing. Split refactors from behaviour changes.
- Include tests with the change. A bug fix gets a test that fails without it.
- Explain what changed and why in the description, and which tests you ran and where.
- Update the docs, and the body of the ADR that owns the contract, when the behaviour or a contract changes.
- Do not commit secrets. The few throwaway keys in the repository are listed in [SECURITY.md](SECURITY.md).

Report a vulnerability privately as described in [SECURITY.md](SECURITY.md), not in a public issue. Conduct is
governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

### Sign your commits (DCO)

Every commit carries a `Signed-off-by` line with your name and email, the same as the commit's author. It certifies
the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or have the
right to submit it, under the project's MIT licence.

```sh
git commit -s -m "Fix the date range check"
```

`-s` adds `Signed-off-by: Your Name <you@example.org>`, using `user.name` and `user.email` from your git
configuration. The `dco` workflow checks every commit of a pull request, merges included (`git merge --signoff`), and
fails it when a line is missing or names someone other than the author. A pull request of more than 250
commits cannot be checked whole and fails. To fix a branch:

```sh
git rebase --signoff main      # adds the line to every commit of the branch
git push --force-with-lease
```

## License

By contributing, you agree that your contribution is licensed under the MIT license that covers this project, and
you certify the Developer Certificate of Origin with your sign-off.
