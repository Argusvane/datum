# Running the programs on your own server

If your framework has no Datum host, you can still validate submissions and render PDFs on your server. The build produces two plain programs, `datum-sandbox-program.js` and `datum-pdf-program.js`, and any host that runs WebAssembly can run them. They are the same programs the browser runs, so the verdicts and the PDF bytes match. Spring Boot and FastAPI hosts are built on exactly this; the [server hosts](/server-hosts) page lists them. On the JVM, the [Java sandbox library](/java-sandbox) does all of it for you in any framework. In Python, the [Python sandbox library](/python-sandbox) does the same.

## What a host needs

A host needs three things:

- **A runtime.** A WebAssembly runtime with WASI.
- **The sandbox module.** A WASM build of a JavaScript engine, which the programs run inside.
- **The two programs.** `datum-sandbox-program.js` and `datum-pdf-program.js`, from the built folder. [Files you host](/files#getting-the-files) has the build.

Each run is a fresh instance of the module:

- The programs are mounted read-only.
- The request goes in on standard input, and the answer comes back on standard output.
- Runs share nothing, so they need no lock.
- Compile the module once and reuse it where the runtime allows.

[Running the sandbox](/wasm-running#on-a-runtime-of-your-own) walks through choosing a runtime, the command's arguments and how to read the way a run ended. [Hardening on a server](/wasm-hardening) lists what a host does around every run.

## The sandbox run

The host loads the sandbox program, registers any rule modules the form needs, then calls `__datum_run` with the request text. It reads the outcome text back.

The request is one JSON object, the run context. The keys are in the table below.

```json
{
  "form": { "…": "the form's root component" },
  "values": { "fullName": "Ada" },
  "locale": "en",
  "unknownFields": "strip",
  "logLevel": "warn"
}
```

| Key | What it carries |
|---|---|
| `form` | The form's root component, from the definition. |
| `values` | The submitted answers, keyed by value path. |
| `locale` | The language the engine's messages are worded in. |
| `unknownFields` | What to do with submitted keys the form does not define: `strip` (the default, removed from the returned values), `keep`, or `reject` (a blocking `unknown_field` error per key). |
| `logLevel` | What the run's log keeps: `off`, `error`, `warn` (the default), `info` or `debug`. |
| `journey` | The journey the answers were given through, `{ id, ... }` as the definition has it. The program works out the path from the values, treats every component off it as hidden, and refuses a path that ends at an exit page (`journey.exit`), a malformed journey (`journey.invalid`, which includes a page with a `when` of its own: only routes carry conditions) and a fold that does not settle (`fold.unsettled`). A Check answers page (`kind: "review"`) ends the path with the submit and holds no form field. |
| `page` | A page of the journey the host is checking. The outcome then lists `pageComponentIds`, the components in scope for that page. The verdict is still the whole submission's; keeping the errors to the page is the host's job. Ignored without a usable journey. |
| `today` | The calendar day `today()` and `age()` read, as `YYYY-MM-DD`. Absent, a rule that reads the clock is left unevaluated (its component is listed in `clockDependent`), and a journey whose conditions read the clock is refused (`journey.clockDependent`). A value that is not a real date counts as absent. |
| `hostContext` | The values the form's `host.` names read, as an object your host works out from the request: the signed-in person's role, the site's region. Never take it from the browser: the page's own `hostContext` is for display, a client can set it to anything, and the envelope does not carry it. Nested objects are read by dotted name (`host.user.role`). With it, every rule and calculation that reads `host.` is judged, and a name it does not hold has no value. Without it, those rules are left unjudged as before (the field keeps its own settings, a field the host shows is not required and is listed in `visibilitySkipped`, a calculation keeps the value sent and is listed in `clientDerived`). A value that is not an object is logged and counts as absent. It is held to the bounds of the rest of the request (64 levels deep). |
| `formulaErrors` | `fail` (the default) or `warn`. What to do with a rule that does not parse or a scope a rule may not take: `fail` refuses with one `formula.invalid` per problem; `warn` drops the rule and logs it. Overrides the form's own setting. |
| `riskyPatterns` | `refuse` (the default) or `allow`. A regular expression of a catastrophic shape, such as a repeat of a repeat, is refused as `pattern.risky` (judged by `formulaErrors`); `allow` runs it. |
| `reportFold` | `true` asks for the fold's results in the outcome: `withheld`, `effectiveState`, `submittable` and `trace`. |
| `document` | The delivered document exactly as received (an envelope or a signed wrapper). The outcome then carries its `canonical` text and `digest`, whatever the verdict. Rules never see it. |
| `optionSnapshot` | The options the host resolved from its data sources, by source id: `{ "<sourceId>": [ { "value": "...", "label": "..." } ] }`. A choice answer is held to them (`option.notAllowed`), and a source the snapshot lacks fails closed (`option.sourceUnavailable`). |
| `kinds` | The definition's `kinds` map: each plugin or design-system type to the engine type it is read as, so a `gcds-date` is checked as a date. |
| `translations`, `catalog` | The definition's translations and the host's catalogue, used to word a failed pattern's message in `locale`. |

The outcome is one JSON object. `errors` holds codes and the component they belong to, never wording, so your page words them. A run that does not block also carries the sanitised `values`: keys the form does not define are removed (with the default `unknownFields`), and the host stores these, not what was posted.

```json
{
  "errors": [
    { "code": "custom.fullNameIncomplete", "componentId": "fullName", "path": "fullName" }
  ]
}
```

| Outcome key | Present when | What it is |
|---|---|---|
| `errors` | Always | The error codes, each with `code`, `componentId`, `path` and `parameters`. A run reports at most 10,000, then ends the list with `errors.truncated`. |
| `values` | The run does not block | The sanitised answers. |
| `logs` | The run kept anything | Entries of `level`, `message` and optional `data`. |
| `submittable` | `reportFold` and the run blocked | The judged values of a blocked run. |
| `withheld` | `reportFold` | The delivered keys the form defines that the judged values leave out: hidden answers the fold withheld. |
| `effectiveState` | `reportFold` and there is any | For components whose errors the fold can drop, `visible`, `disabled`, `readonly`, `runValidation`, `requiredApplies`, `submitValue` and `clearValue`. |
| `trace` | `reportFold` and a journey | The journey's path through the answers. |
| `clientDerived` | There are any | Value paths of answers worked out in the browser and kept as sent, such as a calculation the program could not reproduce. They were still held to the form's rules. |
| `pageComponentIds` | `page` names a page | The components in scope for that page, in document order. |
| `clockDependent` | There are any | Components, and with a journey pages, whose rules read the clock. |
| `serverRules` | There are any | Components whose `server` or `server-secret` rules the run applied, so a host can explain a verdict the browser never showed. |
| `visibilitySkipped` | There are any | Components whose own `visibleWhen` the server could not replay: it reads `host.` and the run had no `hostContext`, it runs in the browser only, or it reads the clock and the run had no `today`. They and everything under them count as hidden for requiredness. |
| `index` | `values` is present | The flat index of `values`, one row of `path`, `delta` and `value` per answer. |
| `canonical`, `digest` | `document` was sent | The document written canonically (keys sorted by UTF-16 code unit, no whitespace) and its SHA-256 as 64 lowercase hex digits. Store or sign these, not your own re-serialisation. |

A run for a form with a field shown to administrators only, `"visibleWhen": "host.role = \"admin\""` and required, with the host's own context:

```json
{
  "form": { "…": "the form's root component" },
  "values": { "fullName": "Ada" },
  "locale": "en",
  "hostContext": { "role": "admin" }
}
```

```json
{
  "errors": [{ "code": "required", "componentId": "adminNote", "path": "adminNote", "source": "wasm", "stage": "field-constraints" }]
}
```

With `{ "role": "user" }` the same answers pass and `adminNote` is left out of the values. With no `hostContext` they pass too, and `visibilitySkipped` names `adminNote`.

What a host does with each result:

- **An outcome without `values`.** It carries a blocking error, and a host answers it with a 422 and the code for each entry. Warnings alone do not block.
- **A rule that throws.** It blocks the submission with `validator.failed`, and its message goes to the run log.
- **A rule module that fails to load.** The run ends with exit code 1.
- **A run stopped for its time or memory.** It gives no verdict, so the host refuses the submission (503 `wasm.execution_error` on the built hosts) and stores nothing: a submission the gate did not judge is never let through.

## The policy knobs

Four settings decide what the gate does with the unexpected. A server host sets each once for every run; a host of your own puts the key in the run context.

| What it decides | Run context key | Values (default first) | Spring Boot property | FastAPI setting |
|---|---|---|---|---|
| Submitted keys the form does not define | `unknownFields` | `strip`, `keep`, `reject` | `datum.host.unknown-fields` | `datum.host.unknown_fields` |
| A rule that does not parse | `formulaErrors` | `fail`, `warn` | `datum.host.formula-errors` | `datum.host.formula_errors` |
| A regular expression of a catastrophic shape | `riskyPatterns` | `refuse`, `allow` | `datum.host.risky-patterns` | `datum.host.risky_patterns` |
| How much of a run the log keeps | `logLevel` | `warn`, `off`, `error`, `info`, `debug` | `datum.host.log-level` | `datum.host.log_level` |

Leave `formulaErrors` on `fail` and `riskyPatterns` on `refuse` on a server. `warn` and `allow` exist for previews and staging, where a form with a broken rule should still draw.

External data is the host's too. The program never fetches. A form whose choices come from a data source needs the options in the run context as `optionSnapshot`, resolved by the host. Without them, an answer that picks a value of that source is refused as `option.sourceUnavailable`, which is the safe result.

## Asking questions of a definition

A second entry point, `__datum_inspect`, takes `{ abi, op, definition }` and answers four operations. A host serves only the `public` copy to a page. The answer is `{ ok: true, op, ... }`, or `{ ok: false, error: { code, message, where?, limit? } }` with `abi_mismatch`, `invalid_request` or `definition.tooDeep`.

| `op` | Extra request keys | Answer |
|---|---|---|
| `public` | none | `definition`: the definition to serve to a browser, without the rules marked `server-secret`, and without a secret value written where no server scope is allowed. |
| `check` | `formulaErrors`, `riskyPatterns`, `types` (the component types the host can draw, at most 4,096 names) | `problems` and `warnings` (rule findings), `policy`, `structure` (findings that refuse, such as a reserved id or a pattern that does not compile), `structureWarnings`, `limits` (the size caps in force) and `verdict`: `ok`, `warn` or `fail`. A component whose type is not in `types` is a `component.type.unknown` warning. |
| `inspect` | none | `rules` (each rule's component, key, `run` scope, the paths it `reads`, `readsHost`, `readsClock` and `functions`), `functionsUsed`, `pluginsNeeded` and `paths`, every value path the program reads, with `componentId`, `type`, `holdsData` and any `source` or `collection`. |
| `test` | `tests` (sidecar test text), `formulaErrors` | `report`: every scenario with its name, line, `status` and `steps`, `summary` counts (`total`, `passed`, `failed`, `skipped`, `error`) and the parse `problems`. Without `tests` the definition's own scenarios run. At most 256 KiB of test text, 200 scenarios and 1,000 statements in one scenario, else `invalid_request`. A form that reads the day needs `given today` in each scenario. See [Testing](/testing). |

A definition over the size caps, or nested deeper than the limit, is refused before any of this is read.

## The PDF run

The PDF program is called with `__datum_pdf`, which answers with a promise that settles before the module exits. The program's whole script is one line: it reads the request from standard input, and prints the reply. There is no nonce frame, because no page-written rule runs in it.

The request names an `abi`, an `op`, and the keys that op needs. Every printing op also takes `env`, the only time and identity the program sees:

- `createdAt`: an ISO 8601 instant.
- `documentId`: hashed into the file's identity.
- `producer` and `creator`: optional.

The same request gives the same bytes on every host.

```json
{
  "abi": "4.0.0",
  "op": "document",
  "form": { "…": "the form's root component" },
  "values": { "fullName": "Ada" },
  "locale": "en",
  "fonts": [ { "id": "sans", "family": "Noto Sans", "data": "…base64…" } ],
  "env": { "createdAt": "2026-11-13T12:00:00.000Z", "documentId": "abc-123" }
}
```

A reply is `{ "ok": true, "op": "...", ... }` or `{ "ok": false, "error": { "code", "message" } }`. The error codes are `abi_mismatch`, `invalid_request`, `font`, `template`, `layout`, `unknown_component`, `conformance`, `attachment_budget`, `signature`, `formula_invalid`, `render_limit` and `internal`.

| `op` | What it does | Request keys (besides `abi`, `op`) | Reply keys (besides `ok`, `op`) |
|---|---|---|---|
| `capabilities` | Probe: the version and the features. | none | `abi`, `features`, `kernelVersion` |
| `document` | Choose a layout from the answers (or the one named) and produce the PDF. | `form`, `values`, `locale`, `fonts`, `env`; optional `layoutId` or `layout`, `pdf`, `translations`, `formTranslations`, `kinds`, `optionSnapshot`, `effectiveStates`, `theme`, `title`, `hostContext`, `unknownComponents`, `attachments`, `today`, `formulaErrors`, `riskyPatterns`, `options`, `template`, `signature` | `bytes` (base64), `pageCount`, `pages`, `warnings`, `fields`, `areas`, `pdfa`, `attachments`, `signing`, `layoutId`, `layoutKind`, `layoutChoice` |
| `build` | The layout choice and the document model, without bytes. | The inputs of `document`, without `fonts` and `env` | `layoutId`, `layoutKind`, `layoutChoice`, `document`, `fill`, `warnings` |
| `render` | Produce a PDF from a document `build` made. | `document`, `fonts`, `env`; optional `options`, `signature` | As `document`, without the layout keys |
| `layout` | Lay a document out and report the pages, no bytes. | `document`, `fonts`, `env` | `pages`, `warnings` |
| `fill` | Write answers into a fillable template. | `template`, `values`, `fonts`, `env`, `options`; optional `areas`, `conformance`, `attachments`, `signature`, `typography`, `colors` | `bytes`, `pageCount`, `fields`, `areas`, `warnings`, `pdfa`, `attachments`, `signing` |
| `inspect` | Read a template's fields and facts. | `template`; optional `attachments`: `none`, `digest` or `data` | `info`: `pageCount`, `pages`, `fields`, `hasXfa`, `encrypted`, `permissions`, `pdfa`, `attachments`, `signatures` |
| `sign` | Prepare a signature over any PDF. | `pdf` (base64), `signature`, `env`; optional `fonts` | `bytes` (the prepared file), `signing`, `warnings` |
| `complete` | Embed the signature value your server made. | `pdf`, `signing` (the signature value and an optional timestamp token) | `bytes`, `field`, `cms`, `timestamped` |
| `timestampRequest` | Build the RFC 3161 request to post to a timestamp server. | `signature` (base64) | `request` (base64) |
| `verify` | Check every signature in a PDF. | `pdf`; optional `knownCertificates` (DER base64, at most 64 of at most 16 KiB) | `signatures`, `attachments`, `warnings`, `documentId` |

Signing keys never enter the sandbox. A `document`, `fill` or `sign` call that carries a `signature` spec returns the prepared file and a `signing` handoff: the data to sign. Your server signs it with its own key or a key service, and a `complete` call embeds the value. `verify` checks structure, digest and certificate binding; the signature value and the trust in the signer are the host's to judge. [Signing](/signing) has the whole story, and the reply of the built hosts' verify route is on [the wire](/wire#post-api-pdf-verify).

## Limits a host sets

Each run has a time budget, a memory limit and a stack limit, and the request and the answer are bounded before they reach the sandbox. The defaults of the Node reference host are:

| Limit | Validation run | PDF run |
|---|---|---|
| Time budget | 250 ms to start | 15 s |
| Memory | 32 MiB | 256 MiB |
| Stack | 1 MiB | 1 MiB |
| Request nesting | 320 levels | 320 levels |
| Request length | 32 Mi characters | 256 Mi characters |
| Answer length | 8 Mi characters | no cap |

The validation budget of the Node reference host is not fixed. It starts at 250 ms and grows:

- 5 ms for each rule read and 1 ms for each KB of the definition, to at most 5 seconds.
- Then 2 ms for each KB of the request, to at most 5 seconds in all.

A host picks its own budgets. The built hosts, Spring Boot and FastAPI, give every validation run a fixed 5 seconds by default and do not scale it. Their defaults:

| Default | Spring Boot | FastAPI |
|---|---|---|
| Validation time and memory | 5 s, 32 MiB | 5 s, 32 MiB |
| PDF time and memory | 15 s, 256 MiB | 60 s, 256 MiB |
| Largest PDF the verify route reads | 20 MiB | 20 MiB |
| Engine | Endive | wasmtime |

The sizes are binary in both hosts: 1 MiB is 1,048,576 bytes. A Spring Boot property writes them as `32MB`, `256MB` and `20MB`, where Spring's `MB` means that same binary unit. A FastAPI setting writes them as `32MiB`, `256MiB` and `20MiB`, and there `MB` is decimal.

[Spring Boot properties](/spring-boot-properties#runtime) and [FastAPI settings](/fastapi-settings#datum-runtime) list the rest of the runtime settings.

- Do not raise the stack limit: the module's own stack is about 1 MiB, and asking for more makes every call fail.
- Count the time budget on the run itself, with a deadline the runtime enforces, never a timer you start per run on a shared clock.

Failures a host reports:

- A request refused for its size or depth fails with the code `request_refused`.
- An over-long answer fails with `outcome_too_large`.
- An interrupted run is answered with 503 `server.unavailable`.
- A run that passed its budget and would not stop is answered with 503 `wasm.execution_error`, as a timeout is.
- A new run while runs that would not stop fill their bound is answered with 503 `server.unavailable` and no `Retry-After`.
- A full set of runs in flight is answered with 503 `server.busy`.

## The run protocol

A sandbox run is one instance of the module, started with the program loaded first and a script that your host writes and then runs. The script is what keeps a rule from forging an answer. A host that runs the program unframed (the worked examples do) trusts every rule module it loads. A host that loads page-written rules does what follows.

1. **Make a nonce.** 16 random bytes from a secure source, written as 32 lowercase hex characters. A fresh one for every run.
2. **Send it first on standard input.** Standard input is the nonce, one line feed, then the request JSON, in UTF-8.
3. **The script reads it.** It splits the first 32 characters off, requires a line feed after them and lowercase hex in them, and throws `no run nonce` otherwise. It keeps the entry point (`__datum_run`, or `__datum_inspect`), the registration function (`__datum_register`) and the output function in local variables.
4. **Remove the ambient globals.** It deletes `std`, `os`, `print`, `console`, `performance`, `scriptArgs` and `bjson` from the global scope, then the globals quickjs-ng adds that the page's engine does not have: `queueMicrotask`, `gc`, `navigator`, `argv0`, `execArgv`, `atob`, `btoa` and `DOMException`. It fails the run if one stays.
5. **Freeze.** It freezes the program's own functions and the language's intrinsics, so a rule cannot rebind them.
6. **Print the started marker.** `@@datum:<nonce>:started@@` on its own line.
7. **Register each rule module.** Each module is evaluated as one expression and passed to the registration function. A module is a plain object; it can add `validators` and formula `functions`. Registration happens before the first run and a module that adds a function named like a built-in is refused.
8. **Run.** It calls the entry point with the request text, then prints `@@datum:<nonce>:begin@@`, the answer, and `@@datum:<nonce>:end@@`, each on its own line.

The host reads the whole of standard output and accepts it only if it is exactly this frame: the started marker, the begin marker, the answer and the end marker, each once and in that order, with nothing but whitespace (space, tab, line feed, carriage return) around them. A second frame, a lone marker, another nonce's markers, or any other byte means the run is refused. The answer is the text between begin and end, which you then parse as strict JSON. Read it as bytes, and decode only after the frame has passed.

Rule modules cannot print a verdict, because they have no `print` and no nonce. A module that imports the engine's own `std` module can still reach standard output, so the frame is what refuses what it prints: rule modules are code your host trusts, not code a visitor supplied.

The PDF program has no rule modules, so it needs no frame.

## What the sandbox cannot reach

The programs run with:

- No environment and no network.
- No file system but the read-only mount.
- No clock and no randomness: `Date` and `Math.random` are disabled.
- No timers, DOM, process or module loader for a rule.

The page's own rules are plain JavaScript modules that return codes, never text, and read only the request. The hosts Datum builds also bound the output of a run. Hold the same line in your own host:

- Refuse an answer that is not the framed one.
- Keep a rule's text and an engine's messages in your log, never in a response.

The whole list, with the reason for each item and what the Datum hosts already do, is on [Hardening on a server](/wasm-hardening).

## The run log

The sandbox has no console. A rule writes to `context.log` with `debug`, `info`, `warn` or `error`, and the program logs its own steps. The request's `logLevel` says what a run keeps: `off`, `error`, `warn` (the default, so a run that behaves returns nothing), `info` or `debug`. What was kept comes back as `logs` in the outcome, each entry a `level`, a `message` and optional `data`. It is plain data, so the same run gives the same log on every host. Forward it to your own logging, and never send it to the browser.

## Interface versions

Each program states the interface version it speaks, and a host refuses a program, or a definition, it was not built for.

| Program | Current version |
|---|---|
| Sandbox | 4.1.0 |
| PDF | 4.0.0 |

The major number changes when a payload's shape breaks, and the minor number when the program judges or prints something differently or accepts an optional key. The sandbox program answers a request of its own major that is no newer than itself, the PDF program any request of its own major, and each refuses any other as `abi_mismatch`.

At start, probe the program:

- **Sandbox.** Send `__datum_inspect` a request with an `abi` and the op `public`; the program answers it, or refuses it as `abi_mismatch`.
- **PDF program.** Send `__datum_pdf` the op `capabilities`, which also lists its features.

Refuse to serve a program that:

- Reports another major.
- Reports a lower version than your floor.
- Lacks a feature you need.

Build the programs from the release you deploy, and deploy them to servers first or together with the browser bundle, so a server is never more lenient than the page in front of it.

## Worked examples

Four examples carry a page and its endpoint all the way through, each with the endpoint written out in full in four stacks: Python with FastAPI on wasmtime, Java with Spring Boot on Endive, C# with ASP.NET Core and the Wasmtime package, and Node.js with Express, one process per run. They are short on purpose, to show the part that is Datum's, and are not production hosts: [Simple on purpose](/server-example-validate#simple-on-purpose) says what they skip.

- [Validate on the server](/server-example-validate): the endpoint runs the sandbox program and answers with the same codes, which the page hands to `setErrors`.
- [Render a PDF on the server](/server-example-pdf): the endpoint validates, renders the record with the PDF program and answers with the PDF.
- [Fill a PDF on the server](/server-example-fill): the endpoint writes the answers into a fillable PDF it keeps and answers with the filled file.
- [Sign a PDF on the server](/server-example-sign): the endpoint renders the record, seals it with its own certificate and answers with it; a second endpoint verifies a signed file.

Once a host runs, hold it to the wire with the [conformance suite](/conformance): `datum-security-check --program` attacks the program you ship, and `datum-host-check` checks your endpoints.
