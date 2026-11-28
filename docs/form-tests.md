# Form tests

A form test is a short scenario written in plain text: some answers are set, a button is pressed, and the test says what must then be true. A field is shown and required, a page is skipped, a submission is refused with a given error code, an answer is withheld from the envelope. The scenario is stored with the form (or in a `.datum-test` file beside it), diffs as text, and is run by a command, by vitest, and by the builder. The decision to build it is ADR 0154.

The reason is that a large form accumulates rules (`visibleWhen`, `requiredWhen`, `validWhen`, calculations, a journey's routes, a PDF layout's `when`) and a team forgets what each was for. A change to one rule silently moves a path or a verdict somewhere else, and the only record of the intended behaviour is the rule itself. A test writes the intent down in the author's words ("a partnership needs a registered agent") and says so the day the form stops doing it.

A test cannot be more right than the form. Every expectation reads a fact the engine already produces (the fold's visibility and requiredness, the validation errors by code, the journey's path, the envelope's values), and the language adds no evaluation of its own. The same scenario runs on two sides: the browser's runtime, headless, and the server's validation kernel. A scenario that passes on one and fails on the other is reported as its own finding, `parity`, because that is the class of bug the two-sided design exists to prevent.

## A first test

The examples in this page run on the package's fixture form (`fixtures/main.json`, built from the engine's `engine/tests/form-tests/fixtures/form-tests-fixture.ts`). It has a journey `main` of five pages: `intro` (a required `applicant_name`, an `age` between 18 and 120, a calculation `age_next_year = age + 1`, a `wants_details` box and a `nickname`), `contact` (a `contact_method` choice, an `email` required when that is the way, a `phone` shown for the other way, a `confirm_email` checked against the email, a `province` from a data source and a `stop_code` that routes to the exit page `stop` on "STOP"), `details` (reached only while `wants_details` is ticked: a route on `contact` leaves it out otherwise), `review` (a repeating section `items`, a `role_note` only an admin host sees and a `ref_number` checked by the server alone) and the exit page `stop`.

```datum-test
test "email is required when it is the way to reach you"
  set applicant_name = "Ada"
  set age = 30
  continue
  expect page = contact
  expect email optional
  set contact_method = "email"
  expect email required
  continue
  expect page = contact
  expect error on email: required
```

```sh
datum-form-test fixtures/main.json
```

prints a Markdown report with one row per scenario, the result on each side and the details of anything that did not pass. The exit code is 0 when everything that ran passed.

## Where tests live

- **In the definition**, under `tests`: `{ "scenarios": [{ "id": "main-1", "source": "test \"…\"\n  set …" }] }`, beside `pdf` and `journey`, so one document is saved, exported, versioned and handed between hosts. Each `source` is normally one `test` block, name included. An entry without a non-empty string `id` and a string `source` is dropped, and the first of two entries with one `id` wins. The public copy of the definition (what a browser is served) has `tests` stripped, as it has server-secret rules, so the running form never carries its tests. The price of one document is that editing a test changes the definition's bytes and digest (and, on a host that signs over `version`, its version).
- **In a sidecar file** with the definition's name and the extension `.datum-test`: `fixtures/main.json` reads `fixtures/main.datum-test` when it exists. The file is the concatenation of `test` blocks, the same text the `source` fields hold, parsed by the same parser. It is for repositories that keep definitions as files and want the tests beside them without touching the definition.
- **In files named on the command line** with `--tests` (see below).

Scenario names are the handle a report uses, so keep them unique. Two `test` blocks of one source with one name are a parse problem (`duplicateName`), and so is an empty name.

## The language

A source is a list of `test "name"` blocks. Within a block, one statement per line; `#` starts a comment (outside a string); blank lines and indentation mean nothing; keywords are case-insensitive English in every locale, as the formula language's are. A line that does not parse records one problem and adds no statement, and the lines after it are still read, so every problem is listed at once. A statement before the first `test` is `stepOutsideTest`. A source over 200,000 characters is one `tooLong` problem, and a scenario over 1,000 statements ends as the error `scenario.tooManySteps`.

### Names and literals

- **Fields** are named by value path, the engine's own path syntax: `total`, `items[0].qty`. Rows are numbered from 0, so `items[0]` is the first row. A path is dotted segments of letters, digits, `_` and `-`, each with an optional `[n]`; the first may begin with `@`.
- **Pages, journeys and layouts** are named by id, not title: `contact`, `main`, `pets`. Titles are localized and change; ids are what the builder's rename follows.
- **Values** are literals:

| Literal | Reads as |
| --- | --- |
| `"text"` or `'text'` | text; `\n`, `\t` and `\r` are escapes, a backslash before any other character is that character |
| `12`, `-3`, `1.5`, `.5`, `2e3` | a finite number |
| `true`, `false`, `null` | the three words, in any case |
| `@"2026-01-01"` | a date, held as its ISO text, which is how answers hold dates |
| `("a", "b")`, `()` | a list, for a checkbox group or a multi-select; lists nest to 32 levels |

The literals are the formula language's spellings plus two things a formula has no word for: a list and a row path. So `("a")` is a one-item list here and a bracketed string in a formula, and `items[0].qty` is a path only in a statement of this language. A curly quote is not a quote (the problem says so); write straight ones.

### Header and skip

```datum-test
test "a scenario kept for later"
  skip "waiting on the address rules"
  expect applicant_name visible
```

`test "name"` opens a block. `skip "reason"` directly under it keeps the scenario listed and unrun: both sides report it `skipped` with the reason. A `skip` after a `given` or a step is `skipAfterStep`.

### Givens

A `given` sets the scene. Givens come at the top of a block, before the first action or expectation (`givenAfterStep` otherwise), and each may appear once (`duplicateGiven`).

The example below belongs to the second fixture form, `fixtures/clock.json`, which has a rule that reads today's date; on `fixtures/main.json` it would fail, since that form has no `event_date`.

```datum-test
test "an event must not be in the past"
  given today = @"2026-03-01"
  set event_date = @"2026-02-01"
  check
  expect refused
  expect error on event_date: rule
```

| Given | Meaning |
| --- | --- |
| `given today = @"2026-03-01"` | The day `today()` and `age()` read. It must be a real calendar day (`2026-02-31` is the parse problem `badGiven`). A scenario on a form whose rules read the clock and that gives no day is the error `scenario.clockUnset`, never today's date, so a test never depends on when it runs. |
| `given locale = "fr"` | The locale the form is read in, and the language `expect message` is worded in. A locale the form does not offer is the error `scenario.badGiven`. |
| `given journey = main` | The journey played. Without it a form that has journeys plays its default one. `given journey = none` tries the form on one page, with no journey. An id the form does not have is the error `scenario.unknownJourney`. |
| `given host.role = "admin"` | A value of the host context: the browser runtime's `hostContext` and the kernel run's `context.hostContext` alike, so both sides judge the rules that read it; a key no given sets reads as no answer. Nested names (`host.team.lead`) are written as they are read. With no `given host.` the kernel runs with no context (see "What a skip means"). |
| `given options for province = ("ON", "QC")` | The options of a data-source-backed choice, so the choice check has something to judge. The path must name a field with a data source, else `scenario.badGiven`. |

When several givens are bad, the first in source order is the one reported.

### Actions

```datum-test
test "rows are added, answered and removed"
  given journey = none
  expect rows of items = 0
  add row to items with qty = 2
  add row to items
  expect rows of items = 2
  expect items[0].qty = 2
  set items[1].qty = 5
  remove row 0 of items
  expect rows of items = 1
  expect items[0].qty = 5
```

| Statement | Meaning |
| --- | --- |
| `set <path> = <value>` | Answer a field, as the person would. A `set` on a hidden or disabled field is allowed, as the runtime's `setValue` is, so a test can show that a hidden answer is withheld. |
| `clear <path>` | Empty a field. |
| `add row to <collection> [with k = v, …]` | Add a row to a repeating section; the keys are the fields' names relative to the new row (`qty`, not `items[0].qty`). |
| `remove row <n> of <collection>` | Remove row `n` (0-based). |
| `continue`, `back`, `go to <pageId>` | A journey's Continue, Back and a jump. |
| `change <field>` | On a Check answers step, press the Change link of that answer's row: the step that asks it opens, and a `continue` (or a `back`, from a step completed before) then comes back to the Check answers step, or goes first to a step the new answers put on the path. Any other move gives the return up. The scenario ends as the error `action.refused` when there is no such row to press: `params.reason` is `change.notReview` (not on a Check answers step), `change.off` (the step has Change links off), `change.notListed` (the path is no answer the person's path asks) or `change.unreachable` (the step that asks it cannot be opened yet). |
| `check` | Run the page's check (the whole form's check without a journey) without moving. |
| `submit` | Submit. |

An action that the form refuses is not a failure: a `continue` off a page with errors leaves the scenario where the form keeps it, and the next `expect` says what was meant (the example above under "A first test" does exactly that). The exception is a row action the form turns down (more rows than the section's most, a section whose add or remove operation is off, a row that is not there, a name that is no collection): the scenario ends as the error `action.refused`, with `params.reason` one of `rows.max`, `operations.add`, `operations.remove`, `rowOutOfRange`, `unknownCollection`, `value.notScalar`. The last is a list (or any non-scalar) set on a field that takes one answer, and it covers `add row … with` too: `params.path` is the cell of the row the add would make (for example `items[2].sku`). The error names the path, and no row is added.

A list set on a checkbox group ticks those options: `set topics = ("news", "events")`. The text `"true"` or `"false"` set on a lone checkbox is stored as the boolean, as the runtime stores it; any other value is stored as written and does not tick the box. A cell of `add row … with` is stored as `set` would store it, so a list on a checkbox group's cell becomes the group's record, ticked per option, on the browser and the kernel drivers alike.

### Expectations

An expectation judges the state after the action before it. Consecutive expectations judge the same state.

**State** of a field: `expect <path> visible | hidden | required | optional | enabled | disabled | readonly | editable | empty | not empty`.

```datum-test
test "the nickname follows the details box"
  expect nickname disabled
  set wants_details = true
  expect nickname enabled
  set applicant_name = "Locked"
  expect nickname readonly
  set applicant_name = "Ada"
  expect nickname editable
```

`required` is requiredness after the hidden-required policy, so a hidden field is not required. `empty` reads the answer as the envelope carries it: a hidden field that still holds a value is not empty, and a checkbox group with nothing ticked is.

**Value**: `expect <path> = <value>` and `!= <value>`.

```datum-test
test "the age bounds and the calculation"
  set applicant_name = "Ada"
  set age = 15
  expect age = 15
  expect age != 16
  expect age_next_year = 16
```

The answer is read as the envelope carries it and compared as JSON: numbers by value, `null` and absent as the same, lists in order. A list literal against a checkbox group compares with the ticked options in any order, so `expect topics = ("events", "news")` holds however the group was ticked. A name that is no field fails as `expect.unknownField` (a typo never passes), and so does a row the form does not have (`params.reason` is `rowOutOfRange`).

**Formula**: `expect <formula>` for anything else.

```datum-test
test "topics read through a formula"
  given journey = none
  set topics = ("news", "events")
  expect count(selected(topics)) = 2
  expect age_next_year = age + 1
```

A line that is not a state and not a path with a single literal after `=` or `!=` is handed to the formula parser (so `expect total = 5` is a value check and `expect total = subtotal * 1.13` a formula). It is evaluated over the same settled view the form's rules read, with the same function library (see [Formulas](formulas.md)), and holds only when the result is the boolean `true`, as every rule does; any other result fails as `expect.formula` with the result as the actual. The names a formula reads are component ids, as in a rule. A name the form does not have fails as `expect.unknownField` and does not pass on a missing value; a value path that is not an id fails the same way, with `params.id` naming the component it belongs to; `row.` and `ancestor.` reads fail with `params.reason` `noRowScope`, because a scenario has no row in scope. A leading `host.`, `row.` or `ancestor.` name always starts a formula, so `expect host.role = "admin"` is a formula and not a value check on a field called `host.role`. `TRUE`, `False` and `Null` are read in any case.

**Errors**: `expect error on <path>`, `expect error on <path>: <code>`, `expect message on <path> = "…"`, `expect no error on <path>`, `expect no errors`.

```datum-test
test "the confirmation must match the email"
  given journey = none
  set email = "a@example.com"
  set confirm_email = "b@example.com"
  check
  expect refused
  expect error on confirm_email: rule
  expect message on confirm_email = "The two emails must match."
  set confirm_email = "a@example.com"
  check
  expect no error on confirm_email
```

An error code is letters, digits, `.`, `_` and `-` (`required`, `rule`, `number.min`, `pattern`, `minLength`, `maxLength`, `rows.min`, `rows.max`, the file codes, a host's own code). Without a code, any error on the path holds. `expect message` is the worded message, in the given locale, taken from the field's own `messages`; any error on the path with exactly that text holds. Errors appear when something checks: put a `check`, `continue` or `submit` before an `expect error`, as the examples do. `expect no errors` names no field and reads every error on show.

On the server side `expect message` is worded from the field's own `messages` without the form's translation catalog or a binding's language pack, so a code that only the catalog words may read differently from the renderer. When the two sides word a message differently the scenario shows it as a `parity` finding; write the message on the field to keep it stable.

**The verdict**: `expect accepted` and `expect refused`, after a `submit` or a `check`.

```datum-test
test "a province from the given options"
  given journey = none
  given options for province = ("ON", "QC")
  set applicant_name = "Ada"
  set age = 30
  set province = "QC"
  submit
  expect accepted
  expect submitted province = "QC"
```

The verdict stands until the next `check` or `submit`; a `continue` sets none. Asked before either has run, the expectation fails as `expect.noVerdict`.

**The journey**: `expect page = <pageId>`, `expect path = (p1, p2, p3)`, `expect path ends`, `expect path ends at <exitPageId>`, `expect <pageId> on path`, `expect <pageId> off path`.

```datum-test
test "STOP routes to the exit page"
  set applicant_name = "Ada"
  set age = 30
  continue
  set stop_code = "STOP"
  continue
  expect page = stop
  expect path = (intro, contact, stop)
  expect path ends at stop
  expect review off path
```

`path` lists the pages the current answers put on the path, in order; `path ends` says it runs off the end of the journey, `path ends at stop` that it ends on that exit page. Page ids are bare words. A scenario with `given journey = none` has no page or path, so these fail as `expect.noJourney`; a page the journey does not have fails `on path` and `off path` as `expect.unknownPage` instead of passing on a typo.

**What goes out**: `expect submitted <path> = <value>`, `expect <path> withheld`, `expect rows of <collection> = <n>`, `expect layout = <layoutId>`.

```datum-test
test "a hidden phone is withheld, a hidden pet name is kept"
  given journey = none
  set applicant_name = "Ada"
  set age = 30
  set contact_method = "phone"
  set phone = "555-0100"
  set contact_method = "email"
  set email = "a@example.com"
  set confirm_email = "a@example.com"
  set has_pet = false
  set pet_name = "Rex"
  submit
  expect accepted
  expect phone withheld
  expect submitted pet_name = "Rex"
```

`submitted` is the envelope's values after an accepted submit, by value path (a repeating section's rows at `items[0].qty`); before one it fails as `expect.notSubmitted`. `withheld` is a value path the form held an answer for and did not send (hidden and excluded, or on a page off the path); it needs a `submit` or `check` first. `rows of` needs a collection (anything else is `expect.unknownField`). `layout` is the PDF layout the answers choose (ADR 0044) and is all a test says about PDF output; what prints is the PDF kernel's concern.

```datum-test
test "the pets layout when there is a pet"
  given journey = none
  expect layout = standard
  set has_pet = true
  expect layout = pets
```

### Parse problems

The parser never throws. A problem is a code with a line and a span, and the command words it from this table:

| Code | The line is wrong because |
| --- | --- |
| `unknownStatement` | its first word is no statement |
| `stepOutsideTest` | it comes before any `test "name"` |
| `expectedName`, `duplicateName` | a `test` has no name, or another test of the source has it |
| `expectedPath`, `expectedPage`, `expectedValue`, `expectedNumber`, `expectedEquals`, `expectedKeyword` | the token there is not the path, page id, value, whole number, `=` or word the statement needs |
| `badState` | the word after a path is no state, and the line is no formula either |
| `badCode` | an error code has a character outside letters, digits, `.`, `_`, `-` |
| `badGiven`, `givenAfterStep`, `duplicateGiven`, `skipAfterStep` | a given or skip is unusable, late or repeated |
| `unterminatedString`, `unclosedList` | a quote or a list is never closed (or a curly quote was used, or lists nest past 32) |
| `badFormula` | the formula does not parse; the formula parser's own sentence follows |
| `trailingText` | there is text after the statement ended |
| `tooLong` | the source is over 200,000 characters |

A source with problems fails the run (exit 1).

### Lints

A lint is a warning about a line that parses. It is shown in the builder's Tests panel and in the
agent's `check_form`, never fails the run, and the scenario still runs.

| Code | The line draws the warning because |
| --- | --- |
| `tests.set.unknownPath` | a `set` line names a path the form has no field for; the warning names the path. The line keeps its meaning (a host's extra answer is a legitimate given), so a typo is the thing to look for |

### How a step and a scenario end

Every step has a status: `ran` for an action, `passed`, `failed` or `skipped` for an expectation, `error` when the driver broke. A failed step carries a code, the expected value and the actual one, as data (`expect.visible`, `expect.value`, `expect.error`, `expect.path`, `expect.formula`, and so on: one per expectation, plus `expect.unknownField`, `expect.unknownPage`, `expect.noJourney`, `expect.noVerdict` and `expect.notSubmitted` for an expectation that names something the run does not have).

A scenario fails when any step failed; else it is an error when any step errored or it could not start; else it is skipped when it had expectations and every one skipped; else it passed (a scenario with no expectations passes, it only had to run). The scenario errors are `scenario.clockUnset`, `scenario.unknownJourney`, `scenario.badGiven`, `scenario.formulaInvalid` (the definition's formulas do not compile under the policy in force; `params.problems` lists the first five), `scenario.tooManySteps`, `scenario.driverFailed`, `action.refused` and `action.failed`.

## What a skip means

A side cannot replay everything. The browser never runs a rule marked `run: "server"`; the kernel has a host context only when the scenario gives one and does not apply `run: "browser"` rules. An expectation about something a side could not replay is `skipped` on that side with the reason, never failed, as the conformance suite reports a vector it cannot run. A scenario is `passed` when no expectation failed on any side and at least one passed.

| Reason | The side that skips | When |
| --- | --- | --- |
| `unreplayable.host` | kernel | the field has a rule that reads `host.` and the scenario has no `given host.` line, so the run has no host context (with one, the givens are the run's `hostContext` and the rule is judged) |
| `unreplayable.server` | runtime | every rule on the field runs only on the server (`run: "server"`) |
| `unreplayable.secret` | both | the field has a `server-secret` rule; a test cannot carry the secret context without leaking it into the definition |
| `unreplayable.browser` | kernel | a rule the form runs only in the browser (`run: "browser"`), or a calculation scoped to it |
| `unreplayable.clientDerived` | kernel | a calculation that reads an answer the server was not sent, so the server keeps the value as sent |
| `unreplayable.clock` | kernel | a rule needs the day and none was given; a scenario on a clock-reading form must `given today`, so this is rare |

The skip reaches further than the field. An expectation about the run as a whole (`expect accepted`, `expect refused`, `expect no errors`, `expect submitted …`) skips when a rule that side could not replay could have decided the verdict, and the page, path, path-end, on-path, withheld and submitted expectations skip when a route reads something it could not replay, because the path it drew would not be the person's. A formula that reads an unreplayable field skips with that field's reason.

A skipped step is not a failure and does not make the scenario one. A scenario is reported `skipped` only when every side skipped it, so one that the kernel skipped and the runtime passed is `passed` (the sides are `one-sided`, see "Parity"); and a run in which no scenario passed at all is inconclusive (exit 3).

## The command

```
datum-form-test <definition.json>… [--tests <file.datum-test>]…
                [--runner runtime|kernel|both] [--program <file>]
                [--report json|junit|md]… [--out <dir>]
                [--coverage] [--fail-on failed|untested] [--help] [--version]
```

The command is a plain Node 22 bundle with no TypeScript toolchain. From a checkout: `npm run build` in `packages/form-test`, then `node packages/form-test/dist/cli.mjs …` (or `bin/datum-form-test.mjs`); installed from a tarball (`npm pack`, then `npm install <tarball>`) it is `datum-form-test`.

| Flag | Meaning |
| --- | --- |
| `<definition.json>…` | One or more form definitions (a JSON object with an object `root`). The scenarios stored in each definition's `tests` run, and so do those in the sidecar `.datum-test` file beside it. |
| `--tests <file>` | A `.datum-test` file to run as well. Repeats. It needs exactly one definition (it would be unclear which form a file belongs to); with two it is a usage error. Naming the definition's own sidecar here reads it once, not twice. |
| `--runner runtime\|kernel\|both` | The side or sides to play. The default is `both`: the in-process kernel is in the bundle, so both sides always run. One side alone has no parity. |
| `--program <file>` | A built sandbox program (what a host ships as the validation gate) for the kernel side to run on, in QuickJS, instead of the in-process kernel. The report records its path, size and sha256. The program is loaded once per run and reused by every scenario. A file that evaluates but defines no sandbox entry point (the PDF kernel's file, say) is an input error, exit 2, not a parity finding on every scenario. The kernel side runs it, so `--runner runtime` with `--program` is a usage error. |
| `--report json\|junit\|md` | A report to produce. Repeats. The default is `md`. |
| `--out <dir>` | Write the reports `--report` names as files in `<dir>` (made if need be): `form-tests.json`, `form-tests.xml`, `form-tests.md` (only `form-tests.md` by default). Stdout then gets one line per parse problem, one per scenario, a totals line and a `reports:` line naming the files. Without it, the reports print to stdout in the order given. |
| `--coverage` | Add the coverage of the form's rules (see below). |
| `--fail-on failed\|untested` | What makes the run fail. `failed` (the default) is a failing scenario, a parity difference or a source with problems. `untested` also fails the run when a rule has no scenario, and implies `--coverage`. |
| `--help`, `--version` | |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Passed: every scenario that ran passed (and under `--fail-on untested`, every rule is tested). |
| 1 | A scenario failed or errored, the two sides disagreed (`parity`), a source had parse problems, or a rule is untested under `--fail-on untested`. |
| 2 | Usage or input error: bad flags, an unreadable or malformed definition, test file or program. The message is `datum-form-test: <message>` on stderr; a usage error (bad flags) adds the usage text, an input error (a file or the definition) does not. A definition the Logic model cannot read is an input error under `--coverage`. An unwritable `--out` is found before any scenario runs. |
| 3 | Inconclusive: no scenario came to a verdict (none were found, or every one was skipped). Non-zero so CI never reads "nothing was checked" as success. |
| 4 | The tool itself broke; the stack is on stderr. |

Failure outranks inconclusive: a run with one failed scenario is 1 however many others skipped.

With `--out`, the per-scenario lines on stdout look like this:

```
PASS  fixtures/main.json › email is required when it is the way to reach you (runtime: passed, kernel: passed)
PASS  fixtures/main.json › an admin sees the role note (runtime: passed, kernel: passed)
PASS  fixtures/main.json › a server-only check is not the browser's to judge (runtime: skipped unreplayable.server, kernel: passed)
SKIP  fixtures/main.json › a scenario kept for later (runtime: skipped waiting on the address rules, kernel: skipped waiting on the address rules)
FAIL  fixtures/main.json › a deliberate failure: the name is not optional (runtime: failed, kernel: failed)
FAILED: 21 scenarios, 19 passed, 1 failed, 0 parity, 0 error, 1 skipped; 0 sources with problems
reports: out/form-tests.md
```

The word is `PASS`, `FAIL`, `SKIP`, `ERROR` or `PARITY`. A parse problem comes before the scenario lines as `PROBLEM  <form> › <source>:<line> <message>`. A source that did not parse runs none of its scenarios (a scenario missing the line that did not parse could pass for want of it); the problem alone fails the run. A later source that parses but repeats a scenario name of an earlier one (`duplicateName`) is a problem too, yet its scenarios still run, so the other failures show in the same run. Under `--fail-on untested` the totals line ends with the number of untested rules, since every scenario line can read `PASS` on a red run.

## The reports

All three come from one data model (`Report` in `src/report/model.ts`, exported by the package), and nothing in it is a sentence: the messages are made from codes by the report writers.

**JSON** (`form-tests.json`) is the whole model, two-space indented. Its top level is:

```json
{
  "tool": { "name": "datum-form-test", "version": "0.1.0" },
  "startedAt": "2026-10-24T09:00:00.000Z",
  "durationMs": 1840,
  "runner": "both",
  "program": null,
  "failOn": "failed",
  "forms": [],
  "summary": { "scenarios": 22, "passed": 18, "failed": 1, "skipped": 3, "error": 0, "parity": 0, "problems": 0 },
  "verdict": "failed"
}
```

Each entry of `forms` has the definition's `path`, its `sources` (each with the scenario names it parsed to and its parse problems), its `scenarios` (name, source, line, status, each side's engine result with every step, the `parity` reading, duration) and, with `--coverage`, `coverage`. A reader should ignore keys it does not know.

**JUnit** (`form-tests.xml`) is for CI services that show test results. A `<testsuite>` per form, a `<testcase>` per scenario, times in seconds. A failed scenario is a `<failure type="failed">` whose message is its first failing step and whose body lists every failing step as `line: message` (prefixed with the side when only one side found it); `parity` is a `<failure type="parity">` listing the differing lines; an error is an `<error>`; a skip is a `<skipped>`; a source with problems is one extra `<testcase name="<source> parses">` with an `<error>` listing them. Under `--fail-on untested`, a form with untested rules gets one more case, `every rule is tested`, a `<failure type="coverage">` listing the rules, so a test-report widget shows the reason the job is red. The `classname` is the form's path without its extension, separators as dots (`fixtures.main`), because services such as Jenkins read the text before the last dot as a package; the `testsuite` keeps the full path as its `name`. A scenario name used twice in a form is numbered from the second use (`name (2)`) so that nothing merges the two. Everything is XML-escaped.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="datum-form-test" tests="3" failures="1" errors="0" skipped="1" time="1.840">
  <testsuite name="fixtures/main.json" tests="3" failures="1" errors="0" skipped="1" time="0.047" timestamp="2026-10-24T09:00:00.000Z">
    <testcase classname="fixtures.main" name="the age bounds and the calculation" time="0.031"/>
    <testcase classname="fixtures.main" name="a scenario kept for later" time="0.000">
      <skipped message="Skipped: waiting on the address rules"/>
    </testcase>
    <testcase classname="fixtures.main" name="a deliberate failure: the name is not optional" time="0.016">
      <failure message="Expected &quot;applicant_name&quot; to be optional, but it is required." type="failed">2: Expected "applicant_name" to be optional, but it is required.</failure>
    </testcase>
  </testsuite>
</testsuites>
```

**Markdown** (`form-tests.md`) is the one to read: a title, the run line (runner, the program's hash or "in-process", the start time), a heading per form with a table `Scenario | Runtime | Kernel | Result`, the details of each scenario that did not pass (line, message, expected and actual as JSON), the problems of each source, and with `--coverage` the table of rules, untested ones first and in bold.

### In GitHub Actions

```yaml
- name: Form tests
  run: node packages/form-test/dist/cli.mjs forms/*.json --report junit --report md --out form-test-reports
- name: Form test summary
  if: always()
  run: cat form-test-reports/form-tests.md >> "$GITHUB_STEP_SUMMARY"
- name: Upload the reports
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: form-test-reports
    path: form-test-reports
```

The first step fails the job on exit 1, 2, 3 or 4. The summary step puts the Markdown report on the run's page; the JUnit file is what a test-report action reads. The repository's own CI job (`form-test` in `.github/workflows/ci.yml`) runs the built command over the package's fixtures and expects exit 0 for two passing forms and exit 1 for a form with one scenario that fails on purpose.

## Parity

Under `--runner both` each scenario is played on a fresh driver of each side, over the same text, and the two are compared line by line. A line is compared when both sides have a step for it and neither skipped it; its status (`passed`, `failed`, `ran`, `error`) must be equal. Steps one side never reached (the other stopped earlier) are not compared.

- `agree`: no compared line differs.
- `one-sided`: one side skipped the scenario as a whole, or skipped every line the two sides share, so nothing is compared. A scenario over a `host.` rule with no `given host.` is the usual case.
- `differ`: a compared line came to different statuses (two errors on a line differ when their codes do), or one side errored where the other ran, or both errored for different reasons. The scenario's status becomes `parity`, the report lists the lines with each side's status, code and actual, and the run fails.

`differ` is a defect report, never a row to allow. It says the browser's runtime and the server's kernel disagree about what this form does with these answers, which is a person accepted by one side and refused by the other. There is no allow list in the command and none should be made: find which side is wrong (`--runner runtime` and `--runner kernel` show each alone), and fix the engine or the form. Do not edit the test until both sides agree with what it says. Running the kernel side on `--program` makes the check about the program a host actually ships; a program built before an engine fix can disagree with the in-process kernel, which is parity doing its job.

## Coverage

`--coverage` lists, from the Logic model (`buildLogicModel`, the same list the builder's Logic workspace shows, with the journey's conditions and routes and the PDF layouts' conditions), every rule of the form and the scenarios that exercised it. A scenario exercises a rule only if it ran to `passed`, `failed` or `parity` (a skipped or errored scenario pins nothing). A rule with no scenario is untested. The reading lives in the engine (`coverageOf` in `@argusvane/datum-engine/logic`, with `reach: "ran"` as here), where the builder's Tests panel uses it too, with `reach: "written"` (see "The rules without a test"). Untested is a list, not a failure, unless `--fail-on untested` says so.

A rule is exercised by the expectation that reads the property it decides, on its target:

| Rule kind | Exercised by |
| --- | --- |
| `show`, `hide` | `expect <target> visible` or `hidden` |
| `require` | `expect <target> required` or `optional` |
| `enable` | `expect <target> enabled` or `disabled` |
| `readonly` | `expect <target> editable` or `readonly` |
| `validate` | `expect error on <target>: rule`, or `expect no error on <target>`, or `expect no errors` |
| `calculate` | an `expect <target> = …` value check, or an `expect <formula>` that reads the target |
| `min-rows`, `max-rows` (a data grid's bounds) | `expect error on <target>: rows.min` or `rows.max`, or `expect rows of <target> = …` |
| `show-step`, `hide-step` | `visible` or `hidden` on the step's id |
| `route` | an `expect path = (…)` listing the route's source page immediately followed by its target; for a route to the end of the journey (`$end`), an `expect path = (…)` that stops at the route's source page together with an `expect path ends` (no exit page) in the same scenario |
| `pdf-layout` | `expect layout = <layoutId>` naming the layout |

A route rule belongs to one journey, and counts only for a scenario that ran it: the scenario's `given journey`, else the form's default journey (`given journey = none` runs no journey), so two journeys with a page of one id are covered separately. A path names a rule's target by its first segment or its last (indices dropped), and through the form's data keys and row fields (ADR 0109), so `expect items[0].qty visible` covers a rule on `items` and a rule on `qty`. These are the rule kinds the Logic model lists that the language has no expectation for and that coverage therefore leaves out: `default` (a starting value, `rules.defaultValue`), `filter` (the options a choice offers, `rules.filter`) and `gate` (the condition for continuing past a step, `rules.navigationGating`). A form with such rules is not reported as untested on them; it is also not known to be tested.

## The vitest helper

For a repository already on vitest, `formTests` from `@argusvane/datum-form-test/vitest` registers a form's scenarios as tests, so they run in the same suite as the code's. It imports `vitest` (an optional peer dependency, version 2.1 or later); the package's main entry never does.

```ts
// forms/registration.test.ts
import { fileURLToPath } from "node:url";

import { formTests } from "@argusvane/datum-form-test/vitest";

// Paths are read as given, relative to vitest's working directory, which under a monorepo or
// `--root` is not this file's folder: build them from the file's own URL.
const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

formTests(here("registration.json"), {
  name: "registration form",
  tests: [here("registration-extra.datum-test")],
  runner: "both",
  coverage: "warn"
});
```

A definition already in memory works too, with scenarios given as text:

```ts
import { formTests } from "@argusvane/datum-form-test/vitest";
import { registration } from "./registration.js";

formTests(registration, {
  name: "registration form",
  sources: [
    `test "a partnership needs a registered agent"
       set business_structure = "Partnership"
       expect registered_agent visible
       expect registered_agent required`
  ],
  coverage: "fail"
});
```

| Option | Meaning |
| --- | --- |
| `name` | The `describe` title. Default: the form's title, else the path, else the definition's id. |
| `tests` | Paths of `.datum-test` files to run besides the scenarios stored with the definition. |
| `sources` | Scenario text to run, for tests written in the test file. |
| `runner` | `"runtime"`, `"kernel"` or `"both"` (the default). |
| `program` | A sandbox program file for the kernel side, as `--program`. |
| `signatures`, `functions` | The signatures and implementations of plugin functions the form's rules call, which the command line cannot supply. |
| `coverage` | `false` (the default), `"warn"` (the untested rules go to `console.warn`) or `"fail"` (an extra test, `every rule is tested`, fails while any rule has no scenario). |

A string definition is a path, loaded as the command loads it, its sidecar included. The helper registers one `describe`, and inside it:

- one `it("<source> parses")` for each source with problems, which fails with the problems' messages (that source's scenarios are not registered, as the command does not run them); a source that parses but repeats a name an earlier source used gets the same failing test, and its scenarios are registered, as the command runs them;
- one `it(<scenario name>)` per scenario, which plays it on the chosen sides, skips (`context.skip()`, with the reason) when every side skipped, and throws with the failing steps' messages when it failed or errored, or with the parity table when the sides differ;
- the coverage test, when `coverage` asks for it. It plays any scenario that has not run yet and waits for the rest, so it gives the same answer whatever order vitest runs the file in (`--sequence.concurrent`, `--shuffle`) and under a `-t` filter; the message says the rules are untested "by the scenarios that ran".

Parsing happens when vitest collects the file, so a test that does not parse is reported at once. The sandbox host, when `program` is given, is made once per `describe` and disposed when it ends.

## In the builder

The builder has a Tests panel for the same scenarios. It is an item on the activity strip, named Tests, after Variables, and it is there in every workspace but Languages (Form, Logic, Data, Journeys, PDF and Print), because tests belong to the form and not to a view of it. It loads on first use: a builder that never opens it has not fetched it. The `tests` token of the `features` attribute (`<datum-builder features="…">`) turns it on and off; `minimal` leaves it off, so a host that wants it names it.

The panel shows the list of the form's tests and runs them on the browser's reading only: each scenario on a fresh headless runtime built from the form as it is committed now (drafts that are not yet applied are not in it), with the form's data sources and the host's plugin functions. It does not run the server's kernel and compares nothing. Parity between the two sides is the command's job (`--runner both`), and a form whose scenarios pass in the panel can still differ there.

### A test as the Print sample

The Print workspace (ADR 0174) previews the printed form with sample answers, and a scenario can be that sample. Choosing a test in its Sample answers menu plays the scenario on a fresh runtime and prints with the values it ends on, so a header or footer that reads a field (`{{applicant.name}}`) shows what that scenario answered. The menu offers the tests only while the Tests feature is on. The sample is for the preview and its test page; it is never saved into the form.

### The list

- **Run all** runs every test, whether or not Run as I edit is on.
- **Run as I edit** is a switch, on by default and remembered in the browser. While it is on, the whole list reruns shortly after any change to the form (a field added, moved or removed, a property applied) and after a test is applied; a run in flight is cancelled by the next change, and the results of the cancelled run stay on the list, dimmed, as stale. Nothing runs while the panel is closed; it runs when the panel is opened.
- The **summary line** says when the run happened and how many tests passed, failed, were skipped, could not run, or do not parse.
- Each row has a dot for its state (passed, failed, skipped, could not run, does not parse, not run yet) and the test's name. **Filter** narrows the rows by name. A skipped test is a warning, not a problem: it ran on no side that could judge it (see "What a skip means").
- The strip item carries a count: the tests that failed, could not run or do not parse. Skipped tests are not in it. The count is the panel's, so it appears once the panel has loaded, the first time Tests is opened.
- **Record a test** and the foot line **N of M rules untested · Show** are described below. The Tests item has its own glyph (a checklist) and `persist-panels` remembers it like any other panel, but a panel restored open at page load does not run the suite by itself: the first run is Run all or your first edit.
- When a run ends, its summary is read out to a screen reader, as is a removed test.
- **New test** adds an entry and opens it in the editor.

### The editor

Opening a row shows its source: one `test` block, in the language this page describes, in an editor that colours the statements, offers the form's fields, pages, error codes and values as you type, and marks each line with the state of the last run. Each problem the parser finds is listed under the box with its line, and a click goes to the line. The editor is plain text first: the CodeMirror editor loads on top of it a moment later, keeping the text, the caret and the focus, and if it cannot load the plain box stays.

**Add step** is a menu of the things a step can say, grouped as Set an answer, Expect a state, Expect a value, Expect an error, Journey, Rows and Output, for a field chosen from the form's own. It writes one line at the caret, with a placeholder value to replace, so a test can be written without remembering the words. **Reference** links to this page.

**Apply** saves the test with the form as one undo step; it is disabled while the text is the stored one. Close with an unapplied edit asks first, and the same question comes if the builder is asked to leave (another workspace, New, Open): the Tests panel opens to ask it if it was closed. With a Logic rule also unapplied, Save saves both. **Remove test** asks again before it removes. A new test's id is `test-<n>` for the smallest free number; renaming a test never changes its id.

### Record

**Record**, in the editor's row of buttons, turns what you do in Try it into lines of the open test. It turns Try it on if it is off and the bar reads "Recording" with a Stop recording button; the panel's own Record button reads Stop recording while it records. Close, Show me and Back to editing end the recording too; a run does not (it replays the saved tests on runtimes of its own and never touches Try it), so Apply, which starts one while Run as I edit is on, saves the lines so far and the recording carries on. The Form canvas's Try it has no day of its own, so Record lends it today's date (your calendar day) for the length of the recording and puts it back after: the rules on screen read that day while you record. When the form reads the clock and the test names no day, Record writes `given today = @"<that day>"` under the header, before any recorded line, so the test does not depend on the day it is run. In the list, **Record a test** first makes a new test named "Recorded 1" (the smallest free number) and records into it.

Each settled thing you do becomes one line, appended after the test's last filled line (the box turns dirty; **Apply** saves, as for any edit):

| In Try it | Written |
| --- | --- |
| an answer, once the field is left or another is written | `set <path> = <value>`; emptied (nothing, an empty list, a checkbox group with nothing ticked) is `clear <path>` |
| a row added or removed | `add row to <collection>`, `remove row <n> of <collection>` |
| Continue, Back, a jump to a page | `continue`, `back`, `go to <page>` (a Continue the page's checks held back is still `continue`, since the lines after it read the errors it showed) |
| A Change link on a Check answers step | `change <field>`: the first answer the step it opened asks (any row of that step opens the same step), a repeating section's own path for an answer inside a row |
| Check now | `check` |
| Submit | `submit` |

Paths are value paths (a data key is honoured). A calculation's value is not recorded, since the test would then assert what the form computes as if the author had typed it; a value written into a field twice with the same value is one line. Something the language cannot say is not written and the panel's status line says why: an answer to a field the form does not name, a value the language cannot spell (a record, a number that is not finite), a page with no id. A removed row is written only when exactly one row went. Clear answers ends a recording; a journey card's Restart does not, the recording follows the new runtime. When no day is known (a Journeys session runs on a runtime of its own, with no day) Record writes no `given today` line and the status line says so once ("The day Try it runs on is not known here, so no given today line was written."): add the day yourself, or the scenario ends as `scenario.clockUnset`.

### Assert this

**Assert this**, next to it and offered while Try it is on, opens a popover that lists the fields the last recorded step changed (ticked), then every field (with a search box), and the extras "The page", "The errors on show" and, after a Submit, "The verdict". **Insert N lines** writes what you ticked after the test's last line:

- a visible field: `expect <path> visible` (a hidden one only `hidden`), then `expect <path> required` or `optional` only when a `requiredWhen` decides it, then `expect error on <path>: <code>` for each error on show, or `expect no error on <path>` when it has none;
- a field the last step moved asserts only what moved;
- "The page": `expect page = <id>`; "The errors on show": one `expect error on …` per error, or `expect no errors`; "The verdict": `expect accepted` or `expect refused`.

An error code with characters outside letters, digits, `.`, `_` and `-` is asserted without the code. The popover reads Try it's state now, so it is the author's assertion, not the form's promise: run the test after inserting, and read each line before you trust it.

### The rules without a test

The list's foot line says "N of M rules untested · Show". **Show** opens the rules view: every rule the Logic workspace lists that a test can pin (the same set the command's `--coverage` reports, see "Coverage"), each as its Logic sentence with the kind (Show, Hide, Require, Enable, Read-only, Validate, Calculate, Fewest rows, Most rows, Show step, Hide step, Route, PDF layout), then either **Pinned by** and the names of the tests (buttons that open the test) or **Untested**, and a **Write a test** button on every row. The panel's reading is more generous than the command's: it counts a scenario that parses, whatever its last result, so a pin shows before the first run; the command counts a scenario only when it ran to passed, failed or parity.

**Write a test** writes a scenario from the rule, in one undo step, opens the first and (with Run as I edit on) runs it. Where the rule's condition is a comparison of one field with a literal (`=`, `!=`, `<`, `<=`, `>`, `>=`, `in (…)`, a bare yes-no field, `not(…)` of one of these, or `and`/`or` of them over fields) it writes one scenario for the condition holding and one for it not holding, with answers that make each true (the compared value; for a choice, the matching option and another one; for `<` and `>` one step either side of the bound), and the expectation that kind of rule decides: `expect <target> visible` or `hidden`, `required` or `optional`, `enabled` or `disabled`, `readonly` or `editable`, `check` then `expect error on <target>: rule` or `expect no error on <target>`, `expect <target> = <formula>` for a calculation, `check` then `expect error on <collection>: rows.min` or `rows.max` for a row bound, `expect page = <next>` (and `expect path = (…)`) for a route, `expect layout = <id>` for a PDF layout. The names are "<target label> is shown when <condition>" and its counterpart. Anything else (a condition the scaffold cannot solve) writes the `set` line with an empty value and a comment, `# pick a value that makes "<formula>" true`, and says so: the test does not pass until you fill it. A route scaffold needs the earlier pages' answers added by hand, since Continue leaves a page only with valid answers.

Known limits of the scaffold, each pinned by a test so a fix shows: a **show step** or **hide step** scaffold fails with `expect.unknownField` on the browser's side (the runtime driver does not take a step's id as a field); the "condition holds" scenario of a rule on a field inside a repeating section reads the row template once, not the row, and fails while its counterpart passes; and the over-the-limit case of a maximum-rows rule is not written at all, because the form refuses the row (`action.refused`, `rows.max`) and the language has no statement for a refused add.

### In the Logic workspace

A saved rule's editor ends with a **Pinned by** line: the names of the tests that pin it, as buttons that open the test in the Tests panel (and bring the panel up if it is closed), or "No test pins this rule." with a **Write a test** button that does what the rules view's button does. The line is not drawn for the kinds no expectation reads (`default`, `filter`, `gate`). With no tests at all the line still reads "No test pins this rule." so the first test can be started from the rule. Pins are recomputed while Logic is on show, from the committed form and the saved tests, not from an unapplied edit.

### A failure

A failed test shows, in the editor, the line that failed and a card with the reason in the form's own words (the labels the author gave, not the ids): what the test expected and what the browser found. The lines after the first failure are marked as not reached. The card has up to three actions.

- **Show me on the form** turns Try it on over the canvas with the answers the test had set up to that step, so the form on screen is the form the test saw. The Try bar then shows "Showing step k of n", with Step back, Step forward and Stop showing; each step replays the scenario up to that step. A journey test shows its page: in the Journeys canvas the preview goes to that page, and on the Form canvas the bar names the page without going anywhere. A step that cannot be replayed keeps the last state on screen and the bar says so. Any edit of the form, a new run, or closing the panel ends the showing. It needs the Try it feature. From Logic, Data or a Journeys or PDF overview, where the canvas is put away, Show me first goes back to the Form workspace (asking about unapplied edits as any switch does) with the Tests panel open. The scenario's givens are applied for the length of the showing and put back after it: `given options for` fills the simulated list of that field's data source, `given locale` switches the preview's language, `given today` sets the preview's day. `given host.…` sets the host values the rules read (dotted names nest, as `host.org.unit` is read), in place of Try it's Settings' Host values while it is shown, and those come back after; a day and a language are not applied while a Journeys session runs, which keeps a runtime of its own, and the bar says so. The shown line is marked in the editor's gutter, and the mark goes when the showing ends; the panel's status line announces it as "Line N shown on the form." each time it starts or moves (the step count is the Try bar's, which announces it itself).
- **Open rule** is offered when the failed expectation reads a property that a rule decides (shown, required, enabled, read-only, valid, a calculation), the target has a rule of that kind, and the Logic feature is on. It opens the Logic workspace on that field's rule of the kind the test reads (the show or hide rule for `visible`, the require rule for `required`, and so on), else on its first rule.
- **Accept new behaviour** rewrites the one failing line to say what the form does now: a state flips (`visible` to `hidden`, `required` to `optional`, and the like), a value expectation takes the actual value, a page or path takes the actual one, `accepted` and `refused` swap. The change is made at once, as one undo step, and shown in the editor with the caret on the line; there is no separate Apply. It is refused, with the reason, when it could not write the line faithfully: a formula expectation, a value that is a record, a step that did not fail, or a fact the run did not report.

### A walkthrough

The fixture form from the first example is open in the builder and its test "email is required when it is the way to reach you" passes. Open the Tests panel and Run all: the summary reads "Ran just now · 1 passed". Now open Logic, find the rule that makes the email field required and clear it. With Run as I edit on, the dot turns to failed within a moment and the strip item shows a count of 1. Open the test: the card names the line `expect email required` and says the email was expected to be required and the browser found it optional.

Press Show me on the form: the builder goes back to the Form workspace, the canvas turns on Try it with the applicant name and age filled in and the contact method set to email, and the bar says "Showing step 7 of 10". Step back twice to see the form before the contact method was chosen (one step back is the step that chose it). Then choose. If the rule was removed by mistake, go back to Logic and put it back; the test passes again on the next run. (Open rule is not offered here: it is offered only while the field has a rule of the kind the test reads, and this one was cleared.) If the form is meant to behave this way now, **Accept new behaviour** rewrites the line to `expect email optional` and saves it. Either way the change is on the undo stack, and the tests travel with the form's file.

### How a host keeps the tests

Tests are part of the form's definition (`tests`), so a host that already saves `value`, `localization`, `pdf` and `journey` beside each other adds one more field.

- `<datum-builder>` has a `tests` property. Reading it gives the committed block; setting it feeds the form's own in, silently: no change event, no undo step, and the panel rereads it. Set it with the form, when a definition is loaded. A tests edit in the panel is an ordinary edit of the form: it fires `builder-change` with the reason `edit`, so a host that saves on that event needs no extra wiring beyond reading `builder.tests` where it reads `builder.localization`.
- `<datum-form-builder>` carries `tests` in its `definition` both ways: a definition assigned with a `tests` block seeds the builder, `definition` reads it back, `datum-builder-change` is announced for an edit that only touched a test, and the File menu's Download and Open carry it. A form that is otherwise empty but has tests is not empty for New's question.
- The builder's own controller has `tests()` and `setTests(value)`. `setTests` normalizes the block (an entry without a non-empty `id` and a string `source` is dropped, and the first of two with one `id` wins; an empty list leaves no `tests` key) and is one undo step.
- Renaming a field in the builder rewrites the references to it in the tests (a segment equal to the old id anywhere in a dotted path; `[n]` positions are skipped), as a second undo step: a form with tests keeps passing through a rename. A field with a data key keeps its data path under a new id, so the tests are left as they are. Giving a journey page another id, or a journey another id, is followed the same way (`go to`, `expect page`, `expect path`, `path ends at`, `on path` for a page; `given journey` for a journey), as its own undo step. A layout's id never changes (renaming it changes its label), so there is nothing to follow. The Journeys mode tells the builder itself, with a bubbling `builder-journey-rename` event on the builder's root, so a host forwards nothing, whether it uses `<datum-form-builder>` or mounts the mode by hand through `builder.addMode(...)`; a journey given another id before the Journeys workspace was first opened is told when it opens. The mode's `onChange` detail still names the change (`reason` `"page-rename"` or `"journey-rename"`, `renamed: { journeyId, from, to }`), and the same two reasons arrive on `datum-journey-change` and `datum-builder-change`, for a host that keeps references of its own. Only a mode mounted outside the builder's tree, whose event never reaches the builder, has the host pass the mode's `onChange` detail to `builder.followJourneyChange(detail)` (it ignores every other detail).

## On a server: the `test` op

A host without Node runs a form's tests through the sandbox's inspect entry point, the same way it asks for `check` or `public` (ADR 0154). The request is `{ abi, op: "test", definition, tests?, formulaErrors? }`:

- `tests` is sidecar text (the concatenation of `test` blocks), parsed with the program's function signatures. Absent, the definition's own `tests.scenarios` run, one entry each, with the names checked across entries as the panel does.
- `formulaErrors` is the host's policy word, as for `check`.

The answer is `{ ok: true, op: "test", report }` with `report = { scenarios: [{ id?, name, line, status, reason?, params?, steps }], summary: { total, passed, failed, skipped, error }, problems: [{ id?, code, line, start, end, params? }] }`. A scenario's `steps` are the runner's step results, so the command's and the builder's words apply to them unchanged, and `problems` are the parse problems with the entry's `id` when the tests came from the definition. Four requests are refused as `invalid_request` with `where` and `limit` in the error: `tests` that is not text or is over 256 KiB, more than 200 scenarios, a scenario of more than 1,000 statements, and a definition past one of the size caps `check` refuses first (`where: "definition"`, `limit` the cap's number; a select with 2,001 options is one), before any scenario runs. A request naming an ABI newer than the program's is `abi_mismatch`, as for every op.

It gives the **kernel's reading** and no other: what the command reports as `--runner kernel`. The program holds the same parser, judge and server driver the engine does (they are listed in `PORTABLE_KERNEL_FUNCTIONS`, so the in-process host answers byte for byte what the QuickJS program answers, and a test holds them to it). Rules the kernel cannot replay skip with the reasons in "What a skip means" (`unreplayable.host`, `.browser`, `.clientDerived`, `.secret`), a scenario's `given host.` values are every run's `hostContext`, and there is no clock: a form that reads the day needs `given today` or the scenario ends as `scenario.clockUnset`. The op never compares with the browser's side; parity is the command's.

The program is `datum-sandbox-program.js` in `packages/datum/dist` (the globals `__datum_register`, `__datum_run`, `__datum_inspect`); the in-page module `datum-wasm.js` carries the same kernel. A program built before 2.16 has no `test` op and answers `invalid_request` for it, so rebuild and ship the program with the host. It also carries the judge, so the judge's wording of a failure (`params.sent` for a withheld answer, `actual.last` for a path's last page) reaches a host only with a rebuilt program.

A request that carries many scenarios needs time, nearly all of it the runs and the folds: the QuickJS host (`@argusvane/datum-quickjs-wasm-host`) gives a `test` request the 5,000 ms cap by default instead of the 250 ms plus 1 ms per KB an `inspect` otherwise gets (an explicit `maxEvalMs` is used as given). A host that sets its own budget must do likewise when it wires the op. Plugins' functions and validators reach the op as they reach a run.

**The op is part of the floor.** `test` belongs to the sandbox ABI every host's floor names (`SandboxAbi.MIN`, `SANDBOX_ABI_MIN`), and a host adopts the op when it wants it. Whether a failing suite may block publishing is the host's setting, off by default.

## Limits

- **Files are not answers.** `set upload = file(…)` does not exist, since the value shape of an upload is host-specific (ADR 0034).
- **A host adopts the `test` op by choice.** The op exists and no host is required to call it. A host's Tests tab (a run at save or publish, a failing suite blocking publishing only by a setting) is that host's to build.
- **Record waits for the form's own signals.** The preview publishes no `interim` flag and has no commit, so Record holds each answer until another field is written, focus leaves the form's control, or a move, check, submit or Assert comes; a mode's journey session already reports settled answers.
- **What a scenario cannot say.** Per-row requiredness inside repeating sections is not asserted (the fold does not do it), scenarios are written and not generated, and a scenario takes one `given today` (a second is `duplicateGiven`).

The command supplies no plugin functions, so a form whose rules call one cannot be tested from the command line (the vitest helper, the programmatic API and the builder take them). A sandbox program built before the latest kernel fixes judges as that kernel did; rebuild it before running `--program` against it. And the builder's panel judges on the browser alone, so the parity finding exists only in the command and the helper.
