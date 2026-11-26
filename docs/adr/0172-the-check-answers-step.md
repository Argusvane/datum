# ADR 0172: The Check answers step

## Status

Accepted.

## Context

A long journey ends better when the person can read everything they said, go back to one answer, and
send. The pattern is GOV.UK's "Check your answers": answers listed by step, a Change link beside each,
and a send that stays on the list when something is wrong. A journey could not draw it: it drew its
steps, Back, Continue and Submit, and a page written around the form had to build the list itself
from `values` and `goToPage`.

## Decision

1. **A step's kind may be `review`, worded Check answers.** `JourneyPageKind` is `questions | exit |
   review`. A Check answers step lists the answers the person has given and sends them. It may hold
   content of the journey's own (a declaration, a paragraph) and no form field: a form field placed on
   it is dropped by the path engine and named by the diagnostic `page.review-form-field`.

2. **What it lists.** The step lists, in path order, the answers of the questions steps on the path,
   under each step's title. A field belongs to the earliest step on the path that asks it. Only
   answers a person gave count: a hidden field, a field off the path and a journey-only field are not
   listed.
   - Each row is the field's label (or the row wording the author wrote), its answer in words
     (the same wording print uses for an answer, `answerTextOf`), and a Change link.
   - A required field with no answer says "Enter {label}" and links to its step; an optional field
     left blank says "Not provided".
   - A data grid or a repeating section is one card per row, titled by the row's heading,
     with one Change for the card.

3. **Settings on the step**, `review`: `labels` (row wording by form component id, plain strings
   translated at `journeys › <journey id> › pages › <page id> › review › labels › <component id>`),
   `emptyOptional` (`"notProvided"`, the default, or `"omit"`) and `change` (absent: true; false draws no
   Change links). The shape is checked on any step, so a step whose kind is switched keeps its block, and
   read only on a Check answers step.

4. **It is the last step and it submits.** The path engine never passes it over, ends the walk there with
   a submit (`to: "$end"`), and never tries its routes; it is counted by the counter. Its action is Submit
   unless the step holds a submit button of its own.
   - Diagnostics (errors): `page.review-repeated` (one per journey), `page.review-not-last` (a step
     other than an ending after it, or a route leaving it for any place but the end),
     `page.review-form-field`.
   - `page.review-bypassed` (warning) names a route to the end from an earlier step that submits
     without passing it.
   - Its page scope holds no form id on either side.

5. **Change and return.** A Change link calls `goToPage(id, { direction: "change" })`. The runtime
   remembers the Check answers step as the return target (`JourneyState.returnTo`, also in the draft).
   - Continue and Back from the changed step go to the first step on the path not yet completed, else
     back to the Check answers step, so a changed answer that puts a new step on the path asks it
     before returning.
   - Any other move (a jump, a blocked submit's move, a restart, a path that no longer takes the
     Check answers step) gives the return up.
   - A change is allowed to a completed step or to the first step not yet completed, never to the
     Check answers step itself.
   - `datum-page-change` reports the direction `change`, the runtime's `PAGE_CHANGED` also carries
     `returnPageId` while a return holds, and `beforePageChange` sees the direction.

6. **A blocked send stays.** When the person submits from a Check answers step and a check refuses, the
   runtime does not move to the earliest step holding an error (as it does from any other step). The
   errors stay in the error store and the step lists them: an error summary links each to its row, the row
   carries the message, and its Change link opens the step. The same holds for a host's `setErrors`.

7. **Drawing.** The Datum binding draws it (`datumReview`, with `part="review"` and `part="review-card"`),
   through the optional binding hook `review`; a binding that draws none gets Datum's, and the GOV.UK
   binding draws `govuk-summary-list` (and a `govuk-summary-card` for a data grid's rows). The list's code and styles load only for a journey that has such a
   step. The details are in the guide's "Check answers".

8. **Texts.** `change`, `changeHidden`, `notProvided`, `enterAnswer` are form texts, translated by the
   binding's packs and by a journey's or a step's own wording.

9. **Tests and the builder.** The test language (ADR 0154) has `change <field>`, listed in docs/form-tests.md. The builder's Kind box
   offers Check answers, the inspector's "Answers listed" is a read-only list of what the step will show, the Step
   view draws the real list over placeholder answers, and the map marks
   routes written on the step as never tried; the guide's "In the builder" has the rest.

## Reasoning

- **A step kind, not a component.** It must be last, one per journey, and must hold the whole path's
  answers; those are properties of a step and the path engine reads them.
- **The runtime owns the return.** A Change link that is only a jump leaves the person on the changed step
  with no way back but Back through the whole journey. The return target belongs with the journey's
  state so a draft and the test drivers keep it.
- **One answer wording.** Print and the list share the function that words an answer, so the same answer
  reads the same on paper and on the list.
- **A send that stays.** Moving away from the list on a refusal would hide the list the person is
  reading; the list is where every error can be seen and fixed in turn.

## Consequences

- A journey with a Check answers step needs no code on the host page.
- Only the GOV.UK binding draws a native version; the others use Datum's drawing.
