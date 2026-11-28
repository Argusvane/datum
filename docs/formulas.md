# Formulas

A **formula** is a rule written as text in a small subset of DMN FEEL, the decision-table
expression language. It says when a field shows, when it is required, how a total is worked
out, or which PDF layout prints. `age(dateOfBirth) >= 18` is a formula. The same text is read by
the browser, by the server sandbox and by the PDF program, so they reach the same verdict.

The decisions are in ADR 0139 (the language, storage, policy and clock) and ADR 0140 (the
formula builder). This page is the reference: what you can write, what is stored, and what each
side does with it.

- [Where a formula is used](#where-a-formula-is-used)
- [Fields and paths](#fields-and-paths)
- [Values and operators](#values-and-operators)
- [Conditions](#conditions)
- [if, then, else](#if-then-else)
- [Functions](#functions)
- [The day: today() and age()](#the-day-today-and-age)
- [Where a rule runs](#where-a-rule-runs)
- [Mistakes in a formula: the formulaErrors policy](#mistakes-in-a-formula-the-formulaerrors-policy)
- [Regular expressions: the riskyPatterns policy](#regular-expressions-the-riskypatterns-policy)
- [Adding your own functions](#adding-your-own-functions)
- [The formula editor in the builder](#the-formula-editor-in-the-builder)
- [For hosts: publicDefinition and inspect](#for-hosts-publicdefinition-and-inspect)
- [What is stored](#what-is-stored)
- [Differences from DMN FEEL](#differences-from-dmn-feel)
- [Error messages](#error-messages)

## Where a formula is used

A formula (or any of the other two stored shapes, see [What is stored](#what-is-stored)) may
stand wherever the engine accepts a rule:

| Place | Key | Meaning |
|---|---|---|
| A component's `rules` | `visibleWhen` | Hidden unless the formula is `true` (see [Conditions](#conditions)). Absent means visible. |
| | `requiredWhen` | Required while the formula is true, on top of the field's own Required (ADR 0120). |
| | `validWhen` | A check on the answer: a non-empty answer is refused with the code `rule` unless the formula is true (ADR 0120, see [Validate rules](#validate-rules)). |
| | `enabledWhen` | Disabled unless the formula is `true`. |
| | `readonlyWhen` | Read-only when true. |
| | `value` | A calculation: the field holds the result. No result means no answer. |
| | `defaultValue` | Used while the field has no value. Browser only. |
| | `filter` | An option or collection filter. Browser only. |
| | `navigationGating` | Gates moving into or out of a step. Browser only. |
| A data grid's `rules` | `minRows`, `maxRows` | The fewest and most rows the grid holds, as a number (ADR 0153, see [Data grids](#data-grids)). Read over the whole form, never a row. |
| A journey page or route | `when` | Whether the page is visited, which route is taken (ADR 0112). |
| A journey's worked-out value | `configuration.value` | A value the journey sets. |
| A PDF layout | `when` | The layout that prints for these answers (ADR 0044). |
| A PDF field or area | `{ "kind": "expression", "expression": ... }` | The value that fills it. |

A rule key that is not one of the eleven above is copied as written, so an annotation or a
host's own key survives.

### Required when rules

A component's `rules.requiredWhen` **adds** to its Required tick (ADR 0120): the component is
required when the tick is set **or** the rule holds. The rule never lowers the tick, and the
required marker follows the same reading, so a ticked field keeps its asterisk while its rule is
false. The browser, the server sandbox and every server hold the field to it.

- **Where it is read.** On a component that holds an answer of its own, outside a repeating
  section, over the answers as they would be submitted: an answer that is hidden and excluded, or
  on a page the journey's path skips and excludes, reads as absent, a calculation that came out
  `NaN` reads as `null` (as JSON carries it), and a hand-written `rules: null` or
  `requiredWhen: null` is no rule. The result is then subject to the field's
  `hiddenRequiredBehavior`, as the tick is.
- **Where it is not read.** On a form root, a group, a repeating section or data grid, a button,
  static HTML, an image or a signature (their value is always empty, so the rule would refuse
  every submission), and on any component inside a repeating section or data grid, where only the
  tick is held, per entry. The server cannot tell a plugin's display component from a field, so a
  rule there is enforced; the builder's Rules tab offers "Required when" only to a node the
  engine reads it on, and shows a rule already on any other node under a note that it is never
  enforced (a rule reading `host.` under one saying only the browser checks it).
- **What a server cannot replay.** A rule that reads `host.` when the run carries no host
  context, reads the clock when the run has no day, or runs `browser` is not enforced by the
  server, so the server is never stricter than the browser. For the same reason a field whose own
  or inherited `visibleWhen` the server cannot replay is not demanded
  (`hiddenRequiredBehavior: "required"` on the node keeps it demanded). Write the rule
  `run: "server"` or `"server-secret"` to opt out of that for one rule.
- **JSON Schema export.** A field the rule alone requires gets the sentence "Required when a rule
  of the form says so"; a ticked field is listed under `required`.
- **The sandbox's run log** lists, at debug level (`requiredByRule`), the components a rule, not
  the tick, made required.

### Validate rules

A **Validate rule** checks an answer against the others: "the end date is on or after the
start date", "the shares add up to 100", "the confirmation matches the email". It is the field's
`rules.validWhen`, a formula that is **true when the answer is acceptable**, and its words are the
field's own message for the code `rule` (ADR 0120):

```json
{
  "id": "end_date",
  "type": "date",
  "configuration": { "label": "End date", "messages": { "rule": "The end date is on or after the start date." } },
  "rules": { "validWhen": "end_date >= start_date" }
}
```

- **What is checked.** A field whose answer is not empty, after its other checks (required, the
  answer's kind, bounds, file limits, length, pattern): one error per field, and `rule` comes
  last. An empty answer is never checked; make the field required (or `requiredWhen`) when it
  must be answered. `component` reads the field's own answer, so `string length(component) >= 3`
  works without naming the field.
- **Where it is read.** As `requiredWhen` is: on a field holding an answer of its own, outside a
  repeating section, over the answers as they would be submitted. A field that is not validated
  because it is hidden is not refused for it. The browser and the server sandbox work it out with
  the same fold, so they refuse the same answers.
- **The message.** The page's wording for `rule` where the page gives one, else the field's
  `messages.rule` (a localised text, translated like any message), else a container's or the
  form's, else "Check this answer". The Logic workspace's
  New rule > *Validate* writes both the formula and the message, in one undo step.
- **Where it runs.** `run` works as for any rule: a `server` check is the server's alone, a
  `browser` one the browser's. A check reading `host.`, or `today()` on a server given no day,
  holds on the server, which cannot replay it.
- **It fails closed.** Under `formulaErrors: "fail"` a check that does not parse refuses the form,
  as any rule does. Under `warn` it is **not** dropped like other rules: it refuses every
  non-empty answer, since a check that cannot say yes says no. A check that comes to anything but
  `true` (no answer, a function that threw) refuses too.
- **One per field.** Join two checks with `and`. A field inside a repeating section, a journey's
  own nodes, and several messages for one field are not covered: use a plugin validator. A
  `validWhen` on a field inside a repeating section is reported at compile as the warning
  `rule.unsupportedScope`; it never refuses a run.

## Fields and paths

A bare name reads a field's answer by its id or data key: `quantity`, `address.city`.
Components in a repeating section (a data grid's rows are one, ADR 0153) are read through scope prefixes:

| Prefix | Reads |
|---|---|
| `row.amount` | A sibling in the same entry of the repeating section. Not read in a grid's `rules.minRows` / `rules.maxRows`: the bound belongs to the whole grid, so a `row.` read there is the warning `rule.unsupportedScope`. |
| `ancestor.total` | A field outside the current section, from inside it. |
| `host.region` | A value the host page supplies, not an answer (`host.` reads are never replayed on a server that was not given them). |
| `component` (or `component.x`) | The component being evaluated. |

A component id is letters, digits, `_` and `-`, starting with a letter, so an id never holds a
backtick or a space. The grammar has no escape inside backticks and trims the name, so a name
with a backtick or edge spaces cannot be written.

A name that is not a plain identifier goes in **backticks**: `` `first name` ``,
`` `2nd-choice` ``. A backticked name is never a keyword or a function.

**The hyphen rule.** A hyphen between two name characters belongs to the name: `first-name` is
one field. To subtract, put spaces around the minus: `price - discount`. `price-discount` is
read as a field with that name, and the builder warns when it finds no such field and suggests
adding spaces.

## Values and operators

| Value | Written |
|---|---|
| Number | `42`, `3.5`, `-2`; a literal past the double range (`1e999`) is the error `numberTooLarge` |
| Text | `"hello"` or `'hello'`; a backslash escapes the next character (`"say \"hi\""`); `\n`, `\t` and `\r` are a new line, a tab and a carriage return, and no other letter is an escape: `\uXXXX` is not supported (`"\u0041"` is the text `u0041`), and the editor warns about a backslash before another letter |
| Yes or no | `true`, `false` |
| Nothing | `null` |
| A calendar day | `@"2026-01-31"` (the same as `date("2026-01-31")`) |

Keywords (`if`, `then`, `else`, `and`, `or`, `not`, `in`, `between`, `true`, `false`, `null`) are
lower case. Use straight quotes: a typographic quote is an error.

### Precedence

Loosest first. Operators on one line bind equally and group left to right.

| Level | Operators |
|---|---|
| 1 | `if ... then ... else ...` |
| 2 | `or` |
| 3 | `and` |
| 4 | `=` `==` `!=` `<` `<=` `>` `>=`, `between ... and ...`, `in (...)`, `in` an interval |
| 5 | `+` `-` |
| 6 | `*` `/` |
| 7 | unary minus |
| 8 | numbers, text, names, calls, `( ... )` |

`=` and `==` are the same test. Comparisons do not chain: write `a < b and b < c`, not
`a < b < c`. `not(x)` is the canonical negation; a prefix `not` is accepted and takes one whole
comparison, so `not a = b` means `not(a = b)`. As in DMN FEEL, `+`, `-`, `*` and `/` over an
operand that is not a number (an empty answer, a text, a yes-or-no) have no result (a text that is
a decimal numeral, `"12"` or `"1e3"`, reads as that number: see Numbers), as does
dividing by zero; a calculation with no result stores no answer, never `NaN`. An empty answer
and `null` are the same nothing under `=` and `!=`, so `ratio != null` means the ratio is known.

### between, in and intervals

- `age between 18 and 65` means `age >= 18 and age <= 65`.
- `province in ("ON", "QC", "BC")` means one of those values. A single value `x in ("ON")` is `x = "ON"`.
- An interval is a range with open or closed ends: `age in [18..65]` (both ends in),
  `age in (18..65]` (18 out), `age in [18..65)` (65 out), and `]a..b[` is the French spelling
  of both ends out. Intervals work for numbers and for days: `startDate in [@"2026-01-01"..@"2026-12-31"]`.

A range whose literal bounds cannot hold (`[10..1]`, `between 10 and 1`) or whose bounds are of
different kinds (`[1.."z"]`) is never true; the editor warns. Write an interval with exactly two
dots: `[1...2]` is the error `intervalDots`, not a range.

Numbers are binary floating point, as in every spreadsheet: `0.1 + 0.2` is `0.30000000000000004`
and `0.1 + 0.2 = 0.3` is false, and an integer past 9007199254740991 loses its last digits. Round
a calculation before comparing it for equality, `roundTo(price * 1.13, 2) = total`; the editor
warns about `=` between a calculation and a decimal literal.

### Ordering: numbers, days and text

`<`, `<=`, `>` and `>=` order numbers, days and texts, and never a mix of kinds:

- Two numbers order as numbers. A text that is a decimal numeral against a number reads as that
  number (`"10" > 9` is true).
- Two **texts** order by UTF-16 code unit, the same for every text (ADR 0139):
  `"abc" <= "abc"`, `"b" > "a"` and `name > "M"` are true for `"Zed"`. That orders two calendar
  days written `YYYY-MM-DD` as days, since the digits are padded, and it orders any other text
  the way a dictionary of code units does: every capital before every lower-case letter
  (`"Z" < "a"`), an accented letter after `z`. A text that is not a day (`"2026-1-5"`, the
  invalid `"2026-02-30"`) is simply a text, so it orders against `"2026-01-05"` by its characters.
  The one exception: when BOTH texts are decimal numerals (see Numbers), they order as numbers,
  so `"10" > "9"` is true while `"10a" < "9a"` is true by code unit.
- A text that is not a numeral against a number, a yes-or-no, a list, or an answer that is
  missing never orders: every one of the four is false. So `not (u < 1)` holds for a missing `u`;
  write `u != null and u >= 1` when the answer must be there.
- `=` and `!=` are strict equality (`"1" = 1` is false), apart from the missing answer and `null`
  being the same nothing.

## Conditions

A **condition** is a formula used where the engine needs a yes or no: the five `rules` keys
`visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen` and `navigationGating`, a journey
page or route `when`, a PDF layout `when`, and the tests inside `if`, `and`, `or` and `not`. A
condition **holds only for the yes-or-no `true`** (ADR 0139; the truthiness is
strict, there is no JavaScript "truthy"). Everything else does not hold, and reads as false:

| The formula comes to | Holds? |
|---|---|
| `true` | yes |
| `false`, no answer (a missing answer, `null`, `x + 1` over an empty `x`) | no |
| a number (`1` and `0` alike), a text (`"yes"` and `"false"` alike) | no |
| a list (an empty one too), an object, a choice group with nothing ticked | no |

So `visibleWhen: "yes"` hides the field, `requiredWhen: items` never requires it and
`not "false"` is `true`. `and`, `or` and `not` read each operand the same way and always give
`true` or `false`: `1 and 2` is false, `"x" or 0` is false. Compare instead of passing a bare
value: `email != null`, `len(items) > 0`, `not(empty(items))`, `status = "paid"`. A bare field is
still fine for a yes-or-no checkbox (`visibleWhen: agreed`: `true` holds, `false` and unticked
do not).

The compile warns about a condition that provably never holds because it is no yes-or-no: a
number, text or `null` literal, arithmetic, a function that returns a number, text, list or day
(`len(a)`, `upper(a)`, `today()`), or an `if` with such a branch. The warning is
`condition.notBoolean` (severity `warning`, in `CompiledDefinition.warnings`; it never refuses a
run, whatever `formulaErrors` says), and the formula editor underlines the whole text of a
condition box. A bare field, `coalesce`, `first`, `last` and a plugin function cannot be judged
from the formula alone and get no warning. A runtime reports each warning once, the check op
returns them in `warnings` (see "For hosts").

## if, then, else

```
if age < 18 then "minor"
else if age < 65 then "adult"
else "senior"
```

The cases are tried in order and the first that holds wins. `else if` can repeat. `else` is
optional, which is a deliberate difference from FEEL (see below): with no case holding and no
`else`, the result is **no answer**. For each use that means:

| Used as | No case holds and no `else` |
|---|---|
| A condition (`visibleWhen`, `when`) | Does not hold: hidden, not taken, not chosen. |
| `requiredWhen`, `readonlyWhen` | Not required, not read-only. |
| `enabledWhen` | Disabled. |
| `value` | The field comes to no answer. |
| `defaultValue` | No default is set. |

Write an `else` whenever you want a definite answer: `if a then "x" else ""`.

## Functions

Names are camelCase because a formula has no names with spaces. Where DMN FEEL spells a
function differently, the last column gives it (`startsWith` is FEEL's `starts with`); the
FEEL spelling is not accepted in a formula. Giving an unknown function, or the wrong number of
arguments, is a mistake in the formula (see the policy below). A function given a value it
cannot work with, such as `upper` of a number that is missing, has no result; it never throws.
Square brackets in a signature mark an optional argument, and `...` a last argument that can
repeat.

A `sum`, `min`, `max` or `avg` over a list reads the list's items, so
`sum(pluck(items, "amount"))` adds a repeating section's column.

### Logic

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `coalesce(value, ...)` | any | The first argument that is not null or missing. | `coalesce(nickname, firstName, "there")` |  |
| `empty(value)` | boolean | True when the value is missing, blank, an empty list or a group with nothing ticked. Blank covers `null`, a blank text, an empty object and a number that is not finite. `false` and `0` are not empty. | `empty(email)` |  |
| `isNumber(value)` | boolean | True when the value is a number or a text that reads as one. | `isNumber(quantity)` |  |
| `isDate(value)` | boolean | True when the value is a calendar day written YYYY-MM-DD. | `isDate(startDate)` |  |

### Text

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `concat(value, ...)` | text | Joins the arguments into one text; missing values add nothing. A list or a group among them gives no result. | `concat(firstName, " ", lastName)` |  |
| `len(value)` | number | The number of characters in a text or items in a list. Characters are code points; no result for a missing value. | `len(postcode)` | `string length` |
| `upper(text)` | text | The text in upper case. No result for a missing value, a list or a group. | `upper(postcode)` | `upper case` |
| `lower(text)` | text | The text in lower case. No result for a missing value, a list or a group. | `lower(email)` | `lower case` |
| `titleCase(text)` | text | The text with the first letter of each word in upper case. | `titleCase(city)` |  |
| `trim(text)` | text | The text without spaces at either end. | `trim(reference)` |  |
| `startsWith(text, prefix)` | boolean | True when the text begins with the prefix. | `startsWith(postcode, "K1")` | `starts with` |
| `endsWith(text, suffix)` | boolean | True when the text ends with the suffix. | `endsWith(email, ".ca")` | `ends with` |
| `contains(haystack, needle)` | boolean | True when the text contains the needle, or the list holds it as an item. No result when the needle is missing or a group, or the haystack is neither a text nor a list. | `contains(languages, "fr")` |  |
| `substring(text, start, [length])` | text | The part of the text from a 1-based position, optionally limited to a length. Counted in characters (code points). | `substring(sin, 1, 3)` |  |
| `indexOf(haystack, needle)` | number | The 1-based position of the needle in the text or list, or 0 when absent. In a text it counts characters. | `indexOf(email, "@")` |  |
| `replace(text, find, with)` | text | The text with every occurrence of one piece replaced by another. | `replace(phone, "-", "")` |  |
| `split(text, separator)` | list | The text cut at each separator, as a list. | `split(tags, ",")` |  |
| `join(list, separator)` | text | The list's items as one text with the separator between them. | `join(selected(languages), ", ")` | `string join` |
| `matches(text, pattern)` | boolean | True when the whole text matches the regular expression. No result when the pattern is not a valid expression. A literal pattern that repeats a repeat is refused at compile ([riskyPatterns](#regular-expressions-the-riskypatterns-policy)). | `matches(postcode, "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d")` (a backslash is written twice in a formula text: `\\d` reaches the pattern as `\d`) |  |
| `text(value)` | text | The value written as text. | `text(total)` | `string` |
| `padStart(text, length, fill)` | text | The text padded at the start with the fill up to the length. | `padStart(text(invoiceNumber), 6, "0")` |  |

A text function reads a text, a finite number or a yes-or-no; a missing answer, a list or a group
has no result (so `upper` of an empty field is nothing, not `""`, and `contains("undefined", x)`
never tests the word for a missing `x`). Positions and lengths count characters as a person does
(an emoji is one), and a function never cuts one in two.

**Size caps.** A function reads at most the first 10,000 characters of a text, and a text it builds
is cut to its first 10,000. Every function that reads a whole text (`titleCase`, `trim`, `startsWith`,
`endsWith`, `substring`, `indexOf`, `replace`, `split`, `matches`, `text`, `padStart`, `upper`, `lower`
and `contains`) works on the head of a longer text and says so with one `text.truncated` warning; a
text built by `concat`, `join` or `replace` past the cap is cut the same way, and `padStart` stops
there. So `trim(a)` of an essay of 12,000 characters is the trimmed first 10,000, never "no result",
and `matches(a, ...)` judges those first 10,000 only. `len` and `empty` read the whole text (use
`empty(a)`, or `len(a) > 0`, to test whether an answer is blank, not a capped function), and a
`validWhen` rule that depends on the end of a text longer than 10,000 characters cannot see it.
`matches` still gives no result for a pattern over 256 characters. Hitting a cap is never silent: one
warning names the function and the cap (the browser's console, the sandbox's run log). The sandbox program carries the same caps.

**List cap (`MAX_FORMULA_LIST_ITEMS`, 10,000).** A list function (`sum`, `min`, `max`, `avg`,
`count`, `contains`, `indexOf`, `first`, `last`, `distinct`, `sort`, `reverse`, `append`,
`pluck`, `any`, `all`, `join`) handed a list of more than 10,000 items gives no result, and
`split` gives none when it would make more. One warning names the function and the cap, the
same way as the text cap. The cap counts the tree a result expands to (every item at any depth,
each copy of a shared list counted), so `append(prev, prev)` chains give no result at the link that
crosses it.

**Sandbox time budget.** The QuickJS sandbox stops a run that takes too long (`maxEvalMs`).
Unless the host sets `maxEvalMs`, the budget is 250 ms plus 5 ms for each path the rules read
(the `reads` of the `inspect` op, added over every rule), at most 5,000 ms, worked out once
per definition. A host that sets `maxEvalMs` gets exactly that.

The budget does not grow with the cells of a data grid: it counts the paths the rules read, not
rows times columns, so a form with a large grid (many rows, many columns, rules that read
`row.` fields) can need more than the formula allows. A host that validates such forms sets
`maxEvalMs` to what the biggest grid it accepts needs, measured on its own hardware, and keeps
`killSlackMs` as it is. A grid that declares no `maxRows` holds at most 500 rows, so 500 rows
of the widest grid is the worst case to measure.

### Numbers

A text is read as a number only when it is a decimal numeral: an optional sign, digits with an
optional fraction (or a fraction alone, `.5`), and an optional exponent (`12`, `-3.5`, `.5`,
`1e3`). That is the same wherever a number is read from text: `+ - * /`, the orderings,
`number()`, `isNumber()`, `sum` and the other functions. A reference code such as `0x10`,
`0b11` or `1_000`, and the words `Infinity` and `NaN`, are text, not numbers. The result of a
calculation is never a negative zero, and `modulo` is truncated: the remainder takes the
dividend's sign (`modulo(-7, 3)` is `-1`). `roundTo`, `roundUp` and `roundDown` work at any
magnitude (`roundTo(0.0000001, 2)` is `0`). A number function given a missing or non-numeric
input has no result, never `NaN`, and a `sum`, `avg` or `power` whose result is past the double
range (an overflow) has no result, never `Infinity`. `sum`, `min`,
`max` and `avg` leave an empty argument or item out, so `sum(m1, m2, m3)` is the total of the
months answered so far; an argument that is there but is not a number makes the whole result
nothing. To add two required numbers write `a + b`, which has no result until both are answered.

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `sum(value, ...)` | number | Adds the arguments; a list argument adds its items. | `sum(price, tax)` |  |
| `min(value, ...)` | number | The smallest of the arguments; a list argument contributes its items. | `min(quote1, quote2)` |  |
| `max(value, ...)` | number | The largest of the arguments; a list argument contributes its items. | `max(quote1, quote2)` |  |
| `avg(value, ...)` | number | The mean of the arguments; a list argument contributes its items. | `avg(pluck(scores, "mark"))` | `mean` |
| `count(value)` | number | How many items are selected: a list's length or the ticked boxes of a group. | `count(interests)` |  |
| `abs(number)` | number | The number without its sign. | `abs(balance)` |  |
| `round(number)` | number | The number rounded to the nearest whole number. | `round(total)` |  |
| `roundTo(number, scale)` | number | The number rounded to a count of decimal places. | `roundTo(total, 2)` | `decimal` |
| `roundUp(number, [scale])` | number | The number rounded away from zero, optionally at a count of decimal places. | `roundUp(hours)` | `round up` |
| `roundDown(number, [scale])` | number | The number rounded towards zero, optionally at a count of decimal places. | `roundDown(hours)` | `round down` |
| `floor(number)` | number | The largest whole number not above the number. | `floor(ratio)` |  |
| `ceil(number)` | number | The smallest whole number not below the number. | `ceil(ratio)` | `ceiling` |
| `modulo(number, divisor)` | number | The remainder after dividing by the divisor. | `modulo(seats, 4)` |  |
| `power(base, exponent)` | number | The base raised to the exponent. | `power(1 + rate, years)` |  |
| `sqrt(number)` | number | The square root of the number. | `sqrt(area)` |  |
| `clamp(number, low, high)` | number | The number held between a low and a high bound. | `clamp(discount, 0, 100)` |  |
| `number(text)` | number | The text read as a number, or nothing when it does not read as one. | `number(amountText)` |  |

### Lists

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `selected(value)` | list | The chosen options as a list: a group's ticked boxes, a list as is, one answer alone. The ticked boxes come in the order stored; one answer alone is a non-empty text; anything else gives an empty list. | `selected(interests)` |  |
| `first(list)` | any | The first item of the list. | `first(selected(languages))` |  |
| `last(list)` | any | The last item of the list. | `last(items)` |  |
| `distinct(list)` | list | The list without repeated items, first occurrences kept in order. Numbers and texts are the same when equal; records and lists only when they are the very same one. | `distinct(pluck(items, "category"))` | `distinct values` |
| `sort(list)` | list | The list in ascending order, numbers by value and texts by code unit. | `sort(scores)` |  |
| `reverse(list)` | list | The list in the opposite order. | `reverse(sort(scores))` |  |
| `append(list, item)` | list | The list with the item added at the end. | `append(selected(languages), "en")` |  |
| `pluck(rows, key)` | list | One column of a repeating section's rows, as a list. | `sum(pluck(items, "amount"))` |  |
| `any(list)` | boolean | True when at least one item of the list is true. | `any(pluck(items, "taxable"))` |  |
| `all(list)` | boolean | True when every item of the list is true. | `all(pluck(items, "confirmed"))` |  |

Edge cases of the list functions:

- `sort` orders a list of numbers by value or a list of texts by code unit; a list that mixes
  kinds, or holds yes-or-no values, nothing, lists or objects, has no order and gives no result.
- `pluck(rows, key)` skips rows that lack the key, so its positions need not line up with the
  rows; a row holding `null` there contributes `null`. A key that is not text gives no result.
- `any` and `all` count only the value `true`: `any([1, "true"])` is false. `all` over an empty
  list is true and `any` over an empty list is false; over a missing list both have no result.
- `append(list, item)` adds to the end; a missing list reads as an empty one, but `null` is not
  a list and gives no result.

### Dates

A literal unit other than `"days"`, `"weeks"`, `"months"` or `"years"` in `dateAdd` or `dateDiff`
(`"day"`, `"DAYS"`) is the error `badUnit`; a unit read from a field that is not one of them gives
no result.

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `today()` | date | The host's calendar day, YYYY-MM-DD; nothing when the host supplies none. | `dateDiff(startDate, today(), "days")` |  |
| `date(text)` | date | The text as a calendar day when it is one written YYYY-MM-DD. | `date("2026-01-31")` |  |
| `dateAdd(date, amount, unit)` | date | The day moved by an amount of days, weeks, months or years; month ends clamp. No result when the amount is not a finite number or the day would fall outside the years 1 to 9999. | `dateAdd(startDate, 30, "days")` |  |
| `dateDiff(from, to, unit)` | number | The signed whole count of days, weeks, months or years from one day to another. A month end that `dateAdd` clamped counts as a whole month. | `dateDiff(startDate, endDate, "days")` |  |
| `year(date)` | number | The year of the day. | `year(startDate)` |  |
| `month(date)` | number | The month of the day, 1 to 12. | `month(startDate)` |  |
| `day(date)` | number | The day of the month, 1 to 31. | `day(startDate)` |  |
| `dayOfWeek(date)` | number | The weekday as a number, 1 for Monday to 7 for Sunday. | `dayOfWeek(startDate)` | `day of week` |
| `startOfMonth(date)` | date | The first day of the day's month. | `startOfMonth(today())` |  |
| `endOfMonth(date)` | date | The last day of the day's month. | `endOfMonth(today())` |  |
| `isWeekend(date)` | boolean | True when the day is a Saturday or a Sunday. | `isWeekend(startDate)` |  |
| `age(dateOfBirth)` | number | Whole years from the date of birth to the host's day; nothing without a day. Nothing either for a date of birth after that day. | `age(dateOfBirth) >= 18` |  |

**Month ends.** `dateAdd` clamps to the last day of a shorter month: 31 January plus a month is
29 February in a leap year, 28 otherwise. `dateDiff` counts the same way, so
`dateDiff(a, dateAdd(a, n, unit), unit)` is `n`, and the answer for `(a, b)` is minus the answer
for `(b, a)`. A month is whole when the later day reaches the earlier day's number, or is the last
day of its month while the earlier number is past it. **A birthday on 29 February** is therefore
reached on 28 February in a year that is not a leap year (`age` of someone born `2000-02-29` is 1
on `2001-02-28`), not on 1 March. A count that reaches past the years 1 to 9999 is no date.

### Repeating sections

A repeating section is any container with a `collection` binding, a data grid being the one the
builder offers (`docs/data-model.md`, "Repeating sections").

| Function | Returns | Does | Example | FEEL spelling |
|---|---|---|---|---|
| `rowIndex()` | number | The 1-based position of the current entry in its repeating section. | `rowIndex() = 1` |  |
| `rowCount()` | number | How many entries the current repeating section holds. | `rowIndex() = rowCount()` |  |

`not` is the one logical function that is not in the table: it is written `not(x)` or, in front of
one comparison, `not x`. A repeating section's rows are read with `pluck(items, "amount")`; the
section itself reads as nothing in a PDF layout condition (see `docs/pdf-rendering.md`).

A calculation over a repeating section's rows is never reproduced on the server: it is kept as
the browser sent it and listed in the outcome's `clientDerived`.

A calculation on a field inside a repeating section or a data grid is worked out for each entry,
in the browser as on the server (ADR 0153, ADR 0142): `row.` reads that entry, `rowIndex()` is the
entry's 1-based position among the entries that hold an answer, and `rowCount()` is how many
there are. The browser writes the result into the entry before the entry is sent, so a line
total such as `row.qty * row.price` is the same on both sides.

### Data grids

A data grid's row count may follow a formula (ADR 0153). `rules.minRows` and `rules.maxRows` are
rule sources like `requiredWhen`, with a `run` scope as any rule has, evaluated over the whole
form to a number: `{ "maxRows": "if hasPartner then 6 else 3" }`. A finite whole number from 0 up
wins over the grid's fixed `configuration.minRows` / `maxRows` (one past 500 reads as 500);
anything else, a text, a fraction, a negative number or a formula that does not parse, leaves the
fixed bound in force. The browser's Add and Remove buttons and the `rows.min` / `rows.max` codes
read the same resolved bound, so the buttons and the server agree. A formula
that reads `row.` is reported as `rule.unsupportedScope`.

## The day: today() and age()

`today()` is the host's calendar day as `YYYY-MM-DD`. `age(dateOfBirth)` is
`dateDiff(dateOfBirth, today(), "years")`. There is no time of day and no time zone: a formula
sees a day, and the host decides which day it is.

- **Browser.** The day is `FormRuntime`'s `today` dependency (a string or a function), else the
  local calendar date from `localCalendarDate` (never `toISOString`, which is UTC). It is read
  once per recompute, so every rule in one pass sees the same day. The renderer always sends the
  day it used to the sandbox at submit.
- **Server.** The sandbox context's `today` wins; the submissions package supplies its own
  day (`deps.today`, else the server's local date). A `today` that is not a valid day is warned
  about and treated as absent. With none, a rule that reads the clock is treated like a rule that
  reads `host.`: not replayed, `requiredWhen` not enforced, a calculation kept as sent.
- **PDF.** A layout's `when` and a field's expression read the day the call supplies
  (`PdfDocumentInputs.today`), else the runtime's, else the local date. A server that renders a
  PDF for a submission should send the day it validated the submission under.
- The outcome lists the components, and the journey pages, whose rules read the clock as
  `clockDependent`, so a host can tell a verdict that depends on the day from one that does not.
  The journey diagnostics warn of a rule or condition that reads the clock (`rule.reads-clock`,
  `condition.reads-clock`), and a journey condition that reads the clock when a server is given
  no day is refused (`journey.clockDependent`).

The browser and the server can disagree for the minutes around midnight, when one has crossed
into the next day and the other has not. A form that must not allow that should keep the day it
decided on and send it back. `now()` and time zones are not provided.

## Where a rule runs

The object form of a rule says which side applies it. `run` is one of:

| `run` | Browser | Server (the sandbox) |
|---|---|---|
| `both` (default) | applies it | applies it |
| `browser` | applies it | skips it as it skips a `host.` rule: the state is kept as configured, `requiredWhen` is not enforced, a calculation is kept as sent and listed in `clientDerived` |
| `server` | ignores it, as if the rule were absent | applies it: a hidden answer is dropped by the hidden-value policy, a failed `requiredWhen` is an error, a `value` overwrites the answer (`recalculated`) |
| `server-secret` | ignores it, and the rule is **absent from the definition served to a browser** | as `server` |

```json
{ "rules": { "requiredWhen": { "formula": "income > 100000", "run": "server-secret" } } }
```

Only `visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`, `validWhen`, `value` and a grid's
`minRows` / `maxRows` can take a server scope. `defaultValue`, `filter` and `navigationGating` are browser-side by nature, and journey
nodes, journey `when`s and PDF layouts and fields are applied by the side that owns them, so
`run` there may only be `both` or `browser`. A `run` a place may not take is reported as a
`runScope` problem and the rule runs on both sides.

What a run says of a `server-secret` rule: `formula.invalid`, the matching run-log lines and a
plugin function's thrown message carry the rule's `where` and a fixed sentence, never its text, an unknown
function's name or a pattern; `check` redacts the same way. A rule that is not secret is named in full.

A `server` or `server-secret` rule is the author opting out of the rule that a server is never
stricter than the browser (ADR 0120), for that rule only. The outcome's `serverRules` lists the
components whose server-only rules were applied, so a host can say "the server requires X" for
a field the browser never marked. A server-only rule that reads `host.` or the clock the server
was not given can never run; the diagnostics report it as `rule.server-cannot-run` (an error for
`host.`, a warning for the clock alone).

The journey diagnostics (`diagnoseJourneys`) name the other combinations that cannot work as intended:
`rule.reads-host` (a `both` rule reading `host.`, which a server given no host context cannot
replay), `rule.browser-only-required` (a `requiredWhen` that runs `browser`, which the server does
not enforce), `rule.browser-only-visibility` (a required field behind a browser-only
`visibleWhen`) and `rule.secret-reads-browser-hidden` (a `server-secret` rule reading a field a
browser-only rule may hide, so the server reads the answer the browser kept or dropped).
`rule.reads-host` and `rule.secret-reads-browser-hidden` come from the per-journey pass, so only for
a form that has a journey. A form with no readable journey gets the form-level pass
(`diagnoseFormRules`), which reports `rule.browser-only-required` and `rule.browser-only-visibility`.

A visibility the server cannot replay (it reads `host.`, runs `browser`, or reads a clock with no
day) does not make the server demand the field: its requiredness is dropped, the node stays
visible for the other checks, and the outcome's `visibilitySkipped` lists it (ADR 0142). A
calculation whose optional, never-hidden input is missing is worked out over the empty answer, and
a forged sent value is replaced (`recalculated`); only an input that may have been withheld keeps
the value as sent. A `value` rule on a field inside a repeating section runs for each entry, with
`row.` reading that entry, `rowIndex()` and `rowCount()`.

**The fold's results ride in the outcome when asked.** A host that sets the
context key `reportFold` gets `withheld` (the delivered keys the form defines that the judged
values leave out, in the delivered order; present, possibly empty, whenever the fold ran),
`effectiveState` (the fold's state of each component whose errors the hidden policy can drop: not
validated, or requiredness not applying; a component not listed passes every error),
`submittable` (the judged values of a run that blocked, which has no `values`) and `trace` (a
journey's path). The submissions service uses them and runs no second partition or fold.
Without `reportFold` the outcome carries none of these keys.

**A server rule calling a function the server lacks is refused.** Under `warn` and `fail` the
submission is refused with `formula.invalid` (`parameters.function`). Scope such a rule
`run: "browser"`, or wire the function on the server.

**On the PDF side** a layout `when` and a field source run in the PDF program only, whatever
the form's rules do; they cannot be secret.

A PDF the browser prints (ADR 0035) cannot show a `server-secret` calculation, because the browser
never receives the rule; the PDF the server renders does show it.

## Mistakes in a formula: the formulaErrors policy

A formula that does not parse (a misspelt function, a missing parenthesis), a call to a function
the side that runs the rule does not have, or a rule that throws while it is evaluated is a
**mistake in the formula**. The default, on every side, is to **refuse** (ADR 0139): a form with
a mistake does not open, a submission is not accepted, a PDF is not made, and the problem is
named. The setting that changes this is `formulaErrors`:

| Policy | What happens |
|---|---|
| `fail` (the default) | The definition or the submission is refused, with the problem named. The browser throws `FormulaError` (with the form id and the problems); `<datum-form>` then draws a notice (`data-form-error`, `role="alert"`) with one line per problem, removes it when a later definition loads, and still fires `datum-error`. The sandbox answers with one error `formula.invalid` per problem (stage `definition`, source `wasm`, no component) and runs no fold, constraints or validators; the submissions service refuses to register the form (`invalid_definition`, HTTP 422); the PDF program and the engine's PDF service raise `formula_invalid`. A clean compile logs nothing. |
| `warn` | An explicit opt-in for authoring, preview and staging. The rule is absent. A warning is logged (a `console.warn` per problem in the browser, a `warn` log line in the sandbox) and, in the browser, `FORMULA_INVALID` is published with the problems; the PDF reports the warning `formula.invalid`. One problem still refuses: a rule the **server** runs that calls a function the server does not have. And a `validWhen` that does not parse is not absent: it refuses every non-empty answer (ADR 0120). |

Any other value is no policy word: the engine reads the next place in the list below that names
one, else the default. The renderer's `formula-errors` attribute refuses such a value, and a server
host configured with one refuses to start. The builder offers `fail` and `warn`, `fail` first; a stored word it does not know shows as `fail`.

Where it is set, strongest first:

1. The host: `FormRuntime`'s `formulaErrors` dependency (and `SubmitOptions.formulaErrors` for one
   submission), the renderer's `formula-errors`
   attribute, `WasmSubmissionContext.formulaErrors`, `PdfDocumentInputs.formulaErrors`, the
   submissions package's `settings.validation.formulaErrors`.
2. The form: `root.configuration.formulaErrors`, set in the builder's Form settings panel.
3. The default, `fail`.

The builder's own previews (the canvas, the journey preview, Try it's runtime, the PDF
designer's preview and the builder element's sample runtime) run under `warn`, so a formula the author is still typing never closes the
builder. What the server would do under `fail` is what the per-side report says.

## Regular expressions: the riskyPatterns policy

A regular expression can take exponential time on some text (`(a+)+$` against a long run of `a`
followed by `!`). A pattern with that shape is **refused**. The
check is static and runs where the pattern is written, not when it runs: `kernelRegexRisky`
(`core/expressions/compile.ts`) flags a pattern from its text alone, without running it.

The pattern is parsed (groups, branches, quantifiers, classes) and every group repeated without
bound, or eight or more times, is read. It is flagged when

- an element inside it is repeated without bound and its characters can also start what follows it,
  the next turn of the loop included, so the text can be cut between the repeats in many ways:
  `(x+)+`, `(x*)*`, `(x+)*`, `(\w+\s?)+`, `((ab)+)+`, `(x|y+)+`, `(.*a){16}`, at any depth. A
  delimiter the repeat cannot take clears it: `(\d+\.)+`, `(\.[a-z]+)*`,
  `^([a-z0-9-]+\.){1,10}[a-z]{2,}$`, `^(\w+ ){0,9}\w+$` and `^(\d+,){8}\d+$` are not flagged;
- its body can match nothing and has more than one way to: `(a|a?)+`, `(a|b|)*`, `(a?b?)*`, also
  behind groups (`((a)|(a?))+`);
- two of its branches can take the same text, in the group or in a group inside it: `(a|a)+`,
  `(a|aa)+`, `(\d|\d\d)+`, `[a-c]|[b-d]`. Branches that cannot (`(a|b)+`, `(ab|ac)+`,
  `(foo|bar)+`) are not flagged; a quantified or grouped pair of branches that can start alike
  counts as overlapping.

The reading goes further:

- a repeat whose count varies counts like `+` (`{1,3}`, `{0,2}`, `{2,}`, and a `?` beside something the
  branch must match): `(a{1,2})+`, `(\w{1,10}\s?)+`, `([ab]a?)+` are flagged; `{3}` is not;
- three or more unbounded repeats in one sequence that overlap (`a*a*a*b`, `.*a.*a.*a`, `\d+\d+\d+`,
  each counts when it can start what follows or follows a counted one it overlaps) are flagged
  (polynomial of degree three); two, such as `.+@.+\.com`, are not;
- `(?i:...)`, `(?-s:...)` modifier groups are read as plain groups;
- `\p{L}`, `\p{Lu}`, `\p{Ll}`, `\p{N}`, `\p{Nd}`, `\p{P}`, `\p{Z}` (and `\P`, and the long names) are sets,
  so `^\p{L}+(?:[ '-]\p{L}+)*$` passes; any other `\p{...}` stands for anything;
- a pattern the reader cannot follow but the engine accepts counts as risky;
- a pattern over 2,000 characters counts as risky (and is refused at Save, `component.pattern.tooLong`).

More cases:

- a character is read whole, so `(😀+)+` and `(\ud83d\ude00*)*` are flagged like `(a+)+`;
- a group repeated 3 to 7 times is flagged when it holds a repeat without bound that can cut the text:
  `(a+){7}`, `(.*a){7}`, `(\w+\s?){1,7}`, `(a*){5}b`; `(\d{1,3}\.){3}\d{1,3}`, `(\d+,){2,5}\d+` and
  `(a+){2}` are not;
- a last unbounded repeat before the end counts in the chain once two before it do and it can take what
  the element before it takes: `^\S+@\S+\.\S+$` and `.+@.+\..+` are flagged (cubic on text that fails
  at the end); the email forms with classes that exclude `@` and space (`[^\s@]+@[^\s@]+\.[^\s@]+`, the
  preset's) are not.

A back-reference with a repeat (`\1+`, `\1{2,}`, `\k<name>*`) is flagged anywhere. Groups nested more
than 32 deep, and a pattern that takes more than 3,000 steps to read (about 50 ms in the sandbox: a
sixty-way alternation of classes under a repeat reaches it), count as risky. A source that
is not a valid pattern is not flagged (its own compile refuses it).

| Where | What happens to a risky pattern |
|---|---|
| A literal pattern in `matches(text, "...")` | The formula is refused at compile with the problem code `pattern.risky` (`params.pattern`, span on the word `matches`), judged by `formulaErrors` exactly like a formula that does not parse: refused under `fail`, the rule dropped and a warning logged under `warn`. Browser, sandbox and PDF program share the check. A rule written as a tree rather than text is not looked at by a form's or a journey's compile (a PDF's is: a tree-written layout `when`, mapping or area expression, and a layout block's expression and rules are reported too), and a pattern read from a field (`matches(a, b)`) is not a literal and is not looked at at compile. Every PDF expression runs under a cache that refuses a risky pattern at the call, whatever wrote it. |
| A pattern built at run time (`matches(t, concat(...))`, a pattern read from a field) | The sandbox's kernel checks the pattern when `matches` is called: one of the shapes above gives no result and one warning (`matches: the pattern repeats a repeat and can take very long`), unless the host allows risky patterns. The browser leaves it to its own time. |
| A field's `configuration.pattern` | A definition problem like a pattern that does not compile: the browser's stage and the sandbox skip it; the sandbox logs `pattern is risky` and, under `formulaErrors: "fail"`, refuses a non-empty answer (`pattern`, `parameters.invalid: true` and `parameters.risky: true`). |
| The builder | The formula editor underlines the pattern with the same message; the inspector's Pattern box shows the problem under it. Neither blocks Save. |

A host that has a reason can allow them with `riskyPatterns: "allow"` (default `"refuse"`): the
`FormRuntime` dependency, the `<datum-form>` `risky-patterns` attribute, `WasmSubmissionContext.riskyPatterns`,
`PdfDocumentInputs.riskyPatterns`, the submissions package's `settings.validation.riskyPatterns`
and the `riskyPatterns` of the `check` request.

**Time.** With `allow`, a pattern that does blow up is bounded only by the sandbox's `maxEvalMs`. The
interrupt that ends it is uncatchable inside QuickJS and the host sees only that the deadline passed
(`QuickJsExecutionError` `interrupted`), not which function was running, so it stays a **run
failure** (the run is rejected and nothing is judged), not a rule failure. The browser cannot
interrupt a running expression at all. This is why `refuse` is the default.

**A rule that throws.** A plugin function that throws while a rule is evaluated reads as
`undefined` under every policy, and under `fail` (the default) it is also a refusal: a blocking
`formula.invalid` (stage `definition`, `parameters.where` names the rule, `parameters.message`
the cause), in the browser (source `client`) and in the sandbox, which then runs no plugin
validator. Under `warn` a `formula function threw` line is logged and the verdict is unchanged.
(ADR 0142.)

**A function the server lacks.** A rule the server runs (`run` is `both`, `server` or
`server-secret`) that calls a function the server does not have refuses the submission under
every policy word, `warn` included: the browser, which has the function, would enforce a rule the
server read as absent. A rule scoped `run: "browser"` follows the policy. (ADR 0142.)

The builder always shows the problems whatever the policy, and never disables Save for one
(ADR 0111).

**Calculations that never settle.** Calculations that feed one another in a loop (`a = a + 1`,
or `p` reading `q` reading `p`) cannot hold one value. The browser refuses to open such a form
(`Calculation rule cycle detected: a -> b -> a`). The sandbox, when its recompute does not settle,
refuses the submission with the blocking error `formula.invalid` (stage `definition`,
`parameters.where` the first calculation, `parameters.message` "the calculations do not settle:
a -> b -> a") under every policy word, and runs no validator; it does not keep the last pass's
value with a warning. (ADR 0139, decision 15.)

## Adding your own functions

A plugin adds a function with `FormPlugin.formulaFunctions`:

```ts
const plugin: FormPlugin = {
  id: "acme-tax",
  version: "1.0.0",
  formulaFunctions: [
    {
      name: "taxFor",
      params: ["amount", "province"],
      returns: "number",
      summary: "The sales tax on an amount in a province.",
      example: 'taxFor(subtotal, province)',
      evaluate: ([amount, province]) =>
        typeof amount === "number" ? amount * (province === "ON" ? 0.13 : 0.05) : undefined,
      snippets: [{ label: "Sales tax", insert: "taxFor(subtotal, province)" }]
    }
  ]
};
```

A parameter name ending in `?` is optional, `variadic: true` makes the one listed parameter
repeat, and `min` gives the fewest arguments accepted when that differs from the count of
required parameters. A function's `summary`, `example` and `snippets` feed the builder's hints and
snippet toolbar.

The rules for a function are the rules for a validator in the sandbox (ADR 0001, ADR 0029): it
is **pure and takes its arguments only**. No closure over host state, no I/O, no `Date`, no
randomness. If it needs host data, take that as an argument (`taxFor(subtotal, host.region)`),
so what a rule reads stays visible to the analysis. It receives the evaluated arguments and
returns a plain value; `undefined` means no result. A function that throws gives `undefined` and
a warning. So does a result that is not plain data: a number that is not finite (`NaN`,
`Infinity`), a promise, a function, a `Date` or any other class instance. Each reads as no answer
with one warning that names the function (the browser's console, the sandbox's run log); a text,
a finite number, a yes-or-no, `null`, and lists and plain objects of those pass through. A name that collides with a built-in, or with another plugin's, is refused when the
plugins are wired.

For the server and the PDF program the function must also exist in the sandbox. The plugin's
`wasmPlugin.source` module has a reserved key `functions` beside `validators`:

```js
export default {
  functions: {
    taxFor: ([amount, province]) =>
      typeof amount === "number" ? amount * (province === "ON" ? 0.13 : 0.05) : undefined
  }
};
```

The PDF program's `__datum_pdf_register` accepts the same key, and
the in-process host takes it as `WasmPlugin.functions`; a function-backed plugin's sandbox source
is derived from its `evaluate`. The sandbox module declares no arity of its own: the parser's
signatures come from the built-ins and the contributions. A
program that does not have a function evaluates a call to it as no result, and a `when` that
calls it never holds. The parser is told the declared names and arity, so a mistyped call to a
custom function is a problem under the policy on both sides.

**Prove the two sides agree.** `formulaFunctionParity(contribution, vectors, runSandbox)` in
`validation/parity/formula-function-parity.ts` runs each `{ args, expected }` vector through
`evaluate` and through the sandbox you supply, and reports every vector where either result
differs from the expected one. Run it in your plugin's tests, as validators are parity-tested.
`formulaFunctionParity` is exported from the engine's parity index
(`validation/parity/index.ts`).

The builder's autocomplete, signature hints, Variables panel and snippet toolbar list a wired
plugin's functions beside the built-ins. In the builder, Try it evaluates plugin functions when
the host wires them (the shell's `formulaFunctions` or the `plugins` of `<datum-form-builder>`).
In the shipped packages/datum bundles a plugin registers through `plugins.register`
(`packages/datum/src/plugins.ts`) and must carry its sandbox source with the
`functions` key, for the server-side check.

The builder's index exports the pieces a host can reuse: `printFormula`, `renameInRuleSource`,
`formulaFieldsOf`, `mountFormulaTextarea`, `FORMULA_SNIPPETS` and the editor loader
(`loadFormulaEditor`, with the editor options as types only). The editor module itself stays a
lazy chunk.

## The formula editor in the builder

One editor takes a rule everywhere the builder does: the Logic workspace, the inspector's Logic tab,
and a journey route's or a PDF layout's `when` in their designers (ADR 0140). It reads as a
sentence rather than code.

- **Chips.** A field reference is a chip: the label is shown and the id is stored, so a rename or a
  reworded label never changes what a rule means. Backspace removes a chip whole. A name the form
  does not store is not a chip but a mark, so a misspelt field can be corrected a letter at a time,
  with a "Did you mean ...?" fix. A tree-stored rule opens printed as a formula with ids.
- **Layout.** A calculation is multiline: each `then` and `else` case on its own indented line,
  Enter after `then` or `else` starting the next. A condition is one line and Enter commits.
- **Helpers.** Under the box: `+ Field` (the form's data-holding fields in document order, with
  their kinds and options), `ƒ Function` (the built-ins grouped logic, text, number, list, date and
  scope, then the wired plugins', each with its signature) and `Helpers`: snippets grouped Answers
  (`isAnswered`, `isEmpty`, `anyOf`, `between`), Choices (`allTicked`, `anyTicked`, `noneTicked`,
  `atLeastTicked`), Dates (`withinDays`, `beforeDate`, `ageAtLeast`, `weekend`) and Cases
  (`ifThenElse`, `cases`), with a plugin's own `snippets` under Plugins. A helper inserts at the
  caret with each blank selected in turn and Tab moving through them. A "Formula reference" link
  shows only when the host sets `formulaReferenceHref`.
- **Suggestions while typing.** Fields first (the label and the id, matched on either), then
  functions with their argument names, then keywords. After a choice field and `=`, `!=` or
  `in (` come its options. The scoped paths (`row.`, `ancestor.`, `host.`, `component`) are
  offered when the host allows them.
- **Problems.** A formula that does not parse is underlined at its span with the message under the
  box, worded from the builder's catalog; a path that names nothing the form stores gets its own
  mark. A problem never disables Apply or Save (ADR 0111). A call to a function neither the table
  nor the wired plugins know is refused when it is applied (`unknownFunction`).
- **Reads as.** The rule in the sentence the rule list uses, or the printed formula with field
  chips when a sentence cannot word it; cases read "250 when ...; 180 when ...; otherwise 120".
- **Runs.** For every rule key that may take a server scope, the editor head offers Browser and
  server, Browser only, Server only and Server only, secret, each with a one-line consequence.
  `defaultValue`, `filter` and `navigationGating` show a fixed Browser chip, and a journey or PDF
  `when` shows none, since their sides are fixed. The rule list marks a server-only rule and a
  secret one with a lock chip, and says that a browser-printed PDF leaves a secret field blank.
- **Try it.** Sample answers give the verdict per side ("on both sides", "server only", "browser
  only"); a value rule also shows the computed value, and a date box appears when the formula reads
  the clock. An empty box offers three "try one" chips built from the form's own fields. Wired
  plugin functions are evaluated there too.
- **Apply.** The text is written as a bare string, or `{ formula, run }` when the scope is not
  `both` (a browser-only key is always a bare string). A rule key is written only when its text or
  run changed or the rule is new, so an untouched rule stays byte for byte as it was and a tree
  rule stays a tree. The inspector's Logic tab shows each rule as an Off / Formula switch with a
  compact box, and "Open in Logic" for the form's own rules.
- **Renaming a field** rewrites every rule that reads the old id (components, a journey route's
  `when`, worked-out values, and a PDF layout's `when` and field or area expressions) in one undo
  step, keeping the author's formatting. A formula that does not parse but spells the old id is
  left as written and reported beside the rule that holds it. A PDF layout's `component` and `path`
  bindings follow the rename too (ADR 0044).
- **Elsewhere in the builder.** Form settings has a Formulas section that sets `formulaErrors`
  (Fail, the default, or Warn; choosing Fail over a form that sets nothing writes nothing). The
  Variables panel lists the functions by group with signatures, and copies a call with blanks or a
  field's name.
- **Without the editor.** A plain text box with the same problems stands in until the editor loads,
  and stays, with a "failed, retry" line, if the editor cannot be loaded.

## For hosts: publicDefinition and inspect

A host that serves a definition to a browser must remove its `server-secret` rules first.

- In JavaScript, `publicDefinition(definition)` returns a copy with those rules removed (the
  field stays; only the rule goes). The renderer's `definition` setter does not strip: it cannot
  know whether it was handed the server's copy, so stripping is the serving host's job. The
  builder never strips. The submissions package exposes `publicDefinition` on its service and
  `inspect(key, op)` beside it, and serves the public copy at `GET /api/forms/:key/definition`.
- A host that cannot call JavaScript (the Java, .NET and Python hosts)
  calls the sandbox program's second entry point, `globalThis.__datum_inspect(request)`, with
  the request as JSON and reads canonical JSON back. `WasmValidationHost.inspect()` is the
  in-process form. The program's `__datum_inspect` is beside `__datum_register` and `__datum_run`.

The request is `{ abi, op, definition, formulaErrors? }`. `abi` is the sandbox ABI the host
speaks and must be accepted by the program. There are three ops:

```jsonc
// op: "public" -> the definition without its server-secret rules
{ "ok": true, "op": "public", "definition": { /* ... */ } }

// op: "check" -> what compiling would report, the policy, and what a runtime would do
{ "ok": true, "op": "check",
  "problems": [{ "where": "rules:age:visibleWhen", "code": "unknownFunction",
                 "message": "Unknown function \"agee\".", "start": 0, "end": 4, "text": "agee(dob) > 17" }],
  "warnings": [{ "where": "rules:age:visibleWhen", "code": "condition.notBoolean", "severity": "warning",
                 "message": "..." }],
  "policy": "fail", "verdict": "fail" }

// op: "inspect" -> a static inventory
{ "ok": true, "op": "inspect",
  "rules": [{ "componentId": "tax", "key": "value", "run": "both", "reads": ["subtotal", "province"],
              "readsHost": false, "readsClock": false, "functions": ["taxFor"] }],
  "functionsUsed": ["taxFor"], "pluginsNeeded": ["taxFor"],
  "paths": [{ "path": "subtotal", "componentId": "subtotal", "type": "number", "holdsData": true }] }
```

`warnings` lists the findings that never refuse a run, such as a condition that is provably no
yes-or-no (`condition.notBoolean`) or a rule no side evaluates (`rule.unsupportedScope`); it is empty when there are none, secret rules are
redacted as in `problems`, and it never changes `verdict`. A runtime says the same thing once per warning: the
browser's `FormRuntime` writes a console warning at construction, and the sandbox program writes a
`warn` log line (`formula warning: <where>: <message>`) in every run.

`verdict` is `ok` (no problems), `warn` (problems, definition kept) or `fail` (problems under
`fail`, definition refused). `pluginsNeeded` lists the functions used that no built-in provides:
what a plugin must contribute before the definition evaluates. A request of no usable shape, or
an ABI the program does not accept, answers `{ "ok": false, "error": { "code": "invalid_request" | "abi_mismatch", "message": "..." } }`.

For a stored definition, compute the public copy when it is saved and keep it beside the
definition (keyed by the definition's hash), rather than on every page view.

### Remembering a prepared definition between runs

A run compiles the definition it is handed (every formula to a tree) and builds a few indexes
over the tree: the tree index, value paths, ids by path, the allowlist of key shapes, row
fields and lists, collection owners. None of that depends on the answers, so a host that judges
the same form again and again can keep it. The kernel keeps no state of its own; the host holds a
cache and passes it as the fifth argument of `runKernel(context, validators, functions,
signatures, cache)`, made by `kernelCreatePreparedCache(capacity, maxChars)`. The three hosts
that hold state do it for you:

- **In-process** (`InProcessWasmHostAdapter`): one cache per instance, the 16 most recently used
  definitions (`IN_PROCESS_PREPARED_DEFINITIONS`), at most 4,000,000 characters of key text.
- **QuickJS** (`@argusvane/datum-quickjs-wasm-host`, and every host that evaluates the sandbox program):
  the program keeps the cache in a variable private to its own closure (no global holds it, so
  rule code cannot reach or replace it), in the sandbox context the host already reuses across runs. It holds plain data the kernel built inside that context, never a
  host handle. Sixteen definitions, at most 2,000,000 characters of key text (a prepared
  definition is about seven times its key in memory), lowered to a sixteenth of the memory limit
  when the host sets a smaller one than the default 32 MiB. A host that creates a fresh process
  or context per run (the Node and Python process-per-run hosts) never hits, and pays
  one `JSON.stringify` of the form for it.
- **The submissions service** sends the sandbox the compiled copy it registered, the same text
  every time, so the sandbox's cache finds the definition it prepared for the first judgement.
  It passes no key and its callers see nothing new; `WasmValidationHost` exposes nothing new
  either.

The key is the formula-error word, the risky-pattern word, the parser's signatures (name and
argument counts, sorted by name), and the exact JSON text of the form, the journey and the PDF
layouts. Equal keys mean equal inputs to the compile, so a hit is the object a miss would have
built and the outcome is byte-identical: what the compile found (problems, warnings) is judged
and logged on every run, hit or not. The text is not re-sorted, so the same definition with its
members in another order is another entry (a miss, never a wrong answer), and a definition that
cannot be written as JSON text gets no key. The least recently used entry goes first, and a key
longer than the whole bound is not kept. A plugin validator is handed `context.form`, which a
prepared definition shares nodes with; the run that built the entry cuts it loose before the
validators run, so nothing a validator writes reaches a later run.

No request or outcome names the cache, and a program without it judges
the same bytes, only slower.

## What is stored

A rule may be stored in any of three shapes, and a runtime reads all three:

```jsonc
// 1. A formula string (what the builder writes)
"visibleWhen": "country = \"CA\" and age(dateOfBirth) >= 18"

// 2. The expression tree
"visibleWhen": { "kind": "binary", "operator": "eq",
                 "left": { "kind": "path", "path": "country" },
                 "right": { "kind": "literal", "value": "CA" } }

// 3. The object form, when the rule needs a run scope
"visibleWhen": { "formula": "country = \"CA\"", "run": "server" }
"visibleWhen": { "expression": { "kind": "path", "path": "wantsPaper" }, "run": "browser" }
```

A tree written as JSON is capped at 200 JSON levels (every record and list counts, the left side of a chain included); a deeper one is refused. A formula written as text is never cut by that cap: the tree it compiles to is only checked for shape.

Before anything reads a rule, each runtime compiles the definition into a copy in which every
string is a tree, and reads the copy. **The author's object is never changed**: a host that
hashes the stored JSON keeps the same hash, and the submissions validator passes its catalog's
definition straight to the kernel. The builder opens a tree-stored rule by printing it back as a
formula, and writes a formula only when you Apply a change; a rule you did not touch stays
byte for byte as it was. Printing and parsing are inverses: the formula you see reads back as the
same tree.

A rule value that is none of the three (a number, `{}`, `{ "run": "server" }` with neither
formula nor expression) is reported as `invalidRule`. Under `rules` the key is dropped; at a
`when` or a source the value stays as written for the shape checks to refuse. `null` is no rule,
and a blank formula text is no expression and no problem. Only the eleven `ComponentRules` keys compile (the nine in [Where a formula is used](#where-a-formula-is-used) and a data grid's `minRows` / `maxRows`); any other key under `rules` is copied as written.

**Where a problem is reported.** The compile lists its problems in document order. Each has a
`code`, a `message`, its `params` and, for a formula that does not parse, the span (0-based, end
exclusive) and the formula's `text`. Its `where` names the rule:

| `where` | The rule |
|---|---|
| `rules:<component id>:<key>` | A component's rule |
| `journey:<journey id>:page:<page id>:route:<n>` | A journey route's `when` (the route's position, from 0) |
| `journey:<journey id>:node:<node id>[:<key>]` | A journey's own node |
| `pdf:<layout id>` | A layout's `when` |
| `pdf:<layout id>:field:<i>`, `pdf:<layout id>:area:<i>` | A layout field's or area's expression |

## Differences from DMN FEEL

- **Camel-case names.** `startsWith`, not `starts with`; the table above gives the FEEL name.
- **`else` is optional.** FEEL requires it. Without one the result is no answer.
- **No names with spaces.** Use backticks for an odd field name.
- **Prefix `not`** takes one whole comparison; `not(x)` is canonical.
- **No chained comparisons**, no `for`, `some`, `every`, filters (`list[item > 1]`), contexts or
  functions you define, and no time of day, durations or time zones.
- **A day is a text** `YYYY-MM-DD`; `@"..."` is its literal. `dayOfWeek` is a number, 1 for
  Monday to 7 for Sunday, not a name.
- **Missing is not an error.** A function given a missing or wrong-typed value has no result
  instead of failing the whole decision.
- **Two texts order by code unit** under `<`, `<=`, `>` and `>=` (days included, since they are
  padded; two decimal numerals order as numbers); FEEL orders strings the same way. A text against a number reads the text as a number
  when it is a numeral, otherwise never orders.
- **A condition holds only for `true`.** FEEL's `if` takes the `else` for a condition that is not
  a boolean, which is the same; `and`, `or` and `not` differ, where FEEL gives no answer for a
  non-boolean operand and a formula gives `false` (and `true` for `not`), so a condition always
  has a yes or no.
- **Plugin functions** are pure and take arguments only.

## Error messages

A formula that does not parse yields one problem with a code, the span of text it concerns
(0-based, end exclusive) and a plain English message. The builder words each code from its own
catalog, with the span underlined.

| Code | Message (kernel log) |
|---|---|
| `unexpected` | `Unexpected "x".` |
| `expectedValue`, `expectedValueHere` | `Expected a value but found "x".` |
| `expectedOperator` | `Expected an operator but found "x".` (two values with nothing between them) |
| `unclosedParen` | `Expected ")" but found ...` / `Missing ")" before the end of the formula.` |
| `unmatchedParen` | `A ")" has no matching "(".` |
| `unterminatedString` | `A quoted text has no closing quote.` |
| `curlyQuote` | `A curly quote "..." is not a quote here; use straight quotes.` |
| `unterminatedName` | `A backticked name has no closing backtick.` |
| `emptyName` | `A backticked name is empty.` |
| `badChar` | `The character "x" is not part of a formula.` |
| `unknownFunction` | `Unknown function "name".` |
| `arity` | `name takes 2 arguments but was given 3.` / `name takes between 1 and 2 arguments but was given 3.` |
| `arityMin` | `name needs at least 1 argument but was given 0.` |
| `betweenAnd` | `Expected "and" after the lower bound of between ...` |
| `inList` | `Expected a list in brackets after "in" ...` |
| `intervalDots` | `Expected ".." between the bounds of a range ...` |
| `ifThen` | `Expected "then" after the condition ...` |
| `chainedCompare` | `Comparisons cannot be chained; join them with and.` |
| `numberTooLarge` | `The number "1e999" is too large to be a number.` |
| `badUnit` | `dateAdd takes "days", "weeks", "months" or "years" as its unit, not "day".` (a literal unit only; the span is the call) |
| `tooDeep` | `The formula nests more than N levels deep.` |

Two more problem codes come from the definition compile rather than the parser: `runScope` (a
`run` the place may not take; the rule runs on both sides) and `invalidRule` (a value that is
neither text, tree nor the object form).
