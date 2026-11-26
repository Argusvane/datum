# ADR 0112: Journeys — multi-page flows over one form

## Status

Accepted.

## Context

An author defines the data model and the questions once, as one form. Many services then ask
those questions as a journey: one or a few questions per page, branches that skip whole sections, a page
that stops the journey ("You are not eligible"), and checks on the way — on each page, against the
service's own records, and once more before the answers are sent.

The steps container (ADR 0081) is a layout inside one page; it is not this. A journey is a flow
across pages. The hard part is the server: it re-validates a submission, so it has to know which
questions the person was shown. That contract is ADR 0178.

The author's model is simple: a journey is the steps a person goes through, and moving between
them is something the author writes down. A page with a condition of its own has no predecessor
to read it from when it is first. A page passed over because its questions are all hidden is a
decision nobody wrote, and the author cannot see it on the map. A person held on Continue by an
error on a page they are leaving has not yet been asked the pages that would explain it.

The guide to using journeys is [docs/reference/journeys.md](../reference/journeys.md). This ADR
holds the decisions and the reasoning behind them. The Check answers step is ADR 0172.

## Decision

1. **A journey is a list of pages on the definition, and each page lists component ids.**
   `FormDefinition.journey = { journeys: Journey[], defaultJourneyId?, opensAs? }` sits beside
   `pdf`, the same way PDF layouts do (ADR 0043). A page is not a node of the tree, so the tree
   stays the one form and its data model is unchanged. A page lists components, and each
   brings its subtree. A component may sit on several pages, for example the same question on
   two branches that exclude each other.

   A page's `components` may also hold objects: nodes the journey owns, an alias that fills a
   form field, a worked-out value, and references to form components inside own layouts. Those
   are ADR 0121. The tree is still the one form: an own node is never a node of it.

2. **Branching is forward routes, written on the page the person leaves.**
   - A page has no condition of its own. A definition whose page carries a `when` is refused
     (`journey.invalid`) by the browser's shape check and by the kernel's copy of it
     (`kernelIsJourney`), with the same reason: "a page has no condition of its own; branch with
     a route on the page before it". The path reaches a page by falling through to it or by a
     route (the builder's Go to rule). A condition reads the answers of pages already on the
     path, so a rule that leaves a page decides from what the person has just answered; a page's
     own condition would have to read answers that do not exist yet when it is first.
   - Every page the path reaches is shown, even one with nothing on it or with all its
     questions hidden. `journeyPath` (`core/journey/journey-path.ts`, spliced into the sandbox
     program so a server walks the same path) takes a page it reaches whether or not anything on
     it shows, and reads no visibility. Such a page shows its heading and its buttons. There is
     no decision kind for passing a page over. Skipping is a route, so the author wrote it and
     the map draws it. A page with nothing on it is a page the author has not filled yet, and
     the builder says "No fields yet" on it.
   - A page's `routes` are tried in order when the person leaves it. The first that matches
     wins, and its target is a later page or `"$end"`. With no match, the path falls through to
     the next page. The builder edits routes in the Logic workspace as "Go to a step" rules
     (ADR 0127), and the map draws each as a labelled line (ADR 0119).
   - Routes only go forward, so the path always terminates and is a pure function of the
     answers. A route back or to an unknown page is a diagnostic error and is passed over.
   - An `exit` page ends the journey with no Submit. A submission whose path ends at one is
     refused, by the browser and by the server (`journey.exit`).

3. **Conditions read only what the person has been shown and would submit.** ADR 0178 decision 1.

4. **Everything reads the submittable view, in the browser and in the sandbox alike.** ADR 0178
   decision 2: one fold, `kernelFoldSubmittable`, with the path and the placement as inputs.

5. **Off the path is hidden; on no page is judged as the whole form judges it.** ADR 0178 decision 3.

6. **Which journey opens: the definition proposes and the host decides.**
   - The definition's `opensAs` (absent: a journey whenever there is one), then
     `defaultJourneyId` (absent: the first).
   - The host's `journey` (on `<datum-form>`, `<datum-form-host>` and `FormRuntime`) overrides
     it: a journey id, `"form"` for the whole form on one page, or `"journey"` for the default
     journey even when the form opens as a form. An unknown id warns and falls back.
   - This is the shape `localization.defaultLocale` has against `locale`, and
     `pdf.defaultLayoutId` against `renderPdf({ layoutId })`.
   - `page` deep-links or resumes, honoured only when that page is reachable. At the start only
     the first page is, so a later page waits: a draft whose completed pages reach it opens
     there, and the person's first move forgets it.
   - A draft being restored names its own journey, and that wins over the host's choice: the
     person resumes where they left off. A draft naming a journey that is not in the form starts
     the running journey from its first page.

7. **The runtime owns navigation, so every host behaves alike.**
   - `nextPage` checks the page and moves forward. `previousPage` follows the current path (no
     history stack: the path is a function of the answers). `goToPage` may jump only to pages
     at or before the frontier, the first page not yet completed.
   - A `beforePageChange` hook may veto a move.
   - Changing an earlier answer that reroutes the path drops the completion of pages that left
     it.
   - A blocked submit, a rejected submission or a host's `setErrors` moves to the earliest page
     on the path holding a blocking error. Errors on no page stay in the summary, which is
     scoped to the page.
   - Drafts carry the journey, the page and the completed pages. They never carry the result
     of a server check: a stored "clean" is a claim a client could forge, and verdicts go stale.

8. **Validation per page is a setting, and so is a check against the host's server.** The
   journey sets the defaults, and a page overrides them key by key.
   - **`validation.continue`**: `"defer"` (the default) moves on from Continue and checks every
     page when the person submits, the earliest page with an error taking them back to it.
     `"page"` validates the page on Continue and stays while an error blocks; it is chosen
     explicitly, for the whole journey or one page. A deferred page that already holds blocking
     errors is validated on Continue, so a fix can be confirmed; resuming a draft never validates
     a deferred page. The default lives in the engine (`journeyPageValidation`), read by the
     browser, the kernel and the server checks, so the builder writes nothing into a new journey
     to get it.
   - **`validation.server: true`** makes Continue also ask the host's server to check the page
     (a registration number, an address) once the page's own checks pass. It is ignored on a
     deferred page, and the diagnostic `page.validation-server-deferred` says so. The request
     carries every submittable answer, so the server's verdict agrees with the browser's fold. A
     result that arrives after the answers changed is discarded, a check that returns only
     warnings stops Continue once, and an error the server reported stays on its field until that
     answer changes.
   - **`validation.onUnavailable`** decides what an unreachable server means: `"block"` (the
     default, with a message to try again) or `"continue"`. Unreachable is a timeout, a network
     failure, a malformed reply, no validator at all, and any HTTP status that is no verdict,
     which is every status but 200 and 422 — a 5xx and a 4xx alike. A 4xx (a lapsed session, a
     moved route, a misconfigured URL) is no verdict on the answers either, so the page is held
     as in an outage rather than let through on a check that never ran.
   - The guide has the request, the timeout and the cache ("Server checks").

9. **A journey can end with a server check.**
   - With `validation.end: "server"`, Submit asks the host's server to check the whole journey.
     The check runs after the browser's validation and the sandbox (ADR 0001's order: client,
     then WASM, then server, over one snapshot), over the exact values that will be submitted,
     and before the envelope is completed, signed or delivered. Nobody is asked for a passkey
     for answers the service will refuse.
   - The browser cannot run the service's hooks: they need services and secrets only the
     server holds. The host supplies the way to its server, `JourneyServerValidator`: a
     function property, or a URL the element posts to.
   - The URL is posted the delivery a Datum host's `POST /api/submissions/validate` takes, with
     the envelope Submit builds as `document`, made by the same code over the same values. One
     route then judges a check and a submission alike, and `validate-url` points at a host with
     no adapter in between.
   - The request carries the submittable values, the journey id and the locale, never a path.
     The server works the path out again with the same kernel. `@argusvane/datum-submissions`
     offers `validate`, receive's verdict and hooks without storing a record, and receive
     refuses a body that asks for a check. Both accept a result that has only warnings; receive
     refuses on a blocking error alone (ADR 0001).
   - The end check's errors have their own source (`journey-server`), apart from the in-process
     `serverValidationRunner` stage. A host that configures both runs its hooks twice.
   - A download button skips the end check, so the person can keep their answers offline. A
     journey the builder is previewing is never checked against a server: the server knows the
     registered definition, not the draft.
   - The definition says *when* validation happens; the host says *how*.

10. **Journeys are runtime state, not a render mode.**
    - An active journey paints its current page in interactive mode. `RenderMode`
      and `RendererTarget` stay `interactive | readonly | pdf`. The steps container's navigation
      state keeps its own `"wizard"` mode, which is a different thing.
    - The renderer's journey page module (`render/live/journey-page.ts`) draws the page around
      its components from a `PageState`: a focusable heading (with the counter's caption,
      decision 13) and the page's description above the fields, then Continue — or Submit on the
      final page, unless the page carries its own submit or download button, which keeps passkey
      signing and custom submission modes working — then Back on every page but the first.
    - A binding draws them through its `page.heading` and `page.actions` hooks, else Datum's
      (`render/live/datum/page.ts`) draws them, tinted inside another binding; the Datum
      binding's `journeyHeading` and `journeyActions` parts wrap or replace its own. The actions
      are the renderer's whatever draws them: Continue asks the runtime for the next page
      (`journeyAction`), Back the previous one, and while a move or a server check is out the
      buttons are `aria-disabled`, never `disabled`. The steps container's Back is the Datum
      binding's `stepBack` part, beside the journey's.
    - Read-only and PDF render every answer, never one page. A print follows the person's path:
      each page on it is a headed section, in order (ADR 0035).

11. **The envelope names the journey and nothing more.** ADR 0178 decision 4: the envelope's
    `submission.journey`, the verdicts that refuse a journey it does not have or cannot use, and
    the journey a submission that names none is judged by.

### Steps, the counter and journey-only fields

12. **The builder says Step; the definition keeps `page`.** `JourneyPage`, `pageId`, `expect page`
    and the `datum-page-change` event keep the word. Every word the builder, the counter and the
    findings show says Step. A step's number is its place on the path.

13. **The counter is on.** `progress` absent is `"count"`: each questions step and Check answers
    step is captioned "Step 2 of 5" (the `pageOf` text), counting the steps on the path as the
    answers draw it; an ending is not counted. `progress: "none"` turns it off. The browser and
    the kernel agree because the count is read from the path's trace. In the builder the Journey
    panel's Progress box offers "Count the steps" and "None".

14. **Fields only the journey asks are never data.** A step may hold fields of its own
    (ADR 0121): aliases, worked-out values and answers kept in the browser. Their answers are kept
    in drafts and never sent, printed or exported. The builder words them Journey-only and tags
    them "Not sent".

15. **A new journey is one empty step.** The builder makes it with one questions step and nothing
    placed on it (ADR 0115 decision 8), so a blank journey shows what it lacks as findings from
    the start: a required field no step asks blocks every submission through the journey
    (ADR 0121).

16. **A route is an editable rule, edited in the Logic editor.** In the builder a page's route is a rule of
    kind "Go to a step" (ADR 0127): its source step is fixed once the rule is saved, its target is a later
    step or the end and never an earlier or the same step, and a stored target the path would ignore is
    kept and shown. A step's rules are tried in the order they are written, the editor shows that order
    ("Tried 1st of 2 from this step") and a move is applied at once, one undo entry, with a warning when an
    earlier rule always matches. Apply writes the route's `to`, `when` and position on the journey's
    controller in one undo entry and never writes the form's controller. A route has no Rules tab and no
    inspector box, since its target and condition are the editor's: one place edits a route, so the Logic
    list, the map and the step's Logic tab cannot disagree about it. The map opens it (ADR 0119 decision 12)
    and the guide lists the editor's rows ("Go to rules").

### The page heading

`Journey.heading?: "shown" | "hidden"`, absent meaning shown. A one-page journey is a journey
like any other: the heading is what makes it look like the form, or not. A page heading is drawn
unless the journey hides it.

- **Drawing.** When hidden, the page's state carries no title or progress, and the renderer
  never asks the binding's `page.heading` for a heading block, so no binding's heading is drawn.
  The page's description, when it has one, still opens the fields. The page count is not drawn.
- **The form's title.** The page is headed as the whole form is: the chrome draws the form's
  title as the form's heading over the fields when no journey heading says it already and no
  `form-title` chrome part draws it. A form that shows no title has no heading on the page, as
  its whole form has none.
- **Naming and focus.** The page's `<form>` carries no `aria-labelledby`, as the whole form's
  does not. A page that draws no heading takes focus on the `<form>` instead
  (`data-journey-page-focus`), which is also the fallback when a binding's heading cannot take
  focus.
- **Presentation only.** Neither `validateJourneyShape` nor the kernel's `kernelIsJourney`
  checks the key, and any value but `"hidden"` reads as shown. A check on one side only
  would make the browser drop a journey the server accepts, and adding it to the kernel
  would change the sandbox program for a setting the server never reads.

## Reasoning

- **Conditions on the way out, not the way in.** One place decides where a person goes next, and
  the author reads it at the step they are on. The path stays a function of earlier answers.
- **Showing every step is honest.** A step that can vanish by itself makes the counter, Back and
  the map disagree with what a person sees. A step the author wants gone is a rule the author can
  read.
- **Check at the end.** A person is not stopped by a field on a step they are leaving. The Check
  answers step (ADR 0172) and the submit check show every problem together, and `"page"` stays
  for a service that must verify a step before the person goes on.
- **The default in the engine.** One rule for the browser, the kernel and the hosts means a
  definition means the same thing everywhere without the builder having to write it down.

## Consequences

- The steps container (ADR 0081) and `FormRuntime.navigate/next/back` are separate from journeys.
- The path is a pure function of the answers, and a condition reads form scope only, so a `host.`
  path cannot be read in one (`condition.scope`).
- The step counter and the deferred check are part of what a journey means, so a journey with no
  settings counts its steps and checks on Submit in every host.
