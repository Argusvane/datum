# ADR 0120: Rules that add checks: Required when and Validate

## Status

Accepted.

## Context

A form that says "phone is required when the contact method is phone" must refuse an empty phone
in the browser, in the sandbox and on every server, as the builder's own text promises. So a
component's `rules.requiredWhen` has to be enforced by every checker that enforces
`configuration.required`: the browser's orchestrator evaluates the rule and the renderer draws the
required marker from it, while the field-constraints stage and the kernel's walker hold a field to
it.

A check that reads more than one answer ("the end date is on or after the start date", "the shares
add up to 100") needs a place in Logic too, next to Show, Hide, Require, Calculate and Start at. A
field's own limits (length, pattern, bounds) speak about its own answer only, and a plugin
validator is code a host has to ship. The check is a validation, so the browser, the sandbox and
every server judge it alike. It builds on rules as FEEL text (ADR 0139), the formula builder (ADR
0140), the fail-closed validation gate (ADR 0142) and authored validation messages (ADR 0049).

The two rules are the ones that add to what the fold works out. The second is
`{ kind: "validate", when, message, target }`: a formula that is true when the answer is acceptable,
the message the person reads otherwise, and the field the message stands under.
`docs/formulas.md` ("Where a formula is used": Required when rules, Validate rules) is the
reference for what each rule does.

## Decision

1. **Required OR Required when.** A component is required when `configuration.required` is
   `true` OR its `rules.requiredWhen` holds. The static tick is a floor the rule cannot lower.
   Letting the rule win would loosen verdicts that are enforced by the tick; the builder's text
   says the rule adds; the JSON Schema export lists ticked fields under `required`, which is right
   only under OR. The required marker reads OR too: a ticked field keeps its asterisk while its
   rule is false, so nothing is drawn optional that is then refused.

2. **Evaluated once, inside the shared fold, over the settled view.** `kernelFoldSubmittable`
   (`core/state/submittable-fold.ts`) works requiredness out after its fixpoint, converged or
   not, over the last rule view: the submittable answers under the keys the schema defines, as
   JSON carries them, re-keyed by id. The rule reads the same context as `visibleWhen` does
   through a `ruleRequired` callback each side supplies, so both reach the same verdict over the
   same answers. An answer that is hidden and excluded, or sits on a page the journey's path skips
   and is excluded, reads as absent there. The rule is read as every rule is (only the boolean
   `true` holds, ADR 0139 decision 13). The result is `KernelFoldResult.required`, before the hidden-required
   policy: `requiredApplies` is applied afterwards exactly as for the static tick, so a hidden
   field is held to its rule only as its `hiddenRequiredBehavior` says.

3. **Where the rule is not read** (the component keeps its tick alone, or none):
   - a component that holds no answer of its own (`kernelFoldHoldsOwnAnswer`): the form root, a
     repeating section or data grid, any group, and a button, static HTML, an image or a
     signature. Such a node's value is always empty, so a rule on it would refuse every submission
     while it held. The kernel's `kernelClaimsData` is built on the same predicate, so the two
     readings cannot drift.

     **A plugin's display component** is the one kind the fold cannot tell from a field (the
     kernel has no registry, and an unknown type may well be an answer-holding plugin field), so
     the fold does read a rule there and refuses every submission while it holds. The builder
     closes that gap instead (decision 6);
   - a component inside a repeating section or data grid: neither side folds row by row, so the
     rule would hold a form-level answer against every entry at once. The tick is held per entry
     (ADR 0142). Per-row `requiredWhen` is not supported;
   - **on the server only**, a rule the server cannot replay: one that reads `host.` when the run
     carries no host context (ADR 0142 decision 18), one that reads the clock when the run has no
     `today`, or one scoped `run: "browser"` (ADR 0139). The kernel's `kernelRuleRequired`
     answers `false`. Under OR that makes the server never stricter than the browser, which does
     hold the field to the rule with its host context. The builder says so under the rule, and the
     journey diagnostics say so too (`rule.reads-host`) for a form that has a journey, since `diagnoseJourneys` is the only pass that runs
     them. The author
     may opt out of "never stricter" for one rule by writing it `run: "server"` or
     `"server-secret"`, which the browser then ignores and the kernel applies. For a field a
     journey places on no page, the browser also leaves a `host.`-reading rule unread, since it
     would refuse on a field no page shows what the server accepts (ADR 0178 decision 3);
   - a field behind a **visibility the server cannot replay**: for a node whose own or inherited
     `visibleWhen` reads `host.` (and the run carries no host context), runs `browser`, or reads a
     clock with no day, `kernelFoldRelaxUnreplayable` sets `required` false (the tick and
     `requiredWhen`), unless the node says `hiddenRequiredBehavior: "required"`. The node stays
     visible for validation and its hidden-value policy is untouched. The outcome lists the ids
     whose own `visibleWhen` was skipped as `visibilitySkipped`. Otherwise the server would demand
     a field the browser hid.

4. **Both checkers read it, and the map never crosses the sandbox ABI.**
   - The browser: `FormRuntime.runValidation` passes `requiredComponents` (the orchestrator's map)
     in the `ValidationContext`. `collectFieldConstraints` collects a field with only the rule,
     only where the fold reads it, and `createFieldConstraintsStage` holds a field to `required`
     when its tick is set OR the map holds `true` under its own id. Without the map (a host
     running the stage outside `FormRuntime`) the tick alone counts; the sandbox still enforces
     the rule. A host that runs the stage on its own can work the map out with the kernel's fold
     (`kernelFoldSubmission`). `validationCodesRaisedBy` lists `required` for a rule-only field
     the fold reads, and for no other, so the messages editor offers it exactly where the stage
     can raise it.
   - The kernel: `kernelFoldSubmission` passes `ruleRequired`, and `kernelRunFieldConstraints`
     takes the fold's `required` (tick OR record).
   - `requiredComponents` **is not part of the sandbox ABI**: `WasmSubmissionContext` leaves it
     out with the other browser-only members, so no host can believe the sandbox honours a record
     it was handed, and `JsonWasmAbi.serializeContext` drops it by name before the bytes are made.
     The kernel works requiredness out for itself from the same fold. The payload carries no
     requiredness, so a program that does not enforce the rule accepts an empty answer the
     browser refuses; every host needs a program that does (`docs/reference/sandbox-abi.md`).

5. **Public API.** `FormRuntime.isRequired` and `requiredMap` answer Required OR Required when,
   before the hidden policy, for every component but the root, so they answer `true` for a field
   that is only ticked. The renderer's `requiredByComponent` is that map; the marker shows when it
   says so or the tick is set. The builder canvas runs the same orchestrator, so its asterisk
   follows the same rule.

6. **The builder offers Required when only where it is read.** The Rules tab offers it where the
   fold reads it (`applicableRuleDescriptors` with `offersRequired`, decided by the panel from
   `kernelFoldHoldsOwnAnswer`, the node's place outside any repeating section, and
   `BuilderController.typeOffersRequired`: the type's `required` capability, or no capabilities at
   all). A rule already on another node stays on the tab under a warning note that it is never
   enforced, and a rule reading `host.` under one saying only the browser checks it. The JSON
   Schema export adds its "Required when a rule of the form says so" sentence only to a field the
   rule alone requires; a ticked one is already listed under `required`.

**The Validate rule.** Decisions 7 to 16 are the second rule: a check over several answers.

7. **Where it is stored.** The target is the component the rule sits on, as for every form rule;
   the formula is the `ComponentRules` key `rules.validWhen` (true = the answer is valid);
   the message is the component's own message for the code `rule`, `configuration.messages.rule`
   (ADR 0049's map, a `LocalizedText`). No other key and no new shape. `validWhen` takes every
   shape a rule takes and may run `server` or `server-secret`, like the other
   kernel-applied keys. One rule per field; two checks are one formula joined by `and`. The Logic
   workspace calls the kind `validate`.

8. **One reading, in the shared fold.** The fold works out, after the view has settled and beside
   requiredness, which components' `validWhen` does not hold (`KernelFoldResult.invalid`,
   `kernelFoldInvalid`). It reads the rule where it reads `requiredWhen` (decision 3), with the
   same rule context (`component` is the field's own answer). The browser's orchestrator and the
   kernel each hand the fold their own evaluator, so both reach the same verdict over the same
   answers.

9. **What it raises.** A field whose rule does not hold and whose answer is not empty gets one
    error, code `rule`, stage `field-constraints`, no parameters, after every other check of the
    field. One error per field; `rule` is last. An empty answer is never checked against the
    rule: whether a field must be answered is `required` / `requiredWhen`'s question. The error
    blocks like every field-constraints error.

10. **Hidden fields.** `rule` is not a format check (the list is in ADR 0178 decision 2), so a component that is not
    validated (hidden, by its `hiddenValidationBehavior`) is not refused for it, on either side.

11. **Run scopes and what the server cannot replay.** `run` is read as for any rule: the server
    skips a `browser` rule, the browser a `server` or `server-secret` one. A rule reading `host.`
    (with no host context in the run), or the clock on a side given no day, is skipped by the
    server (it holds, the lenient reading of decision 3): a server that cannot evaluate the rule is
    never stricter than the browser that can. With a journey, a component on no page whose
    `validWhen` the server cannot replay is read by neither side (ADR 0178 decision 3's reading for
    `requiredWhen`).

12. **Fail closed (ADR 0142).** Under `formulaErrors: "fail"` (the default) a `validWhen` that
    does not parse refuses the form or the submission, as any rule does, and a plugin function
    that throws is `formula.invalid`. Under `warn` a rule that is dropped elsewhere is not dropped
    here: a `validWhen` that does not parse, or is none of the rule shapes, compiles to a rule that
    never holds (`false`), so every non-empty answer is refused with `rule`; a rule that throws
    reads as no answer, which does not hold either. A check that cannot say yes says no.

13. **The message.** The error is worded the way every code is (ADR 0049), page first. `rule`
    joins `ENGINE_VALIDATION_CODES`, so the builder's Messages editor offers it, and
    `validationCodesRaisedBy` lists it for a field with the rule. The kernel carries no text: the
    code is enough for a host to word it from the same catalog.

14. **The browser's stage.** `createFieldConstraintsStage` raises `rule` for a field whose id the
    context's `invalidComponents` (component id -> `true` when its rule does not hold) names,
    filled by `FormRuntime` from the same recompute as `requiredComponents`. Like that map it is
    browser-only and never crosses to the sandbox: the WebAssembly host and the parity adapter
    strip it. Without the map the stage raises no `rule`; the sandbox still enforces it. The key
    is declared on `ValidationContext` in `core/schema/contracts.ts`.

15. **The sandbox enforces it too.** The compile, the fold and the field-constraints pass the
    sandbox program splices in all know `validWhen`; a program that did not would copy it as an
    annotation and accept what the browser refuses. The element refuses a program naming another
    ABI (ADR 0142), so the element and its `datum-wasm.js` move together.

16. **The builder.** Logic's New rule menu offers *Validate*: the Field (any component holding an
    answer), Runs, the formula box (ADR 0140's formula builder, a condition), and a Message box
    that writes the source text of `messages.rule`, keeping its translations. Try it beside the
    rule says whether the answers it is given pass, worked out by the preview runtime's fold.

## Consequences

- A form with only the rule makes the field required in the browser, the sandbox and every server
  while the rule holds and `requiredApplies` is true.
- A `requiredWhen` on a group, an html block, a button, a data grid or a row field is never
  enforced, and its marker follows the tick alone. A `requiredWhen` on a plugin's display
  component is enforced as if it were a field, so the Rules tab does not offer it there.
- Rules reading `host.` are enforced by the browser, and by a server only when its run carries a
  host context.
- A known client-only gap the rule-required fields inherit from the tick: a field hidden by a rule
  with `hiddenValidationBehavior: "validate"` and `hiddenRequiredBehavior: "required"` whose answer
  is excluded or cleared (`hiddenValueBehavior`) and was typed in. The browser's stage reads the raw
  state and sees the answer; the envelope drops it, so the kernel sees it empty and refuses with
  `required`. A `FormRuntime` with no sandbox therefore accepts what every server refuses; with a
  sandbox the browser agrees with the server. The server is the stricter side.
- One more rule key everywhere rule keys are listed: the compile (`kernelIsServerRuleKey`), the
  condition warnings, the kernel's clock and server-rule lists, the orchestrator's dependency graph.
- Limits of `validWhen`, as for `requiredWhen`: a field inside a repeating section (its rule is not
  read), a journey's own nodes, and several messages for one field are not covered. A form that
  needs those keeps a plugin validator.
- The builder's Try it panel hands the preview runtime's `invalidMap()` to the field-constraints
  stage as `invalidComponents`, so its Check names a failing `validWhen` (ADR 0141, section 6 decision 3).
