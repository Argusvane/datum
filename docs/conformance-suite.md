# Conformance suite

`@argusvane/datum-conformance-suite` is a conformance suite for Datum's validation gate: the sandbox program that judges every submission on the server (ADR 0029, ADR 0142). It sends attack vectors at a program file or at a live server and reports PASS or FAIL per vector, with the expected and the observed result, as JSON and Markdown. The command is `datum-security-check`. The decision to build it is ADR 0151. The package also carries `datum-host-check` (a host's wire contract) and `datum-binding-check` (a form-renderer binding), below.

What a PASS means: on every vector the suite ran, the gate behaved as the contract in this page says. What it does not mean: the suite is not a penetration test, it does not look at the host's code outside the validation routes, and a vector that is `pending` or `advisory` does not fail the run. Read the report's list of skipped and pending vectors before you quote a PASS.

## Threat model

The suite attacks the gate as four kinds of people would:

- **A form filler** controls the answers, the HTTP body, the headers, file uploads and the browser. Browser-side validation is advisory only; the server-side run is the gate. Most vectors are written from here.
- **A form author** with builder access but no host admin rights controls the definition, its rules (formulas), validation scripts, data-source configuration and PDF layouts. The author must not escape the sandbox, read host secrets, hang the host, exhaust its memory beyond the configured limits or forge a passing outcome.
- **A data-source operator** returns hostile option lists and labels.
- **A network attacker** replays or alters submissions.

The host (Node, .NET, Java, Python), its configuration and the published ABI program are trusted. Each vector names its attacker in the report.

## What each class verifies

Every vector has a stable id (`CTL-01`, never reused), a severity (S1 bypass of validation or host compromise, S2 denial of service that survives the limits, S3 a limit weaker than documented or a browser and server that disagree, S4 hardening) and, in `explain <id>`, where it came from. These are the classes, in the terms an auditor can cite. `datum-security-check list` is the catalogue; it is generated from the code, so it is the list that counts.

| Class | Prefix | What a PASS shows |
| --- | --- | --- |
| Controls | CTL | The program is a real gate and not a stub: a valid submission is accepted and its stored values equal the pinned golden values, and a blank required field, an over-long text and a non-matching pattern are each refused with exactly the expected error. Unknown fields are stripped and hostile keys (`__proto__`, `constructor`) do not pollute anything. A program that accepts everything fails here first. |
| ABI | ABI | The program states the sandbox ABI it speaks, it is at or above the floor the suite expects, and it matches the manifest of the release it came from. A newer or older major, a missing or malformed `abi` and a request of no usable shape are refused with typed errors, never thrown. A stale program is caught here. |
| Isolation | ISO | A plugin or validator sees no network, DOM, process, module loader, timers, QuickJS `std`/`os`, console or performance clock; the wall clock and randomness are unreachable; a validator that returns nothing usable, or changes its answer between reads, is never accepted; it cannot read the delivered document and its mutations of its context do not leak. The host freezes the kernel's functions and the language's intrinsics before the plugins load, so a plugin that rebinds a kernel function or patches `Array.prototype.push` changes nothing for the next run, and a module that redefines a global such as `RegExp` with `Object.defineProperty` changes nothing another module reads (ISO-04). |
| Resources | RES | Every budget holds: a plugin that never returns is interrupted and the host stays usable; an allocation bomb stops at the memory limit and the next run is answered; the heap is recycled; oversize and too-deep requests, definitions and host data are refused with typed errors before they cost anything; catastrophic regular expressions are refused or bounded; unbounded logs, error lists and string growth are capped. Legitimate big input still passes. A formula text function over a very long answer gives no result at once instead of running to the deadline (RES-02); a run whose outcome passes 8 MiB is refused as `outcome_too_large` and the host answers the next run (RES-20); and, where the Node worker host is installed (`npm run check:source` from a checkout; the bundled command skips the row with the reason), a native call the interrupt handler cannot stop is killed by the host's own clock and the next run is judged on a fresh worker (RES-19). Heavy vectors (seconds and hundreds of MB) run only with `--heavy` or the full gate. |
| Options | OPT | The S1 class. A choice answer the form does not offer is never stored: not by spelling (case, padding, label), not by shape (object, list, number), not by posting it at a container or list key in another spelling, not by deep nesting, and not when the data source's snapshot is missing (the gate fails closed). Only the boolean `true` frees a source's answers, and only a plain text input sharing a storage key stands in for a sourced choice (OPT-11); a plugin-type pick of nested objects or lists is refused (OPT-12); a data grid's column constraints (required, length, pattern, file size and type) hold on every row's cell (OPT-13); a grid's row count is held to its minimum and maximum, an empty row posted as `{}` counted, with the codes `rows.min` and `rows.max` (OPT-14, ADR 0153; its variant `hidden-grid-held-to-the-row-cap` holds a hidden grid that is still submitted to the same 500-row cap, and `hidden-grid-own-maximum-not-checked` shows it is the cap alone: a hidden grid with `maxRows` 3 and ten rows is accepted, since only a forged post could exceed 500). A program that stores a choice the form does not offer has stopped being a gate. |
| Files | FIL | An uploaded file whose bytes pass its declared size by more than 1% plus 1 KiB is refused as `file.sizeMismatch`; a smaller understatement is judged by the size limit on the decoded bytes. File names that look like paths are reported, not trusted. |
| Context | CTX | Host context (`locale`, `today`, `formulaErrors`) of the wrong shape is read as absent, never trusted; a localized message is worded from the `translations` map the run context carries (ADR 0158: a run has no definition, so a vector's input holds the map beside `locale`) and, when the host passes one, the host catalog as `catalog`, read before the map under the same tag; clock-dependent rules say so instead of guessing; the host can relax formula errors only to a warning; a `hostContext` the host supplies decides `host.` rules (CTX-08: an admin-only required field is enforced for `{ role: "admin" }`, not asked of `{ role: "user" }`, and left unjudged with no context), a key it lacks reading as no answer. CTX-08 runs in program mode; a live host proves it passes its own context through the `host-context` capability of `datum-host-check`. |
| Canonical and digest | CAN | The canonical text and the SHA-256 digest of a submitted document are exactly the bytes an independent serializer produces, for the pinned golden case, for adversarial documents (`1e21`, `-0`, integer-like keys, lone surrogates, `U+2028`) and for the same run repeated; a validator cannot change them. The digest is what a signature and a receipt bind to. |
| Secrecy | SEC | A server-secret rule's text, the functions it calls and what a plugin threw stay out of the verdict, the logs, the public definition and the error bodies. Over every response of an endpoint run: no 5xx other than a typed 503, JSON in the contract's shape, no stack traces or file paths. |
| Definitions | DEF | Hostile form definitions given to the `check` and `public` operations: duplicate ids and data keys, reserved ids (`component.id.reserved`, `pdf.layout.id.reserved`, `journey.id.reserved`, `journey.page.id.reserved`), inverted limits (`component.limits.inverted`, a warning), required fields inside nested grids, size and depth caps, own `__proto__` keys, malformed types and journeys, loops, and bounded answers for 9,000 duplicates. The `check` answer owns the verdict on a definition's structure. Every row is enforced. Among the variants: DEF-07 `prototype-names-as-ids-only-warn` (`toString` only warns; `constructor` is refused as `component.id.reserved`, the sentence that names the word, and `component.id.invalid` is the grammar only) and `scope-words-as-ids-are-reserved` (`component`, `host`, `row` and `ancestor` as ids, nested ones too, each `component.id.reserved`); DEF-11 `reserved-journey-and-page-ids` (a journey or page id of a prototype name is `journey.id.reserved` / `journey.page.id.reserved`; the scope words stay free as journey ids); DEF-16 `pdf-layout-id-reserved`, `inverted-limits-only-warn` (`component.limits.inverted`, a warning), `pattern-that-does-not-compile` (`component.pattern.invalid`) and `chrome-part-ids-missing-or-repeated`. |
| Builder | BLD | The `builder` profile: hostile definitions saved to a suite-owned test form, and what the editing host does with them. Needs `--allow-writes`. |
| Receiver | REC | The HTTP contract of a receiving route: a body that is not a JSON object, a number JSON cannot hold, a body over the limit, values nested too deep, another form's id, an outdated form version, a bad locale, a malformed signed wrapper, an unknown journey, the wrong method, hostile keys. Each is refused with the documented 4xx and typed code, never a 5xx. A check stores nothing. A body without a `submissionKey` is refused. The submissions service answers a replay of the same key and digest with the first record (the same id), and a known key with a different digest with a 409 `submission.keyConflict`, never a second record for one key (REC-12's four rows: `same-attempt-twice` must answer the same record and is never refused, `key-reused-for-another-document` is the 409, `no-key` is the 400, `two-attempts-same-answers` makes a new record; the keys are minted once per run); different keys are different records (ADR 0052), and a 503 the run happens to meet carries a typed code such as `server.busy` (REC-16, never provoked). |
| Parity | PAR | The in-process kernel (browser) and the program (server) give byte-identical outcomes over the core and adversarial corpora and every vector that opted in, agree on curated built-in function calls, and agree on the digest. A difference is allowed only if it is on the divergence ledger with an ADR and it is still real. |
| Journeys | JRN | How a journey (ADR 0112) holds when the client lies about the path. Program mode: a path that ends at an exit page is refused (`journey.exit`) however it gets there; the answers of a skipped page are dropped from the judged values; wrong-typed and object-member-named journey ids are refused; `scope`, `pageId` and other smuggled members change nothing; a calculation reads the settled view (JRN-05). Endpoint mode: the same exit rows, hostile ids, and the receiver rule for a request that names no journey: the form's only or declared default journey judges it, or the answer is `journey.required` (JRN-07). |
| PDF output | OUT | The PDF program, run with `--pdf-program <datum-pdf.program.js>` (PDF ABI 4.0.0, or a later version of that major, with the `output-safety` feature; any other program leaves the class pending). It renders a fixture with hostile answers and the suite inspects the output bytes with pdf.js and raw scans: content-stream and text integrity, no active content or links, attachment Filespec and names, a size-honest attachment budget, bidi controls, over-wide atoms and missing glyphs, template `/V` escaping and stale appearances, metadata escaping, the render caps (an over-long answer is cut with `render.truncated`, a document past the page cap is refused as `render_limit`; OUT-13), a file that carries more bytes than it declares (`file.sizeMismatch`; OUT-14), executable, script and HTML attachments refused by claimed type and by magic bytes (`attachment.refusedType`; OUT-15), and, when veraPDF and openssl are present, PDF/A-3b conformance and a sealed signature. |
| Form tests | TST | The `test` op of `__datum_inspect` (ADR 0154): a host hands the program a form definition and test text and gets a report back. A sidecar of two scenarios is run and reported in order (one passed, one failed with the verdict it met, `summary` counting both), a parse problem is listed in `problems` and a scenario that cannot start is an `error` with its reason (TST-01; its variants include `list-in-an-added-row-cell-is-refused`: an `add row … with` that sets a list in a text cell is the error `action.refused` with `reason: value.notScalar` and the cell's path, before the row is made; and `list-in-an-added-checkbox-cell-is-stored-as-the-group`: the same list in a checkbox group's cell is stored as the group's record, as `set` does, and the submit is accepted); with no sidecar the definition's own `tests` entries run, reported under their ids, and a sidecar replaces them (TST-02); a request over a cap is refused as `invalid_request` naming `where` and `limit`, never thrown or cut short: more than 256 KiB of test text, more than 200 scenarios, more than 1,000 statements in one scenario, and a definition past the structure size caps (`where: "definition"`; TST-03); the ABI check comes first (`abi_mismatch` for a newer minor, another major or no `abi`) and tests that are not text are `invalid_request` (TST-04); the same request answers the same bytes twice (TST-05); a request exactly at a cap is run (TST-06, heavy). Program mode only. |

### Before a live run: the endpoint fixture form

The live endpoint rows (JRN-01, JRN-03, JRN-07 among them) judge the fixture form installed on the server. After a change to the fixture the installed form must be reinstalled (`datum-security-check fixture` prints the current definition; see `packages/conformance-suite/fixtures/README.md`). A missing or wrong fixture is **INCONCLUSIVE, exit code 3**, with a preflight line such as `the form has no journey "main" ... install the fixture form`, before any vector is judged. A stale one still carrying `main` is a FAIL on JRN-01's `check-the-exit-answers-through-main` row. The builder profile makes and removes its own form; its cleanup (and `builder-cleanup`) deletes the form with its records.

## Running it

The suite runs three ways. All print a report; all use the same exit codes.

**Program mode** takes a built sandbox program file and needs nothing else. This is the release check for a build artifact, and it is what CI runs.

```sh
datum-security-check --program packages/datum/dist/datum-sandbox-program.js
datum-security-check --program packages/datum/dist/datum-sandbox-program.js --format json,md --out report/
```

`--manifest` checks the program against the release's `manifest.json` (ABI and build). `--abi-floor` raises the ABI the program must answer, within the suite's major (4.0.0 by default, the golden file's; a lower floor is refused); `--budget-profile node|browser` picks the nominal budget the time bounds are multiples of; `--plugins <module.js>` registers a plugin module in every sandbox, for a program that ships with plugins; `--golden <file>` judges against another golden file.

**Parity mode** compares the kernel with the program. `--all` is program and parity together.

```sh
datum-security-check --program packages/datum/dist/datum-sandbox-program.js --parity
datum-security-check --program packages/datum/dist/datum-sandbox-program.js --all --gate release
```

**Endpoint mode** attacks a live server through its public routes. It needs ONE fixture form installed on the server for it (`fixtures/README.md` in the package has the steps for `@argusvane/datum-submissions`; `datum-security-check fixture` prints the definition). Nothing in the allowlist is ever PUT or DELETEd, no other form's route is touched and no redirect is followed.

```sh
datum-security-check fixture --format submissions
datum-security-check --endpoint https://site.example --form datum-security-suite --auth-header "Cookie: SESS=..." --out report/
datum-security-check --endpoint http://localhost:3000 --form datum-security-suite --allow-writes --i-installed-the-suite-fixture
```

It is read-only by default: only the form's check route (and a GET of the public definition) is used. `--allow-writes` also posts to the submit route, and only for a form that carries the fixture marker or that you vouch for with `--i-installed-the-suite-fixture`. Rate limits are obeyed: one wait for a `Retry-After` of at most 60 seconds, then the run stops INCONCLUSIVE. The credential is read from `--auth-header` or `DATUM_SC_AUTH`, is only ever sent, and never appears in a report. Every request goes out on a connection of its own (`Connection: close`, never a reused keep-alive socket), after a pause of `--delay-ms` (default 250) and with `--timeout-ms` (default 30000 ms) as its hard limit. Under `NODE_USE_ENV_PROXY=1` the connection goes through `HTTP_PROXY` / `HTTPS_PROXY` (and honours `NO_PROXY`), as Node's own fetch does; without it the suite connects directly. Endpoint mode is not a pull-request gate because it needs a live site; run it by hand before a release or on a schedule against a booted site.

From a checkout, `npm run conformance-suite:check -- --gate full` builds the program from source and runs it; that is the only place a program is built (the bundled command takes only `--program`).

The package's build holds its bundles to a size budget and fails over it: the security suite's bundles (`dist/index.mjs`, `dist/cli.mjs`) 3,500,000 bytes together (`scripts/build-cli.mjs`), `dist/host-check.mjs` 1,000,000 bytes (`HOST_CHECK_SIZE_BUDGET_BYTES` in `scripts/host-check-bundle.mjs`; it carries no engine and no QuickJS), and the binding check's `binding-check/dist/host.js` 1,500,000 bytes (`scripts/build-binding-check.mjs`).

Other commands: `list [--json]` is the catalogue, `explain <id>` shows what one vector sends and expects, `--only` and `--skip` take ids or classes (`ISO-03`, `isolation`, `ISO`).

## Reading a report

The first line is the verdict. Then the program (path, size, hash, detected ABI against the floor), the endpoint if any, and a count per status. Failures come first, each with expected and observed. Every result has a status:

| Status | Meaning |
| --- | --- |
| PASS | The gate behaved as the vector expects. |
| FAIL | An enforced vector observed something else. The run fails. |
| WARN | An advisory vector, or a pass with a note (for example the banner ABI differs from the real one). Does not fail unless `--fail-on warn`. |
| SKIP | Not run: pending under the release gate, heavy without `--heavy`, or not applicable to this runner. The row says why. |
| XFAIL | A pending vector, run under `--gate full`: the attack still works, and a known open item blocks the fix. |
| XPASS | A pending vector whose attack no longer works. Promote it to enforced. Fails the run only with `--fail-on warn`. |
| ERROR | The vector could not be judged (a program that will not start, a transport failure). On an enforced vector the verdict is INCONCLUSIVE. |

Gates: `release` (the default) runs enforced and advisory vectors; `full` also runs pending and heavy vectors and prints promotion hints. The verdict is FAIL if any enforced vector failed, INCONCLUSIVE if the run could not finish (preflight failed, rate limited out, an enforced vector errored), otherwise PASS. FAIL outranks INCONCLUSIVE.

Time bounds in endpoint mode (RES-11's 10 s, RES-16's and RES-17's) are judged on the HTTP exchange itself: from the moment the TCP connection is open to the last byte of the answer, summed over the row's requests. On https the TLS handshake comes after that point, so it counts: a slow handshake is the host's (or its terminator's) time. The pause between requests, DNS, the TCP connect and anything waiting in the client are not counted. A request with no answer before `--timeout-ms` counts its whole wait, so a hang is over any bound; and for the body-limit rows (RES-05, REC-03) a host that stops reading an over-limit body and never answers is a FAIL, not the WARN a different limit gets. Each endpoint result, and each of its rows, carries `exchange` in the JSON report: `requests` (the requests that went out), `connectMs` (DNS and TCP connect before the exchanges, outside the bound; 0 where unknown), `firstByteMs` (to the first byte of the answer) and `totalMs` (to the last, the figure the bound is held to). `durationMs` stays the wall time of the whole result, pauses included.

Exit codes: `0` PASS, `1` an enforced vector failed, `2` usage or configuration error, `3` INCONCLUSIVE, `4` internal error. Code 3 is non-zero so CI never reads "could not check" as success. The JSON report validates against `report.schema.json` (`schemaVersion` 1). New optional fields may appear within version 1 (as `exchange` did), and a reader validates against the schema shipped in the same build, never a pinned copy; the version is bumped for any change an earlier reader would reject; observed values are cut at 200 characters in the Markdown and the JSON holds the detail.

## The host conformance contract

A host that stores or forwards submissions conforms when, for every request that reaches its receiving route:

1. **Run `check` before persisting.** The sandbox program judges the submission first. Nothing is stored, signed, rendered or forwarded on a request the gate has not accepted, and a validation run itself (a page check) stores nothing.
2. **Serve only `public`.** The browser gets the definition from the `public` operation, which removes server-secret rules. A host never serves the stored definition, the `inspect` output over secret rules or a validator's source.
3. **Refuse on any problem.** A rejected verdict, a gate that did not answer, a budget refusal, an ABI mismatch, a stale or missing option snapshot, an oversize or malformed body: all are refusals with a typed code, and none is turned into an acceptance. The gate fails closed (ADR 0142).
4. **Never 500.** A bad request is a 4xx with a JSON body of the documented shape; a gate that is unavailable or busy is a typed 503, and so is a run that gave no verdict (`wasm.execution_error`, `outcome_too_large`, and `definition.tooDeep` of the registered form): the answers were not judged, so a 422 or a 200 verdict would be a lie. Only `validator.failed` (a rule module that threw inside the guest) is a verdict, a 422. A 5xx without a typed code, a stack trace, a file path or a rule's text in any body is a failure (SEC-05).

Endpoint mode checks 1, 3 and 4 from the outside; program mode checks the program that makes 2 possible.

## Host conformance (`datum-host-check`)

The endpoint mode above sends attacks and wants refusals. `datum-host-check` is the package's second command; it sends what a browser and an operator send and wants the specified answers: the wire contract every Datum host serves, whatever it is written in. It is the Node port of the Java host test kit (`integrations/jvm/tck/datum-host-tck`, the oracle: every `@Test` method is one case, with the same requests, assertions, order and skips), so Spring Boot, Quarkus, NestJS, FastAPI and .NET hosts are held to one table by one tool that needs only Node 22 (`dist/host-check.mjs`, no toolchain, no JDK). The Java JUnit interfaces stay for a Spring team's in-process tests (ADR 0152); the Node kit is the cross-host gate. A release runs both modes against the same test deployment.

### What the kit holds

| Capability | Cases | What it holds the host to |
| --- | --- | --- |
| `submissions` | SUB-01..07 | the golden control documents (CTL-01 accepted with a digest and receipt, CTL-02..04 refused with the kernel's errors), the journey check, the refusals before the kernel (409, 415, 413, 400, 404), a retry of one submit attempt (the same key) answered with the first receipt, another attempt with the same answers a second record, and a known key sent with another document -> 409 `submission.keyConflict`, also when that document fails a rule (a known key is answered before the document is judged, never 422); a body without a key is 400, an oversized one 413 before the key is read; oracle `SubmissionsContract#aSubmitAttemptIsOneRecordByItsKey`. SUB-03 holds the journey check to one verdict shape: `{accepted, errors, notes?}`, `errors` blocking only with entries `{field?, code, message?}` (no `severity`, no `"field": null`), `notes` left out when empty and otherwise `{field?, code, severity, message?}`. SUB-07 holds it to a strict request: the body is `{document, scope, pageId?}`, and a bare document, a missing or unknown `scope`, a `pageId` beside `scope: "journey"` and a page check with no page are each 400 `bad_document` before the kernel is asked |
| `submissions-test` | DRY-01..03 | `POST /submissions/test` reports the golden values; the report is one flat object of exactly 14 members (no `accepted`, no nested `report`, no `notes`), each with its type and presence rule, for an accepted document (DRY-02) and a refused one (DRY-03: `stage` `sandbox`, findings with all six keys) |
| `forms` | FRM-01..04 | the public copy under its key and the catalog key `id@version` (never the server-secret rule), the ETag and its 304, 404 `form.notFound`, and with the builder off a 404 without ETag or secret for the author's copy (`?public=false`) |
| `assets` | AST-01..05 | `host.json`, the immutable bundles under the build id, the glue, the builder's files following the builder switch, no path out of the assets |
| `builder` | BLD-01..04 | only someone who may build saves, `If-Match` and 409, the kernel's 422s, id rules, 409 `form.exists` |
| `pdf` | PDF-01..06 | posted answers print, refused answers do not, sign, the server's chain, verify, 404 `layout.notFound`, 415, 400 `pdf.notAPdf` (the seal cases are skipped, never passed, without `--pdf-signing`); PDF-06: two routes on one host get each route's catalog PDF theme, named in `X-Datum-Pdf-Theme` and drawn into the PDF (the kit's theme's text colour is in the content streams of its route's PDF and not the other's; skipped without `--pdf-bindings`) |
| `tsa` | TSA-01..04 | a granted RFC 3161 token over the digest with the nonce echoed, a PKI rejection for unreadable bytes, 403 for a session cookie then 415, public certificates |
| `passkeys` | PKY-01..04 | the signing block, who may ask for a challenge, the register refusals in order, a person's list, 404 for another person's passkey |
| `hardening` | HRD-01..05 | with the hostile rule module registered: a looping validator is cut within 20 s, memory without bound and a 40 MiB answer are refused, bytes after the answer frame refuse the run, and the next submission is answered. A run that gave no verdict is a 503 with its code (`wasm.execution_error`, `outcome_too_large`) and no `Retry-After`; only a verdict the kernel reached (`validator.failed`) is a 422; never a 200 or a 500; no body echoes the answer. HRD-05 sends the loop to `POST /submissions/validate` (scope `journey`): the same 503 `wasm.execution_error`, no `accepted` member, within 20 s |
| `runtime-down` | RDN-01..02 | a runtime that could not prove its program answers 503 (`server.unavailable` or `validator_unavailable`) to every submission and to a journey check, which carries no `accepted` member |
| `host-context` | HCX-01..04 | the host judges `host.` rules with a context it works out itself, never one the client writes, over the kit's fixture `datum-host-context` (`name` required; `admin_note` required and shown only when `host.role = "admin"`). The test header `X-Datum-Test-Role` stands in for a session. HCX-01: `admin` makes the check (journey and page scope) answer `{field: "admin_note", code: "required"}` and a delivery 422. HCX-02: `user` is accepted. HCX-03: no header (no context) is accepted, and the dry run lists `admin_note` in `visibilitySkipped`. HCX-04: `user` with a document that forges `hostContext` (on the envelope and on its submission), a `host` answer and an `admin_note` answer is still accepted, and the dry run's `values` hold no `admin_note` |
| `flood` | FLD-01..02 | 429 `flood` with `Retry-After`: FLD-01 from the per-form limit, FLD-02 from the address limit, which counts a body that does not parse before the parse (the host runs with a per-form limit of 30 and `address-limit` 200) |

Each capability runs as its own group in the order above (flood always last, whatever order `--capabilities` names them in). Every reply also passes the never-5xx rule: a 5xx other than a typed 503, or a non-JSON body on a JSON route, fails the case on the spot (a 401 or 403 may be the framework's own format). `datum-host-check list` prints the cases and `explain <id>` shows one case's requests, its expectations and its Java oracle.

### Options

```sh
datum-host-check --endpoint <base url> --capabilities <a,b,c> [options]
datum-host-check list | explain <id> | fixtures --out <dir>
```

| Option (`datum.tck.<key>` in a `--config file.properties`) | Meaning |
| --- | --- |
| `--endpoint <url>` (`base-url`) | the host's base URL with its context path; required |
| `--capabilities a,b,c` | the capabilities the host serves; required |
| `--api-path` (`/api`), `--assets-path` (`/datum/assets`), `--tsa-path` (`/tsa`), `--webauthn-path` (`/api/webauthn`) | where the routes are mounted (the API and WebAuthn paths may not be empty) |
| `--builder-enabled` | the host serves the builder's files, so AST-04 expects them |
| `--pdf-signing` | the host holds a PDF signing key; without it the seal cases are skipped |
| `--pdf-bindings` | the host routes the two fixture forms (`datum-security-suite`, and its copy `datum-security-suite-b` that `fixtures --out` writes as `fixture-form-b.json`) with `datum.bindings.*`: `datum-security-suite-b` to a binding whose catalog PDF theme is the kit's `datum-host-check-pdf` (text `#123456`; `fixtures --out` writes it as `fixture-pdf-theme.json`, supplied as `datum.bindings.pdf-themes.datum-host-check-pdf`), `datum-security-suite` to one with another theme, both forms installed; without it PDF-06 is skipped |
| `--signing-form <key>`, `--build-form <key>` | the form a passkey signature is required for (passkeys), the form the author may read and save (builder); a capability whose key is missing asserts nothing (exit 2) and the host is not touched for it |
| `--header Name=Value` | sent on every request (repeatable); values never reach the report |
| `--person-header Name=Value`, `--other-person-header Name=Value` | the signed-in person and another one (a session cookie, a bearer token); a visitor sends neither |
| `--csrf cookie:<cookie>:<header>` | the cookie-token recipe (Spring Security: `cookie:XSRF-TOKEN:X-XSRF-TOKEN`): `GET /` hands each persona the cookie, which is sent back, and the header carries it on every write |
| `--only <ids>`, `--skip <ids>` | case ids (`SUB-01,FRM-02`) |
| `--out <dir>` | write `report.json` and `report.md` |
| `--timeout <ms>` | per request, default 120000 |

### The switches each capability needs

Every Datum route is off until the application switches it on. Before any case runs, the preflight checks what the named capabilities need and says which switch is missing (exit 3, inconclusive, not a failure of the host's contract).

| Capability | What the host needs (Spring Boot property) |
| --- | --- |
| `submissions`, `forms`, `assets`, `pdf`, `flood` | the fixture form `datum-security-suite` at version 1 installed (`datum-host-check fixtures --out <dir>` writes `fixture-form.json`; add `file:<dir>/fixture-form.json` to `datum.forms.locations`); `datum.web.api.endpoints.submissions`, `.validate`, `.definition` and `datum.web.assets.enabled` as the capability uses them |
| `submissions-test` | `datum.web.api.endpoints.test=true` |
| `builder` | `datum.builder.enabled=true`, a policy that lets the author build `--build-form` and refuses the viewer |
| `pdf` | the PDF starter, `datum.web.api.endpoints.pdf`, `.fill`, `.sign`, `.verify`; a signing key for `--pdf-signing` |
| `tsa` | `datum.tsa.enabled=true` |
| `passkeys` | `datum.webauthn.enabled=true`, origins, relying-party id and secret, and a form that asks for a signature (`--signing-form`) |
| `hardening` | the test deployment below |
| `runtime-down` | the test deployment below |
| `host-context` | the test deployment below, with the dry-run route on (`datum.web.api.endpoints.test=true`) and the validate and submissions routes |
| `flood` | a submission limit the run can exceed (the kit posts at most 120 times; Spring Boot: `datum.web.throttle.limit=30`) and an address limit the run can exceed (FLD-02 posts up to 400 times, and the cases before it post fewer than 200; Spring Boot: `datum.web.throttle.address-limit=200`, FastAPI: `DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200`) |

The submissions, builder, pdf and passkeys cases write records: aim the kit at a test deployment.

### Fresh deployments

The flood case spends the address's request budget, and the submissions cases need the first 20 requests of a minute, so a second run against the same deployment inside the throttle window fails SUB-01..06 with 429. Boot (or wait out) a fresh deployment for every run: the Java kit, the Node kit and the flood case each get their own. The `jvm` job of the JVM workflow (`jvm.yml`) does this (the ui example is booted three times, once per run).

### The three test deployments

`hardening`, `runtime-down` and `host-context` need a host started differently from a production one, and each is one deployment:

- **Hardening**: the kit's hostile rule module (`hardening-rules.js`, written by `fixtures`) registered for the fixture form, with the validation memory raised so the 40 MiB answer meets the run's output caps rather than the module failing to build it. It loops, takes memory without bound, builds a 40 MiB answer and writes a forged outcome on purpose: never in a deployment people use. The Spring submissions example has a test-only property for it: `--datum.example.hardening-rules=<dir>/hardening-rules.js --datum.runtime.validation.memory=512MB`.
- **Runtime down**: the stale sandbox program (`stale-program.js`, ABI 2.11.0, below every host's floor) as the host's sandbox program with fail-fast off, so the host starts, the runtime refuses the program with `abi_mismatch`, and every submission is 503. Spring Boot: `--datum.runtime.programs.sandbox=file:<dir>/stale-program.js --datum.runtime.fail-fast=false`.
- **Host context**: the kit's host context fixture (`fixture-host-context-form.json`, form `datum-host-context`, written by `fixtures`) served beside the fixture form, the dry-run route on, and a TEST-ONLY host context provider. For that form only, the provider answers `{"role": <value>}` from the request header `X-Datum-Test-Role` when the request carries it, and no context when it does not. A client chooses that header, so never wire such a provider where real submissions are taken. On Spring Boot add the file to `datum.forms.locations` and declare a `HostContextProvider` bean, as the submissions example's `SubmissionsHostContextIT` does. A host that does not declare `host-context` is never run against these cases.

```sh
datum-host-check fixtures --out kit/
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar --datum.example.hardening-rules=kit/hardening-rules.js --datum.runtime.validation.memory=512MB
datum-host-check --endpoint http://localhost:8080 --capabilities hardening
datum-host-check --endpoint http://localhost:8081 --capabilities host-context   # a deployment with the fixture, the dry run and the test provider
```

The files the Java kit also ships (`hardening-rules.js`, `stale-program.js`, `fixture-pdf-theme.json` and the host context fixture) are copied byte for byte from its resources; a test keeps the copies equal while both are in the repository.

### The other example deployments

The Spring Boot examples beyond `ui` are held to the Node kit once each, every one on its own fresh boot (the `jvm` job of the JVM workflow (`jvm.yml`) runs them in this order; ports are free choices):

| Example | Boot (besides `--server.port`) | Kit options |
| --- | --- | --- |
| `ui-builder-jpa` | none: its `application.yml` switches the builder, the definition route and the assets on; people sign in with HTTP Basic (`author`, a form admin; `viewer`, who is refused) and the page checks the cookie CSRF token | `--capabilities builder,assets --builder-enabled --build-form intake --person-header "Authorization=Basic <author:author>" --other-person-header "Authorization=Basic <viewer:viewer>" --csrf cookie:XSRF-TOKEN:X-XSRF-TOKEN` |
| `webflux-pdf` | the development key store (`examples/webflux-pdf/scripts/make-dev-keystore.sh`) as `--spring.ssl.bundle.jks.pdf-signer.keystore.location=file:<abs path>/local/dev-signer.p12`, the definition, submissions, validate and assets switches, and the fixture form added to `--datum.forms.locations` (keep `classpath:/datum/forms/*.json`) | `--capabilities submissions,forms,assets,pdf,tsa --builder-enabled --pdf-signing` |
| `tsa-server` | none (open access, a self-signed certificate) | `--capabilities tsa` |
| `passkeys` | `--datum.webauthn.origins=http://localhost:<port>`: a passkey is bound to the origin a browser writes, and the example's yml names port 8080 | `--capabilities passkeys --signing-form petition --person-header "Authorization=Basic <ada:ada>" --other-person-header "Authorization=Basic <grace:grace>" --csrf cookie:XSRF-TOKEN:X-XSRF-TOKEN` |

`<user:password>` is the base64 of that text. The tests that wire these deployments in-process are the examples' own ITs.

### Exit codes and the report

`0` every selected case passed and every named capability had at least one case pass; `1` a case failed; `2` a usage error, including a named capability whose cases all skipped (it asserted nothing) or an id outside the named capabilities; `3` inconclusive: the host cannot be reached, the fixture form or a required switch is missing (the message says which); `4` an internal error. `report.json` and `report.md` have the same top-level shape as the endpoint mode's report; the verdict adds `UNEXERCISED` (exit 2), results carry the capability, the Java oracle and the exchanges, and header values never appear.

### How it complements endpoint mode

Endpoint mode attacks the receiving routes with forged outcomes, smuggled members and malformed bodies, and reads a refusal as success. The host check proves the routes do what a form needs (accept, print, sign, timestamp, serve assets) and refuse the plain misuse of each. A release of a host runs both against the same test deployment.

### Agent tools catalogue

The browser assistants' tools (ADR 0155: the renderer's twelve, the `begin_session` / `end_session` pair, and the builder's twenty-four) are a published surface: an agent reads their titles, descriptions and input schemas. `packages/conformance-suite/golden/agent-tools.json` pins all of it (names in catalogue order, `title`, `description`, `inputSchema`, `annotations`, and the flags that change how the page treats a tool: `allowedWhileStopped`, `readActions`, `answersWhenOff`, `inputBytes`), with the two toolset strings `datum-form/1` and `datum-builder/1`. Three checks read it:

- **The golden test** (`tests/agent-tools-catalogue.test.ts`, part of `npm test`) builds the live catalogues from the engine and compares them to the golden, and compares the generated `docs/reference/agent-tools.md` to it. A reworded description or a new schema property fails until the golden is regenerated on purpose and the page follows. Regenerate with `npm run golden:agent` (it writes `golden/agent-tools.json`, keys sorted, two-space JSON), review the diff, then regenerate `docs/reference/agent-tools.md`.
- **The verb** `datum-host-check agent-tools --tools <dump.json> [--json]` compares a page's own tool dump to the golden shipped in the package. It needs no endpoint and no engine, and it is not a capability (`list` and the Java kit's catalogue do not change). Write the dump in the page's DevTools with `copy(JSON.stringify(await document.modelContext.getTools()))`, or with `JSON.stringify(await form.agentTools())` on a `<datum-form>`; both shapes are read, and a schema given as JSON text is parsed. A dump holding `describe_form` must hold all twelve renderer tools and the session pair, one holding `describe_builder` all twenty-four builder tools and the pair; any other name is an extra tool. Descriptions and schemas must be equal, a title equal when the dump's is not empty, and annotations equal on the keys both carry. A form sealed by its author's `off` (or by a host that follows the definition) still lists every tool, because the call is refused with `agent-off` rather than the tool withdrawn, so its dump passes too; a form under `agent-access="never"` registers nothing, so there is no dump to take.
- **The comparer** (`compareAgentCatalogues`, `compareAgentDocs`, `compareToolDump`, exported from `src/host-check/index.ts`, pure and engine-free) is what both use.

The verb prints one line per finding (`missing-tool`, `extra-tool`, `order`, `title`, `description`, `input-schema`, `annotations`, `flag`, `toolset`) or, with `--json`, `{ kit, golden: { toolsets }, findings }`. Exit codes: `0` no finding, `1` a finding, `2` a missing or unreadable dump (or no `--tools`). The golden adds about 90 KB to `dist/host-check.mjs`, which stays far under its 1,000,000 byte budget.

## Binding conformance (`datum-binding-check`)

The package's third command holds a form-renderer binding to what Datum asks of it: Datum's own binding, or a design-system binding module that exports `createBinding(lit, datum)`. It mounts a fixed corpus of fixture forms, one per Datum feature, through the engine renderer (`mountLive`) with the binding, in headless Chromium driven by Playwright, and runs the cases against what Datum and the binding write and pass in. The cases check integration only, never the design system's own look or accessibility. The `datum` binding must pass every case; the nine reference bindings in `bindings/` run it in CI on their pinned design-system releases, as tests of the infrastructure.

### Install and run

```sh
npm install --save-dev @argusvane/datum-conformance-suite playwright esbuild
npx playwright install chromium
npx --package @argusvane/datum-conformance-suite datum-binding-check                                        # Datum's own binding (the default)
npx --package @argusvane/datum-conformance-suite datum-binding-check --binding ./dist/my-binding.js --assets assets.json --report out/
npx --package @argusvane/datum-conformance-suite datum-binding-check --binding gcds                         # bindings/gcds, found upward from the working directory
npx --package @argusvane/datum-conformance-suite datum-binding-check --list                                 # the cases and their groups
```

Playwright and esbuild are optional peer dependencies, loaded by this command alone, so a server host that installs the suite for `datum-host-check` pulls neither. esbuild bundles the binding module (`.ts` or `.js`) and the assets file's print and PDF modules for the run; `--binding datum` needs no esbuild. Without a peer, or without the browser, the command exits 3 and says what to install.

The host module the cases mount through (the renderer, the runtime and Datum's binding) is prebuilt into the package as `binding-check/dist/host.js`, so the installed command reads no engine source. The binding module is bundled apart from it, as a binding ships apart from the page it is drawn on, and is handed the host's `lit` and Datum's binding. In a checkout of the repository the command builds the host module from the engine's source on each run instead, so a run there always holds the engine as it is.

| Option | Meaning |
| --- | --- |
| `--binding <datum \| id \| path>` | `datum` (the default); an id: the package `bindings/<id>` found upward from the working directory (then from the suite's own folder), with its `binding-check.json` as the assets file; a path: a binding module, with its assets file in `--assets` |
| `--assets <file>` | the assets file (below) |
| `--only <ids>` | case ids or groups, comma separated (`MNT,VAL,ERR-01`) |
| `--report <dir>` | write `report.json`, `junit.xml`, `report.html` and `shots/<id>.png` for each failing case |
| `--baseline <report.json>` | a report from a known-good release: prints which cases changed state, a new failure marked `REGRESSION` |
| `--browser chromium \| firefox \| webkit` | Chromium is the default and the only one the corpus is verified on |
| `--port <n>` | the first port to try; the first free one of the thirty from it is used (default: any free port) |
| `--case-timeout <ms>` | per case, default 60000 |
| `--continue` | run the cases although preflight found a problem |

### The assets file

JSON, with the design system's files as the host gives them to the renderer. Paths in it are relative to the file.

| Key | Meaning |
| --- | --- |
| `stylesheets`, `fonts`, `scripts` | lists of URLs, or entries `{ url, integrity }`; a script entry may also say `classic: true` and carry `attributes` for its `<script>` element |
| `known` | cases that fail because of a defect of the design system itself, each `{ case, reason, since }`: the run reports such a case as `known` with its reason, counted apart from pass and fail, and exits 0 when only known cases are left; a listed case that passes fails the run ("listed as known but passes: remove it"). An id of the kit's behaviour suite is ignored here, and the kit's `package` step refuses one that matches no case of either suite |
| `rootFontSize` | the host page's root font size in px, when the design system's sheet expects another |
| `roots` | folders that stand in for the CDN: the tester's server answers the asset URLs from them (default: the file's own folder). A URL `/node_modules/<package>/...` is also answered through an npm alias the folder's `package.json` pins (`"govuk-frontend-6.6.0": "npm:govuk-frontend@6.6.0"`) |
| `binding` | the module of a package named by `--binding <id>` (otherwise its `src/binding.ts` or `src/index.ts`) |
| `lang`, `bodyClass` | the host page's language and its `<body>` class (GOV.UK Frontend's `govuk-frontend-supported`) |
| `designSystem` | the design system's name for the report, when the binding names none |
| `print`, `pdf` | the package's print theme and PDF theme modules: PRT-01 prints the corpus under the print theme with the host's stylesheets and its self-check; PDF-01 checks that the binding's `pdfTheme` suggestion is what the engine's ladder picks. Each skips without its module or suggestion |

Before the cases, preflight fetches every asset URL and mounts one form: an asset that is not found, a `datum-binding-error` from the binding's `selfCheck` or an exception stops the run (exit 3) unless `--continue`. The run's header prints each side effect the binding declares outside the form's root (`designSystem.sideEffects`) as a `SIDE EFFECT` line, and the report lists them; a declared side effect is never a failure. Each listed `known` case that the run selects is printed as a `KNOWN DEFECT` line, and the report counts it as `known`.

### Cases

`datum-binding-check --list` prints every case with its id, title and whether it is pending, then the groups: MNT mount, assets, selfCheck and unmount; VAL value round trip; ERR errors drawn; NTC notices and pending checks; SUM error summary; ANN count announcer; RO read-only and disabled; DAT date parts; GRD data grid; TAB tabs; JNY journey; I18N languages; HK state hooks and references; CAP capability answers; KIND tier-2 kinds fall back to their base; CNV builder canvas mode (the engine's canvas hooks laid over a fixture: a node per component, inert field leaves, a real click on a control or a group's heading selecting that component, the empty group's drop zone, the form live again with the hooks off); PRT print theme; PDF PDF suggestion. The cases find a field's controls by native tag (`input`, `textarea`, `select`) or by role, so a design system that draws its own controls as custom elements is driven like a native one: an element with a `role` of radio, checkbox or combobox in the field's composed tree (a combobox inside its host's shadow root included), or a form-associated custom element with a boolean `checked` (its ElementInternals role cannot be read from script: a radio under `role="radiogroup"`, else a checkbox). An element found by role that holds a native control is not counted twice. Such a control is clicked where its role is, its choice is read from its `value` property and its state from `checked` or `aria-checked`; what describes and names it is read from `aria-describedby` / `aria-labelledby` (ids in its own tree) and from `ariaDescribedByElements` / `ariaLabelledByElements` (element reflection across shadow roots). A journey page's buttons are `button` or `[role=button]` elements outside fields, the summary and chrome parts. A summary entry is an `a[href]`, or the custom-element host of an empty inert proxy `a[href]` with the same `href` (a FAST anchor draws its link so); the entry's words are then read from the host. A select drawn with no native `<select>` skips VAL-05 (the generic driver does not operate a custom listbox). A case for a component type the binding has no adapter for is skipped (Datum draws it), as is a case whose capability the binding answers `none`; the reason is in the report. The corpus is versioned with the suite, so a binding checked by a newer suite reports what it does not carry yet.

### Exit codes and the report

`0` every case that ran passed; `1` a case failed; `2` a usage error, or nothing was asserted (every selected case skipped or pending); `3` preflight: Playwright, esbuild, the browser or the host module missing, an asset unreachable, a binding that will not build, or `selfCheck` reporting a problem; `4` an internal error. `report.json` holds the binding, the assets file, the browser, preflight, a summary by group and each case's status, message, time and the console output of the design system's scripts; `junit.xml` is one test suite per binding, a skipped or pending case marked skipped.

### Programmatic use

`@argusvane/datum-conformance-suite/binding-check` exports what the command is made of, for a binding's own probes on the same host page and driver: `runBindingCheck(argv, io)`, `buildRun`, `startBrowser`, `openCase`, `startServer`, `FIXTURES`, `form`, `CASES`, `GROUPS`, `Fail`, `Skip`, `PreflightError`, `loadPlaywright`, `loadEsbuild`, `resolveTarget`, `DATUM_BINDING` and `RUN_PREFIX`. The binding kit in `packages/datum/binding-kit` runs the command as its conformance step.

### Publishing the package

The package publishes from a `v<version>` tag by `.github/workflows/release-npm.yml`, with the other published packages (`@argusvane/datum` and `@argusvane/datum-form-test`; no unscoped name is published, so its commands run as `npx --package @argusvane/datum-conformance-suite <command>`). The workflow checks that every package carries the tag's version, builds the package (with the engine, `quickjs-wasm-host`, `pdf-kernel` and `submissions` packages installed), runs the pack tests, packs the tarballs, installs them into an empty project and runs each command, then publishes once an approval is given on the `npm` environment; a prerelease version publishes under the `next` tag. The pieces can be run by hand from the repository root, and none of them publishes:

1. `npm ci` in `packages/conformance-suite`, then `npm test` (the pack test installs the tarball into an empty folder and runs all three commands from it).
2. `npm run pack:check` in the package: `prepack` writes `LICENSE` and `NOTICE`, and the listing must hold `bin/`, `dist/`, `binding-check/` with `dist/host.js` and no `binding-check/host/`, `golden/` and `fixtures/`.
3. `node scripts/npm/release.mjs pack --out <dir>` and `node scripts/npm/release.mjs smoke --dir <dir>` pack every published package and install the tarballs.

## Release gate: what runs where

| Where | What |
| --- | --- |
| Every pull request (CI job `conformance-suite`) | typecheck, the package's tests (vector lint, negative programs, the reference `@argusvane/datum-submissions` server, report schema, pack and install smoke), the build, and `check:source`: the program built from source through program mode and parity. |
| Every pull request (CI job `bindings`) | the binding kit's checks on Datum's binding and on each reference binding, `datum-binding-check` among them, in Chromium. |
| Every pull request (CI job `conformance-suite-artifacts`) | the built bundles: `node packages/conformance-suite/dist/cli.mjs --program packages/datum/dist/datum-sandbox-program.js --all --gate release`, so the shipped file, not only the one built from source, is attacked. |
| By hand or on a schedule | Endpoint mode against a booted site with the fixture installed. |

The root scripts are `conformance-suite:build`, `conformance-suite:typecheck`, `conformance-suite:test`, `conformance-suite:check` and `conformance-suite:host-check` (the host check command: `npm run conformance-suite:host-check -- --endpoint ...`, after a build); the first three are part of `npm run ci`. The `jvm` job of the JVM workflow (`jvm.yml`) runs `datum-host-check` beside the Java kit and the suite's endpoint mode, each on its own fresh boot of the Spring examples.

## Adding a vector

Put it in the class file under `packages/conformance-suite/src/vectors/` with `vector({...})`, add it to that class's array, and give it: a new id (ids are never reused), a title that states the expected result, a severity and attacker, `provenance` (the tests that cover it; the lint requires each path to exist and each test name to occur in its file) and, for an S1 vector, a mutation test in `tests/mutation-programs.test.ts` (the real program with the guard removed must FAIL it). A vector blocked by an open item is registered `pending` with `blockedBy`, and is made `enforced` when the item lands. Regenerate the golden file with `npm run golden:write` only when the bytes legitimately change, and bump the vector set in `src/version.ts`.

## Known gaps

- Hosts that run the program under wasmtime (Node, .NET, Java, Python) are checked through the program file and the endpoint, not through their own embedding; the in-process host has no limits of its own beyond the QuickJS budget.
- The PDF program's output safety is the `OUT` class (`src/vectors/output.ts`), and it runs only when `--pdf-program` names a program; the sandbox-program and endpoint runs skip it, and the pull-request jobs above do not pass the flag.
- A live acceptance run against a real deployment is a manual step; the reference server in the tests reproduces the receiver table but is not a host.
