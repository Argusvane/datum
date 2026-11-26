# ADR 0154: Form tests: scenarios over rules, journeys and verdicts

## Status

Accepted.

## Context

The guide is [docs/form-tests.md](../form-tests.md); it carries the language reference, the
command, the reports, the vitest helper and the builder panel. This ADR keeps the decisions and
their reasoning.

A large form accumulates rules: `visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`,
`validWhen`, calculations, a journey's routes, a PDF layout's `when`. Teams
change the form over months and forget what the rules were for. A change to one rule silently
alters a path or a verdict somewhere else, nobody notices until a person is refused or a page is
skipped, and the only record of the intended behaviour is the rule itself.

The engine already has every fact a test would assert, in one place. `kernelFoldSubmittable`
(ADR 0178) settles visibility, placement, requiredness (ADR 0120) and `validWhen` (ADR 0120) over
the submittable answers; `journeyPath` makes the path a pure function of the answers; the
validation pipeline raises errors by code (`required`, `rule`, `number`, `pattern`, …); the kernel
outcome carries `trace`, `effectiveState`, `withheld`, `submittable` and `values`; the
builder's Try it session (ADR 0141) holds one answers store and a `submit()` that returns problems;
`buildLogicModel` (ADR 0127) lists every rule the form holds and what it reads. What is missing is
a way for a form author, not a developer, to write down "when the business structure is a
partnership, the registered agent is shown and required, and a submission without one is refused",
keep it with the form, see it pass or fail while editing, and have CI say the same.

The rules language settled a pattern this ADR follows (ADR 0139): text is what the author
writes and what is stored, a kernel-shaped parser that never throws turns it into a tree with
spans and codes, the builder offers a simple editor that writes exactly that text, and the same
reading runs in the browser and in the sandbox.

## Decision

1. **A scenario language, text first.** A test is a `test "name"` block of one statement per line
   (givens, actions, expectations); `#` starts a comment, keywords are case-insensitive and
   English in every locale (as FEEL's are, ADR 0139), and indentation is for the eye only. Fields
   are named by value path (`items[0].qty`, the engine's own path syntax, so no second convention
   exists), pages, journeys and layouts by id, since titles are localized and change. Values are
   FEEL literals, plus a list `("a", "b")` for a checkbox group or multi-select. The reference is
   `docs/form-tests.md`, "The language".

2. **The statements.** Everything an expectation names is a fact the fold, the pipeline or the
   path already produces; the language adds no evaluation of its own. A test cannot be "more
   right" than the form, it can only record what the form does and catch it changing. An
   `expect <formula>` is evaluated over the same settled view the form's rules read, so a test and
   a rule can never disagree about what a field "is". The choices that carry reasoning:
   - A scenario on a form whose rules read the clock and that sets no day is an error,
     `scenario.clockUnset`, never today's date, so a test never depends on when it runs. A day is
     set once per scenario: a second day mid-scenario has no counterpart in a real session.
   - An action the form refuses (a Continue off a page with errors) is not a failure: the scenario
     stays where the form keeps it, and the next `expect` says what was meant.
   - A `set` on a hidden or disabled field is allowed, so a test can show that a hidden answer is
     withheld. A `set` on a path the form has no field for is linted (`tests.set.unknownPath`) and
     still runs, since a host's extra answer is a legitimate given.
   - Files as answers are not in the language: the value shape is host-specific (ADR 0034).
   - Server-secret rules skip on every driver with `unreplayable.secret`, since a test cannot
     carry the secret context without leaking it into the definition.
   - PDF output is asserted only as `expect layout = <id>`; what prints is the PDF kernel's concern
     and has its own golden tests. Data sources are fixed only through `given options for`.

3. **The parser is engine core and kernel-shaped.** `kernelParseFormTests(text, signatures)`
   (`core/form-tests/form-test-parse.ts`) returns `{ ok, scenarios, problems }` and never throws: a
   problem is `{ code, line, start, end, params }` with codes, not sentences; the builder words
   them from its catalog and the CLI from a table of its own. The `expect <formula>` form is
   parsed with `kernelParseFormula`; literals are lexed by the test parser itself with the formula
   language's spellings plus a list and a row path. The result lists `paths`, `pages`, `journeys`
   and `layouts` with their spans, in source order, so the builder's rename seam rewrites a test
   when a field, page or journey is renamed, exactly as it rewrites a formula. A reference to a
   field or page the form lacks is no parse problem: the step fails at run time as
   `expect.unknownField` or `expect.unknownPage`.

4. **One interpreter, two drivers, one snapshot.** `runFormTestScenario(scenario, driver)` walks the
   statements and judges every `expect` against a `FormTestSnapshot` (`core/form-tests/form-test-types.ts`)
   the driver returns after each action.
   - The **runtime driver** wraps a `FormRuntime`. It is the browser's reading, headless: it needs
     no renderer and runs in the builder, in vitest and in the CLI.
   - The **kernel driver** holds the answers itself and asks the validation kernel after each
     action: in process (`WasmValidationHost`'s in-process form) or the sandbox program file a
     host ships. `continue` is a run with `context.page` set to the current page, advanced along
     the outcome's `trace` when it blocks nothing; `submit` is a whole run. It is the server's
     reading.
   - Both drivers fill the same snapshot, so an expectation never knows which side it is
     judging. The CLI's default runs both and reports a scenario that passes on one side and
     fails on the other as its own finding (`parity`), which is the class of bug the two-sided
     design of ADR 0178 and 0120 exists to prevent. `compareSides` (`packages/form-test/src/parity.ts`)
     classes a pair as `agree`, `one-sided` or `differ`; `differ` fails the run and has no allow
     list.
   - The interpreter and the kernel driver's logic are kernel-shaped (top-level `kernel*`
     functions, no `Date`, no `Intl`, no throws), so they are spliced into the sandbox program
     through the `portable-kernel.ts` list as a `test` op, and a Java, .NET or Python host can run
     a form's tests at save time without Node.

5. **What a side cannot replay is a skip, not a failure.** The kernel's outcome lists the
   components whose rules it could not replay (`host.`, `browser`-scoped, the clock without a
   day) and those whose `server` rules the browser never ran. An expectation on such a component
   is reported `skipped` on that driver with the reason (`unreplayable.*`, listed in the guide's
   "What a skip means"), as the conformance suite reports a vector it cannot run. A skipped
   `requiredWhen` or `validWhen` could have decided the verdict, so the verdict expectations skip
   with it. A scenario's `given host.` values are the kernel run's `hostContext` (ADR 0142
   decision 18), so its `host.` rules are judged there too; with no `given host.` the run has
   none. A scenario is `passed` when every expectation passed on every driver that could judge it.

6. **Results are data.** A report holds scenarios, their steps and their coverage, and no
   sentence. A failed step carries what was expected and what the snapshot held
   (`{ code: "expect.visible", expected: true, actual: false }`), never a sentence. Each run is
   bounded: at most 1,000 statements per scenario and the kernel's own budget per run, so a
   runaway test ends.

7. **Coverage, from the Logic model.** `coverageOf` (`builder/logic/coverage.ts`) lists, from
   `buildLogicModel`, every rule and route of the form and which scenarios exercised it, by the
   expectation that reads the property the rule decides on its target (the table is in the guide's
   "Coverage"). A route is exercised by a `path` expectation, because a path is what a scenario
   can name; a page or route rule counts only for a scenario that ran its journey. `reach: "ran"`
   (the command's reading) counts scenarios that ran; `"written"` counts scenarios that parse, so
   the panel shows a pin before the first run. The rule kinds `default`, `filter` and `gate` have
   no expectation in the language and are not listed. "Untested" is a list, not a failure, unless
   the CLI is told `--fail-on untested`. This is the answer to "we forget the rules": the panel
   shows which rules nothing pins down, and each has a one-click scaffold.

8. **Where tests live and how they are stored.** `FormDefinition.tests = { scenarios: [{ id,
   source }] }`, beside `pdf` and `journey` (ADR 0043 section 4; one document to save, export,
   import, version and hand between hosts). Each `source` is one `test` block, name included, so
   a file of tests (`*.datum-test`) is the concatenation of sources and the embedded form and the
   file form parse with the same parser. `publicDefinition` strips `tests`, as it strips
   server-secret rules: the running form never carries them. The kernel's `check` op ignores
   `tests` and the size caps count it, so a definition cannot smuggle a megabyte of text past the
   gate as "tests". Hand-written sidecar files (`<stem>.datum-test` beside a definition) are read
   by the CLI too, for repositories that keep definitions as files.

9. **The builder: a Tests panel on the activity strip, a lazy chunk.** `<datum-builder-tests-panel>`
   after Variables, its surface in a lazy chunk (the CodeMirror editor a second chunk behind the
   panel's own lazy import), the eager bundle gaining only the strip entry and loader. The
   `tests` feature token gates it; `minimal` leaves it off. The guide describes the panel
   ("In the builder"); the decisions are these.
   - **State.** The controller holds the block (`tests()`, `setTests(value, { silent? })`),
     normalized on the way in, compared by value, and an undoable edit of its own that announces
     one `change` with reason `edit`. Hosts persist `builder.tests` beside `builder.value`;
     `<datum-form-builder>` carries it in `definition`. The panel's leave guard is stacked, not
     chained (`pushLeaveGuard`): the guard slot belongs to the surfaces (Logic, Languages, a
     designer's mapping), which clear it whole, so the Tests editor stacks beside them and
     neither throws the other's edits away.
   - **The panel runs the browser's reading only**, one fresh headless runtime per scenario so
     scenarios never share state, debounced and cancelled by the next edit, and never while the
     panel is closed. The command does both sides, so a form that passes in the panel can still
     differ there. Failures count as problems in the strip's badge; Save is never held back
     (ADR 0111).
   - **The editor** is text with completions and an "Add step" menu that inserts a well-formed
     line, so the author never has to remember the syntax and the text stays the only storage.
   - **Record** turns what the author does in Try it into lines, so an end user writes a test
     without learning the language first. A calculation's value is never a line, since the test
     would then assert what the form computes as if the author had typed it. A form that reads
     the clock gets `given today = <day>` as the first line, lent from the author's calendar day
     since the canvas's preview has no day of its own; a Journeys session has none, so the
     scenario reads `scenario.clockUnset` until the author adds it.
   - **A failure** is worded from the catalog in the form's own labels. "Show me" replays the
     scenario up to the failing step into the Try it store (ADR 0141's one answers store) so the
     canvas shows the state the test saw. "Accept new behaviour" rewrites the failing expectation
     to what the form does now, as one undo step with the change shown in the editor: without it
     authors delete failing tests instead of keeping them.
   - **Scaffold from a rule** ("Write a test") records what the form does today, which is what a
     team that has forgotten its rules needs first. Every scaffolded source is parsed again and
     dropped unless it is exactly one scenario with no problem.
   - **Renames.** A field rename is followed in the tests by the parser's spans as its own undo
     step; page and journey renames reach the shell on a bubbling `builder-journey-rename` event.
     A component with a data key (ADR 0109) keeps its value path under a new id, so its rename is
     not followed.
   - **Chunk hygiene.** The Tests runner runs on a run-only host, so the builder's eager entry
     carries no `test` op, parser or judge; a build guard fails if two strings only the op and
     the judge spell reach `datum-builder.js` or `datum-form.js`, and another asserts no chunk
     the panel loads statically carries CodeMirror.

10. **The sandbox `test` op.** `__datum_inspect` answers a fourth op, `test`, that parses and runs
    a form's tests (the definition's own `tests.scenarios`, or a sidecar text) on the kernel's
    reading and reports them in the runner's shape. The program holds the same parser, judge and
    server driver the engine does, so the in-process host answers the same bytes as the QuickJS
    program. The op gives the kernel's reading and no other; parity is the command's. Its size
    limits are refused before any scenario runs, and a scenario costs real run time, so a host
    gives a `test` request a larger time cap than the size-scaled one for the other inspect ops
    (`docs/form-tests.md`, "On a server: the test op"). The conformance suite has a Form tests
    pack for it. Whether a host runs tests at save or publish time, and whether failing tests may
    block publishing, is the host's setting, off by default; the builder never holds back Save.

11. **CI: a command and a vitest helper.** The package `packages/form-test`
    (`@argusvane/datum-form-test`: Node 22, a plain JavaScript bundle, the conformance suite's
    shape) provides the `datum-form-test` command and its exit codes (guide: "The command").
    `--runner both` is the default, because the in-process kernel is in the bundle; `--program`
    runs the kernel side on a sandbox program in QuickJS instead. JSON, JUnit and Markdown reports
    are written from one model that holds no sentence. For repositories already on vitest,
    `formTests(definition, options)` from `@argusvane/datum-form-test/vitest` registers one `it`
    per scenario; the helper lives in the package, not the engine, because the engine has no
    vitest dependency and should not gain one, and `vitest` is an optional peer the main entry
    never imports.

## Reasoning

- **Text first.** Text is what the author writes and what is stored; the builder's editor writes
  exactly that text, the same reading runs in the browser and in the sandbox, and tests diff in
  version control. The rules language settled this pattern (ADR 0139).
- **Tests live inside the definition.** One document to save, export, version and hand between
  hosts; the cost is that a test edit changes the definition's digest and, on a host that signs
  over `version`, its version. The sidecar form stays for teams that mind.
- **Pages by id, rows 0-based:** one path syntax everywhere, written for the author by Add step.
- **Formulas and worded messages in expectations** let a test read a field exactly as a rule does.
- **Two drivers over one snapshot** so parity is a test of the two-sided design for free. A
  skipped expectation is not a failure, so a side that cannot replay a rule does not read as
  broken.
- **Accept new behaviour** exists because authors otherwise delete failing tests.
- **A failing suite never holds back Save, and blocks publishing only by a host's setting.**

## Consequences

- A form's intended behaviour becomes a document a non-developer can write, read and run, kept
  with the form and diffed in version control as text.
- Divergence between the browser's and the server's reading is reported as its own class of
  finding.
- Tests sit in the definition, so hosts that hash the stored definition see a test edit as a
  definition change.
- The engine holds a parser, an interpreter and two drivers in core, all kernel-shaped, and a
  rename seam over tests; the builder has a lazy panel; the eager builder bundle carries a strip
  entry and loader only, which the bundle check guards.
- Every expectation reads facts the engine already produces, so the language cannot drift from
  the form: a new rule kind is testable the day the fold or the pipeline reports it.
