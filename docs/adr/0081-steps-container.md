# ADR 0081: Steps Container

## Status

Accepted.

## Context

Every government design system audited splits a long form into steps:

- USWDS's step indicator (segments, counters, "of N" with the step's heading)
- GOV.UK's one-thing-per-page journey (a "Question 2 of 3" caption over the page's heading, a Back
  link, Continue)
- Ontario's step indicator pattern ("Step 2 of 3" over the heading, a Back button, and the advice
  not to list the steps' names)
- GC Design System's `gcds-stepper` ("Step 1 of 4" over an h2)
- Québec's plain text.

The runtime knows how to navigate a wizard (`FormRuntime.navigate`, `next`, `back`, its
`beforeNavigation` hooks, the `navigationGating` rules and the `NAVIGATION_*` events, all keyed on
`step` nodes), but something in the tree has to put a step in front of a person, which a plain group
of steps does not (every step shows at once).

The `tabs` container shows the shape: a renderer module that owns the behaviour and hands a state to
a binding's adapter, shared by the live form and the builder canvas.

## Decision

**1. Two container types.** `steps` holds `step` containers (its content slot takes `step`
alone, so a field dropped on it lands in a step), and `step` is an ordinary labelled container
whose label is its name in the indicator. They are nodes rather than configured slots, because
the runtime's navigation, hooks, gating rules and error navigation are all keyed on step
*nodes*; the error navigation's default step type is `step`.

**2. The renderer owns the steps; an adapter draws them.** The renderer's steps module
(`render/live/steps.ts`) works out which step shows (the runtime's `navigation.currentStepId` when
it is one of the container's, else the first), each step's status, the progress words, Back and
Continue, and hands a `StepsState` to the binding's `steps` adapter, falling back to Datum's
(`render/live/datum/steps.ts`) when the binding has none or its template throws.

- Every step's components are drawn inside a wrapper carrying `data-container-id`, so the DOM
  contract holds whatever the adapter draws.
- Datum's adapter draws:
  - the indicator (one entry per step, `datum-form__step--active|completed|visited|upcoming`, each a
    button naming its step, an upcoming one `aria-disabled`)
  - the progress line (`stepOf`, the counter, the current step's name)
  - every panel (all but the shown one `hidden`, each a section with a focusable heading carrying
    the renderer's `headingId`)
  - Back (`data-step-prev`)
  - Continue (`data-step-next`)
- The last step has no Continue, the form's own submit button ending the journey.
- While a move is in flight the form is busy and both buttons are `aria-disabled`, never `disabled`.
- A review (`readonly` mode) or a print sets `StepsState.flat`: every step drawn headed, in order,
  with no indicator and no buttons; a `tabs` container is drawn the same way there, every tab
  stacked under its name.

**3. Navigation through the runtime.** In the live form, Continue validates the step in front of the
person (`validate({ scope })` keeps only the errors on that subtree and replaces the store, so the
summary lists that step's errors and none from steps still to come).

It either focuses the first error or records the step as completed (`markStepCompleted`) and
navigates to the next through `runtime.navigate`, whose hooks and gating rules may refuse and whose
`NAVIGATION_COMPLETED` draws the form on the new step, after which focus moves to the step's heading
(the new page's title, as a multi-page service moves it).

- Back navigates with no check
- an indicator entry reopens a visited step, an upcoming one is not a way to skip ahead.
- A submit validates the whole form, and an error or a focus request on a field in a step not shown
  opens that step first (the feature's `reveal`, through the runtime when it navigates).
- On the builder canvas, and under any runtime without `navigate`, every control switches the panels
  in place and the renderer keeps the choice across draws, so the author reaches every step's drop
  zones and the preview is never held by a required field.

**4. Wording through `texts`**: `stepOf` ("Step {{n}} of {{total}}"), `stepTagSeparator`,
`back`, `continue`, `stepCompleted` and `stepNotCompleted` (read beside a step's name). English is
built in; other languages come from the form's translations or a binding's language pack.

**5. A binding draws its design system's anatomy.** The state is the same for every binding, so a
binding's `steps` adapter only chooses the markup: the reference bindings draw, for example,
USWDS's step indicator (`bindings/uswds`) and a `gcds-stepper` heading each panel
(`bindings/gcds`). A binding with no `steps` adapter gets Datum's, tinted by its
`fallbackTokens`.

**6. The step's tag sits inside its heading.** Datum's panel heading opens with a
`datum-form__step-tag` span (the same `stepOf` words as the progress line, split around the number
into `-lead`, `-number` and `-rest` so a stylesheet can circle the number, then the visually hidden
`stepTagSeparator`) before the title, so the heading focus lands on after Continue reads "Step 2 of
3: Where you live", the way gcds-stepper, USWDS's step indicator and GOV.UK's caption-in-heading
structure it.

Datum's stylesheet hides the tag (`display: none`, as it hides the progress line's counter); a look
that heads a step with it shows the tag and hides `.datum-form__step-progress`.

**7. Seams on the datum binding** (ADR 0163) for the parts a design system draws differently, as
`createDatumBinding({ controls })` (`DatumContainerControls`, `render/live/datum/container-kit.ts`):
- `stepSegments: "text"` draws each indicator entry as static text naming its step
  (`data-step-entry`), with no role and no tab stop, the current one `aria-current="true"`, as
  usa-step-indicator marks it; Back is then the way back. The default is buttons.
- `stepRegion: "none"` gives a step's section no label (no landmark) while its heading stays the
  one focus moves to; `panelRegion: "none"` does the same for panels and tabs.
- `stepPages: "plain"` makes a step an unnamed section and the progress line a plain caption (not
  live), for a design system whose steps are pages. Focus still moves to the step's heading. By
  default a step is a region named by its heading and the progress line a polite live region.
- `stepProgress: "beforeList"` writes the progress line before the list, and
  `actionOrder: "nextFirst"` writes Continue before Back in `datum-form__step-actions`. Only the
  markup order moves. The default is the list, the progress line, the panels, Back before
  Continue.
- The `stepBack` part (`createDatumBinding({ parts })`) draws Back in a host's own template.

## Consequences

- A form gains steps by wrapping fields in a `steps` container; nothing changes for a form
  without one, and a `step` outside a `steps` container is a plain labelled section.
- The `steps` container is the way an author builds a step-by-step form in the interactive mode;
  steps in any other container all show at once.
- Errors are validated per step on Continue and for the whole form on submit; a host's
  `beforeNavigation` hook and a `navigationGating` rule apply to Continue and to indicator entries
  alike.
- A PDF prints every step as a section under its name, as the default layout does for a labelled
  container.
- Two `steps` containers on one form each show their own first step until navigated; the
  runtime's `next`/`back` walk every step node in document order, which is why the renderer
  navigates each container to its own neighbouring step ids instead.
