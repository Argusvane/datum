# FastAPI settings

Every setting of the FastAPI host, with its default, its bounds and what it does. The [FastAPI](/fastapi) page shows how to include the routers; the [wire](/wire) page describes the requests and answers they serve.

## Where settings come from

`DatumSettings` reads the settings from three sources. The first source that names a setting wins.

1. Keyword arguments to `DatumSettings(...)`.
2. Environment variables.
3. A TOML file named by `DATUM_CONFIG_FILE`. The variable must name an existing file, or the start stops.

Environment variables follow these rules:

- **Name.** `DATUM_` plus the setting's path in capitals, with `__` between levels: `datum.runtime.validation.time_limit` is `DATUM_RUNTIME__VALIDATION__TIME_LIMIT`.
- **Matching.** Names are matched without regard to case, and an empty value counts as unset.
- **Lists and mappings.** A list or a mapping is written as JSON text (`DATUM_FORMS__LOCATIONS='["forms/*.json"]'`), or a mapping one key at a time (`DATUM_WEB__THROTTLE__LIMITS__SUBMIT=10`).
- **Capitals.** A key written in the environment comes out in lower case, so a binding id or a form key with capitals belongs in the TOML file.
- **Merging.** Values from the sources are merged level by level, so the environment can change one setting the TOML file also sets.

In the TOML file the tables are the setting paths without the leading `datum`:

```toml
[web.api.endpoints]
submissions = true
validate = true

[runtime.validation]
time_limit = 3
memory = "64MiB"

[web.throttle]
limit = 30

[forms]
locations = ["forms/*.json"]
```

The same settings in the environment:

```sh
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true
export DATUM_WEB__API__ENDPOINTS__VALIDATE=true
export DATUM_RUNTIME__VALIDATION__TIME_LIMIT=3
export DATUM_RUNTIME__VALIDATION__MEMORY=64MiB
export DATUM_WEB__THROTTLE__LIMIT=30
export DATUM_FORMS__LOCATIONS='["forms/*.json"]'
```

`python -m datum_core.config.schema --out <path>` writes the JSON Schema of every setting to a file, or into a directory as `datum-settings.schema.json`. The same schema ships inside `argusvane-datum-core`.

A value that cannot work stops the start and names the setting. The cases are:

- A number outside its bounds.
- A word that is not one of the allowed ones (the message lists them and offers the closest).
- A missing file.
- A password that is too short.

A `DATUM_` variable that matches no setting is warned about (`datum.W007`); with `datum.strict_env` it stops the start instead. The next section lists the value forms and the rules that tie settings together.

## Value forms and rules across settings

| Form | What it accepts |
|---|---|
| Seconds | A number (`5`, `0.05`), a numeric string, or an ISO 8601 duration (`PT5S`). A boolean is refused. |
| Size | A whole number of bytes, or a size such as `32MiB` (binary) or `32MB` (decimal). A boolean is refused. |
| Word | One of a closed set, matched without regard to case. |
| Secret | Never shown in a log, an error or a dump. A secret that sets a minimum length refuses a shorter value and reports the length only. |
| Credential address | A URI that may hold credentials. Its user-info is hidden in logs and in the JSON dump. |

Rules that tie several settings together, each of which stops the start:

- `datum.runtime.qjs_sha256` needs `datum.runtime.qjs_path`.
- A signing key (`datum.pdf.signing` and `datum.tsa.signer`) follows its type:
  - Type `PKCS12` needs `pkcs12_file` and refuses `key_password`, `key_file` and `cert_file`.
  - Type `PEM` needs `key_file` and `cert_file` and refuses `pkcs12_file`, `pkcs12_password` and `friendly_name`.
  - An empty password counts as unset.
  - The files are read once at start, at most 1 MiB each, so a renewed key takes a restart.
  - The first certificate must be the certificate of the private key.
  - The key must be RSA (2048 bits or more) or ECDSA P-256 or P-384.
  - A `friendly_name` must equal the friendly name of the key's certificate in the store; it checks, it does not choose.
- `datum.tsa.signer.self_signed` refuses a named key file as well.
- `datum.tsa.enabled` needs `datum.tsa.policy`, and every policy is checked as an OID.
- `datum.tsa.client_store = sql` with `access = clients` needs a client store passed to `Datum(tsa_client_store=...)`.
- The timestamp client of a PDF signature:
  - Needs an `http` or `https` address with a host.
  - Takes `basic_user` and `basic_password` together or not at all, and `basic_user` holds no colon.
  - Refuses a bearer token, Basic credentials or user-info in the address for an `http` address that is not loopback.
- A throttle storage that is not memory needs `datum.web.throttle.key_salt` (`datum.E005`).
- Each entry of `datum.web.throttle.limits` is at least 1, and `datum.web.throttle.address_limit` is at least 1 or `off`.
- Every binding named in `datum.bindings` must be in the catalogue, and every PDF theme a used binding suggests (other than `datum-pdf`) must be supplied under `datum.bindings.pdf_themes`.
- `datum.silenced_checks` names only known check ids, and never an ERROR check.
- A PDF or timestamp capability that is on needs its extra installed (`argusvane-datum-core[pdf]`, `argusvane-datum-core[timestamp]`).

## datum

The top of the tree.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.enabled` | `DATUM_ENABLED` | `true` | Boolean. When false, every Datum router adds no routes. |
| `datum.strict_env` | `DATUM_STRICT_ENV` | `false` | Boolean. When true, a `DATUM_` variable that names no setting stops the start instead of warning (`datum.W007`). |
| `datum.silenced_checks` | `DATUM_SILENCED_CHECKS` | none | List of check ids to leave out of the log, such as `["datum.W003"]`. Only INFO and WARNING checks can be silenced; an unknown id or an ERROR id is refused. |
| `datum.workers_expected` | `DATUM_WORKERS_EXPECTED` | unset | Whole number, at least 1. The number of worker processes the deployment runs. Unset, the host reads `WEB_CONCURRENCY` as a hint, else 1. The memory check (`datum.W002`) and the builder's shared-store rule (`datum.E002`) read it. |

## datum.runtime

The program runtime: the sandbox that runs the form program and the PDF program.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.engine` | `DATUM_RUNTIME__ENGINE` | `wasmtime` | Text. The id of the engine provider. An unknown or unavailable id stops the start. |
| `datum.runtime.fail_fast` | `DATUM_RUNTIME__FAIL_FAST` | `true` | Boolean. When true, a runtime that cannot be brought up stops the start. |
| `datum.runtime.warm_up_runs` | `DATUM_RUNTIME__WARM_UP_RUNS` | `3` | Whole number, 0 or more. Runs made at start to warm the engine. The host always makes at least one, so 0 behaves as 1. |
| `datum.runtime.shutdown_grace` | `DATUM_RUNTIME__SHUTDOWN_GRACE` | `10` s | Seconds, 0 or more. How long shutdown waits for runs in flight. Keep it below the process manager's own timeout. |
| `datum.runtime.startup_budget` | `DATUM_RUNTIME__STARTUP_BUDGET` | `30` s | Seconds, at least 0.001. The time allowed for the runtime to start. A start that runs past it fails with `datum.E004`. |
| `datum.runtime.tick` | `DATUM_RUNTIME__TICK` | `0.05` s | Seconds, at least 0.001. The resolution of the clock the runs share. |
| `datum.runtime.work_dir` | `DATUM_RUNTIME__WORK_DIR` | unset | Text. A directory local to the container for the runtime's working files. Unset uses the system temporary directory. |
| `datum.runtime.stop_grace` | `DATUM_RUNTIME__STOP_GRACE` | `5` s | Seconds, 0 or more. How long the engine waits when it stops a run. |
| `datum.runtime.max_strays` | `DATUM_RUNTIME__MAX_STRAYS` | `0` | Whole number, 0 or more. Stray runs tolerated. 0 means one per CPU, at least 2. |
| `datum.runtime.worker_threads` | `DATUM_RUNTIME__WORKER_THREADS` | `0` | Whole number, 0 or more. The worker threads the limiter allows for runs plus hooks in flight. 0 means 2 times the slots plus 2, where the slots are the validation and PDF slots together. To size it yourself use slots plus the slots times hook time on a thread over run time, rounded up, plus 2; blocking work on the worker thread (a synchronous store, the timestamp client) counts as hook time. A call that gets no thread within `datum.runtime.validation.wait` answers 503 `server.busy`. |
| `datum.runtime.qjs_path` | `DATUM_RUNTIME__QJS_PATH` | unset | Text. The path of your own copy of `qjs-wasi.wasm`. Unset uses the packaged, pinned module. |
| `datum.runtime.qjs_sha256` | `DATUM_RUNTIME__QJS_SHA256` | unset | Text, 64 hexadecimal characters. The SHA-256 of your own copy. It needs `qjs_path`. |
| `datum.runtime.allow_unguarded_stack` | `DATUM_RUNTIME__ALLOW_UNGUARDED_STACK` | `false` | Boolean. Run your own copy of `qjs-wasi.wasm` even when the shadow stack guard cannot read it (no name section, or not the layout of the release builds). Off, such a copy stops the start. On, it runs without the guard and the start logs a WARNING: a run whose C stack overruns the module's static data is then not detected. The packaged module is always guarded. |
| `datum.runtime.verify_max_bytes` | `DATUM_RUNTIME__VERIFY_MAX_BYTES` | `20MiB` | Size. The largest PDF the verify route reads; a larger one answers 413. A value outside 1 MiB to 100 MiB is moved to the nearest bound with `datum.W008`. |

## datum.runtime.validation

The budgets of one validation run. Each value outside its bounds is moved to the nearest bound with `datum.W008`.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.validation.time_limit` | `DATUM_RUNTIME__VALIDATION__TIME_LIMIT` | `5` s | Seconds, more than 0. The time limit of a run. Bounds 0.001 s to 60 s. |
| `datum.runtime.validation.memory` | `DATUM_RUNTIME__VALIDATION__MEMORY` | `32MiB` | Size. The memory of a run. Bounds 4 MiB to 1 GiB. A value below what the runtime module needs to start is an error (`datum.E003`), never clamped up. |
| `datum.runtime.validation.concurrency` | `DATUM_RUNTIME__VALIDATION__CONCURRENCY` | `0` | Whole number, 0 or more. Concurrent runs. 0 means one per CPU. At most 64. |
| `datum.runtime.validation.wait` | `DATUM_RUNTIME__VALIDATION__WAIT` | `2` s | Seconds, 0 or more. How long a run waits for a slot before the answer is 503. At most 10 s. |

## datum.runtime.pdf

The budgets of one PDF run, on the same rules.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.pdf.time_limit` | `DATUM_RUNTIME__PDF__TIME_LIMIT` | `60` s | Seconds, more than 0. The time limit of a run. Bounds 0.001 s to 300 s. |
| `datum.runtime.pdf.memory` | `DATUM_RUNTIME__PDF__MEMORY` | `256MiB` | Size. The memory of a run. Bounds 32 MiB to 4 GiB. A value below what the runtime module needs to start is an error (`datum.E003`). |
| `datum.runtime.pdf.concurrency` | `DATUM_RUNTIME__PDF__CONCURRENCY` | `0` | Whole number, 0 or more. Concurrent runs. 0 means the smaller of 2 and the CPUs. At most 64. |
| `datum.runtime.pdf.wait` | `DATUM_RUNTIME__PDF__WAIT` | `2` s | Seconds, 0 or more. How long a run waits for a slot before the answer is 503. At most 10 s. |

## datum.runtime.programs

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.programs.sandbox` | `DATUM_RUNTIME__PROGRAMS__SANDBOX` | unset | Text. The path of the form program. Unset uses the packaged program, which is still checked against its digest. A path that cannot be read stops the start. |
| `datum.runtime.programs.pdf` | `DATUM_RUNTIME__PROGRAMS__PDF` | unset | Text. The path of the PDF program, on the same terms. |

## datum.runtime.diagnostics

How the sandbox tells you what its runs did. See [Python sandbox library](/python-sandbox#diagnostics).

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.diagnostics.trace` | `DATUM_RUNTIME__DIAGNOSTICS__TRACE` | `off` | `off`, `failures` or `all`. One line per run on the logger `datum.sandbox.trace`: `failures` writes one for a failed run only. A line holds sizes and times, never an answer. Any other word stops the start. |
| `datum.runtime.diagnostics.report` | `DATUM_RUNTIME__DIAGNOSTICS__REPORT` | `true` | Boolean. Log the effective settings at start on `datum.sandbox.settings`, each with where it came from. |

## datum.runtime.diagnostics.capture

The failed-run capture. It keeps the bytes of every failed run on disk so it can be replayed. Those files hold the submitted answers and the form definition in clear text, so it is off by default and the start warns while it is on.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.runtime.diagnostics.capture.enabled` | `DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__ENABLED` | `false` | Boolean. Keep the stdin, stdout, stderr, `run.js` and a `meta.json` of every failed run. |
| `datum.runtime.diagnostics.capture.directory` | `DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__DIRECTORY` | unset | Text. The directory the captures go to. It must be a real directory owned by the process's user with mode 0700 and, on macOS, no access-control entry; a missing one is created 0700. Anything else stops the start. Required when the capture is on. |
| `datum.runtime.diagnostics.capture.max_runs` | `DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__MAX_RUNS` | `20` | Whole number, at least 1. Captures kept; the oldest go first. |
| `datum.runtime.diagnostics.capture.max_bytes` | `DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__MAX_BYTES` | `64MiB` | Size, at least 1 byte. Bytes of captures kept; a capture larger than this is dropped and counted. |
| `datum.runtime.diagnostics.capture.queue_bytes` | `DATUM_RUNTIME__DIAGNOSTICS__CAPTURE__QUEUE_BYTES` | `64MiB` | Size, at least 1 byte. Bytes waiting to be written; past it a capture is dropped and counted. A run never waits for the capture. |

## datum.host

Options the form program reads on every run.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.host.formula_errors` | `DATUM_HOST__FORMULA_ERRORS` | `fail` | Word: `fail` or `warn`. What a formula that cannot be evaluated does. |
| `datum.host.risky_patterns` | `DATUM_HOST__RISKY_PATTERNS` | `refuse` | Word: `refuse` or `allow`. What a regular expression that repeats a repeat does. |
| `datum.host.time_zone` | `DATUM_HOST__TIME_ZONE` | the process zone | Text, an IANA zone name such as `America/Toronto` or `UTC`. The zone for `today()` and clock rules. The default is the process zone, read once; when it cannot be read the host uses `UTC` and warns (`datum.W010`). |
| `datum.host.unknown_fields` | `DATUM_HOST__UNKNOWN_FIELDS` | `strip` | Word: `strip`, `keep` or `reject`. What an answer with no component in the form does. |
| `datum.host.log_level` | `DATUM_HOST__LOG_LEVEL` | `warn` | Word: `off`, `error`, `warn`, `info` or `debug`. How much of a run's log is kept and relayed. |

## datum.submissions.idempotency

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.submissions.idempotency.memory_size` | `DATUM_SUBMISSIONS__IDEMPOTENCY__MEMORY_SIZE` | `10000` | Whole number, 16 to 10,000,000. Receipts the in-memory receipt store keeps. |

## datum.forms

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.forms.locations` | `DATUM_FORMS__LOCATIONS` | `["datum/forms/*.json"]` | List of text. Paths and glob patterns of the form definition files, or `package:<pkg>/<glob>` for files inside an installed package. A location with no glob character names one file. Each file's `id` is its form key. A file that cannot be read, is not a JSON object, has no valid `id`, or repeats an `id` stops the start; a location that matches nothing is a warning in the `datum.forms` log. The files are read when a route that finds a form by its id is on (`submissions`, `validate`, `test`, `definition`, `pdf`, `fill`) or the builder is; with none on, nothing is read and nothing is warned about. |

## datum.forms.snapshots

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.forms.snapshots.max_entries` | `DATUM_FORMS__SNAPSHOTS__MAX_ENTRIES` | `500` | Whole number, at least 1. Snapshots the in-memory store keeps. |
| `datum.forms.snapshots.public_copy_cache_size` | `DATUM_FORMS__SNAPSHOTS__PUBLIC_COPY_CACHE_SIZE` | `256` | Whole number, at least 1. Public copies of a definition kept by hash. |

## datum.forms.translations

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.forms.translations.max_entries` | `DATUM_FORMS__TRANSLATIONS__MAX_ENTRIES` | `1000` | Whole number, at least 1. The number of forms the in-memory translation store holds catalogues for. |

## datum.forms.data_sources

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.forms.data_sources.timeout` | `DATUM_FORMS__DATA_SOURCES__TIMEOUT` | `15` s | Seconds, at least 0.001. One deadline for all the data-source calls made while building a snapshot. |
| `datum.forms.data_sources.max_threads` | `DATUM_FORMS__DATA_SOURCES__MAX_THREADS` | `16` | Whole number, at least 1. Threads for data-source providers that are plain (synchronous) functions. |

## datum.forms.cache

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.forms.cache.definition` | `DATUM_FORMS__CACHE__DEFINITION` | `no-store` | Text. The `Cache-Control` header of a definition answer. |

## datum.web.api

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.api.max_body_size` | `DATUM_WEB__API__MAX_BODY_SIZE` | `1MiB` | Size, at least 1 byte. The largest request body. It is also the largest document the services read. |
| `datum.web.api.problem_details` | `DATUM_WEB__API__PROBLEM_DETAILS` | `false` | Boolean. When true, errors are answered as RFC 9457 problem details. |
| `datum.web.api.busy_retry_after` | `DATUM_WEB__API__BUSY_RETRY_AFTER` | `5` | Whole seconds, 1 to 3600. The `Retry-After` of a busy answer. |
| `datum.web.api.correlation_header` | `DATUM_WEB__API__CORRELATION_HEADER` | `X-Request-ID` | Text, an HTTP header name. The header that names a request in the logs. |

## datum.web.api.endpoints

One switch per endpoint. Every endpoint is off until its switch is set to true. A router adds a route only when its switch is on.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.api.endpoints.submissions` | `DATUM_WEB__API__ENDPOINTS__SUBMISSIONS` | `false` | Boolean. `POST /api/submissions`. |
| `datum.web.api.endpoints.validate` | `DATUM_WEB__API__ENDPOINTS__VALIDATE` | `false` | Boolean. `POST /api/submissions/validate`. |
| `datum.web.api.endpoints.test` | `DATUM_WEB__API__ENDPOINTS__TEST` | `false` | Boolean. `POST /api/submissions/test`. |
| `datum.web.api.endpoints.inspect` | `DATUM_WEB__API__ENDPOINTS__INSPECT` | `false` | Boolean. Definition inspection, `POST /api/inspect`. |
| `datum.web.api.endpoints.definition` | `DATUM_WEB__API__ENDPOINTS__DEFINITION` | `false` | Boolean. `GET /api/forms/{key}/definition`. |
| `datum.web.api.endpoints.data_sources` | `DATUM_WEB__API__ENDPOINTS__DATA_SOURCES` | `false` | Boolean. `GET /api/data-sources/{id}`. |
| `datum.web.api.endpoints.pdf` | `DATUM_WEB__API__ENDPOINTS__PDF` | `false` | Boolean. `POST /api/pdf`. |
| `datum.web.api.endpoints.fill` | `DATUM_WEB__API__ENDPOINTS__FILL` | `false` | Boolean. `POST /api/pdf/fill`. |
| `datum.web.api.endpoints.sign` | `DATUM_WEB__API__ENDPOINTS__SIGN` | `false` | Boolean. `POST /api/pdf/sign`. |
| `datum.web.api.endpoints.verify` | `DATUM_WEB__API__ENDPOINTS__VERIFY` | `false` | Boolean. `POST /api/pdf/verify`. |
| `datum.web.api.endpoints.certificate` | `DATUM_WEB__API__ENDPOINTS__CERTIFICATE` | `false` | Boolean. The signing certificate route, `GET /api/server/certificate`. |

## datum.web.throttle

Request throttling. Two counts share the window, the storage, the salt and the key cap. The address limit counts every request to a throttled route (submit, validate, test, inspect and the PDF routes) by its client address alone, after the `Content-Type` check and before the body is read, so a body that does not parse is counted too. The per-form limit counts after the parse, by the parts `by` names. Both refuse with 429 `flood` and `Retry-After`. Without `datum.web.throttle.limits`, one per-form limit and one window apply to every kind of request.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.throttle.enabled` | `DATUM_WEB__THROTTLE__ENABLED` | `true` | Boolean. Throttle requests. |
| `datum.web.throttle.limit` | `DATUM_WEB__THROTTLE__LIMIT` | `60` | Whole number, at least 1. Requests per window for one key (the per-form limit). |
| `datum.web.throttle.address_limit` | `DATUM_WEB__THROTTLE__ADDRESS_LIMIT` | `600` | Whole number, at least 1, or `off` (`None` in code). Requests per window from one client address, counted on every throttled route before the body is read. An IPv6 client is counted by its /64 prefix. A request with no client address is not counted. Off while `enabled` is false. Only Datum's own throttle keeps it: a `throttle` you pass to `Datum` does not. |
| `datum.web.throttle.window` | `DATUM_WEB__THROTTLE__WINDOW` | `60` s | Seconds, at least 1. The length of the window. |
| `datum.web.throttle.by` | `DATUM_WEB__THROTTLE__BY` | `["ip", "form"]` | List of words: `ip`, `form`, `principal`; at least one. What a throttle key is made of. |
| `datum.web.throttle.max_keys` | `DATUM_WEB__THROTTLE__MAX_KEYS` | `10000` | Whole number, at least 1. The most distinct keys the in-memory counters hold. At the cap a new key first drops the expired windows; when none has expired, a sixteenth of the live ones goes, one at a time from the caller (the address and principal, without the form) holding the most windows, its window of the fewest attempts first and the newest among equals. |
| `datum.web.throttle.limits` | `DATUM_WEB__THROTTLE__LIMITS` | none | Mapping from a kind (`submit`, `validate`, `test`, `pdf`, `register`) to requests per window, at least 1. A kind not listed uses `limit`. |
| `datum.web.throttle.storage` | `DATUM_WEB__THROTTLE__STORAGE` | `async+memory://` | Text. A storage address of the `limits` library; use `async+redis://...` in production. Any credentials in it are hidden in logs. A storage that cannot be built stops the start (`datum.E006`). |
| `datum.web.throttle.key_salt` | `DATUM_WEB__THROTTLE__KEY_SALT` | unset | Secret, at least 32 bytes. Salts the keys in the storage. Required when the storage is not memory, and every worker on one storage must share it (`datum.E005`). Memory storage uses a random salt per process. |

## datum.web.assets

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.assets.enabled` | `DATUM_WEB__ASSETS__ENABLED` | `false` | Boolean. Serve the packaged browser files, `host.json` and `datum-host.js`. |
| `datum.web.assets.cache_period` | `DATUM_WEB__ASSETS__CACHE_PERIOD` | `31536000` s | Seconds, 0 or more. The cache lifetime of an asset (one year). |
| `datum.web.assets.omit_features` | `DATUM_WEB__ASSETS__OMIT_FEATURES` | none | List of text. Feature tokens whose files are left out of the served assets. |

## datum.web.csrf

The names the page glue reads from `host.json`. Datum adds no CSRF protection itself; these settings only name the header, cookie and meta tag your own protection uses.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.csrf.header_name` | `DATUM_WEB__CSRF__HEADER_NAME` | `X-XSRF-TOKEN` | Text. The header that carries the token. |
| `datum.web.csrf.cookie_name` | `DATUM_WEB__CSRF__COOKIE_NAME` | `XSRF-TOKEN` | Text. The cookie that carries the token. |
| `datum.web.csrf.meta_name` | `DATUM_WEB__CSRF__META_NAME` | `_csrf` | Text. The meta tag that carries the token. |

## datum.web.openapi

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.openapi.enabled` | `DATUM_WEB__OPENAPI__ENABLED` | `true` | Boolean. Describe Datum's routes in the application's OpenAPI document. |
| `datum.web.openapi.tag_prefix` | `DATUM_WEB__OPENAPI__TAG_PREFIX` | `datum-` | Text. The prefix of Datum's OpenAPI tags. |
| `datum.web.openapi.group_documents` | `DATUM_WEB__OPENAPI__GROUP_DOCUMENTS` | `false` | Boolean. Add one OpenAPI document per router, served at `{prefix}/openapi/{factory}.json`. |

## datum.web.management

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.web.management.recheck` | `DATUM_WEB__MANAGEMENT__RECHECK` | `false` | Boolean. Serve `POST /recheck`. It is guarded by the dependencies you pass to `routers.management`. |

## datum.builder

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.builder.enabled` | `DATUM_BUILDER__ENABLED` | `false` | Boolean. Serve the builder routes. |
| `datum.builder.max_definition_size` | `DATUM_BUILDER__MAX_DEFINITION_SIZE` | `1MiB` | Size, 1 byte to 64 MiB. The largest definition a save accepts. |

## datum.pdf

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.pdf.enabled` | `DATUM_PDF__ENABLED` | `true` | Boolean. The PDF capability. With it on, the start needs `argusvane-datum-core[pdf]`. |
| `datum.pdf.fonts` | `DATUM_PDF__FONTS` | `default` | Word: `default`, `standard` or `all`. Which font faces a PDF embeds. |

## datum.pdf.seal

The seal preset applied to every PDF the application issues.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.pdf.seal.enabled` | `DATUM_PDF__SEAL__ENABLED` | `false` | Boolean. Seal issued PDFs. Without a server signing key the start warns (`datum.W013`). |
| `datum.pdf.seal.layouts` | `DATUM_PDF__SEAL__LAYOUTS` | none | List of text. The layout ids that are sealed. Empty means all. |
| `datum.pdf.seal.certify` | `DATUM_PDF__SEAL__CERTIFY` | `noChanges` | Word: `noChanges`, `formFill`, `annotate` or `none`. The kind of signature. `noChanges` certifies and allows no change afterwards. `formFill` certifies and allows form filling. `annotate` certifies and allows form filling and annotations. `none` is an approval signature, not a certifying one. The program's own words `formFilling` and `annotations`, `false` and `approval` for `none`, and the numbers 0 to 3 are read as well, whatever the case. |
| `datum.pdf.seal.timestamp` | `DATUM_PDF__SEAL__TIMESTAMP` | `true` | Boolean. Ask a timestamp token for each seal made with the server's key, when a timestamp source is set up (`datum.W011` otherwise). The test seal of posted answers is never timestamped. |
| `datum.pdf.seal.reason` | `DATUM_PDF__SEAL__REASON` | unset | Text. The signature reason. |
| `datum.pdf.seal.location` | `DATUM_PDF__SEAL__LOCATION` | unset | Text. The signature location. |
| `datum.pdf.seal.visible` | `DATUM_PDF__SEAL__VISIBLE` | unset | Boolean. Draw a visible signature. Unset leaves it to the layout. |
| `datum.pdf.seal.posted_answers` | `DATUM_PDF__SEAL__POSTED_ANSWERS` | `false` | Boolean. Seal the PDFs of posted, unstored answers with the real certificate. Without a server key they keep the test seal. |

## datum.pdf.signing

The server's signing key, shared by the seal and `POST /api/pdf/sign`. The key rules are under the value forms above. Nothing here is needed when the application passes its own `pdf_signer` to `Datum`.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.pdf.signing.type` | `DATUM_PDF__SIGNING__TYPE` | `PKCS12` | Word: `PKCS12` or `PEM`. The key file format. |
| `datum.pdf.signing.pkcs12_file` | `DATUM_PDF__SIGNING__PKCS12_FILE` | unset | Text. The path of the PKCS#12 key store. For type `PKCS12`. |
| `datum.pdf.signing.pkcs12_password` | `DATUM_PDF__SIGNING__PKCS12_PASSWORD` | unset | Secret. The store's password. |
| `datum.pdf.signing.friendly_name` | `DATUM_PDF__SIGNING__FRIENDLY_NAME` | unset | Text. The friendly name of the key's certificate in the store. A check against the certificate; it never chooses one. |
| `datum.pdf.signing.key_password` | `DATUM_PDF__SIGNING__KEY_PASSWORD` | unset | Secret. The password of the PEM private key. For type `PEM`. |
| `datum.pdf.signing.key_file` | `DATUM_PDF__SIGNING__KEY_FILE` | unset | Text. The path of the PEM private key. |
| `datum.pdf.signing.cert_file` | `DATUM_PDF__SIGNING__CERT_FILE` | unset | Text. The path of the PEM certificate chain, the key's own certificate first. |
| `datum.pdf.signing.retired_certificates` | `DATUM_PDF__SIGNING__RETIRED_CERTIFICATES` | none | List of text. PEM locations (a path or `package:<pkg>/<file>`) of replaced certificates. The verify route reports a signature by one of them as `site_retired`. |
| `datum.pdf.signing.trust_anchors` | `DATUM_PDF__SIGNING__TRUST_ANCHORS` | none | List of text. PEM locations of the trust anchors the verify route builds a chain to. A location that cannot be read stops the start. |

## datum.pdf.signing.tsa

The timestamp client used to timestamp PDF signatures. It is not used when the application passes its own `timestamper` to `Datum`; setting it then raises `datum.I002` or `datum.W012`.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.pdf.signing.tsa.url` | `DATUM_PDF__SIGNING__TSA__URL` | unset | Text. The address of the timestamp authority, `http` or `https`. User-info in it is hidden in logs. |
| `datum.pdf.signing.tsa.policy` | `DATUM_PDF__SIGNING__TSA__POLICY` | unset | Text, an OID such as `1.2.3.4`. The policy requested. |
| `datum.pdf.signing.tsa.bearer_token` | `DATUM_PDF__SIGNING__TSA__BEARER_TOKEN` | unset | Secret. A bearer token for the authority. |
| `datum.pdf.signing.tsa.basic_user` | `DATUM_PDF__SIGNING__TSA__BASIC_USER` | unset | Text. The Basic-auth user. Needs `basic_password`. |
| `datum.pdf.signing.tsa.basic_password` | `DATUM_PDF__SIGNING__TSA__BASIC_PASSWORD` | unset | Secret. The Basic-auth password. Needs `basic_user`. |
| `datum.pdf.signing.tsa.timeout` | `DATUM_PDF__SIGNING__TSA__TIMEOUT` | `10` s | Seconds, at least 0.001. The bound on one request. |

## datum.bindings

Which design-system binding draws each form route, and the PDF theme its PDF prints under. A route is a form key without a version. Use the TOML file for keys with capitals.

```toml
[bindings]
default = "datum"

[bindings.routes]
intake = "acme"

[bindings.catalog.acme]
label = "Acme"
pdf_theme = "acme-pdf"

[bindings.pdf_themes]
acme-pdf = "themes/acme-pdf.json"
```

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.bindings.default` | `DATUM_BINDINGS__DEFAULT` | `datum` | Text. The binding of a route with no override. It must be an id in the catalogue. |
| `datum.bindings.routes` | `DATUM_BINDINGS__ROUTES` | none | Mapping from a form key to the binding id that draws it. Every id must be in the catalogue. |
| `datum.bindings.catalog` | `DATUM_BINDINGS__CATALOG` | none | Mapping from a binding id to its entry (the two rows below). Adds bindings this host registers on its pages to the ones the bundles carry. An id holds letters, digits, `.`, `_` and `-`. |
| `datum.bindings.catalog.<id>.label` | `DATUM_BINDINGS__CATALOG__<ID>__LABEL` | the id | Text. Shown where bindings are listed. |
| `datum.bindings.catalog.<id>.pdf_theme` | `DATUM_BINDINGS__CATALOG__<ID>__PDF_THEME` | none | Text, a PDF theme id. The theme a PDF of a route drawn by this binding prints under. Unset suggests none. |
| `datum.bindings.pdf_themes` | `DATUM_BINDINGS__PDF_THEMES` | none | Mapping from a PDF theme id to the path of its JSON file, for every suggested PDF theme except `datum-pdf`. The file is a JSON object whose `id` is the key and whose `target` is `pdf`. |

## datum.tsa

The RFC 3161 [timestamp server](/timestamps). The routes are on only when `datum.tsa.enabled` is true.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.tsa.enabled` | `DATUM_TSA__ENABLED` | `false` | Boolean. Serve the timestamp route. Needs `argusvane-datum-core[timestamp]` and `datum.tsa.policy`. |
| `datum.tsa.access` | `DATUM_TSA__ACCESS` | `clients` | Word: `clients` or `open`. Who may call: only clients that present a known key, or anyone. |
| `datum.tsa.policy` | `DATUM_TSA__POLICY` | unset | Text, an OID. The policy the server issues under. |
| `datum.tsa.accepted_policies` | `DATUM_TSA__ACCEPTED_POLICIES` | none | List of OIDs. The policies a request may ask for. |
| `datum.tsa.accuracy` | `DATUM_TSA__ACCURACY` | `1` s | Seconds, 0 to 60. The accuracy stated in each token. |
| `datum.tsa.max_request_size` | `DATUM_TSA__MAX_REQUEST_SIZE` | `16KiB` | Size, 1 byte to 1 MiB. The largest request. A larger one answers 413. |
| `datum.tsa.session_cookies` | `DATUM_TSA__SESSION_COOKIES` | `["*"]` | List of text. A request that carries one of these cookies is refused with 403. The default `"*"` refuses any cookie. Name cookies instead to refuse only those. Names are matched without regard to case. |
| `datum.tsa.allow_memory_stores` | `DATUM_TSA__ALLOW_MEMORY_STORES` | `false` | Boolean. Acknowledge that the serial allocator and issue log are kept in memory, which is safe for one instance only. Without it the start stops (`datum.E001`); with it the start warns (`datum.W009`). |
| `datum.tsa.client_store` | `DATUM_TSA__CLIENT_STORE` | `settings` | Word: `settings` or `sql`. Where timestamp clients are kept. `sql` needs a client store passed to `Datum`. |
| `datum.tsa.clients` | `DATUM_TSA__CLIENTS` | none | List of 64-character hexadecimal strings. The SHA-256 of each client key, for client store `settings`. |
| `datum.tsa.retired_certificates` | `DATUM_TSA__RETIRED_CERTIFICATES` | none | List of text. PEM locations of replaced timestamp certificates. |

## datum.tsa.flood

Flood control of the timestamp server.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.tsa.flood.limit` | `DATUM_TSA__FLOOD__LIMIT` | `1000` | Whole number, 0 or more. Requests per window, counted per client (per address under open access, where an IPv6 client is counted by its /64 prefix). Over it the answer is 429. 0 turns it off. |
| `datum.tsa.flood.window` | `DATUM_TSA__FLOOD__WINDOW` | `3600` s | Seconds, at least 1. The length of the window. |
| `datum.tsa.flood.failed_keys` | `DATUM_TSA__FLOOD__FAILED_KEYS` | `10` | Whole number, 0 or more. Wrong keys tolerated per address per window (an IPv6 client is counted by its /64 prefix); past it the answer is 429. 0 turns the lockout off. |

## datum.tsa.signer

The timestamp server's signing key. The key rules are under the value forms above.

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `datum.tsa.signer.type` | `DATUM_TSA__SIGNER__TYPE` | `PKCS12` | Word: `PKCS12` or `PEM`. The key file format. |
| `datum.tsa.signer.pkcs12_file` | `DATUM_TSA__SIGNER__PKCS12_FILE` | unset | Text. The path of the PKCS#12 key store. |
| `datum.tsa.signer.pkcs12_password` | `DATUM_TSA__SIGNER__PKCS12_PASSWORD` | unset | Secret. The store's password. |
| `datum.tsa.signer.friendly_name` | `DATUM_TSA__SIGNER__FRIENDLY_NAME` | unset | Text. The friendly name of the key's certificate in the store. Checked against the certificate, never used to choose it. |
| `datum.tsa.signer.key_password` | `DATUM_TSA__SIGNER__KEY_PASSWORD` | unset | Secret. The password of the PEM private key. |
| `datum.tsa.signer.key_file` | `DATUM_TSA__SIGNER__KEY_FILE` | unset | Text. The path of the PEM private key. |
| `datum.tsa.signer.cert_file` | `DATUM_TSA__SIGNER__CERT_FILE` | unset | Text. The path of the PEM certificate chain. |
| `datum.tsa.signer.self_signed` | `DATUM_TSA__SIGNER__SELF_SIGNED` | `false` | Boolean. Use a throwaway self-signed key, for development only. Refused when a key file is named as well. |

## Start-up checks

The host runs its checks when the lifespan starts and logs each one under `datum.checks` as `(datum.W001) message`, with a `HINT:` line when there is one.

- A WARNING or INFO check never stops the start.
- All ERROR checks found are raised together as one `DatumConfigurationError` and the start stops.
- List ids in `datum.silenced_checks` to leave out an INFO or WARNING check.

| Id | Severity | Cause | What to do |
|---|---|---|---|
| `datum.I001` | INFO | The log line that names the routes that are on: the endpoint switches that are true, and `assets`. | Nothing. If it reads `none`, set `datum.web.api.endpoints.*` or `datum.web.assets.enabled`. |
| `datum.I002` | INFO | `datum.pdf.signing.tsa` names an address or credentials, and the application also passed its own `timestamper`, which issues the tokens instead. | Unset the client settings, or do not pass `Datum(timestamper=...)`. |
| `datum.W001` | WARNING | A router was included and every switch it reads is off (or `datum.enabled` is false), so it serves no route. | Set one of the named switches, or do not include the router. |
| `datum.W002` | WARNING | The runtime's slots times their memory, for the validation and PDF pools and every worker, exceed the container's memory limit (cgroup, else the host's memory) less what the process uses at start. | Lower `datum.runtime.validation.concurrency`, `datum.runtime.pdf.concurrency` or the memory budgets, raise the container memory, or state `datum.workers_expected`. |
| `datum.W003` | WARNING | A submission route is on and the default logging handler is in use, which keeps nothing. | Pass your own `Datum(handler=...)`. |
| `datum.W004` | WARNING | A store is kept in this process's memory: the throttle counters, the receipt store, the snapshot or translation store, or the builder's form repository. Each worker has its own, and a restart forgets them. | Use a shared throttle storage (`async+redis://...`), give Datum SQL stores or your own, or run one worker. |
| `datum.W005` | WARNING | Declared for an engine over in-memory SQLite. Nothing raises it. | None. |
| `datum.W006` | WARNING | A data-source provider keeps the default `exists`, so it answers for every id and hides the providers after it. | Implement `exists` on the provider. |
| `datum.W007` | WARNING | A `DATUM_` environment variable matches no setting. The hint offers the closest name. | Fix the name, or remove the variable. Set `datum.strict_env` to stop the start on one. `DATUM_CONFIG_FILE` is the only name outside the settings that is allowed. |
| `datum.W008` | WARNING | A `datum.runtime` budget was outside its bounds and was moved to the nearest bound. The message gives the value asked, the value used and the bounds. | Set a value inside the bounds listed above. |
| `datum.W009` | WARNING | The timestamp server keeps its serial allocator or issue log in memory because `datum.tsa.allow_memory_stores` says so. | Run one instance, or give Datum a SQL store or your own to share between instances and restarts. |
| `datum.W010` | WARNING | The process time zone could not be read, so `datum.host.time_zone` is `UTC`. | Set `datum.host.time_zone` to an IANA zone name. |
| `datum.W011` | WARNING | The seal asks for timestamps, a server key is present, and no timestamp source is set up. Sealed PDFs carry the `sealing.timestamp` warning and no token. | Pass `Datum(timestamper=...)`, set `datum.pdf.signing.tsa.url`, enable `datum.tsa.enabled`, or set `datum.pdf.seal.timestamp` to false. |
| `datum.W012` | WARNING | `datum.pdf.signing.tsa.policy` is set, and the application's own `timestamper` issues the tokens, so the policy is unused. | Unset the policy, or do not pass `Datum(timestamper=...)`. |
| `datum.W013` | WARNING | `datum.pdf.seal` is on and the server has no signing key, so posted answers carry the test seal and `render_submission` answers 500. | Name a key in `datum.pdf.signing`, or pass `Datum(pdf_signer=...)`. |
| `datum.E001` | ERROR | The timestamp server would keep its serial allocator or issue log in memory, and that is not acknowledged. | Pass a SQL engine and create the table, provide your own store, or set `datum.tsa.allow_memory_stores` to true for one instance. |
| `datum.E002` | ERROR | The builder is on with in-memory stores and more than one worker is expected, so a save on one worker is invisible on the others. | Give Datum shared stores, or set `datum.workers_expected` to 1. |
| `datum.E003` | ERROR | A runtime memory budget is below what the runtime module needs to start (its initial pages times 64 KiB). The message gives the least value. | Raise `datum.runtime.validation.memory` or `datum.runtime.pdf.memory` to at least that value. |
| `datum.E004` | ERROR | The runtime did not start within `datum.runtime.startup_budget`. The message names the phases finished so far. | Raise `datum.runtime.startup_budget`, or give the host more CPU: compiling the sandbox module takes seconds on a small virtual machine. |
| `datum.E005` | ERROR | The throttle counts in a shared storage and `datum.web.throttle.key_salt` is not set. | Set `key_salt` to a secret of at least 32 bytes, the same on every worker. |
| `datum.E006` | ERROR | The throttle storage cannot be built: a missing client library or an unusable address. The message names the failure's class, never its text. | Install the client library (for example the `redis` extra of `limits`), or fix `datum.web.throttle.storage`. |

W003, W004, E005 and E006 are raised only while a submission route (`submissions`, `validate`, `test` or `inspect`) is on. W004 for the snapshot, translation and builder stores is raised while the definition route or the builder is on.
