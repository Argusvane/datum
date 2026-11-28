# Codes and messages

Everything Datum refuses, warns about or reports carries a code: a short string such as `required`, `number.min` or `draft.notFound`. A page words a code for the person, a server host returns it, and a test names it. This page is the one place to look a code up. Each section says what raises the code, what it carries, and what to do about it.

A validation error has this shape: `{ code, componentId?, path?, severity?, parameters?, message? }`. The `parameters` fill the `{name}` tokens of a message. The tokens are single braces, so `Enter at least {minLength} characters` says "Enter at least 3 characters" when the error carries `{ minLength: 3 }`. A code that nothing words is shown as the bare code. [Languages](/languages) says how a page words codes and how a form carries its own wording.

- [Validation codes](#validation-codes): the field checks, the choice checks and the grid checks
- [Severities](#severities): what error, warning and info do to a submit
- [Sandbox and run codes](#sandbox-and-run-codes): what a validation run itself reports
- [Definition problem codes](#definition-problem-codes): what `check` says about a definition
- [datum-error and datum-warning](#datum-error-and-datum-warning): what the elements tell the page
- [Draft errors](#draft-errors)
- [Journey navigation refusals](#journey-navigation-refusals)
- [Codes a host returns](#codes-a-host-returns)
- [PDF failure codes](#pdf-failure-codes) and [PDF warning codes](#pdf-warning-codes)
- [Signing and passkey codes](#signing-and-passkey-codes) and [The signing agent's codes](#the-signing-agent-s-codes)

## Validation codes

The checks below run in the page and again in the sandbox, with the same codes, parameters and order. A field gets one error at a time, the first that applies, in the order of the table:

1. What the control itself knows (an unreadable number, a part-filled date).
2. `required`.
3. The kind of the answer.
4. Its bounds.
5. The file checks or the text checks.
6. The field's own `validWhen` rule.

An answer is empty when it is absent, `null`, a text of spaces only, an empty list, a checkbox that is not ticked, or a `checkboxes` group with nothing ticked. An empty answer that is not required raises nothing. A non-empty answer is checked against the rest.

| Code | Raised when | Parameters | Default message |
|---|---|---|---|
| `number` | A number field holds text that is not a number, or was sent something other than a number. A box the browser could not read adds `badInput: true` | `badInput` | Enter a number |
| `dateIncomplete` | A date was typed in part: one or two of day, month and year are filled | `missing` (the parts left, such as "month and year"), `missingKey` (such as `month-year`), `missingParts` | Enter a complete date |
| `required` | A required field is empty. A field is required by `required`, or by `requiredWhen` while the rule holds | none | This field is required |
| `text` | A text or text area was sent an answer that is not text | none | Enter text |
| `date` | A date field's answer is not a real calendar date written `YYYY-MM-DD` | none | Enter a real date |
| `number.min` | A number is below `configuration.min`. The bound itself is allowed | `min` | Enter a number of {min} or more |
| `number.max` | A number is above `configuration.max`. The bound itself is allowed | `max` | Enter a number of {max} or less |
| `date.min` | A date is before `configuration.min`, written `YYYY-MM-DD`. The bound itself is allowed | `min` | Enter a date on or after {min} |
| `date.max` | A date is after `configuration.max`. The bound itself is allowed | `max` | Enter a date on or before {max} |
| `file` | A file field's answer is not an uploaded file, or a list holds an entry that is not one | none | Upload a file |
| `fileCount` | More files than the field takes: one for a single-file field, `maxFiles` for a field with `multiple` (100 when `maxFiles` is not set) | `count`, `maxFiles` | Too many files: the most allowed is {maxFiles} |
| `fileSize` | A file declares a size no file has: negative, or not a whole number | `file`, `size` | This file could not be read. Choose it again |
| `file.sizeMismatch` | A file's inline bytes are well past the size it declares. A server catches an honest size that was a lie | `file`, `size`, `actual` | This file could not be read. Choose it again |
| `maxFileSize` | A file is larger than `maxFileSizeMb`. Size is checked before type | `file`, `size`, `maxFileSize`, `sizeLabel`, `maxFileSizeLabel` | {file} is larger than the {maxFileSizeLabel} this field accepts |
| `fileType` | A file's name or type is not in `accept` | `file`, `type`, `accept` | {file} is not a type of file this field accepts |
| `minLength` | A text is shorter than `minLength`, counted in characters | `minLength`, `length` | Enter at least {minLength} characters |
| `maxLength` | A text is longer than `maxLength`, counted in characters | `maxLength`, `length` | Enter no more than {maxLength} characters |
| `pattern` | A text does not match `pattern`. The pattern must match the whole answer | `pattern`; `invalid: true` or `risky: true` when the pattern could not be run; `message` when `patternMessage` is set | Enter a value in the expected format |
| `rule` | The field's `validWhen` rule does not hold for a non-empty answer that nothing above refused | none | Check this answer |
| `rows.min` | A data grid holds fewer rows than its minimum | `min`, `count` | Too few rows: add at least {min}. |
| `rows.max` | A data grid holds more rows than its maximum, or past the 500-row cap when it sets none | `max`, `count` | Too many rows: at most {max}. |
| `option.notAllowed` | A choice answer is not one of the options the field offers. A `select` or `radio` answer is one value, a `checkboxes` answer is a set of ticked values | `keys` (the values refused) | Choose one of the options offered |
| `option.sourceUnavailable` | A choice takes its options from a data source and the run was given no list for it, so the answer cannot be checked and is refused | `keys`, `sourceId` | This answer could not be checked. Try again later. |

How the rows of the table are set:

- `min` and `max` on a number are numbers. On a date they are `YYYY-MM-DD` texts. If `min` is above `max`, both are ignored.
- `minLength` and `maxLength` are whole numbers of 1 or more, and are ignored together if the minimum is above the maximum. A character is a Unicode code point, and spaces count.
- `maxFileSizeMb` is megabytes per file. Zero, a negative number or an unreadable value means no limit. The labels are `512 B`, `12 KB` or `1.5 MB`.
- `accept` is a list of extensions (`.pdf`), type families (`image/*`) or full types (`application/pdf`). A file passes when its name ends with an extension in the list or its type matches. An empty list accepts everything.
- A `pattern` that cannot be compiled, or that is of a runaway shape, cannot be shown to match, so under `formulaErrors: "fail"` (the default) it refuses a non-empty answer, and under `warn` it is skipped. See [Rules and formulas](/formulas#risky-patterns).
- `option.notAllowed` and `option.sourceUnavailable` stand on a hidden field too, since the answer is stored. A source declared with `answersFree: true` is not held to its list. See [Data](/data#how-the-server-checks-an-answer).
- A `rule` error is worded with the field's own `messages.rule`. Its default, "Check this answer", is only a placeholder.

### Wording a code

A component's `configuration.messages` maps codes to text, and the page's `messages` attribute is a catalogue of the same shape:

```json
{
  "id": "age",
  "type": "number",
  "configuration": {
    "label": "Age",
    "min": 0,
    "max": 120,
    "messages": {
      "number.min": "Age cannot be below {min}",
      "number.max": "Age cannot be above {max}"
    }
  }
}
```

A text pattern's own sentence is the field's `patternMessage`. Any code in this page can be worded the same way, and so can a code of your own.

## Severities

Every error has a severity: `error`, `warning` or `info`. An error without one is an `error`, and so is one with a word that is none of the three.

| Severity | In the page | In a sandbox verdict and a host's answer |
|---|---|---|
| `error` | Blocks the submit. Shown on the field and in the error summary | The run is blocked and returns no `values`. A host answers with the errors and stores nothing |
| `warning` | Never blocks. Drawn under the field as a notice led by "Warning:", and not counted in the summary | The submission is accepted, and the warning rides along in the outcome's `errors` |
| `info` | The same, led by "Information:" | The same |

A reply that holds only warnings and information is an acceptance. A rule uses this to say "are you sure?" without refusing. A journey page's server check that comes back with only warnings stops Continue once, and Continue again with the same answers goes on. See [Validation](/validation#severities) for how a rule sets one.

## Sandbox and run codes

These come from a validation run itself, in the page (`wasm="auto"`) or on a server. Most carry no `componentId` and are listed in the summary only. [Your own server](/server-programs) says how a host turns them into answers.

| Code | Raised when | Parameters | What to do |
|---|---|---|---|
| `wasm.execution_error` | The page's run gave no verdict: the sandbox module did not load in time, a run passed its time budget, a rule returned something unusable (a promise, no `errors` list, an entry with no `code`), `wasmExternalData` failed, or the outcome was not of the expected shape. The submit is blocked and nothing is sent | `message` (the reason) | Read `parameters.message` and the `datum-error` before it. See [Validation](/validation#timeouts). A server host answers the same refusal as a 503 with this code: no verdict was reached, so it is never a 422 |
| `wasm.values-missing` | The sandbox accepted the answers but handed back none to send. The submit fails closed | none | A mismatched or hand-written sandbox. Rebuild `datum-wasm.js` from the release you deploy |
| `validator.failed` | A rule module threw instead of answering | `validator` (its position, counting from 1) | Read the run log: the throw's message is there at `error` |
| `formula.invalid` | A formula cannot be read, a function a rule calls does not exist on this side, a plugin function threw, or calculations never settle on a value (a cycle). Under `formulaErrors: "fail"` the definition is refused and nothing else is judged; under `warn` the rule is dropped and logged. A rule that runs on the server and calls a function the server lacks refuses the run under either | `where` (such as `rules:phone:visibleWhen`), `message`, `function` | Fix the formula, or load the plugin that supplies the function on this side. `check` lists the same problems with their spans |
| `fold.unsettled` | The form's rules keep flipping one another through the answers they hide, so there is no one set of answers to check | none | Change a rule so two do not depend on each other's hidden answers |
| `map.unsettled` | The values a journey's presentation works out keep changing which of their own sources show | none | The same |
| `unknown_field` | Under `unknownFields: "reject"`, the submission has a key the form does not define. One error per key | `field` | Stop sending the key. The default is `strip`, which removes it silently, and `keep` passes it through |
| `option.notAllowed`, `option.sourceUnavailable` | A choice answer is refused. See [Validation codes](#validation-codes) | | |
| `errors.truncated` | A run found more than 10,000 errors. The list is cut after the verdict, so the marker blocks whenever what was cut could have blocked | `reported`, `shown` | Treat the run as blocked. Fix the largest source of errors first |
| `definition.tooDeep` | Components nest more than 32 levels deep, counting the root as level 1. Nothing else is judged | `where`, `limit` | Flatten the form. A tree is judged only as deep as the sandbox's stack allows |
| `definition.malformed` | A `children` that is not a record of slots, a slot that is not a list, or an entry that is not a component | `where` | Fix the definition. `check` names it |
| `definition.idCycle` | A component shares its id with one of its own ancestors | `where` | Give the child its own id |
| `journey.invalid` | The journey a host passed in is not a usable journey. The run fails closed rather than judge the answers as a whole form | none | A host bug: pass the journey from a checked definition |
| `journey.page.tooMany`, `journey.route.tooMany` | The journey passed in has more than 1,000 pages in all, or a page with more than 64 routes | `limit` | See [Limits](/limits) |
| `journey.clockDependent` | A journey page or route reads the clock and the run was given no `today`, so the path cannot be replayed | `journey`, `page` | Send `today`, the host's own day, on every run of a journey that uses `today()` or `age()` |
| `journey.exit` | The answers end the journey at an exit page, which sends nothing | `journey`, `page` | Not a fault: the person is shown the exit page instead of a submit. The default message is "You cannot send this form with these answers." |
| `journey.unknown` | The submission names a journey the form does not have. Raised by a host's submission service | none | Reload the page, so it and the host hold the same form. Default: "This version of the form cannot be sent. Reload the page and try again." |
| `journey.server-unavailable` | A journey page's server check could not be answered: the service was unreachable, answered in an unreadable way or timed out, and the page's `onUnavailable` is `block`. Raised in the page | none | Check `validate-url` and the endpoint. Default: "We could not check your answers. Try again." |
| `invalid_request` | An `__datum_inspect` request has no usable shape, or a `test` request is over its caps. Not an error of a run | `where`, `limit` | See the answer's message. Test limits are in [Limits](/limits#form-tests) |
| `abi_mismatch` | A program was asked for an interface version it does not answer. A host refuses to serve it | none | Build the programs from the release you deploy |

Some codes belong to the sandbox's host, not to the run:

| Code | Raised when |
|---|---|
| `request_refused` | The request is nested more than 320 levels deep, or longer than 32 Mi characters |
| `outcome_too_large` | A run's answer is longer than 8 Mi characters |
| `compile_error`, `not_a_module`, `interrupted`, `runtime_error`, `never_settles` | A rule module does not compile or is not a module, a run is interrupted by its time budget, throws past the kernel, or never settles |

The sandbox's time, memory and stack budgets are in [Limits](/limits#the-sandbox).

## Definition problem codes

The `check` operation of the sandbox program, and the builder before it saves, judge a definition's structure. It answers two lists, each entry `{ code, where, message, limit? }`:

- `structure`: refusals. Any refusal makes the verdict `fail`.
- `structureWarnings`: findings that never refuse.

Each list holds 200 entries at most, and the 201st is `definition.problemsTruncated`. Formula problems come in a separate list, `problems`, whose verdict follows `formulaErrors`.

The caps behind the `tooMany` and `tooLong` codes are tabled in [Limits](/limits).

| Code | Refused or warned | Meaning |
|---|---|---|
| `definition.id.invalid` | refused | The definition has no `id` of 1 to 128 characters |
| `definition.version.invalid`, `definition.version.tooLong` | refused | `version` is missing or not text, or is over 64 characters |
| `definition.schemaVersion.invalid` | refused | `schemaVersion` is missing or not text |
| `definition.root.type` | refused | The root is not of type `form` |
| `definition.section.invalid` | refused | A top-level section that must be an object is not |
| `definition.key.unknown` | warned | The definition has a top-level key this version does not read |
| `definition.key.prototype` | refused | A key named `__proto__` |
| `definition.components.large` | warned | More than 2,500 components: consider splitting the form |
| `definition.tooManyComponents` | refused | More than 10,000 components |
| `definition.paths.tooLong` | refused | All collection paths and data paths together are over 65,536 characters |
| `component.notRecord` | refused | A child entry is not an object |
| `component.children.invalid` | refused | `children` is not lists of components, one list per slot |
| `component.configuration.invalid` | refused | `configuration` is not an object |
| `component.collection.invalid` | refused | `collection` is not an object with a text `collectionPath` |
| `component.key.unknown` | warned | A component has a key this version does not read |
| `component.id.invalid` | refused | An id that does not follow the [id grammar](/limits#ids-and-names) |
| `component.id.duplicate` | refused | Another component already has this id |
| `component.id.reserved` | refused | An id of `component`, `host`, `row`, `ancestor`, `constructor` or `prototype` |
| `component.id.prototypeName` | warned | An id that is also a name every object has, such as `toString`, which some hosts read wrongly |
| `component.type.invalid` | refused | A `type` that is empty or over 128 characters |
| `component.type.unknown` | warned | This host cannot draw a component of this type |
| `component.dataKey.invalid` | refused | A data key outside the [data key grammar](/limits#ids-and-names) |
| `component.dataKey.prototype` | refused | A data key or path of `__proto__` |
| `component.dataKey.prototypeName` | warned | A data key that is also a name every object has |
| `component.dataPath.duplicate` | refused | Two components would store their answers in one place. Give one a data key |
| `component.dataPath.conflict` | refused | A component would be stored inside a place that cannot hold it |
| `component.path.tooLong` | refused | A collection path or data path over 512 characters |
| `component.pattern.tooLong` | refused | A `pattern` over 2,000 characters |
| `component.pattern.invalid` | refused | A `pattern` that does not compile, so no answer can match it |
| `component.limits.inverted` | warned | A minimum above its maximum, so the form ignores both |
| `component.dataGrid.bounds` | warned | A data grid's minimum rows, maximum rows or rows to start with is not a whole number from 0 to 500, or the minimum is above the maximum |
| `component.dataGrid.boundsRule` | warned | A rows formula on a component that is not a data grid, where it does nothing |
| `option.list.invalid` | warned | `options` is not a list |
| `option.entry.invalid` | warned | An option has no text `value`; the form draws it without the entry |
| `option.value.duplicate` | warned | Two options share a value |
| `option.count.large` | warned | More than 500 options in one list: consider a data source |
| `option.tooMany` | refused | More than 2,000 inline options on one component |
| `option.total.tooMany` | refused | More than 50,000 inline options in the definition |
| `chrome.part.id.missing` | refused | An authored header or footer part has no usable `id` |
| `chrome.part.id.duplicate` | refused | Two header or footer parts share an `id` |
| `localization.invalid` | refused | `localization` is not locale codes such as `en` or `fr-CA` in a list |
| `localization.locale.duplicate` | warned | A locale listed twice |
| `localization.defaultLocale.unknown` | warned | The default locale is not one of the supported locales |
| `localization.tooMany` | refused | More than 64 locales |
| `journey.invalid` | refused | A journey without an `id` and a list of pages in the shape the runtime reads |
| `journey.id.duplicate`, `journey.page.duplicateId` | refused | Two journeys, or two pages of one journey, share an id |
| `journey.id.reserved`, `journey.page.id.reserved` | refused | An id of `__proto__`, `constructor` or `prototype` |
| `journey.page.idIsComponentId` | warned | A page id is also a component id |
| `journey.page.unknownComponent` | warned | A page names a component the form does not have |
| `journey.route.unknownTarget` | warned | A route names a page this journey does not have; the runtime ignores it |
| `journey.route.backward` | warned | A route goes to an earlier page or its own page; the runtime ignores it |
| `journey.tooMany` | refused | More than 32 journeys |
| `journey.page.tooMany` | refused | More than 1,000 pages in all |
| `journey.route.tooMany` | refused | A page with more than 64 routes |
| `pdf.invalid`, `pdf.layout.invalid` | refused | The PDF block is not a list of layouts, or a layout lacks an id, a kind (`generated` or `template`) and its root or template source |
| `pdf.layout.duplicateId` | refused | Two layouts share an id |
| `pdf.layout.id.reserved` | refused | A layout id of `__proto__`, `constructor` or `prototype` |
| `pdf.layout.idTooLong` | refused | A layout id over 128 characters |
| `pdf.defaultLayoutId.unknown` | warned | `defaultLayoutId` names no layout |
| `pdf.tooMany` | refused | More than 64 layouts |
| `kinds.invalid`, `kinds.type.invalid`, `kinds.type.engine`, `kinds.base.invalid` | refused | The [kinds map](/definition#the-kinds-map) is not an object, names a type that is empty or over 128 characters, maps one of the engine's own types, or names a base that is not allowed |
| `kinds.tooMany` | refused | More than 4,096 entries in `kinds` |
| `validateOn.invalid` | warned | `validateOn` is neither `submit` nor `commitAfterError`; it is read as `commitAfterError` |
| `definition.problemsTruncated` | | More problems were found than the 200 listed |

### Formula problem codes

`check` lists each formula that cannot be read as `{ where, code, message, params?, start?, end? }`, with `where` as `rules:<componentId>:<key>`, `journey:<journeyId>:page:<pageId>` or `pdf:<layoutId>`, and `start` and `end` the span in the text.

| Code | Meaning |
|---|---|
| `unexpected` | A token where none fits (`token`) |
| `expectedValue`, `expectedValueHere` | The formula ended where a value was due, or a value was due at `token` |
| `expectedOperator` | Two values with nothing between them |
| `unclosedParen`, `unmatchedParen` | A parenthesis without its partner |
| `unterminatedString`, `unterminatedName` | A quote or a backtick without its closing one |
| `curlyQuote` | A typographic quote where a straight one was meant |
| `emptyName` | A backticked name with nothing inside |
| `badChar` | A character the grammar has no use for (`char`) |
| `unknownFunction` | A call to a name that is not a function on this side (`name`) |
| `arity`, `arityMin` | A call with the wrong number of arguments (`name`, and `expected`, `min` and `got`) |
| `betweenAnd`, `inList`, `intervalDots`, `ifThen` | `between` without its `and`, `in` without a list, an interval without `..`, `if` without `then` |
| `chainedCompare` | `a < b < c`, which the grammar refuses |
| `numberTooLarge` | A number literal past the range of a double |
| `badUnit` | `dateAdd` or `dateDiff` with a literal unit other than days, weeks, months or years |
| `tooDeep` | Nesting past 100 levels in a formula (`max`) |
| `pattern.risky` | A `matches` call with a literal pattern of a runaway shape, while `riskyPatterns` is `refuse` (`pattern`) |
| `invalidRule` | A rule that is not a formula or the object form, an expression tree among them (`got` is `tree`). The key is dropped |
| `runScope` | A `run` the rule's place may not take. The rule runs on both sides |
| `condition.notBoolean`, `rule.unsupportedScope` | Findings that never refuse: a condition that is provably not yes or no, and a `validWhen` on a field inside a repeating section, which neither side runs |

## datum-error and datum-warning

`<datum-form>` and `<datum-form-builder>` never throw out of an attribute or a load. They log to the console and dispatch an event that bubbles and crosses shadow boundaries, so a page can show the problem.

`datum-error` has `detail: { code, message, cause? }`.

- A page matches on `code`, which is stable, and shows `message` as written or words it itself. The message can change between releases.
- `cause` holds the underlying error when there is one.

The codes are in [datum-error codes](#datum-error-codes) below.

| What happened | Message | What to do |
|---|---|---|
| An attribute value is not usable | `change-on must be one of input, commit, not "x"`, `change-debounce must be a whole number of milliseconds, not "x"`, `data-source-wait must be "none" or "all", not "x"`, `data-source-timeout must be a whole number of milliseconds (0 for no limit), not "x"` (the same for `wasm-timeout` and `validate-timeout`), `risky-patterns must be one of refuse, allow, not "x"`, `mode must be "interactive" or "readonly", not "x"`, and the like for the other enumerated attributes | Correct the attribute. The old value stays in force |
| `features` names a word that is no feature | `features names no such feature or preset: "x"` | Use a name from the [features list](/leaving-parts-out) |
| `max-definition-bytes` is not usable | `maxDefinitionBytes must be a whole number of bytes above 0, not x` | The 2 MiB cap stays |
| `allow-origins` lists a word that is not an origin | `allow-origins lists origins as URLs (https://cdn.example); "x" names none and is left out` | Write each origin as a URL |
| An attribute that loads code or posts answers names another origin | `The wasm attribute was not used: it names https://other.example, and an attribute loads only from this page's origin or one allow-origins lists (the wasmValidationHost property may name any).` (also for `pdf`, `pdf-pages`, `draft-store` and `validate-url`) | List the origin in `allow-origins`, or set the property from script. See [Security headers](/security-headers) |
| `draft-store` is not a known value | `draft-store must be "server:<url>" or "local", not "x"` | Use `local` or `server:` and a URL |
| A draft key cannot name a draft under the store's URL | `draft-store: the draft key "x" cannot name a draft under <url>` | Use a key that is a single non-empty path segment, not `.` or `..` and with no `/` |
| A definition was refused before it reached the runtime | `The form was not loaded: <problem>`. The problem says why: it is not an object with a `root`, nests too deeply, a node is not a component, a component is its own ancestor, `root` is not of type `form`, or the text is over the size cap (for example `it is 3,000 KB; up to 2 MB is read`) | The form that was shown stays. Correct the definition and set it again |
| `src` and `definition` were both set | `The form was not loaded: the form from src (<url>) is still loading; set src to nothing first to assign a definition in its place.` or `The form was not loaded from src (<url>): a definition is assigned to this form; set definition to nothing first to load one from src.` | Use one route at a time |
| The `src` fetch failed | `Could not load the form definition from <url>: <reason>`. The reason is an HTTP status (`404 Not Found`), a size message, a JSON parse error or a network failure | Check the URL, the server's CORS headers and its MIME type |
| The fetched JSON is not a form | `The form definition at <url> is not usable` | Check the file against [the definition](/definition) |
| The runtime could not be built | `The form definition could not be loaded into a runtime`, with the cause | Read the cause: usually a formula that cannot be read under `formulaErrors: "fail"`. Run `check` on the definition |
| Two components share an id | `The form has more than one component with the id "x"; they share one value. Give each component its own id.` The form is still drawn | Give each its own id |
| A value could not be applied | `Could not set the initial value of "path"`, `Could not keep the answer of "path"` (after a rebuild), `Could not switch to locale "x"`, `Could not open the journey's page "x"` | The cause says which answer or locale was refused |
| A lazy file did not arrive | `<what> could not be loaded: <reason>`, with `what` one of `The journeys runtime (datum-form-journey-engine-chunk-*.js)`, `The sandbox module (<url>)`, `The PDF module (<url>)`, `The PDF pages module (<url>)`, `The WebAuthn code (datum-form-webauthn-*.js, or the ./webauthn module)`, `The server validator (datum-form-server-validator-*.js)`. The form shows a card with a Retry button | Deploy the file beside the bundle, serve it as JavaScript from an origin the page may load from, and retry. A failed load is tried again on the next use |
| The sandbox is stale or not a sandbox | `The sandbox module at <url> speaks ABI x, this element needs ABI y; rebuild or update datum-wasm.js`, `The sandbox module at <url> does not export createWasmValidationHost()` | Rebuild `datum-wasm.js` from the release you deploy |
| The sandbox could not start | `The validation sandbox could not be loaded (wasm="x"): <reason>`, `The validation sandbox the page assigned could not be built` | The submit is blocked with `wasm.execution_error` until it can |
| A data source failed | `The data source "x" did not answer within N ms`, or the source's own error | The field shows a failure line and a retry. Raise `data-source-timeout` or fix the source |
| A submit step failed | `Submit failed`, `Submit and download failed`, `PDF failed`, `The delivery handed to datum-submit's waitUntil failed`, each with the cause | The cause is the page's own delivery or the PDF module's error |
| Autosave failed | `Autosave failed`, with the cause | The draft store refused the write, for example a full or blocked `localStorage` |
| A theme, binding or builder theme id is unknown | `Unknown PDF theme "x": register its package ...` or `Unknown builder theme "x": register it ...`, once per id | Register the theme before use. A theme registered later makes the id resolve |
| The builder could not take a form | `The builder could not take the form: <reason>`, `The builder could not apply its settings: <reason>`, `The PDF layouts were not loaded: <problem>`, `The journeys were not loaded: <problem>`, `The "x" mode could not be opened`, `The PDF side could not be loaded`, `The Journeys side could not be loaded`, `The PDF page images could not be loaded` | The form the builder had stays in place |
| `<datum-form-builder>` chrome parts have no ids | `The form was loaded, but <part>: it is shown untranslated until the Header & footer panel gives it an id, which its first edit does.` | Give every authored part an `id` |
| `save-method` is not usable | `save-method must be <list>, not "x"` | Use one of the listed methods |

### datum-error codes

Each code names one cause. A code in the first group is raised by both elements. The second group is raised by `<datum-form>` alone, and the third by `<datum-form-builder>` alone.

| Code | Raised when |
|---|---|
| `attribute.invalid` | An attribute value is not one its parser takes, such as a `change-on` that is not `input` or `commit`. The setting keeps the value it had |
| `attribute.invalid-json` | An attribute that holds JSON (`definition`, `chrome`, `messages`, `texts`, `data-sources`, `translations`, `values`, `host-context`) is not valid JSON |
| `attribute.origin-refused` | A `wasm`, `pdf`, `pdf-pages`, `draft-store`, `validate-url` or `save` attribute names another origin that `allow-origins` does not list. The attribute is treated as absent |
| `allow-origins.invalid` | `allow-origins` lists a word that names no origin, such as `*` or a bare host. The word is left out |
| `features.unknown` | `features` names a word that is no feature or preset. The word is left out |
| `max-definition-bytes.invalid` | `max-definition-bytes` or `maxDefinitionBytes` is not a whole number above 0. The cap stays |
| `definition.invalid` | A definition cannot be used: it is not a form tree, it nests too deeply or holds too much, a fetched body is not JSON or not a form, or the `definition` attribute does not hold up. The form that was shown stays |
| `definition.load` | The `src` fetch failed: an HTTP status other than success, or a network failure |
| `definition.too-large` | The `src` body is longer than `max-definition-bytes`. It is not parsed |
| `definition.source-conflict` | A definition was assigned while `src` is loading, or `src` was set while a definition is assigned. Nothing changes |
| `mode.invalid` | `mode` is neither `interactive` nor `readonly`. The mode stays |
| `agent.attach-failed` | The agent tools could not be attached. When their file did not arrive, the code is `file.unavailable` instead |
| `file.unavailable` | A lazy file did not arrive: a chunk of the bundle, the PDF module, the page images, the journeys diagnostics or the agent tools. It is asked for again on the next use |
| `pdf-theme.unresolved` | A `pdf-theme` id that nothing registered. Once per id |
| `definition.build-failed` | `<datum-form>`: the definition could not be built into a form, usually a formula that cannot be read under `formulaErrors: "fail"` |
| `definition.duplicate-ids` | `<datum-form>`: two components share an id, so they share one value. The form is still drawn |
| `values.invalid` | `<datum-form>`: an initial value in `values` could not be set |
| `host-context.invalid` | `<datum-form>`: `hostContext` or `host-context` held something that is not plain JSON data (a function, `NaN`, a `Date`, nesting past 64 levels). That part is left out and the rest is kept. A value that is no object at all clears it |
| `answer.keep-failed` | `<datum-form>`: an answer could not be kept when the form was built again |
| `locale.switch-failed` | `<datum-form>`: the locale could not be switched |
| `journeys.unavailable` | `<datum-form>`: the journeys file did not arrive. The form shows an alert with Retry |
| `journey.page-failed` | `<datum-form>`: the page a call asked for could not be opened |
| `journey.diagnostics-failed` | `<datum-form>`: the journey checks under `debug` threw |
| `sandbox.unavailable` | `<datum-form>`: the validation sandbox named by `wasm` could not be loaded |
| `sandbox.build-failed` | `<datum-form>`: the sandbox a page assigned as `wasmValidationHost` could not be built |
| `submit.failed` | `<datum-form>`: the submit, or submit and download, a button started threw |
| `submit.delivery-failed` | `<datum-form>`: the promise handed to `datum-submit`'s `waitUntil` rejected |
| `pdf.failed` | `<datum-form>`: a PDF a button asked for could not be made |
| `draft.save-failed` | `<datum-form>`: autosave could not write the draft |
| `render.failed` | `<datum-form>`: the form could not be drawn |
| `data-source.failed` | `<datum-form>`: a data source could not supply its options. The detail also names `sourceId` and `componentId` |
| `theme.unresolved` | `<datum-form-builder>`: a `theme` id that nothing registered |
| `save-method.invalid` | `<datum-form-builder>`: `save-method` is not `PUT` or `POST`. The method stays |
| `chrome.untranslated` | `<datum-form-builder>`: a header or footer part has no `id`, so it is shown untranslated until the Header & footer panel gives it one |
| `pdf.layouts-invalid` | `<datum-form-builder>`: the PDF layouts assigned cannot be used. The layouts stay as they were |
| `journeys.invalid` | `<datum-form-builder>`: the journeys assigned cannot be used. The journeys stay as they were |
| `pdf.rename-unparsed` | `<datum-form-builder>`: after a rename, a layout condition that does not parse still spells the old id |
| `pdf.designer-failed`, `journeys.designer-failed` | `<datum-form-builder>`: the PDF or Journeys designer reported a problem |
| `mode.unavailable` | `<datum-form-builder>`: a mode could not be opened |
| `builder.settings-failed` | `<datum-form-builder>`: the builder could not apply a setting the page made |

### datum-warning

`datum-warning` has `detail: { code, message, count?, addresses? }`. It means the element took something, but not whole. `addresses` names the first few places, dotted, and `count` says how many.

| Code | Raised by | Meaning | What to do |
|---|---|---|---|
| `draft.dropped` | `<datum-form>` | A restored draft held answers the form cannot hold, such as an object in a text box. The rest was restored | Nothing, or tell the person. `addresses` lists the first five answers left out |
| `translations.dropped` | `<datum-form-builder>` | Translation entries in a loaded form were unusable and were left out. Saving keeps only the others | Open the Languages workspace and re-enter them |
| `src.superseded` | `<datum-form-builder>` | The form from `src` arrived after the author had edited, and was not loaded over the edits | Set `src` again to load it over them |

## Draft errors

A draft call rejects with a `DraftError`, which has a `code`. [Drafts](/drafts) says when each call is made.

| Code | Raised when | What to do |
|---|---|---|
| `draft.notFound` | Nothing is stored under the key. Every store raises it, and the server store raises it on a 404 | Start a fresh form |
| `draft.formMismatch` | The draft is for another form: its `formId` is not this definition's `id` | Use a different key per form |
| `draft.incompatible` | The draft was saved under another `schemaVersion` than the definition now carries. A host that passes an allow list of form versions refuses any version not on it too | A draft does not survive a `schemaVersion` change. A change of `version` alone does not refuse it |
| `draft.malformed` | The draft is not a record, its `values` are not a record, or it has no `state` | Discard it. A draft written by this library never has this |
| `draft.reservedKey` | The browser store was given a key starting `__`, which it keeps for its own index. Thrown as `ReservedDraftKeyError`, with `draftId` | Choose a key that does not begin with two underscores |

Two more kinds of draft error are plain errors, not `DraftError`s:

- A draft file that is read back raises `Invalid draft file: missing required identifiers.`, `Invalid draft file: missing runtime version context.` or `Invalid draft file: missing locale, values, or state.`.
- A `server:` store that answers anything but success raises an error such as `Saving the draft failed: 500 Internal Server Error` (also `Loading the draft`, `Listing the drafts`, `Deleting the draft`).

## Journey navigation refusals

`nextPage()`, `previousPage()` and `goToPage()` resolve to `{ ok, pageId?, reason?, message? }`. A refusal is a resolved value with `ok: false`, never a rejection. `pageId` is the page shown after the call. `message` carries a server's or a hook's text when there is one.
| Reason | Meaning | What to do |
|---|---|---|
| `validation` | The page's own answers hold an error that blocks | Show the errors. `nextPage()` focuses the first |
| `server` | Your server's check of the page found a blocking error | The errors are on the page already |
| `server-unavailable` | The check could not be reached, and the page's `onUnavailable` is `block` | Retry |
| `warnings` | The check found only warnings. They are shown once | Call again with the same answers to go on |
| `pending` | A check or another move is still out, or a submit's end check is | Wait, then call again |
| `stale` | The answers changed while the server was checking them | Call again |
| `cancelled` | Back, a jump, an error moved to, or leaving the journey called off the move. Also a move whose path changed while a hook ran | Nothing: the person is somewhere else |
| `at-end` | `nextPage()` on the last page. The last page submits | Submit instead |
| `at-start` | `previousPage()` on the first page | Nothing |
| `unreachable` | `goToPage()` for a page that is not on the path, or past the first page not yet completed. | Offer only reached pages |
| `no-journey` | No journey is running: the form opens as `form`, or has none | Check the `journey` attribute |
| `exit` | `nextPage()` on an exit page, which ends the journey | Nothing: the exit page is the end |
| `vetoed` | A `beforePageChange` hook refused the move. `message` is its text | The element sets no hook, so this is for a runtime you build |

The directions a `datum-page-change` event reports are `start`, `resume`, `forward`, `back`, `jump`, `error` and `redirect`. See [Journeys](/journeys#the-page-change-event).

## Codes a host returns

A submission host answers with the validation codes above and a few of its own. The routes and statuses are on [Spring Boot](/spring-boot) and [FastAPI](/fastapi). The codes the hosts' sources use:

| Code | Meaning |
|---|---|
| `server.unavailable` | The host could not judge the answers now: a run was interrupted, the engine is closed, a rule did not answer, or the host's own context provider failed. Nothing is stored and the submission was not let through. 503, with no `Retry-After` |
| `server.busy` | Every sandbox slot is taken. 503 with `Retry-After` |
| `outcome_too_large` | The answers produce a verdict larger than the host will judge. 503: no verdict was reached |
| `form.outdated` | The submission was made for a version of the form the host does not have. 409 |
| `form.notFound` | No form is registered under that id. 404 |
| `submission.keyConflict` | A second submission under the same `submissionKey` with different content. 409 |
| `bad_document` | The document is not usable. 400 |
| `journey.unknown`, `journey.required` | The submission names a journey the form lacks, or names none while the form has several and no usable default |
| `access.denied`, `unauthorized` | A security layer refused. 403 and 401 |
| `flood` | A throttle refused: the address limit, counted before the body is read, or the per-form limit, counted after it parses. 429 with `Retry-After` |

## PDF failure codes

A PDF call that cannot produce a document fails with `{ ok: false, error: { code, message } }`. A host answers a request error with a 4xx and an internal failure with a 5xx.

| Code | Raised when | What to do |
|---|---|---|
| `abi_mismatch` | The program does not answer the interface version asked for | Build the programs from the release you deploy |
| `invalid_request` | The request has no usable shape: a missing field, a wrong type, a value out of range | Read the message, which names the field |
| `font` | PDF/A needs every font embedded and no font resource covers a family, or the field appearances or a signature appearance have no font | Send a font resource for the family. See [PDFs](/pdf) |
| `template` | A template cannot be filled: it is not a readable PDF, it is encrypted with a password or an unsupported handler, or its owner permissions forbid filling form fields. A template that needs its bytes was not sent | Send an unencrypted copy of the template, or one with no password. The message says which |
| `layout` | A layout cannot be used | Read the message |
| `unknown_component` | A component has no PDF rendition and `pdf-unknown-components` is `fail` | Register a rendition for the type, or set the policy to `warn` or `ignore` |
| `conformance` | A PDF/A claim could not be honoured without lying: an encrypted template, or appearances that could not be regenerated | Fix the template, or drop the claim |
| `attachment_budget` | Uploaded files outgrew the layout's attachment budget with `onExceeded: "fail"`, or an upload was refused for its type or a lying size under the same policy | Raise `attachments.budgetMb`, or set `onExceeded` to `skip` |
| `signature` | A signature could not be prepared, completed or read: a certificate the kernel cannot use, a layout that requires a signature and a request with no certificates, a provider that cannot prepare or complete, a certification over a signed file, a value that does not fit, a token that vouches for something else | Read the message. See [Signing](/signing) |
| `formula_invalid` | A rule the program could not parse under a `fail` policy | Fix the formula or set `formulaErrors` to `warn` |
| `render_limit` | The document ran past its page cap. The message begins `render.pageCap` | Shorten the answers or raise the layout's `limits.pages`. See [Limits](/limits#pdfs) |
| `internal` | The program failed in a way no other code names | A bug: report it with the request |

## PDF warning codes

A PDF reply carries `warnings`, each `{ code, message, componentId?, blockId? }`. A warning never blocks. The document was made, but not exactly as asked. A host that logs `warnings` should treat the groups marked "wrong output" as a reason to look.

### Layout and rendering

| Code | Meaning | Output |
|---|---|---|
| `layout.notFound` | The form has no usable layout of the name asked for. A layout derived from the form was used | wrong layout |
| `layout.conditionInvalid`, `layout.conditionFailed` | A layout's `when` condition could not be run or evaluated. It counted as not holding | wrong layout |
| `layout.nestedDocument` | A document inside a document was skipped | content missing |
| `layout.unknownType` | A layout node has a type the layout does not know. Skipped | content missing |
| `layout.duplicateWidgetName` | Two owners take one PDF field name: two signature blocks, a signature block and a component's `field` rendition, or two components (a `widgetName` that repeats another's path). Only the first is that field. One component bound twice is one field on purpose and says nothing | wrong output |
| `component.unknown` | A component has no PDF rendition here. The generic one was used. Raised under `pdf-unknown-components: "warn"` | generic look |
| `repeat.unbound` | A repeat names no collection | content missing |
| `options.unavailable` | A component's option source failed, or had not answered, when the PDF was built. The PDF lists none of its options and its answer prints as stored rather than as the option's label | wrong output |
| `render.truncated` | An answer ran past `limits.answerChars` (20,000 by default) and the rest was left out | content missing |
| `render.limitsCapped` | The layout asked for a render limit above the ceiling. The ceiling applied | |
| `text.bidiStripped` | Bidirectional control characters typed into an answer were removed, since they can reorder the text around them | |
| `text.glyphMissing` | Characters with no glyph in the font used were drawn as missing-glyph boxes | wrong output |
| `box.overflow`, `frame.overflow`, `anchored.overflow`, `table.rowOverflow` | A box, a value, an anchored box or a table row is taller than a page or its frame, so content flows without the border or past the frame | |
| `image.unresolved` | An image reached the program as a URL, and no host resolved it to bytes | image missing |
| `image.unavailable` | An image was not embedded | image missing |
| `image.invalid` | An image could not be embedded. The reason is in the message | image missing |
| `image.unsafeUrl` | An image has a URL the PDF will not fetch | image missing |
| `formula.invalid` | A mapping or layout expression could not be read. It prints blank | content missing |
| `theme.notFound` | A PDF theme id nobody registered. The next rung was used | |
| `theme.notPdf` | An id names a theme that is not a PDF theme. The next rung was used | |
| `style.invalid` | A theme's or a layout block's component style has a value of the wrong kind, such as `"12"` for a size. That value was ignored | |

### Fonts

| Code | Meaning | Output |
|---|---|---|
| `font.fallback_default` | No font resource for a family. The default sans-serif face was used | wrong output |
| `font.faceFailed` | A theme font file could not be loaded, or no font folder is configured. The default font was used | wrong output |
| `font.unencodable` | Characters outside the fonts' repertoire were replaced with `?`. Send a font that covers them | wrong output |
| `font.privateUse` | Private Use Area code points were replaced with `?` under PDF/A level `a` | |

### Filling a template

| Code | Meaning | Output |
|---|---|---|
| `mapping.unresolved` | A mapping names a component the form does not have | field blank |
| `mapping.collection` | A mapping names a repeating component or a cell inside one. It has no single value. Map each row cell with a path such as `items[0].sku` | field blank |
| `mapping.unknownSource` | A mapping has a source of an unknown kind | field blank |
| `mapping.unmappedValue` | A value map has no entry for these answers. They are written as the answer is | wrong value |
| `field.overflow` | A multi-line field holds more characters than its appearance can show. In a flattened page the rest is lost; otherwise the viewer redraws it and the value is kept whole | |
| `area.page` | An area is on a page the template does not have | area missing |
| `area.overflow` | An area holds more than its box. The rest is clipped | content missing |
| `area.field` | An area asks for a field and the template has no form to hold one, or its name is taken. The area was not made a field | |
| `template.xfa_removed` | The template carried XFA, which is not supported. It was removed so the form fields fill | |
| `template.decrypted` | The template was encrypted with owner permissions only. It was read decrypted and the filled file is written unencrypted | |
| `template.permissions` | The template's owner does not allow modifying it, and flattening or drawing areas changes its content | |
| `template.appearances` | Field appearances could not be regenerated. The reason is in the message | wrong output |
| `template.flatten` | The form could not be flattened. The reason is in the message | wrong output |
| `template.widgets_relinked`, `template.widgets_detached` | A PDF re-saved by another application (such as macOS Preview) had fields that lost their link to a page. They were reattached, or could not be placed and will not show | field missing |
| `template.truncated` | The template has more pages or fields than a listing reads (500 pages, 5,000 fields). Only those are listed | |
| `widget.failed` | A field could not be created. The reason is in the message | field missing |
| `widget.duplicateSignature` | A signature field appears more than once. Only the first is a field | |

### Attachments

| Code | Meaning |
|---|---|
| `attachment.skipped` | An uploaded file would take the document past its attachment budget (4 MiB by default). It was not attached |
| `attachment.refusedType` | An executable, script or HTML file is never attached |
| `attachment.unresolved` | An uploaded file is in a storage the program cannot fetch, and the host could not resolve it. It was not attached |
| `file.sizeMismatch` | A file's inline bytes are well past its declared size. It was not attached |
| `signature.attachment` | An embedded file in a file being verified has no stream, or could not be decoded |

### PDF/A

| Code | Meaning |
|---|---|
| `pdfa.level` | The level asked for could not be claimed. The document declares the level it can: level `a` drops to `u` when the structure or language a reader needs is missing, and a template's own level wins over a level it cannot promise |
| `pdfa.outputIntent` | The output intent profile is not a built-in one or is not an ICC profile. The document declares sRGB instead |
| `pdfa.attachments` | Associated files need PDF/A-3, or the file's embedded-files tree is one the program does not edit. Nothing was attached |
| `pdfa.template` | The template declares no PDF/A level, so the filled document cannot claim one. Send a PDF/A template |
| `pdfa.appearances` | PDF/A leaves nothing to the viewer. Appearances were regenerated although the layout asked to leave them |
| `pdfa.tagged` | A tagged level was asked for, so the document was tagged although the layout turned tagging off |
| `pdfa.boldFallback` | No bold font resource was supplied. Bold areas use the regular face |
| `pdfa.font` | A font program has no `maxp` table or `CharStrings`, so no CIDSet was written |
| `pdfa.image` | A CMYK JPEG, which PDF/A does not allow under an RGB output intent, was left out |
| `pdfa.info` | A document date is not a PDF date. It was dropped so the metadata stays consistent |

### Signing and verifying

| Code | Meaning |
|---|---|
| `signature.noCertificates` | The layout declares signature settings and the request carries no certificates. The document is unsigned |
| `signature.certificateExpired`, `signature.certificateExpiring`, `signature.certificateNotYetValid` | The signing certificate has expired, expires within a short time (the message gives the days), or is not valid yet |
| `signature.chainIncomplete` | No certificate in the request names the signer's issuer, so a verifier may not be able to build the chain. Send `--chain` to the agent, or the issuers with the request |
| `signature.timestamp` | A timestamp could not be read, uses an unchecked digest algorithm, names a signer whose certificate is not held, or carries no signing-certificate attribute |
| `signature.certificate` | A certificate in a signature could not be read |
| `signature.malformed` | A signature has no usable `/ByteRange` or `/Contents`, or is not a CMS the program can read |
| `signature.byteRange` | The `/ByteRange` does not frame the `/Contents`. The signature cannot be trusted |
| `signature.unlinked` | A signature is in no field of the file's latest revision |
| `signature.unfinished` | A signature was prepared and never completed |
| `signature.revision`, `signature.revisions` | A revision the signature covers, or the updates after it, could not be read, or more than the program reads. What changed after is not judged |
| `signature.digestAlgorithm` | A signature uses a digest other than SHA-256. Only SHA-256 is checked |
| `signature.certificateMismatch` | A carried certificate differs from the known one with the same name. The carried one is reported |
| `signature.noSigningCertificate` | A signature carries no signing-certificate attribute, so its certificate is not bound to the signed attributes |
| `signature.signerMissing` | A signature names a signer whose certificate neither it nor the known certificates hold |

## Signing and passkey codes

`signing.providerMissing` and `signing.failed` come from the page when a submission is to be signed. `sign-with` names a provider. A submit is never delivered unsigned.

| Code | Raised when | Parameters |
|---|---|---|
| `signing.providerMissing` | `sign-with` names a provider that is not registered, or a provider is required and none is. The submit is refused | `providerId` |
| `signing.failed` | A provider threw while signing. The message is "The submission could not be signed: " followed by the reason | `providerId`, `message`, `errorCode` when the provider's error has a `code` |

A passkey ceremony fails with a `WebAuthnError` whose `code` is one of these. The page words it, or reads `describeWebAuthnError(error)` for a sentence.

| Code | Meaning |
|---|---|
| `cancelled` | The prompt was dismissed, timed out or could not open: no user activation, or no matching credential |
| `unsupported` | The browser or device has no WebAuthn, or not the feature asked for, or the authenticator cannot meet the user-verification or resident-key requirement |
| `security` | The relying party id does not match the page's origin, or the page is not a secure context |
| `in_use` | The authenticator already holds a credential for this user. Registration only |
| `aborted` | The ceremony was aborted through its signal |
| `no_credentials` | No credential is registered to sign with |
| `protocol` | The response could not be read as WebAuthn's JSON and bytes, or the browser failed in a way no other code names |
| `invalid` | The assertion did not verify. The message names the check that failed |

## The signing agent's codes

The local signing agent answers a refusal as `{ "error": { "code", "message", "attemptsRemaining"? } }` with the HTTP status below. The page's signer raises a `PdfSigningAgentError` with the same `code`, plus `status` and `attemptsRemaining`, and two codes of its own for an answer that is not the agent's.

| Code | Status | Meaning |
|---|---|---|
| `unreachable` | | The signer's own: no agent answered at the URL, or `fetch` is not available |
| `protocol` | | The signer's own: the answer was not the agent's JSON, or its code is one the signer does not know |
| `bad_request` | 400 | The body is not a JSON object, a field is not valid base64, or the slot is not a PIV slot such as `9c` or `file` |
| `origin_denied` | 403 | The page's origin is not in the agent's allow list. Start the agent with `--allow-origin <origin>` |
| `not_found` | 404 | No such route |
| `no_certificate` | 404 | The slot holds no certificate |
| `unusable_key` | 422 | The key in the slot cannot sign a PDF |
| `algorithm_mismatch` | 409 | The certificate signs with another algorithm than the request asked for |
| `pin_invalid` | 401 | Wrong PIN or passphrase. `attemptsRemaining` says how many tries are left |
| `pin_blocked` | 401 | The PIN is blocked. Unblock it with the PUK (`ykman piv access unblock-pin`) |
| `pin_cancelled` | 409 | The PIN or signing prompt was cancelled, or a passphrase was needed and there is no way to ask |
| `touch_timeout` | 408 | The token waited for a touch and none came |
| `busy` | 423 | The token is in use by another request |
| `no_device` | 503 | No token is plugged in |
| `device_error` | 500 | The token refused to sign, or a certificate file holds no private key |
| `too_large` | 413 | The request body is over 64 KiB |

[Signing](/signing) shows the agent in use.
