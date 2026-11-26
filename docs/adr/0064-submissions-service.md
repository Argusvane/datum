# ADR 0064: A Submissions Service: `@argusvane/datum-submissions`

## Status
Accepted.

## Context

The engine validates, canonicalizes and signs a submission and hands it to a `fetch`. Something
has to receive that submission and keep it: list what a form received, render and sign a PDF for
it on the server's behalf, count anything, and take a record back out of a PDF. A server sample
that ends at `store(values) { // wherever submissions go }` leaves all of that undone.

The service is one piece of code that holds what a server would hold and runs what a server would
run, with no DOM and no framework, so a page can play the server and a Node or HTTP host can run
the same code.

## Decision

1. **One service behind seams, in a package of its own.** `packages/submissions`
   (`@argusvane/datum-submissions`) holds a `SubmissionService` (register a form, receive a submission,
   list and inspect records, render its PDF, count, export, import) over four interfaces the host
   binds: `SubmissionStore` (where things are kept), `SubmissionValidator` (who judges),
   `SubmissionPdfRenderer` (who renders and reads PDFs) and `ServerKeys` (who signs). The package
   imports no DOM, no React and no Node API; `http-mapping.ts` says how an HTTP host puts the
   service on the wire.

2. **A page can be a host.** The package ships a browser binding of each seam: the store to
   IndexedDB (four object stores; a `Map` where a page has no IndexedDB), the validator to the
   sandbox program in a QuickJS of its own (the file a server runs), with the portable kernel
   answering until that QuickJS is up, the renderer to the in-process PDF kernel, and the keys to
   WebCrypto. A server host binds the same seams to a database, the PDF program and a key file
   (the table in the package's README).

3. **The verdict is the sandbox program's.** A submission is judged again on receipt, over the
   definition as registered, with the form's own `unknownFields` and log level; the outcome's errors
   go back to the form as host errors, and the run log is kept on the record.
   - A form the server does not know is refused whole (`unknown_form`); only a registration makes a
     form known.
   - A body that names no journey is judged by the form's journey (ADR 0178, decision 4).
   - A run that gave no verdict (it was cut off or threw, its verdict passed the sandbox's cap, or the
     registered form nests past the sandbox's limit) is refused under its own code and nothing is
     kept; a route answers 503 with the run's code, never a 422 that would tell the filler to fix
     answers that were not the trouble. The codes are in `packages/submissions/README.md`.

4. **A record's digest is SHA-256, hex, over the delivered document's canonical serialization:**
   sorted keys, no whitespace, the wrapper included when there is one. It is the record's identity
   across copies: the same bytes go into the PDF, so the PDF's attachment report names its
   record. The digest covers the whole document, so an extra unjudged top-level key makes another
   document.

5. **A submission is identified by its key, not its digest.** `receive` takes `{ document,
   submissionKey }`: a key matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, minted once per submit
   attempt and reused for its retries (the page's `datum-submit` event carries it as
   `detail.submissionKey`). The digest is no such key, since two people with the same answers share
   one; different keys are different records, even for identical answers.
   - The same key with the same digest is the first record: it is answered with that record's
     receipt and stored once, and two in flight under one key share one run.
   - A known key with another digest is a 409 `submission.keyConflict`, with no record echoed. The
     key is looked up before the document is judged, so a known key sent with another document that
     also fails a rule is a 409, never a 422. Every host answers in this order.
   - A rejected delivery leaves its key free: only an accepted record holds a key, so the author
     can fix the answers and send again under the same key.
   - A body without a key, or with a malformed one, is a 400 `bad_document` before anything is
     judged; the size check (decision 6) comes first.
   - An import keys on the file: `importPdf` uses `pdf:<sha-256 of the bytes>`, so the same file
     imported twice answers with the record it made.
   - `AcceptedSubmission` carries the key on every host, so a handler told to be idempotent on the
     form, version and key can be. Records keep `submissionKey`, and a record filter can select by it.

6. **`maxBodyBytes` (default 1 MiB) bounds a body.** The JSON of a delivered document (or of the
   values of a bare delivery, measured whole with its locale, journey id, form id and version) past it is refused before anything is judged or
   digested: `payload_too_large`, a 413. A host that takes uploads inline raises it; `Infinity`
   turns it off. A bare delivery's locale must be a language tag, as an enveloped one's (`bad_document`).

7. **`record.document` is the signed raw input, `record.values` the judged fold.** The document is
   kept byte for byte because its digest and signatures cover it; it can hold answers the fold
   withheld (a page the path skipped) and keys the form does not define. Anything that reads
   answers (exports, statistics, PDFs, a host's own code) reads `record.values`
   (`recordValuesOf(record)`), and a host that serves the document to a person serves the signed
   input, not the judged answers.

8. **A server PDF carries its record as `record.json`**, an associated file with the `Data`
   relationship, when the form's settings say so: rendered through the kernel's own `build`, then
   `render` or `fill`, the file added to the model between the two, the one place the one-call
   `document` op leaves no room for.
   - Under PDF/A-1 and -2 the kernel embeds nothing and says so (ADR 0060); the record's `attached`
     flag and the settings page say the same.
   - The name is not `submission.json`: that is a layout's own PDF/A-3 data export (ADR 0059), the
     answers alone, which may sit beside this file.

9. **In a page, the server's identity is an ECDSA P-256 key with a self-signed certificate,** minted
   with WebCrypto at the first signature (or on export), kept in the store, exportable as PEM so a
   verifier elsewhere can trust it.
   - The certificate is written by the PDF kernel's own DER encoder (`mintSelfSignedCertificate`,
     exported): v3, `ecdsa-with-SHA256`, `digitalSignature` + `nonRepudiation`, valid from five
     minutes before the mint, the same shape as the `openssl req -x509` line at the top of the
     server samples.
   - The key never leaves the host: the kernel gets a `PdfSigner`, as any server's key gives it.

10. **Statistics are computed from the records**, not from telemetry, as pure functions over
    `SubmissionRecord[]`, with fields classified by the component type's well-known name: records are the truth, work offline, and a delete changes the numbers.
    Export is CSV (one column per field, RFC 4180) or JSON. A CSV text cell (an answer, heading, record column or list
    entry) that begins with `=`, `+`, `-`, `@`, tab, CR or LF is written with a leading apostrophe,
    so a spreadsheet shows it as text instead of running it; numbers and booleans are written as
    they are (a list led by a number is guarded as a whole), and the translation exchange uses the
    same rule (ADR 0158). JSON is not guarded.

11. **Extraction prefers the attachment and falls back to template fields.**
    - A PDF handed back is read with `inspect`; its `record.json` gives the exact document, digest
      re-checked
    - a template-layout PDF without one gives its AcroForm values, mapped back through the layout's
      `fields` (component sources only, the rest noted)
    - a designed layout without the attachment is not extractable, and the service says so.
    - The imported record goes through the same validation as any other, with `source: "pdf-import"`
      and where it came from.
    - `importPdf` of a document already kept answers with that record and changes nothing.

12. **Signature verdicts are itemised, never a single boolean.** An envelope's WebAuthn checks
    (type, challenge, origin, relying party, presence, verification, signature) and a PDF's
    structural, cryptographic, certificate, trust and timestamp attributes are each reported;
    `unverifiable` is kept apart from `invalid`: the demo provider, an unknown algorithm, a
    credential not registered here and a certificate not trusted here are not failures, they are
    things this verifier cannot vouch for. The same report serves a stored record and a file
    inspected without being stored.

13. **`inspect` may return embedded files.** `attachments: "none" | "digest" | "data"` on the
    request, and `attachments` on the info with each file's name, digest, type and, for `data`, its
    bytes. One reader (`embedded-files.ts`) serves `verify` and `inspect`.

14. **The development validators are not for production.** `createKernelValidator` and
    `createInProcessPdfProvider` run the portable kernel and the PDF kernel in the host's own
    process, with nothing between a form author's rules and the server; the service logs one
    warning per process when either is bound. A production server binds the QuickJS program hosts.
    A page that plays the server uses the kernel by design.

15. **A Node server judges every delivery in a fresh sandbox, on a worker thread.**
    `createQuickJsValidator` from `@argusvane/datum-submissions/node` binds `QuickJsWorkerHost`
    (ADR 0181, decisions 4 and 5) by default: every call runs in a new WebAssembly instance that is thrown away after
    it, so nothing one submission's run did reaches the next, and a runaway native call is killed at
    its deadline (that delivery is a 503 `validator_unavailable`, the next runs on a new worker).
    `worker: false` binds `QuickJsFreshSandboxHost`: the same sandbox per call on the calling
    thread, with no hard stop. The page's Data tab keeps one sandbox for its session, since there
    the answers are the filler's own. The `/node` entry is separate so the page's bundle never
    reaches `node:worker_threads`.

## Consequences

- A registered form receives submissions and answers each with a receipt; its records, their PDFs
  and their signatures can be read; a downloaded PDF can be inspected or imported; a JSON
  submission can be inspected without being stored.
- An HTTP host over the same package is what the seams exist for: `qjs.mjs` as the validator, the
  PDF program as the renderer, a key file as the keys, a database as the store, `http-mapping.ts`
  as the routes.
- The submission key makes a retry, or a double delivery that reaches the server, one record.
- `parseCertificate` and `mintSelfSignedCertificate` are exported from `@argusvane/datum-pdf-kernel`; the
  submissions package depends on the kernel for those two and nothing else, and the provider that
  renders is handed in.
