# Validation and the sandbox

One kernel program validates a submission. It runs on your server inside a WASM sandbox, and it can run in the page while you develop and test. The same definition and the same answers produce the same verdict, byte for byte. This page says how to add a check of your own, which of the five routes to take, and what the sandbox receives and returns. [How Datum uses WebAssembly](/wasm) explains the sandbox itself: its parts, how to run it and how to harden it on a server.

## Choosing a route

A form can be checked in five ways. They run in different places and read different things.

| Route | Where it runs | What it can read | How its message is worded |
|---|---|---|---|
| A field's own settings: `required`, `pattern`, `minLength`, `maxLength`, `min` and `max` on a number or date, file limits | The page as the person types and at submit, and the sandbox at submit | Its own answer | The page's `messages` for the code, else the field's own `messages` (and `patternMessage` for `pattern`), its containers' and the form's `messages`, else the engine's text. See [Where a word comes from](/languages#where-a-word-comes-from) |
| A `validWhen` formula on the field | The page and the sandbox, unless the rule's `run` places it on one side | Any answer in the form, the row and ancestors, the day through `today()` | The field's `messages.rule`, unless the page's `messages` names `rule`. See [Rules and formulas](/formulas) |
| A rule module in the sandbox (`wasmPlugins`) | The sandbox: in the page with `wasm`, and on your server in the host's own sandbox | The whole context table below, and the data the page or host hands in | A code only; the words come from `messages` |
| A plugin validator (`validators` on a plugin) | The page only. It may be asynchronous and may fetch. A server never repeats it | The answers, the form's id and the locale | A code, with `parameters.message` or the page's `messages` |
| A host validator on your server | Your server, after the sandbox accepted the answers | The judged answers, the definition, who sent it, and your own database | The host's own `message`, sent back with the code. See [Spring Boot](/spring-boot) and [FastAPI](/fastapi) |

Reach for them in this order:

1. **A formula first.** `validWhen` needs no code, shows in the builder, and runs on both sides.
2. **A rule module** for what a formula cannot say, or for data the page hands in. It runs in the sandbox, so the server reaches the same verdict. Load the same module in the host: [Spring Boot](/spring-boot) takes it through `SandboxRulesProvider` and [FastAPI](/fastapi) through `rules_providers`.
3. **A host validator** for what needs your own database, such as a number that must not have been used before. The sandbox cannot reach one.

A plugin validator suits a check that only makes sense in the page, such as asking your address service whether a postcode exists. Whatever it finds, the server must still decide, so repeat the check in a host validator.

## When errors appear

The form-wide setting `validateOn` in the root configuration says when a field is checked as the person leaves it.

- **`commitAfterError`** (the default). A field is never checked the first time it is left, and is checked again as soon as it shows an error or the person has tried to go on.
- **`submit`**. Answers are judged only when the person tries to go on, and leaving a field checks nothing.

A submit, a journey page's Continue and a steps container's Continue all count as going on.

## In the page

Set `wasm="auto"` and the element fetches `datum-wasm.js` from beside the bundle once the form is live, runs the sandbox in the page, and reports the verdict on `datum-wasm-validated` along with the run log. This is for development and testing: it shows what the server will say before a server exists.

```html
<datum-form src="/forms/intake.json" wasm="auto" wasm-log-level="info"></datum-form>
```

`wasm` takes `auto` or the URL of the module.

- The module is fetched once per URL and shared by every element on the page; each element builds a sandbox of its own from it.
- A URL on another origin is refused unless `allow-origins` lists it (see [Security headers](/security-headers)).

### Rules of your own

Field constraints such as required, a pattern or a length come from the definition, and the sandbox checks them at every submit. A rule the definition cannot express, such as a name that needs two words or a contact method offered in some countries only, is a small program of your own that the sandbox runs after them.

`wasmPlugins` takes a list of `{ id, version, source }`. The source is an ES2020 program whose value is `{ validators: [(context) => ({ errors })] }`.

- Each validator runs once per submit, in the order the modules and validators are listed, and answers at once: a promise is refused.
- The sandbox has no `Date`, no `Math.random` and no network, so a server that runs the same program over the same answers reaches the same verdict.
- Return codes and the fields they belong to, never text; the page words the codes with `messages`.

```js
form.wasmPlugins = [{
  id: "intake-rules",
  version: "1.0.0",
  source: `({
    validators: [(context) => {
      const errors = [];
      if (typeof context.values.age === "number" && context.values.age < 18) {
        errors.push({
          code: "custom.tooYoung",
          componentId: "age",
          stage: "intake-rules",
          source: "custom",
          parameters: { minimum: 18 }
        });
      }
      return { errors };
    }]
  })`
}];
form.messages = { "custom.tooYoung": "You must be {minimum} or older." };
```

#### The context a rule receives

A validator is handed one object. Every field is read-only, and `values` is a deep-frozen copy: writing to it changes nothing the run stores.

| Field | What it holds | When it is absent |
|---|---|---|
| `values` | The answers the run judged, a flat map keyed by value path (`billing.street`, `items[0].sku`) | Never |
| `formId` | The form's id | Never |
| `locale` | The locale the person answered in | When the form has none |
| `form` | The definition's root component, with every component below it | When the run was sent no definition |
| `today` | The calendar day, `YYYY-MM-DD`: the page's own day, or the day a server host judges by | When the host gave none. A rule that needs the day must then do nothing, since the sandbox has no clock |
| `hostContext` | The values `host.` reads: in the page, the page's `hostContext`; on a server, the values the host worked out itself | When none was supplied |
| `externalData` | What `wasmExternalData` handed in (below) | When nothing was handed in |
| `journey` | The journey the answers were given through | For a form without one |
| `page` | The journey page a host is checking | In the page. A server host may set it |
| `optionSnapshot` | The options each data source held, by source id, as `{ value, label? }` lists | When the form has no source-backed choice |
| `kinds` | The definition's map from a plugin or binding type to the standard type it reads as | When the definition has none |
| `translations`, `catalog` | The definition's translations and the host's catalogue, as the run was given them | When there are none |
| `unknownFields` | `strip`, `keep` or `reject`: what the run does with keys the form does not define | When the run did not set it (`strip` applies) |
| `logLevel` | The level the run log keeps | When the run did not set it (`warn` applies) |
| `formulaErrors`, `riskyPatterns` | The run's policies for a formula that cannot be read and for a risky regular expression | When the run did not set them |
| `reportFold` | Whether the outcome carries the fold's results | In the page. A server host may set it |
| `log` | The run log: `debug`, `info`, `warn` and `error`, each `(message, data?)`, and `level` | Never |

The delivered document is never in a validator's context. A rule judges `values`, and the verdict does not depend on how the answers were wrapped.

#### The error a rule returns

A validator returns `{ errors: [...] }`, one entry per problem, and `{ errors: [] }` for a pass.

- **A bad answer.** An answer that is not an object with an `errors` list, a promise, or an entry without a string `code` fails the run closed: the page blocks the submit with `wasm.execution_error`, and a server host refuses it as unavailable.
- **A throw.** A validator that throws blocks the run with `validator.failed`, whose `parameters.validator` is the validator's position counting from 1; the message of the throw goes to the run log at `error`.

| Key | What it is |
|---|---|
| `code` | Required. A string that names the problem and keys its wording. Use your own prefix (`custom.tooYoung`) so it cannot clash with a code of the engine |
| `componentId` | The component the error belongs to. Without it the error belongs to the form as a whole and is listed in the summary only |
| `path` | The value path when the error is on a row or a nested field, such as `items[1].sku` |
| `severity` | `error` (the default), `warning` or `info`. See below |
| `parameters` | Plain data that fills `{name}` tokens in the message (strings and numbers only). `parameters.message` carries a text for the code when nothing words it |
| `stage` | A name for where it came from, such as your module's id. The declared type requires it |
| `source` | Who said it: `custom` for a rule of your own. The declared type requires it |

#### Severities

Only `error` blocks. A severity that is none of the three counts as `error`.

| Severity | In the page | In the sandbox verdict |
|---|---|---|
| `error` | Blocks the submit. Shown on the field and in the error summary | The run is blocked: the outcome carries the errors and no `values` |
| `warning` | Never blocks. A notice under the field, led by the word "Warning:", and not listed in the summary | Accepted. The warning rides along in the outcome's `errors` |
| `info` | The same, led by the word "Information:" | The same |

A host that receives an outcome of warnings and information alone accepts the submission. This is how a rule asks "are you sure?" without refusing.

#### What the page hands in

The sandbox never fetches. `wasmExternalData` is what the rules read beside the answers: an object, or a function the form calls at every submit with `{ formId, values, locale }` and that returns the object, or a promise of it. Every value must be plain data.

```js
form.wasmExternalData = ({ locale }) => fetch("/api/phone-countries").then((r) => r.json());
```

Inside the rule it is `context.externalData`.

- A function that rejects, or that takes longer than `data-source-timeout` (15 seconds by default, `0` for no limit), blocks the submit with `wasm.execution_error`.
- The data is not part of the submission.
- A server host supplies the same data from its own side: [Spring Boot](/spring-boot) calls this a `SandboxContextContributor` and [FastAPI](/fastapi) a context contributor.

#### The run log

The sandbox has no console. What the kernel did, step by step, and what a validator wrote to `context.log` come back as the run log. `wasm-log-level` sets how much it keeps.

| Level | Keeps |
|---|---|
| `off` | Nothing |
| `error` | Errors only |
| `warn` | Warnings and errors. The default: a run that behaves returns no log |
| `info` | Adds one line per step and the verdict |
| `debug` | Adds every step, including each validator's count of errors |

An entry is `{ level, message, data? }`.

- A run keeps at most 200 entries; past that it adds a final warning, "run log truncated", with the counts.
- A message over 8 KiB is cut with a marker, and `data` over 8 KiB is replaced by a note of its size.
- Write plain data only, so the same run yields the same log on every host.

#### The outcome

The sandbox answers with an outcome, and the element reports it on `datum-wasm-validated` as `detail.outcome`.

| Key | What it holds |
|---|---|
| `errors` | Every error, the engine's and your rules', in the shape above. A run reports at most 10,000; past that the list is cut and ends with `errors.truncated` |
| `values` | The sanitized submission. Only when nothing blocked: keys the form does not define are removed, calculations recomputed |
| `index` | The same values as one row per answer: `path`, `delta`, `value`. Present whenever `values` is |
| `logs` | The run log, when it kept anything |
| `clientDerived` | Value paths worked out in the browser and kept as sent |
| `clockDependent` | Components whose rules read the clock |
| `serverRules` | Components whose server-only rules this run applied |
| `visibilitySkipped` | Components whose visibility the run could not replay |
| `pageComponentIds` | The components in scope for `page`, when a journey page was named |
| `withheld`, `effectiveState`, `submittable`, `trace` | The fold's results, when the run asked for them with `reportFold` |
| `canonical`, `digest` | The delivered document as canonical text, and its SHA-256 as lowercase hex. Only when the run was given the document |

Only the keys that apply appear. [Your own server](/server-programs) says what a host does with each.

`datum-wasm-validated` is raised at every submit that reached the sandbox. Its `detail`:

| Key | What it holds |
|---|---|
| `blocked` | Whether the verdict blocks the submit |
| `durationMs` | How long the run took |
| `values` | The answers the page sent |
| `externalData` | What `wasmExternalData` handed in, when it did |
| `unknownFields`, `logLevel` | The run's settings |
| `outcome` | The outcome above, when the sandbox answered |
| `executionError` | Why it gave no answer, when it did not |
| `logs` | The run log, `outcome.logs` or an empty list |

`datum-wasm-ready` is raised when the sandbox has arrived, with `detail.host`.

#### Timeouts

| Setting | What it limits | Default |
|---|---|---|
| `wasm-timeout` | How long the page waits for the module to load and build. `0` waits without limit. A module that never loads is reported as `datum-error` and blocks the submit with `wasm.execution_error`, never silently passes it | 15000 ms |
| `data-source-timeout` | How long a `wasmExternalData` function may take, as for any data source | 15000 ms |
| The run's time budget | How long one run may take before the sandbox interrupts it. A run that exceeds it blocks the submit with `wasm.execution_error` | In the page: 250 ms, scaled up with the number of rules, the size of the definition and the request, to at most 5 seconds |

Starting the sandbox has its own budget of 2 seconds. A server host sets its own run budgets: see [Your own server](/server-programs).

#### Loading the sandbox yourself

A page that imports `datum-wasm.js` itself builds the sandbox with `createWasmValidationHost(plugins, options)` and assigns it, or the promise of it, to `wasmValidationHost`.

- A submit made before it arrives waits for it.
- A sandbox built this way carries its own plugins, so leave `wasmPlugins` out.
- The `options` can set `maxEvalMs` (the run budget), `maxStartupMs` and `memoryLimitBytes` (32 MiB by default).

```js
import { createWasmValidationHost } from "./datum-wasm.js";

form.wasmValidationHost = createWasmValidationHost([
  { id: "intake-rules", version: "1.0.0", source: rulesSource }
], { maxEvalMs: 500 });
```

The module also exports `certifyWasmPlugin(plugin)`, which loads a rule module in a sandbox and probes it, answering `{ ok, validatorCount, code?, message? }`, and `WASM_ABI_VERSION`. Run the first in a test before you ship a module.

<LiveExample name="wasm" />

Type a first name alone in Full name and submit: the sandbox answers `custom.fullNameIncomplete` and the page's words for it appear under the field. Pick Mexico and Phone to see the rule over two fields and the list the page handed in. Each submit writes the run log under the result; set the log level to Info or Off and submit again to see how much it keeps.

## On the server

In production the page does not carry the sandbox. The element raises `datum-submit` with the canonical envelope, your page posts it to your host, and the host runs the same program inside its own WASM runtime over the definition it has registered for that form id and version. The verdict comes back as a receipt or as field errors, which `setErrors()` shows on the right fields.

The sandbox cannot reach the network, the file system, the clock or anything on the host it was not handed. It receives the definition, the answers and the run's options, and returns the verdict, the canonical document and its digest.

### Rules that read the host

A rule that reads `host.` (see [Values from the host](/formulas#values-from-the-host)) is judged on the server only when the host passes `hostContext` in the run: an object it works out itself from the request, such as the signed-in person's role. The browser's values are for display, and the server supplies its own: never trust the page's, which a client can set to anything, and they are not in the envelope anyway.

- **With a context.** A field shown only to administrators and marked required is enforced for an administrator and not asked of anyone else, and a name the context does not hold has no value.
- **Without one.** Every rule that reads `host.` is left unjudged, as before: the field keeps its own settings, it is not required when the host shows it, and a calculation keeps the value sent.

### Versions and your own host

A program is pinned to an interface version; a host refuses a program or a definition it was not built for. [Your own server](/server-programs) describes running the program without a Datum host, and says what a host does with keys the form does not define (`unknownFields`).

## What is checked

- **Shape**: every answer belongs to a component of the definition, with the type that component declares. Reserved ids are refused. Unknown keys are removed by default; a host can keep them or refuse them with `unknownFields`.
- **Rules**: required, shown and hidden, calculated values and option lists are re-derived from the answers, never trusted from the page.
- **Constraints**: length, range, pattern, choice sets, file budgets. A pattern that could run away is refused unless the host allows it.
- **Journeys**: the pages a person passed through must form a valid path for the answers given.
- **Data sources**: an answer drawn from a data source is checked against the snapshot the form saw.

The result is a verdict with codes per field, the same codes the page shows, so a message authored in the builder reads the same from either side.

## Signed submissions

A submission is the answers as a JSON record in canonical form, so the same answers always give the same bytes. A passkey or security key can sign those bytes with WebAuthn before the form sends them; the server recomputes the challenge and reports every check on its own, so a failed verdict says exactly why. `signing-scope` says what the signature covers, and `sign-with` names the provider every submit signs with. See [Signing a form with a passkey](/passkey-signing).
