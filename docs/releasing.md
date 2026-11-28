# Releasing Datum

How a release is cut: one version, one tag `v<version>`, three registries and one GitHub Release. The commands use
0.1.0. Only a plain `X.Y.Z` version is released. A prerelease cannot be named alike everywhere: npm takes
`0.2.0-rc.1`, while the FastAPI release script and the PyPI workflow take only PEP 440's normalized form (`0.2.0rc1`),
so one tag cannot name both. The Maven release script refuses anything but `X.Y.Z` on a real run.

Each registry has its own workflow, and the push of the tag starts all three:

| Host | Published by | Starts when | Can be undone |
|---|---|---|---|
| Maven Central (`com.argusvane`) | `.github/workflows/release-maven.yml`, then the maintainer in the Central portal | the push of the tag `v<version>` | no: a Central version is permanent |
| npm (`@argusvane/*`) | `.github/workflows/release-npm.yml` | the push of the same tag | no: a version number is never reused |
| PyPI (eight `argusvane-datum-*` distributions) | `.github/workflows/release-fastapi.yml`, TestPyPI first | the push of the same tag | no |

Each workflow builds first and refuses a tagged commit that is not on `main` or has no `ci.yml` run that passed `ci-ok`,
then waits for its environment's reviewer before anything is uploaded. The Maven workflow's build job runs
`integrations/jvm/scripts/release.mjs --stage`, which holds no key and no token: it builds and tests the reactor and
stages an unsigned Central bundle. Its publish job, behind the `maven-central` environment, signs that same bundle with
the release key and uploads it (`integrations/jvm/scripts/central-publish.mjs`), so what Central receives is what was
tested. The deployment then waits in the Central portal until the maintainer publishes it.

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
2. Create four GitHub environments (Settings, Environments): `npm`, `testpypi`, `pypi` and `maven-central`. Give `npm`,
   `pypi` and `maven-central` a required reviewer (the owner), and `testpypi` one too if the first upload should wait. GitHub creates an
   environment that does not exist on its first use with no protection, so create them before anything that lets a job
   publish: a trusted publisher registered while `pypi` is unconfigured lets a pushed tag upload unapproved. Required
   reviewers need a public repository or a paid plan.
3. Configure npm trusted publishing: `release-npm.yml` publishes with its job's OIDC token and reads no npm secret.
   On npmjs.com, for each published package (`@argusvane/datum`, `@argusvane/datum-conformance-suite` and
   `@argusvane/datum-form-test`), open Settings, Trusted publishing, and add a GitHub Actions publisher: organization or
   user `argusvane`, repository `datum`, workflow filename `release-npm.yml` (the file name only), environment `npm`.
   Every field is case-sensitive and npm checks none of them until a publish. Then, under Publishing access, choose to
   require two-factor authentication and disallow tokens, and delete the `NPM_TOKEN` secret from the `npm` environment
   (and any automation token it held on npmjs.com). The publish needs npm 11.5.1 or later on Node 22.14.0 or later; the
   workflow pins npm 11.21.1. Provenance comes with the same OIDC token.
4. Register a pending trusted publisher on PyPI and on TestPyPI for each of the eight distributions: workflow
   `release-fastapi.yml`, environment `pypi` on PyPI and `testpypi` on TestPyPI.
5. Restrict who may create `v*` tags to the owner and require the `ci-ok` check on `main` (a repository ruleset; it needs
   the same plan as step 2). Both workflows start on every `v*` tag.
6. For Maven: the namespace `com.argusvane` is verified in the Central portal. Store four secrets in the `maven-central`
   environment:
   - `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`: a portal user token (Account, Generate User Token), not the
     account's login.
   - `MAVEN_GPG_PRIVATE_KEY`: the release signing key, ASCII-armored (`gpg --armor --export-secret-keys <key id>`).
   - `MAVEN_GPG_PASSPHRASE`: its passphrase.

   Central checks the signatures against the public keyservers, so send the public key to `keyserver.ubuntu.com` and
   `keys.openpgp.org` (`gpg --keyserver <host> --send-keys <key id>`; the second mails the key's address to confirm it).
   Keep an offline copy of the secret key: every later release should be signed with the same one.
7. Run `jvm.yml` by hand once on the commit to be released, for every Java version (`gh workflow run jvm.yml -f java=all`):
   the JVM host has no pull request gate, so this is where its test matrix runs. The Maven release workflow builds and
   tests on Java 21 only.

## The order of a release

### 1. The release commit

The tree carries the release version before the tag is made; the workflows refuse a tag whose version does not match.

- npm: every published package's `version` is the release version and its `repository.url` is the canonical one.
  `node scripts/npm/release.mjs check --version 0.1.0` says what is wrong.
- PyPI: `npm run fastapi:release -- --version 0.1.0` sets every member's version and rewrites the sibling pins, builds
  the distributions locally and uploads nothing. Commit the changes it makes. It does not tag: the tag is made in step 2, on the
  merged commit, and pushed in step 3.
- Maven: nothing in the tree changes; the workflow takes the version from the tag.
- Changelog: `node scripts/changelog-promote.mjs --version 0.1.0` turns `## [Unreleased]` into `## [0.1.0] - <date>` and
  leaves an empty `## [Unreleased]` above it. Read the section once: it is the release's notes. `release.mjs` refuses to
  run when the version's section is missing.
- If the release changes what is published, update [Release status](https://datum.argusvane.com/docs/introduction#release-status)
  in `site/docs/introduction.md`, the one place that says it.

Open a pull request with the commit. `main` takes squash-merged pull requests, so the commit that lands on `main` is a
new commit with its own SHA, and it is that commit that is released. Wait for `ci.yml` to finish with `ci-ok` green on
the merged commit. The three workflows look for a green `ci-ok` on the tagged commit and stop without it.

### 2. Tag the merged commit and push the tag

The tag goes on the merged commit, not on the branch the pull request came from: its SHA is not the merged one.

```sh
git fetch origin
git switch --detach origin/main    # the merged commit (or: git switch main && git pull --ff-only)
git tag v0.1.0
git push origin v0.1.0
```

Three workflows start. Each builds first and stops when the tagged commit is not on `main`, when no `ci.yml` run on it
passed `ci-ok`, or when a package's version is not the tag's.

The Maven build job (`Release Maven`, about an hour) runs `release.mjs --stage`, which also refuses a version that is not
a plain `x.y.z` and a `CHANGELOG.md` without a `## [0.1.0]` section. It builds the web components and the assets, runs the
security suite over the sandbox program on quickjs-emscripten (the page's engine), builds and tests the reactor on Java 21
with the QuickJS runtime compiled for all six native targets, runs the security suite again on the `qjs-wasi.wasm` that
build compiled (held to the pom's `qjs.sha256`), runs the post-checks over every jar, and stages the Central bundle with nothing signed. The release
directory (`release.json`, `SHA256SUMS`, `README.md` and `central-bundle.zip`) is the job's artifact.

The FastAPI build job runs the security suite twice as well, before anything is built: on quickjs-emscripten, for the
bundles `argusvane-datum-assets-ui` carries to the page, and on the `qjs-wasi.wasm` `argusvane-datum-qjs-wasm` carries
(held to `runtime.json`), the engine the server runs. The browser bundles and the npm packages run only
quickjs-emscripten, which `ci.yml` checks on every change.

### 3. Approve the publishes

- `Release Maven`: approve the `maven-central` environment. The publish job builds nothing. It checks the bundle against
  `release.json`, refuses a version Central already holds, signs every jar and pom, uploads the signed bundle and waits
  for Central to validate it. Its `release-assets` job then attaches `SHA256SUMS-maven` to the tag's Release, creating
  the draft when none exists.
- `Release npm`: approve the `npm` environment. The tarballs publish in dependency order with provenance; a version the
  registry already holds with the same tarball is skipped and one with another tarball fails. The `release-assets` job
  then creates the draft Release when none exists and attaches the source maps, the script bundles and
  `SHA256SUMS-npm`.
- `Release FastAPI`: the `testpypi` job uploads the eight distributions to TestPyPI, `smoke` installs them on three
  Python versions, and the `pypi` job waits for its reviewer, then uploads the same files. Its `release-assets` job
  attaches `SHA256SUMS-pypi` to the same draft, creating it when the npm workflow has not. After a partial failure,
  rerun with `skip-existing` set to true on the steps that already went out, for that run only.

The three `release-assets` jobs share a concurrency group named by the tag, so they run one after the other. The draft
then carries one checksum list per registry: `SHA256SUMS-npm`, `SHA256SUMS-pypi` and `SHA256SUMS-maven`. The Maven list
holds a SHA-256 for every jar, pom and signature uploaded, by its path in the repository, so a file downloaded from
`https://repo1.maven.org/maven2/<path>` can be checked against it.

### 4. Publish the Maven deployment

The validated deployment waits in the Central portal (Publishing, Deployments, named `datum-jvm-0.1.0`). Look at its
components, then publish it, or drop it on a finding. Once Central holds a version it cannot be replaced, so a bad
published version is followed by a patch version, not by a retry. A run started by hand with `auto-publish` set lets
Central publish the deployment as soon as it is validated.

#### A tag that is already pushed

When the Maven workflow did not run for a tag, or stopped before the upload, start it by hand on that tag. It builds the
tag's tree with the release scripts of `main`, so a tag pushed before a fix to those scripts (v0.1.0 was pushed before
the workflow existed) is still released by the fixed ones. A failed upload has left nothing on Central, so this is safe;
the publish job refuses a version Central already holds.

```sh
gh workflow run release-maven.yml --repo argusvane/datum -f tag=v0.1.0
```

#### Trying the Maven build on a machine

`npm run jvm:release -- --version 0.1.0 --dry-run` runs the workflow's checks as warnings, builds without signing and
uploads nothing, so it works before the tag exists. `--check-only` runs only the post-checks over the jars already under
`integrations/jvm/target/`: it needs no tag, no network and no `gh`, and writes nothing under `dist/`. `--allow-stale`
and `--skip-security-suite` are for those two; a staged or real run refuses both, so Central only receives assets the
run built and a program the security suite checked. A real run without `--stage` signs with the local keyring and
uploads with the token in `~/.m2/settings.xml` (server id `central`); the workflow has replaced it, and it is kept only
for when GitHub Actions cannot be used.

### 5. Publish the Release

The workflows leave a draft with the one-line note `Datum v0.1.0`. Open it (`gh release list`; there is exactly one
draft for the tag), replace the note with the `## [0.1.0]` section of `CHANGELOG.md`, check the assets, and publish it.

Last, install from each registry in a clean directory: an `npm install @argusvane/datum`, a Maven resolve of `datum-bom`
and a `pip install argusvane-datum-fastapi`.

## When something stops half way

- A published Maven, npm or PyPI version is never replaced, and a published tag is never moved. A defect found after publishing
  is fixed in a patch version with its own tag.
- A workflow job that fails before it publishes is rerun from the Actions page. The npm publish step is safe to rerun:
  it compares the registry's digest with the tarball it holds. The Maven publish job refuses a version Central already
  holds; a deployment that failed validation is dropped in the portal before the rerun.
- A tag pushed by mistake on a commit that is not on `main` stops in the build job. Delete the tag on the remote
  (`git push origin :refs/tags/v0.1.0`) once nothing published from it.
