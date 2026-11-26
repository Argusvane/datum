# FastAPI

The FastAPI packages add Datum's server side to your own FastAPI application:

- Form definitions, served by id.
- Submissions, validated by the same program the page runs.
- The form and builder assets.
- PDF render, fill, sign and verify.
- An RFC 3161 timestamp server.

You include a router for each capability. A router adds a route only when its setting is on (the management router's health routes aside), and who may call it is your own FastAPI dependencies, never a Datum policy. The FastAPI packages are tested on Linux. The [server hosts](/server-hosts) page compares the hosts.

## First run

This section takes the form from [Getting started](/getting-started) to a FastAPI application that receives its submission. Follow it from top to bottom. It needs nothing from the rest of the page.

You need:

- Python 3.12 or newer, and [uv](https://docs.astral.sh/uv/).
- Node 22 or newer, npm and git, to build the packages. They are not published to PyPI yet. The build downloads the sandbox runtime once.

1. **Build the browser files.** Run the commands of [Files you host](/files#getting-the-files) in a clone of the repository, then build the conformance suite, whose files the next step copies:

   ```sh
   (cd packages/conformance-suite && npm install)
   npm run conformance-suite:build
   ```

2. **Build the packages' files,** from the root of the clone:

   ```sh
   npm run fastapi:assets
   ```

   It writes the programs, the browser files and the sandbox runtime into the member folders under `integrations/fastapi/packages`. It may note that the settings schema was skipped; the application does not need it.

3. **Make a folder for the application** beside the clone, named `intake` here, and put `pyproject.toml` in it. The six `path` sources point at the built members; `uv sync` installs them with the `submissions` extra:

   ```toml
   [project]
   name = "intake"
   version = "0.1.0"
   requires-python = ">=3.12"
   dependencies = ["argusvane-datum-fastapi[submissions]", "uvicorn"]

   [tool.uv]
   package = false

   [tool.uv.sources]
   argusvane-datum-fastapi = { path = "../datum/integrations/fastapi/packages/argusvane-datum-fastapi" }
   argusvane-datum-core = { path = "../datum/integrations/fastapi/packages/argusvane-datum-core" }
   argusvane-datum-programs = { path = "../datum/integrations/fastapi/packages/argusvane-datum-programs" }
   argusvane-datum-sandbox = { path = "../datum/integrations/fastapi/packages/argusvane-datum-sandbox" }
   argusvane-datum-sandbox-wasmtime = { path = "../datum/integrations/fastapi/packages/argusvane-datum-sandbox-wasmtime" }
   argusvane-datum-qjs-wasm = { path = "../datum/integrations/fastapi/packages/argusvane-datum-qjs-wasm" }
   ```

   ```sh
   cd intake && uv sync
   ```

4. **Put the form where the host reads it.** Save the form the page uses (`forms/contact.json` in Getting started, id `contact`, version `1.0.0`) as `datum/forms/contact.json` in the application folder. That is the default of `datum.forms.locations`, `["datum/forms/*.json"]`, read from the folder the server starts in. The file's `id` is its key. Another place is `DATUM_FORMS__LOCATIONS='["path/*.json"]'`.

5. **Write the application,** `app.py`:

   ```python
   from uuid import uuid4

   from fastapi import FastAPI

   from datum_core.submissions import AcceptedSubmission, SubmissionReceipt
   from datum_fastapi import Datum, DatumSettings, routers


   def keep(accepted: AcceptedSubmission) -> SubmissionReceipt:
       print("received", accepted.form_key, dict(accepted.values))
       return SubmissionReceipt(id=str(uuid4()), reference=accepted.digest[:8].upper())


   datum = Datum(config=DatumSettings().to_config(), handler=keep)

   app = FastAPI()
   app.include_router(routers.submissions(datum))
   ```

   The handler stores the accepted submission and answers its receipt: the `reference` is what the form's confirmation shows. Here it prints the answers. A real handler stores them once per `(form_key, version, submission_key)`, because a retried attempt may reach it twice. Including a router also starts Datum, through the application's lifespan: with lifespans off, every Datum route but `/livez` answers 503 `server.unavailable`. Add `routers.forms(datum)` to serve the form's definition (its setting is `datum.web.api.endpoints.definition`), and `openapi_tags=DATUM_OPENAPI_TAGS` to `FastAPI(...)` to group the routes in the OpenAPI document. Without a handler the host logs the form and the receipt id, stores nothing and warns once (`datum.W003`).

6. **Switch the route on and run.** Every route is off until its setting is on. The submissions switch is all this story needs: it also loads the form files.

   ```sh
   export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true
   uv run uvicorn app:app
   ```

   The start takes a few seconds while the sandbox compiles. It ends with `Application startup complete.` and two `datum.W004` notices, which say that the throttle and the receipts are kept in this process's memory. To see the routes that are on, add `logging.basicConfig(level=logging.INFO)` to `app.py`: the log then holds `Datum routes on: submissions`.

7. **Send a submission.** In a second terminal, post the body a page sends: the envelope as `document`, and the key of the submit attempt.

   ```sh
   curl -s -X POST localhost:8000/api/submissions -H 'content-type: application/json' -d '{
     "document": {
       "versionContext": { "form": { "id": "contact", "version": "1.0.0" } },
       "submission": { "locale": "en", "values": {
         "fullName": "Ada Lovelace", "email": "ada@example.com", "topic": "question", "message": "Hello" } }
     },
     "submissionKey": "first-run-1"
   }'
   ```

   The reply is 200, and the server prints `received contact {...}`:

   ```json
   {"id":"9a60a8d1-967f-4680-afcf-f2fc63e81980","reference":"81396661","status":"accepted","digest":"813966615705ced43fc2ab4c6d752fd703fbf171f7af0157651bab2a321f56b6","handled":false}
   ```

   Send the same command again and `handled` is `true`: the same key gets the first receipt, and the handler is not called again.

8. **Send answers the form refuses.** Change `fullName` to `""` and the key to `first-run-2`. The sandbox judges the answers against the form's own copy and the reply is 422, which a page puts on the field with `setErrors`:

   ```json
   {"errors":[{"field":"fullName","code":"required"}]}
   ```

9. **Open the page through the application.** The page from [Send it to a server](/getting-started#send-it-to-a-server) posts this body to this route: both are this host's defaults. A browser lets a page read a reply only from its own origin, so serve the site folder of Getting started from the application. Add this at the end of `app.py`, after the routers, and run it again:

   ```python
   from fastapi.staticfiles import StaticFiles

   app.mount("/", StaticFiles(directory="../my-site", html=True))
   ```

   Open `localhost:8000` in a browser, fill the form in and press Send. The form shows "Your form was submitted" with the reference the handler answered, and the server prints the answers.

Two things to keep in mind from here:

- The `id` and `version` in the page's form must be the ones the host holds, so the page and the host read the same file.
- A page that stays on another origin needs CORS configured in your application: the host adds no CORS headers, and a preflight to the route answers 405.

## Extras and packages

The application above asks for the `submissions` extra. Python 3.12 or newer, asyncio. Add the extras you need:

| Extra | Adds |
|---|---|
| `submissions` | The programs, the sandbox engine (`argusvane-datum-sandbox-wasmtime`) and the throttle |
| `ui` | `submissions`, plus the form and builder browser assets |
| `pdf` | `submissions`, the PDF libraries and the PDF browser assets |
| `timestamp` | The RFC 3161 server and client |
| `revocation` | Offline revocation checking for the PDF trust policy |
| `testing` | The test helpers and an HTTP client for `TestClient` |
| `all` | Every extra but `testing` |

The packages:

- `argusvane-datum-sandbox` does all the work of running the programs, for any Python framework: see [Python sandbox library](/python-sandbox).
- `argusvane-datum-core` is the framework-free core over it and imports no web framework.
- `argusvane-datum-fastapi` adds the routers.
- `argusvane-datum-sandbox-wasmtime` is the engine: wasmtime, which ships native libraries for 64-bit Linux (glibc and musl), macOS and Windows on x86_64 and arm64.
- `argusvane-datum-programs`, the two asset distributions and the WASM runtime distribution carry the built programs, the browser files and the sandbox module.

Every `argusvane-datum-*` distribution must be at one version:

- The extras pin each distribution to the exact version of `argusvane-datum-fastapi`, so installing through an extra keeps them together.
- At start the host compares the build id of `argusvane-datum-core` with that of each resource distribution installed: `argusvane-datum-programs`, `argusvane-datum-assets-ui`, `argusvane-datum-assets-pdf` and `argusvane-datum-qjs-wasm` (the WASM runtime distribution). It refuses to start on a mix, naming each one's build.

## Switching routers on

Every endpoint is off by default. Settings are read from three sources:

- Environment variables: `DATUM_` plus the dotted name in capitals, `__` between levels.
- A TOML file named by `DATUM_CONFIG_FILE`.
- Keyword arguments to `DatumSettings`.

```sh
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true
export DATUM_WEB__API__ENDPOINTS__VALIDATE=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true
export DATUM_WEB__ASSETS__ENABLED=true
export DATUM_BUILDER__ENABLED=true
export DATUM_TSA__ENABLED=true
```

The first source that names a setting wins, in this order:

1. Keyword arguments to `DatumSettings`.
2. Environment variables.
3. The TOML file.

`datum.strict_env=true` turns the warning about an unknown `DATUM_*` variable into a refusal to start.

### Common settings

Every setting, with its default and bounds, is on [FastAPI settings](/fastapi-settings). The ones met most often:

- `datum.web.api.max_body_size`, default `1MiB`.
- `datum.web.api.problem_details`.
- `datum.runtime.validation.time_limit`, default `5 s`, and `memory`, default `32MiB`.
- `datum.host.time_zone`.
- `datum.web.throttle.limit`, default `60` per `60 s` for one key, and `datum.web.throttle.address_limit`, default `600`, for one address before the body is read.

A value that cannot work stops the start and names the setting, and an unknown `DATUM_*` variable is warned about. `python -m datum_core.config.schema --out <path>` writes the JSON Schema of every setting. The routes, bodies and codes behind these switches are on [the wire](/wire).

## Routers and endpoints

| Factory | Endpoints | Setting |
|---|---|---|
| `routers.forms` | `GET /api/forms/{key}/definition`, `GET /api/forms/{key}/translations`, `GET /api/data-sources/{id}` | `datum.web.api.endpoints.definition`, `.data_sources` |
| `routers.submissions` | `POST /api/submissions`, `POST /api/submissions/validate` | `.submissions`, `.validate` |
| `routers.authoring` | `POST /api/submissions/test`, `POST /api/inspect` | `.test`, `.inspect` |
| `routers.assets` | `host.json`, `datum-host.js` and the bundles under `/datum/assets` | `datum.web.assets.enabled` |
| `routers.builder` | `POST /api/forms`, `PUT /api/forms/{key}`, `PUT /api/forms/{key}/translations` | `datum.builder.enabled` |
| `routers.pdf` | `POST /api/pdf`, `/api/pdf/fill`, `/api/pdf/sign`, `/api/pdf/verify`, `GET /api/server/certificate` | `.pdf`, `.fill`, `.sign`, `.verify`, `.certificate` |
| `routers.tsa` | `POST /tsa`, `GET /tsa/certificate`, `GET /tsa/certificates` | `datum.tsa.enabled` |
| `routers.management` | `GET /livez`, `/readyz`, `/health`, `/info`, and `POST /recheck` | `datum.web.management.recheck` for `/recheck` |

### The check route

- **Request.** It takes `{ document, scope }` (and `pageId` for a page check). `scope` is required, and a bare envelope is 400 `bad_document`.
- **Answer.** 200 `{ accepted, errors }`, with `notes` for warnings only when there are any. An error or a note has a `message` when the sandbox or a validator gave one, and none otherwise.

A run that fails gives no verdict. The check route, `POST /api/submissions`, the dry run, the PDF routes and `POST /api/inspect` all answer it 503 with the run's code and no `Retry-After`, because the same run fails the same way. The codes are:

- `wasm.execution_error`
- `outcome_too_large`
- `definition.tooDeep`, for a registered form nested too deep

A definition posted to inspect that is nested too deep is the caller's: 422. Only a busy sandbox, 503 `server.busy`, carries `Retry-After`. The [wire reference](/wire#post-api-submissions-validate) has the whole contract.

### The dry run

The dry run answers one flat report, the same on every Datum host. [The wire reference](/wire#post-api-submissions-test) lists its members. It has no `accepted` member and no nested report: read `outcome`, and the run's time is `sandbox.elapsedMs`.

### Factory arguments

- Every factory takes `prefix=`, and every one but `tsa` takes `dependencies=`.
- The factories that run work for the caller or write (`authoring`, `builder`, `pdf`, `management`) require `dependencies`, so an unprotected router reads `dependencies=[]` in your source.
- At start the log lists the routes that are on, and warns (`datum.W001`) about a router included with every switch off.
- `datum.enabled=false` makes every router add nothing but the management router's health routes.

## Hooks and stores

Everything you plug in is a keyword of `Datum(...)`. A hook is a plain callable, sync or async, and a sequence keeps the order you give it.

| Keyword | Purpose |
|---|---|
| `handler` | Stores the accepted submission and returns the receipt |
| `pre_checks` | Refuse before the sandbox runs: `(IncomingSubmission) -> Allow \| Reject(code, message)` |
| `validators` | Host-side validation after the sandbox, with errors and warnings |
| `rules_providers`, `context_contributors`, `host_options_customizers` | Add host rules, context entries, or per-form run settings |
| `host_context` | Works out the values a form's `host.` names read, from the request (see below) |
| `definition_customizers` | Adjust the public copy of a form on its way to a filler |
| `builder_save_customizers`, `builder_save_validators` | Adjust or judge a definition before it is stored |
| `pdf_request_customizers`, `pdf_result_validators` | Adjust a PDF request, or judge the PDF before it leaves |
| `form_repository`, `snapshot_store`, `translation_store`, `idempotency_store` | Where forms, versions, translations and receipts live |
| `data_sources` | Providers for option lists |
| `throttle` | Your own rate limiter, in place of the one built from `datum.web.throttle` |
| `pdf_signer`, `timestamper` | The seal key and where seals get their timestamps |
| `signature_check` | Checks a signed submission's signature (the passkey routes are not served, so a signed wrapper answers 503 `signing.not_set_up` by default) |
| `timestamp_request_customizers`, `tsa_key_material`, `tsa_serial_allocator`, `tsa_log`, `tsa_client_store`, `tsa_time_source`, `tsa_transport` | The timestamp server's policy hooks, signing key, serial numbers, issue log, clients, clock and the transport of the client |
| `pdf_middleware`, `sandbox_middleware`, `pdf_trust_policy` | Wrap the PDF program or the sandbox; decide which anchors make a signer `trusted` |
| `pre_check_statuses` | Maps a pre-check's refusal to a status (403 and 429 by default) |
| `runtime`, `sandbox`, `engine_settings` | Replace the sandbox runtime or the engine's settings, for tests and special hosts |
| `error_translators`, `run_log`, `listeners`, `now`, `withheld_assets` | Extra error answers, the guest's run log, event listeners, the clock, assets the page glue must not serve |

- **Customizers** run in order, each over what the one before left, and the first refusal stops the rest.
- **Validators** all run, so every error is reported at once.
- **A refusal** is `HookRefusedError`: `forbidden` answers 403, `conflict` 409 and `invalid` 422, with a body of `errors`.

### Events

Events follow the effect and never veto it:

- `SubmissionValidatedEvent`, `SubmissionRejectedEvent`, `SubmissionThrottledEvent`, `SubmissionRedeliveredEvent`, `JourneyCheckedEvent`
- `FormDefinitionSavedEvent`
- `PdfRenderedEvent`, `PdfVerifiedEvent`
- `TimestampIssuedEvent`, `TimestampRefusedEvent`
- `DatumRuntimeReadyEvent`, `SandboxRunInterruptedEvent`

### Stores

The stores that ship are in memory.

- The start warns (`datum.W004`) when a per-process store is in use.
- The start fails (`datum.E002`) when the builder is on with in-memory stores and more than one worker.
- The timestamp server refuses to start with in-memory serials unless `datum.tsa.allow_memory_stores` acknowledges a single instance.

The store protocols are the seam: implement one over your database and hold it to its contract with the classes in `datum_core.testing`.

### The host context

A rule can read a fact about the visit, such as `host.role`. The server judges those rules only with values it works out itself. It never reads them from the request body. Give `Datum` one `host_context` provider. It takes the form key and the call's context, and answers a JSON object or `None`. Read the person from the context's `principal`, which your `principal` dependency answers from the request:

```python
from fastapi import Request
from datum_fastapi import Datum

def current_user(request: Request) -> object | None:
    return getattr(request.state, "user", None)

def host_context(form_key: str, context) -> dict[str, str] | None:
    user = context.principal
    return {"role": user.role} if user is not None else None

datum = Datum(principal=current_user, host_context=host_context)
```

What the provider answers decides how `host.` rules are judged:

- **No provider, or `None`.** Every rule that reads `host.` is left unjudged, as before.
- **An object, even an empty one.** Every such rule is judged, and a name it does not hold has no value.
- **A raise, or something that is not a JSON object within the sandbox's bounds (64 levels deep).** This is a fault in your application: the call answers 503 `server.unavailable` and nothing is judged.

Where it applies:

- The provider is asked for the check route, submissions, the dry run and the PDF routes.
- A retried submission keeps its first verdict and asks nothing.
- The handler sees the same values as `AcceptedSubmission.host_context`, and a PDF is drawn with them.

[Values from the host](/formulas#values-from-the-host) shows the formulas.

## Builder and drafts

`datum.builder.enabled` adds `POST /api/forms`, `PUT /api/forms/{key}` and `PUT /api/forms/{key}/translations`, and the author's copy at `GET /api/forms/{key}/definition?public=false`, which only `routers.builder` serves.

- **Access.** Protect the router with `dependencies=`.
- **Checks.** The sandbox kernel checks a save, and it is refused with 409 `form.outdated` when it builds on an out-of-date version. The bodies and codes are on [the wire](/wire#builder).
- **Stores.** With in-memory stores and more than one worker the start refuses a builder (`datum.E002`).

The router does not serve draft routes. A `server:` draft store calls four routes you write yourself: see [Drafts](/drafts).

## Serving the form from the host

`datum.web.assets.enabled` serves `host.json`, the page glue `datum-host.js` and the bundles under their build id. [Server hosts](/server-hosts#the-page-glue) shows the page code and lists every `DatumHost` method.

## Sealing PDFs

The seal needs a key. Put it in files and name them.

```sh
export DATUM_PDF__SEAL__ENABLED=true
export DATUM_PDF__SIGNING__TYPE=PKCS12
export DATUM_PDF__SIGNING__PKCS12_FILE=/etc/datum/seal.p12
export DATUM_PDF__SIGNING__PKCS12_PASSWORD=...
```

| Setting | Does |
|---|---|
| `datum.pdf.seal.enabled`, `.layouts`, `.certify`, `.reason`, `.location`, `.visible` | Turn the seal on, limit it to some layouts, and set what the signature says. Without a key the start warns (`datum.W013`). |
| `datum.pdf.signing.type`, `.pkcs12_file`, `.pkcs12_password`, `.key_file`, `.cert_file`, `.key_password` | The key: a PKCS#12 file, or a PEM key and a certificate chain. Or pass your own `pdf_signer`. |
| `datum.pdf.seal.timestamp` | Ask for a token over each seal. With no [timestamp source](/timestamps#on-a-built-host) the start warns (`datum.W011`). |
| `datum.pdf.signing.trust_anchors`, `.retired_certificates` | Anchors the verify route builds a chain to, and the certificates the seal key replaced. |
| `datum.pdf.seal.posted_answers` | Seal the PDFs of posted, unstored answers with the real key. Off, they keep a test seal. |

Where the seal gets its timestamps, a server you name or the host's own, is on [Timestamp server](/timestamps). Every setting is on [FastAPI settings](/fastapi-settings#datum-pdf).

## Access control

Datum ships no access policy. Pass your own FastAPI dependencies, and they run before Datum's own checks, so a refused caller meets your 401 or 403 first.

```python
from fastapi import Depends

app.include_router(routers.builder(datum, dependencies=[Depends(require_author)]))
app.include_router(routers.management(datum, dependencies=[Depends(require_operator)]))
```

- **403 body.** `FastAPI(exception_handlers=access_errors(datum))` gives your 403 the catalog's `access.denied` body.
- **Caller and language.** `Datum(principal=..., locale=...)` take dependencies that name the caller and the language for the hooks.
- **Proxy.** Behind a proxy let the ASGI server decide `request.client` (uvicorn's `--proxy-headers`), because the throttle never reads `X-Forwarded-For` itself.
- **CSRF.** FastAPI has no CSRF protection of its own and Datum adds none, but the JSON endpoints accept `application/json` only.
- **Server-secret rules.** The definition with its server-secret rules is reachable only through `routers.builder`.

## Testing

- Starlette's `TestClient` as a context manager runs the lifespan, so Datum starts once for the block.
- Share one app across a module's tests, because the runtime compiles its sandbox module on start.
- Install the `testing` extra.
- To test without the sandbox, pass `runtime=` or `sandbox=` to `Datum`.

`datum_core.testing` has contract classes that hold a store of your own to its protocol. To check a running deployment against the wire contract, run `datum-host-check` from the [conformance suite](/conformance).

## Health and logs

- Requests are named in the logs by the `X-Request-ID` header, or the trace id.
- The management router's `/health` reports the runtime and the stores, and `/readyz` reads the runtime alone.
- Datum's own checks log under `datum.checks` with stable ids; `datum.silenced_checks` silences a notice or a warning by id (never an error). [FastAPI settings](/fastapi-settings#start-up-checks) lists every id, its cause and what to do about it.

## What is not served

- **No passkey routes.** A form cannot require a passkey signature here, and `DatumHost.passkeys()` is refused in the page unless you pass an `endpoint`.
- **No SQL store.** The stores that ship are in memory.

To run more than one worker, see [Server hosts](/server-hosts#running-more-than-one-instance).

## Supported versions

- **Python.** 3.12 and later.
- **FastAPI.** 0.133 or newer, with Starlette 1.x.
- **wasmtime-py.** Held to one tested major at a time.

Every setting is on [FastAPI settings](/fastapi-settings), and every route on [The wire](/wire).
