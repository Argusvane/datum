# Datum for Python web applications

This directory is a [uv](https://docs.astral.sh/uv/) workspace holding the Python distributions of the Datum forms host:
`argusvane-datum-sandbox` (every part of running the programs, for any framework: the generic hardened WASI run, the run
protocol, `SandboxSettings`, `DatumSandbox`, the diagnostics and the engine kit), `argusvane-datum-core` (framework-free
services, configuration, checks and store protocols over it), `argusvane-datum-fastapi` (the FastAPI binding: router
factories and the `Datum` object), `argusvane-datum-sandbox-wasmtime` (the wasmtime engine), and the four resource
distributions `argusvane-datum-programs`, `argusvane-datum-qjs-wasm`, `argusvane-datum-assets-ui` and
`argusvane-datum-assets-pdf`. The guide is [docs/fastapi.md](../../docs/fastapi.md); the sandbox library is described in
[ADR 0176](../../docs/adr/0176-one-sandbox-library-per-server-language.md).

## Working on it

The resource distributions and every package's `datum-build.json` are generated from the repository's built bundles, and
the build guard refuses any build, including an editable install, until they exist. You need Node 22 with npm and
[uv](https://docs.astral.sh/uv/) (Python 3.12 or later is supported; uv fetches the 3.14 interpreter pinned in `.python-version`
when none is installed). On a fresh clone run, from the repository root:

```sh
npm run fastapi:prepare
```

It installs the JavaScript units the assets are built from, builds the datum bundles (`packages/datum/dist`, a few minutes) and
the conformance suite's commands (`packages/conformance-suite/dist/host-check.mjs`, which the asset build runs for the test
fixtures), builds the assets (`npm run fastapi:assets`), syncs the workspace (`uv sync --all-packages --all-extras --frozen`) and writes
the settings schema, which needs the synced workspace. Later, after a change to the bundles or the resource inputs, `npm run datum:build`
and `npm run fastapi:assets` refresh the generated files.

Then run one member's tests with `uv run --frozen --no-sync --package argusvane-datum-core pytest packages/argusvane-datum-core`, or every
member with `npm run fastapi:test` from the repository root. That runs `scripts/test-members.mjs`: argusvane-datum-core and
argusvane-datum-fastapi split their unmarked bulk over pytest-xdist workers (`--workers N`, default half the cores) and then run their
`runtime`, `openssl` and `server` tests in one quiet process each; the small members run as they are, all concurrently
(`--print` shows the plan). A plain `uv run --frozen --no-sync pytest` from this directory collects every member into one
process; the observation tests share that process's one OpenTelemetry SDK through `datum_core.testing.otel`. `uv.lock` is committed; change a dependency in
the member's `pyproject.toml` and run `uv lock` once, never concurrently with another uv command. The Python version pinned
in `.python-version` is the one CI uses; the distributions support Python 3.12 and later.

Static checks run from this directory: `uv run --frozen --no-sync ruff check .`, `mypy packages`, `pyright`, `lint-imports`,
and `deptry .` from inside each member directory.

### Running the host check

`examples/submissions/host_check_app.py` is TEST WIRING for `datum-host-check`, never for production: it adds the dry-run
route, a host context provider that trusts the `X-Datum-Test-Role` header for the `datum-host-context` form, and the kit's
hostile rule module for the fixture form. It refuses to start without `HOST_CHECK_TEST_WIRING=yes-this-is-a-test-deployment`.

`datum-host-check` below is not on your path until you build it. Build it once from the
repository root: `npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel packages/submissions packages/conformance-suite` (the suite builds through `file:` links to the first four), then `npm run conformance-suite:build`. Then run it from
this directory as `node ../../packages/conformance-suite/bin/datum-host-check.mjs`, with the same arguments.

```sh
datum-host-check fixtures --out kit/
export HOST_CHECK_TEST_WIRING=yes-this-is-a-test-deployment
export DATUM_FORMS__LOCATIONS='["kit/fixture-form.json","kit/fixture-host-context-form.json"]'
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true DATUM_WEB__API__ENDPOINTS__VALIDATE=true DATUM_WEB__API__ENDPOINTS__TEST=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true DATUM_WEB__ASSETS__ENABLED=true DATUM_RUNTIME__VALIDATION__MEMORY=512MiB
# the flood cases: FLD-01 passes the per-form limit, FLD-02 the address limit (above the rest of the run, below 400)
export DATUM_WEB__THROTTLE__LIMIT=30 DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200
# optional: trace every run and keep the failed ones (personal data: an owner-only scratch directory, off after debugging)
# export DATUM_RUNTIME__DIAGNOSTICS__TRACE=all DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__ENABLED=true
# export DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__DIRECTORY="$PWD/kit/captures"
uv run --frozen --no-sync --package datum-example-submissions uvicorn host_check_app:app --port 8765 &
datum-host-check --endpoint http://127.0.0.1:8765 --capabilities submissions,submissions-test,forms,assets,hardening,host-context,flood
```

The `runtime-down` capability needs its own process: the same module started with
`DATUM_RUNTIME__PROGRAMS__SANDBOX=kit/stale-program.js` and `DATUM_RUNTIME__FAIL_FAST=false` (no test, assets or memory
settings needed), checked with `--capabilities runtime-down`. Boot a fresh process for each run (the flood case spends the
request budget).

`npm run fastapi:host-run` (from the repository root; `integrations/fastapi/scripts/host-run.mjs`) does the boot, the wait
and the stop in one command, on Linux and macOS: it starts the app in its own process group, waits until the port answers,
runs the check, always stops the app, and exits with the check's code. CI's two host-check steps use it:

```sh
npm run fastapi:host-run -- --port 8765 --path /datum/assets/host.json --cwd integrations/fastapi -- \
  uv run --frozen --no-sync --package datum-example-submissions uvicorn --app-dir examples/submissions host_check_app:app --port 8765 \
  --check node packages/conformance-suite/bin/datum-host-check.mjs --endpoint http://127.0.0.1:8765 --capabilities submissions,forms,assets
```

`--any-status` counts any HTTP answer as ready, which the `runtime-down` boot needs, since that host answers with an error by design.
