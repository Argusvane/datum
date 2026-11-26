# Releasing Datum

How a release is cut: one version, one tag `v<version>`, three registries and one GitHub Release. The commands use
0.1.0. Only a plain `X.Y.Z` version is released. A prerelease cannot be named alike everywhere: npm takes
`0.2.0-rc.1`, while the FastAPI release script and the PyPI workflow take only PEP 440's normalized form (`0.2.0rc1`),
so one tag cannot name both. The Maven release script refuses anything but `X.Y.Z` on a real run.

The three registries do not publish alike, and the order follows from that:

| Host | Published by | Starts when | Can be undone |
|---|---|---|---|
| Maven Central (`com.argusvane`) | `integrations/jvm/scripts/release.mjs`, run by hand on the maintainer's machine | the maintainer runs it | no: a Central version is permanent |
| npm (`@argusvane/*` and four bare command names) | `.github/workflows/release-npm.yml` | the push of the tag `v<version>` | no: a version number is never reused |
| PyPI (eight `argusvane-datum-*` distributions) | `.github/workflows/release-fastapi.yml`, TestPyPI first | the push of the same tag | no |

Maven goes first because it is the only one that is not started by the tag, and the one that needs a commit that is
already the tag's. The script refuses to deploy unless the tree is clean, `origin` is `argusvane/datum`, HEAD is on
`origin/main`, a `ci.yml` run on HEAD passed `ci-ok`, and the tag `v<version>` already exists locally and points at
HEAD, so Central never receives a build of a commit that is not the one the tag names and CI approved. The tag is pushed
only after the deployment is published, because the push starts npm and PyPI.

## The engine's release gates

Apart from the registries, the engine carries release gates that CI evaluates on every run (the `Evaluate release gates` step of `ci.yml`). `evaluateReleaseGates` (`engine/form-engine/verification/release-gates.ts`) turns a `ReleaseGateInput` into a `ReleaseGateReport` of named checks, and a release is blocked when any of them fails:

| Check | Passes when |
|---|---|
| `deterministic-vector-parity` | the same validation vectors give the same error signatures through the browser, sandbox and server adapters (`runParity`) |
| `performance:<name>` | each observed time is within its budget (`render-model-build-50-fields`, 50 ms by default) |
| `security:wasm-sandbox-isolation` | the sandbox host throws before a run when handed a policy that allows the network |
| `security:plugin-failure-isolation` | a plugin whose `initialize` throws is recorded as failed and a healthy plugin still initializes |
| `pdf-render-determinism` | one request rendered twice through the PDF provider gives one byte sequence; passed as not applicable when no PDF provider is wired |

`collectReleaseGateInputs` (`verification/gate-inputs.ts`) produces the input by running those checks. `npm run gates` in `engine/` builds, collects (`gates:collect` writes `gate-inputs.json`) and evaluates (`gates:evaluate` writes `gate-report.json`, prints one PASS or FAIL line per check and exits 1 on a failure, 2 when the input file is missing).

The engine's gates run against the in-process sandbox adapter, because a dependency from the engine on the QuickJS package would be a cycle. `GateInputOptions.wasmValidationHost` and `pdfProvider` let a host inject the real sandbox and PDF provider, and `packages/quickjs-wasm-host/tests/quickjs-release-gates.test.ts` proves every gate, parity and sandbox isolation included, passes with the real QuickJS engine.

## Once, before the first release

1. The repository is `argusvane/datum`. Both release workflows publish only there (`if: github.repository ==
   'argusvane/datum'` on every job that publishes or writes to the Release), so a fork or a mirror that receives the
   tag builds and stops. A clone made before the move still points `origin` at the old address, which the Maven
   release script refuses; point it at the new one with `git remote set-url origin https://github.com/argusvane/datum.git`.
2. Create three GitHub environments (Settings, Environments): `npm`, `testpypi` and `pypi`. Give `npm` and `pypi` a
   required reviewer (the owner), and `testpypi` one too if the first upload should wait. GitHub creates an
   environment that does not exist on its first use with no protection, so create them before anything that lets a job
   publish: a trusted publisher registered while `pypi` is unconfigured lets a pushed tag upload unapproved. Required
   reviewers need a public repository or a paid plan.
3. Store `NPM_TOKEN` (an automation token that can publish the `@argusvane` scope and the four bare names) as a secret of
   the `npm` environment. Provenance needs no token.
4. Register a pending trusted publisher on PyPI and on TestPyPI for each of the eight distributions: workflow
   `release-fastapi.yml`, environment `pypi` on PyPI and `testpypi` on TestPyPI.
5. Restrict who may create `v*` tags to the owner and require the `ci-ok` check on `main` (a repository ruleset; it needs
   the same plan as step 2). Both workflows start on every `v*` tag.
6. For Maven: the namespace `com.argusvane` is verified in the Central portal, the release GPG key is in the keyring, and
   `~/.m2/settings.xml` has a `<server>` with `<id>central</id>` holding the portal token. The script checks that the
   server id exists and never reads the key or prints the token.
7. Run `jvm.yml` by hand once on the commit to be released, for every Java version (`gh workflow run jvm.yml -f java=all`):
   the JVM host has no pull request gate, so this is where its test matrix runs.

## The order of a release

### 1. The release commit

The tree carries the release version before the tag is made; the workflows refuse a tag whose version does not match.

- npm: every published package's `version` is the release version and the four bare-name forwarders pin it.
  `node scripts/npm/release.mjs check --version 0.1.0` says what is wrong.
- PyPI: `npm run fastapi:release -- --version 0.1.0` sets every member's version and rewrites the sibling pins, builds
  the distributions locally and uploads nothing. Commit the changes it makes. It does not tag: the tag is made in step 2, on the
  merged commit, and pushed in step 3.
- Maven: nothing in the tree changes; the version is passed to the script as `--version`.
- Changelog: `node scripts/changelog-promote.mjs --version 0.1.0` turns `## [Unreleased]` into `## [0.1.0] - <date>` and
  leaves an empty `## [Unreleased]` above it. Read the section once: it is the release's notes. `release.mjs` refuses to
  run when the version's section is missing.
- If the release changes what is published, update [Release status](https://datum.argusvane.com/docs/introduction#release-status)
  in `site/docs/introduction.md`, the one place that says it.

Open a pull request with the commit. `main` takes squash-merged pull requests, so the commit that lands on `main` is a
new commit with its own SHA, and it is that commit that is released. Wait for `ci.yml` to finish with `ci-ok` green on
the merged commit. Both workflows look for a green `ci-ok` on the tagged commit and stop without it.

### 2. Maven Central, from the tagged commit

The tag goes on the merged commit, not on the branch the pull request came from: its SHA is not the merged one.

```sh
git fetch origin
git switch --detach origin/main    # the merged commit (or: git switch main && git pull --ff-only)
git status --short                 # empty
git tag v0.1.0                     # local only; do not push it yet
npm run jvm:release -- --version 0.1.0 --dry-run     # builds, signs nothing, uploads nothing
npm run jvm:release -- --version 0.1.0
```

The real run refuses unless all of these hold, and says which does not: the working tree is clean (untracked files
count; ignored files do not), the `origin` remote is `argusvane/datum` (https or ssh), HEAD is an ancestor of, or equal
to, `origin/main` (a clone without `origin/main` is refused, never held against a local `main`), a `ci.yml` run on
HEAD concluded success with its `ci-ok` job passed (read with the `gh` CLI, which must be installed and signed in with
`gh auth login`), the tag `v0.1.0` exists and points at HEAD, and `CHANGELOG.md` has a `## [0.1.0]` section. It then builds the assets,
runs the security suite over the sandbox program, builds and signs the reactor, runs the post-checks over every jar and
the staged bundle, and only then deploys. After the build it checks the tree and the tag again, so a build that moved
either does not upload.

- `--dry-run` runs the guards (the `gh` lookup included) as warnings, builds without signing and uploads nothing, so it works before the tag
  exists.
- `--check-only` runs only the post-checks over the jars already under `integrations/jvm/target/`; it skips the commit
  guards (so it needs no tag, no network and no `gh`). The version is whatever those jars were built with (`0.1.0-SNAPSHOT` for a development
  build), and it writes nothing under `dist/`.
- `--publish` adds `-DautoPublish=true`; without it the deployment waits in the Central portal and the maintainer
  publishes it there after looking at it.
- `--allow-stale` and `--skip-security-suite` are for a dry run or `--check-only`; a real run refuses both, so Central
  only receives assets this run built and a program the security suite checked.

Publish the deployment in the Central portal. If the run fails before the deploy, fix the cause; when that needs a new
commit, delete the local tag (`git tag -d v0.1.0`), merge the new commit to `main`, wait for CI, switch to the merged commit and tag
again. Once
Central holds a version it cannot be replaced, so a bad published version is followed by a patch version, not by a
retry.

The run writes `integrations/jvm/dist/datum-jvm-0.1.0/` (`release.json`, `SHA256SUMS`, `README.md`) and prints the
next two steps.

### 3. Push the tag

```sh
git push origin v0.1.0
```

Two workflows start. Each builds first and stops when the tagged commit is not on `main`, when no `ci.yml` run on it
passed `ci-ok`, or when a package's version is not the tag's.

### 4. Approve the publishes

- `Release npm`: approve the `npm` environment. The tarballs publish in dependency order with provenance; a version the
  registry already holds with the same tarball is skipped and one with another tarball fails. The `release-assets` job
  then creates the draft Release when none exists and attaches the source maps, the script bundles and
  `SHA256SUMS-npm`.
- `Release FastAPI`: the `testpypi` job uploads the eight distributions to TestPyPI, `smoke` installs them on three
  Python versions, and the `pypi` job waits for its reviewer, then uploads the same files. Its `release-assets` job
  attaches `SHA256SUMS-pypi` to the same draft, creating it when the npm workflow has not. After a partial failure,
  rerun with `skip-existing` set to true on the steps that already went out, for that run only.

Both `release-assets` jobs share a concurrency group named by the tag, so they run one after the other.

### 5. Attach the Maven checksums

The Maven release is not a workflow, so its checksum list is attached by hand once the draft Release exists (after either
`release-assets` job). `release.mjs` prints these commands with the real paths:

```sh
cp integrations/jvm/dist/datum-jvm-0.1.0/SHA256SUMS integrations/jvm/dist/SHA256SUMS-maven
gh release upload v0.1.0 integrations/jvm/dist/SHA256SUMS-maven --repo argusvane/datum
```

The list holds a SHA-256 for every jar, flattened pom and signature that went to Central, with paths relative to
`integrations/jvm`; `shasum -a 256 -c` run there checks a local build against it. The draft then carries one checksum
list per registry: `SHA256SUMS-npm`, `SHA256SUMS-pypi` and `SHA256SUMS-maven`.

### 6. Publish the Release

The workflows leave a draft with the one-line note `Datum v0.1.0`. Open it (`gh release list`; there is exactly one
draft for the tag), replace the note with the `## [0.1.0]` section of `CHANGELOG.md`, check the assets, and publish it.

Last, install from each registry in a clean directory: an `npm install @argusvane/datum`, a Maven resolve of `datum-bom`
and a `pip install argusvane-datum-fastapi`.

## When something stops half way

- A published npm or PyPI version is never replaced, and a published tag is never moved. A defect found after publishing
  is fixed in a patch version with its own tag.
- A workflow job that fails before it publishes is rerun from the Actions page. The npm publish step is safe to rerun:
  it compares the registry's digest with the tarball it holds.
- A tag pushed by mistake on a commit that is not on `main` stops in the build job. Delete the tag on the remote
  (`git push origin :refs/tags/v0.1.0`) once nothing published from it.
