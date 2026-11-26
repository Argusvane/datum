# ADR 0178: The fold and server parity

## Status

Accepted.

## Context

A server re-validates every submission, so it has to know which questions the person was shown. A server
that required every required field would reject every submission of a journey whose branches each have
required fields. A server that accepted whatever its browser hid would let a client choose the questions it
answers. So the browser and the server run one fold of the answers, and what the fold reads is what a server
could also see.

This is a contract for every form, not a journey feature. Journeys (ADR 0112) are the case that makes it
matter, since the path decides which questions were shown.

The guides are [docs/reference/journeys.md](../reference/journeys.md#on-the-server) for the envelope and the
verdicts, [docs/reference/sandbox-abi.md](../reference/sandbox-abi.md) for the kernel's inputs and outcome,
and [docs/formulas.md](../formulas.md) for how a rule reads an answer.

## Decision

1. **Conditions read only what the person has been shown and would submit.**
   - Conditions are the rules language's expressions (formula text or the object form, ADR 0139), keyed by
     component id, in form scope only. The fold reads a compiled copy of the definition, never the stored
     one.
   - A condition sees the answers of the pages already on the path, and of components on no page. An answer
     on a page the path did not take, or on a later page, reads as `undefined`, so an answer left on an
     abandoned branch cannot steer the path.

2. **Everything reads the submittable view, in the browser and in the sandbox alike.**
   - One kernel-shaped function, `kernelFoldSubmittable` (`core/state/submittable-fold.ts`), does the whole
     fold:
     1. resolves every node's rules, Required OR Required-when (ADR 0120);
     2. places each component against the journey's path;
     3. folds ancestors and applies the hidden-value policy;
     4. repeats over the new view until it stops changing, bounded at ten passes.
   - The path and the placement are inputs to the fold (ADR 0144): the browser takes them from its journey
     engine, the kernel from the path engine spliced into the sandbox program. The runtime's orchestrator
     calls the fold, and so does the validation kernel. A server that receives the submitted values starts
     at the fixpoint the browser reached and lands on it in one pass. That is why the path, the visibility
     and the verdict agree by construction.
   - **This applies to every form.** A rule never reads an answer that is hidden and excluded from
     submission, because a server could never see it. The kernel folds `visibleWhen` for forms without
     journeys: a field hidden by its own rules is not required on the server, which is what the browser
     does.
   - **Answers are read as the envelope carries them (JSON semantics), and only under keys the schema
     defines.** A server only ever holds the submission as JSON, so the fold starts from
     `kernelJsonAnswers`: a non-finite number reads as `null`, `-0` as `0`, and an entry holding
     `undefined` is absent. The rules and the journey read the view `kernelFoldRuleView` cuts to the keys
     `kernelDefinesKey` accepts, the sandbox's allowlist (`kernelKnownKeyShapes`): each component's value
     path, and the entries of a repeating section or the rows of a data grid (ADR 0153) at its collection
     path. Nodes that hold no data of their own define no key. Both steps run once, inside
     `kernelFoldSubmittable`, which the browser and the kernel share.
     - **What a key no component owns can and cannot steer.** A value under such a key (a host's extra,
       `setValue` of an unknown key) is never read by a `visibleWhen`, `enabledWhen` or `readonlyWhen` rule,
       a route's condition or a PDF layout's `when`: the default `unknownFields: "strip"` removes it before
       the fold, and `"keep"` passes it through to the values without letting any of those read it. A
       calculation (`rules.value`) is the exception: calculations read every key the answers hold, and
       `kernelRecomputeCalculations` keeps the submitted result when one of its reads is missing. So
       `code = concat(campaign)` carries a host's `campaign` into `code`, a key the schema defines, and a
       rule, route or layout reading `code` is steered by it. Both sides still agree: the browser works
       `code` out from `campaign`; a server that strips `campaign` cannot reproduce the calculation and keeps
       the submitted `code`, and one that keeps it works out the same result.
     - **A non-finite number is unanswered.** `FormRuntime.submittableValues()` and the envelope's values
       carry `null` where the state holds a calculation's `NaN`. Every calculation reads the answers as JSON
       carries them, in the browser's `runValueRules` and the kernel's `kernelRecomputeCalculations` alike,
       so `coalesce(ratio, 0)` over a `NaN` ratio is `0` on both sides. `isEmptyValue` and
       `kernelIsEmptyValue` count `NaN` and `±Infinity` as empty, so a `required` calculation that comes out
       `NaN` is refused by the client pipeline as the kernel refuses the `null` the envelope carries. A PDF
       layout's `when` and the PDF render model read through the same functions, so a download prints a `NaN`
       as an unanswered value, as the server's PDF of the same submission does (ADR 0044).
     - **Limits that stand.** `rules.navigationGating` on the steps container is browser-only and no server
       reads it. A `Date` (or any object with a `toJSON`) set through `setValue` is a host's misuse: answers
       are JSON values, `kernelJsonValue` ignores `toJSON`, and the canonical envelope (`kernelSortKeys`)
       turns a `Date` into `{}`.
   - A visibility rule that reads `host.` counts as visible on the server, which has no host context, and
     does not demand a required field there: it is listed in `visibilitySkipped` (ADR 0142). The diagnostic
     `rule.reads-host` points at it.
   - A fold that does not settle within its ten passes means rules feed each other through hidden answers.
     Both sides then refuse the submission with one form-level error, `fold.unsettled`, rather than each
     settling somewhere different.
   - **The server trusts nothing it can work out itself.** Before the fold, the kernel recomputes every
     calculation (`rules.value`) whose inputs it was sent, and folds over its own results. A forged
     calculated value cannot hide a required field or skip a page. A calculation that reads `host.`, or an
     answer that was not submitted, keeps the submitted value, since the server cannot reproduce it.
     Defaults are the person's starting answers and are not recomputed.
   - **A hidden answer is left out of the submission unless the component says otherwise.** The component's
     `hiddenValueBehavior` decides: `exclude-from-submission`, the default, keeps the answer in the form
     (showing the field again shows it, a draft keeps it) and does not send it; `retain` keeps it and sends
     it; `clear` sends it empty. A person who types an answer and then hides its question by another answer
     has not meant to send it, and an answer nobody can see on the page should not reach the server unseen. A
     hidden component is also not validated (`hiddenValidationBehavior`, default `skip`) and not required
     (`hiddenRequiredBehavior`, default `not-required`). A PDF and a printed copy read the answers after this
     policy, so neither shows an answer the submission leaves out.
   - **Hiding relaxes "required", not the shape of an answer that is still submitted.** A hidden component
     whose answer is kept and sent (`retain`) is still held to its format: length, pattern, file size and
     type. Its `required`, plugin and custom checks are skipped. The browser applies the same rule and lists
     such an error in the summary, since the field is not shown. Without this, a client choosing the answer
     that hides a field could store anything in it.

3. **Off the path is hidden; on no page is judged as the whole form judges it.**
   - A component off the path, and every descendant of one, is hidden: never validated, never required. Its
     answer is kept for the person, so switching back to a branch restores it. It is not submitted unless its
     own `hiddenValueBehavior` or the journey's `offPathValues` says otherwise.
   - A component on no page is folded exactly as the whole form folds it: its own visibility, its own
     Required, its own value behaviour, its plugin and custom checks, in the browser and in the kernel alike
     (`kernelPlacedSemanticState`, one function both run). Form rules always hold: no client can name a
     journey to skip a required field it leaves off every page, nor that field's plugin and custom checks. A
     left-out answer is judged in full, format included. Route conditions can read such a component, and an
     explicit `hiddenValueBehavior` of `exclude-from-submission` or `clear` does not drop its answer. A
     calculated or host-seeded field on no page still submits, as the whole form submits it. The builder
     reports a required field left out as an error (ADR 0121).
   - **A field hidden on the form that opts in** (`hiddenRequiredBehavior: "required"` and
     `hiddenValidationBehavior: "validate"`) is, when left out, required and validated on both sides as in
     whole-form mode. `required` is raised for a hidden field only when it opts in to both: a hidden field
     not validated is held to the shape of its answer alone, so `hiddenRequiredBehavior: "required"` by
     itself enforces nothing, on the whole form or through a journey.
   - **The one exception is a field the server cannot replay.** The server has no host context: it leaves a
     `visibleWhen` reading `host.` unevaluated and keeps the configured visibility, while the browser follows
     the host. A left-out field is on no screen, so if each side judged it by its own reading they would part
     on a verdict nobody can act on: a browser told the person is not staff accepting what every server
     refuses, or the other way round. So when a left-out field's own `visibleWhen`, or any ancestor's, reads
     `host.` (`kernelFoldVisibilityReadsHost`, a walk up the tree, decided from the definition alone), both
     sides keep the lenient fold: hidden, not validated, not required, its answer by its own
     `hiddenValueBehavior`, else retained, its opt-ins (`hiddenRequiredBehavior: "required"`,
     `hiddenValidationBehavior: "validate"`) included. The ancestor chain counts whole, a structural ancestor
     (one holding a listed component) included; that ancestor itself keeps its own state, as on the whole
     form. A left-out field's own `requiredWhen` reading `host.` is held to that rule by neither side
     (`kernelFoldRequiredReadsHost`; its tick alone counts): the kernel never evaluates a rule reading
     `host.` (ADR 0120), and a browser that did would refuse, for a field no page shows, an envelope the
     server accepts. The field keeps the rest of the whole form's fold (shown, validated, its format held);
     on a page, and on the whole form, the browser follows the host.
   - Calculations read the settled view: an answer the fold withheld, and a component on a page the path
     skips, are no input to a calculation, so a forged answer to a component on a skipped page, read by its
     component id, derives nothing and steers no later page. A read by nested path (`box.income`) or over a
     collection (`sum(rows.amount)`) of a skipped page cannot be reproduced on the server: the sent result is
     kept and listed in `clientDerived`, as for a form without a journey. The browser and the kernel both work
     the calculations out again over the answers less the previous round's withheld ones, and fold again over
     all of them, until the withheld set stops changing. A view that comes back to one already tried (a
     calculation that moves the page that feeds it) is `fold.unsettled` on both sides, not a silent drop of
     the answer. A calculation whose input is on the path, optional and never hidden is worked out over the
     person's empty answer when it is omitted, so a filler cannot forge the derived value by leaving that
     input out. The diagnostic `calc.reads-branch` warns the author that a calculation reads a branch (its
     result is empty when the branch is skipped). With `offPathValues: "retain"` a retained answer is still
     readable.
   - A route or exit-page condition that reads the clock, with no day given to the server
     (`context.today`), is refused: `journey.clockDependent` (stage `journey`, `parameters`
     `{ journey, page }` naming the first such page), no values. The server cannot replay such a condition,
     and neither a kept route (which locks out an honest filler whose browser did not take it) nor a dropped
     one is the person's path. A host that runs a journey passes a day; the browser always has one. With a
     day, every page with a route whose `when` reads the clock is listed under `clockDependent` by its page
     id.
   - A repeating section or data grid stored at its own collection path is judged as the section or grid: its
     entries follow its placement and its hidden-value behaviour, so a grid that is hidden and excluded, or
     on a page the path skips, does not submit its rows, and they steer no rule or route.
   - One exception keeps parity: a container on a skipped page that also holds a component on a page the path
     takes is not folded. Its other children are hidden in their own right, but the container stays visible
     so the component on the path is not hidden by its ancestor. Otherwise the browser would take a route on
     an answer the server never received.

4. **The envelope names the journey and nothing more.** `submission.journey = { id }` is absent without a
   journey, so every existing signature and digest is unchanged. It is signed under the `submission` and
   `envelope` signing scopes, not under `values`. The sandbox's `WasmSubmissionContext.journey` carries it.
   The submissions service refuses an envelope that names a journey the definition does not have
   (`journey.unknown`). A context whose journey is not a usable journey, by the same shape rules the
   browser's reader applies (`validateJourneyShape`), fails closed (`journey.invalid`), and a path ending at
   an exit page is refused (`journey.exit`). All three use the stage `journey`.
   - The submissions service keeps the delivered document byte for byte, because its digest and signatures
     cover it. It also stores the values the verdict judged on the record: the kernel's submittable values,
     recomputed calculations included. PDFs, exports and aggregates read those values. A warning on the
     record lists any keys the fold withheld from what was delivered.
   - **A client chooses which of the author's journeys it answered through.** That is by design: a journey is
     a path the author declared. A submission that names none is not judged as the whole form, which would be
     a way to leave an exit page out: the submissions service judges it by the form's only journey, else the
     one `journey.defaultJourneyId` names, and refuses it with `journey.required` when the form has several
     and no usable default. `journey.opensAs: "form"` keeps the whole-form delivery. A check that names none
     is judged the same way. On a server host an amendment is judged by the original record's journey.
   - The filler's choice among the declared journeys is not an access boundary: naming a journey that has no
     exit page, or that skips a page, skips that exit page or that page's required fields. An author who needs
     an exit page to hold for everyone puts it in every journey, or declares one journey. A server that must
     accept only some journeys filters on `submission.journey.id` itself.

## Reasoning

- **One fold, not two that are kept alike.** What the browser shows and what the server judges agree because
  they are the same function over the same view, with the path and the placement as inputs.
- **The lenient reading for `host.` is the one both sides can share.** Judging a left-out field by the host
  in the browser and by the configuration on the server splits the two on a field nobody sees. Judging it by
  the configuration on both sides makes a journey stricter than the browser's whole form for the public, and
  still parts from the browser on a structural ancestor. The lenient reading on both sides agrees, at a
  cost: on the whole form a server requires such a field, so a client may name a journey that leaves it off
  every page to skip a Required and the plugin and custom checks (a forged answer for it is stored, only never
  checked). Closing that needs the host on the server, which the server does not have.
- **The server recomputes what it can.** A forged calculated value must not hide a required field or move
  the path, so the kernel works calculations out itself and keeps a sent value only where it cannot.
- **A client may name any declared journey.** Judging a submission that names none as the whole form would
  let a client leave an exit page out by saying nothing, so the server picks the journey the author declared.

## Consequences

- Servers agree with browsers on journeys. The kernel's visibility fold relaxes verdicts for forms without
  journeys too: required fields hidden by their own rules are not required on the server.
- A rule reading an answer that is hidden and excluded reads `undefined`, in the browser as on the server.
  `diagnoseJourney` and the diagnostics help authors find the places where that matters.
- A path that depends on the clock needs the host to give the server a day, or the submission is refused.
