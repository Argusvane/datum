# @argusvane/datum-submissions

A submissions server for Datum forms as a platform-neutral service (ADR 0064): a catalog of
form definitions, an endpoint that validates and keeps what a form sends, server-rendered and
signed PDFs that carry their record, statistics, itemised signature verdicts, and the way back
from a PDF to its record. Storage, validation, PDF rendering and keys are seams a host binds —
a page in the browser (IndexedDB and WebCrypto) or a Node server.

This is a whole example. The package is in this repository and is consumed as source, so run it as a test from this
folder: save it as `tests/quick-start.test.ts` (after `npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel
packages/submissions` from the repository root) and run `npx vitest run tests/quick-start.test.ts`.

```ts
import { expect, it } from "vitest";
import { InMemorySubmissionStore, createSubmissionService } from "@argusvane/datum-submissions";
import { createQuickJsValidator } from "@argusvane/datum-submissions/node";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } }
  ] } }
};

// What the page sends: the form and version it was drawn from, and the answers.
const envelope = (values: Record<string, unknown>) => ({
  versionContext: { form: { id: "visit-request", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: { locale: "en", values }
});

it("keeps a submission only when the sandbox accepts it", async () => {
  const validator = await createQuickJsValidator();   // the sandbox, on a worker thread
  const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
  await service.register(definition, { pdf: { enabled: true, sign: true, attachSubmission: true } });

  // One key per submit attempt: the same key again is a retry, not a second record.
  const refused = await service.receive({ document: envelope({}), submissionKey: crypto.randomUUID() }, { source: "api" });
  expect([refused.record.status, ...refused.errors.map((error) => error.code)]).toEqual(["rejected", "required"]);

  const { record, receipt } = await service.receive({ document: envelope({ fullName: "Ada" }), submissionKey: crypto.randomUUID() }, { source: "api" });
  expect([record.status, receipt.title]).toEqual(["accepted", "Submission received"]);
  await validator.dispose();
});
```

## Seams

| Seam | Interface | In the browser | On a server |
|---|---|---|---|
| Storage | `SubmissionStore` | `IndexedDbSubmissionStore` | a database; `InMemorySubmissionStore` in tests |
| Verdict | `SubmissionValidator` | `createProgramHostValidator(quickJsHost)` over `datum-sandbox-program.js` (it proves the program speaks this ABI before its first verdict; `{ checkProgramAbi: false }` when the host already did), `createKernelValidator()` meanwhile | the same program in a QuickJS: `createQuickJsValidator()` from `@argusvane/datum-submissions/node` (a worker thread), `qjs.mjs`, wasmtime. `createKernelValidator()` is for development and tests only |
| PDF | `SubmissionPdfRenderer` | `createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts, build: handlePdfRequest })` | the PDF program in a QuickJS: `provider` = `createQuickJsPdfProvider`, `build` = `__datum_pdf` | (`createInProcessPdfProvider` is for development and tests only)
| Keys | `ServerKeys` | `createServerKeys(store)` — WebCrypto P-256 + self-signed certificate | a key file, an HSM, a KMS behind a `PdfSigner` |

## What the service does

- `register(definition, settings?)` — keyed by `id@version`; settings decide unknown fields, log
  level, the PDF (layout, sign, attach `record.json`, PDF/A level) and the receipt. The kernel's
  structural check runs first: a definition with a repeated component id, two fields
  storing at one place, a malformed journey or PDF layout, one past a size cap, or nested past 32
  levels is refused, `invalid_definition` (422), before its formulas are compiled; the findings that
  only warn (an unknown type when `options.componentTypes` is given, a route the runtime ignores) are
  kept on the entry as `structureWarnings`. A form registered before keeps serving.
- `receive(input, { source })` — finds the form, judges the answers in the sandbox and by the
  server's hooks, digests the document, renders and signs the PDF if asked, writes the record,
  words the receipt (ADR 0052) or the host errors. Only an error of severity `"error"` refuses a
  record; warnings stay on an accepted one (ADR 0001). Every delivery carries the
  `submissionKey` the browser mints once per submit attempt (1 to 128 letters, digits, `.`, `_`,
  `:`, `-`; `SUBMISSION_KEY_PATTERN`); a body without one is refused, `bad_document` (400). The key,
  not the answers, says what one submission is: a retry of the attempt (the same key and the same
  digest as an accepted record of the form and version) is answered with that record and not kept
  again, so a double click or a proxy's repeat stores one; two people who give the same answers send
  two keys and are two records; a known key with another document is refused with
  `submission.keyConflict` (409), before that document is judged (an invalid one too), and never
  answered with the stored record. A rejected delivery is
  kept each time and leaves its key free. `importPdf` keys an import on the file (`pdf:<sha-256>`).
  A body over `maxBodyBytes`
  (default 1 MiB, in UTF-8 bytes of its JSON; a bare delivery is measured whole, locale and journey
  id included) is refused first with `payload_too_large` (413), before its key is read. A run that gives no verdict (it was
  cut off or threw: `wasm.execution_error`; its verdict passed the sandbox's 8 MiB cap: `outcome_too_large`; the
  registered form nests past what the sandbox reads: `definition.tooDeep`) is refused whole under its own code, a 503
  (see "On HTTP"), and nothing is kept. A
  body that names no journey on a form that has journeys is judged by its only journey or its
  `defaultJourneyId`, and refused with `journey.required` when there are several and no default
  (`journey.opensAs: "form"` keeps the whole form; ADR 0178).
- **`record.document` and `record.values` are two things.** `document` is what was delivered, byte
  for byte, because its digest and signatures cover it: the signed raw input, which can hold answers
  the fold withheld and keys the form does not define. `values` is what the sandbox judged (the fold's
  submittable answers, calculations recomputed). Read answers from `values` (`recordValuesOf`);
  serve `document` only as the signed input.
- `validate(input)` — `receive`'s verdict with nothing kept, for the whole submission, a journey
  or one page of it (below).
- `listRecords`, `getRecord`, `deleteRecord`, `getPdf`.
- `inspectRecord(id)` / `inspectDocument({ kind: "json" | "pdf" })` — every signature, check by
  check: WebAuthn checks on an envelope, structure / digest / certificate / signature value /
  validity / trust / timestamp on a PDF; `unverifiable` apart from `invalid`.
- `aggregate(key, spec)` / `exportRecords(key, "csv" | "json")` — counts per day, choices,
  numbers, completion, locale / version / source.
  A CSV text cell (an answer, heading, record column or list entry) that begins with `=`, `+`,
  `-`, `@`, tab, CR or LF is written with a leading apostrophe, so a spreadsheet shows it as
  text instead of running it; numbers and booleans are written as they are (a list led by a number is guarded as a whole).
- `importPdf(bytes)` — a server PDF back into a record: its `record.json`, else its template
  fields through the layout's mapping.
- `serverCertificate()` / `exportServerKey()`.

`http-mapping.ts` lists the routes an HTTP host mounts and the status each service refusal
maps to.

## Binding the sandbox on a Node server

```ts
import { createSubmissionService } from "@argusvane/datum-submissions";
import { createQuickJsValidator } from "@argusvane/datum-submissions/node";

const validator = await createQuickJsValidator({ plugins }); // worker thread; { worker: false } for the calling thread
const service = createSubmissionService({ store, validator });
// ... on shutdown
await validator.dispose();
```

Every validation runs in a sandbox of its own: a new WebAssembly instance of the engine, the program
and the plugins loaded into it, thrown away after the one call, so nothing one submission's run did
(a global, a plugin's state, memory it grew) reaches the next. The questions the host asks the program
on a validation's behalf (the scaled budget's `inspect`, the ABI probe at start) get one each too.
The sandbox runs in a `node:worker_threads` worker (`QuickJsWorkerHost`, ADR 0181), which builds the
next sandbox as soon as a call answers, so a lone delivery does not wait for it (a few ms for a small
form; about 66 ms per call when they come back to back). A run that sits in a native call past
`maxEvalMs` plus `killSlackMs` is terminated, that delivery answers `validator_unavailable` (503), and
the next one runs on a new worker over the same program and plugins. `{ worker: false }` gives each
validation a fresh sandbox on the calling thread (`QuickJsFreshSandboxHost`), built when it comes (about
60 ms per sequential call). It has no hard stop (a long native call holds the thread until it returns) and no
ceiling on the instance's WebAssembly memory, so `killSlackMs`, `bootTimeoutMs`, `maxWasmHeapBytes` and
`maxOldGenerationSizeMb` are refused with it, and a server keeps the worker. The host depends on
`@argusvane/datum-quickjs-wasm-host`; the main entry (`@argusvane/datum-submissions`) never reaches `node:worker_threads`, so
a page bundles it unchanged. `createKernelValidator()` and `createInProcessPdfProvider()` run
the kernels in the host's own process with no sandbox: development and tests only, and the service logs
one warning per process when it is given either.

## Checking answers without keeping them: `validate`

A journey (ADR 0112) can ask the server to check a page on Continue, and the whole journey
before its final Submit. `validate` takes what `receive` takes, plus a scope, and answers
`{ accepted, errors, journey? }` (`journey`, the path the server worked out, is for an in-process caller's
diagnostics; it is not on the wire):

```ts
const verdict = await service.validate({
  formId: "eligibility", formVersion: "1.0.0", locale: "en",
  values,                // every submittable answer, not only the page's
  journeyId: "apply",
  scope: "page",         // or "journey"; absent: the whole submission, as receive judges it
  pageId: "business"
});
```

- The server works the journey's path out again from the values, with the same kernel as the
  browser; it never takes a path from the client. `journey` in the answer is that path, for
  diagnostics only.
- `accepted` is true when nothing in `errors` has severity `"error"`; `errors` includes
  warnings.
- `scope: "page"` keeps the errors on the page's components (and their subtrees) and those on
  the form as a whole, bar `journey.exit` (an exit page is where Continue leads). A page the
  server's path does not take has its components folded to hidden, so the answer is clean.
- Nothing is stored: no record, no digest, no PDF.
- Refused as `bad_document` (400): a page check without a journey or naming a page the journey
  does not have, a `pageId` without `scope: "page"`, a scope other than `"page"` or `"journey"`.
  A journey the form does not have is a verdict, not a refusal: `journey.unknown`.
- `receive` refuses (`bad_document`) a body that carries `scope` or `pageId`, so a check sent to
  the delivery endpoint by mistake writes no record.

On HTTP it is `POST /api/submissions/validate`. The body is `{ document, scope, pageId? }`, which
`parseValidateRequest(body)` reads strictly and returns as a `ValidateInput` (the service's own `validate`
stays lenient for an in-process caller: bare values, an absent scope judging the whole submission): `document` is
the submission envelope, `scope` is required (`"journey"`, which names no page, or `"page"`, which names one in
`pageId`), and a body without the wrapper, without a scope or with an unknown one, a `pageId` beside
`"journey"`, or a page check without its `pageId` is `bad_document` (400). The answer is `200` with
`validationBody(verdict)` (`validateResponse` adds the status), whatever the verdict:

```
{ accepted, errors: [{ field?, code, message? }], notes?: [{ field?, code, severity, message? }] }
```

`errors` holds what blocks and nothing else (no `severity`); `notes` holds the warnings and info
(`severity` `"warning"` or `"info"`) and is absent, never `[]`, when there are none. `field` is left out for
a finding that names no component; `message` goes along when the sandbox or a hook supplied one. A
finding's parameters never do: a check that stores nothing must not become a way to read what a hook knows.
A refusal of the answers is a `200` with `accepted: false`, not a 4xx; on a delivery it is `422`
(`receiveResponse(result)`, with `errorsBody`).

The service takes bodies already parsed. Parse them with `parseStrictJson(text)`, which is `JSON.parse`
except that an object naming the same key twice throws (`DuplicateJsonKeyError`, a `SyntaxError`) instead
of keeping the last value, and answer that as any other malformed body: `bad_document` (400). The service's
own reads of JSON text (`inspectDocument({ kind: "json" })`, the `submission.json` a PDF carries) refuse
a repeated key the same way.

`statusOf(error)` maps a refusal to its status and `errorResponse(error)` to the status and body a route
answers (`{ errors: [{ code }] }`; `undefined` for anything that is no refusal the service knows). A run that
gave no verdict is `503` with the run's own code and no `Retry-After` (the same run fails the same way), on a
delivery and a check alike; so is an unavailable validator (`validator_unavailable`). A host context the
host got wrong (`hostContext` that is no plain object) is a programming error and throws a `HostContextError`
(a `TypeError`) from the service, which `errorResponse` answers `503 server.unavailable`, never a 500.

## Server hooks

Checks only the server can make — against its own records, a registry, a secret — go in a
`ServerValidationRunner` (from `@argusvane/datum-engine`), with the services its hooks may read:

```ts
const service = createSubmissionService({
  store, validator,
  serverValidationRunner: new ServerValidationRunner([duplicateCheck], { allow: ["registry"] }),
  serverServicesProvider: () => ({ registry })
});
```

- `receive` and `validate` run the hooks after the sandbox, over the values it sanitized (off-
  path and excluded answers gone, unknown keys handled as the form's settings say), and only
  when the sandbox found nothing blocking in the scope being checked.
- A hook reads `context.scope`: `{ kind: "submission" | "journey" | "page", journeyId?, pageId?,
  componentIds? }`. The values are every submittable answer in every scope, so a page's hook
  can compare with earlier answers; `componentIds` are what a page check shows errors on.
- What a hook reports on a component the fold does not validate (hidden, off the path) is
  dropped, as the sandbox drops a plugin validator's.
- A hook that throws — or a sandbox that does — refuses the call with `validator_unavailable`,
  which `statusOf` maps to 503, and nothing is stored. A journey reads a 503 as a server it
  cannot reach, and its `onUnavailable` setting decides what the person sees.
- What the filler sent is the filler's to fix, never an outage: a body nested deeper than
  `MAX_BODY_DEPTH` (256) levels is refused as `bad_document` (400) before anything reads it, and
  a sandbox that refuses the request before parsing it (`request_refused`: past its depth or
  length limit) is `bad_document` (400) too; a verdict too large for the sandbox's cap is
  `outcome_too_large`, a 503 like every run that gives no verdict.
- A browser that runs the same runner in-process (`FormRuntime`'s `serverValidationRunner`)
  and also checks the journey's end with this server runs its hooks twice.

## Data-source choices: the option snapshot

The kernel holds every answer to a choice that names a data source (`data.sourceId`) to that
source's list, and refuses the answer (`option.sourceUnavailable`) when the run carries no list for
it. The service knows no data source, so the host supplies the lists, two ways:

```ts
// Plain data registered beside the form: persists with the entry, never listed by listCatalog.
await service.register(definition, {
  validation: { unknownFields: "strip", optionSnapshot: { countries: [{ value: "CA", label: "Canada" }] } }
});

// Or worked out for each judgement (a function cannot be stored, so it goes to the service):
const service = createSubmissionService({
  store, validator,
  optionSnapshot: async (definition, values, locale) => ({ cities: await citiesFor(values.province, locale) })
});
```

- The provider's list wins over the registered one for the same source; a source in neither is
  unavailable and an answer picking from its choice is refused. Leave a source out of the
  provider's result to treat it as down.
- A provider that throws or rejects refuses the call: `validator_unavailable` (503), nothing kept.
- `receive` and `validate` both use it, so a journey's checks and the final delivery agree.

## The catalog and secret rules

`listCatalog()` serves every caller (it is what `GET /api/forms` answers): each entry's
`definition` and `compiled` copies are the public ones (the `server-secret` rules removed, as
`publicDefinition` serves them), a `formulaProblems` entry on a secret rule keeps `where` and
`code` but not the formula text, and the registered `optionSnapshot` is left out. The registering
host, which needs the entries exactly as registered, calls `listCatalogFull()`; never mount that
one on a route a browser can reach. `getEntry(key)` and `inspect(key, op)` are operator calls in
the same way (`inspect` with `op: "check"` also drops the text of a secret rule's problem, but the
`inspect` inventory names secret rules by design).

## Tests

```
npm run typecheck && npx vitest run
```

The store contract runs against the `Map` store and, under `fake-indexeddb`, the IndexedDB
store. PDF tests use the in-process kernel and Node's WebCrypto; the WebAuthn fixture comes from
`engine/tests/webauthn-fixture.ts`.
