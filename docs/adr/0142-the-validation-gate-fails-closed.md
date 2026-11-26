# ADR 0142: The validation gate fails closed

## Status

Accepted.

## Context

The gate is the one validation the server (or the sandbox) runs before it keeps an answer. It
must not say yes when it cannot say anything. A pass by silence is a bypass: a number sent for a
text field, a number outside its declared bounds, a list of ten attachments on a single-file
field, a choice from a data source the validator was never told about, a plugin validator that
returned nothing, a rule that threw. The browser has the mirror image of the problem: a data
source that fails must be visible, one that never answers must not block the first paint forever,
and a sandbox module that never loads must not hang a submit.

The rule of this ADR is one sentence: **when the gate cannot tell whether an answer is good, it
says no, and it says why.** Where the browser can hold a stricter reading than the server, the
server's side is the one that is stated; the browser agrees wherever it can see the same facts.
The attack vectors that hold each rule are catalogued in `docs/conformance-suite.md`. The codes,
parameters and orders of the checks below are in `docs/reference/sandbox-abi.md`, "What the kernel
judges".

A rule can also read facts about the visit rather than the answers: `host.role`, `host.region`
(ADR 0139). The browser evaluates such a rule against `FormRuntime`'s `hostContext`. Where the
sandbox is given no such context, the kernel leaves every rule reading `host.` unevaluated
(`kernelRuleSkipped`): the field keeps its configured state, a `requiredWhen` or `validWhen` does
not count, a calculation is kept as sent and listed in `clientDerived`, and a field shown by the
host is treated as hidden for requiredness (`visibilitySkipped`). That lenient reading keeps a
server from being stricter than the browser (ADR 0120), but a field shown only to administrators
and marked required is then enforced by no server. So the server can be given the values (decisions
17 to 19).

## Decision

1. **A text answer is a string.** A number, boolean, list (an empty one too) or object sent for a
   built-in `text` or `textarea` is refused with the code `text`, by the browser stage and the
   kernel alike, through the ADR 0122 mechanism. A plugin type is nobody's to check. `required` is
   not satisfiable by `{}`, `0` or `[""]`.

2. **Declared bounds are enforced.** `configuration.min` and `max` on a number or date field are
   inclusive limits. A bound that is not a usable number or day is no bound, and an inverted pair
   drops both, so a malformed definition cannot refuse every answer. A hidden answer that is still
   submitted is held to its kind, length, pattern and file size and type, but not to its bounds or
   file count, which the browser's hidden-value policy drops.

3. **An attachment is an attachment, and there are not too many.** A file answer that is not the
   attachment envelope of ADR 0034 is refused as `file`; a count over the field's allowance is
   `fileCount`, the allowance being one for a field that is not `multiple`, else
   `configuration.maxFiles`, else 100; a declared `size` that is negative or not an integer is
   `fileSize` (kernel only).

4. **A row field is held at each entry.** A field inside a repeating section is checked at each
   entry's key and the error's `path` names it. `required` errors only for entries that lack the
   field; no entries, no error. `requiredWhen` inside a section stays unread (ADR 0120 decision
   3); only the tick is per entry.

5. **A row calculation is recomputed per entry.** `rules.value` on a row field is evaluated for
   each entry with `row.` reading that entry. A forged `items[0].total` is replaced, and the run log
   says so. An entry whose inputs are missing, or that reads `host.` or runs in the browser, is kept
   as sent and listed in `clientDerived` by its entry key. An aggregate over the whole section names
   no answer and is kept as sent.

6. **A source the snapshot lacks refuses.** A choice bound to `data.sourceId` whose source is not in
   `optionSnapshot` refuses an answer that picks a value, with `option.sourceUnavailable`. An answer
   that picks nothing, and an unanswered question, pass. Leaving a source out of the snapshot is not
   an opt-out.

   The one opt-out is explicit and the author's: `data.answersFree: true` beside `data.sourceId`
   says the source only suggests, so the snapshot is not consulted for that choice on either side,
   the answer still has its kind's shape and the field's own limits, and `inspect` lists the source
   as free. Only the boolean `true` counts. The builder offers it as a switch in the Data section,
   beside the Data source.

7. **A rule that throws is a failure under `fail`.** The kernel wraps the plugin functions it
   evaluates and records `{ where, name, message }` once per rule and function. Under
   `formulaErrors: "fail"` each record is a blocking `formula.invalid` and the plugin validators
   are skipped; under `warn` it is a `warn` log line. The browser wraps its functions the same way
   and adds the same error to a whole-form or journey page run under `fail`, naming the rule more
   coarsely than the kernel does.

8. **A function the server lacks refuses.** A rule that calls an unknown function and that runs on
   the server (`run` is `both`, `server` or `server-secret`; the key can take a server scope) is
   refused as `formula.invalid` under `warn` as well as `fail`. A rule scoped `run: "browser"`, a
   browser-only key, a journey condition and a PDF site keep the policy. The submissions service
   compiles once at register, so its `judge` adds the same error from the form's recorded problems.

9. **A validator that cannot answer fails the run.** A plugin validator that returns `undefined`,
   `null`, a non-object, a promise, an object with no `errors` list, or an entry that is not a
   record with a string `code`, makes the run throw. The service maps that to `validator_unavailable`
   (503, nothing kept, no hook run); the browser to the blocking `wasm.execution_error`. A validator
   that throws keeps `validator.failed`. A returned answer is copied once and the copy judged, so a
   getter that answers differently on a second read changes nothing.

10. **A severity outside the set blocks.** An error a validator returns whose `severity` is present
    and not `error`, `warning` or `info` is copied with `severity: "error"`. The service's `blocks()`
    and the runtime's `isBlocking` read the same way.

11. **A validator reads a frozen copy.** `context.values` is a deep-frozen copy; the stored values
    are built from the pristine object. A write from sloppy code is ignored; from strict code (every
    ES module and the sandbox program's own text) it throws and becomes `validator.failed`.

12. **An omitted input is the person's empty answer.** A calculation is kept as sent only when an
    unanswered read may have been withheld: the read names no data-holding component of the form, or
    sits in a repeating section, or the component can be hidden and its own `hiddenValueBehavior` is
    anything but `retain` (by default a hidden answer is left out of the submission).

    With a journey, a read is also a maybe until the fold has placed the components; after that a
    component only on pages the path skips is withheld for certain, so its read is the empty
    operand, and a component on the path follows the rule above.

    Any other unanswered read (optional or required, never hidden, or hidden but retained) is worked
    out over the empty answer: a forged sent value is replaced, the run log says the calculation was
    recomputed, and what reads it follows.

13. **A visibility the server cannot replay does not demand the field.** For a node whose own or
    inherited `visibleWhen` reads `host.` (and the run was given no host context, decision 18), runs
    `browser`, or reads a clock with no day, `required` is set false (the tick and `requiredWhen`),
    unless the node says `hiddenRequiredBehavior: "required"`. The node stays visible for validation
    and its hidden-value policy is untouched. The outcome carries `visibilitySkipped`, the ids whose
    own `visibleWhen` was skipped (also on `SubmissionRecord` and the service verdict).

14. **The browser paints first, times out, and says what failed.** The form is drawn without waiting
    for its data sources; a field whose source has not answered is `aria-busy` with a status line. A
    named source that throws, rejects, answers nothing, answers the wrong shape or times out raises
    `datum-error` once per component and message and draws the reason under the field. The author's
    inline options are **not** a fallback for a named source that failed; they stand for a component
    naming no source and for a journey page's own field, which has inline options only (`docs/reference/journeys.md`, "How journey-only fields run"). A list over the item
    ceiling is cut, warned about and noted; the sandbox module has the same bound. The wait and the
    timeout are host options (`docs/reference/attributes.md`, `docs/data-sources.md`).

15. **A sandbox module names its ABI.** A loaded `datum-wasm.js` must export `WASM_ABI_VERSION` equal
    to the element's. One that names another, or none, is refused before its host is built, the load
    error reaches `datum-error`, and the submit is not accepted. A load that takes over `wasm-timeout`
    fails, and a submit reports the validator unavailable; the failure is not cached.

The formula language's own rules (the `formulaErrors` default of `fail` on every side, conditions
that hold only for the boolean `true`, the order of two texts, and what a function does with an
operand it cannot use) are in ADR 0139.

16. **A risky regular expression is refused by default** (`riskyPatterns: "refuse"`; ADR 0139
    decision 7).

**Host context.** Two further decisions (17 and 18) say where the values of `host.` come from, and
one (19) what stays lenient whatever is supplied.

17. **The page supplies values for display.** `<datum-form>` takes a `hostContext` property and a
    `host-context` JSON attribute, copied as plain JSON data by the engine's sanitiser
    (`core/state/host-context.ts`). A later change goes to `FormRuntime.setHostContext`, which
    recomputes in place: the runtime is not rebuilt, so typed answers stay and nothing is announced
    as a new form.

    The values never enter the submission envelope. A server that took them from the browser would
    judge by whatever a client chose to send, which is the reading the lenient skip exists to avoid.
    The in-page sandbox (`<datum-form wasm>`) is handed the page's context with the day, because it
    stands in for the browser's own judgement.

18. **The server supplies values for the verdict.** The sandbox run context takes an optional
    `hostContext`. A server works it out from what it knows of the request, such as the session's
    role, and passes it per run. The kernel reads it into every rule context it builds (visibility,
    enabled and read-only state, `requiredWhen`, `validWhen`, a grid's row bounds, calculations).

    `kernelRuleSkipped`, `kernelFoldRuleUnreplayable` and `kernelFoldRelaxUnreplayable` take a
    `hostKnown` flag. With it set, a `host.` read is replayable like any other read, so a host-shown
    field is not relaxed for requiredness. A calculation's `host.` read counts as answered even when
    the key is absent, so the calculation is worked out over no answer rather than taken on trust.

    A key the context lacks reads as no answer (`null` in `=`), exactly as in the browser. Only the
    absence of the whole context means undecided, and then the kernel leaves the `host.` rules
    unevaluated as the Context describes. A value that is not an object is logged and read as
    absent. The ABI refuses, before the run, a context JSON would reshape, with the bounds it
    already holds `externalData` to.

    `@argusvane/datum-submissions` is the reference for a server: `receive` and `validate` take
    `{ hostContext }`, copy the value through JSON and pass it to the sandbox, and the record's PDF is
    drawn with the same context.

19. **Two readings stay lenient.** Both are decided from the definition alone, so both sides make
    them whatever a server supplies. A journey route's `when` never reads `host.` (the diagnostics
    report it as an error). A field a journey places on no page whose visibility reads `host.` keeps
    the lenient fold (ADR 0178 decision 3): the browser cannot know whether a server has a context, and the two
    sides must agree on a field nobody sees.

## Reasoning

- **Fail closed over fail open.** A gate that passes what it could not judge is a gate that can be
  bypassed by making it unable to judge; a refusal comes with a code a binding or a translation can
  word.
- **The source snapshot is not an opt-out.** An author who wants a source to only suggest says so
  with `data.answersFree: true`. A snapshot that silently lacks a source would pass any answer, so
  the check fails closed. Only the boolean `true` counts.
- **Inline options are not a fallback for a failed source.** A broken integration must stay visible
  instead of silently showing whatever was typed months earlier.
- **A validator reads a frozen copy, and a throwing one blocks.** A rule validator that could
  rewrite its input could change what is stored; a throw becomes a verdict, so the outcome and
  digest still come back. The copy is frozen, not only copied: the freeze is what makes a
  strict-mode write throw.
- **A visibility the server cannot replay relaxes requiredness**, because demanding a field the
  browser hid would make the server stricter than the browser on facts only the browser has; the
  author can still say `hiddenRequiredBehavior: "required"`.
- **An omitted input is the empty answer**, because a forged sent value over a missing input would
  otherwise be trusted; only an input that may have been withheld keeps the value as sent.
- **The host context never travels in the submission.** A server that took the values from the
  browser would judge by whatever a client chose to send; the server works them out from the request.
- **Two readings stay lenient whatever is supplied**, because the definition alone decides them and
  the browser cannot know whether a server has a context.

## Consequences

- Every rule here changes a verdict, so a host runs a program that carries it
  (`docs/reference/sandbox-abi.md`).
- A form accepted only because the gate stayed quiet is refused, with a code a binding or a
  translation can word and a path the person can find.
- A strict-mode validator that mutates its input blocks instead of silently rewriting the stored
  answers.
- A form that wants a file allowance other than the default of 100 writes `configuration.maxFiles` in
  the definition; the builder has no box for it.
- A host that supplies a host context enforces the form's host-dependent rules. A host that supplies
  none sees the lenient reading of decision 13.
- The browser and the server agree only when they are given the same values. When they are not, the
  server's verdict stands, and its errors reach the browser as for any server-only rule.
- The form tests' kernel side turns a scenario's `given host.…` lines into the run's context, so a
  host-dependent rule is judged there as in the browser. A scenario with no host given runs with no
  context, and what a `host.` rule decides skips as `unreplayable.host`.
- The `rule.server-cannot-run` diagnostic reports a `server` rule reading `host.` as one no server
  can run, which is true only of a host that supplies no context.
