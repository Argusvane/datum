# Testing a form

A test is a short scenario in plain words, kept with the form: set some answers, press Continue or Submit, and expect a field shown or required, a page on the path, a submission refused with a given error, or an answer withheld. The same scenarios run in the builder as you edit, from the command line, and in a vitest suite, on the browser's runtime and on the server's kernel. The command and the vitest helper are the `@argusvane/datum-form-test` package, which publishes with the first release; until then, build it with `npm run build` in `packages/form-test`.

## In the builder

- The Tests panel on the strip lists the form's scenarios and runs them as you edit.
- A failure is shown on the form itself, step by step, so you see the field that was required when the scenario said it should not be.
- **Record** from Try it writes a scenario from what you just did.
- Every rule in the Logic workspace lists the tests that pin it, and a rule with none is called out.

## A live example

The example is a builder on a form that carries three scenarios.

1. Open the Tests panel on the strip (the checklist icon, under More on a narrow screen, or press the builder's Full window button first). The scenarios run on the browser's runtime as the panel opens, and again after every edit.
2. Open a scenario to change it, or change the form in the canvas and watch which scenarios notice.
3. Switch Scenarios to "A fourth that fails" to load the same form with one more scenario, which expects a field to be required that is not. Its row is marked failed, with the line and what the form did instead (the form was accepted, not refused).

The file under the example is the same three scenarios as a `.datum-test` sidecar, and the form is [intake-with-tests.json](/forms/intake-with-tests.json){target="_blank"}.

<LiveExample name="tests" />

The page can only run them in the builder. The sandbox side and the two-sided comparison need the command or a host, below.

## A scenario

A scenario sets answers, presses Continue, Check or Submit, and says what must then be true.

```
test "a partnership needs a registered agent"
  given today = @"2026-03-01"
  set business_structure = "Partnership"
  expect registered_agent visible
  expect registered_agent required
  submit
  expect refused
  expect error on registered_agent: required
  set registered_agent = "Jane Doe"
  submit
  expect accepted
  expect submitted registered_agent = "Jane Doe"
```

Every statement is listed with an example in [The form-test language](/form-test-language):

- the five givens
- the ten actions
- the expectations about a field, the whole form and a journey
- the ten states
- the problems the parser reports

Fields are named by value path, pages and journeys by id. The copy of a definition a browser is served carries none of its tests.

## Where tests live

Scenarios can be kept in three places, and a run reads all that exist, in this order:

1. **The definition's own `tests`.** The builder writes them there, one entry per scenario, as `{ "id": "…", "source": "test \"…\"\n…" }` under `tests.scenarios`.
2. **A sidecar file** beside the definition: the definition's path with its extension replaced by `.datum-test`. `forms/intake.json` reads `forms/intake.datum-test`, and a definition with no extension gets `.datum-test` added. The file is plain text, one scenario per block, so it diffs and reviews like any other file in the repository. A missing sidecar is not an error.
3. **Files named with `--tests`**, after the sidecar.

All the sources of one form share one set of names: a scenario name that an earlier source already used is reported as a `duplicateName` problem on the later one.

## Installing the command

`datum-form-test` and the vitest helper are in the `@argusvane/datum-form-test` package, which publishes with the first release. Once it is published, `npm install --save-dev @argusvane/datum-form-test` is all it takes. Until then, build it once from a checkout, then install the tarball in the project that holds the forms:

```
cd packages/form-test
npm ci
npm run build        # bundles dist/cli.mjs, dist/index.mjs and dist/vitest.mjs, for Node 22
npm pack             # writes a tarball
```

```
cd ../my-project
npm install ../datum/packages/form-test/argusvane-datum-form-test-0.1.0.tgz
npx --package @argusvane/datum-form-test datum-form-test --version
```

`npm ci` in a pipeline then brings the command in from `package-lock.json`, as long as the tarball is where the lock file says it is.

## The command

```
datum-form-test <definition.json>… [options]
```

Each definition is read with its own tests, then its sidecar, then any `--tests` files. Every input is read before anything runs, so a missing file stops the run with exit code 2 and no half-written report.

| Option | Takes | Default | Does |
|---|---|---|---|
| `--tests <file>` | A `.datum-test` file. Repeats. | none | Adds more scenarios for the one definition given. Naming the sidecar again is harmless. |
| `--runner` | `runtime`, `kernel` or `both` | `both` | Which side plays each scenario. With `both`, a scenario the two sides judge differently is a parity finding. |
| `--program <file>` | A built sandbox program | the in-process kernel | The sandbox program the kernel side runs on, so the suite checks exactly what your host will run. |
| `--report` | `json`, `junit` or `md`. Repeats, or comma-separated. | `md` | Which reports to produce. A format named twice is made once. |
| `--out <dir>` | A folder | none | Writes the reports there and prints a line per scenario instead. The folder is made if it is missing. |
| `--coverage` | none | off | Lists every rule of the form with the scenarios that exercise it. |
| `--fail-on` | `failed` or `untested` | `failed` | With `untested`, a rule that no scenario exercises also fails the run. It switches `--coverage` on. |
| `--help`, `-h` | none | | Prints the usage and exits 0. |
| `--version` | none | | Prints the name and version and exits 0. |

Every option takes its value as `--option value` or `--option=value`. A value is never a following option: `--out --coverage` is a missing value.

These combinations are refused with exit code 2:

- `--tests` with anything but exactly one definition, because a test file names one form's fields.
- `--program` with `--runner runtime`, because the runtime side never loads a program and a broken one would pass unseen.
- No definition at all, an unknown option, a value outside the listed ones, and a definition that is not JSON or has no `root` component.

### Reports

Without `--out`, each report you asked for prints to the standard output, in the order given. With `--out`, the reports are written as files and the command prints one line per scenario, the totals, and the files it wrote.

| Format | File under `--out` | Holds |
|---|---|---|
| `md` | `form-tests.md` | A table per form (a row per scenario, a column per side), the details of everything that did not pass, the parse problems of each source, and the coverage table with untested rules first. For a pull request or a job summary. |
| `junit` | `form-tests.xml` | One test suite per form and one test case per scenario. A failed scenario and a parity difference are failures (the type says which), an error is an error, a skipped one is skipped, and a source that does not parse is one more test case in an error, so a broken file cannot pass by having no scenarios. |
| `json` | `form-tests.json` | Everything: the tool and its version, the start time, the runner, the program's path, size and SHA-256, each form's sources, scenarios with each side's result, parity lines and coverage, the summary and the verdict. |

A scenario report in Markdown looks like this, with most of the passing rows cut:

```
# Datum form tests: failed

Runner both | Program in-process kernel | Started 2026-11-15T23:51:37.899Z | 251 ms | Fail on failed

20 scenarios: 19 passed, 1 failed, 0 parity, 0 error, 0 skipped. 0 sources with problems.

## fixtures/main.json

_Form tests fixture_

| Scenario | Runtime | Kernel | Result |
|---|---|---|---|
| the age bounds and the calculation | passed | passed | PASS |
| a server-only check is not the browser's to judge | skipped (unreplayable.server) | passed | PASS |
| a deliberate failure: the name is not optional | failed | failed | FAIL |

### Details

#### a deliberate failure: the name is not optional

**FAIL** (fixtures/failing.datum-test, line 1)

| Side | Line | Message | Expected | Actual |
|---|---|---|---|---|
| both | 2 | Expected "applicant\_name" to be optional, but it is required. | true | false |
```

### Exit codes

| Exit code | Meaning |
|---|---|
| 0 | Every scenario that ran passed, and at least one did. With `--fail-on untested`, every rule is tested too. |
| 1 | A scenario failed or ended in an error, the two sides disagreed (parity), a test file did not parse, or a rule is untested under `--fail-on untested`. |
| 2 | Usage or input error: a bad option, or a definition, test file or program that cannot be read. |
| 3 | Inconclusive: nothing failed, but no scenario passed, because none was found or every one was skipped. An empty run is never a pass. |
| 4 | The tool itself broke. |

### Parity

With `--runner both`, each scenario is played on the browser's runtime and on the server's kernel, and the results are compared line by line. A difference is a result of its own, reported as `PARITY` with a table of the lines and what each side did, never folded into a pass:

```
| Line | Runtime | Kernel |
|---|---|---|
| 14 | passed | failed expect.error (got ["pattern"]) |
```

It means the two sides disagree about what this form does with these answers, for example one accepts a person the other refuses.

- Run `--runner runtime` and `--runner kernel` to see each alone.
- The test is not what is wrong until both sides agree with what it says.

### Skipped steps

A side skips what it cannot replay, with the reason, and never fails it. A scenario passes when at least one side judged it and none failed it.

| Reason | Meaning |
|---|---|
| `unreplayable.host` | A rule reads a host value and the scenario has no `given host.`. The kernel side then has no host context, as on a server that supplies none. With a `given host.` both sides judge the rule. |
| `unreplayable.server` | A rule runs only on the server, so the browser's runtime does not judge it. |
| `unreplayable.secret` | A rule uses a server secret. |
| `unreplayable.browser` | A rule runs only in the browser, so the kernel does not apply it. |
| `unreplayable.clock` | A rule reads today's date and the scenario has no `given today`. |
| `unreplayable.clientDerived` | A calculation reads an answer the server was not sent. |

Two more cases skip:

- An expectation about the whole form (`expect accepted`, `expect no errors`, `expect submitted …`) skips too when a rule this side could not replay could have decided the result.
- A scenario with `skip "reason"` is skipped on both sides with the author's reason.

### Coverage

`--coverage` lists every rule of the form with the scenarios that exercise it, and counts the rules no scenario touches.

- The rules are the ones the Logic workspace lists for these kinds: show, hide, require, enable, read-only, validate, calculate, minimum and maximum rows, show and hide a step, route and PDF layout choice.
- A scenario exercises a rule only if it ran to passed, failed or parity: a skipped or errored scenario pins nothing.
- A rule is exercised by an expectation that reads what the rule decides, on its target:

| Rule | Exercised by |
|---|---|
| Show, hide, show step, hide step | `expect <target> visible` or `hidden` |
| Require | `expect <target> required` or `optional` |
| Enable | `expect <target> enabled` or `disabled` |
| Read-only | `expect <target> editable` or `readonly` |
| Validate | `expect error on <target>: rule`, `expect no error on <target>`, or `expect no errors` |
| Calculate | `expect <target> = …`, or an `expect <formula>` that reads the target |
| Minimum and maximum rows | `expect error on <target>: rows.min` or `rows.max`, or `expect rows of <target> = …` |
| Route | An `expect path = (…)` that lists the route's source page directly followed by its target. For a route to the end of the journey, an `expect path = (…)` that stops at the source page together with `expect path ends`. |
| PDF layout | `expect layout = <id>` |

A page or route belongs to one journey, and counts only for a scenario that ran that journey. A green run therefore proves that every listed rule has a scenario that reads it. It proves nothing about a rule outside these kinds or about answers no scenario tried.

## In a vitest suite

```js
import { fileURLToPath } from "node:url";
import { formTests } from "@argusvane/datum-form-test/vitest";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

formTests(here("intake.json"), {
  name: "intake form",
  runner: "both",
  coverage: "warn"
});
```

`formTests` takes a path to a definition, or a definition object, and registers one `describe` with one test per scenario, so the form's tests run in the same run, reporter and watch mode as your code. A scenario that every side skipped is a skipped test.

The options:

| Option | Default | Does |
|---|---|---|
| `name` | The form's title, else its path, else its id | The title of the `describe`. |
| `tests` | none | Paths of `.datum-test` files to add after the sidecar and the stored scenarios. |
| `sources` | none | Test text to add after the files, for a project that builds scenarios in code. |
| `runner` | `"both"` | `"runtime"`, `"kernel"` or `"both"`. |
| `program` | the in-process kernel | A sandbox program file the kernel side runs on. |
| `signatures`, `functions` | none | The names, argument counts and code of plugin formula functions the form calls. Without them such a form cannot be tested. |
| `coverage` | `false` | `"warn"` prints untested rules after the run, `"fail"` adds a failing test named "every rule is tested". |

- Paths are read from vitest's working directory, so build them from the file's URL as above.
- `vitest` is an optional peer dependency, pinned to 5.0.5 in the package, and only `@argusvane/datum-form-test/vitest` imports it.

## In a pipeline

One command runs every definition and writes the reports a CI job reads. The recipes below run `npx --package @argusvane/datum-form-test datum-form-test` and so assume the package is installed in your project (it publishes with the first release; until then install it as in [Installing the command](#installing-the-command)). A GitHub Actions job:

```yaml
name: Form tests
on: [push, pull_request]
jobs:
  form-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Form tests
        run: npx --package @argusvane/datum-form-test datum-form-test forms/*.json --coverage --report junit --report md --out form-test-reports
      - name: Summary
        if: always()
        run: cat form-test-reports/form-tests.md >> "$GITHUB_STEP_SUMMARY"
      - name: Reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: form-test-reports
          path: form-test-reports
```

On GitLab CI the same command goes in `script`, and the JUnit report in `artifacts.reports.junit`:

```yaml
form-tests:
  image: node:22
  script:
    - npm ci
    - npx --package @argusvane/datum-form-test datum-form-test forms/*.json --coverage --report junit --report md --out form-test-reports
  artifacts:
    when: always
    reports:
      junit: form-test-reports/form-tests.xml
    paths:
      - form-test-reports
```

Any other runner only needs the command and its exit code, from the table above. An empty run is never a pass (exit 3). Add `--fail-on untested` to fail the job when a rule has no scenario.

## On the server

A host can run a form's tests through the same sandbox it validates with, so a deployment check proves the registered definition and the shipped program agree with the suite. A host without Node sends the sandbox program a request and reads back the kernel's verdict on every scenario:

```
{ "abi": "<the program's version>", "op": "test", "definition": { … }, "tests": "test \"…\"\n  …" }
```

`tests` is optional test text. Left out, the scenarios stored in the definition run; given, that text runs instead.

The answer is `{ "ok": true, "op": "test", "report": … }`, where `report` holds:

- **`scenarios`**, each with its entry `id` when it came from the definition, `name`, `line`, `status`, `reason` and `steps`.
- **`summary`**, with `total`, `passed`, `failed`, `skipped` and `error`.
- **`problems`**, the parse problems, with `id`, `code`, `line`, `start` and `end`.

Limits and cost:

- The request is refused as `invalid_request` over 200 scenarios, 1,000 statements in one scenario or 256 KiB of test text.
- There is no clock, so a form that reads the day needs `given today` in each scenario.
- Give it a longer time budget than a validation run gets: a scenario takes about 13 ms.

See [Server programs](/server-programs) for the envelope.
