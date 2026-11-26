# ADR 0121: Journey-only fields

## Status

Accepted.

## Context

A journey (ADR 0112, 0115, 0119) reuses the form's components page by page. Authors also need to combine
several fields into one calculated value, not require a field in one journey, word the same data
differently, and offer a short public version of a long form.

The direction is that the form is the final submission. There is ultimately one form, which represents the
final submission logic. A journey either reuses fields from the form or creates fields of its own that map
back to data paths in the original form. Those own fields are journey-only. The code names them
presentations (`presentationValues`, `isPresentationKey`, `PRESENTATION_VALUE_TYPE`); the builder says
journey-only. The rules that follow:

- **Own fields stay in the browser.** They are validated by their own rules and kept in drafts (local and
  server-stored), never in the submission, never printed or exported. Aggregates are allowed and labelled
  "worked out in the browser".
- **The server keeps replaying the route from the submitted form values.** Routes and page conditions read
  form values only, never a journey's own field.
- **A reused form field appears exactly as on the form.** Any difference is an own field that maps back.
- **Form rules always hold.** A journey can never make the server accept less than the form requires. A
  required form field a journey neither asks nor fills is a builder error, and the server judges fields a
  journey leaves out exactly as the whole form would (ADR 0178).
- **`requiredWhen` means Required OR Required-when;** the rule adds, never removes (ADR 0120).

The guide is [docs/reference/journeys.md](../reference/journeys.md#fields-only-the-journey-asks): the shapes a
step may hold, the usability rules A to I, how the fields run in the browser, and the diagnostic codes.

## Decision

1. **The form is the submission.** `definition.root` holds the data model, the rules, Required, the
   calculations, and everything that is sent, printed or exported.

2. **One mechanism: a journey with fields of its own.** They live in `definition.journey.journeys[]`; the
   builder mode keeps its id `journeys` (ADR 0115). A journey with only string page entries is exactly an
   ADR 0112 journey: it keeps the same ownership and trace, and the same fold whenever it places every
   component (a one-page journey listing everything folds as the whole form). A one-page journey is a
   journey like any other; it can hide its page heading to look like the form (ADR 0112, "The page
   heading").

3. **Own nodes are stored inside the page.** `page.components` is
   `(string | PresentationNode | PresentationReference)[]`: a string is a reused form component, drawn
   exactly as on the form; an object is a component the journey owns (a field, text or layout), an alias
   (a field with `configuration.fills`), a worked-out value (a `journey-value` node), or a `journey-field`
   reference to a form component, usually inside an own layout. The tree stays the one form: an own node is
   never a node of it. `validateJourneyShape` and the kernel's `kernelIsJourney` accept the same shapes and a
   table test holds them to one verdict; a malformed shape makes the browser drop the journey and the kernel
   answer `journey.invalid`.

4. **Own fields stay in the browser.** Their rules run only in the browser; Continue holds a page to its own fields and a submit judges the whole path, but an own field off the path or hidden never blocks. Their answers live under
   `@<journey id>.<id>`, are kept in drafts, and are never sent, printed or exported. The form pipeline,
   meaning calculations, the fold, the envelope, the sandbox request, page and end checks, PDF, CSV,
   data-source and submit-hook contexts, is built from `formValues()` and never sees them, so a form
   calculation that reads an own id gets nothing. `isPresentationKey(key, defines)` tells an own answer from
   a form value: it starts with `@` and the form does not define it. A hand-written form that does define
   such a key keeps it as form data, and an own field whose key the form defines is unusable (rule I).

5. **An alias is the form field.** Its answer is stored at the target's value path, so there is no second
   copy and no reverse seeding. It may have its own label, help and Required; it always shows the target's
   visibility, disabled and read-only state.

6. **A worked-out value is computed in the browser and checked on the server.** It reads only own fields on
   its own page (a static rule, so the server cannot flip-flop or hit a dead end), is drawn as a read-only
   copy of the target that shows the target's errors, and writes the target form field. The server keeps the
   value, checks it with the target's own rules, and lists it in `clientDerived` (`kernelClientDerived`, for
   forms without a journey too). A filled form field is kind-checked by the server (ADR 0122): the field an
   alias fills or a worked-out value sets is an ordinary `number` or `date` field to the kernel, so a forged
   non-numeric `annual_income` is refused with `number`. The runtime writes a worked-out value only once a
   readable source is answered and clears only what it wrote itself, so a prefilled or drafted answer is
   never cleared by an empty source.

7. **Placement is replayed.** A form field that is referenced, aliased or worked out counts as placed on that
   node's page. The server re-walks the path from the form values. Routes and route conditions read form
   values only. One shared ownership (`journeyOwnership`) says what each entry places, and the runtime, the
   kernel and the builder all read it. No page is passed over for being empty (ADR 0112): an own entry that
   references, fills or works out components whose visibility rules hide them, an own layout that holds
   nothing, and a page of own content all leave their page on the path. A context that names a page gets the
   form components in scope for it by the kernel's own placement (`pageComponentIds`).

8. **The kernel knows nothing about `@` keys.** Honest browsers never send them; the existing unknown-fields
   mode (`strip`, `reject`, `keep`) handles a forged one like any other unknown key. The kernel reads no own
   node's rules and no worked-out value's expression.

9. **Reference problems are handled the same way on both sides.** Shared, static usability rules, read from
   the definition alone (`core/journey/journey-path.ts`, spliced into the sandbox program), silently ignore
   bad entries on both sides, and the builder reports each one. Only a malformed shape makes the browser drop
   a journey and gives `journey.invalid` on the server. The rules are lettered A to I in the guide. A node
   that breaks A, B, C, H or I drops its whole top-level entry (`journeyOwnNodeRule`,
   `journeyOwnNodeUsable`); D to G drop only what they name: the reference, the alias's `fills`, or the
   worked-out value. Rule H makes own answers live under `@<journey id>.` exactly, so two journeys never
   share them. Rule I keeps an own answer from landing on a
   key the form defines, which would make it a form value that leaves the browser. Several aliases may fill
   one field (on branches that exclude each other, say).

10. **Form rules always hold: leaving out a required form field is a builder error.** The fold half of this
    rule is ADR 0178 decision 3, including the exception for a field whose visibility or Required-when reads
    `host.`. The builder half:
    - `component.unassigned` carries `required: true` when the form field has `configuration.required` or
      `rules.requiredWhen` (read by truthiness, as the fold reads it; `requiredWhen: null` is no rule), and
      the severity is then error, with the fixes "Ask it here" and "Make it optional on the form".
      Non-required omissions stay warnings per field under one summary, `presentation.fields-left-out`.
    - A left-out field the exception covers is a warning with `hostBound: true`, never counted as a required
      field left out, because neither side holds it to the rule.
    - **A literal default answers the field.** A required field answered by a literal `rules.defaultValue`
      that is not empty for its type is a warning, not an error: the browser submits the default unchanged,
      so the form's rule is met without asking. A default worked out from other answers may seed nothing, so
      it lifts nothing and the error stands. The definition alone cannot tell whether it would come to one
      for a given person.
    - **A required field hidden for good is never "asked".** No page can show a field hidden on the form with
      no rule to show it, so the finding carries `hidden: true` and offers "Make it optional on the form"
      for that field alone, on its own row or on the row of the container reported whole with it, and a container holding a field a page can ask as well is reported for that field, with the
      hidden one as `component.hidden-required` beside it. The same code keeps the error standing once the
      field is on a page, since every side still refuses `required` for a field hidden for good.
    - **A required calculated field whose input is left out** is an error on the input
      (`calc.input-left-out`). The fold holds the calculation to its Required wherever it sits, and with an
      input it reads on no page it comes out empty, so every side refuses every submission. An input whose
      visibility only the host decides is still this error, not the host-bound warning: on no page nobody can
      answer it, whatever the host says. The check reads the expression, not the answers: it assumes
      everything the journey does ask is answered.
    - The details of each case, with the exact reading of the expression, are in the guide's "Questions no
      step asks".

11. **One combined root, for the live page only.** While a journey with nodes of its own runs, the render
    bridge draws its current page from `FormRuntime.journeyRenderRoot()`: the form's root with a last slot
    holding the journey's container. A review, a printed copy and a PDF keep `formRoot()`, so an own node is
    never drawn there, and everything but the live page reads `formValues()`: no own answer reaches a review,
    a printed copy or a PDF made in the browser, not through a layout's path, template text or expression
    either, just as a server's copy has none. A journey of component ids alone has no combined root.

12. **Ids a journey owns stay its own.** The Journeys mode claims the id of every own node, in every journey,
    for the form's controller (`claimedIds`): a rename onto one is refused with an id error, and a new form
    component never takes one. The claimed ids are every journey's own ids in the catalog plus every open
    tree's, so an own node added, renamed or removed is claimed or let go at once, even while its tree cannot
    be written; a reference written with an id of its own claims none. The Data workspace's model import and a
    PDF template's "Create form fields" plan around `claimedIds()`, and `insertComponents` and
    `replaceContent` refuse a claimed id as a rename does.

13. **The builder reads the same ownership.** `diagnoseJourney` (`core/journey/journey-diagnostics.ts`) judges
    a journey's own nodes node by node, for the designer to draw each finding on its node. What is in use is
    read off the shared ownership and its rules (`journeyOwnNodeRule`, `journeyTargetUsable`, `aliasOf`,
    `workedOutOf`), so the builder cannot disagree with the browser or the server. An entry a rule drops is
    said only for why it is dropped, since nothing else in it is placed. The findings, their codes, and which
    carry `ownNodeId` are in the guide's "Diagnostics for journey-only fields".

## Reasoning

- **The form is the one data model.** A separate stored data model, model/view property roles on components,
  two journey modes, and per-page overrides of reused fields were each rejected: they would give the server
  a second contract to replay. An own field that maps back keeps one.
- **No lenient server modes.** Form rules always hold, so the builder refuses to author a journey that
  leaves a required field off every page, and the fold judges such a field as the whole form does. A mode
  that let a journey relax the form would be a way to skip a Required by naming a journey.
- **Routes read form values only, and the server replays them.** If a route could read an own field, the
  server could not replay the path, and a client could choose its own path.
- **A worked-out value is one-way and page-local.** It reads own fields of its own page, a static rule the
  server cannot flip-flop on, and writes a form field the server checks with the field's own rules.
- **One reading of what a journey places.** The runtime, the kernel and the builder read one ownership, so a
  finding in the builder is what the browser and the server will do, not a prediction of it.

## Consequences

- The form stays the single server contract; every journey reuses the journeys and PDF-layout machinery
  rather than adding a second one.
- A hand-written journey that relaxes a required field has its submissions refused; the builder refuses to
  author such a journey without an error.
- The plugin and custom checks of a left-out field run, as they do on the whole form.
- A journey's routes can still route around a required field: off the path keeps ADR 0178's rule, so both
  sides agree, but a client may choose the answers that skip a page. A required field that sits only on
  pages a route can skip is not warned about by the builder.
