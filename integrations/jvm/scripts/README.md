# JVM host build scripts

- `build-assets.mjs` (`npm run jvm:assets [-- --allow-stale] [-- --omit-features=a,b] [-- --dry-run] [-- --out <dir>]`): turns `packages/datum/dist` into
  `<out>/datum-programs/`, `<out>/datum-ui/` and `<out>/datum-pdf/` (each with `manifest.json` and `NOTICE`), a `NOTICE` in every
  other published module's `<out>/<module>/` (libraries, Spring bindings and starters, the two test kits), the host kit's fixtures
  in `<out>/datum-host-tck/`, the engine kit's golden answers, fixture form and ABI 3.8 documents in `<out>/datum-sandbox-tck/`
 , `<out>/assets.properties`, and the test fixtures under `<out>/<module>/test-fixtures/` (on the test class path
  as `datum-fixtures/`: copies of the conformance suite's goldens, the PDF kernel's documents, the engine's JCS vectors and
  `integrations/shared/fixtures`). `<out>` is `integrations/jvm/target/datum-assets` by default. The reactor's
  root pom runs the script itself once per build at `generate-resources` (exec-maven-plugin, `--out
  target/datum-assets --allow-stale=${datum.assets.allowStale} --omit-features=${datum.assets.omitFeatures}`; `-Ddatum.assets.skip=true`
  reuses the last generation), after an enforcer rule that refuses a missing `packages/datum/dist` naming
  `npm run datum:build`; a module's pom refuses to build when its directory is missing, naming `./mvnw -N
  generate-resources`. Each module directory is staged as `<module>.new` and swapped in at the end. Every dist file is claimed
  by exactly one module or the explicit skip list; an unclaimed file fails the build. The shared half lives in
  `integrations/shared/assets-lib.mjs`. Run `npm run datum:build` first.
- `notices.json`: third-party notice rows per module (`name`, `version`, `license`, `source`, `textFile` as a
  repo-relative path, optional, and `kind: "dependency"` for a Maven dependency the jar declares and does not
  repackage; a row without a kind names files the jar carries); written into each module's `META-INF/NOTICE`
  under the repository's own copyright line.
- Runtime pin: `npm run jvm:pin-runtime [-- v0.16.2]` rewrites the `qjs.*` properties
  between the `datum:qjs begin/end` comments of `libs/datum-sandbox-endive/pom.xml` from the repository's pinned qjs
  release (version, the official quickjs-ng download URL and its sha256).

- `release.mjs` (`npm run jvm:release -- --version <x.y.z> [--dry-run] [--publish] [--allow-stale]
  [--skip-security-suite] [--maven-args "<extra Maven options>"] [--check-only]`): builds,
  checks and publishes the whole reactor at one version. `--version` is mandatory. In order: the commit guard (a real run
  refuses unless the version is a plain x.y.z, the working tree is clean, `origin` names argusvane/datum, HEAD is on
  `origin/main` (no local-main fallback), a `ci.yml` run on HEAD passed `ci-ok` (read with an installed, signed-in `gh`),
  the tag `v<v>` exists and points at HEAD, and `CHANGELOG.md` has a `## [<v>]` section; it also refuses
  `--allow-stale` and `--skip-security-suite`, which only a dry run or `--check-only` take; a dry run prints
  what it would refuse and goes on; `--check-only` does not look, so it needs no tag; the tree and the tag are checked
  again before the deploy); then
  `npm run datum:build` (skipped with `--allow-stale`) and `npm run jvm:assets` (with `--allow-stale` only
  if you pass it; the Maven runs then get `-Ddatum.assets.allowStale=true`); the security suite's program mode on `target/datum-assets/datum-programs` with `--gate release` (skip
  with `--skip-security-suite`, which the output says); then Maven from `integrations/jvm` in two runs, so that the post-checks gate the upload (Central
  releases cannot be deleted): `./mvnw -B -ntp -Prelease -Drevision=<v> clean verify` builds and signs, the
  post-checks below run over the result, and only then `./mvnw -B -ntp -Prelease -Drevision=<v> -DskipTests -DskipITs
  deploy` (no clean; the sums of the checked files are compared again afterwards). Central's publishing plugin
  uploads and waits for validation; the maintainer publishes in the Central portal unless `--publish` adds
  `-DautoPublish=true`. The token is the `central` server in
  `~/.m2/settings.xml` and the key is the maintainer's GPG key; the script only checks that the server id exists
  and never prints either. `--dry-run` runs `-Prelease -Dgpg.skip=true clean verify` instead (sources and javadoc
  jars built, nothing signed or uploaded). `--maven-args` appends `-D` / `-X` options to both Maven runs (goals,
  profiles, value-taking flags and `-DautoPublish`, `-Dgpg.skip`, `-Drevision`, `-DskipTests`, `-DskipITs` are refused; note that
  `-Pdev-native` is refused by the release profile on purpose: a dry run compiles the six native targets, 20
  minutes or more).
  Then the post-checks over `target/` of every published module: the main jar, `-sources` and `-javadoc`; no module may
  hold a `-tests.jar` (the helpers that modules share live in the unpublished `libs/*-test-support` modules, each of which
  must set `maven.deploy.skip` and be named in the central-publishing `excludeArtifacts` of both the root pom and `datum-bom/pom.xml` (`checkTestSupportModules` checks each support module against both lists); the post-checks
  fail otherwise, and fail when a staged bundle, `target/central-publishing/central-bundle.zip`, holds a tests jar or a
  test-support artifact; the uploaded bundle is checked again after the deploy); main jars carry `META-INF/LICENSE`, `META-INF/NOTICE` and the `Datum-*`
  manifest entries (`Datum-Engine-Version`, `-Sandbox-Abi`, `-Pdf-Abi`, `-Build-Id`, `-Source`, written by the
  parent pom from `target/datum-assets/assets.properties`) (a value that is still a `${...}` placeholder is refused) and `Implementation-Version` equal to the version; no jar's manifest or
  embedded pom, and no flattened `.flattened-pom.xml`, mentions `SNAPSHOT` or an unresolved `${revision}`; after a
  real release every jar also has its `.asc`. The examples are never published and are
  skipped. Any finding exits 1 and writes nothing.
  It writes `integrations/jvm/dist/datum-jvm-<v>/`: `release.json` (versions, source, every artifact (jars, the flattened
  poms as deployed, `.asc` signatures) with size and SHA-256), `SHA256SUMS` (the same files, paths relative to `integrations/jvm`) and a `README.md` with the BOM
  snippet, and prints the `git push origin v<v>` that starts the npm and PyPI workflows and the `gh release upload` that attaches the checksums to the draft Release (the script tags and pushes nothing; the tag is made before the run, see `docs/releasing.md`). `--check-only` skips everything before the
  post-checks and takes the version of the jars already under `target/` (so `-SNAPSHOT` is allowed, and then the SNAPSHOT-mention checks and the sources and javadoc jars,
  which only `-Prelease` builds, are not required): the way to try the checks without a six-target build; it never deploys.

The poms of `datum-programs`, `datum-ui` and `datum-pdf` put `target/datum-assets/<artifactId>` under `META-INF/datum/` in the
jar and refuse to build when it is missing (run `./mvnw -N generate-resources`, or build the whole reactor).
