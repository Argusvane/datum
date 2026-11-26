# The form-test language

A form's tests are written in a small line-based language. This page lists every statement of it: the givens that set the scene, the actions a person would take, and the expectations that say what must be true afterwards. [Testing a form](/testing) says where tests live and how to run them.

```
test "a partnership needs a registered agent"
  given today = @"2026-03-01"
  set business_structure = "Partnership"
  expect registered_agent visible
  expect registered_agent required
  submit
  expect refused
  expect error on registered_agent: required
```

## The shape of a test file

A file, or the text of one test in the builder, holds one or more tests. Each one is a block that starts with a `test` line and runs until the next.

```
# A comment runs to the end of its line.
test "first scenario"
  skip "waiting for the new tax table"
  given locale = "fr-CA"
  given host.role = "admin"
  set age = 17
  expect no errors

test "second scenario"
  continue
```

The rules of the text:

- **One statement a line.** Blank lines and indentation mean nothing. Write the statements indented under the `test` line for readability.
- **Comments.** `#` starts a comment, unless it sits inside a quoted text or a name in backticks.
- **Keywords are English** in every language of the form, and are read in any case: `Submit`, `submit` and `SUBMIT` are the same. Field names, page ids and codes keep their case.
- **Order within a test.** `skip` comes directly under the `test` line. Every `given` comes before the first action or expectation, and each given appears once. Anything else is a problem the builder shows on the line.
- **Names.** A test's name is a quoted text, and no two tests of one run share a name (reports key the results by name).
- **Limits.** One source of tests may hold up to 200,000 characters, and one test up to 1,000 statements. A test with more ends as an error.

### Values

A value is written as a literal.

| Literal | Written as |
|---|---|
| Text | `"Jane Doe"` or `'Jane Doe'`, in straight quotes. A backslash escapes the next character, and `\n`, `\t` and `\r` are a new line, a tab and a carriage return. Curly quotes are refused. |
| Number | `42`, `-1.5`, `.5`, `1e3` |
| Yes or no | `true`, `false` |
| Nothing | `null` |
| Date | `@"2026-03-01"`, which is the text `"2026-03-01"` and must be a real calendar day |
| List | `("Ontario", "Quebec")`, nested up to 32 levels, and `()` for an empty one |

A field is named by its **value path**, which is where its answer is stored: `name`, `applicant.email`, or a row of a repeating section, `items[0].qty` (rows count from 0). If a field has a data key, its path uses the key; see [Data model and data sources](/data#ids-and-data-keys). Pages, journeys and PDF layouts are named by id.

## Givens

A given sets the scene before the first step.

| Given | Sets | Example |
|---|---|---|
| `given today = <day>` | The day the form's rules see. A form whose rules read the clock (`today()`, `age()`) needs it: without it the test ends as an error, "needs a day", on both sides. | `given today = @"2026-03-01"` |
| `given locale = <code>` | The language the form is in. It must be one the form offers, else the test ends as an error. | `given locale = "fr-CA"` |
| `given journey = <id>` | The journey the test runs. `none` runs the whole form as one page. With no `given journey`, a form that has a journey runs its default journey. | `given journey = intake` |
| `given host.<key> = <value>` | A value the page would pass in with `host.<key>` in a rule. | `given host.role = "admin"` |
| `given options for <path> = <list>` | The options a choice that takes them from a data source is offered. The field must have a data source. Each value is also its label. | `given options for province = ("ON", "QC")` |

Both sides use the `given host.` values:

- The browser's runtime reads them as the page's host values.
- The server side gets them as its host context, so it judges the same rules.
- A dotted key nests: `given host.org.unit = "tax"` is what `host.org.unit` reads.
- A key no given sets reads as no answer on both sides.

A test with no `given host.` gives the server side no host context, as on a server that supplies none. That side then does not judge a rule that reads `host.`, and skips each step such a rule decides. See [Testing a form](/testing#skipped-steps).

## Actions

An action is something a person does. After each one the form's state is read again.

| Action | Does | Example |
|---|---|---|
| `set <path> = <value>` | Types or picks an answer. The answer counts as settled, as if the person had left the field. Setting a row past the last adds rows up to it, within the section's limits. A list is for a field that holds several values, such as checkboxes. | `set age = 17` |
| `clear <path>` | Removes the answer. | `clear registered_agent` |
| `add row to <collection>` | Adds an empty row to a repeating section or data grid. | `add row to items` |
| `add row to <collection> with <key> = <value>, …` | Adds a row with answers. The keys are the fields' keys inside the row. | `add row to items with sku = "A1", qty = 2` |
| `remove row <n> of <collection>` | Removes row `n`, counted from 0. | `remove row 0 of items` |
| `continue` | Presses Continue on the current page. A page with errors stays where it is, with its errors shown. | `continue` |
| `back` | Goes to the page before. | `back` |
| `go to <page>` | Jumps to a page, as the page list would. Only a page the person could reach counts. | `go to review` |
| `change <field>` | On a Check answers page, presses the Change link of that answer's row: the page that asks it opens, and a `continue` then comes back to the Check answers page, or goes first to a page the new answers put on the path. The test ends as an error when there is no such row to press. | `change email` |
| `check` | Runs the checks of the current page, or of the whole form without a journey, as pressing Continue or Submit would, but moves nowhere and sends nothing. It gives a verdict. | `check` |
| `submit` | Presses Submit. The verdict is accepted or refused, and an accepted one gives the submission. | `submit` |

- `continue`, `back`, `go to` and `change` do nothing in a run without a journey, and the next expectation says what the form did.
- A row action the form turns down ends the test as an error, naming the reason. The cases are a row beyond the section's maximum, a remove below its minimum, a section that does not allow adding, and a row that is not there.
- Errors appear only when something checks: put a `check`, `continue` or `submit` before an `expect error`.

## Expectations

An expectation starts with `expect` and states a fact. A failed one is reported with the line, what was expected and what the form did.

### About one field

| Form | Holds when | Example |
|---|---|---|
| `expect <path> <state>` | The field is in that state. The states are below. | `expect registered_agent required` |
| `expect <path> not empty` | The field has an answer. | `expect name not empty` |
| `expect <path> = <value>` | The field's answer equals the value. A list is compared as a set for a group of checkboxes. | `expect total = 120` |
| `expect <path> != <value>` | It does not. | `expect status != "draft"` |
| `expect error on <path>` | Some error is on the field. | `expect error on email` |
| `expect error on <path>: <code>` | An error with that code is on the field: `required`, `minLength`, `maxLength`, `pattern`, `number.min`, `rows.min`, `rows.max`, `rule`, a host's own code. | `expect error on email: pattern` |
| `expect message on <path> = "<text>"` | An error on the field has exactly that wording, in the test's language. | `expect message on email = "Enter an email address"` |
| `expect no error on <path>` | The field has no error. | `expect no error on email` |
| `expect <path> withheld` | The form holds an answer for the path and did not send it, because the field is hidden and excluded, or on a page off the path. Needs a `check` or `submit` before it. | `expect discount_code withheld` |
| `expect rows of <collection> = <n>` | The repeating section holds `n` rows. | `expect rows of items = 2` |

The states:

| State | Holds when |
|---|---|
| `visible` | The field is shown. |
| `hidden` | The field is not shown. |
| `required` | An answer is required now. |
| `optional` | It is not. |
| `enabled` | The field can be used. |
| `disabled` | It cannot. |
| `readonly` | The field shows its answer and cannot be changed. |
| `editable` | It can be changed. |
| `empty` | There is no answer. A group of checkboxes with nothing ticked, or a checkbox that is not ticked, is empty. |
| `not empty` | There is one. |

### About the whole form

| Form | Holds when | Example |
|---|---|---|
| `expect accepted` | The last `check` or `submit` came out accepted. Asked before either has run, it fails. | `expect accepted` |
| `expect refused` | It came out refused. | `expect refused` |
| `expect no errors` | No error is on show anywhere. | `expect no errors` |
| `expect submitted <path> = <value>` | After an accepted `submit`, the submission carries that answer at that path. | `expect submitted registered_agent = "Jane Doe"` |
| `expect layout = <id>` | The answers choose that PDF layout. | `expect layout = partnership-letter` |
| `expect <formula>` | A formula over the answers is true, written as a rule would be and read with the same functions. Only `true` holds. A name the form does not have fails the expectation. `row.` and `ancestor.` reads are not available, because a test has no row in scope. | `expect total = subtotal * 1.13` |

A line that is not any other form is read as a formula, so `expect total > 100` and `expect age in (17, 18)` work. A line that starts with a `host.`, `row.` or `ancestor.` name is always a formula. See [Rules and formulas](/formulas) for the language.

### About a journey

These need a journey: with `given journey = none` they fail as having no journey to look at.

| Form | Holds when | Example |
|---|---|---|
| `expect page = <page>` | The person is on that page. | `expect page = review` |
| `expect path = (<page>, …)` | The pages on the path, in order, are exactly these. | `expect path = (start, details, review)` |
| `expect path ends` | The path runs off the end of the journey. | `expect path ends` |
| `expect path ends at <page>` | The path stops at that exit page. | `expect path ends at declined` |
| `expect <page> on path` | The page is on the path. | `expect details on path` |
| `expect <page> off path` | It is not. A page the journey does not have fails, so a typo does not pass. | `expect details off path` |

## An example with a journey and a repeating section

```
test "the details page takes rows and leads to the review"
  given today = @"2026-03-01"
  given journey = intake
  expect page = start
  set full_name = "Ada Lovelace"
  continue
  expect page = details
  add row to items with sku = "A1", qty = 2
  add row to items
  expect rows of items = 2
  remove row 1 of items
  expect rows of items = 1
  set items[0].qty = 3
  continue
  expect page = review
  expect path = (start, details, review)
  back
  expect page = details
  go to review
  submit
  expect accepted
```

## Problems the parser reports

A line that cannot be read is a problem with a code, shown on its line in the builder and listed in the command's report.

- The lines after it are still read, so every problem shows at once.
- The command runs none of a source's tests while that source has a problem, and exits with code 1.

| Code | Meaning |
|---|---|
| `unknownStatement` | The line does not start with a statement word. |
| `stepOutsideTest` | A statement comes before the first `test` line. |
| `expectedName` | A `test` line has no name in quotes, or an empty one. |
| `duplicateName` | Another test of the run already has the name. |
| `expectedPath` | A field path was expected. |
| `expectedValue` | A value was expected. It names the list when a list was. |
| `expectedPage` | A page id was expected. |
| `expectedNumber` | A whole number was expected, such as a row number. |
| `expectedEquals` | An `=` was expected. |
| `expectedKeyword` | A word such as `to`, `of` or `on` was expected. |
| `badState` | A word after a path is not a state and the line is not a formula. |
| `badCode` | An error code has characters other than letters, digits, dots, underscores and hyphens. |
| `badGiven` | A given is not one of the five, or its value is not usable (a day that is not on the calendar, an empty locale). |
| `givenAfterStep` | A given comes after an action or expectation. |
| `duplicateGiven` | The test already sets that given. |
| `skipAfterStep` | `skip` is not directly under the `test` line. |
| `unterminatedString` | A quoted text is not closed, or uses curly quotes. |
| `unclosedList` | A list is not closed, or nests too deeply. |
| `badFormula` | An `expect` formula does not parse. |
| `trailingText` | There is text after the end of a statement. |
| `tooLong` | The source is longer than 200,000 characters. |

The builder's Tests panel also gives one piece of advice that is not a problem: `tests.set.unknownPath`, shown when a `set` names a path no field of the form stores an answer at. The step still runs, as a test may send an unknown key on purpose to see the form drop it.

## How a test ends

Each test comes to one of four results, and each side (the browser's runtime and the server's kernel) gives its own.

| Result | Meaning |
|---|---|
| passed | Every expectation held. |
| failed | An expectation did not hold. |
| skipped | The test has `skip`, or this side cannot judge it. See [Testing a form](/testing#skipped-steps). |
| error | The test could not run: a given could not be applied (`scenario.badGiven`, `scenario.unknownJourney`), the form needs a day (`scenario.clockUnset`), a formula of the form does not compile (`scenario.formulaInvalid`), a row action was refused (`action.refused`), or the test is too long (`scenario.tooManySteps`). |
