# Datum for FastAPI

Python distributions that add Datum's server side to a FastAPI application: the same validation program the page runs,
in a sandbox in your process; the form definition, the browser assets and the thin page glue; PDF rendering, signing
and verification; an RFC 3161 timestamp server. Python 3.12 or newer, asyncio, found by composing router factories into
your own `FastAPI` application. Build the workspace under
[`integrations/fastapi`](../integrations/fastapi/README.md) and install from it (the build generates the browser assets
and programs itself from `packages/datum/dist`; see "Building from source" below).

The packages store no submissions. The wire shapes, error codes and statuses are the endpoint catalog's
([integrations/shared/endpoint-catalog.json](../integrations/shared/endpoint-catalog.json)), and the conformance suite
([ADR 0151](adr/0151-a-security-suite-for-the-validation-gate.md)) holds the receiving routes to them.

## Two stories, which packages

Every route is off until the application switches it on: see "Switches per story" under Install for the set each story
needs; the examples carry theirs in environment variables.

1. **My form is on a page, and the server validates what it submits.** Install `argusvane-datum-fastapi[submissions]`. You get
   `POST /api/submissions/validate` (page checks of a journey or a form), `POST /api/submissions` (the full receive
   pipeline), the `handler` hook where your code stores the accepted submission, events, the throttle and the runtime.
   No browser assets: the page loads `datum-form.js` from wherever it likes.
2. **The renderer is on my page; load the schema from my server, submit back.** Install `argusvane-datum-fastapi[ui]`. It brings
   the first story and serves the form assets under a versioned path, `GET /api/forms/{key}/definition`, data sources
   and the page glue `datum-host.js`.
3. **This application is where forms are authored** (story two plus the builder): the same install with
   `datum.builder.enabled`, which serves the builder bundle and the write endpoints, a writable form repository, and
   `routers.builder(datum, dependencies=[...])` with a dependency that decides who may use it (see "Security notes").

Add the `pdf` or `timestamp` extras for the other capabilities.

## Install

```sh
uv add "argusvane-datum-fastapi[ui]"          # or: pip install "argusvane-datum-fastapi[ui]"
```

| Extra of `argusvane-datum-fastapi` | Adds | Story |
|---|---|---|
| (none) | `argusvane-datum-core` with the async faces, FastAPI, pydantic-settings: the routers, `Datum`, `DatumSettings`. `Datum` cannot start without the programs and an engine, so every story installs at least `submissions` | the binding alone |
| `submissions` | the programs, the wasmtime runtime, `limits` for the throttle | one |
| `ui` | `submissions`, the form and builder browser assets | two and three |
| `pdf` | `submissions`, `cryptography`, the timestamp client, the PDF browser assets | any, plus PDF |
| `timestamp` | `asn1crypto` and `cryptography`: the RFC 3161 server and client | a timestamp server |
| `revocation` | `pyhanko-certvalidator`: the offline revocation checker for the PDF trust policy | PDF verification |
| `testing` | `argusvane-datum-core[testing]` (pytest, hypothesis, the OpenTelemetry SDK, the contract kits) and an HTTP client for `TestClient` | tests |
| `all` | every extra of the package but `testing` | |

The distributions, one directory each under `integrations/fastapi/packages`:

| Distribution | Holds |
|---|---|
| `argusvane-datum-sandbox` | every part of running the programs, for any framework: the generic hardened WASI run, the run protocol, `SandboxSettings` with every clamp, `DatumSandbox` (the lifecycle), the diagnostics, the async facade and the engine kit (see [Engines](#engines) and [Diagnostics](#diagnostics)) |
| `argusvane-datum-core` | the framework-free core over it: configuration, the services, hooks, events, checks and the stores. It imports no web framework; each optional capability sits behind an extra |
| `argusvane-datum-fastapi` | the router factories, `Datum`, `DatumSettings`, the OpenAPI support and the page glue file |
| `argusvane-datum-sandbox-wasmtime` | the `wasmtime` engine (see [Engines](#engines)) |
| `argusvane-datum-programs` | the sandbox program, the PDF program, the freeze-intrinsics snippet and the DejaVu fonts, with the manifest |
| `argusvane-datum-qjs-wasm` | the pinned `qjs-wasi.wasm` (quickjs-ng) and its record: version, sha256, size |
| `argusvane-datum-assets-ui` | the form and builder bundles, the builder's fonts, the feature file lists |
| `argusvane-datum-assets-pdf` | the PDF module, the page renderer, the viewer and the fonts of the browser |

The four resource distributions carry one build id, and `argusvane-datum-core` carries it too. The start refuses a mix and names
every id it found, so install them at one version (the extras pin `==0.1.0` together).

The wasmtime native library comes from wasmtime-py on 64-bit Linux (glibc and musl), macOS and Windows, on x86_64 and
arm64. Elsewhere the engine reports itself unavailable and the start stops naming the platform (see [Engines](#engines)).

Every Datum **route** is off until the application switches it on: a router factory you include registers a route only
when its switch is set, so adding a dependency or including a router never opens a door. A router included with every
one of its switches off adds nothing and the start says so (`datum.W001`). `datum.enabled=false` makes every router
add nothing. At start the log lists what is on (INFO, logger `datum.checks`, check `datum.I001`):

```
(datum.I001) Datum routes on: submissions, validate, definition, assets
```

and, when nothing is on, says so and names the settings: `Datum routes on: none (set datum.web.api.endpoints.* or
datum.web.assets.enabled)`. The OpenAPI documents follow the switches: a route that is off is absent.

### Composing the application

`Datum` is built once from a validated `DatumConfig`, and each router factory takes it:

```python
from fastapi import Depends, FastAPI

from datum_core.submissions import AcceptedSubmission, SubmissionReceipt
from datum_fastapi import DATUM_OPENAPI_TAGS, Datum, DatumSettings, routers


def keep(accepted: AcceptedSubmission) -> SubmissionReceipt:
    # idempotent on (form_key, version, submission_key): a retried attempt may reach the handler twice
    return SubmissionReceipt(id="...", reference="...")


datum = Datum(config=DatumSettings().to_config(), handler=keep)

app = FastAPI(openapi_tags=DATUM_OPENAPI_TAGS)
app.include_router(routers.forms(datum))
app.include_router(routers.submissions(datum))
app.include_router(routers.management(datum, dependencies=[Depends(require_operator)]))
```

`Datum()` with no `config` uses the model's own defaults and reads no environment; `DatumSettings().to_config()` is the
way to read `DATUM_*` variables and a TOML file (see "Configuration"). Every router factory takes `prefix=` (the
catalog's base by default) and `dependencies=`; the factories of the routes that run work for the caller or write
(`management`, `authoring`, `builder`, `pdf`) are *privileged*: `dependencies` is a required keyword, so an unprotected
router reads `dependencies=[]` in your source.

| Factory | Routes (each on its own switch) | Default prefix |
|---|---|---|
| `routers.forms` | `GET /forms/{key}/definition`, `GET /forms/{key}/translations`, `GET /data-sources/{id}` | `/api` |
| `routers.submissions` | `POST /submissions`, `POST /submissions/validate` | `/api` |
| `routers.authoring` (privileged) | `POST /submissions/test` (the dry run), `POST /inspect` | `/api` |
| `routers.assets` | `GET`/`HEAD` `host.json`, `datum-host.js`, `{build_id}/{path}` | `/datum/assets` |
| `routers.builder` (privileged) | `POST /forms`, `PUT /forms/{key}`, `PUT /forms/{key}/translations`, and the author's copy of a definition | `/api` |
| `routers.pdf` (privileged) | `POST /pdf`, `POST /pdf/fill`, `POST /pdf/sign`, `POST /pdf/verify`, `GET /server/certificate` | `/api` |
| `routers.tsa` | `POST /tsa`, `GET /tsa/certificate`, `GET /tsa/certificates` | `/tsa` |
| `routers.management` (privileged) | `GET /livez`, `/readyz`, `/health`, `/info`, and `POST /recheck` on its switch | none (the root) |

Each router carries the lifespan that starts `Datum`: including a router is what starts the runtime (see "Lifecycle and
hooks"). A FastAPI application started with its lifespan off (`uvicorn --lifespan off`) never starts Datum, and every
Datum route answers 503 `server.unavailable` with one ERROR in the log that says why.

### Switches per story

| Story | Settings set to `true` | Routes |
|---|---|---|
| One: the form is on my page, the server validates | `datum.web.api.endpoints.submissions`, `.validate`, `.definition` | `POST /api/submissions`, `POST /api/submissions/validate`, `GET /api/forms/{key}/definition` and `/translations` |
| Two: the server also serves the form | story one plus `datum.web.assets.enabled`, `datum.web.api.endpoints.data_sources` | the bundles and `datum-host.js` under `/datum/assets`, `GET /api/data-sources/{id}` |
| Three: this application authors forms | story two plus `datum.builder.enabled`, a writable repository, and a dependency on `routers.builder` | `POST /api/forms`, `PUT /api/forms/{key}`, `PUT /api/forms/{key}/translations`, the builder files |
| PDF | `datum.web.api.endpoints.pdf`, `.fill`, `.sign`, `.verify`, `.certificate` (any subset) | `POST /api/pdf`, `/api/pdf/fill`, `/api/pdf/sign`, `/api/pdf/verify`, `GET /api/server/certificate` |
| Operators | `datum.web.api.endpoints.test`, `.inspect`, `datum.web.management.recheck` | the dry run `POST /api/submissions/test`, the kernel's `POST /api/inspect`, `POST /recheck` |
| Timestamp server | `datum.tsa.enabled` | `POST /tsa`, `GET /tsa/certificate`, `/tsa/certificates` |

The definition switch also decides whether the form files are read: `datum.forms.locations` is loaded only when
`datum.web.api.endpoints.definition` or `datum.builder.enabled` is on (see "The forms files").

For example, story two in the environment:

```sh
export DATUM_FORMS__LOCATIONS='["forms/*.json"]'
export DATUM_WEB__ASSETS__ENABLED=true
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true
export DATUM_WEB__API__ENDPOINTS__VALIDATE=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true
export DATUM_WEB__API__ENDPOINTS__DATA_SOURCES=true
uvicorn app:app
```

## Configuration

The settings are `DatumConfig`, a frozen pydantic tree (`datum_core.config`), every field described and bounded.
`DatumSettings` (`datum_fastapi`) is the same tree plus where its values come from, in this order of precedence:

1. keyword arguments (`DatumSettings(web={"api": {"max_body_size": "2MiB"}})`),
2. environment variables, `DATUM_` plus the dotted name in capitals, `__` between levels:
   `datum.web.api.max_body_size` is `DATUM_WEB__API__MAX_BODY_SIZE`. A list is JSON
   (`DATUM_FORMS__LOCATIONS='["a/*.json"]'`); an empty variable counts as unset,
3. the TOML file named by `DATUM_CONFIG_FILE` (tables mirror the dotted names: `[web.api]`, `max_body_size = "2MiB"`),
4. the defaults.

There is no `.env` file reading. `DatumSettings().to_config()` hands the validated tree to `Datum` as a plain
`DatumConfig`. A value is a number of seconds, a numeric string or an ISO 8601 duration (`5`, `"5.5"`, `"PT5S"`) for a
duration, and an integer or a size with a unit for a size (`32MiB` is binary, `32MB` decimal). The published JSON Schema
of the tree is `python -m datum_core.config.schema --out <path>`; the same file ships as
`datum_core/datum-settings.schema.json`, so an editor can complete a TOML file.

**A value that cannot work stops the start**, naming the setting, as every pydantic model does. An unknown member of a
known section (`DATUM_WEB__ASSETZ`), a word that is not in a setting's set (it names the allowed ones and the closest:
`formula_errors` takes `fail`, `warn`; `fial` is refused with `did you mean 'fail'?`), a bound that is not met, a time
zone that is no IANA name raise pydantic's `ValidationError`, with input values hidden from the message. A `DATUM_*`
variable whose first segments match no setting (`DATUM_WEBB__X`) is warned about (`datum.W007`, with the closest name);
with `datum.strict_env` it stops the start instead. Nothing falls back to a default silently. The exceptions are the run
budgets, documented safety clamps (see "Runtime and host options"): they keep their bounds and the `datum.W008` warning.

Configuration problems the start finds are `DatumConfigurationError`s (a `ValueError` carrying a message, a `hint` and
the `problems` checks); an engine that is misnamed or unavailable is the `EngineSelectionError` subclass:

```
no program runtime engine 'wasmtime2' is installed (found: wasmtime)
HINT: install the distribution that provides it, or set datum.runtime.engine to one found
```

A refusal never carries a secret: passwords, tokens and keys are `SecretStr`s, a URI with credentials prints with its
user-info replaced, and a too-short secret is reported by its length.

### Web (`datum.web.*`, root `datum.enabled`)

| Setting | Default | |
|---|---|---|
| `datum.enabled` | `true` | master switch; `false` makes every router add no route |
| `datum.strict_env` | `false` | an unknown `DATUM_*` variable stops the start instead of `datum.W007` |
| `datum.silenced_checks` | none | check ids to silence; INFO and WARNING only (an ERROR id is refused here) |
| `datum.workers_expected` | none | processes the deployment runs; unset reads `WEB_CONCURRENCY`, else 1 (see "Memory and pool guidance") |
| `datum.web.api.max_body_size` | `1MiB` | counted on the raw stream before parsing (413 over it); also the services' document cap |
| `datum.web.api.problem_details` | `false` | answer errors as RFC 9457 `application/problem+json` with the same codes |
| `datum.web.api.busy_retry_after` | `5` | the `Retry-After` of a 503 `server.busy`, whole seconds, 1 to 3600 |
| `datum.web.api.correlation_header` | `X-Request-ID` | the request header that names a request in the logs (see "Observability") |
| `datum.web.api.endpoints.<name>` | `false` | per-endpoint switch, every one off until set: `submissions`, `validate`, `test`, `inspect`, `definition`, `data_sources`, `pdf`, `fill`, `sign`, `verify`, `certificate` |
| `datum.web.assets.enabled` | `false` | serve the packaged bundles through `routers.assets` |
| `datum.web.assets.cache_period` | `365d` (31,536,000 s) | `max-age` of the immutable asset responses |
| `datum.web.assets.omit_features` | none | feature tokens whose files answer 404 (ADR 0143); an unknown token stops the start, naming the known ones |
| `datum.web.csrf.header_name` / `cookie_name` / `meta_name` | `X-XSRF-TOKEN` / `XSRF-TOKEN` / `_csrf` | the names `host.json` tells the glue |
| `datum.web.throttle.enabled` / `limit` / `window` / `by` | `true` / `60` / `60 s` / `ip, form` | the default throttle; `limit` is at least 1, `window` at least 1 s, `by` takes `ip`, `form`, `principal` (at least one) |
| `datum.web.throttle.limits.<kind>` | none | a limit of its own for a request kind: `submit`, `validate`, `test`, `pdf`; at least 1; a kind not listed uses `limit` |
| `datum.web.throttle.storage` | `async+memory://` | a `limits` storage URI; see "Rate limiting" |
| `datum.web.throttle.key_salt` | none | secret that salts the storage keys; at least 32 bytes; required when the storage is shared |
| `datum.web.throttle.address_limit` | `600` | requests per `window` from one client address, counted before the body is read; `None` or the word `off` turns it off, and it is off when `enabled` is `false`; an IPv6 client is counted by its /64; its own key space in the same storage, with the same `key_salt`, `window` and `max_keys` |
| `datum.web.throttle.max_keys` | `10000` | the most counters the in-process storage holds |
| `datum.web.openapi.enabled` | `true` | describe the Datum routes in the application's OpenAPI document |
| `datum.web.openapi.tag_prefix` | `datum-` | the prefix of Datum's tags |
| `datum.web.openapi.group_documents` | `false` | one OpenAPI document per router (see "OpenAPI") |
| `datum.web.management.recheck` | `false` | register `POST /recheck` |

### Forms and builder

| Setting | Default | |
|---|---|---|
| `datum.forms.locations` | `["datum/forms/*.json"]` | paths and glob patterns, or `package:<pkg>/<glob>` (see "The forms files") |
| `datum.forms.snapshots.max_entries` | `500` | the in-memory snapshot store's bound (least recently used goes first) |
| `datum.forms.snapshots.public_copy_cache_size` | `256` | public copies kept, by stored hash |
| `datum.forms.translations.max_entries` | `1000` | forms the in-memory translation store holds catalogs for |
| `datum.forms.data_sources.timeout` | `15 s` | one deadline for the whole option snapshot of a submission |
| `datum.forms.data_sources.max_threads` | `16` | threads for providers that are not `async` |
| `datum.forms.cache.definition` | `no-store` | the `Cache-Control` of a definition answer |
| `datum.builder.enabled` | `false` | serve the builder bundle and register the write routes |
| `datum.builder.max_definition_size` | `1MiB` | the largest definition a save reads (413 over it); at most `64MiB` |

### Runtime and host options

| Setting | Default | |
|---|---|---|
| `datum.runtime.engine` | `wasmtime` | the engine that runs QuickJS, by its provider's id (see [Engines](#engines)); an id no installed engine has, or one unavailable here, stops the start whatever `fail_fast` says |
| `datum.runtime.fail_fast` | `true` | a runtime that cannot prove its programs stops the start; with `false` the start completes, `readyz` is 503 and every run answers 503 until a recheck passes |
| `datum.runtime.warm_up_runs` | `3` | smoke runs at start; at least one is always made |
| `datum.runtime.shutdown_grace` | `10 s` | how long the last lifespan exit waits for calls in flight, then the runtime interrupts the rest (503 `server.unavailable`); keep it under the process manager's kill timeout |
| `datum.runtime.startup_budget` | `30 s` | time allowed for the start (compiling the guest takes seconds on a small VM); an overrun is `datum.E004`, naming the phases so far |
| `datum.runtime.tick` | `50 ms` | resolution of the shared run clock; a looping guest ends within two ticks of its budget |
| `datum.runtime.work_dir` | the temp directory | container-local directory for the private run directories; leftovers older than six minutes are swept at start |
| `datum.runtime.stop_grace` / `max_strays` | `5 s` / `0` | how long a stopped run's thread is given to end; how many stopped runs may outlive that before new runs are refused (`0` is one per CPU, at least two) |
| `datum.runtime.worker_threads` | `0` | worker threads the binding allows for runs plus in-flight hooks; `0` is `2 * slots + 2` (see "Memory and pool guidance") |
| `datum.runtime.validation.time_limit` / `memory` / `concurrency` / `wait` | `5 s` / `32MiB` / `0` / `2 s` | one validation run; `0` slots is one per CPU; `wait` is the wait for a free slot before 503 `server.busy` |
| `datum.runtime.pdf.time_limit` / `memory` / `concurrency` / `wait` | `60 s` / `256MiB` / `0` / `2 s` | one PDF run; `0` slots is the smaller of 2 and the CPUs |
| `datum.runtime.verify_max_bytes` | `20MiB` | the largest PDF the verify route reads (413 over it) |
| `datum.runtime.programs.sandbox` / `pdf` | the packaged programs | a file used instead; still proved by the ABI probe |
| `datum.runtime.qjs_path` / `qjs_sha256` | the packaged guest | an own copy of `qjs-wasi.wasm`, and the SHA-256 the engine holds it to (the digest needs the path) |
| `datum.host.formula_errors` | `fail` | what a formula that cannot be evaluated does: `fail` or `warn` |
| `datum.host.risky_patterns` | `refuse` | a regular expression that repeats a repeat: `refuse` or `allow` |
| `datum.host.time_zone` | the process zone | the IANA zone `today()` and date rules read in; the process zone is read once through `tzlocal` (UTC with `datum.W010` when it cannot be) |
| `datum.host.unknown_fields` | `strip` | an answer with no component: `strip`, `keep` or `reject` |
| `datum.runtime.diagnostics.trace` | `off` | one line per run on `datum.sandbox.trace`: `off`, `failures` (failed runs only) or `all` (see [Diagnostics](#diagnostics)) |
| `datum.runtime.diagnostics.report` | `true` | log the effective settings, each with its source, once at start on `datum.sandbox.settings` |
| `datum.runtime.diagnostics.capture.enabled` | `false` | keep the bytes of every failed run on disk; they hold the submitted answers and the form definition |
| `datum.runtime.diagnostics.capture.directory` | unset | the owner-only directory the captures go to (0700, this process's user, no ACL); required when the capture is on |
| `datum.runtime.diagnostics.capture.max_runs` / `max_bytes` / `queue_bytes` | `20` / `64MiB` / `64MiB` | captures kept, bytes kept, bytes waiting to be written; each at least 1 |
| `datum.host.log_level` | `warn` | how much of a run's log the program keeps, `off`, `error`, `warn`, `info`, `debug` |
| `datum.submissions.idempotency.memory_size` | `10000` | the receipts the in-memory idempotency store remembers; 16 to 10,000,000 |

The budgets, slots and the wait are the one place a value is clamped instead of refused. They are held to
`ProgramLimits`' bounds, and a value moved is warned once (`datum.W008`) naming the setting:

| Budget | Bounds |
|---|---|
| `validation.time_limit` | 0.001 s to 60 s |
| `validation.memory` | 4 MiB to 1 GiB |
| `validation.concurrency` | 0 to 64 slots |
| `validation.wait` | 0 to 10 s |
| `pdf.time_limit` | 0.001 s to 300 s |
| `pdf.memory` | 32 MiB to 4 GiB |
| `pdf.concurrency` | 0 to 64 slots |
| `pdf.wait` | 0 to 10 s |
| `verify_max_bytes` | 1 MiB to 100 MiB |

A memory budget below the guest module's initial pages (256 KiB for the pinned module) is not clamped: it is `datum.E003`
and stops the start. The runtime's output caps (32 MiB stdout, 64 KiB stderr, 8 Mi UTF-16 units of outcome) are not
configurable.

### PDF and timestamp

| Setting | Default | |
|---|---|---|
| `datum.pdf.enabled` | `true` | the PDF capability; it needs the `pdf` extra only when something asks for it (a PDF route, the seal, a key, a PDF seam) |
| `datum.pdf.fonts` | `default` | `default` (DejaVu Sans and Sans Bold), `standard` (five faces), `all` (seven) |
| `datum.pdf.signing.type` | `PKCS12` | the key format, `PKCS12` or `PEM` |
| `datum.pdf.signing.pkcs12_file` / `pkcs12_password` / `friendly_name` / `key_password` | none | the key store; the passwords are secrets |
| `datum.pdf.signing.key_file` / `cert_file` | none | the PEM private key and the certificate chain |
| `datum.pdf.signing.retired_certificates` / `trust_anchors` | none | PEM locations: earlier server certificates; anchors that make a signer or timestamp authority "trusted" |
| `datum.pdf.signing.tsa.url` / `timeout` / `bearer_token` / `basic_user` / `basic_password` | none / `10 s` | a named timestamp server for seals (the client sends credentials only to that URL) |
| `datum.pdf.signing.tsa.policy` | none | the `reqPolicy` object identifier every request to that server asks for; a value that is no object identifier is refused |
| `datum.pdf.seal.enabled` / `layouts` / `certify` / `timestamp` / `reason` / `location` / `visible` | `false` / all / `noChanges` / `true` | the seal on PDFs the application issues; `certify` is `noChanges`, `formFill`, `annotate` or `none` |
| `datum.pdf.seal.posted_answers` | `false` | seal PDFs of posted, unstored answers with the server's key too (off: a throwaway certificate seals them) |
| `datum.bindings.default` | `datum` | the design-system binding a form route without an override is drawn by: an id of the catalog (the bundles' `datum` and the `catalog` entries below). An id the catalog does not list stops the start. A dark Datum form is the element's `scheme` attribute, not a binding |
| `datum.bindings.routes` | none | per-route overrides, form key to binding id. The host knows a form's binding from here, never from the definition; `host.json`'s `bindings` publishes the table to the page glue (`DatumHost.binding(element, { formKey })`) |
| `datum.bindings.catalog` | none | bindings the application registers on its pages, by id, each with a `label` and the `pdf_theme` a PDF of its routes prints under. The bundles' `datum` suggests `datum-pdf`, the engine's own |
| `datum.bindings.pdf_themes` | none | PDF theme id to the path of its JSON object (`target: "pdf"`, the same `id`), for every suggested PDF theme but `datum-pdf`. A PDF of a route carries its binding's theme object as the request's host theme, below the render call's and the layout's own; nothing is written into a layout. The reply names it in `X-Datum-Pdf-Theme`: the theme the route's binding suggests, which a render call's or a layout's own theme still outranks in the drawing. A suggested theme nobody supplies stops the start |
| `datum.tsa.enabled` | `false` | the RFC 3161 server |
| `datum.tsa.access` | `clients` | `clients` (a key listed under `clients`) or `open` |
| `datum.tsa.clients` | none | SHA-256 hashes of the client keys (a key is `dtsa_` and 32 bytes in base64url) |
| `datum.tsa.client_store` | `settings` | where clients are kept: `settings` reads `clients`; `sql` says you pass a `tsa_client_store` of your own (under `clients` access the start stops without one). A `tsa_client_store` replaces the setting whatever it says |
| `datum.tsa.policy` | none | the issuing policy OID, **required** while the server is on (the start stops without it; use an OID your organisation owns); a value that is no valid policy OID stops the start |
| `datum.tsa.accuracy` / `max_request_size` | `1 s` / `16KiB` | the stated accuracy (at most 60 s), the largest request (at most 1 MiB) |
| `datum.tsa.accepted_policies` | none | further policy OIDs a request may ask for with `reqPolicy`; the issuing policy is always accepted |
| `datum.tsa.flood.limit` / `window` / `failed_keys` | `1000` / `1 h` / `10` | tokens per window per client (per address under open access, where an IPv6 client is counted by its /64 prefix), `0` turns it off; wrong client keys one address (an IPv6 client by its /64 prefix) may present per window before it is answered 429 (`0` turns the lock off) |
| `datum.tsa.signer.type` / `pkcs12_file` / `pkcs12_password` / `friendly_name` / `key_password` / `key_file` / `cert_file` | `PKCS12` / none | the signing key, read once at start |
| `datum.tsa.signer.self_signed` | `false` | a throwaway certificate made at start: development only; naming a key file as well is refused |
| `datum.tsa.retired_certificates` | none | PEM locations of earlier certificates, served on `/tsa/certificates` |
| `datum.tsa.session_cookies` | `*` | refuse (403) a request that carries a cookie: `*` is any `Cookie` header, or a list of the cookie names that count |
| `datum.tsa.allow_memory_stores` | `false` | see "Stores and the memory-store policy" |

## SPIs and hooks

Everything an application plugs in is a keyword of `Datum(...)` (or of `datum_core.Datum` without FastAPI). `None` or an
empty sequence means Datum's default. The hook sequences keep the order they are given; a hook is a plain callable, sync
or async, decided per call (see "Hooks and the event loop").

| Keyword | Type | Default | |
|---|---|---|---|
| `handler` | `SubmissionHandler`, `(AcceptedSubmission) -> SubmissionReceipt` | logs the form and digest (never the answers), stores nothing, answers a fresh UUID, with start-up warning `datum.W003` | where accepted submissions are stored; idempotent on `(form_key, version, submission_key)` |
| `form_repository` | `FormDefinitionRepository` (`current`); `WritableFormDefinitionRepository` adds `create`, `replace` | read-only `FileFormDefinitionRepository` over `datum.forms.locations` | implement it to store forms in a database; the builder needs the writable form |
| `snapshot_store` | `DefinitionSnapshotStore` (`record`, `find`) | bounded in memory | the versions a submission is judged against, by hash |
| `translation_store` | `TranslationCatalogStore` (`read`, `write` against an ETag) | bounded in memory | the builder's translation grid |
| `data_sources` | sequence of `DataSourceProvider` (`items`, `exists`) | none (404) | option lists and values a form loads (`GET /api/data-sources/{id}`). Providers are asked in order and the first whose `exists(id)` is true answers; the default `exists` answers true for every id, hides the providers after it and is warned about (`datum.W006`) |
| `pre_checks` | sequence of `SubmissionPreCheck`, `(IncomingSubmission) -> Allow \| Reject(code, message)` | none | refuse before the sandbox runs (anti-spam, quotas); the first `Reject` stops the rest |
| `pre_check_statuses` | `(Reject) -> int` | `PreCheckStatuses.standard()`: 403 for every code | `PreCheckStatuses.by_suffix()` answers 422 for `.invalid` and 503 for `.unavailable`; a mapping may answer 429 but with no `Retry-After` (a rate limit belongs in the throttle) |
| `validators` | sequence of `SubmissionValidator`, `(ValidatedSubmission, SubmissionContext) -> HookFindings \| None` | none | host-side validation after the kernel's; all run, errors refuse together, warnings ride along |
| `rules_providers` | sequence of `RulesProvider`, `(form_key, definition, context) -> Sequence[RuleModule]` | none | host rule modules for a form; `RuleModule(id, version, source)` is an ES2020 program whose completion value is `{validators, functions}` |
| `context_contributors` | sequence of `ContextContributor`, `(SubmissionContext) -> Mapping \| None` | none | entries added to the run's context, merged in order (a later key replaces an earlier one) |
| `host_context` | one `HostContextProvider`, `(form_key, SubmissionContext) -> Mapping \| None` | none: every rule that reads `host.` is left unjudged | the values a form's `host.` names read, worked out from the request (see "The host context") |
| `host_options_customizers` | sequence of `HostOptionsCustomizer`, `(form_key, definition, RunSettings, context) -> None` | none | adjust the run's `unknown_fields` and `log_level` per form, or refuse |
| `definition_customizers` | sequence of `DefinitionCustomizer` (`__call__(DefinitionDraft)`, `cache_key(DefinitionRequest)`) | none | adjust or refuse the public copy on its way to a filler (per-tenant defaults, hidden components); see "Lifecycle and hooks" |
| `builder_save_customizers`, `builder_save_validators` | sequences of `(BuilderSaveDraft) -> None`, `(BuilderSaveCandidate) -> HookFindings \| None` | none | adjust or refuse a definition before the kernel's check; judge it after the verdict, before the store |
| `pdf_request_customizers` | sequence of `(PdfRequestDraft) -> None` | none | change a PDF request's `env`, `options`, `host_context`, `attachments` and `fonts`, or refuse; never the ABI, the op or the program |
| `pdf_result_validators` | sequence of `(PdfResultCandidate) -> HookFindings \| None` | none | judge a PDF after the program made it, before any seal and before its bytes leave (page count, size policy) |
| `timestamp_request_customizers` | sequence of `(TimestampRequestDraft) -> TimestampRequestDraft \| None` | none | refuse a client, choose the policy among the accepted ones, state another accuracy, before a token is signed. A bare callable runs for `POST /tsa` only; `every_channel(fn)` also runs it for seals and receipts |
| `throttle` | `SubmissionThrottle` or `AsyncSubmissionThrottle` (`check(ThrottleKey) -> Allow \| Deny`) | `LimitsThrottle` over `datum.web.throttle`; its `limits.aio` face over a network storage | see "Rate limiting" |
| `idempotency_store` | `SubmissionIdempotencyStore` (`find`, `record`) | in memory, `datum.submissions.idempotency.memory_size` receipts | keyed by form, version and submission key: a retried attempt is answered with the first receipt, a known key with another digest is 409 `submission.keyConflict` |
| `signature_check` | `SubmissionSignatureCheck` | none | the receiver has the slot and takes only `None`; anything else is refused when the service is built |
| `tsa_time_source` | `TsaTimeSource` (`read() -> Reading`) | the `now` clock, always available | where the timestamp server gets "now" and whether it may trust it; see "Time source" |
| `tsa_key_material`, `tsa_serial_allocator`, `tsa_log`, `tsa_client_store`, `tsa_transport` | the timestamp server's key, stores and outbound POST | the key `datum.tsa.signer` names; memory stores (see the policy below); `datum.tsa.clients`; the standard-library transport | |
| `pdf_signer` | `PdfSigner` (`algorithm`, `certificates()`, `sign(to_be_signed)`) | `KeyFilePdfSigner` over `datum.pdf.signing` | the server's seal key; read once at start. The key never leaves the signer |
| `timestamper` | `Timestamper` | the client of `datum.pdf.signing.tsa.url`, else the in-process authority | where seals get their timestamps; yours is used first |
| `pdf_trust_policy` | `PdfTrustPolicy` | `PdfTrustPolicy.standard(...)`: the configured anchors, no revocation checking, every chain judged now | what makes a signer or a timestamp authority `trusted` |
| `error_translators` | sequence of `(Exception) -> HttpAnswer \| None` | none | add a response for an exception; the first answer wins, ahead of Datum's own table |
| `withheld_assets` | sequence of `(path) -> bool` | none | withhold an asset path (case-folded); a callable that raises withholds the file and is warned about once |
| `run_log` | `RunLog`, `(RunLogEntry) -> None` | one escaped line per entry on the logger `datum.sandbox` | where a real submission's guest log (`context.log`) goes |
| `sandbox_middleware`, `pdf_middleware` | sequences of `Sandbox -> Sandbox` and of PDF kernel wrappers | none | wrap the sandbox or the PDF kernel to observe every run; the first entry is outermost |
| `runtime`, `sandbox`, `engine_settings` | `GuestRuntime`, `Sandbox`, `EngineSettings` | the selected engine; the one the runtime builds | replace the engine, or the sandbox itself (it still goes through the middleware); the settings report shows them as replaced |
| `trace`, `capture_sink` | `RunTrace`, `(TraceRecord) -> None`; `RunCaptureSink` | a line on `datum.sandbox.trace`; the owner-only directory of `datum.runtime.diagnostics.capture.directory` | where traced runs and failed-run captures go (see [Diagnostics](#diagnostics)) |
| `listeners` | sequence of `(EventType, fn)` pairs, built with `listener(EventType, fn)` | none | see "Events" |
| `now` | `() -> datetime` (aware) | the clock in `datum.host.time_zone` | every time the host reads |
| `principal`, `locale` (the binding's) | FastAPI dependencies | anonymous (`None`); `accept_language` | who is calling; the request's language |

A minimal handler:

```python
def keep(accepted: AcceptedSubmission) -> SubmissionReceipt:
    # a unique key on (form_key, submission_key) stores one submit attempt once, retries included
    row_id = db.insert(accepted.form_key, accepted.submission_key, accepted.values, accepted.digest)
    return SubmissionReceipt(id=row_id, reference=f"REF-{row_id}", receipt=None)
```

**Hooks and the event loop.** Services run on worker threads (never the event loop), and a sync hook runs inline on that
thread, so blocking calls in a hook are fine; they count toward `datum.runtime.worker_threads`. An `async` hook, listener
or store is resolved through the binding's awaiter (`anyio.from_thread`), back on the loop. With `datum_core.Datum` and no
awaiter an async hook is refused at start (`DatumConfigurationError`), never silently run.

**Ordering.** A hook whose position relative to another matters must be in the right place in the list; Datum adds no
sorter. Customizers run each over what the one before left, and the first refusal stops the later ones. Validators all
run, so every error is reported at once (a `HookRefusedError` from a validator stops at once).

**The request seams.** `Datum(principal=..., locale=...)` take FastAPI dependencies. `principal` is your optional-mode
authentication dependency (`HTTPBearer(auto_error=False)`, ...): a user, or `None`. It reaches the hooks as
`context.principal`, and the throttle counts a principal under its string value, else its `username` or `name`
attribute. `locale` (default `accept_language`, the request's preferred `Accept-Language` language, else the process
locale, else `en`) reaches the definition customizers and the data-source provider.

### Stores and the memory-store policy

The development stores are in memory: the snapshot, translation and idempotency stores, the form repository you may seed
(`datum_core.stores.memory.MemoryFormDefinitionRepository`), the throttle's counters, and the timestamp server's serial
allocator, issue log and flood counters. No SQL store ships; the store protocols are the seam, and the contract kits in
`datum_core.testing` (see "Testing your application") hold a store of your own to them. The start says what is in memory
and what that costs:

| Check | When |
|---|---|
| `datum.W004` (warning) | the snapshot, translation or idempotency store, or the throttle's counters, are per-process memory in a deployment that serves them: a second worker or a restart does not see them |
| `datum.E002` (error) | the builder is on with in-memory stores and `datum.workers_expected` (or `WEB_CONCURRENCY`) is above 1: a save on one worker is invisible on the others |
| `datum.E001` (error) | the timestamp server would keep its serial allocator or issue log in memory: serials could repeat across instances or after a restart. The three ways out: your own `tsa_serial_allocator` and `tsa_log`, or `datum.tsa.allow_memory_stores=true` to acknowledge a single instance |
| `datum.W009` (warning) | the memory trust-state stores that `allow_memory_stores` acknowledged |

Health says the same (`stores.*` components, `tsa`).

### Timestamps, trust and sandbox runs

Seams that sit where a mistake is silent, each with a default that is safe on its own.

**Timestamper.** Seals are timestamped by your `timestamper` when there is one (a qualified trust service's client, an
HSM-backed authority, anything that answers a granted `TimeStampResp`); the settings it leaves unused are named at
start (`datum.I002` for the URL and credentials, `datum.W012` for the policy). Without one, the client of the server
`datum.pdf.signing.tsa.url` names, else the timestamp server's in-process authority when `datum.tsa.enabled`. With none
of them and `datum.pdf.seal.timestamp` on, a server-key seal is made without a token and carries the
`sealing.timestamp` warning (`datum.W011`). When a policy is asked, a token granted under any other policy is no token.
A failed timestamp is that warning too, never a failed PDF. The throwaway test seal is never timestamped. A token is
checked when the PDF is verified like any other: Datum does not take a `Timestamper`'s word.

**PdfTrustPolicy.** Verification places a signer (and a timestamp authority) as `trusted` when a path builds from its
certificate to one of the policy's anchors. The default, `PdfTrustPolicy.standard(signing, site_certificates=...)`, uses
the anchors of `datum.pdf.signing.trust_anchors`, no revocation checking and every chain judged now. A policy of your
own changes that:

```python
from datum_core.pdf import CertvalidatorRevocationChecker, PdfTrustPolicy
from datum_core.pdf.protocols import PdfValidationTime

policy = PdfTrustPolicy(
    anchors=anchors_der,
    revocation=CertvalidatorRevocationChecker(roots=anchors_der, crls=crls_der, ocsps=ocsps_der),
    validation_time=PdfValidationTime.SIGNING_TIME,
    site_certificates=signer_chain_der,
    name="qualified",
)
datum = Datum(config=config, pdf_trust_policy=policy)
```

The revocation checker is offline: it fetches nothing, the status of a chain comes from the CRLs and OCSP responses you
hand it, and a chain whose status cannot be learnt reads `unknown` and is not trusted. `SIGNING_TIME` judges a signer's
chain at the instant its verified timestamp proves, never the signature's own claim; a timestamp authority's own chain is
always judged now. The words are `site` (this server's key, byte for byte), `site_retired`, `trusted`, `self_signed`,
`unknown`. The verify report names the policy (`trustPolicy`) and each trusted signature the instant its chain was judged
at (`trustedAt`). A policy given as an application seam needs `site_certificates` set to the server's own certificates,
or the server's own seals read as unknown.

**RunLog.** A real submission's guest log goes to your `run_log` (default: one line per entry on `datum.sandbox`, every
control character escaped). Yours receives the text as the guest wrote it: escape it before it reaches a line-oriented
log. Dry runs, smoke and warm-up runs relay nothing. The log is an observer: when yours raises, the entry is dropped with
one warning per run naming the exception's class, and the submission's verdict stands.

**Sandbox runs.** The receiver, the inspection and the definition service (public copies, the builder's checks) run on
one composed `Sandbox`. `sandbox_middleware` wraps it: each entry takes the sandbox it is handed and returns one, the
first entry outermost, Datum's own observation (`datum.sandbox.run`) innermost. `pdf_middleware` does the same for the PDF
kernel (`datum.pdf.run`). A middleware must delegate every call and rethrow what that sandbox throws; one that answered in
its place would take the kernel out of the decision, which the code cannot detect, so the rule is stated rather than
enforced. A middleware that returns `None` is refused with a `TypeError`.

```python
def tracing(inner: Sandbox) -> Sandbox:
    return TracingSandbox(inner)   # implements Sandbox, delegating

datum = Datum(config=config, sandbox_middleware=[tracing, audit])
```

### Signing keys

The PDF signer and the timestamp server read their private key from files, once, at start:

```sh
export DATUM_PDF__SIGNING__PKCS12_FILE=/etc/datum/pdf-signer.p12
export DATUM_PDF__SIGNING__PKCS12_PASSWORD="$PDF_KEYSTORE_PASSWORD"
export DATUM_TSA__ENABLED=true
export DATUM_TSA__SIGNER__TYPE=PEM
export DATUM_TSA__SIGNER__KEY_FILE=/etc/datum/tsa.key
export DATUM_TSA__SIGNER__CERT_FILE=/etc/datum/tsa.crt
```

A PKCS#12 store takes `pkcs12_file`, `pkcs12_password`, `friendly_name` (checked against the key's certificate, never used
to choose it) and `key_password`; PEM takes `key_file` and `cert_file` (the chain, leaf first). A setting the chosen type
cannot use, a leaf that is not the key's, or a key outside the supported set is refused naming `datum.pdf.signing` or
`datum.tsa.signer`, never a password or a byte of a key. The PDF seal key is RSA (PKCS#1 v1.5, at least 2048 bits) or
ECDSA on P-256 or P-384, with SHA-256. The timestamp key additionally carries the extended key usage RFC 3161 asks for.

The key is read once, at start: replacing the files takes a restart. List the certificate you replaced in
`datum.pdf.signing.retired_certificates` or `datum.tsa.retired_certificates`, so the seals and tokens it made still
verify as the server's own. `pdf_signer` and `tsa_key_material` replace the file readers when the key lives in an HSM or
a vault.

### Outbound HTTP

The only outbound HTTP call is the PDF module's request to a named timestamp server (`datum.pdf.signing.tsa.url`). It goes
through a `TsaTransport`: one POST answered with the status, the content type and the bytes. The default is built on the
standard library, never follows a redirect (a bearer token or Basic credential goes only to the URL named), honours
`HTTPS_PROXY` (an `http://` proxy URL; an `https://` one is not supported) and `SSL_CERT_FILE`, and bounds the reply
(1 MiB) and the wait (`datum.pdf.signing.tsa.timeout`). Pass `tsa_transport=` to replace it, or a whole `timestamper=` to
replace the client. A transport that says it follows redirects is refused at construction.

### Time source

RFC 3161 asks a timestamp authority whose clock it cannot trust to refuse with `timeNotAvailable`. Datum's server reads
"now" through a `TsaTimeSource`: `read()` answers `Reading.available(instant)` or `Reading.unavailable(reason)`. The
default wraps the `now` clock and is always available. While a source answers unavailable, `POST /tsa` answers **503**
with a `TimeStampResp` (status rejection, failure info `timeNotAvailable`, the reason as its status text), no key is used
and no serial taken, `TimestampRefusedEvent` carries the failure, and the `tsa` health component is down with
`time: unavailable (reason)`. A source that raises counts as unavailable, its message going to the log only. The reason
reaches clients, so keep hostnames and addresses out of it. Datum ships no NTP client; a source that checks the system
clock against a reference and refuses above a drift is a few lines over a cached value a background task refreshes:

```python
from datum_core.timestamp import Reading


class DriftCheckedTime:
    def __init__(self) -> None:
        self._last = Reading.unavailable("not checked yet")   # a background task refreshes it

    def read(self) -> Reading:
        return self._last

datum = Datum(config=config, tsa_time_source=DriftCheckedTime())
```

### The timestamp server in context

No Python library packages an RFC 3161 server. `argusvane-datum-core[timestamp]` builds the DER with `asn1crypto` and signs with
`cryptography`. Datum's authority is for self-contained deployments and for receipts; a qualified or audited service
means `datum.pdf.signing.tsa.url` pointed at a commercial timestamp authority, or at a deployment you run.

## Lifecycle and hooks

`Datum` starts and stops with the application's lifespan. Every router a factory builds carries `lifespan=datum.lifespan`,
and `include_router` merges it into the application's lifespan once per inclusion. The lifespans share one reference-counted
entry (`datum_core.aio.AsyncLifecycle`): the first entry starts `Datum` off the event loop (the runtime compiles its guest),
later entries only count, and the last exit drains the calls in flight within `datum.runtime.shutdown_grace`, has the
runtime interrupt what is left, and stops it. `async with datum:` is the same entry by hand: for your own lifespan, for a
Starlette parent of `datum.asgi_app()`, for a queue consumer and for tests. One `Datum` serves one event loop at a time;
loops that follow each other are fine.

The start, in order: the resource distributions agree on one build id; the start checks (budget clamp, store policy,
router switches, memory against the container's limit, process zone; ERRORs are raised together, the rest is logged on
`datum.checks`); the form repository (a bad file stops the start naming it) and, with assets on, the asset catalog; the
runtime (the engine selected, the sandbox composed, the ABI proof once, the smoke and warm-up runs); the services, then
only while `datum.tsa.enabled` the timestamp authority and only while `datum.pdf.enabled` and something asks for it the
PDF service; then `DatumRuntimeReadyEvent`. A configuration the start refuses stops it whatever `fail_fast` says; any
other failure to bring the runtime up raises with `fail_fast` (the default), or leaves the start done with the `runtime`
health component down and the routes answering 503 until `Datum.recheck()` (`POST /recheck`) brings it up. A PDF program
that fails its proof leaves PDFs unavailable (`pdfUnavailable` on the `runtime` health) and everything else working.
A failed start undoes what it built.

Until a lifespan has entered, every router answers 503 `server.unavailable` and logs one ERROR naming the composition
(`datum_fastapi.lifespan.COMPOSITION_ERROR`, or `START_FAILED_ERROR` when a start was tried and failed). On a privileged
router the application's `dependencies` run first and the guard second, so an unauthenticated caller meets its own 401
before any 503 and never learns the server's state.

**What a route lets happen.** `DatumRoute`, the route class every Datum router uses, maps whatever a route raises, in
this order: an `HTTPException` (your dependency's 401 or 403) passes through untouched; a client that left mid-upload ends
the request with no answer and no log; an `AnswerError` is written as it carries; anything else goes to your
`error_translators` in order, then to Datum's table (a bad path or query parameter is 400 `bad_request`, a hook's refusal,
a busy or closed engine, a sandbox error), and last answers 500 `internal`, logged with the correlation id. No handler is
registered on the application and no middleware added.

| Kind | When | May | Raises |
|---|---|---|---|
| `*_customizers` (ordered list) | before the engine or the store is asked | change a typed draft in place, or refuse with `HookRefusedError`; never the ABI, the op, the program or the identity (a form's `id` and `version`) | anything else fails the request |
| `validators`, `*_validators` (ordered list) | after the engine answered, before the effect | see the verdict; add errors (refuse) or warnings (ride along) as `HookFindings`; or refuse at once with `HookRefusedError` | anything else fails the request |
| `handler` (one) | the effect | store, deliver, issue | |
| events | after the effect | observe; never veto | a listener's failure is logged, never the request's (see "Events") |
| stores, providers, key material, clocks, time sources, transports | wherever the capability needs them | be replaced by yours | |

`HookRefusedError` (`datum_core.hooks`) is the one typed refusal: `forbidden(code, message)`, `conflict(code, message)`,
`invalid(code, message)` or `invalid([HookProblem, ...])`, each `HookProblem` a `(field, code, message)` with a code of
letters, digits and `. _ : -`, starting with a letter. Its kind is what a transport answers: on the routes `forbidden` is
**403**, `conflict` **409**, `invalid` **422**, with the errors body `{"errors": [{field, code, message}]}` (one entry per
problem; in problem-details mode the first problem's code is `code`). A capability with its own 422 shape answers its
problems in that shape (the builder's `definition.refused`); the timestamp server, whose wire is RFC 3161, answers any
kind as a `badRequest` rejection. A non-HTTP caller reads `kind` and `problems`.

### Forms: `GET /forms/{key}/definition`

```
key -> form (FormDefinitionRepository) / version (DefinitionSnapshotStore) -> DefinitionCustomizer* -> kernel public copy (Sandbox) -> 200 | 304
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| the key (`id`, or `id@version`), the form, the version | `FormDefinitionRepository`, `DefinitionSnapshotStore` | 404 `form.notFound` |
| customize (the public copy only) | `DefinitionCustomizer` | its kind: 403, 409, 422; a throw, or a changed `id` or `version`, 500 `internal` |
| the kernel's public copy of what the customizers left (server-secret rules removed, whoever added them); asked only when the definition carries a server-secret rule | `Sandbox` | 503 `server.unavailable` for a form with secret rules while the runtime is down; 422 `definition.tooDeep` |
| the effect | | 200 with the `ETag` of the bytes served and `Cache-Control: datum.forms.cache.definition` (`no-store` by default); 304 for a matching `If-None-Match` |

The route has no `public` parameter: it serves the public copy only, and a request whose `public` parameter is `false`
(percent-decoded, case-insensitive) is not matched by it. The author's copy (server-secret rules included, whose `ETag` the builder's `If-Match`
names) is served by `routers.builder`, behind its `dependencies`; without that router the query is the application's own
404.

A `DefinitionCustomizer` sees a `DefinitionDraft`: the `DefinitionRequest` (form key, the stored version's hash, current
or by hash, the principal, the locale `Datum(locale=...)` resolved) and a copy of the stored definition to change in
place. Never customized: the author's copy and the definition a submission is judged against (the stored one: a customizer
that hides a required component must make the submission side agree, or the hidden answer is refused). The public copy is
cached by the stored hash and each customizer's `cache_key(request)`, or not at all when one answers `None` or has no
`cache_key` (so a customizer's copy is made per request until it declares a key); a cached copy is used only when its
customized definition is the one this request's customizers left, so a key that names too little serves a fresh copy (with
a warning), never another request's. The translations and data-source reads have no customizer: the catalog's `ETag` is the
store's and the builder writes it back with `If-Match`.

### Builder: `PUT /forms/{key}`, `POST /forms`

```
dependencies -> existence (404) -> media type (415) -> size (413) -> If-Match (409) -> JSON (400) -> read-only (501) -> shape and id (422) -> language changes (400) -> finite numbers (422)
  -> BuilderSaveCustomizer* -> the same rules again -> kernel check -> BuilderSaveValidator* -> store under the form's lock -> FormDefinitionSavedEvent -> 200 | 201
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| existence (save), the media type, the size, the precondition | `FormDefinitionRepository` | 404 `form.notFound`, 415 `unsupported_media_type`, 413 `bad_document`, 409 `form.outdated` (current `ETag`) |
| strict JSON, the repository is writable, the shape, the id, the language changes, finite numbers | | 400 `bad_document`, 501 `forms.readOnly`, 422 `definition.refused` (`definition.id.mismatch`, `definition.id.invalid`, `definition.number.nonFinite`), 409 `form.exists` (create) |
| customize | `BuilderSaveCustomizer` | `invalid`: 422 `definition.refused`, each problem a finding; `forbidden` 403, `conflict` 409 with the errors body; a throw, or a changed `id`, 500 `internal` |
| the kernel's check | `Sandbox` | 422 `definition.refused` (the kernel's codes), `definition.tooDeep`, `definition.tooCostly`; 503 `server.unavailable` |
| validate (every validator, the verdict in `BuilderSaveCandidate`) | `BuilderSaveValidator` | errors: 422 `definition.refused`, every error a finding; a `HookRefusedError`: its kind; a throw: 500 `internal`. Warnings ride in the 200 |
| the store | `FormDefinitionRepository`, `TranslationCatalogStore`, `DefinitionSnapshotStore` | 409 `form.outdated` (raced) |
| the effect | | 200 (201 with `Location` for a create), the `ETag` of what was stored: the customized definition |

Only `If-Match` is read: an absent one and `*` are the unconditional save. A create has no existence step and no
precondition. The default repository is read-only, so the builder needs a writable one (`MemoryFormDefinitionRepository`
for development, or your own `WritableFormDefinitionRepository`): `create` and compare-and-set `replace` return `None` on
a refusal, never an exception. The same hooks run for `BuilderService` callers outside HTTP. The translations write
(`PUT /forms/{key}/translations`) takes the catalog bare or as `{"catalog": ...}` against the catalog's `ETag` and has no
hook. Every builder answer is `Cache-Control: no-store`. A write is one tracked call of the runner (the hooks, the
kernel's check, the store, the saved event), so a client that leaves after the body was read cancels nothing.

### Submissions: `POST /submissions`, `/submissions/validate`, `/submissions/test`

```
admission (415) -> address limit (429) -> body (413, 400) -> size and shape of the document -> throttle -> pre-check -> definition and version -> idempotency
  -> journey -> context (ContextContributor*, HostContextProvider, HostOptionsCustomizer*, RulesProvider*)
  -> option snapshot -> sandbox
  -> signature slot -> validators -> handler -> idempotency told -> events
```

A delivery's body is `{document, submissionKey}`: the document and the key the page mints once per submit attempt and
sends again on a retry (`datum-submit`'s `detail.submissionKey`; the shared glue posts it). The key matches
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (a version 4 UUID fits). A body without one, and the bare document, are 400
`bad_document`; the size cap is measured first (413). The test route takes the same wrapper and ignores the key; a bare
envelope is 400 `bad_document` there too. The validate route takes `{document, scope}` and, for a page check, `pageId`:
`scope` (`journey` or `page`) is required, `pageId` is required with `page` and refused with `journey`, and a body with
no `scope`, or the bare envelope, is 400 `bad_document`. Its 200 is `{accepted, errors}`, `errors` holding the blocking
entries only (`{field?, code, message?}`), plus `notes` (`{field?, code, severity, message?}`, `warning` or `info`,
`message` only when the sandbox or a validator gave one, as on an error; a validator's warnings are notes too) only when there are any:
the member is absent, never `[]`. An error entry (a 422 of submit, the 200 of validate) carries the
`message` the sandbox gave the item when it is non-empty text, and none otherwise; a hook's finding is its own entry with
its own message, so the two never merge. A run that gives no verdict is no verdict on all three routes, on the PDF routes
and on inspect: 503 with the run's code (`wasm.execution_error`, `outcome_too_large`, `definition.tooDeep` of the
registered form) and no `Retry-After`, since the same run fails the same way. Only a busy sandbox, 503 `server.busy`,
carries `Retry-After`; `server.unavailable`, `validator_unavailable` and `data_source.unavailable` carry none. A submitted
document too deep or malformed is 400 `bad_document`; a definition posted to inspect that is too deep is the caller's
422 `definition.tooDeep`, refused before any run.

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission | | 415 `unsupported_media_type` (only `application/json`) |
| address limit (before the body is read) | `throttle` (Datum's own only) | 429 `flood` with `Retry-After` |
| body | | 413 `bad_document`, 400 `bad_document` (also a delivery with no usable `submissionKey`) |
| throttle (not the PDF dry run) | `throttle` | 429 `flood` with `Retry-After` |
| pre-check (every mode) | `pre_checks`, `pre_check_statuses` | the `Reject`'s own code, with the status the mapping names (403 for every code by default, `access.denied` included); a mapping that throws or answers no refusal: 500 |
| definition and version | `form_repository`, `snapshot_store` | 404 `form.notFound`, 409 `form.outdated` |
| submission key (a delivery) | `idempotency_store` | a key accepted before with the same digest: 200 with the first receipt (`handled: true`), no run and no handler; with another digest: 409 `submission.keyConflict`, before the document is judged, whatever it holds |
| journey (validate's checks) | | 200 `{accepted: false, errors}` (`journey.required`, `journey.unknown`); 400 `bad_document` for a check that names no page of the journey |
| context customize | `host_options_customizers`, `rules_providers`, `context_contributors`, `host_context` (each takes the `SubmissionContext`) | an ordinary exception: 503 `validator_unavailable` (customizer, contributor), 503 `server.unavailable` (rules provider, host-context provider, option snapshot); a host context that is not a JSON object within the bounds: 503 `server.unavailable`; a `HookRefusedError`, a `DatumError` or a configuration error is raised as it is; a customizer that sets a `RunSettings` word the program does not read fails as a throw does (never a quiet default) |
| sandbox | `sandbox`, `sandbox_middleware` | 422 `submission.rejected` with the kernel's errors (validate: 200 `{accepted: false, errors}`); 503 `server.busy` with `Retry-After`; 503 `server.unavailable`, `wasm.execution_error`, `outcome_too_large`, `definition.tooDeep` with none, on every route |
| validators | `validators` | errors: 422 `submission.rejected`; a throw: 503 `validator_unavailable` |
| the effect | `handler` | 200 `{id, reference, status, digest, ...}`; the idempotency store is then told the key, digest and receipt |
| events | `SubmissionValidatedEvent`, `SubmissionRejectedEvent`, `SubmissionRedeliveredEvent`, `SubmissionThrottledEvent`, `JourneyCheckedEvent` | |

`HostOptionsCustomizer` and `RulesProvider` take the same `SubmissionContext` as the other hooks (channel, principal,
client address, user agent, the request's headers without `Authorization`, `Proxy-Authorization` and `Cookie`, the body's
SHA-256), whatever the channel. The same service answers a signed wrapper with 503 `signing.not_set_up`, because the
signature slot takes only `None` (see the table above). The dry run (`POST /submissions/test`) runs every stage up to the handler
and answers one flat report; it keeps nothing, publishes no event, and counts under the `test` throttle kind, as does
`POST /inspect`. The report is the same object on every Datum host, with these members in this order:

| Member | Type | Holds |
|---|---|---|
| `outcome` | `"accepted"` or `"rejected"` | whether a delivery would be accepted |
| `stage` | string or null | where a rejection happened (`journey`, `sandbox` or `server`); null when accepted |
| `errors` | array | every finding in the order found, each `{field, code, message, severity, stage, source}` with all six members always present (null where unknown, `severity` `error` when none was given); warnings and info sit here beside the blocking errors, and an accepted document can list some; a validator's findings come last with `stage` and `source` `server` |
| `sent` | object | the answers as sent |
| `values` | object or null | what the run kept; null when it kept none or never ran |
| `clientDerived`, `clockDependent`, `serverRules`, `visibilitySkipped` | arrays of strings | component ids, empty when none apply or no run happened |
| `document` | string or null | the canonical text that was digested; null when no run happened |
| `digest` | string or null | its SHA-256 in hex; null when no run happened |
| `logs` | array | the run's log entries, empty when none |
| `sandbox` | object or null | `{elapsedMs, rules, unknownFields, logLevel}`: the run's wall time in milliseconds (one decimal), the ids of the rule modules it loaded, and its two words; null when no run happened |
| `signature` | null | no signature check is wired, so always null |

There is no `accepted` member (read `outcome`), no `notes` member (a warning is an entry of `errors` with its
`severity`) and no nested `report`: the run's time is `sandbox.elapsedMs`. A journey refusal happens before any run, so
its report holds the findings and `sent` and null or empty for the rest. `SubmissionService.test` returns
`DryRun(accepted, stage, errors, values, report)`: `errors` there are the blocking findings only, and `report` is this
object.

The idempotency store is asked before the document is judged and told after the handler, with no lock held between (none
holds across instances): two deliveries in flight may both reach the handler, so a handler is idempotent on its attempt's
key and never on `digest`, which two people who give the same answers share.

### The host context

A rule can read a fact about the visit instead of an answer: `host.role`, `host.region`. The server judges those rules
only with values it works out itself, never with anything in the body (the envelope does not carry the page's
`hostContext`, and a `hostContext` member beside the document is 400 `bad_document`). `Datum(host_context=...)` takes one
provider, `(form_key, SubmissionContext) -> Mapping | None`, sync or async. It is asked once per judged call (submit,
validate, test and the PDF routes' check), after the idempotency step, so a retried attempt keeps its first verdict and
asks nothing. Its answer goes to the run as `hostContext` (sandbox ABI 4.1.0), to the handler as
`AcceptedSubmission.host_context`, and to the PDF the call prints (`render_submission` uses the submission's own).

Read the person from the context's `principal`, which your `principal` dependency answers from the request:

```python
from fastapi import Request
from datum_fastapi import Datum

def current_user(request: Request) -> object | None:
    return getattr(request.state, "user", None)  # or request.user, or the session

def host_context(form_key: str, context) -> dict[str, str] | None:
    user = context.principal
    return {"role": user.role} if user is not None else None

datum = Datum(principal=current_user, host_context=host_context)
```

`None` (the default, or a provider's answer) supplies no context: every rule that reads `host.` is left unjudged, as
before. An object, even `{}`, judges every such rule, and a name it lacks has no value. A provider that raises, or that
answers something the sandbox cannot take as JSON (not an object, a key that is not text, `NaN`, a set, deeper than 64
levels below a key, more than 1,000,000 values), is the application's bug: 503 `server.unavailable` (no `Retry-After`),
logged on `datum.submissions` with the reason and never the values, and no verdict. A `HookRefusedError` answers its kind.
`datum_core.testing.fixtures` holds the contract form (`datum-host-context`) and a TEST-ONLY provider that reads the role
from the `X-Datum-Test-Role` header; never wire it into a deployment people use.

### PDF: `POST /pdf`, `/pdf/fill`, `/pdf/sign`

```
dependencies -> admission (415) -> address limit (429) -> body (413, 400) -> throttle (429) -> PDFs available (503) -> the receiver's dry run in PDF mode (422)
  -> the layout -> pdf_request_customizers -> PDF program (pdf_middleware) -> pdf_result_validators -> seal (PdfSigner, Timestamper) -> PdfRenderedEvent -> 200 application/pdf
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission, address limit, throttle, availability | `throttle` | 415, 429 `flood` (the address limit, before the body is read), 413, 400 `bad_document`, 429 `flood`, 503 `server.unavailable` / `server.busy` (only busy carries `Retry-After`) |
| the answers | the receiver's pre-checks and validators (PDF mode) | 422 `submission.rejected`, the pre-check's own code; a run that gave no verdict: 503 `wasm.execution_error`, `outcome_too_large` or `definition.tooDeep`, no `Retry-After` |
| the layout | | 404 `layout.notFound` (a layout id the definition lacks, or a template whose source is not inline base64), 400 `layout.notTemplate` (a fill of a layout that is not a template) |
| customize | `pdf_request_customizers` | its kind: 403, 409, 422; a throw: 500 `internal` |
| the program | the PDF kernel (`pdf_middleware`) | its refusal by its word: 404 `layout.notFound`; 422 `template`, `render_limit`, `unknown_component`, `conformance` or `attachment_budget`; 500 `signature` for a seal it would not make; any other word 500 `internal`; a run that gave no answer: 503 `wasm.execution_error` or `outcome_too_large`, no `Retry-After` |
| validate (every operation that answers PDF bytes, before any seal) | `pdf_result_validators` | errors: 422 with the errors body (the first error's code); a `HookRefusedError`: its kind; a throw: 500 `internal` |
| seal | `pdf_signer`, `timestamper`, `pdf_trust_policy` | 500 `signature`, with no message, for a layout that requires a seal the server has no key for, a signing handoff that is not over the prepared file or names another algorithm than the signer's (refused before the key signs), a signer with no certificate, a signer that raises (its exception stays in the `datum.pdf` log), or a value of no shape the program takes; a failed timestamp is a `sealing.timestamp` warning |
| the effect, events | `PdfRenderedEvent` | 200 `application/pdf` with `X-Page-Count`, `X-Datum-Layout`, `X-Datum-Pdf-Theme` (the PDF theme the route's binding suggests, when it suggests one; a render call's or a layout's own theme still outranks it in the drawing), `X-Signed-By`, `X-Signature-Field` |

A refused PDF costs no signature, no timestamp and no serial, and announces no `PdfRenderedEvent`. The body of the three
printing routes is `{document, layoutId?}` (`layoutId` is required for a fill); `POST /pdf/verify` takes the raw
`application/pdf` bytes up to `datum.runtime.verify_max_bytes` and answers the verify report: each signature with its
trust word, the document id, the warnings and the policy. A file that is not a PDF is 400 `pdf.notAPdf` (it costs no
throttle check and no run), an unreadable one 400 `pdf.unreadable`. `GET /server/certificate` answers the server's chain
as PEM text, 404 `certificate.notFound` without a key.

Which key seals: `render` and `fill` of posted answers use the throwaway "Datum test seal" unless
`datum.pdf.seal.posted_answers` is true and the server has a key; `render_submission` (an accepted submission, called from
your handler) uses the server's key and never the test seal; `sign` uses the server's key whatever the seal settings say
and answers 503 `server.unavailable` before anything runs when there is none. The routes `render`, `fill` and `sign` run
the application's `dependencies` first; `verify` and the certificate are public (they never run your `principal`
dependency, so their throttle key is the client address alone).

### Timestamp server: `POST /tsa`

```
cookie (403) -> media type (415) -> client key (401) -> failed-key lock and flood (429) -> size (413) -> query -> customizers -> time source -> serial -> sign -> log -> TimestampIssuedEvent -> 200
```

The admission gate runs on the headers before the body is read, and a refusal before the service is plain text. The
media type is `application/timestamp-query` (or the older `application/timestamp-request`); the reply is
`application/timestamp-reply`. The client key is a Bearer token or the password of a Basic credential, matched by its
SHA-256 against `datum.tsa.clients` (or your client store); no key, an unknown one and a revoked one are the same 401
with a `WWW-Authenticate` challenge. A wrong key presented counts toward `datum.tsa.flood.failed_keys` per address (an IPv6 client is counted by its /64
prefix); past it the address is 429 for the rest of the window, and a right key is never locked out. Imprints are SHA-256, SHA-384 or
SHA-512. A rejection is a DER `TimeStampResp` (400, or 503 with `Retry-After`: the timestamp server writes its own DER answers, outside the JSON answer table) whose text echoes no request byte, no header,
no cookie and no key. Every answer is `Cache-Control: no-store`. `GET /tsa/certificate` answers the signing chain as PEM, leaf first
(`?format=der` answers the leaf alone as `application/pkix-cert`) and `GET /tsa/certificates` the current chain and then the
retired certificates, all PEM.

### Web: every route

Request bodies are read as a counted stream, so a chunked body cannot pass the cap; the strict JSON reader refuses
non-finite numbers, a lone surrogate, nesting past 256 and numbers of more than 1000 characters (a duplicate key: the last
wins, as `JSON.parse` does), and every parse refusal is 400 `bad_document`. Refusals never echo the body. Every refusal is
`{"errors": [{"field"?, "code", "message"?}]}` or, with `datum.web.api.problem_details`, RFC 9457 `application/problem+json`
with `type`, `title`, `status`, `detail`, `code`, `correlationId` and `errors`. A 500 carries no field or message.

## Using the engine without HTTP

The services under the routes are framework-free, and a queue consumer, a batch import or a CLI can call the same ones the
routes call. In an asyncio program, enter `Datum` and use the async faces; each call is one tracked task of the runner, so a
cancelled caller does not cancel the effect:

```python
from datum_core.submissions import Accepted, FormRef, SubmissionContext, Unavailable

async with datum:
    context = SubmissionContext(channel="bus", submission_key=message_id)   # the broker's message id is the attempt's key
    outcome = await datum.async_submissions.submit(FormRef.from_document(), document, context)
    if isinstance(outcome, Unavailable):
        ...   # retry later
```

The consumer in [the submissions example](../integrations/fastapi/examples/submissions/consumer.py) reads a message with
`datum_sandbox.json.read` (the strict reader), dead-letters what is not JSON, and retries `Unavailable`.

| Face | Methods |
|---|---|
| `datum.async_definitions` | `read(key, *, public, sha256, principal, locale)` |
| `datum.async_translations` | `read(key)` |
| `datum.async_data_sources` | `items(DataSourceRequest)` |
| `datum.async_submissions` | `submit`, `validate`, `test`, `inspect` |
| `datum.async_builder` | `save`, `create`, `save_translations` |
| `datum.async_timestamps` | `issue`, `answer` (only while `datum.tsa.enabled`) |
| `datum.async_pdf` | `render`, `fill`, `sign`, `verify`, `render_submission`, `certificate_chain` (only while `datum.pdf.enabled`) |

A call outside the lifespan raises `AnswerError` carrying the 503 `server.unavailable` answer. The outcomes are frozen
dataclasses with no status and no header; a caller closes the union with `match` and `assert_never`. For submissions they
are `Accepted(receipt, submission, warnings)`, `Redelivered(receipt, digest)`, `KeyConflict`, `Rejected(errors, stage)`,
`Checked`, `DryRun`, `Outdated`, `NotFound`, `Malformed`, `TooLarge`, `Throttled(retry_after)`, `Refused`, `Unavailable`.
`datum_core.http` turns an outcome into the answer a route writes (`submission_answer`, `builder_answer`, `pdf_answer`,
...), for a transport of your own.

From a program with no event loop, use `datum_core.Datum` (the same object without the FastAPI parts) and the sync
services. `start()` and `stop()` are synchronous and take seconds (the runtime compiles its guest), so a framework binding
calls them off its loop:

```python
from datum_core import Datum
from datum_core.submissions import FormRef, SubmissionContext

datum = Datum(config=config, handler=keep)
datum.start()                       # async hooks need start(awaiter=...)
try:
    outcome = datum.submission_service.submit(FormRef.from_document(), document, SubmissionContext(channel="batch", submission_key=key))
finally:
    datum.stop()
```

The services of a `Datum` that has not started raise `DatumNotStartedError`. `datum.sandbox` is the composed `Sandbox`
(`validate`, `inspect`, `check`, `public_copy`, `smoke`, `prove_abi`); it raises while the runtime is down. The sync
services run on the caller's thread and hold a run slot while they run: from async code use the async faces.

Mounted under another ASGI parent, `datum.asgi_app()` returns a FastAPI sub-application holding the forms and submissions
routers (and the assets router when assets are on) with no OpenAPI document or docs page of its own. A `Mount` forwards no
lifespan, so the parent's lifespan writes `async with datum:`. The privileged routers are not in it: include them in the
application that owns the authentication.

```python
@asynccontextmanager
async def lifespan(app):
    async with datum:
        yield

parent = Starlette(routes=[Mount("/forms", app=datum.asgi_app())], lifespan=lifespan)
```

## Events

Typed, frozen, slotted records delivered after the effect they report, one at a time, in the order the listeners were
given (`EventDispatcher`): published on the worker thread that ran the call, inside the call (so the shutdown drain waits
for them), before the answer leaves. Datum opens no transaction: an event published inside your transaction precedes its
commit. A listener cannot veto anything. A listener that raises is logged on `datum.events` with its traceback and delivery
goes on; `MemoryError` and everything that is not an `Exception` (cancellation, `SystemExit`) propagates. A listener on a
base class sees its subclasses, so one listener on `DatumEvent` is a bus.

```python
from datum_core import listener
from datum_core.submissions import SubmissionValidatedEvent

def audit(event: SubmissionValidatedEvent) -> None:
    log.info("accepted %s over %s", event.submission.form_key, event.channel)

datum = Datum(config=config, listeners=[listener(SubmissionValidatedEvent, audit)])
```

| Event | Published |
|---|---|
| `DatumRuntimeReadyEvent` (`engine`, `sandbox_abi`, `pdf_abi`, `warm_up_millis`) | once per start, after the ABI proof and the warm-ups, from the thread that ran the start |
| `SandboxRunInterruptedEvent` (`program`, `reason`, `elapsed`) | when the runtime stops a run (`budget`, `memory`, `trap`, `output-cap`, `interrupted`); the caller still gets the refusal |
| `SubmissionValidatedEvent` (`submission`, `receipt`, `channel`) | after the handler answered and the idempotency store was told; none when the handler raised |
| `SubmissionRejectedEvent` (`form_key`, `errors`, `stage`, `remote_address`, `channel`) | when a delivery is refused at `journey`, `sandbox` or `server` |
| `SubmissionRedeliveredEvent` (`form_key`, `digest`, `receipt`, `channel`) | when a delivery is answered with the first receipt of its attempt |
| `SubmissionThrottledEvent` (`key`, `kind`, `retry_after`, `channel`) | when the throttle refuses a call |
| `JourneyCheckedEvent` (`form_key`, `journey_id`, `page_id`, `accepted`, `channel`) | after every validate check that reached a verdict |
| `FormDefinitionSavedEvent` (`key`, `sha256`, `previous_sha256`) | by the builder once a definition is stored, after the form's lock is released (two saves may publish out of order; `previous_sha256` orders them) |
| `TimestampIssuedEvent` (`serial`, `gen_time`, `imprint_algorithm`, `client`) | once a token is made and logged; the client is the store's id, never the key |
| `TimestampRefusedEvent` (`fail_info`, `reason`) | when the authority answers a rejection |
| `PdfRenderedEvent` (`form_key`, `op`, `bytes`, `layout_id`, `signed`, `timestamped`) | once a PDF is made and sealed; scalars only |
| `PdfVerifiedEvent` (`sha256`, `size`, `document_id`, `signatures`, `trust_policy`) | after a verify report is made |

A dry run publishes no submission event. No event carries answers, definition text, a key, a certificate or a file.

## Observability

Datum reports through the OpenTelemetry API only: it creates no provider, installs no exporter and no logging handler, and
never calls `basicConfig`. With no SDK configured every call is a no-op; the tracer and meter are acquired at import under
the name `datum`, so an application that configures OpenTelemetry after importing Datum still sees every span and metric.
Configure the SDK and, if you want a server span per request, FastAPI's telemetry or the ASGI instrumentation as usual:
Datum's spans become children of the request's, and a request has exactly one server span in either configuration.

| Span | Around |
|---|---|
| `datum.submission` | one call of the submission service (`datum.mode`, `datum.channel`, `datum.outcome`, `datum.form`, `datum.stage`) |
| `datum.sandbox.run` | one call of the sandbox, the innermost layer (`datum.program`, `datum.op`, `datum.engine.mode`, `datum.outcome`) |
| `datum.pdf` | one call of the PDF service (`datum.pdf.op`, `datum.outcome`, `datum.pdf.seal`, `datum.pdf.timestamp`, `datum.form`) |
| `datum.pdf.run` | one call of the PDF kernel |
| `datum.tsa.issue` | one token (`datum.channel`, `datum.outcome`) |

| Instrument | |
|---|---|
| `datum.sandbox.run.duration` (histogram, s) | wall time of a run, by program and outcome |
| `datum.sandbox.run.wait.duration` (histogram, s) | the wait for a slot |
| `datum.sandbox.run.active` (up-down counter) | runs in progress |
| `datum.sandbox.run.rejected` (counter) | calls refused because no slot came (`datum.reason=busy`) |
| `datum.sandbox.slot.limit` (gauge) | run slots of the runtime |
| `datum.submission.received` (counter) | deliveries answered, by status and form |
| `datum.request.throttled` (counter) | calls the throttle refused |
| `datum.pdf.output.size` (histogram, By) | size of the PDF a call answered |

Attributes are `datum.`-prefixed and carry no answer, byte, digest, address or secret. A refused or rejected submission is
a normal outcome (span status unset); the error status and `error.type` mark an infrastructure failure only.

**Correlation.** A request is named in the logs by the `datum.web.api.correlation_header` value when it matches
`[A-Za-z0-9._-]{1,64}`, else by the current trace id, else by 12 random hex digits. In problem-details mode it is the
`correlationId` of an error body. A 500 is logged with it and its body says nothing else.

**Logging.** Datum installs no handler. The loggers are `datum.sandbox` (the guest's run log), `datum.events`,
`datum.checks` (the start checks, with `datum_check_id` on the record), `datum.runtime`, `datum.submissions`,
`datum.forms`, `datum.builder`, `datum.pdf`, `datum.tsa`, `datum.assets` and `datum.web` (the binding: a 500, a failed
response write, a failing translator). `extra` keys on records are prefixed `datum_`.

**Start checks.** Every finding has a stable id, a message and a hint, logged on `datum.checks` at its level. The
warnings and info lines can be silenced by id in `datum.silenced_checks`; an ERROR is never dropped.

| Id | Level | Meaning |
|---|---|---|
| `datum.I001` | info | the routes that are on |
| `datum.I002` | info | a PDF timestamp client URL or credentials unused beside the application's `timestamper` |
| `datum.W001` | warning | a router was included and every switch it reads is off |
| `datum.W002` | warning | slots times memory (every worker) exceeds the container's limit less the resident set |
| `datum.W003` | warning | the default logging submission handler is in use |
| `datum.W004` | warning | a per-process store in memory |
| `datum.W006` | warning | a data-source provider keeps the default `exists` |
| `datum.W007` | warning | an unknown `DATUM_*` environment variable |
| `datum.W008` | warning | a runtime budget clamped to its bound |
| `datum.W009` | warning | a timestamp trust-state memory store acknowledged |
| `datum.W010` | warning | the process time zone could not be read; UTC is used |
| `datum.W011` | warning | the PDF seal asks a timestamp and nothing can issue one |
| `datum.W012` | warning | a PDF timestamp policy unused beside the application's `timestamper` |
| `datum.W013` | warning | the PDF seal is on and the server has no signing key |
| `datum.E001` | error | a timestamp trust-state store in memory and not acknowledged |
| `datum.E002` | error | the builder on with in-memory stores and more than one worker |
| `datum.E003` | error | runtime memory below the module's initial pages |
| `datum.E004` | error | the runtime did not start within `datum.runtime.startup_budget` |
| `datum.E005` | error | a shared throttle storage and no `datum.web.throttle.key_salt` |
| `datum.E006` | error | the throttle storage cannot be built (a missing client library, an unusable URI) |

### Health and info

`routers.management(datum, dependencies=[...], prefix="")` mounts the probes:

| Route | Answers |
|---|---|
| `GET /livez` | 200 with no body while the process answers. Public |
| `GET /readyz` | 200 with no body when the `runtime` component is up, else 503; 503 before the lifespan and after its exit. It reads that component alone, so another component's problem never fails it. Public |
| `GET /health` | the flat report `{status, components: {name: {status, details}}}`: 200 when every component is up, else 503 with the report. Behind your `dependencies` |
| `GET /info` | the flat info body: Datum's version, the two ABIs, the build id, the engine, and the capabilities (store kinds, builder, assets, throttle, idempotency, timestamp server). Behind your `dependencies` |
| `POST /recheck` | on `datum.web.management.recheck`: re-proves the sandbox (the ABI and a smoke run) or, when the runtime is down, builds it again; answers the report. Behind your `dependencies` |

The probes answer while a runtime that failed to start is down. Components are `runtime` (engine, release, mode,
`pdfCapable`, the two ABIs, and `slots`, `slotsInUse`, `runsInFlight`, `stuckRuns`, `strayRuns`; `pdfUnavailable` says why
PDFs are off), `stores.snapshots`, `stores.translations`, `stores.throttle` (kind, `perProcess`, `degraded`),
`stores.idempotency`, and, when they apply, `stores.forms` (the builder on), `tsa` and `pdf`. A contributor of your own is
one function registered on the object:

```python
from datum_core import ComponentHealth

datum.health_registry.register("billing", lambda: ComponentHealth.up(queue=depth()))
```

Contributors run on the event loop and must be cheap, `() -> ComponentHealth`; one that raises or answers anything else is
reported down. Health never carries a path, a key, a certificate or a password.

## OpenAPI

The routes carry explicit operation ids and the catalog's responses, so the application's own document describes them:
tags `datum-forms`, `datum-submissions` (the dry run and inspect too), `datum-ui` (the builder), `datum-pdf`,
`datum-tsa` and `datum-management`. Pass `FastAPI(openapi_tags=DATUM_OPENAPI_TAGS)` for their descriptions
(`openapi_tags(prefix)` follows a different `datum.web.openapi.tag_prefix`). Every operation documents the shared error
body, a `default` response (so FastAPI does not add its own 422; Datum answers a bad parameter as 400 `bad_request`), and
`429` on a POST that takes a body. With `datum.web.api.problem_details` the error content type is
`application/problem+json`. `datum.web.openapi.enabled=false` leaves the Datum routes out of the document. The asset
routes, the author's copy and the group documents are never in it. A test holds the documented routes to the endpoint
catalog, so a document that disagrees with the code fails.

With `datum.web.openapi.group_documents`, each router also serves its own document at `{prefix}/openapi/{factory}.json`
(`forms`, `submissions`, `authoring`, `builder`, `pdf`, `tsa`), generated over that router's routes alone, with the
factory's own prefix. The route is hidden from the application's schema and answers the application's own 404 when the
application has no OpenAPI URL. The builder's and authoring's documents describe routes the application guards, so they
answer `Cache-Control: no-store`.

## The page glue

`datum-host.js` is a small module served beside `host.json` (`{assets}/datum-host.js`, `{assets}/host.json`). The
application writes its own pages and sets every element attribute itself (see the
[attribute reference](reference/attributes.md)); the glue only saves the plumbing:

```html
<script type="module" src="/datum/assets/datum-host.js"></script>
<script type="module">
  await DatumHost.load({ bundle: 'form' });            // imports datum-form.js from the versioned path
  DatumHost.submit(document.querySelector('#f'));
</script>
```

`DatumHost.load` reads `host.json` (build id, assets base, API base, CSRF names) once; `submit` posts each accepted
submission to `{api}/submissions` with the CSRF header and shows the receipt or the refusals; `dataSources` builds the
loaders for `{api}/data-sources/{id}`; `builder` wires a `<datum-form-builder>` to the definition and save endpoints
(story three). `DatumHost.config` and `DatumHost.csrfToken` expose the parts. `host.json` is `no-cache`; everything under
the build id is `immutable`. Its body is `{buildId, assetsBase, apiBase, csrf: {headerName, cookieName, metaName},
bindings, paths?}`, with `assetsBase`, `apiBase` and each `paths` entry including the request's `root_path`, so a
mounted or proxied application publishes working URLs. `paths` names the base of each capability router the
application built (`tsa` for `routers.tsa`, at its `prefix`) and is left out when none was. FastAPI serves no passkey
routes, so `paths` has no `webauthn` entry and `DatumHost.passkeys()` is refused unless the page passes `{endpoint}`. `routers.assets(datum, api_prefix="/api")` names the API base the glue posts to.

### How the files are served

The versioned files (`{assets}/{build_id}/{path}`) are served by a real route, never `StaticFiles`. The request path is only
ever a key of a dictionary the start built from the distributions' file lists (`AssetCatalog`); it is never joined to a
directory, decoded again or normalised, so `..`, a percent-escape, a backslash or a case trick names nothing. A path that
is not a key, or a key under another build id (a stale page after a deploy gets a 404 that no cache keeps), is the
framework's 404. The answer is the file with a strong `ETag` (the manifest's SHA-256), a media type from an explicit table
(never the platform's registry), `Cache-Control: public, max-age=<cache_period>, immutable`, and 304 for a matching
`If-None-Match`; `HEAD` gets the headers. Three kinds of file are never in the dictionary:

- the builder's files while `datum.builder.enabled` is off,
- the files of an omitted feature (`datum.web.assets.omit_features` and the manifest's list), and
- any path your `withheld_assets` callable withholds (compared case-folded).

Feature tokens: `journeys`, `print`, `translations`, `data-sources`, `drafts`, `server-validation` (alias `validate-url`),
`signing` (alias `webauthn`), `pdf`, `wasm`, `agent`, `logic`, `data`, `languages`, `variables`, `header-footer`,
`data-model`, `palette`, `try-it`, `tests`, `json`, `binding-picker`, `advanced-fields`, `pdf-pages`. The `pdf` and
`pdf-pages` tokens name the whole PDF assets distribution. The asset directory must be a real directory: a zipped
install (a zipapp, an egg) is refused at start, because the route serves files by path.

## Building from source

The resource distributions and every package's `datum-build.json` are generated from the repository's built bundles, and the
build guard refuses any build, including an editable install, until they exist. From the repository root:

```sh
npm run datum:build
npm run fastapi:assets
cd integrations/fastapi && uv sync --all-packages --all-extras --frozen
```

`npm run fastapi:assets` writes each distribution's files into its project directory (`argusvane-datum-programs`, `argusvane-datum-assets-ui`,
`argusvane-datum-assets-pdf`, `argusvane-datum-qjs-wasm`, and the page glue into `argusvane-datum-fastapi`), a `manifest.json` and a `datum-build.json`
that carry the one build id, the `NOTICE` files, the published settings schema, and the test fixtures under
`integrations/fastapi/build/fixtures/`. A dist that is missing or older than its sources is refused. The pinned
`qjs-wasi.wasm` is fetched and held to the SHA-256 in `argusvane-datum-qjs-wasm/runtime.json`.

| Option | |
|---|---|
| `-- --allow-stale` | build from a dist older than the sources |
| `-- --omit-features=pdf,journeys` | leave out the files of these features; recorded in the manifest. `DATUM_WEB__ASSETS__OMIT_FEATURES` names the same tokens at run time |
| `-- --qjs-wasm-file <path>` | take `qjs-wasi.wasm` from this file (an air-gapped build), still held to the pin |
| `-- --dry-run` | print the allocation table and write nothing |

Run one member's tests with `uv run --frozen --no-sync --package argusvane-datum-core pytest packages/datum-core` from
`integrations/fastapi`, or every member with `npm run fastapi:test` from the repository root. Static checks run from
`integrations/fastapi`: `ruff check .`, `mypy packages`, `pyright`, `lint-imports` and `deptry .` inside each member. The
Python version pinned in `.python-version` is the one CI uses; the distributions support Python 3.12 and later.

## Fixed by contract

What is not a setting, and why. Each row is a floor the wire, the ABI or a security contract pins: a setting that moved it
would make the answer differ between hosts or reopen a hole the suites close. The contract is named so the number can be
traced; every one is held by a test in the library that applies it and by the conformance suites
(`packages/conformance-suite` and `datum-host-check`).

| Fixed value | Where | The contract that pins it |
|---|---|---|
| a run's stdout 32 MiB and stderr 64 KiB | `datum_sandbox.wasi` | the frame protocol and the hardening port (a 40 MiB answer is refused) |
| an outcome of at most 8 Mi UTF-16 units | `datum_sandbox.protocol` | the `outcome_too_large` code in the error catalog |
| answer JSON nested at most 512 deep; component depth 32, raw definition depth 256 | `datum_sandbox.protocol` | security suite DEF-06 (`definition.tooDeep`) |
| a 16-byte run nonce from `secrets`; the guest globals removed | `datum_sandbox.protocol` | the frame protocol (a forged outcome is refused) |
| sandbox ABI 4.1.0 (floor 4.1.0, the first that reads `hostContext`), PDF ABI 4.0.0 (floor 4.0.0) | the programs in `argusvane-datum-programs` | the programs' ABI and the golden answers; a program that does not answer for the floor is refused at start |
| the bounds of every `datum.runtime.*` budget (time, memory, slots, wait, body) | `SandboxSettings.build` (the bounded record is `ProgramLimits`) | the documented clamps (a validation run is at most 60 s, a PDF run 300 s, 64 slots, a wait of 0 to 10 s) |
| SHA-256 for the canonical digest | `datum_core.canonical` | the digest contract (`canonical.json`, the JCS vectors) |
| JSON bodies nested at most 256 deep, numbers at most 1000 characters, only `application/json` | `datum_sandbox.json`, `datum_core.http` | the wire hardening vectors of the security suite (SEC-*) |
| a form key of 1 to 128 letters, digits, dots, hyphens or underscores (`id@version` names a version) | `datum_core.forms.keys` (the one rule every route and service asks) | the URL segment |
| a submitted document nested at most 64 deep | `SubmissionService` | security suite REC-04 |
| at most 10,000 components, 2000 options a component and 50,000 in all, 200 problems, a 64-character version | `datum_core.builder.shape` | the builder contract |
| a translation catalog of at most 10,000 entries, 64 locales of change, 16 KiB of text, 190 characters of key, 12 levels | `datum_core.builder.catalog` | the translations contract |
| PDF slots `min(2, CPUs)` by default and a wait of at most 10 s | `ProgramLimits` | the PDF pool and the 503 `server.busy` contract |
| a verify request names at most 64 certificates of 16 KiB | `datum_core.pdf.request` | the PDF program's caps |
| the seal key rules: RSA PKCS#1 v1.5 (2048 bits or more) or ECDSA P-256/P-384, SHA-256; an ECDSA value as DER or raw `r\|\|s` | `datum_core.pdf.signer` | the PDF program's `pdf.sign` |
| imprints over SHA-256, 384 or 512 only; a stated accuracy of at most 60 s; the media types | `datum_core.timestamp` | RFC 3161 and the timestamp contract |
| the timestamp certificate rules | `TsaCertificateRules` | RFC 3161 section 2.3 (`id-kp-timeStamping`, critical) |
| a stop grace of 5 s by default and `max(2, CPUs)` stray runs; a read-only `/app` and no environment for the guest | `datum_sandbox.wasi`, the wasmtime runtime | the engine kit (`WasiHardeningContract` and the runtime and hardening contracts) |

The development stores (`MemoryTsaLog` 1000 rows, `InMemoryTsaFlood` 50,000 keys), the self-signed development certificate,
the correlation header's 12-hex fallback and the English wire messages (an `error_translator` rewrites them) are
conveniences, not contracts, and are not settings either.

## Engines

The programs run in QuickJS compiled to WebAssembly, and a WebAssembly *engine* runs it in your process. Everything about
running them lives in `argusvane-datum-sandbox` (`datum_sandbox`), which any Python framework can use without the rest of
the host; **wasmtime is the only engine** (`argusvane-datum-sandbox-wasmtime`, which the `submissions` extra brings).

**The layers.** `datum_sandbox.wasi` is the generic hardened WASI run and imports only the standard library: a run is a
`GuestRun(app_files, argv, stdin, budget)` (the files become the only ones under a read-only `/app`; a bare string for
the arguments and a file name that is not one plain name are refused), a `GuestRuntime` runs it and answers a `RunResult`.
`datum_sandbox.protocol` is the Datum run protocol on top (the program store, `run.js` and the nonce frame, the strict
answer reading, the ABI gate, `SandboxService`, `PdfKernelService`). `datum_sandbox.runtime` holds `SandboxSettings` and
`DatumSandbox`, the lifecycle `Datum` uses (see "Using the sandbox without the host" below).

**The SPI.** An engine distribution registers a `GuestRuntimeProvider` in the `datum.guest_runtimes` entry-point group
(`datum_sandbox.wasi.GROUP`), under the name equal to the provider's `id`. A provider has an `id`, an `availability()`
(`Available(notes)` or `Unavailable(reason)`: can its native code load here) and `create(limits: EngineLimits,
engine_settings: EngineSettings)`, which builds the runtime (blocking: it runs off the event loop). `EngineLimits` names
the pools and their slots (`validation` and `pdf` for Datum), the work directory, the clock tick, the common and the
largest run memory, and an own guest module. The runtime reports an `EngineInfo` (id, the engine's release, its mode,
notes), which health, `/info` and `DatumRuntimeReadyEvent` carry, and may name the pools it serves (`pools`): the PDF
program runs only on a runtime that serves the PDF pool and whose report answers (`pdfCapable` in health).
`GuestRuntimes.discover()` lists what is installed (a provider whose import fails is listed as broken and never hides the
others) and `select(id)` picks one.

**Selection.** The sandbox selects by `datum.runtime.engine` (default `wasmtime`) through the installed entry points; no
class name is configured and nothing is imported by a string you write. An id no distribution has, an unavailable engine,
a broken one, or two distributions claiming one id raise the engine layer's `EngineSelectionError`, which the sandbox turns
into a `DatumConfigurationError` with the same words: it stops the start whatever `datum.runtime.fail_fast` says (a
configuration error, not a program to prove later). Passing your own `runtime=` to `Datum` skips the selection.

**What an engine implements.** The engine-neutral half of a run is `datum_sandbox.wasi.RunHarness`: one worker thread per
run, the stop at the time budget, a fresh private run directory holding only the run's files, the bounded stdout and
stderr, the bound on stopped runs that outlive their grace, the reading of how a run ended, and (for a run that asks) its
timings. An engine implements only `GuestEngine`: wire the run's streams, arguments, entropy and directory into its WASI
layer, instantiate the module under the budget's memory limit without starting it, call `_start`, and say what its own
exceptions mean (an exit with its code, a trap, an interrupt, a memory end). Its refusals are the WASI layer's own
(`EngineConfigurationError`, `MemoryFloorError` for a memory below the module's floor), which the sandbox translates once
(the floor is `datum.E003`).

**The engine kit.** `datum_sandbox.testing` (the `testing` extra) holds the contract classes an engine's own tests
subclass against its `GuestRuntime`:

| Contract | Holds the engine to |
|---|---|
| `WasiHardeningContract` | the generic run alone, with an inline `run.js` and no Datum program: only the given files under a read-only `/app`, no environment, stdin as given, the output cap with every byte up to it, the time and memory budgets, the stop at close |
| `RuntimeContract` | the private read-only `/app` and nothing reachable outside it, every way a run ends with the started marker kept, the output caps, a loop stopped at its budget and the next run answering, a host interrupt, parallel streams, many runs stopped at once, shutdown |
| `SandboxHardeningContract` | the sandbox hardening through `SandboxService`: a stale program refused by the ABI probe, a rule module that cannot forge an outcome, rebind the kernel or write outside the frame, the output cap, the depth guard, the loop, memory and recursion stops, the smoke run |
| `GoldenVerdictsContract` | the golden outcome byte for byte and the control verdicts |
| `PdfRenderContract` | the documents rendered to their pinned hashes (for an engine that serves the PDF pool) |

```python
class TestMyRuntime(WasiHardeningContract, RuntimeContract, SandboxHardeningContract, GoldenVerdictsContract, PdfRenderContract):
    capabilities = RuntimeCapabilities()          # what the engine lacks, with reasons

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]: ...

    @pytest.fixture
    def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]: ...
```

The runtime under test is built with at least 16 validation slots; tests marked `runtime` never run under pytest-xdist
(`skip_runtime_under_xdist(config, items)` from your conftest does the skip).

### The wasmtime engine

`argusvane-datum-sandbox-wasmtime` runs the pinned quickjs-ng guest (`qjs-wasi.wasm`, from `argusvane-datum-qjs-wasm`) on
[wasmtime-py](https://github.com/bytecodealliance/wasmtime-py) under the sandbox's run harness, and imports only
`datum_sandbox.wasi`.

- **At start, once per process.** It imports wasmtime (an unsupported platform is refused by name), re-hashes the guest
  against the pin (or `datum.runtime.qjs_path` against `qjs_sha256`), builds one `Engine` (epoch interruption on, fuel off),
  compiles one `Module`, links WASI once and instantiates one throwaway store, so an address-space refusal stops the start
  rather than the first run. Compiling takes about half a second to 1.4 s on a laptop and 4 to 7 s on a 1-vCPU Linux VM:
  raise `datum.runtime.startup_budget` on a small host. The `Datum` start runs it off the event loop and reports the
  runtime as down until it returns.
- **One store per run**, created, run and closed on the run's worker thread: a memory limit of the run's budget, one
  instance, memory and table, an epoch deadline derived from the wall budget, the private run directory preopened
  read-only as `/app`, stdin from a sibling file, no environment.
- **One epoch clock thread** (`datum-epoch-clock`) advances the engine's epoch every `datum.runtime.tick`. A looping guest
  ends within two ticks of its wall budget; there is no timer per run.
- **Sleeps end at the budget.** The epoch cannot interrupt a guest waiting inside a host call, and a rule module can reach
  `os.sleep` and `os.setTimeout`. The runtime therefore replaces the one WASI import that waits, `poll_oneoff`: a clock wait
  is cut to the run's remaining wall budget and woken by its stop, so a sleeping run ends at its budget with no stuck run
  and no stray thread.
- **How a run ended.** A plain return (or exit 0) is clean; an exit has its code; a trap is read by its code (the interrupt
  is the wall budget). The engine reports `memory` only when the guest's memory ended at the store's limit; QuickJS's own
  `InternalError: out of memory` below the limit, like the same words thrown by a rule, is an exit the sandbox reads as a
  throw.
- **One harness per pool, one `run()`.** A run's `RunBudget.pool` (`validation` or `pdf`) picks its slots over the same
  engine; a pool the limits did not name is refused.
- **Shutdown.** `close()` refuses new runs, marks every run in flight interrupted, advances the epoch past every armed
  deadline, waits the stop grace and stops the clock. Interrupted runs end as `interrupted` and answer 503
  `server.unavailable`. The application's own drain (`datum.runtime.shutdown_grace`) comes first.

A run that does not end within its wall budget plus the stop grace ends as `stuck`: its caller is answered as the budget
stop it is (503 `wasm.execution_error`), and its thread is counted as a stray that keeps its slot until it ends. At the
stray bound new runs are refused with 503 `server.unavailable` and no `Retry-After`: a runtime that could not stop its
guests is a fault, not a queue to wait in. The trace and the capture record such a refused run as `unavailable`.
`server.busy` is only a slot wait that expired.

**Platforms.** wasmtime-py ships native libraries for 64-bit Linux (glibc and musl), macOS and Windows on x86_64 and arm64;
the requirement's environment marker installs wasmtime only there. Elsewhere `pip` can install the `py3-none-any` wheel,
which carries only the Windows library, and `import wasmtime` fails with a bare `OSError`: Datum turns that into the
start-up refusal naming the platform and `platform.machine()`, and the provider reports itself unavailable. On Alpine and
other musl systems the wheel needs `libgcc_s.so.1`:

```dockerfile
FROM python:3.12-alpine
RUN apk add --no-cache libgcc
```

**Versions.** wasmtime-py releases a major about monthly; the distribution allows one tested major at a time (`>=50,<51`).

### The resource distributions

`argusvane-datum-programs` (the sandbox and PDF programs, the freeze snippet, DejaVu Sans, Serif and Mono with their licence, and
`programs.json` with each file's SHA-256), `argusvane-datum-qjs-wasm` (the guest), `argusvane-datum-assets-ui` and `argusvane-datum-assets-pdf` (the
browser files) carry no Python code. Each has a `datum-build.json` with the one build id; the start refuses a mix. The
programs are held to their digests, and a program you point `datum.runtime.programs.sandbox` or `.pdf` at is still proved by
the ABI probe before any run.

## Diagnostics

Three tools, none able to change a run's answer, all framework-free (`datum_sandbox.diagnostics`).

**The run trace** (`datum.runtime.diagnostics.trace`): `off` (the default), `failures` or `all`. One INFO line per run on
the logger `datum.sandbox.trace`:

```text
run=5c1f0e9a2b3d program=sandbox op=validate abi=4.1.0 engine=wasmtime mode=cranelift slotWaitMs=0.0 prepareMs=0.4 instantiateMs=1.9 startMs=6.2 totalMs=9.1 termination=clean exit=- outcome=verdict stdinBytes=812 stdoutBytes=301 stderrBytes=0 capture=-
```

The fields keep that order; every text value is reduced to letters, digits, `.`, `_` and `-`. A line carries lengths,
never an answer, the definition or the run's nonce. A failed run is every outcome but `verdict` and `refused` (the
program's own refusal, which includes a probe the program does not answer for); a PDF answer the protocol refuses after
the run, and an answer with no structure, is `no_outcome`. A run refused for a busy slot, or before it was made (a
definition too deep, input that is not JSON, a stopping runtime), makes no line.
`Datum(trace=...)` takes any `(TraceRecord) -> None` instead of the log line. With the trace and the capture off, no run
is measured.

**The settings report** (`datum.runtime.diagnostics.report`, on by default): at start, before the programs are proved, one
INFO block on `datum.sandbox.settings` names every `datum.runtime.*` and `datum.host.*` value with where it came from
(default, configured, clamped from a value to its bound, or replaced by a seam you passed), the engine's release, mode and
notes, and each program's sha256 and ABI. `Datum.explain()` answers the same report, and the management router's `/info`
carries it as JSON under `settings`, and in `/info` and the health details an absolute path inside the engine's notes is
shown as `<path>`. A URL's user information (`user:password@`, up to the last `@`), its query values and its fragment values
are masked everywhere.

**The failed-run capture** (`datum.runtime.diagnostics.capture.*`, off by default) keeps, for each failed run,
`stdin.bin`, `stdout.bin`, `stderr.bin`, `run.js` and a `meta.json` (the trace fields, the program's sha256 and ABI, the
engine and the settings report; never the run's nonce, which rides only on the stdin it was sent on), in
`<directory>/<UTC yyyymmdd-hhmmss>-<run id>/`. Those files hold the submitted answers and the form definition in clear
text: the start logs one WARN while it is on, and you turn it off after
debugging.

```sh
DATUM_RUNTIME__DIAGNOSTICS__TRACE=failures
DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__ENABLED=true
DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__DIRECTORY=/var/lib/myapp/datum-captures
```

- The directory must be a real directory (not a link) owned by the process's user with mode 0700, and on macOS carry no
  access-control entry (`chmod -N <dir>`, and none inherited from its parent). A missing one is created 0700. Anything else
  stops the start naming the setting; Windows is refused (no POSIX permissions to check). The checks run again before every
  write.
  The macOS check asks `/bin/ls -lde` (an absolute path, no shell, `--` and the directory as one argument, a timeout, bounded output) and refuses on a `+` in the
  mode column or any entry line; a check that cannot run, or whose answer does not parse, refuses too (it fails closed).
  The directory is opened once (`O_DIRECTORY | O_NOFOLLOW`) and every file is made through that handle, so a path swapped
  after the open is never followed, and before each write the handle and the path are checked again (the same device and
  inode, the same owner, no group or other bit, no ACL). The owner is the owner of a probe file the sink creates there, the
  effective user.
- Files are created 0600, exclusively and without following a link (`O_CREAT | O_EXCL | O_NOFOLLOW`), synced, and written into `.partial-<id>`, which is renamed to `<id>` once complete.
- `max_runs` (20) and `max_bytes` (64 MiB) bound what is kept, the oldest going first (by name, never the capture just
  written; a capture removed by hand only leaves the count, and one whose removal fails is skipped for the next oldest, so
  the bounds still hold); a bound below 1 refuses the build of the settings; `queue_bytes` (64 MiB) bounds what
  waits to be written. A capture that does not fit is dropped and counted (`captureDropped` in the `runtime` health, with a
  WARN a minute at most); a write that fails is counted (`captureFailed`). A run never waits for the capture.
- Eviction renames `<id>` to `.evict-<id>` before deleting it and touches only directories named like captures. A `.partial-*` or `.evict-*` left by a crash is never removed for you; the start WARN counts them.
- One daemon writer thread per start, with its own queue. Whatever a sink, a trace or a recorder raises is logged by class
  (an `OSError`'s message carries a path, so it is never logged), and only an interrupt or an exit (`KeyboardInterrupt`,
  `SystemExit`, `GeneratorExit`) goes on. A start refuses while an earlier writer for the same destination is still alive
  (the writer closes the sink as it exits). A start that fails drains its capture within the shutdown grace too, so the
  failed runs that made it fail are kept.
- The names come from the capture id alone (a UTC time and a random run id) and hold no request text. The `runtime` health
  component is the same as without a capture apart from `captureDropped` and `captureFailed`, present while it is on.
- `Datum(capture_sink=...)` takes a `RunCaptureSink` of your own (an object store); the bounds, the queue and the one writer
  thread still apply.

## Using the sandbox without the host

`argusvane-datum-sandbox` needs no framework and no `Datum`: `DatumSandbox` is the lifecycle `Datum` uses.

```python
from datum_sandbox import DatumSandbox, SandboxSettings

settings = SandboxSettings.build(validation_time_limit=2.0, trace="failures")
with DatumSandbox(settings) as sandbox:
    result = sandbox.sandbox.validate(context, real=False)
    print(sandbox.status().details["engine"], sandbox.explain())
```

`SandboxSettings.build` takes the keys by their keyword names (`validation_time_limit`, `capture_max_runs`) and clamps
them exactly as the settings do; `datum_sandbox.aio.AsyncDatumSandbox` awaits the same calls from an event loop. What it
cannot clamp refuses the build with a `DatumConfigurationError` naming the key: a diagnostics word that is none of the
three, a capture bound below 1, a clock tick or a start-up budget below 1 ms, a digest with no module path, a host word
(`unknown_fields`, `log_level`, `formula_errors`, `risky_patterns`) that is none of its words, and a memory below the guest module's floor when the floor is known before the start (`datum.E003`; the clamp never lifts it to pass). The report shows the resolved
slot count beside a concurrency of 0.

`start()` opens the capture, selects or adopts the engine, logs the settings report, composes the sandbox over the packaged
program, proves the ABI, warms up, and then composes and proves the PDF kernel while the PDF program is on. `stop(deadline=)`
takes one `time.monotonic` deadline (the shutdown grace from now when none is given): the engine's runs end within the stop
grace and the capture drains in what is left. `explain()` returns the settings report, and the `sandbox` and `pdf_kernel`
properties are the composed services. The seams are `compose_sandbox(own, replacement=, middleware=, observation=)` and
`compose_pdf_kernel(...)`: Datum's observation wraps the service first, then the middleware from the last entry to the first,
so the first entry is outermost; `HostOptions` and `ProgramLimits` (the bounded budgets) are the values a host hands in.

## Memory and pool guidance

**One runtime per process.** Every worker process of a server (`uvicorn --workers N`, gunicorn, one per container) compiles
its own module and holds its own run slots. State the count in `datum.workers_expected` (or leave `WEB_CONCURRENCY`, which is
read as a hint): the memory check and the builder's shared-store rule multiply by it.

Each validation or PDF run is one QuickJS instance in a fresh store under the run's memory limit. A container's memory should
cover roughly: workers times (slots times the per-run memory limit, plus about 2.7 MiB per live run, plus the process's own
resident memory). The defaults are 5 s and 32 MiB for validation (slots: one per CPU) and 60 s and 256 MiB for PDFs (slots:
the smaller of 2 and the CPUs). At start the runtime compares slots times the memory budgets (every worker) with the
container's memory limit (cgroup v2 `memory.max`, else v1 `memory.limit_in_bytes`, else the host's RAM) less the resident
set, and logs `datum.W002` when every slot full at once would not fit (the kernel would stop the process with no Python
error). Lower `datum.runtime.validation.concurrency`, `datum.runtime.pdf.concurrency` or the memory budgets, raise the
container memory, or state `workers_expected`. A request that cannot get a slot within `wait` answers 503 `server.busy` with
`Retry-After`; slots above the number of CPUs buy nothing.

**Worker threads.** The binding bounds the threads that run calls with a limiter of `datum.runtime.worker_threads`
(default `2 * slots + 2`, slots being the validation plus the PDF slots). It counts runs plus in-flight hooks: blocking work
on a worker thread (sync stores, the timestamp client, a sync handler) counts as hook time. Size it as
`slots + ceil(slots * hook_time_on_thread / run_time) + 2` (`datum_core.aio.size_worker_threads`). A call that gets no thread
within `datum.runtime.validation.wait` answers 503 `server.busy` instead of queueing out of sight.

**Address space.** wasmtime's defaults reserve 4 GiB plus a 64 MiB guard region per linear memory, whatever the guest uses:
eight run slots then need about 33 GB of address space and fail under `ulimit -v`, in address-space-limited containers and
on hardened hosts. Datum sets a guard of 0 and a reservation of the validation memory cap (rounded up to whole 64 KiB
pages) plus growth room up to the PDF memory cap, built from the two caps the runtime is created with. A run whose budget
is above that room is still limited to its budget, but its store moves to a new reservation as it grows, and the runtime
logs one warning on `datum.runtime` the first time it happens: build the runtime with the largest budget you give as
`pdf.memory`. Measured on Linux x86_64:

- address space about 50 MiB, plus per validation slot (validation memory + 1 MiB), plus per PDF slot (PDF memory +
  validation memory + 1 MiB) while PDF runs are live;
- resident memory about 35 MiB on Linux (about 100 MiB on macOS) with the compiled module, plus per live run 2.7 MiB plus
  what the guest uses.

When the throwaway store at start cannot reserve its memory, wasmtime says `mmap failed to reserve ...`, and the start is
refused naming `datum.runtime.validation.memory` (or `.pdf.memory`), the bytes asked for and the address-space limit
(`ulimit -v`).

**Start time.** Compiling the guest takes seconds on a small VM. The `Datum` start runs off the event loop, so the server
keeps accepting connections and every Datum route answers 503 `server.unavailable` until it returns; a readiness probe on
`/readyz` is the right gate for a load balancer. A synchronous compile cannot be cut short: when the start passes
`datum.runtime.startup_budget` it reports `datum.E004` at the next phase boundary and undoes what it built, and the process
is expected to exit on that error.

## Security notes

- **Who may call a route is the application's.** Datum ships no access policy: a route that is switched on is open until
  your dependencies say otherwise. The public factories (`forms`, `submissions`, `assets`) take an optional
  `dependencies=`; the privileged ones (`management`, `authoring`, `builder`, `pdf`) require it, so leaving a route
  unprotected is `dependencies=[]` in your source. The timestamp router takes none: the server has its own client-key
  rule. On a privileged router your dependencies run before Datum's own guard, so a caller you refuse gets your 401 or 403
  before any existence check, body read or kernel run, and never learns the server's state.
- **`access_errors(datum)`** is the opt-in handler that gives your own 403 the catalog's `access.denied` body, so one client
  code path reads every refusal: `FastAPI(exception_handlers=access_errors(datum))`. Only 403 is mapped (the catalog has no
  401 row; its `WWW-Authenticate` challenge is yours); the headers your exception set are kept.
- **The author's copy and the builder.** The definition with its server-secret rules is reachable only through
  `routers.builder`, behind its dependencies; the public route never serves it, whatever the `public` parameter's spelling.
  Without the builder router `?public=false` is the application's 404. The builder's files are withheld from the asset route
  while `datum.builder.enabled` is off. Put an author-only dependency on `routers.builder`; nothing else decides who builds.
- **CSRF.** The endpoints accept `application/json` only (415 otherwise), so a plain cross-site form post cannot reach
  them, but FastAPI has no CSRF protection of its own and Datum adds none. If your application adds one, the glue reads the
  token from the `XSRF-TOKEN` cookie (or a `<meta name="_csrf">`) and sends it as `X-XSRF-TOKEN`; set `datum.web.csrf.*` to
  the names your protection uses and `host.json` tells the glue. The timestamp server refuses a request that carries a
  cookie (403, `datum.tsa.session_cookies`) so a browser cannot be made to ask it.
- **The client address is `request.client`.** A spoofable `X-Forwarded-For` never reaches a throttle key. Behind a proxy,
  let the ASGI server decide what `request.client` is (uvicorn's `--proxy-headers` and `--forwarded-allow-ips`). Hooks are
  handed the request's headers except `Authorization`, `Proxy-Authorization` and `Cookie`: the principal is the identity.
- **The guest is boxed.** Rule modules and the programs run in WebAssembly with no environment, a private read-only `/app`,
  bounded output, a time and memory budget, a fresh run nonce that a forged outcome cannot guess, and the guest's globals
  removed. A run whose outcome is not the framed answer is refused. A run's text never reaches a response: a failure is a
  code, and the engine's words go to the log only.
- **Secrets stay out.** Passwords, tokens and keys are `SecretStr`s, hidden from `repr`, dumps and validation messages; a
  URI with credentials prints with its user-info replaced; a `ThrottleKey` keeps the address and principal out of its
  `repr`; throttle storage keys are salted HMACs, so a storage dump names no caller; no event, outcome or log record
  carries definition text, a rule's source, a digest of a refused body or a principal; a 500 carries no field or message.
- **Signing keys** are read once and used through `sign`; they are never exposed, copied or pickled. Replacing one takes a
  restart (see "Signing keys"). The self-signed timestamp certificate (`datum.tsa.signer.self_signed`) is for development.
- **Mounted applications.** `datum.asgi_app()` holds only the public routers; the privileged ones belong to the
  application that owns the authentication.

## Rate limiting

The default throttle is a fixed window over [`limits`](https://limits.readthedocs.io): `datum.web.throttle.limit` requests per
`window`, counted per `by` (the client address and the form by default, an IPv6 client by its /64 prefix, one bracketed IPv6
literal such as `[2001:db8::1]` as the address inside; add `principal` to count a signed-in person apart).
`LimitsThrottle` counts the kinds `submit`, `validate`, `test` (the dry run and inspect) and `pdf` (render, fill, sign and
verify) apart, each with the limit in `limits.<kind>` or the shared `limit`. A refused call is 429 `flood` with `Retry-After`
(whole seconds, at least 1) and publishes `SubmissionThrottledEvent`. `datum.web.throttle.enabled=false` turns it off.

The address limit (`datum.web.throttle.address_limit`, default 600) is checked first, after the `Content-Type` check and before the body is read, on every throttled route. It counts the client address alone, so a flood of bodies that never parse, or name a different form each time, is refused with the same 429 `flood` and `Retry-After`. Its counters have their own key space in the same storage; `None` or `off` turns it off. Only Datum's own throttle keeps it.

| `datum.web.throttle.storage` | Counted |
|---|---|
| `async+memory://` (default) | in this process, in Datum's own capped storage (`max_keys`; a new key past the cap first drops the expired windows, and when none has expired a sixteenth of the live ones goes, one at a time from the caller (the address and principal, every part of the key but the form) holding the most windows, its window of the fewest attempts first and the newest among equals; so one address naming many forms evicts its own one-attempt windows before its full one and never another caller's while it holds more; this fails open: an attacker with as many addresses as windows can restart other callers' counters, and no caller is ever locked out); each worker counts alone, so N workers allow N times the limit, and a restart forgets them (`datum.W004`) |
| `async+redis://...` or any other `limits` storage | in the shared storage, awaited through `limits.aio`, never on a thread; `datum.web.throttle.key_salt` (at least 32 bytes, the same on every worker) is required, or the start stops (`datum.E005`); a missing client library or an unusable URI stops it too (`datum.E006`, naming the failure's class, never its words) |

The storage key is `datum:throttle:<kind>:`, the HMAC-SHA-256 of the chosen components under the salt, `:` and the
HMAC-SHA-256 of the same components but the form (the caller the capped storage evicts by), so the address is never in
a key. A storage failure **fails open**: the request is allowed, the failure is logged once per window naming the class, and the `stores.throttle` health component shows `degraded`. A counter outage must not take the form down.

A throttle of your own is any object with `check(ThrottleKey) -> Allow | Deny(retry_after)` (or the `async` form), passed as
`throttle=`; it then ignores `limits.<kind>`, the storage settings and the address limit (it counts no address before the read). `ThrottleKey` carries `ip`, `form_key`, `principal`,
`kind` and `channel`. A caller with no address and no principal (a queue consumer that gave none) is not counted.

The timestamp server has its own floor: `datum.tsa.flood.limit` tokens per window per client, `failed_keys` wrong keys per
address before a 429 (`Retry-After` is the rest of the window), and a request size cap, all in the process (the `tsa` health
component says `flood: memory (per process)`). The body caps (`datum.web.api.max_body_size`, `datum.builder.max_definition_size`,
`datum.runtime.verify_max_bytes`, `datum.tsa.max_request_size`) are counted on the stream before anything is parsed.

## The forms files

`datum.forms.locations` is a list of paths and glob patterns that the default repository reads **once, eagerly, at start**,
in order, each location's files sorted by path. A path is relative to the working directory or absolute; `*`, `?`, `[...]`
and `**` work in a segment; a location with no wildcard names one file. `package:<pkg>/<glob>` reads from an installed
package's resources, for a form bundled in a wheel. Each file is one JSON definition (read with the strict bounded reader);
its string `id` is the form's key (1 to 128 letters, digits, dots, hyphens or underscores, no `@`). A file that is not a
JSON object, has no `id`, repeats another file's `id`, or is unreadable stops the start naming it (one line per problem);
a location that matches nothing, or a directory that cannot be read, is a warning on `datum.forms`.

The locations are read only when forms are served (`datum.web.api.endpoints.definition` or `datum.builder.enabled`), so a
deployment that only validates posted documents loads no form. A changed file takes a restart. The repository is read-only:
the builder's saves need a `WritableFormDefinitionRepository`, which you seed from the same files:

```python
seeds = [json.loads(path.read_text("utf-8")) for path in sorted(Path("forms").glob("*.json"))]
datum = Datum(config=config, form_repository=MemoryFormDefinitionRepository(seeds))
```

Without one, the builder's writes answer 501 `forms.readOnly`.

## Testing your application

A test of an application that uses Datum is a test of FastAPI: build the app, enter the lifespan, call it. Starlette's
`TestClient` as a context manager runs the router lifespans, so `Datum` starts once for the block; the runtime is real
(compiling the guest takes a second or more), so share one app across the tests of a module:

```python
@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    datum = Datum(config=DatumConfig(forms={"locations": ["forms/fixture-form.json"]}, web={"api": {"endpoints": {"definition": True, "submissions": True}}}), handler=keep)
    app = FastAPI()
    app.include_router(routers.forms(datum))
    app.include_router(routers.submissions(datum))
    with TestClient(app) as client:
        yield client
```

To test without the engine, hand `Datum` a `runtime=` (any `GuestRuntime`: `run(GuestRun)`, `engine_info`, `close`) or a `sandbox=`;
the binding's own tests do both. Install the `testing` extra for the helpers below.

| In `datum_core.testing` | For |
|---|---|
| `IdempotencyStoreContract`, `FormRepositoryContract`, `SnapshotStoreContract`, `TranslationStoreContract`, `TsaSerialAllocatorContract`, `TsaLogContract`, `TsaClientStoreContract` | holding a store of your own to its protocol: subclass the contract in your test module and override the one fixture (`store`, `allocator`, `log`, `store_factory`); the cases use only the protocol, including the races of eight threads and the compare-and-set rules |
| `RuntimeContract`, `SandboxHardeningContract`, `GoldenVerdictsContract`, `PdfRenderContract`, `RuntimeCapabilities` | holding an engine to the runtime contract (see [Engines](#engines)) |
| `skip_runtime_under_xdist`, `skip_openssl_under_xdist`, `requires_openssl`, `openssl_binary` | the markers: a `runtime` test never runs under pytest-xdist, an `openssl` test skips with a reason when there is no binary (`DATUM_OPENSSL` names another) |
| `datum_core.testing.otel.in_memory_sdk()` | the process's one in-memory OpenTelemetry SDK (span exporter and metric reader) for observation tests; it needs the SDK of the `testing` extra |
| `datum_core.testing.tsa_pki.build_pki()` | a throwaway timestamp PKI (EC and RSA chains, a wrong-usage leaf) for timestamp tests; needs the `timestamp` extra |
| `datum_core.testing.fixtures` | the programs, fonts and conformance fixtures from `argusvane-datum-programs` and the asset build (`DATUM_TEST_FIXTURES` names another directory) |
| `datum_core.testing.hypothesis_profiles.load_default()` | the `dev` (50 examples) and `ci` (500, no deadline) Hypothesis profiles |

The OpenTelemetry API allows one provider per process, so every helper installs through `in_memory_sdk()`; a second
`set_tracer_provider` would be ignored and an exporter hung on it would see nothing.

### The host test kit

The wire contract of every endpoint is checked by `datum-host-check`, a Node command in the conformance suite
(`packages/conformance-suite`, [Host conformance](conformance-suite.md#host-conformance-datum-host-check)): the gate every
Datum host runs. It needs only Node 22 and the built kit (`npm run build` in the package), and works against any deployment:

```sh
datum-host-check fixtures --out kit/
export DATUM_FORMS__LOCATIONS='["kit/fixture-form.json"]'
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true DATUM_WEB__API__ENDPOINTS__VALIDATE=true
export DATUM_WEB__API__ENDPOINTS__TEST=true DATUM_WEB__API__ENDPOINTS__DEFINITION=true
export DATUM_WEB__ASSETS__ENABLED=true DATUM_WEB__THROTTLE__LIMIT=30 DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200
uvicorn app:app --port 8000 &
datum-host-check --endpoint http://localhost:8000 --capabilities submissions,submissions-test,forms,assets,flood
```

What each capability needs from the application under test:

| Capability | Setting |
|---|---|
| `submissions`, `forms`, `assets` | the kit's fixture form in `datum.forms.locations` (`datum-host-check fixtures --out <dir>` writes `fixture-form.json`) |
| `submissions` | `datum.web.api.endpoints.submissions` and `.validate` (every route is opt-in) |
| `forms` | `datum.web.api.endpoints.definition` |
| `assets` | `datum.web.assets.enabled` and `routers.assets(datum)` included |
| `submissions-test` | `datum.web.api.endpoints.test`, with `routers.authoring(datum, dependencies=[...])` included |
| `builder` | `datum.builder.enabled`, a writable repository, and `routers.builder(datum, dependencies=[...])` with a dependency that lets the test person build and refuses the others (401 or 403, any body); the kit names the form a person may build (`--build-form`) |
| `pdf` | the `pdf` extra, `datum.web.api.endpoints.pdf`, `.fill`, `.sign`, `.verify`; the seal tests also need a signing key (`datum.pdf.signing.*`) and `--pdf-signing`; the per-route test (PDF-06) needs the fixture form and its copy (`fixture-form-b.json`) in `datum.forms.locations`, `datum.bindings.*` routing the copy to a binding whose PDF theme is the kit's `datum-host-check-pdf` (its object is `fixture-pdf-theme.json` of `fixtures --out`, under `datum.bindings.pdf_themes`) and the fixture form to another, the assets router, and `--pdf-bindings`; they are skipped, not passed, without it |
| `tsa` | `datum.tsa.enabled`, a signer, and `datum.tsa.access` / `allow_memory_stores` as the deployment needs |
| `hardening` | a test deployment that registers the kit's hostile rule module for the fixture form through `rules_providers` (`RuleModule("datum-tck-hardening", "1", <the file's text>)`), with `DATUM_RUNTIME__VALIDATION__MEMORY=512MiB`; never in a deployment people use |
| `runtime-down` | a test deployment started with `DATUM_RUNTIME__PROGRAMS__SANDBOX=<dir>/stale-program.js` and `DATUM_RUNTIME__FAIL_FAST=false`: the runtime refuses the program with `abi_mismatch` and every submission is 503 |
| `flood` | both limits set low enough to exceed: the per-form throttle (the kit posts at most 120 times; `DATUM_WEB__THROTTLE__LIMIT=30`) and the address limit (FLD-02 posts up to 400 times; `DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200`); it runs last because it spends the request budget |

`datum-host-check fixtures --out <dir>` writes the fixture form, the hostile rule module and the stale program. The kit
writes records, so aim it at a test deployment, and boot a fresh application for each run: the flood case spends the
address's request budget, and a second run inside the throttle window fails the submissions cases with 429. The exit codes
(0 to 4), the report and the options (`--header`, `--person-header`, `--out`) are in the conformance suite's page. The
binding's own suite runs the kit against uvicorn deployments (forms and assets, submissions with the dry run and the flood
case, hardening, the builder, PDF with a signing key, the timestamp server).

#### Running the host check against the example

`examples/submissions/host_check_app.py` is TEST WIRING for `datum-host-check`, never for production: it adds the dry-run
route, a host context provider that trusts the `X-Datum-Test-Role` header for the `datum-host-context` form, and the kit's
hostile rule module for the fixture form. It refuses to start without `HOST_CHECK_TEST_WIRING=yes-this-is-a-test-deployment`.

```sh
datum-host-check fixtures --out kit/
export HOST_CHECK_TEST_WIRING=yes-this-is-a-test-deployment
export DATUM_FORMS__LOCATIONS='["kit/fixture-form.json","kit/fixture-host-context-form.json"]'
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true DATUM_WEB__API__ENDPOINTS__VALIDATE=true DATUM_WEB__API__ENDPOINTS__TEST=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true DATUM_WEB__ASSETS__ENABLED=true DATUM_WEB__THROTTLE__LIMIT=30 DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200 DATUM_RUNTIME__VALIDATION__MEMORY=512MiB
uv run --frozen --no-sync --package datum-example-submissions uvicorn host_check_app:app --port 8765 &
datum-host-check --endpoint http://127.0.0.1:8765 --capabilities submissions,submissions-test,forms,assets,hardening,host-context,flood
```

The `runtime-down` capability needs its own process: the same module started with
`DATUM_RUNTIME__PROGRAMS__SANDBOX=kit/stale-program.js` and `DATUM_RUNTIME__FAIL_FAST=false` (no test, assets or memory
settings needed), checked with `--capabilities runtime-down`. Boot a fresh process for each run (the flood case spends the
request budget).

### The security suite

The kit proves what a host promises; the security suite proves what it refuses. Its endpoint mode sends the attack vectors
(forged outcomes, smuggled journey members, oversized and malformed bodies, replays) at the same receiving routes:

```sh
datum-security-check --endpoint http://localhost:8000 --form datum-security-suite --profile submissions --allow-writes --i-installed-the-suite-fixture
```

Install the suite fixture form in the application first (`datum-security-check fixture --format submissions`); without the
two flags the write vectors are skipped. Its program mode checks the packaged `datum-sandbox-program.js` (and, with
`--pdf-program`, the PDF program) and runs with `--gate release` before a release. [Conformance suite](conformance-suite.md)
describes the CLI, the fixture and the report. A release runs both against the same deployment.

## Examples

Three applications under [`integrations/fastapi/examples`](../integrations/fastapi/README.md), workspace members that are
never built or published:

- [`submissions`](../integrations/fastapi/examples/submissions/README.md) (story one): takes submissions over HTTP into an
  in-memory handler, with the management probes behind a placeholder dependency, and a queue consumer that submits the same
  handler's messages outside HTTP under `async with datum:`.
- [`ui`](../integrations/fastapi/examples/ui/README.md) (stories two and three): serves the forms, the assets and the
  builder over a seeded writable repository, with the builder page opening `<datum-form-builder>` through `DatumHost.builder`.
- [`tsa-server`](../integrations/fastapi/examples/tsa-server/README.md): an RFC 3161 timestamp server with a throwaway
  certificate, checked with `openssl ts -verify`.

Each configures itself from `DATUM_*` environment variables through `DatumSettings`; their READMEs carry the exact settings
and the commands.
