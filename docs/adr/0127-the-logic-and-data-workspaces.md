# ADR 0127: The Logic and Data workspaces

## Status

Accepted.

## Context

A form's rules are stored one component at a time, and the inspector's Logic tab edits one component's rules in place. Nothing in that view shows every rule at once, says what a rule does in words, or finds two rules that defeat each other. The words the builder shows must also be translatable by a host, and a sentence built by joining strings cannot follow another language's word order.

Where each answer is saved, what kind of value it is and whether it is required is spread over several places: the inspector's Data key row and its "Saves to" line, and a component's configuration for what happens to a hidden answer. No view shows the whole submitted document as a table an author can scan and act on. The Data workspace is that view. It builds on the data model (ADR 0110), data keys (ADR 0109) and the fold's hidden-value behaviour (ADR 0178, ADR 0120), and it edits the form's controller only.

## Decision

### The Logic workspace

1. **A rule model in the engine** (`builder/logic/logic-model.ts`, types in `logic-types.ts`). `buildLogicModel(root, { definition })` walks every rule the form holds, its steps' rules, each journey route's `when`, and each PDF layout's `when`. Every rule becomes a `LogicRule`: its kind, filter, group (the step its target is on, the form, Steps, Journeys, PDF layouts), whether Logic edits it, the paths it reads, and one sentence of tokens. It also returns counts per filter, the form's steps for the page-flow strip, and diagnostics:
   - visibility cycles and self-hiding rules;
   - reads of a path nothing stores, and reads of a later step;
   - a stored formula that does not parse (it is still listed, with its text), and a rename that left an unparsed formula naming the old id;
   - the run-scope findings (`rule.server-cannot-run`, `rule.browser-only-required`, `rule.secret-reads-browser-hidden`, ADR 0139, decision 9).

   Rule kinds are show, hide, require, validate (ADR 0120), enable, read-only, calculate, start at (default), filter, data-grid row limits, step gate, show step, hide step, Go to a step (a journey route), and the read-only PDF-layout kind.

   **Sentences.** A rule reads as a sentence of tokens, such as "Show [Registered agent] when [Business structure] is [Partnership] or [Corporation]". An `or` of equalities on one field reads as one "is A or B", and a choice is named by its option's label. A journey route reads "Go to [Step] when …", or "Go to [Step] always" with no condition. A `visibleWhen` whose top node is `not` over a non-path reads "Hide X when …". What does not fit a sentence reads as the printed formula (ADR 0140).

2. **The builder text catalog** (`builder/logic/builder-texts.ts`). Its keys are dotted and stable (`rule.show.when`, `logic.filter.require`), and English is built in. Templates have named slots, never concatenation, and a sentence is built from a template's parts, so word order is the language's. Every surface of the builder, Logic's and the shell's chrome alike, reads its words through it. How a locale's catalog falls back, and how lists and counts are formed, is in `docs/builder-ui-translation.md`.

3. **The surface, a lazy chunk** (`builder/logic/logic-surface.ts`, `<datum-builder-logic>`, loaded by `logic-loader.ts` the first time Logic opens). It is drawn where the canvas is in the Form workspace; the canvas and the inspector drawer step aside, and Logic opens with no drawer. It lists the rules filtered by kind and grouped by step, with the form's steps as a page-flow strip (a dashed step is shown only when its rule applies) and the diagnostics. A PDF layout's rule is read-only here, with "Open layout", since it is set in that designer; journey routes are edited here (decision 5). Under 900px of surface the kinds become a row and the editor folds over the list. New rule creates show, hide, require, validate, calculate and start-at rules, a Show a step rule when the form has steps, and a Go to a step rule where a Journeys mode can write it and a journey has a step to leave; the other kinds are listed and edited here but not created. A failed load shows the shell's "Logic didn't load" with Retry.

4. **The rule editor** is the formula editor of ADR 0140, in the surface's editor card, with the rule's field (chosen for a new rule), the formula box, where the rule runs, and its Try it.

   - **Hidden answers.** For a show or hide rule, what happens to the answer while it is hidden: left out of the submission (the default), kept and sent, or sent empty (`configuration.hiddenValueBehavior`, the fold's own setting). It is the component's key, the one the inspector's "When hidden" row and the Data workspace write, so all three show the same choice; a choice of the default removes the key. The list marks a rule whose hidden answer is sent.
   - **Try it.** A box for each answer the condition reads, and what the rule makes of them ("Email is shown"), worked out by the preview runtime: the fold the form runs, not the evaluator alone.
   - **Apply and Discard.** The editor works on a copy. Apply writes the rule and the hidden behaviour with `setProperties`, one undo step, one rule at a time. Discard drops the copy.
   - **The leave guard.** While the copy is not applied, the surface is the form controller's leave guard: a workspace switch or the host's `requestLeave` (a host's Save) asks first, with the inspector's prompt (Stay, Discard, Apply) drawn by the surface. Opening another rule asks the same way. `<datum-form-builder>.hasUnsavedChanges()` is true while a rule is not applied (and while any leave guard holds edits, such as a PDF template mapping): `BuilderController.hasPendingLeaveGuard()`.
   - **The selection follows.** Opening a rule selects its field. Entering Logic with a selection opens that field's rule.

5. **Go to rules.** A journey's route is an editable rule of kind "Go to a step" (ADR 0112, ADR 0119), with the editor of decision 4. Apply writes the route on the journey's controller in one undo entry; the form's controller is not written. A route has no Rules tab: its target and condition are this editor's.
   - **The seam.** The surface and the Journeys mode meet in `logic-journey-host.ts`: the mode registers a `LogicJourneyHost` for the form's controller, and the surface looks it up with the controller it was given. A builder with no Journeys mode has no host, so the surface lists journeys read-only with an "Open journey" button. `prepare()` loads the designer only when the form has a journey. Every host call names a journey id, a step id and the route's written position, never node ids.

6. **Bytes.** The surface, the model and the catalog ride in the Logic chunk (`datum-builder-logic-surface-*.js`). `datum-builder.js` carries only the loader, and the bundle check guards it.

### The Data workspace

7. **The schema table model** (`builder/data/schema-rows.ts`). `buildSchemaTable(root, { definition })` reads `dataModelFromForm` and returns one row per answer the form stores: where it is saved, its kind in words, whether it is required, marks, and the step and journey pages it is on, for the filters. The columns and marks are in `docs/data-model.md`, section 3. A checkboxes group is one row, and a repeating section's fields are rows inside its entries. The model is pure code, tested in node.

8. **The surface, a lazy chunk** (`builder/data/data-surface.ts`, `<datum-builder-data>`, loaded by `data-loader.ts` the first time Data opens). It is drawn where the canvas is in the Form workspace; the canvas and the inspector drawer step aside, and Data opens with no drawer. It shows the table, the JSON Schema and an example as three views under one header (Copy rides a bar over the JSON rather than among the view buttons, so the view switch does not move between views), with step chips and a journey page menu as filters, and an Import… dialog the Data surface owns, whose logic is `builder/data/data-model-import.ts` (ADR 0110). Under 900px of surface the editor folds over the table. A failed load shows the shell's "Data didn't load" with Retry.

9. **The storage editor works on the selection's draft,** like the inspector, not on a copy of its own. Choosing a row is `requestSelect`, so a draft on the answer open asks first. The editor shows the answer's name, type and step; its Data key with the controller's own data-key checks under it; "Saves to", following the draft live, as a read-only text box as in the inspector; what happens to the answer when a rule hides it; whether generated PDF layouts carry it (`pdf.exclude`); and what the server checks, in words (`docs/data-model.md`, section 3).

   Apply is `commitDraft`, one undo step, refused while a check holds it back. Discard drops the draft. Leaving Data, a host's `requestLeave`, and choosing another row ask through the controller's prompt. `hasUnsavedChanges()` counts the draft.

10. **The inspector's prompt moves with it.** While Logic or Data is on, the shell sets the inspector's `promptsElsewhere`. The hidden inspector then neither draws the unsaved-edits dialog (a modal inside a hidden panel would leave the page inert) nor unfolds itself to show it. The Data surface draws the prompt for the answer it shows, as the Logic surface does for its rule (decision 4).

11. **Host destinations.** Host-provided destinations, prefill and API panels arrive as strip items marked `data-workspace="data"` (ADR 0125).

## Reasoning

- **Logic edits the form's controller, and a journey's through a host the mode registers.** A PDF layout's rules are read-only in the list, with "Open layout". A journey's Go to rules are written through a seam the Journeys mode registers for the form's controller (decision 5), so the surface never reaches another mode's controller itself.
- **One catalog with template sentences.** Words in markup literals cannot be translated by a host, and joined strings cannot follow another language's word order.
- **Rules are applied one at a time.** One Apply is one undo step, which keeps a whole-form list from becoming a batch edit with a batch undo.

## Consequences

- An author sees every rule of the form at once, in words, and the cycles that keep a form from settling.
- Hosts copying the builder's bundle copy its chunks (as for the PDF, journeys and JSON chunks). Without the Logic chunk, Logic shows its failure card.
- The inspector's Logic tab stays for editing one component's rules in place.
- A host translating the builder sets a catalog on the surface (`catalog`, `locale`).
- An author sees the submitted document as a table and sets where each answer goes, without opening the canvas.
- Hosts copying the builder's bundle copy the Data chunk too; without it, Data shows its failure card. The import code rides the Data surface's chunk, and check-bundles asserts it.
- The Logic, Data and Languages surfaces share a pattern: a lazy chunk, a host element in the canvas's place, and the prompt drawn by the surface.
