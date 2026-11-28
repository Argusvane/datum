# @argusvane/datum-conformance-suite

A conformance suite for Datum's validation gate: the sandbox program that judges every submission on the server. It sends attack vectors at a program file or a live endpoint and reports PASS or FAIL per vector, as JSON and Markdown, with CI exit codes.

```sh
npm run build                                   # bundles dist/cli.mjs (plain Node, no TypeScript toolchain)
node bin/datum-security-check.mjs --program packages/datum/dist/datum-sandbox-program.js --out report/
npm run check:source -- --gate full            # from a checkout: builds the program from source, then runs the suite
node bin/datum-security-check.mjs list          # the vector catalogue; `explain <id>` for one vector
```

Exit codes: 0 PASS, 1 an enforced vector failed, 2 usage error, 3 inconclusive, 4 internal error.

Full documentation: `docs/conformance-suite.md` (vector classes, running each mode, reading a report, the host conformance contract); the decision is ADR 0151. Install with `npm install --save-dev @argusvane/datum-conformance-suite`; the commands it installs are `datum-security-check`, `datum-host-check` and `datum-binding-check`, and they need only Node 22. Without installing, `npx --package @argusvane/datum-conformance-suite datum-security-check --help` runs the first (the bare names `datum-security-check`, `datum-host-check` and `datum-binding-check` on npm are forwarding packages that run these commands; the `--package` form is the one to write in scripts and CI).

## Program packs (`--program`)

Besides the controls (CTL), ABI and isolation (ISO) vectors, program mode runs the resource (RES), option (OPT), file (FIL), context (CTX), canonical (CAN) and secrecy (SEC) packs, in `src/vectors/{resources,options,files,context,canonical,secrecy}.ts` (listed in `program-packs.ts`). OPT is the S1 pack: a program that stores a choice answer the form does not offer has stopped being a gate. Each S1 vector has a mutation test in `tests/mutation-programs.test.ts`: the real program with that guard removed must FAIL it.

The form-test pack (TST, `src/vectors/tests.ts`) covers the `test` op of `__datum_inspect` (ADR 0154): the report shape and `summary`, the definition's own tests, the three caps (256 KiB of text, 200 scenarios, 1,000 statements) refused as `invalid_request` with `where` and `limit`, and the ABI check. The rows read the answer by index (`report.scenarios.1.status`); the oversize inputs are built by a `repeat` generator when the run needs them. `tests/test-op-vectors.test.ts` runs them on the built program, on a double without the op and on programs with a cap removed.

- Gates: `enforced` fails the run, `advisory` reports WARN, `pending` (blocked by an open item: PAR-06) is SKIP under `--gate release` and runs under `--gate full` as XFAIL while the attack still works, XPASS once it is fixed ("promote me"). Neither fails the run (XPASS does under `--fail-on warn`).
- ABI floor 4.0.0, the sandbox ABI (`golden/abi-4.1.json`, written by `npm run golden:write`). `--abi-floor` may raise it within the major, never lower it; a program of another major fails ABI-01 and ABI-02. RES-19 runs the sandbox on the Node worker host (`@argusvane/datum-quickjs-wasm-host/worker`) so a native call the interrupt handler cannot stop is killed by the host's clock; the bundled command keeps that host external and SKIPs the row with the reason, `npm run check:source` from a checkout runs it. RES-20 holds the host's 8 MiB cap on a run's outcome (`outcome_too_large`).
- `--heavy` (also implied by `--gate full`) adds the vectors that need seconds and hundreds of MB: RES-10 (400 definitions on one sandbox), RES-16 (20,000 rows in linear time), RES-17 (70,000 errors).
- `--budget-profile node|browser` sets the nominal evaluation budget the time bounds are multiples of (250 ms for both). A vector without a bound of its own still ends within a 30 s ceiling.
- The program runs on quickjs-emscripten, the engine of the page and the Node.js hosts. `--qjs-wasm <qjs-wasi.wasm> --qjs-sha256 <hex>` runs it on QuickJS-ng's `qjs-wasi.wasm` instead, the engine of the Spring Boot and FastAPI hosts, as they run it (`src/runners/program/qjs-wasi-host.ts`): one fresh instance per call under `node:wasi`, the servers' run script and nonce frame, a 5 s budget where a vector names none, and a linear memory cap of the vector's heap limit plus 32 MiB (64 MiB by default). The file is refused unless it has that SHA-256. The server release jobs run both.
- The report keeps a bounded view of an observation (`src/compact.ts`): a 70,000-error verdict shows the first 40 and the count.

## Parity (`--parity`, `--all`)

`--parity` compares the in-process kernel with the program file (PAR-01 to PAR-05): the engine's own `runParity` over the core and adversarial corpora, byte-identical outcome text for every vector that opted into parity (`applies.parity`), about 35 curated built-in function calls, and digest parity (golden file, independent reference, kernel, `@argusvane/datum-submissions` digest, program) over the CAN-02 documents. `--all` runs the program vectors and parity together. PAR-06 (endpoint versus program) is a pending vector: the parity runner has no endpoint runner. Differences are allowed only through the ledger in `src/runners/parity/divergences.ts`; an unlisted one is a FAIL and a listed one that no longer differs is a WARN.

## Journeys (JRN)

JRN-01 to JRN-05 and JRN-07 (`src/vectors/journeys.ts`, endpoint rows in `src/runners/endpoint/specs-journeys.ts`) test how a journey holds when the client lies about the path. Program mode (JRN-01 to JRN-05): a path that ends at an exit page is refused (`journey.exit`) by every route (the fixture form's `main` sends the name `STOPZZ` to an exit page); the answers of a skipped page are absent from `values`; a wrong-typed or object-member-named journey id is refused (`journey.invalid`/`journey.unknown`); `scope`, `pageId` and other smuggled members change nothing; a calculation reads the settled view (enforced since vector set 2026.10.15-2). Endpoint mode: JRN-01 and JRN-03 are the same exit rows and hostile ids; JRN-07 is the rule for a request that names no journey (the form's only or declared default journey, so the exit page still refuses, or `journey.required`), enforced (a form with `journey.opensAs: form` is judged whole by design).

**The fixture form's journey `main` has a route from page `p1` to an exit page `stop` when `name` equals `STOPZZ`. A form installed before that does not refuse it, and JRN-01's control row says so (reinstall it from `datum-security-check fixture`). The builder profile creates the form itself, so it is unaffected.

## PDF output safety (`--pdf-program`, `--pdf`)

`--pdf-program packages/pdf-kernel/dist/datum-pdf.program.js` (or `--pdf`, which takes that default) runs the OUT vectors (OUT-01 to OUT-15) against the PDF program. The program is loaded into QuickJS through `@argusvane/datum-pdf-kernel`'s provider, renders a fixture form with hostile answers (PDF syntax, bidi controls, hostile attachment names and sizes, a template with prefilled fields) and the suite inspects the output bytes with pdf.js, pdf-lib object dumps and raw scans. It combines with `--program`, `--parity` and `--all`; the report gets a `pdf` section.

The class needs a program that answers PDF ABI 4.0.0, or a later version of that major, with the `output-safety` feature. Any other program leaves every OUT vector `SKIP` (pending) and the report says why; `--gate full` runs them anyway and reports `XFAIL`. pdf.js and pdf-lib are found next to the suite or through a checkout's `packages/pdf-kernel`; the DejaVu fonts the same way (without them the kernel's standard-14 fonts are used). OUT-11 (PDF/A through veraPDF, `~/verapdf/verapdf` or `$VERAPDF`) and OUT-12 (a sealed signature, which mints a throwaway key with `openssl`) are `SKIP` with the reason when the tool is absent.

## Endpoint mode (`--endpoint`)

Attacks a live server through its public routes, against ONE fixture form you install for it (`fixtures/README.md` has the steps for `@argusvane/datum-submissions`; `datum-security-check fixture [--form <id>] [--format submissions]` prints it).

```sh
datum-security-check --endpoint https://host.example --form datum-security-suite --auth-header "Cookie: SESS...=..." --out report/
datum-security-check --endpoint http://localhost:3000 --form datum-security-suite
```

- Routes: `POST /api/submissions/validate` and `POST /api/submissions` (the `@argusvane/datum-submissions` wire). The submit body is `{ document, submissionKey }`; the REC-12 rows (same attempt twice, a key reused for another document, no key, two attempts with the same answers) and the host-check's SUB-06 hold the key to its contract.
- Read-only by default: only the validate route (plus a GET of the public definition and, for `submissions`, of the record count). `--allow-writes` also posts to the submit route, and only for a form that carries the fixture marker (`--public-definition-url`) or that you vouch for with `--i-installed-the-suite-fixture`. Never PUT or DELETE, never another form's route, never a followed redirect: `src/runners/endpoint/http.ts` throws on anything else.
- A preflight (a valid check, a blank name, a pick outside the options) runs first and exits 3 with the setting to fix when the fixture is missing or misconfigured. 429: one wait for a `Retry-After` of at most 60 s, then stop (exit 3, with the vectors not run). `--max-requests 400`, `--delay-ms 250`, `--timeout-ms 30000`, `--body-limit 1048576`.
- Judged by status and code, not by text. Any 5xx (but a typed 503) and any non-JSON body fail the run whatever the vector expected (the never-500 rule, SEC-05); REC-14 judges a 429 only if the run met one.
- The REC and SEC-05 vectors are in `src/vectors/receiver.ts`; the requests of every endpoint vector are in `src/runners/endpoint/` (`applicability.ts` for the program-first vectors, `specs-receiver.ts` for REC). `explain <id>` prints the rows and what each profile must answer.
- Self-tests need no live site: `tests/helpers/reference-submissions-server.ts` (the real `@argusvane/datum-submissions` service behind `node:http`) must pass every enforced vector; `tests/endpoint-negative.test.ts` breaks the reference server one way at a time and expects the matching vector to FAIL.

## Definition vectors (DEF) and the builder profile (`--builder`)

**DEF** (16 vectors, `src/vectors/definition.ts`): the definition an author hands to a host, asked of the program's `check` and `public` ops (program mode, no flag needed). Every row is enforced: the structure check (`structure`, `structureWarnings`), secret stripping and redaction, depth 33, formula problems, a non-object root, determinism. A `Variant.gate` overrides the vector's. Definitions are JSON **text** (`Fixture.definitionText`, `src/fixtures/definitions.ts`) so an own `__proto__` key, a duplicate key or a lone surrogate reaches the program as written.

**BLD** (8 vectors, `src/vectors/builder.ts`) attacks a host's definition-SAVING route (not the receiving one), and runs the DEF definitions through it:

```sh
# the run makes its own form (POST /api/forms) and deletes it (DELETE /api/forms/:key)
datum-security-check --endpoint http://localhost:3000 --builder --allow-writes --out report/
datum-security-check --endpoint http://localhost:3000 --builder --dry-run          # prints the requests it would send; sends none
# a form you installed from `datum-security-check fixture`: adopt it (restored at the end, never deleted)
datum-security-check --endpoint http://localhost:3000 --builder --allow-writes --builder-form datum_security_suite
# after a killed run
datum-security-check builder-cleanup --endpoint http://localhost:3000 --state-file ./.datum-security-run.json
```

- Lifecycle: create `secsuite_<8 hex>` (id written to `--state-file` first) -> save the base fixture, read it back, one valid check -> the DEF/BLD saves, each read back after a refusal (BLD-04) and checked after an acceptance (BLD-09) -> a final submit on the restored base -> delete (records cleared first) and a check that it is gone (BLD-10). The cleanup runs on every exit: an error, a budget stop, SIGINT/SIGTERM. An incomplete cleanup is reported with the remedy (`DELETE /api/forms/<key>?cascade=true`) and exits 3.
- Safety: GET/POST/PUT/DELETE only, and only on the allowlist in `builder-submissions.ts` (the suite form's id); never the forms collection, settings, extensions, data sources or translations. `--max-requests` (default 120) and `--max-saves` (default 60) are hard caps with a reserve for the cleanup; the report lists requests per template.
- Gates: a hostile save a host accepts is a FAIL. A 5xx is a FAIL whatever the gate; a redirect to a login page is INCONCLUSIVE.
- Self-tests: `tests/helpers/reference-submissions-builder-server.ts` (the real service behind `node:http`, with a few faults to switch on), used by `tests/builder-submissions.test.ts`, `tests/builder-lifecycle.test.ts` and `tests/builder-cli.test.ts`.


## Host conformance (`datum-host-check`)

The package's second command holds a host binding to the wire contract every Datum host answers: the statuses, codes, headers and bodies of the receiving routes, the definition reads, the assets, the flood limit, and (run B) the builder, PDF, timestamp, passkeys, hardening, runtime-down and host-context routes. It is the Node port of the Java host test kit `integrations/jvm/tck/datum-host-tck`, case for case (the Java kit is the oracle: same requests, same assertions, same skips), and needs only Node 22.

```sh
npm run build                                                      # also bundles dist/host-check.mjs
node bin/datum-host-check.mjs fixtures --out fixtures/             # the fixture forms a host installs (and the hardening and host-context files)
node bin/datum-host-check.mjs --endpoint http://localhost:8080 \
  --capabilities submissions,submissions-test,forms,assets,flood --out report/
node bin/datum-host-check.mjs list                                 # the cases; `explain <id>` for one
```

The endpoint mode above sends attacks and wants refusals; the host check sends what a browser and an operator send and wants the specified answers. A release runs both against the same test deployment. Exit codes: 0 every selected case passed and every named capability had a case pass, 1 a case failed, 2 usage error (including a named capability that asserted nothing), 3 inconclusive (the host, the fixture form or a switch is missing), 4 internal error. A run that gave no verdict (`wasm.execution_error`, `outcome_too_large`, a registered form nested too deep) is a 503 with its code and no `Retry-After`, on a delivery, a check and a dry run; a check is strict about its request (`{document, scope, pageId?}`) and answers `{accepted, errors, notes?}`. The `host-context` capability (`--capabilities host-context`) needs a test deployment that serves `fixture-host-context-form.json` and a test-only provider for the `X-Datum-Test-Role` header. Every option, the switches each capability needs and the three test deployments are documented in `docs/conformance-suite.md` ("Host conformance").

### Agent tools catalogue

`golden/agent-tools.json` pins the browser assistants' tools (the renderer's twelve, the session pair and the builder's twenty-four: titles, descriptions, input schemas, annotations). `datum-host-check agent-tools --tools <dump.json> [--json]` compares a page's own dump to it, with no endpoint and no engine: write the dump in DevTools with `copy(JSON.stringify(await document.modelContext.getTools()))` (or `JSON.stringify(await form.agentTools())`). Exit 0 no finding, 1 a finding, 2 an unreadable dump. The engine's live catalogues and `docs/reference/agent-tools.md` are held to the same golden by `tests/agent-tools-catalogue.test.ts`; `npm run golden:agent` regenerates it on purpose. Details in `docs/conformance-suite.md` ("Agent tools catalogue").

## Binding conformance (`datum-binding-check`)

The third command holds a form-renderer binding (Datum's own, or a design-system binding) to what Datum asks of it: it mounts a fixed corpus of fixture forms through the engine renderer (`mountLive`) with the binding, in headless Chromium driven by Playwright, and runs the cases (`--list`). The cases check integration only, never the design system's own quality. The `datum` binding must pass every case. A field's controls are found by native tag (`input`, `textarea`, `select`) or by role: a `role` of radio, checkbox or combobox anywhere in the field's composed tree (a combobox in its host's shadow root included), or a form-associated custom element with a `checked` property (a radio under `role="radiogroup"`, else a checkbox); a journey page's buttons by `button` or `[role=button]`. A summary entry is an `a[href]`, or the custom-element host of an empty inert proxy `a[href]` with the same `href` (a FAST anchor), whose words are read from the host. A custom control is clicked where its role is, its choice read from `value`, and its state from `checked` or `aria-checked`; what describes it is read from `aria-describedby` and `ariaDescribedByElements`. A select with no native `<select>` skips the cases that set it (VAL-05).

```sh
npm install --save-dev @argusvane/datum-conformance-suite playwright esbuild && npx playwright install chromium
npx --package @argusvane/datum-conformance-suite datum-binding-check                                            # Datum's own binding (the default)
npx --package @argusvane/datum-conformance-suite datum-binding-check --binding ./dist/my-binding.js --assets assets.json --report out/ --baseline last-good/report.json
npx --package @argusvane/datum-conformance-suite datum-binding-check --list                                     # the cases and their groups
```

Playwright and esbuild are optional peer dependencies, loaded by this command alone (esbuild bundles the binding module; `--binding datum` runs without it), so a server host that installs the suite for `datum-host-check` pulls neither. The package carries the host module the cases mount through prebuilt (`binding-check/dist/host.js`, `npm run build:binding-check`); in a checkout of the repository the command builds it from the engine's source on each run instead. `--binding <id>` takes the package `bindings/<id>` found upward from the working directory, with its `binding-check.json`. Exit codes: 0 every case that ran passed, 1 a case failed, 2 usage error or nothing asserted, 3 preflight (a tool or browser missing, assets unreachable, selfCheck), 4 internal error. The assets file, the reports and the publish steps are in `docs/conformance-suite.md` ("Binding conformance").
