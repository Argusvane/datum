# Limits

Every cap and structural rule in one place, with what happens when you reach it. A definition past a structural cap is refused by `check` (and by the builder before it saves) with the code named in the table. A runtime cap either cuts the input and says so, or refuses the run. The codes are in [Codes and messages](/codes).

## Definition size and shape

These are the caps `check` holds a definition to. A host can read the caps in force from the `limits` member of the `check` answer.

| What | Limit | When it is passed |
|---|---|---|
| Definition fetched from `src` | 2 MiB (2,097,152 bytes), changed by `max-definition-bytes` | Not parsed. `datum-error`: `it is 3,000 KB; up to 2 MB is read` |
| Component depth | 32 levels, the root counting as level 1 | `definition.tooDeep`. Nothing else is judged |
| Components | 10,000. Above 2,500 it is only a warning | `definition.tooManyComponents` refused; `definition.components.large` warned |
| Inline options on one component | 2,000. Above 500 it is a warning | `option.tooMany` refused; `option.count.large` warned |
| Inline options in the whole definition | 50,000 | `option.total.tooMany` |
| Locales | 64 | `localization.tooMany` |
| Journeys | 32 | `journey.tooMany` |
| Journey pages in all | 1,000 | `journey.page.tooMany` |
| Routes on one page | 64 | `journey.route.tooMany` |
| PDF layouts | 64 | `pdf.tooMany` |
| Entries in the `kinds` map | 4,096 | `kinds.tooMany` |
| `version` | 64 characters | `definition.version.tooLong` |
| Definition `id`, component `id`, component `type`, data key, layout id | 128 characters | `definition.id.invalid`, `component.id.invalid`, `component.type.invalid`, `component.dataKey.invalid`, `pdf.layout.idTooLong` |
| One collection path or data path | 512 characters | `component.path.tooLong` |
| All collection paths and data paths together | 65,536 characters | `definition.paths.tooLong` |
| A field `pattern` | 2,000 characters | `component.pattern.tooLong`. At run a longer pattern is read as runaway and refused |
| Problems listed by `check` | 200 per list | The 201st entry is `definition.problemsTruncated` |
| Locale code in a run | 35 characters | A longer one is read as no locale |

### Ids and names

| Name | Grammar |
|---|---|
| Component id | A letter, then letters, digits, `_` or `-`. At most 128 characters. Unique across the whole form. Not `component`, `host`, `row`, `ancestor`, `constructor` or `prototype` |
| Data key (`configuration.dataKey`) | Letters, digits, `_` or `-`, at most 128 characters, not digits alone, not `__proto__`. It may begin with a digit. Empty means the id is the segment |
| Journey id, page id, PDF layout id | Not `__proto__`, `constructor` or `prototype`. Journey and page ids are unique within their list, and a page id that is also a component id is warned about |
| Chrome part id | Non-empty, not `__proto__`, `constructor` or `prototype`, and unique across the header and footer |

The reserved component ids are words a rule reads as scopes (`component`, `host`, `row`, `ancestor`) or names the translations map cannot key (`constructor`, `prototype`).

- A component given one could never be read by its id. `component.id.reserved` refuses it.
- Ids such as `toString` are allowed but warned about, since some hosts read them wrongly.

A data key sets a component's stored segment apart from its id. Two components that would store an answer at one path, or one inside the path of another, are refused with `component.dataPath.duplicate` and `component.dataPath.conflict`. See [Data](/data#ids-and-data-keys).

A draft key that begins `__` is refused by the browser's draft store (`draft.reservedKey`).

## Answers and fields

| What | Limit | When it is passed |
|---|---|---|
| Text length | `minLength` and `maxLength` in characters (code points), whole numbers of 1 or more. Both are ignored if the minimum is above the maximum | `minLength`, `maxLength` |
| Number and date bounds | `min` and `max`, inclusive. Both are ignored if inverted | `number.min`, `number.max`, `date.min`, `date.max` |
| File size | `maxFileSizeMb` per file. No limit unless set | `maxFileSize` |
| Files in one field | 1 for a single-file field. For `multiple`, `maxFiles`, and 100 when it is not set | `fileCount` |
| Data grid rows | 500. The grid's own minimum and maximum are whole numbers from 0 to 500. It opens with one row unless `initialRows` says otherwise | `rows.min`, `rows.max`. A bound outside 0 to 500 reads as unset, with a `component.dataGrid.bounds` warning |
| Options from a data source | 5,000 shown. Longer answers are cut and the field says how many are shown | The field's note, not an error |
| Uploaded files embedded in a PDF | 4 MiB in all by default, set by the layout's `attachments.budgetMb`. Past it a file is skipped, or the PDF fails under `onExceeded: "fail"` | `attachment.skipped`, or `attachment_budget` |

A file field's answer rides in the submission, so a host's request body cap bounds the files in it. Spring Boot reads at most `datum.web.api.max-body-size` (default `1MB`) and FastAPI `datum.web.api.max_body_size` (default `1MiB`). See [Spring Boot](/spring-boot) and [FastAPI](/fastapi).

## Formulas

| What | Limit | When it is passed |
|---|---|---|
| Nesting in a formula's text | 100 levels (parentheses, calls, `if`, lists, intervals, prefix operators) | `tooDeep` |
| Nesting in a rule written as a tree | 200 levels | `tooDeep` |
| Text a function reads or builds | 10,000 characters. The first 10,000 are used and a warning is logged | The run log's `text.truncated` warning |
| Items in a list a function reads | 10,000. The function gives no answer and a warning is logged | The run log |
| Errors in one run | 10,000 | `errors.truncated` |

## Time and delays

| What | Default | Setting |
|---|---|---|
| Typing pause before `datum-change` reports a value | 300 ms | `change-debounce`, with `change-on="input"` |
| Typing pause before a draft is saved | 300 ms | Not settable |
| A data source's wait | 15,000 ms, `0` for none | `data-source-timeout` |
| Whether the form waits for its sources before it paints | Does not wait | `data-source-wait` (`none` or `all`) |
| The sandbox module's load | 15,000 ms, `0` to wait without limit | `wasm-timeout` |
| A journey page's server check | 10,000 ms, `0` for none. Past it the service counts as unavailable | `validate-timeout` |

- A data source that does not answer in time is a failed source: the field says so and the page hears a `datum-error`.
- A server check that times out gives `journey.server-unavailable`, and the page's `onUnavailable` says whether Continue is blocked.

## The sandbox

The sandbox in the page and the one on a server are the same program with different budgets.

| What | In the page (`wasm`) | Reference host |
|---|---|---|
| Time for one run | 250 ms, plus 5 ms for each rule read, plus 1 ms for each KB of definition (at most 5,000 ms), then plus 2 ms for each KB of the request, at most 5,000 ms in all | 250 ms scaled the same way. A host that sets its own budget uses it as given |
| Starting the sandbox | 2,000 ms | 2,000 ms |
| Memory | 32 MiB | 32 MiB |
| Stack | 1 MiB | 1 MiB |
| Request | 320 levels deep, 32 Mi characters | The same |
| Answer | 8 Mi characters | The same |
| Run log | 200 entries, each message and data 8 KiB | The same |

- A run past its time or memory limit gives no verdict. The page blocks the submit with `wasm.execution_error`, and a host refuses it.
- A request or answer past its cap fails with `request_refused` or `outcome_too_large`.
- The built hosts set their own run budgets, tabled in [Your own server](/server-programs#limits-a-host-sets).
- The page's budgets are explained in [Validation](/validation#timeouts).
- What a server does with each of these limits, and why, is on [Hardening on a server](/wasm-hardening).

## Form tests

The `test` operation, and the test command that uses it, refuse a run with `invalid_request` past these.

| What | Limit |
|---|---|
| Test text | 256 KiB, whether in the definition or beside it |
| Scenarios | 200 |
| Statements in one scenario | 1,000 |

A definition is also gated first by the structure caps above. The test operation has no clock, so a form that reads the day needs `given today` in each scenario.

## PDFs

| What | Default | Ceiling | When it is passed |
|---|---|---|---|
| Pages in one document | 200 | 1,000 | `render_limit` failure. A higher request is capped and warned with `render.limitsCapped` |
| Characters of one answer | 20,000 | 200,000 | The rest is left out, with `render.truncated` |
| Uploaded files embedded | 4 MiB in all | Set by the layout | `attachment.skipped` or `attachment_budget` |
| Pages a template listing reads | 500 | | `template.truncated` |
| Fields a template listing reads | 5,000 | | `template.truncated` |

A layout sets the first two as `limits: { pages, answerChars }`.

## What each kind of limit does

- **Structure caps** refuse the definition. The builder will not save it, and a host will not register it.
- **Run caps** (errors, text, list items) cut the input, log a warning and carry on, except where the table names a refusal.
- **Time and memory caps** give no verdict. A run that gave no verdict is never let through.
- **Size caps on input** (the definition from `src`, a request, a request body) refuse the input before it is read.
