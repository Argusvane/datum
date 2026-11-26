# Rules and formulas

A rule makes a form respond to its own answers: a field appears when another is ticked, a total works itself out, a date must fall after another. Each rule is a formula, a line of text in a small subset of FEEL, the expression language of DMN decision tables. `age(dateOfBirth) >= 18` is a formula. The browser, the server's sandbox and the PDF program all read the same text, so they reach the same verdict.

## What a rule can do

A rule is stored on a component under `rules`.

| Key | Effect |
|---|---|
| `visibleWhen` | Hidden unless the formula is `true`. A hidden field's answer is not sent unless the field says otherwise (see [Answers of hidden fields](/data#answers-of-hidden-fields)). |
| `enabledWhen` | Disabled unless the formula is `true`. |
| `readonlyWhen` | Read-only while the formula is `true`. |
| `requiredWhen` | Required while the formula is `true`, on top of the field's own Required. |
| `validWhen` | A check on the answer: a non-empty answer is refused with the code `rule` unless the formula is `true`. The message is the field's `messages.rule`. |
| `value` | A calculation: the field holds the result. No result means no answer. |
| `defaultValue` | Used while the field is empty. Browser only. |
| `filter` | Keeps the options of a choice field the formula is true for. Browser only. |
| `navigationGating` | Blocks moving into or out of a step until the formula holds. Browser only. |
| `minRows`, `maxRows` | On a data grid, the fewest and most rows, as a number worked out from other answers. |

Journey routes and PDF layouts take formulas too, as a `when` that chooses the route or layout.

```json
{
  "id": "end_date",
  "type": "date",
  "configuration": { "label": "End date", "messages": { "rule": "The end date is on or after the start date." } },
  "rules": { "validWhen": "end_date >= start_date" }
}
```

A condition holds only for the yes-or-no `true`. A number, a text, an empty list or a missing answer does not hold, so compare instead of passing a bare value: `email != null`, `len(items) > 0`, `status = "paid"`.

## Writing a formula

Numbers are `42` and `3.5`, text is `"hello"` or `'hello'`, yes-or-no is `true` and `false`, nothing is `null`, and a calendar day is `@"2026-01-31"`. Keywords are case-sensitive.

Operators, loosest binding first:

| Level | Operators |
|---|---|
| 1 | `if ... then ... else ...` (`else` optional; `else if` chains) |
| 2 | `or` |
| 3 | `and` |
| 4 | `=` (also `==`), `!=`, `<`, `<=`, `>`, `>=`, `between a and b`, `in (a, b)`, and the intervals `[a..b]`, `(a..b]`, `[a..b)`, `]a..b[` |
| 5 | `+` `-` |
| 6 | `*` `/` |
| 7 | unary minus |

- `not(x)` is the way to write not.
- Comparisons do not chain: `a < b < c` is an error, write `a < b and b < c`.
- Formulas nest at most 100 levels deep.

```
if age < 18 then "minor" else if age < 65 then "adult" else "senior"
age between 18 and 65
province in ("ON", "QC", "BC")
startDate in [@"2026-01-01"..@"2026-12-31"]
```

`else` is optional. With no case holding and no `else`, the result is no answer: a hidden field, an unrequired one, an unset calculation. Write an `else` when you want a definite value.

### Types and empty answers

- **Arithmetic** (`+ - * /`) works on numbers, and on text that is a plain decimal numeral (`"3.5"` reads as 3.5; `"0x10"` does not). Anything else, an empty answer, `null`, a blank or non-numeric text, a yes-or-no, a list, gives no answer, and so does dividing by zero. An empty answer plus 1 is no answer, not 1. `+` does not join text; use `concat`.
- **Equality** is strict: `"1" = 1` is false. A missing answer and `null` are the same nothing, so `ratio = null` holds for an unfilled field and for a calculation with no answer, and `ratio != null` means it is known.
- **Ordering** compares two texts by code unit, which orders `YYYY-MM-DD` days as days. Two texts that are both plain numerals compare as numbers (`"10" > "9"`). Otherwise both sides are read as numbers, and a non-numeric text, a missing answer or a yes-or-no never orders: the comparison is false.
- **`and`, `or`, `if`** hold only for `true`. Anything else, including a missing answer, counts as not holding, and `not(x)` holds for any `x` that is not `true`.
- **`coalesce(a, b)`** takes the first value that is not `null` or missing. A blank text is a value; wrap it in `empty()` to test for blank.

## Naming fields, rows and variables

A bare name reads a field by its id or data key: `quantity`, `applicant.email`. A name that is not a plain identifier goes in backticks: `` `first name` ``. A hyphen inside a name belongs to it, so write `price - discount` with spaces to subtract.

Inside a data grid row, three prefixes reach beyond the field itself:

| Prefix | Reads |
|---|---|
| `row.amount` | A sibling in the same row. |
| `ancestor.total` | A field outside the grid, from inside it. |
| `host.region` | A value the host supplies, not an answer (see [Values from the host](#values-from-the-host)). |

Other ways to read a row:

- `component` is the field the rule is on, so `len(component) >= 3` needs no name.
- `rowIndex()` and `rowCount()` give the row's position and the number of rows.
- A whole column is read with `pluck(items, "amount")`, so `sum(pluck(items, "amount"))` totals a grid.
- A calculation inside a row runs for each row, so `row.qty * row.price` gives each line total.

## Functions

A function given a value it cannot work with has no result and never throws. Names are camelCase. A parameter ending in `?` is optional; `...` repeats the last parameter. Each result below is one value; "text" is a string, and a date is a `YYYY-MM-DD` string.

### Logic

| Call | Gives | What it does | Example |
|---|---|---|---|
| `coalesce(value, ...)` | any | The first argument that is not null or missing. | `coalesce(nickname, firstName, "there")` |
| `empty(value)` | boolean | True when the value is missing, blank, an empty list or a group with nothing ticked. | `empty(email)` |
| `isNumber(value)` | boolean | True when the value is a number or a text that reads as one. | `isNumber(quantity)` |
| `isDate(value)` | boolean | True when the value is a calendar day written YYYY-MM-DD. | `isDate(startDate)` |

### Text

| Call | Gives | What it does | Example |
|---|---|---|---|
| `concat(value, ...)` | text | Joins the arguments into one text; missing values add nothing. | `concat(firstName, " ", lastName)` |
| `len(value)` | number | The number of characters in a text or items in a list. | `len(postcode)` |
| `upper(text)` | text | The text in upper case. | `upper(postcode)` |
| `lower(text)` | text | The text in lower case. | `lower(email)` |
| `titleCase(text)` | text | The text with the first letter of each word in upper case. | `titleCase(city)` |
| `trim(text)` | text | The text without spaces at either end. | `trim(reference)` |
| `startsWith(text, prefix)` | boolean | True when the text begins with the prefix. | `startsWith(postcode, "K1")` |
| `endsWith(text, suffix)` | boolean | True when the text ends with the suffix. | `endsWith(email, ".ca")` |
| `contains(haystack, needle)` | boolean | True when the text contains the needle, or the list holds it as an item. | `contains(languages, "fr")` |
| `substring(text, start, length?)` | text | The part of the text from a 1-based position, optionally limited to a length. | `substring(sin, 1, 3)` |
| `indexOf(haystack, needle)` | number | The 1-based position of the needle in the text or list, or 0 when absent. | `indexOf(email, "@")` |
| `replace(text, find, with)` | text | The text with every occurrence of one piece replaced by another. | `replace(phone, "-", "")` |
| `split(text, separator)` | list | The text cut at each separator, as a list. | `split(tags, ",")` |
| `join(list, separator)` | text | The list's items as one text with the separator between them. | `join(selected(languages), ", ")` |
| `matches(text, pattern)` | boolean | True when the whole text matches the regular expression. | `matches(postcode, "[A-Z]\d[A-Z] ?\d[A-Z]\d")` |
| `text(value)` | text | The value written as text. | `text(total)` |
| `padStart(text, length, fill)` | text | The text padded at the start with the fill up to the length. | `padStart(text(invoiceNumber), 6, "0")` |

### Numbers

| Call | Gives | What it does | Example |
|---|---|---|---|
| `sum(value, ...)` | number | Adds the arguments; a list argument adds its items. | `sum(price, tax)` |
| `min(value, ...)` | number | The smallest of the arguments; a list argument contributes its items. | `min(quote1, quote2)` |
| `max(value, ...)` | number | The largest of the arguments; a list argument contributes its items. | `max(quote1, quote2)` |
| `avg(value, ...)` | number | The mean of the arguments; a list argument contributes its items. | `avg(pluck(scores, "mark"))` |
| `count(value)` | number | How many items are selected: a list's length or the ticked boxes of a group. | `count(interests)` |
| `abs(number)` | number | The number without its sign. | `abs(balance)` |
| `round(number)` | number | The number rounded to the nearest whole number. | `round(total)` |
| `roundTo(number, scale)` | number | The number rounded to a count of decimal places. | `roundTo(total, 2)` |
| `roundUp(number, scale?)` | number | The number rounded away from zero, optionally at a count of decimal places. | `roundUp(hours)` |
| `roundDown(number, scale?)` | number | The number rounded towards zero, optionally at a count of decimal places. | `roundDown(hours)` |
| `floor(number)` | number | The largest whole number not above the number. | `floor(ratio)` |
| `ceil(number)` | number | The smallest whole number not below the number. | `ceil(ratio)` |
| `modulo(number, divisor)` | number | The remainder after dividing by the divisor. | `modulo(seats, 4)` |
| `power(base, exponent)` | number | The base raised to the exponent. | `power(1 + rate, years)` |
| `sqrt(number)` | number | The square root of the number. | `sqrt(area)` |
| `clamp(number, low, high)` | number | The number held between a low and a high bound. | `clamp(discount, 0, 100)` |
| `number(text)` | number | The text read as a number, or nothing when it does not read as one. | `number(amountText)` |

### Lists

| Call | Gives | What it does | Example |
|---|---|---|---|
| `selected(value)` | list | The chosen options as a list: a group's ticked boxes, a list as is, one answer alone. | `selected(interests)` |
| `first(list)` | any | The first item of the list. | `first(selected(languages))` |
| `last(list)` | any | The last item of the list. | `last(items)` |
| `distinct(list)` | list | The list without repeated items, first occurrences kept in order. | `distinct(pluck(items, "category"))` |
| `sort(list)` | list | The list in ascending order, numbers by value and texts by code unit. | `sort(scores)` |
| `reverse(list)` | list | The list in the opposite order. | `reverse(sort(scores))` |
| `append(list, item)` | list | The list with the item added at the end. | `append(selected(languages), "en")` |
| `pluck(rows, key)` | list | One column of a repeating section's rows, as a list. | `sum(pluck(items, "amount"))` |
| `any(list)` | boolean | True when at least one item of the list is true. | `any(pluck(items, "taxable"))` |
| `all(list)` | boolean | True when every item of the list is true. | `all(pluck(items, "confirmed"))` |

### Dates

| Call | Gives | What it does | Example |
|---|---|---|---|
| `today()` | date | The host's calendar day, YYYY-MM-DD; nothing when the host supplies none. | `dateDiff(startDate, today(), "days")` |
| `date(text)` | date | The text as a calendar day when it is one written YYYY-MM-DD. | `date("2026-01-31")` |
| `dateAdd(date, amount, unit)` | date | The day moved by an amount of days, weeks, months or years; month ends clamp. | `dateAdd(startDate, 30, "days")` |
| `dateDiff(from, to, unit)` | number | The signed whole count of days, weeks, months or years from one day to another. | `dateDiff(startDate, endDate, "days")` |
| `year(date)` | number | The year of the day. | `year(startDate)` |
| `month(date)` | number | The month of the day, 1 to 12. | `month(startDate)` |
| `day(date)` | number | The day of the month, 1 to 31. | `day(startDate)` |
| `dayOfWeek(date)` | number | The weekday as a number, 1 for Monday to 7 for Sunday. | `dayOfWeek(startDate)` |
| `startOfMonth(date)` | date | The first day of the day's month. | `startOfMonth(today())` |
| `endOfMonth(date)` | date | The last day of the day's month. | `endOfMonth(today())` |
| `isWeekend(date)` | boolean | True when the day is a Saturday or a Sunday. | `isWeekend(startDate)` |
| `age(dateOfBirth)` | number | Whole years from the date of birth to the host's day; nothing without a day. | `age(dateOfBirth) >= 18` |

### Repeating rows

| Call | Gives | What it does | Example |
|---|---|---|---|
| `rowIndex()` | number | The 1-based position of the current entry in its repeating section. | `rowIndex() = 1` |
| `rowCount()` | number | How many entries the current repeating section holds. | `rowIndex() = rowCount()` |

Details a table row cannot hold:

- A text function reads at most the first 10,000 characters of a text, and a result over 10,000 characters is cut. A list function handed more than 10,000 items gives no result. Either case is reported with a warning that names the function. `len` counts the whole text.
- Positions and lengths count code points, so an emoji is one character. `substring` and `indexOf` count from 1; a start below 1 starts at the beginning. `substring` with a length of 0 or less gives an empty text.
- `replace` and `split` use the text as it is, never as a regular expression. `matches` takes a regular expression, anchored to the whole text, at most 256 characters. A pattern that does not compile has no result. See [Risky patterns](#risky-patterns).
- `padStart` pads up to `length`; `fill` defaults to a space; a text already as long is left alone.
- `contains` and `indexOf` also work on lists. `contains` gives no answer for a needle that is not text, number or yes-or-no.
- `sum` ignores empty items and adds the rest.
  - A present item that is not a number makes the sum no answer.
  - `sum` of nothing is 0.
  - `min`, `max` and `avg` skip empty items the same way and have no answer when nothing is left.
- Rounding and roots:
  - `round` rounds halves up (`round(2.5)` is 3, `round(-2.5)` is -2).
  - `roundTo` rounds halves away from zero at `scale` decimal places.
  - `roundUp` rounds away from zero and `roundDown` towards zero, at `scale` places (default 0).
  - `modulo` keeps the dividend's sign (`modulo(-7, 3)` is -1) and has no answer for a zero divisor.
  - `sqrt` of a negative number, and `clamp` with `low` above `high`, have no answer.
  - `number` reads text only.
- `sort` orders a list of all numbers or all texts, and has no answer for a mixed list.
- `pluck(rows, key)` skips rows that lack the key.
- `any` and `all` count only the yes-or-no `true` as true.
- `distinct` keeps first occurrences.
- `count(x)` and `selected(x)` read a checkbox group as its ticked options.
- Date functions:
  - `dateAdd` units are `"days"`, `"weeks"`, `"months"` and `"years"`; a month end clamps (31 January plus one month is the last day of February).
  - `dateDiff` gives a whole signed count, truncated towards zero for weeks, and complete months or years for those units.
  - `dayOfWeek` is 1 for Monday to 7 for Sunday.
  - `date(text)` reads the first ten characters.
  - A date outside years 1 to 9999 has no result.

## The clock

`today()` is the one call that reads the clock. It gives the host's calendar day as `YYYY-MM-DD`, with no time of day and no time zone, and `age(dateOfBirth)` is whole years from that day.

- **Browser.** It reads the local date once per recalculation, so every rule in one pass sees the same day.
- **Server.** It uses the day its host supplies as `today` in the run, so a host that checks a form with `today()` or `age()` in it sends its own day.
- **No day given.** A rule that reads the clock on a server given no day is not replayed there.

## Values from the host

A `host.` name reads a fact about the visit, not an answer: the person's role, the site's region. Any rule can read one, in a grid row or anywhere else. The page supplies the values as the form's `hostContext`, a plain object. Nested objects are read by dotted name, so `host.user.role` reads `{ user: { role: "admin" } }`.

```js
form.hostContext = { role: "admin", region: "QC" };
// visibleWhen: host.role = "admin"
```

- In the builder, preview these values in Try it's Settings under Host values.
- Changing `hostContext` updates the form at once and keeps what was typed.
- A name the object does not hold has no value, as a missing answer has none.
- The values are for display. They are not sent with a submission, and a server must never trust the page's.
- A server judges these rules with values it works out itself, passed as `hostContext` in the run (see [Validation](/validation)).
- A server that passes none leaves every rule that reads `host.` unjudged: the field keeps its own settings, and a calculation keeps the value sent.

On Spring Boot, a `HostContextProvider` bean supplies these values (see [the host context](/spring-boot#the-host-context)).

On FastAPI, the `host_context` keyword of `Datum` supplies them (see [the host context](/fastapi#the-host-context)).

## Where a rule runs

A rule can be written as `{ "formula": "...", "run": "..." }`. The values of `run` are:

- **`both`** is the default.
- **`browser`** is applied in the page only.
- **`server`** is applied on the server only.
- **`server-secret`** is applied on the server only and left out of the definition served to a browser, so a threshold stays private.

A host that serves definitions to browsers removes those rules with `publicDefinition`.

## A formula that cannot be read

A formula with a misspelt function, a missing bracket or a call to a function the running side lacks is a mistake in the formula. The `formula-errors` attribute on `<datum-form>` sets what happens:

| Value | Effect |
|---|---|
| `fail` (default) | The form does not open, a submission is refused and the problem is named. |
| `warn` | A warning is logged and the form opens. Every rule that cannot be read is dropped, with one exception: a `validWhen` that cannot be read is kept as a check that never passes, so it refuses every non-empty answer to its field. |

- The form's own Form settings panel carries the same choice, stored as `formulaErrors` on the root's `configuration`, and the host's attribute wins over it.
- A server run takes it from the run's `formulaErrors` key, else the form's.
- A problem that stops a server run is reported as `formula.invalid`.
- The builder's previews run under `warn`, so a formula in the middle of typing never closes the builder.

## Risky patterns

A regular expression can take exponential time on some text, as `(a+)+$` does. A literal pattern in `matches(text, "...")`, and a field's `pattern`, are checked when they are written, and one with that shape is refused, with the formula judged by `formula-errors`.

- `risky-patterns="allow"` on `<datum-form>` lets them through (`refuse` is the default).
- A server run takes the same two values as its `riskyPatterns` key.
- The code is `pattern.risky`.
- The default should stay `refuse` on a server.

## In the builder

The **Logic** workspace lists every rule in the form.

- **New rule** offers show, hide, require, validate, enable, read-only, calculate, start at a value, a data grid's minimum and maximum rows, filter a field's options and hold a step.
- Each rule is a formula with autocomplete and snippets, shows the fields it reads, and warns about problems without blocking Save.
- The **Variables** panel on the strip lists the field paths and functions a formula may use, and a click copies one.
- A "Formula reference" link beside them appears only when the host sets `formulaReferenceHref` on the builder to a page of its own; with none set, no link is drawn.
- A rule can be tried against sample answers before it is saved, and a test can pin its behaviour (see [Testing a form](/testing)).

## Calculations

A `value` rule gives the field a result the person does not type. The server's sandbox works the result out itself. Calculations that read each other in a loop (`a` reads `b` reads `a`) cannot settle: the browser refuses to open such a form, and a server run refuses the submission with `formula.invalid`.

## Your own functions

A plugin adds a function with `formulaFunctions`. See [Plugins](/plugins#formula-functions) for the registration.

```js
formulaFunctions: [{
  name: "taxFor",
  params: ["amount", "province"],
  returns: "number",
  summary: "The sales tax on an amount in a province.",
  example: "taxFor(subtotal, province)",
  evaluate: ([amount, province]) => (typeof amount === "number" ? amount * (province === "ON" ? 0.13 : 0.05) : undefined)
}]
```

| Member | Meaning |
|---|---|
| `name` | Letters, digits and underscores. A built-in's name, another plugin's, `__proto__`, `constructor` and `prototype` are refused. |
| `params` | Parameter names; one ending in `?` is optional. `variadic: true` repeats the last. `min` sets the fewest arguments. A call with the wrong number of arguments is a formula problem. |
| `returns` | `number`, `text`, `boolean`, `list` or `date`; for the builder's hints. |
| `summary`, `example`, `snippets` | What the builder's autocomplete and Variables panel show. |
| `evaluate` | Receives the evaluated arguments as a list and returns a plain value. |

A function is pure and takes its arguments only: no closure over host state, no I/O, no clock, no randomness.

- If it needs host data, take it as an argument (`taxFor(subtotal, host.region)`).
- `undefined` means no result.
- A function that throws, or returns something that is not plain data (a number that is not finite, a promise, a function, a `Date`), gives no result with a warning that names it.

For the server and the PDF program the function must also exist in the sandbox. The plugin's `wasmPlugin.source` module has a reserved key `functions`, beside `validators`:

```js
export default {
  functions: {
    taxFor: ([amount, province]) => (typeof amount === "number" ? amount * (province === "ON" ? 0.13 : 0.05) : undefined)
  }
};
```

A side that lacks the function reads a call to it as no result, so a `validWhen` using it fails and a `when` using it never holds. Test that the two copies agree.
