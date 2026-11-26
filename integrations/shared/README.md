# integrations/shared

Host-neutral pieces of the asset builds that turn `packages/datum/dist` into a host's files.
Each host's `integrations/<host>/scripts/build-assets.mjs` imports them, so the manifest shape, the skip
rules and the staging behaviour cannot drift apart.

Themes and plugins are not part of `packages/datum/dist`. A host that wants one takes it from `themes/<pkg>/dist/`
or `plugins/<id>/dist/` after `npm run build` in that package; the shipped hosts' asset builds copy none of them.

- `assets-lib.mjs` — plain ESM over node builtins: `parseOmitFeatures`, `createKeep` and the skip
  constants, `createStaging` (stage / swap / discard on exit), `readCatalog`, `assertFreshDist`,
  `programAbis`, `buildIdOf`, `manifestFor`.
- `catalog.ts` — run by `readCatalog` through vite-node (`--root packages/datum`); prints the
  engine version, component types, the built-in bindings (`builtinBindings`: id, label and the `pdfTheme` a server host prints under, the binding id -> PDF theme map) and the builder shell's themes, form tokens and the sandbox's
  `freezeIntrinsicsSnippet` as JSON. Theme and plugin packages are not listed: no host ships them.
- `endpoint-catalog.json` — the endpoint catalog as data (bases, routes with capability, tag, operation id,
  method, path, switch, body, statuses with codes and headers, the shared schemas, headers, parameters and responses,
  the default-response rule). The host that defines the catalog keeps a test that fails when this file differs and
  rewrites it (see that host's own README).
- `glue/datum-host.js` — the page glue a host serves at `{assets}/datum-host.js`; a host's build script copies it into its
  own gitignored assets and its node harness reads this copy.
- `db/migration/{h2,postgresql,mysql}/V*.sql` — the JDBC tables' scripts (forms V100, submissions V200, timestamp V300,
  webauthn V400), the same bytes on every host. A host's build copies each into its own assets, and its asset freshness guard counts `glue/` and `db/` as inputs.

- `fixtures/` — host-neutral test data every host's tests may read: `canonical.json` (inputs and what the engine's
  `serializeCanonicalSubmission` makes of them, the sandbox's digest contract), `webauthn-engine.json`
  (passkeys registered and submissions signed by the engine's own code, [ADR 0063](../../docs/adr/0063-webauthn-signed-submissions.md)) and `jcs-vectors.json` (RFC 8785's
  examples and the repository's tricky keys, hand-written). The engine's own RFC 8785 vectors stay in
  `engine/tests/fixtures/jcs-vectors.json`.
- `scripts/canonical-fixtures.ts` — writes `fixtures/canonical.json` and `fixtures/webauthn-engine.json` from the engine
  (`npm run shared:canonical-fixtures`; the webauthn keys are new on every run, so regenerate only when the engine's
  output changes). `--out <dir>` writes them elsewhere; `--copy-to <dir>` (repeatable) copies the two, `jcs-vectors.json` and
  the engine's vectors (as `jcs-vectors-engine.json`) into a host's own test tree, for a host whose tests run where only that
  tree is mounted (`npm run shared:canonical-fixtures` passes no `--copy-to`, so it writes the shared copy only). `--check` writes nothing and exits 1 when a
  `--copy-to` directory's copies are not byte for byte the shared ones. No host in the tree keeps such a copy;
  a host's build copies what its tests need into its own test-fixtures directory.

Host-specific parts (module tables, descriptor files, scaffolds) stay in each host's script.

The user-facing messages of `parseOmitFeatures`, `describeOmission`, `readCatalog`, `assertFreshDist`
and `programAbis` take an optional `label` (default `build-assets`) so each host's script names
itself; `parseOmitFeatures` also takes `settingsHint` (default "Datum settings » Features"). The `--omit-features` path needs `packages/datum/dist/feature-files.json`
from a packages/datum build; a host's test that needs it skips its omit-features cases until that file exists.

The tree names no host: `npm run shared:check-neutral` scans it and fails on a host's name (it runs in CI).
