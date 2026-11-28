# ADR 0139: Formulas: rules as FEEL text, if/then/else, emptiness, dates and a clock

## Status

Accepted.

## Context

The language reference for authors and hosts is `docs/formulas.md`; the builder's side
(the formula editor and the Logic workspace) is ADR 0140.

A form's rules (`visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`, `validWhen`,
`value`, `defaultValue`, `filter`, `navigationGating`), a journey route's `when`, a
worked-out value and a PDF layout's `when` need a form a person can read and write. Real rules
are mostly conditionals ("if X and Y then 250, if X or Y then 180, else 120") and need emptiness,
"how many ticked" and a date vocabulary. A JSON expression tree (`core/expressions/expression.ts`)
of `and`, `or`, `not`, comparisons and arithmetic cannot be read by hand, and the builder can
only draw flat rows with one join from it.

So a rule is stored as a FEEL-subset string (`session = "both" and not(empty(email))`). The
expression tree stays as the engine's internal runtime form, the shape of a compiled copy, and
is no rule a definition may hold. The language is a hand-written subset of DMN FEEL (OMG), `today()` reads a day the
host supplies, and the policy for a formula that does not parse is the author's and the host's
to set. Hosts also need to serve a definition with its secret rules removed and to check a
definition before storing it, from hosts that cannot run the engine's TypeScript (the Java, .NET
and Python hosts).

## Decision

1. **Two rule shapes, one reading.** Every rule site takes a
   `RuleSource = string | RuleObject` (`docs/formulas.md`, "Where a formula is used"). A string
   is a formula. The object form is `{ formula?: string; run?: RunScope }` and exists to carry
   `run`. A tree written where a rule goes (bare, or as an object form's `expression`) is
   reported by the compile as `invalidRule` (`params.got` `"tree"`) and read as no rule, on
   every side. `kernelRuleExpression(source, parse, signatures)` is the one reader: a string
   parses, the object form parses its formula, a compiled copy's tree (bare, or
   `{ expression, run }`) passes through, and a failed parse yields `undefined` (the rule is
   absent), which is the evaluation-time behaviour under every policy.

2. **The parser is engine core and kernel-shaped.** `core/expressions/formula.ts` holds
   `kernelParseFormula(text, signatures): FormulaParseResult` and its helper functions, all
   top-level `kernel*` functions with no module constants, listed in `FORMULA_FUNCTIONS` and
   spliced into the sandbox and PDF programs like every other kernel group. It never throws: a
   failure is `{ ok: false, code, params, message, start, end }` with a UTF-16 span, and `paths`
   lists every field reference with its span, in source order, for the builder's rename seam and
   unknown-field check. Codes, not sentences, cross the boundary: the builder words them from its
   catalog, the kernel log from `kernelFormulaMessage` (the code table is in `docs/formulas.md`,
   "Error messages"). The parser knows functions by name and arity through the `signatures`
   argument, never by importing the table, so a kernel splice carries no data constant. Nesting is
   counted before the descent and stops at 100 levels (`tooDeep`), so a hostile formula answers in
   under a millisecond.

3. **The grammar** is the FEEL subset `docs/formulas.md` documents. Lowerings produce only nodes
   the tree already had: `between` to `and(gte, lte)` with the left operand deep-copied, `in (…)`
   to a left-folded `or` of `eq`, `-5` to the literal, `-x` to `subtract(0, x)`. Deviations from
   DMN FEEL, each documented in the guide: `else` is optional (no case holding and no `else` is no
   answer, no default, not shown); names with spaces are not supported, so the library uses
   camelCase with the FEEL spelling noted as `feelName`; keywords are case-sensitive and English
   in every locale, as field ids are.

4. **The tree has `if` and a function library, and stays the internal form.**
   `IfExpression = { kind: "if", cases: [{ when, then }], else? }`: the first case that holds (decision 13) wins,
   none and no `else` is `undefined`, which the orchestrator reads as no answer. Every walker
   (read paths, host and clock reads, `dependency-extractor.ts`, `condition-shape.ts`, the
   builder's `isExpression`, the journey diagnostics) visits every branch.

   The function library is `FORMULA_FUNCTION_TABLE` (`core/expressions/function-table.ts`, rows of
   plain data); the summaries and examples sit apart in `function-docs.ts` so the runtime
   bundle carries none of them. The table is the single source for the parser's arity check,
   `isEvaluableExpression`, the journey diagnostics, the builder's helpers and the docs, so none
   can drift. Every function is kernel-shaped, pure, free of `Date`, `Intl` and
   `Math.random` (a parity guard greps the spliced sources), and answers `undefined` to input it
   does not understand, never a throw. Dispatch is `kernelExprCall(name, args, context)`: the
   evaluator's own switch, then the four group modules
   (`rules/evaluator/functions-{text,number,list,date}.ts`, each a `Handles`/`Call` pair), then the
   context's plugin functions. A plugin cannot shadow a built-in.

   What a rule's answer is when its operands are missing, mixed or too large is fixed by
   decisions 13 to 15.

5. **Compile once per runtime, into a copy.** `kernelCompileDefinition(root, journey, pdf, parse,
   signatures)` (`core/expressions/compile.ts`, its kernel functions listed in `COMPILE_FUNCTIONS`)
   returns `{ definition: { root, journey, pdf }, problems, warnings }`: every node, rules record
   and children slot is new, `configuration` objects are shared, every string rule is replaced by
   its tree, and `problems` lists each failure in document order with a `where` address. The
   author's object is never mutated, so a host that hashes the stored JSON keeps the same hash.
   A value of no shape is reported as `invalidRule`; it is dropped under `rules`, a tree is
   dropped at a journey `when`, a worked-out value, a PDF `when` or an expression source too, and
   any other value is kept as written there, so the shape validators refuse it on both sides.
   The PDF render model compiles the copy a runtime or the program hands it again
   (`recompile`), where a tree passes through; a layout handed to it is read as authored. Compile points, one each: the `FormRuntime` constructor (`compileFormDefinition`,
   after plugins install so their functions are known; `definition()` returns the author's object
   and `formRoot()` the compiled root the runtime renders from), `runKernel`'s top (before the
   journey shape check, which runs on the compiled copy so both sides agree), the PDF render
   model's `compilePdfDefinition` (engine and program), the submissions service's `register()`
   (compiled copy stored beside the original; the original is served and hashed) and the
   packages/datum `runtime-factory`'s constraints stage. Every host hands the sandbox the
   definition as authored (the browser its authored root and journey, the submissions service
   the registered definition), and the kernel compiles it for itself. A hand-built resolution
   context with no `rule` reader still works: the browser orchestrator then reads a compiled
   copy's tree, and never parses a string. The `where` addresses are in `docs/formulas.md`, "What is
   stored".

6. **The policy `formulaErrors: "warn" | "fail"`, default `fail` on every side.** Form level:
   `root.configuration.formulaErrors`; a host overrides it on every side that runs a rule, and
   `kernelFormulaPolicy(configuration, hostOption)` resolves it (the places are in the guide's
   "Mistakes in a formula"). Any formula problem (a formula that does not parse, an unknown or
   missing function on a rule that side runs, a rule that throws at evaluation, a scope a rule
   may not take, an `invalidRule`) refuses the definition or the submission with the problem
   named. `fail` is a refusal on each side in that side's own way: the browser constructor throws
   `FormulaError { formId, problems }` and the `<datum-form>` element draws a visible notice
   listing the problems; the kernel answers a `formula.invalid` error per problem and judges
   nothing else; the PDF program and the engine's PDF service refuse with `PdfKernelError("formula_invalid")`; the submissions
   service refuses the registration (`invalid_definition`). `warn` is the explicit opt-in for
   authoring, preview and staging: the rule is absent and the problem is logged. A rule the server
   runs that calls a function the server lacks still refuses under every policy word (ADR 0142
   decision 8).

   Any other value, in host options, a form's `configuration.formulaErrors`, a stored submissions
   setting, the sandbox context or the PDF inputs, is no policy word: `kernelFormulaPolicy` reads
   the next place that names one, else `fail`; the `formula-errors` attribute refuses it, and a
   server host configured with one refuses to start. The builder's Form settings choice list is
   Fail (first) and Warn, and a stored word it does not know shows as Fail.

   The builder's own previews (the canvas runtime, the journey preview, the PDF designer's
   preview and the builder element's sample runtime) pin `warn`: the builder shows problems and
   never disables Save (ADR 0111), and a formula the author is still typing never closes it.
   Try it's per-side report keeps saying what the server would do under `fail`.

7. **A risky pattern is refused: `riskyPatterns: "refuse" | "allow"`, default `refuse`.** A
   regular expression can take exponential time on some text, and neither engine can interrupt
   one in the browser, while in QuickJS the interrupt ends the whole run. So the static check
   `kernelRegexRisky` (`core/expressions/compile.ts`) runs where the pattern is written: a literal
   `matches` pattern with a catastrophic shape is refused at compile as `pattern.risky`, judged by
   `formulaErrors` like a formula that does not parse; a pattern built at run time is refused at
   the call (one warning, no result); a field `pattern` of that shape is skipped and logged, or
   fails closed under `fail`. A host allows them with `riskyPatterns: "allow"`, on every side
   that takes `formulaErrors`. The shapes it flags and the budget it reads under are in
   `docs/formulas.md`, "Regular expressions: the riskyPatterns policy".

8. **Dates and the host-supplied day.** Dates are `YYYY-MM-DD` strings and the arithmetic is
   civil-date integer arithmetic (no `Date` in the kernel). `today()` reads
   `RuleEvaluationContext.today`. The browser snapshots the day once per `recompute()` from the
   `FormRuntime` dependency `today`, defaulting to `localCalendarDate(new Date())` (never
   `toISOString`), and always sends it in the sandbox context at submit. A server sets
   `WasmSubmissionContext.today` from its own clock and its day wins. Absent, a clock-reading rule
   is skipped exactly as a `host.` read is (`kernelRuleSkipped(source, expression, key, side,
   today)`), and a journey condition that reads the clock with no day is refused
   (`journey.clockDependent`), and the outcome's `clockDependent` lists what read it. The clock
   is day-granular on purpose: `now()`, time of day and
   time zones are out of scope, and midnight drift between a browser's and a server's day is the
   documented limit (`docs/formulas.md`, "The day: today() and age()").

9. **Where a rule runs: `run: "both" | "browser" | "server" | "server-secret"`.** The object
   form carries it; the default is `both`. Only a form component's
   `visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`, `validWhen`, `value` and a grid's
   `minRows` / `maxRows` may take `server` or `server-secret`; `defaultValue`, `filter` and
   `navigationGating` are browser-side by nature (the server never applies defaults, ADR 0178 decision 2),
   and a journey own-node rule, a route `when`, a worked-out value, a PDF layout `when` and
   a PDF expression source keep their existing sides, so a server scope there is a `runScope`
   problem and the rule runs on both sides.
   - `browser`: the browser applies it and the kernel skips it as a `host.` read is skipped when
     the server supplies no host context (ADR 0142 decision 18).
   - `server`: the browser treats the field as if the rule were absent and the kernel applies it,
     so a server-only rule takes effect on the server alone. This is the author's opt-out of ADR
     0120's "a server is never stricter than the browser" for that rule.
   - `server-secret` is `server` plus removal from the definition a host serves to a browser:
     `publicDefinition(definition)` and its kernel twin `kernelStripSecretRules(root)` drop the
     rule and its `run`, the field stays. Nothing else can be secret: journeys and PDF layouts
     reject the scope, and a secret value written there is removed from the public copy
     (ADR 0029). The renderer's `definition` setter never strips (it cannot know it holds the
     server's copy; stripping is the serving host's job); the builder never strips (authoring).
     What a run says of a secret rule is withheld: its problems carry `where`, the code and a
     fixed sentence, never the rule's text.
   - The outcome's `serverRules` lists the components whose `server` or `server-secret` rules this
     run applied, so a host can explain a requirement the browser never marked. The journey
     diagnostics name the combinations that cannot work (`docs/formulas.md`, "Where a rule runs").
     A browser-printed PDF (ADR 0035) cannot show a secret calculation, since the browser never
     has the rule; the server-rendered PDF does.

10. **Plugin functions are the extension point.** `FormPlugin.formulaFunctions` contributes
    functions that are pure and args-only (no closures, no I/O, no `Date`, no randomness, ADR
    0001); a function that needs host data takes it as an argument (`host.region`), so read-path,
    host-read and clock-read analysis stay exact. The `FormulaFunctionRegistry`
    (`registry/formula-functions/`) merges them on the plugin platform beside validators and
    refuses a name that is a built-in or already registered. The sandbox module has the reserved
    key `functions: { name: fn }` beside `validators` (`__datum_register` collects it,
    `toSourcePlugin` derives it from `evaluate` for function-backed plugins), the PDF program's
    `__datum_pdf_register` the same. The parser's
    signatures (built-ins plus each plugin function at any arity) are embedded in the sandbox
    program at generation time as `__datum_signatures`, since the kernel cannot read the table; a
    sandbox module declares no arity of its own. A plugin function that throws answers `undefined`
    and a `warn` line, and under `fail` the rule is a `formula.invalid` refusal (ADR 0142); a
    result that is not plain data reads as no answer with one warning. A program with no plugins
    evaluates an unknown function to `undefined`, and a formula calling one is an
    `unknownFunction` problem under the policy on both sides.

11. **Hosts that cannot run TypeScript get the compile from the program.** The sandbox program's
    second entry point `__datum_inspect` answers `public`, `check` and `inspect` (ADR 0029 and the
    guide's "For hosts" section describe the ops and the request shape). The reading is the
    compile's own, so a host ports nothing.

12. **Bundles.** The renderer bundle `datum-form.js` carries the parser and the compile (the
    check-bundles rule forbidding the kernel there stands; the parser imports types only). The
    `FORMULA_FUNCTION_DOCS` summaries must not reach `datum-form.js`, and the sandbox-only structure
    code is built by a call marked pure so the form, builder and PDF bundles drop it.

13. **A condition holds only for the boolean `true`.** `and`, `or`, `not`, `if` and every rule
    verdict (`visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`, `navigationGating`, a
    journey route `when`, a PDF layout `when`) read their value strictly: `false`, `null`, no
    answer, any number, any text, any list and any object do not hold, so `visibleWhen:
    consentText` hides the field, `requiredWhen: items` never requires, `not "false"` is `true`
    and `1 and 2` is `false`. `and`, `or` and `not` always return a boolean. A bare yes-or-no
    checkbox still works as a condition; any other field is written as a comparison
    (`email != null`, `len(items) > 0`, `not(empty(items))`).

    The compile reports a condition that is provably no yes-or-no (a number, text, `null`,
    arithmetic, a call returning one, an `if` with such a branch) as the warning
    `condition.notBoolean` among `CompiledDefinition.warnings`, never `problems`, so
    `formulaErrors` does not act on it; the builder's formula editor underlines it. A bare field,
    `coalesce`, `first`, `last` and a plugin function are not provable and are not warned about.
    The runtime writes one console warning per warning at construction, the sandbox program one
    `warn` log line, and the inspect `check` op returns them in `warnings`.

14. **Two texts order by UTF-16 code unit.** `<`, `<=`, `>` and `>=` compare two texts by code
    unit, two valid days as days (the same comparison), and two decimal numerals as numbers
    (`"10" > "9"`); a text against a number is read as a number, and a non-numeric text against a
    number, a boolean or a missing answer never orders.

15. **Formula functions give no result for what they cannot work with, and cap what they read.**
    - Only a decimal numeral reads as a number (`"0x10"`, `"1_000"`, `Infinity` and `NaN` do not).
    - A missing operand, a division by zero and an overflowing `sum` are no answer.
    - Text and list functions given a value of the wrong kind have no result (`len` of a list
      stays its item count). `substring`, `indexOf` and `len` count code points.
    - A list over 10,000 items gives no answer and one warn line, as does a `split` into more
      than 10,000 pieces; the text caps and the sandbox limits are in `docs/formulas.md`,
      "Functions", and `docs/reference/sandbox-abi.md`, "Limits at run".
    - A plugin function result that is not plain data reads as no answer with one warning naming
      the function.
    - Dates clamp at month ends, a month-end birthday is reached on the clamped day, an
      out-of-range `dateAdd` and an `age` before the date of birth have no result, and rounding
      works below one millionth.
    - Calculations that never settle are `formula.invalid` (stage `definition`,
      `parameters.message` "the calculations do not settle: a -> b -> a") under every policy word,
      with no validator run.
    - A formula literal that is not a finite number, an interval written `[1...2]` and an unknown
      `dateAdd` unit are parse problems (`numberTooLarge`, `intervalDots`, `badUnit`).
    - A journey with duplicate page ids is refused everywhere (`journey.invalid`; a submission
      naming it is `journey.unknown`).

    `docs/formulas.md` states each of these as part of the language.

## Reasoning

- **Why the tree stays the executed form, and no proposal evaluates text directly.** Determinism:
  ADR 0001's contract is a pure tree over explicit context, parity-tested byte for byte between V8
  and QuickJS; the parser runs once at compile and its output is that tree. Hashing: hosts and the
  submissions package hash the stored definition's canonical JSON; compiling into a copy leaves the
  author's bytes alone, where rewriting text in place would not. Splice rules: kernel code is
  top-level functions with no module constants, so the parser can be spliced while the function
  table (data) cannot; a reader that parsed at evaluation time would need the table inside the
  kernel.
- **Why a hand-written subset of FEEL.** The parser is spliced into the sandbox and PDF programs
  as kernel source, so it cannot be a library.
- **Why `fail` is the default.** A formula problem dropped silently makes a form open, be served
  and be judged without the rule, and a PDF print without it. Refusing names the problem; `warn`
  is for authoring.
- **Why a refusing risky-pattern default.** A catastrophic pattern can run unbounded, and neither
  the browser nor an in-thread QuickJS can stop a native regex call, so the shape is refused before
  it runs.
- **Why a condition is strict.** JavaScript truthiness makes the text `"no"` hold, so a bare
  value is never a verdict: only the boolean `true` holds.
- **Why the day is explicit and day-granular.** A rule that read `new Date()` could not be
  replayed on a server or in a test and would differ between hosts; passing the day makes it
  context like any other value.
- **Why a server scope.** Some rules (a threshold the filler must not see) must not reach the
  browser; `server-secret` removes them from the served definition, and the author opts out of
  "never stricter" per rule rather than globally.

## Consequences

- A rule reads as a sentence in the stored JSON, and one reader (`kernelRuleExpression`) serves
  the browser, the kernel, the PDF pipeline, the submissions service and the builder.
- A definition is compiled exactly once per runtime into a copy; the author's bytes, and every
  hash over them, are untouched. `FormRuntime.definition()` returns the author's object and
  `formRoot()` the compiled root; the constructor compiles, so a definition with a formula
  problem under `fail` throws.
- The function library is one data table in core; the builder, the diagnostics, the parser and the
  docs cannot drift from each other, and a plugin's function is typed the same way.
