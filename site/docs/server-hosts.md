# Server hosts

A server host adds Datum's endpoints to an application in your own framework:

- Form definitions by id and version.
- Submissions validated in the sandbox.
- PDF render, fill, sign and verify.
- An RFC 3161 timestamp server.
- Passkey registration and signed-submission verification.

Every host does the same things in its framework's idiom with that community's standard libraries. The wire is the one thing that is identical: the [endpoint catalogue, the error codes and statuses](/wire) and the sandbox interface.

| Host | Language | Status |
|---|---|---|
| Spring Boot | Java, Spring Boot 4, MVC and WebFlux | Built |
| FastAPI | Python | Built, without the passkey routes |
| Quarkus | Java | Planned, over the same Java libraries as Spring Boot |
| ASP.NET Core | .NET | Planned |
| NestJS | TypeScript | Planned |

A framework without a host of its own can still run the two programs: see [Your own server](/server-programs). On the JVM, the [Java sandbox library](/java-sandbox) runs them for any framework, with the same hardening the Spring Boot host uses. The planned rows have no host yet; the worked examples there, such as [Validate a submission](/server-example-validate), show the same run in Node.js, Java, .NET and Python. They are written to show what a host does underneath. On Spring Boot or FastAPI, use the host.

Three things hold for every host:

- Neither built host is on Maven Central or PyPI yet: both are built from the repository. [Spring Boot](/spring-boot#first-run) and [FastAPI](/fastapi#first-run) have the steps.
- Access is the application's security, never a Datum access policy.
- Every endpoint is off by default and switched on by the application, with the enabled routes logged at start.

## Where to start

Each route below ends with a server that takes the submission the page from [Getting started](/getting-started#send-it-to-a-server) delivers: `POST /api/submissions` with `{ document, submissionKey }`.

| You have | Start with | What it takes |
|---|---|---|
| A Spring Boot application, or Java | [Spring Boot: first run](/spring-boot#first-run) | A JDK, the repository build and a local Maven install |
| A FastAPI application, or Python | [FastAPI: first run](/fastapi#first-run) | Python, uv and the repository build |
| Another framework or language | [Validate a submission](/server-example-validate) | One endpoint of your own, a WebAssembly runtime and two files from the built folder |

The form the server holds must be the one the page shows: the delivery names the form's `id` and `version`, and the server checks the answers against its own copy. Serve the page's definition from the same file, or point the form's `src` at the host's definition route.

A page on another origin than the server needs CORS, which the application configures: see [Different origins](#different-origins).

## Spring Boot

The Datum starters bring no web stack and map their routes on whichever one is there.

| Starter | Brings |
|---|---|
| `datum-spring-boot-starter-submissions` | The sandbox runtime, the programs, form registration, the submission receiver |
| `datum-spring-boot-starter-ui` | Submissions, the form and builder assets, the page glue, the builder write endpoints (off) |
| `datum-spring-boot-starter-pdf` | PDF render, fill, sign and verify; the PDF browser assets; the timestamp client |
| `datum-spring-boot-starter-timestamp` | An RFC 3161 server and client, standalone |
| `datum-spring-boot-starter-webauthn` | The passkey ceremony and signed-submission verification |

- Storage, keys and the PDF renderer are seams you bind with beans; the SQL stores ship as reference DDL with a schema-initialisation mode.
- Lifecycle hooks run a customizer before the engine or store, a validator after, one handler, then an event.

[Spring Boot](/spring-boot) covers the starters, the routes and the seams, and [Spring Boot properties](/spring-boot-properties) lists every property.

## FastAPI

A framework-free core holds every decision, and the FastAPI binding is thin.

- `argusvane-datum-core` is the synchronous core with no web framework imported.
- `argusvane-datum-fastapi` adds the routers and async facades.
- `argusvane-datum-sandbox` runs the programs, with `argusvane-datum-sandbox-wasmtime` as its engine (see [Python sandbox library](/python-sandbox)).
- `argusvane-datum-programs` and the asset distributions carry the built programs and the browser bundles.

The stores that ship keep records in memory; storage is a seam you bind. [FastAPI](/fastapi) covers the routers, the hooks and the stores, and [FastAPI settings](/fastapi-settings) lists every setting.

## The page glue

The UI starter (Spring Boot) and the assets router (FastAPI) serve the browser bundles and a small script, `datum-host.js`, that saves a page the plumbing it would otherwise copy: finding the bundles, the CSRF token, and wiring a form to the host's routes. It is optional. A page can fetch the routes in [the wire](/wire) itself.

Three files sit under the assets path (`/datum/assets` by default):

| File | What it is | Caching |
|---|---|---|
| `host.json` | Where things are: the build id, the assets base, the API base, the CSRF names, the bindings table. [The wire](/wire#assets-and-host-json) lists its members. | Never cached |
| `datum-host.js` | The page glue. A module, which also sets `globalThis.DatumHost`. | Never cached |
| `<buildId>/datum-form.js`, `<buildId>/datum-builder.js` and the files beside them | The bundles. | Immutable: the URL changes when the build does |

- The build id is why bundle URLs never go stale. The glue reads `host.json` once, and every bundle URL is built from it.
- `host.json` and the glue are fetched with the page's own credentials and only from the page's own origin, so a page that is not served from the host's origin writes its own `fetch` calls instead.

A form delivering through the host takes four lines:

```html
<script type="module" src="/datum/assets/datum-host.js"></script>
<datum-form id="f" src="/api/forms/contact/definition"></datum-form>
<script type="module">
  await DatumHost.load({ bundle: "form" });
  DatumHost.submit(document.querySelector("#f"));
</script>
```

`DatumHost.submit` listens for the form's accepted submissions and posts each to `POST /api/submissions` as `{ document, submissionKey }`, with `Content-Type: application/json`. The reply's receipt is shown with `setNotice`, and a refusal's `errors` go to `setErrors`.

### The methods

| Method | What it does |
|---|---|
| `DatumHost.config()` | Resolves with the parsed `host.json`. It is fetched once; a failed fetch is forgotten, so the next call asks again. |
| `DatumHost.load({ bundle })` | Imports `datum-form.js` (`bundle: "form"`, the default) or `datum-builder.js` (`"builder"`, which defines `<datum-form>` too) from the versioned assets path, once, and resolves with its module. Any other word throws. |
| `DatumHost.csrfToken()` | Resolves with the CSRF token: the cookie named in `host.json`'s `csrf.cookieName` (read on every call, because it rotates with the session), else a `<meta>` tag named `csrf.metaName`. Empty when the page has neither. |
| `DatumHost.submit(element, { headers })` | Wires a `<datum-form>` to `POST {apiBase}/submissions`. Sends the CSRF header and any `headers` you give (an object, or a function of the element that returns one: anti-spam tokens, a source reference). Gives up after 30 seconds. A 403 with no `errors` is read as a stale CSRF token and retried once with the current one. Returns a function that undoes the wiring. |
| `DatumHost.binding(element, { formKey })` | Sets the element's `binding` from `host.json`'s bindings table: the form's own route entry, else the default. Resolves with the id set, or undefined when the host names none. An id the page has not registered is reported by the element as `datum-binding-error` and the form is drawn by Datum's own binding. |
| `DatumHost.dataSources(sources, { formKey })` | Builds the element's `dataSources` property. `sources` is a list of ids served by the host, or an object of id to a URL or to the items themselves. Each id and locale is fetched once from `{apiBase}/data-sources/{id}` and kept; a source that fails or takes over 8 seconds gives no options for half a minute rather than holding the form up. `formKey` is sent as `?form=` so a hook can decide whether that form may read the source. |
| `DatumHost.builder(element, { formKey, status, seed, dataSources })` | Wires a `<datum-form-builder>` to the host's form routes: it loads the author's copy of the form into the builder and wires saving. `seed` is the definition to start from when the form does not exist yet. [Saving forms](/saving-forms#a-datum-host) covers how a save works. Needs `datum.builder.enabled`. |
| `DatumHost.passkeys(element, { formKey, endpoint, context, defaultLabel, labelPath })` | Wires a `<datum-form>` to the passkey routes: reads which passkeys the person has and what the form signs, gives the element its signing provider, and offers to make a passkey when none signs. Resolves with `{ headers, refresh, guard, dispose, signing }`; pass `headers: handle.headers` to `submit` so a browser without passkeys says so (`X-Datum-Signing: unavailable`) to a form that accepts that. The routes are read from `host.json`'s `paths.webauthn`; a host that names none (FastAPI) serves no passkey routes, and the call is refused unless you pass `endpoint`. |

### Events and codes

`DatumHost.submit` also raises two events on the element:

- `datum-host-accepted` has the receipt body as its `detail`.
- `datum-host-outdated` is raised on a 409 `form.outdated`, so the page can offer a reload that keeps the answers.

The builder wiring raises `datum-host-saved` after a successful save.

The codes `submit` writes itself, when there is no reply to read, are:

- `delivery.failed`: the network failed or the reply was not usable.
- `session.ended`: a 403 that was not the form's own refusal.

## Different origins

The hosts add no CORS headers and no security headers. A page on one origin that calls a host on another needs the application's own CORS configuration on the host, and the page's `connect-src` has to allow the host's origin. `datum-host.js` itself fetches with the page's own credentials and the CSRF cookie is the application's, so the glue is for a page served by the host's origin. [Security headers](/security-headers) lists what the page needs to send.

## Drafts

Neither host serves the draft routes that a `server:` draft store calls. [Drafts](/drafts) describes the four requests; you write and secure those routes yourself.

## Running more than one instance

A second instance, or a second worker, shares nothing with the first unless you give it somewhere to share. Go through this list before scaling out. Each row is a thing that must be one for every instance.

| What | Spring Boot | FastAPI |
|---|---|---|
| Rate limit | Bind a `SubmissionThrottle` bean over shared storage. The built-in throttle counts in memory per instance. | Set `datum.web.throttle.storage` to a shared address such as `async+redis://...` and `datum.web.throttle.key_salt` to the same secret of at least 32 bytes on every worker (`datum.E005`, `datum.E006`), or pass `throttle=`. |
| Retried submissions | Bind a `SubmissionIdempotencyStore`, or give the host a `DataSource` for the SQL one. Without it a retry that lands on another instance is treated as new. | Pass `idempotency_store=`. |
| Forms, versions and translations | Bind `FormDefinitionRepository`, `DefinitionSnapshotStore` and `TranslationCatalogStore`, or use the SQL stores. A builder save on one instance must be seen by the others. | Pass `form_repository=`, `snapshot_store=` and `translation_store=`. The start refuses (`datum.E002`) a builder on in-memory stores with more than one worker; set `datum.workers_expected`. |
| Timestamp serials, issue log, client keys | Give the host a `DataSource` and `datum.tsa.client-store=jdbc`, or bind `TsaSerialAllocator` and `TsaClientStore`. Otherwise the start is refused unless `datum.tsa.allow-memory-stores` says one instance. | Pass `tsa_serial_allocator=`, `tsa_log=` and `tsa_client_store=`. Otherwise the start is refused (`datum.E001`) unless `datum.tsa.allow_memory_stores` says one instance. |
| Passkeys | Bind SQL stores for `PasskeyRepository`, `PasskeyUseStore` and the challenges, and set `datum.webauthn.secret` to the same value of at least 32 bytes everywhere. Empty makes one at start, which one instance only can use. | Not served. |
| Database tables | Run the shipped migrations once and set `datum.jdbc.initialize-schema=never`. | Not shipped. |
| Signing keys | The same key and chain on every instance, through the same SSL bundle or key file, so the seal verifies as the site's own wherever it was made. | The same files and passwords everywhere. |
| Build | Deploy one version everywhere. Bundle URLs carry the build id, so an instance of a different build answers 404 for another build's files. | The same. |
| Client address | Set `server.request.header.forwarded.strategy` behind a proxy, so the throttle sees the caller. | Let the ASGI server decide `request.client` (uvicorn's `--proxy-headers`). The throttle never reads `X-Forwarded-For` itself. |
| Readiness | Use the `runtime` member of the `datum` health component. | Use `/readyz`. |

The warnings at start name what is still per process: `datum.W004` on FastAPI, and the start-up checks on Spring Boot.

## Conformance

A host is held to the wire by the conformance suite, three commands with JSON reports and exit codes for a CI job. `datum-security-check` runs the validation gate's attack vectors against a sandbox program or a live server and reports what passed, what was refused and with which code. `datum-host-check` holds a server to the endpoint catalogue. `datum-binding-check` draws a design-system binding against every feature a form has. Run them against your deployment before it serves a form, and in CI after. See [Conformance suite](/conformance), and [Hardening on a server](/wasm-hardening) for what the hosts do around every sandbox run and what is left to you.
