# The wire

Every host answers the same routes with the same bodies, statuses and codes. This page is that contract: what to send, what comes back, and what each refusal means. The Spring Boot and FastAPI hosts both hold to it, and [`datum-host-check`](/conformance#datum-host-check) tests a host against it. A host you write yourself should too.

The host pages say which setting switches each route on: [Spring Boot](/spring-boot#switching-routes-on) and [FastAPI](/fastapi#switching-routers-on). Every route is off by default, and a route that is off answers the framework's own 404.

## Conventions

| Topic | Rule |
|---|---|
| Base paths | `/api` for the form, submission, builder and PDF routes. `/api/webauthn` for passkeys. The [timestamp server](/timestamps#the-routes) has its own base, `/tsa`, and its own page. Each base can be moved by a setting; `host.json` tells the page where they are. |
| Request bodies | `application/json` (parameters such as `; charset=utf-8` and letter case are ignored). Any other type is 415 `unsupported_media_type`. The two exceptions are the PDF verify route, which takes `application/pdf`, and the [timestamp route](/timestamps#post-tsa), which takes a timestamp query. |
| Body limits | A JSON body larger than the host's limit is 413 `bad_document`, refused from `Content-Length` before a byte is read and again while counting a chunked body. The limit is `datum.web.api.max-body-size` (1 MiB by default), `datum.builder.max-definition-size` for the builder, and `datum.runtime.verify-max-bytes` for a PDF upload. |
| Strict JSON | A body that is not one JSON value, is nested deeper than 256 levels, holds a number JSON cannot carry or a lone surrogate, is 400 `bad_document`. The reply never echoes any of it. |
| Error body | `{ "errors": [ { "field": "fullName", "code": "...", "message": "..." } ] }`. `field` is the component id and is absent when the error belongs to no component. `message` is text for a person: a hook's own, or the form's wording from the sandbox. It is absent when there is none. A 500 carries neither `field` nor `message`. |
| Problem details | With `datum.web.api.problem-details` (Spring) or `datum.web.api.problem_details` (FastAPI) on, an error is `application/problem+json` instead: `type` (`about:blank`), `title`, `status`, `detail` and `code` (the first error's), `correlationId` and the same `errors` list. |
| Codes, never sandbox text | A code is stable and meant for a machine. Text from the sandbox or a rule never reaches a reply; it goes to the host's log. |
| Retry-After | Whole seconds. 429 carries the throttle's own wait. Of the 503s only `server.busy` carries it, as `datum.web.api.busy-retry-after` (5 seconds by default). |
| Correlation | A 500 is named in the host's log by the request id (`X-Request-ID` by default). In problem-details mode the same id is the reply's `correlationId`. |
| Caching | Writes and author's copies are `Cache-Control: no-store`. Definition replies carry the host's `forms.cache.definition` (`no-store` by default). |
| Content negotiation | `Accept-Language` picks the locale a hook sees for a definition. |
| Access | Who may call a route is the application's security. The hosts add no access policy, no CORS headers and no CSRF check of their own. |

### Codes that any route can answer

| Status | Code | When |
|---|---|---|
| 400 | `bad_document` | The body is not usable JSON, or is not the shape the route reads (for a submission: not an object, or members besides the ones listed below). |
| 400 | `bad_request` | A path or query parameter is not valid. `field` names it. |
| 403 | `access.denied` | The application's security refused the caller. |
| 413 | `bad_document` | The body is over the limit. |
| 415 | `unsupported_media_type` | The `Content-Type` is not accepted. |
| 422 | various | The request was understood and refused. The `errors` say why. |
| 429 | `flood` | Throttled, by the address limit or the per-form limit. `Retry-After` says how long to wait. Only POST routes are throttled. |
| 500 | `internal` | An unexpected failure. Nothing of the cause is in the reply. |
| 503 | `server.busy` | Every sandbox slot is in use. Try again after `Retry-After`. |
| 503 | `server.unavailable` | The sandbox or the host is not ready, or a run was interrupted. No `Retry-After`. |

### The order of checks

On a throttled JSON route (submit, validate, test, the PDF routes and the passkey routes listed below; the FastAPI host also throttles inspect) the host judges, in this order:

1. The application's own security.
2. The `Content-Type` (415).
3. The address limit (429).
4. The length (400, then 413).
5. The body read (413).
6. The strict parse (400).
7. The per-form throttle (429).
8. The hooks (403, 409, 422).
9. The work.

A refusal early in the list never reaches a later step. On those routes every request that passes the `Content-Type` check is counted by its address before its body is read, whether or not the body later parses or fits the size limit. The builder writes, the translations `PUT` and, on Spring Boot, inspect are not counted: they have no address limit and no per-form throttle. The per-form throttle counts after the parse, because its key names the form and the form is read from the body. Both refuse the same way: 429 `flood` with `Retry-After`.

## Forms

### GET /api/forms/{key}/definition

The form's definition as the page draws it, with the rules marked `server-secret` taken out. `key` is a form id, or `id@version` for one version.

| Part | Content |
|---|---|
| Request | `If-None-Match` is honoured. |
| 200 | The definition JSON. Headers: `ETag` (the SHA-256 of the definition, in quotes) and `Cache-Control`. |
| 304 | The `ETag` matched. |
| 400 | `bad_request`. The key is not a form key. |
| 403 | `access.denied`. |
| 404 | `form.notFound`. |

### GET /api/forms/{key}/translations

The host's translation catalogue for the form, in the same shape the builder saves. Honours `If-None-Match`.

| Status | Body |
|---|---|
| 200 | The catalogue JSON, with `ETag`. |
| 304 | The `ETag` matched. |
| 403, 404 | `access.denied`, `form.notFound`. |

### GET /api/data-sources/{id}

The options of a data source a form names. Query parameters: `locale` (defaults to the negotiated language), `form` (the form key, so a hook can decide whether that form may read the source) and any others, which are passed to the provider.

| Status | Body |
|---|---|
| 200 | `{ "items": [ { "value": "...", "label": "..." } ] }` |
| 403 | `access.denied`. |
| 404 | `data_source.notFound`. |
| 503 | `server.unavailable`, `server.busy` or `data_source.unavailable`. Only `server.busy` carries `Retry-After`. |

## Submissions

### The delivery

A submission is the form's envelope in a wrapper that also carries the key of the submit attempt.

```json
{
  "document": {
    "versionContext": { "form": { "id": "intake", "version": "1" } },
    "submission": { "locale": "en", "values": { "fullName": "Ada Lovelace" } }
  },
  "submissionKey": "k-7f3a9c"
}
```

| Member | Meaning |
|---|---|
| `document` | The envelope the form emits. It must name its form in `versionContext.form.id` and `version`, and hold the answers as `submission.values`. `submission.locale` is a language tag of up to 32 letters, digits and hyphens (`en` when absent). `submission.journey` names the journey the answers came through. |
| `submissionKey` | The key of this submit attempt: 1 to 128 letters, digits and `. _ : -`, starting with a letter or digit. The form mints one per attempt and sends the same one on a retry. Required on `POST /api/submissions`; a delivery without a usable one is 400 `bad_document`. |
| `scope`, `pageId` | Only on `POST /api/submissions/validate`: a check of the whole journey or of one page. `scope` is required and is `journey` or `page`; `pageId` is required with `page` and refused (400) with `journey`. |

The wrapper holds no other member. `POST /api/submissions`, `POST /api/submissions/validate` and `POST /api/submissions/test` always want the wrapper: a bare envelope is 400 `bad_document`. The document is at most 64 levels deep.

A signed delivery (`{ format, payload, signatures }`) is answered 503 `signing.not_set_up` by a host that has no passkey verification: FastAPI always does today. See [Signing](/signing).

### POST /api/submissions

Validates the submission with the sandbox program, hands it to the application's handler and returns its receipt.

| Status | Body and meaning |
|---|---|
| 200 | `{ "id", "reference", "status": "accepted", "digest", "handled", "receipt"?, "warnings"? }`. `id` and `reference` come from the handler's receipt. `digest` is the SHA-256 of the canonical document. `handled` is `false` for a new submission and `true` when the same submit attempt was delivered before and this is its first receipt again. `receipt` is any data the handler returned for the page. `warnings` lists `{ field, code, message? }` entries from validators that did not block. |
| 400 | `bad_document`: not an object, a missing form name or answers, an unusable key or locale. |
| 403 | `access.denied`, or a pre-check or hook refusal with the code it chose. |
| 404 | `form.notFound`. |
| 409 | `form.outdated` (the form's version is no longer served) or `submission.keyConflict` (the key was used with a different document). |
| 413, 415, 429 | As above. |
| 422 | The sandbox refused the answers: one error per entry, with the codes of the [validation reference](/validation). A 422 always means the answers were judged. |
| 503 | `server.busy` (with `Retry-After`), `server.unavailable` (a host context provider that fails is one), `validator_unavailable`, `data_source.unavailable` or `signing.not_set_up`, none of the others with `Retry-After`. A run that gave no verdict is a 503 too, with the run's own code and no `Retry-After`: `wasm.execution_error` (the run was stopped or failed), `outcome_too_large`, or `definition.tooDeep` when the form itself is nested too deep. It says nothing about the answers. A submitted document nested too deep is the caller's: 400 `bad_document`. |

A pre-check can map its refusal to another status (the hosts' defaults are 403 and 429). A refusal outside the table carries the same error body and no `Retry-After`.

### POST /api/submissions/validate

The same delivery, without storing or calling the handler. Use it for a live check, or for a journey's page check.

| Status | Body |
|---|---|
| 200 | `{ "accepted": true, "errors": [ ... ], "notes": [ ... ] }`. `errors` holds only what blocks, as `{ field?, code, message? }` entries, and is empty when accepted. `field` is left out when a finding names no field. `notes` is left out when empty and otherwise holds `{ field?, code, severity, message? }` entries for what does not block (`warning` or `info`). A verdict of "not accepted" is still a 200. |
| 403, 404, 409 | As on submit. 409 is `form.outdated`. |
| 400 | `bad_document`: the same refusals as submit, and a request that is not `{ document, scope, pageId? }` (no wrapper, no `scope`, a `pageId` with `scope: "journey"`, or no `pageId` with `scope: "page"`). |
| 413, 415, 429 | As above. |
| 503 | A run that failed is no verdict, so it is never answered as a 200 or a 422. It is a 503 with the run's own code (`wasm.execution_error`, `outcome_too_large`, or `definition.tooDeep` when the form itself is nested too deep) and no `Retry-After`, as on submit. The other 503s are `server.busy` (with `Retry-After`), `server.unavailable` or `validator_unavailable`. A submitted document nested too deep is the caller's: 400 `bad_document`. |

A form's `validate-url` posts this delivery: `{ document, scope, pageId }`, with `scope` always set and `pageId` on a page's check. The document is the envelope Submit would emit for the answers so far. Point `validate-url` at this route. How the form reads the reply is on [Journeys](/journeys#checking-between-pages-on-the-server).

### POST /api/submissions/test

The dry run, for authoring tools. It takes the same delivery and answers what each stage did, without storing anything. It is off by default and should be restricted to authors. The reply is one flat report, the same on every host.

| Status | Body |
|---|---|
| 200 | The report below, whether the document would be accepted or not. |
| 403, 404, 503 | As on submit. |

The members come in this order, and each is always present:

| Member | Holds |
|---|---|
| `outcome` | `"accepted"` or `"rejected"`. |
| `stage` | Where a rejection happened: `journey`, `sandbox`, `signature` or `server`. `null` when accepted. |
| `errors` | Every finding, in the order found, as `{ field, code, message, severity, stage, source }`. All six members are there on each finding, `null` where unknown. `severity` is `error` when none was given. Warnings and info sit here beside the blocking errors, so an accepted document can still list findings. There is no separate `notes` member. |
| `sent` | The answers as the caller sent them. |
| `values` | The sanitised answers the run kept. `null` when it kept none or never ran. |
| `visibilitySkipped`, `clientDerived`, `clockDependent`, `serverRules` | Four lists of component ids, described below. |
| `document` | The canonical text that was digested. `null` when no run happened. |
| `digest` | The SHA-256 of that text, in hex. `null` when no run happened. |
| `logs` | The run's log entries. Empty when it logged none. |
| `sandbox` | `{ elapsedMs, rules, unknownFields, logLevel }`: the run's time in milliseconds, the ids of the rule modules it loaded, and the two settings it ran with. `null` when no run happened. |
| `signature` | The signature check's verdict. `null` when no check ran. |

A refusal before any run, such as an unknown journey, still answers 200 with the findings and `sent`. Everything else is `null` or empty.

The four lists are always arrays of strings, and empty when nothing applies:

| Member | Holds |
|---|---|
| `visibilitySkipped` | Fields whose own `visibleWhen` the server could not replay. The server treats them as hidden when it checks what is required. |
| `clientDerived` | Fields whose answers were worked out in the browser. The server keeps them as sent. |
| `clockDependent` | Fields and pages whose rules read the clock. |
| `serverRules` | Fields whose `server` or `server-secret` rules the run applied. |

### POST /api/inspect

Asks the sandbox a question about a definition. It is off by default and should be restricted to authors.

```json
{ "op": "check", "definition": { "id": "intake", "…": "the definition" } }
```

`op` is `public`, `check`, `inspect` or `test`, as described under [the inspect and test ops](/server-programs#asking-questions-of-a-definition).

- A body that is not an object with a string `op` is 400 `bad_document`.
- The reply is the program's answer as it gave it, with status 200; a program-level refusal (`invalid_request`, `abi_mismatch`) is inside the body.
- The other statuses are 403, 404, 413, 415 and 429.
- A run that fails is a 503 with the run's code (`wasm.execution_error`, `outcome_too_large`), or `definition.tooDeep` for a registered form nested too deep, and no `Retry-After`.
- A posted definition nested too deep is the caller's 422.

## PDF

All four routes read the answers in the posted `document` as a submission would, run them through the PDF program and answer the bytes. They are off by default. The three that print are guarded by the application's security; verify and the certificate are public.

### POST /api/pdf, /api/pdf/fill, /api/pdf/sign

Request body, `application/json`:

```json
{ "document": { "…": "the envelope, as for a submission" }, "layoutId": "summary" }
```

`layoutId` is optional on render and sign, and required on fill, where it names a template layout. The body holds no other member that matters; others are ignored. `/pdf` renders, `/pdf/fill` writes the answers into the layout's fillable template, and `/pdf/sign` renders and seals with the server's key.

| Status | Meaning |
|---|---|
| 200 | `application/pdf`, `Cache-Control: no-store`. Headers: `X-Page-Count`; `X-Datum-Layout` when a layout was printed; `X-Datum-Pdf-Theme` when the form's binding suggests a PDF theme; `X-Signed-By` and `X-Signature-Field` when the file is signed. Header values are percent-encoded UTF-8. |
| 400 | `bad_document`; `bad_request` for a `Content-Length` that is not a whole number; `layout.notTemplate` on fill when the layout is not a template. |
| 403 | `access.denied`, or a hook refusal. |
| 404 | `form.notFound` or `layout.notFound`. |
| 413, 415, 429 | As above. |
| 422 | The answers were refused, with the submission's codes; or the program refused the form: `template`, `render_limit`, `unknown_component`, `conformance`, `attachment_budget`; or `form.outdated`. |
| 503 | `server.busy` (with `Retry-After`), `server.unavailable` or `signing.not_set_up`. A run that gave no answer is a 503 too, with the run's own code (`wasm.execution_error`, `outcome_too_large`, or `definition.tooDeep` for a form nested too deep) and no `Retry-After`. |

A program refusal with any other word, such as `signature` or `font`, is a 500 `internal`; the cause is in the host's log.

### POST /api/pdf/verify

The request body is the PDF itself, `Content-Type: application/pdf`, up to `datum.runtime.verify-max-bytes` (20 MiB on both hosts by default). The route is public and counts the throttle by address.

| Status | Body |
|---|---|
| 200 | The report, below. |
| 400 | `pdf.notAPdf` (the bytes are not a PDF) or `pdf.unreadable`. |
| 413, 415, 429 | As above. |
| 503 | `server.busy` (with `Retry-After`), `server.unavailable`, or a failed run: `wasm.execution_error` or `outcome_too_large`, with no `Retry-After`. |

The report holds:

- `sha256` and `bytes` of the file.
- `signatures`, one entry per signature.
- `documentId` and `documentIdSource` (`signed` or `current`).
- `warnings`.
- `trustPolicy` (`name`, `revocationChecking`, `validationTime`).

Each signature carries:

| Member | Meaning |
|---|---|
| `field` | The signature field, empty when no field links it any more. |
| `value` | `valid`, `invalid` or `unchecked`: the signature value under the signer's key. |
| `digestMatches` | The file still hashes to what was signed. |
| `certificateMatches` | The signed attributes name the signer's certificate. |
| `coversDocument` | Nothing was appended after the signature. |
| `intact` | Digest, binding and value all hold. |
| `trust` | `site` (the server's own key), `site_retired`, `trusted` (a chain to a configured anchor), `self_signed` or `unknown`. |
| `signingTime` | The signer's claim, ISO 8601, or null. |
| `trustedAt` | When the chain was judged, for a trusted chain. |

### GET /api/server/certificate

The server's signing certificate chain, PEM, signer first. 404 `certificate.notFound` when the host holds no signing key. The page reads it so that a viewer can tell the site's own signature.

## Builder

- These routes are on only with `datum.builder.enabled`, and only on a host that supplies a form repository that can save.
- They are guarded by the application's security.
- A write goes through the application's customizer and validator hooks and the kernel's check, then is stored.
- Every reply is `Cache-Control: no-store`.

How the builder uses them to save is covered on [Embedding the builder](/embedding-the-builder).

### GET /api/forms/{key}/definition?public=false

The author's copy, with the server-secret rules in it. It is the version a save builds on. The reply is the definition with its `ETag`.

### POST /api/forms

Creates a form from the definition in the body. The body limit is `datum.builder.max-definition-size`. A create or a save may carry an `X-Datum-Locale-Changes` header (up to 8 KiB of JSON, `{ "removed": [codes], "renamed": [ { "from", "to" } ] }`) that tells the host which languages the save removed or renamed.

| Status | Body |
|---|---|
| 201 | `{ "key", "version", "sha256", "savedAt", "catalog", "warnings", "kernelWarnings", "removedLocales" }`. Headers: `ETag` (the new SHA-256) and `Location` (the author's copy). |
| 400, 413, 415 | `bad_document` and `unsupported_media_type`. |
| 403 | `access.denied` or a hook refusal. |
| 409 | `form.exists`. |
| 422 | The kernel or a validator refused the definition: `errors`, plus `kernel`, a list of `{ code, where }` findings. Also `definition.tooDeep` and `definition.tooCostly`. |
| 501 | `forms.readOnly`: the repository cannot save. |

### PUT /api/forms/{key}

Replaces a form. Send the `ETag` you loaded as `If-Match`. A missing header or `*` saves without a check.

| Status | Body |
|---|---|
| 200 | As the create reply. `X-Datum-Removed-Locales` lists languages the save removed. |
| 404 | `form.notFound`. |
| 409 | `form.outdated`: someone saved first. The reply carries the current `ETag`. |
| 422, 501, 403, 400, 413, 415 | As on create. |

A stale, empty, weak or unparseable `If-Match` is 409, never 412. `If-None-Match` and the date headers are not read on a write.

### PUT /api/forms/{key}/translations

Replaces the form's translation catalogue. The body is the catalogue, or `{ "catalog": { ... } }`. `If-Match` works as on a definition save, against the catalogue's `ETag`.

| Status | Body |
|---|---|
| 200 | `{ "catalog", "savedAt" }`, with the new `ETag`. |
| 404, 403 | `form.notFound`, `access.denied`. |
| 409 | `form.outdated`, with the current `ETag`. |
| 422 | `catalog.invalid`, one error per problem. |

## Passkeys

On with `datum.webauthn.enabled` on a host that has the passkey module. Spring Boot serves these routes; the FastAPI host does not.

- Bodies are JSON up to 64 KiB.
- Replies are `Cache-Control: no-store`.
- A passkey is named in a path by its credential id (base64url).

The challenge, register and check-challenge routes are throttled; the others on this page are not. The checks on a throttled route run in this order (check-challenge has no body, so it has no steps 1 and 3):

1. The `Content-Type` (415).
2. The address limit (429).
3. The body (413, 400).
4. The form named (404).
5. Passkeys not set up (503).
6. The person's right to make a passkey here (403).
7. The per-form throttle (429).
8. The work.

| Route | Request | Success |
|---|---|---|
| `POST /api/webauthn/challenge` | `{ "context", "form"?, "label"? }`. `context` is `submit`, `amend`, `test` or `account`. Without `form`, the passkey is made ahead of time on a signed-in account. | 200. The registration options for the browser's `create()`: `challenge`, `token`, `expires`, `rp`, `user`, `userVerification`, `residentKey`, `excludeCredentials`, `pubKeyCredParams`, `attestation`. |
| `POST /api/webauthn/register` | `{ "token", "form"?, "label"?, "credential", "context" }`. The token is the challenge's, single-use and signed. | 201. `{ "id", "transports", "algorithm", "publicKey", "label", "createdAt" }`. |
| `GET /api/webauthn/passkeys?form=` | With `form`: what the page needs to sign that form. Without: the caller's own list. | 200. With `form`: `{ "passkeys": [ { id, transports, algorithm, publicKey } ], "signing": { mode, scope, placement, userVerification, statement?, unavailable, rpId, ready, register, signIn, signedIn, labelPath? } }`. Without: `{ "passkeys": [ { id, transports, algorithm, publicKey, label, formId, origin, browser, createdAt, lastUsed, revoked } ] }`. |
| `DELETE /api/webauthn/passkeys/{id}` | none | 200. `{ "id", "status": "deleted" or "removed" }`. A passkey that has signed a stored submission is kept with its label cleared, so the signature can still be checked. |
| `POST /api/webauthn/passkeys/{id}/check-challenge` | none | 200. `{ challenge, token, expires, rpId, allowCredentials, userVerification }`, a challenge to test that passkey with. |
| `POST /api/webauthn/passkeys/{id}/check` | `{ "token", "assertion" }` | 200. `{ "ok": true, "lastUsed": <epoch seconds> }`. |

Only the owner may list, remove or check a passkey; one that is not yours is 404 `passkey.notFound`, as one that does not exist.

| Status | Code | When |
|---|---|---|
| 400 | `passkey.bad_request`, `passkey.challenge` | The body is not the expected shape; the challenge expired or was already used. |
| 403 | `access.denied`, `signing.sign_in`, `signing.context`, `signing.register_off` | Anonymous caller where a sign-in is needed; a context that is not allowed here (`test` is open only to `datum.webauthn.test-roles`); the site does not make passkeys at its forms. |
| 404 | `signing.off`, `form.notFound`, `passkey.notFound` | The form is not signed; no such form; no such passkey of yours. |
| 409 | `passkey.exists`, `passkey.revoked` | The credential is already registered; the passkey was revoked. |
| 422 | `passkey.invalid`, `passkey.check`, `passkey.counter` | The registration did not verify; the test assertion did not verify; the signature counter did not go up, which happens when a passkey is copied. |
| 429 | `flood` | Throttled, with `Retry-After`. |
| 503 | `signing.not_set_up` | `datum.webauthn.rp-id` and `origins` are not set. |

How a form requires a signature, and what the submission carries, is on [Signing a form with a passkey](/passkey-signing).

## Assets and host.json

Served by the UI starter, outside the endpoint catalogue.

| Route | Reply |
|---|---|
| `GET /datum/assets/host.json` | JSON, `Cache-Control: no-cache`. See below. |
| `GET /datum/assets/datum-host.js` | The page glue, `no-cache`. See [Server hosts](/server-hosts#the-page-glue). |
| `GET /datum/assets/{buildId}/{path}` | A bundle file. `ETag` is the file's SHA-256, `Cache-Control` is immutable and long-lived, and a matching `If-None-Match` is 304. An unknown build id or path is 404. |

`host.json` holds:

| Member | Meaning |
|---|---|
| `buildId` | The id of the build the host serves. It is part of every bundle URL, so a new build never meets a stale cache. |
| `assetsBase` | The URL prefix of the bundle files, build id included. |
| `apiBase` | The base of the API routes. |
| `csrf` | `headerName`, `cookieName` and `metaName`: where the page finds the CSRF token and which header carries it back. |
| `bindings` | `default`, `routes` (a form key to a binding id) and `catalog` (`id`, `label`, `pdfTheme?`): which design-system binding draws each form. |
| `paths` | Where optional capabilities live, such as `webauthn`. Absent when none is on. |

## Management routes (FastAPI)

The FastAPI host also ships probes:

- `GET /livez` answers while the process does, with no body.
- `GET /readyz` is 200 when the runtime is up and 503 otherwise, with no body.
- `GET /health` and `GET /info` report the runtime and the stores.
- `POST /recheck` (off unless `datum.web.management.recheck`) runs the runtime check again.

Spring Boot serves the same through the `datum` actuator endpoint.
