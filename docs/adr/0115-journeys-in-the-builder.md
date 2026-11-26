# ADR 0115: Journeys in the builder

## Status

Accepted.

## Context

A form can declare journeys (ADR 0112): multi-step flows over its one tree, with steps that list
component ids and forward routes. The runtime, the renderer, `<datum-form>`, and the
sandbox all run them. The builder is where an author makes them.

The author's model is: define the form (the data model and its questions) once, then build
journeys over it. The builder has a precedent for "documents made from the form": the
PDF layouts, one document per layout, each edited by its own `BuilderController` (ADR 0045,
ADR 0099).

Three things in the code shape what follows:

- A page id may be any non-empty string (`"1"`, two pages sharing one), but a tree node id must
  follow the component-id grammar and be unique. Page ids cannot be node ids, or valid files
  would not open.
- The canvas preview evaluates a node's `rules`, so a route's condition stored as `visibleWhen`
  would hide the route's node. The Logic editor edits a route's `when`, never a node's `ComponentRules`.
- `setOptions({ componentDefinitions })` rebuilds a controller and wipes its undo, drafts and
  selection, so a journey's designer cannot be rebuilt on every form edit.

And one fact about journeys raises the stakes. **Every journey saved into a definition is one a
client may submit through**, whatever `opensAs` says (ADR 0178 decision 4: the client names the
journey, and the server judges through it). The server holds every answer to the form's rules,
asked or not, so a required field a journey leaves out blocks every submission through it,
unless a default answers it or only the host decides whether it is shown or required (ADR 0121). A half-built journey saved from any builder is a journey nobody can submit through, or
one that skips questions the author meant to ask.

The guide to the mode as an author uses it is [docs/reference/journeys.md](../reference/journeys.md#in-the-builder).

## Decision

### The mode

1. **One Journeys mode, one controller per journey.** Mode id `journeys`, label "Journeys",
   settings label "Journey", document noun "journey". Each journey is a document, listed on the
   Journeys overview and named on the bar's document label, edited by its own lazily created
   `BuilderController`, following the PDF layouts. The overview's New and the command palette
   offer "New journey…" (`BuilderDocuments.addKinds` has that one kind); the journey is never
   called anything else. Undo and selection live per journey and
   survive switching documents or workspaces; drafts do not, since every switch goes through the
   shell's leave guard, which asks to apply or discard.

   Catalog actions — add, rename (the name
   only; the id stays), duplicate, delete, set as default, opens as — are each one step of the
   form's history (ADR 0180, decision 1), as with PDF, so Undo on the journey's page reaches them.
   The designer's tree takes no entry for what the catalog wrote. A rename changes the text shown
   in the form's locale (that locale's own, else the source text), so a localized name keeps its
   translations and catalog key.

2. **The designer's tree uses internal node ids** (`journey-tree.ts`).

   | Node | Node id | Children | Configuration |
   |---|---|---|---|
   | `journey` (root) | `journey` | `pages` | the journey minus `id` and `pages` |
   | `journey-page` | internal | `content`, `routes` | the page minus `id`, `components`, `routes`, plus `pageId` |
   | `journey-field` | internal | none | `{ componentId }` |
   | `journey-route` | internal | none | `{ to, when?, missingTo? }` plus the route's other keys |

   - A page's id is its `pageId` property; its node id is internal (`journey-page_1`, the
     controller's own numbering). A route's `to` names a page *node*, `"$end"`, or nothing yet.
     So any usable file opens — page ids like `"1"`, duplicate page ids, unknown targets,
     backward routes — and editing a page id never breaks a route.
   - The root always has `pages` and every page `content` and `routes`, from `treeFromJourney`
     and from the palette's templates (`journeyNodeTemplate`), so the controller's add finds the
     slot it needs.
   - Writing back (`journeyFromTree`) makes a blank `pageId` the node id (made unique among the
     pages) and turns a route to a page node into that page's id. An unknown target from the file
     stays. A route whose target node was deleted becomes the page id that node was last written as, so it
     survives as the `route.unknown-target` error rather than vanishing and silently changing the
     path; a deleted page's node id and page id are never given to a page added later
     (`reservedIds`), so no new page takes such a route over, and a route whose target id is the id
     a page is later written under goes to that page and follows its node (`routeLinks`). A route
     with no target, or a question with no component, is left out. The normalisations of a saved
     journey (blank selects, booleans, empty lists) are in the guide's "What the builder writes back".
   - **Every key the builder does not know is kept**: on the block, on each journey, on each
     page and route, in `texts` (a binding's own words) and in `validation`.
   - A journey read and written back unedited equals the one read; a second round trip is
     identical to the first. The mode's change reports are measured against that normalized
     text, so opening every journey leaves `definition.journey` byte for byte as it was.

3. **Nothing written fails the shape check.** `readJourneys` silently drops a journey that
   fails `validateJourneyShape`, and the builder's Open refuses the file. So the catalog refuses
   to add or replace one, and a designer tree that would write one reports why through
   `onError` and keeps the last usable journey. Declared journeys that already fail the check
   pass through untouched and unlisted, and so do later journeys whose id an earlier one has
   (`findJourney` could never open them); both are reported (`unlistedJourneysOf`): a repeated
   id as a finding on the root of the journey whose id it repeats, and an unreadable journey,
   which may have no id to match, as a finding on the root of every journey.

4. **A route's condition is node configuration (`when`), never `ComponentRules`**, and is edited
   as a "Go to a step" rule in the Logic editor (ADR 0127), through a seam between the Logic
   surface and the Journeys mode (`logic-journey-host.ts`). A step has no condition (ADR 0112 decision 2),
   so it has no descriptor and no Rules tab; the step's Logic tab lists its routes. A route reads
   its own step's answers and those before it; the mode's note keeps only what it cannot read:
   `row.`, `ancestor.` and `host.` paths.

5. **A form edit never rebuilds a journey's designer.** Choices and the Step view read the form
   through a live context; a form change repaints (`repaintPreview`), so undo, drafts and
   selection survive.

6. **Findings are advisory; only step ids block.** `diagnoseJourney`'s findings lead the Journey
   panel in a findings card, are counted on the map, are drawn on the node they concern, and again
   in the inspector as notes under the box that puts them right, and never hold Apply back
   (ADR 0111). Each problem is said once (ADR 0171). What blocks is a page id the draft *changes*
   to one another page of the journey has, to a form component's id, or to `"$end"` — checked by the
   panel's Apply and by `commitDraft` alike, so the unsaved-changes prompt's Apply cannot bypass
   it; that problem stands in for the finding's note. A clash already in the file stays the advisory `page.duplicate-id` or
   `page.id-is-component-id`, so it never blocks an unrelated edit such as a title.

7. **The mode is static; the designer is a lazy chunk.** The mode, the catalog
   (`journey-catalog.ts`), the model (`journey-mode-model.ts`), the references rewriter
   (`journey-references.ts`) and the shell seams are in `datum-builder.js`; none imports the
   journey diagnostics, the tree mapping or the faces. `activate()` loads the designer with a
   memo that is cleared when a load fails, so a failed chunk load can be retried. Every host
   gets the chunk with no loader wiring. In `@argusvane/datum` it is
   `datum-builder-journey-designer-*.js`; `check-bundles` keeps its
   sentinel, the designer's own mark, out of `datum-builder.js` and `datum-form.js`, and the
   journey findings in one shared chunk. The classic script carries the designer inline. The
   flow map (ADR 0119), the Try it session (ADR 0141) and the journey-only fields (decision 18)
   are chunks of their own, loaded from the designer.

8. **A new journey is one empty step.** The add popover offers a Name, "One empty step" and, when
   there is a journey, "A copy of it"; a blank name is "Journey n". The journey has one questions step,
   "Step 1" (`step-1`, the first `step-n` the form has not taken), with nothing placed on it (ADR 0112 decision 15).
   The author fills it from the palette and the Form fields panel (ADR 0171). There is no blank
   journey with no step: a journey with no steps, saved, would let a client submit the form
   unchecked (see Context). `journey-from-form.ts` is authoring-only, so it lives with the builder and
   `core/journey` keeps to the definition language and the sandbox-spliced functions. Its
   `unassignedMembers` lists what a journey asks on no step (a group none of whose contents is asked
   standing for them), which the findings card and "Ask it here" use, and `journeyFromForm` builds a
   copy's shape.

### Default, opens as, and the stakes

9. **The first journey sets what the form opens as.**
   - `addJourney` on a block with no listed journeys writes `opensAs: "journey"` (the default
     journey being the first, since nothing else is listed), whether `opensAs` was unset or
     `"form"`. Later journeys never change it. The stored shape is `"journey" | "form"`
     (ADR 0112): "opens as that journey" is `opensAs: "journey"` with `defaultJourneyId` naming
     it, or the first listed journey.
   - Removing the journey the form opens as (the effective default while the effective `opensAs`
     is `"journey"`) writes `opensAs: "form"` in the same catalog edit, rather than letting the
     next journey in the list silently become what the form opens as. Removing the last journey
     removes `opensAs` and `defaultJourneyId` with it: they mean nothing without one, and the next
     first journey sets them again. Removing any other journey leaves them alone.
   - Both writes are part of the single catalog edit that adds or removes the journey: one change
     reported (`reason: "journeys"`), one definition written, one step of the form's history
     (decision 1). No state in between can be seen by a host, a save or a draft. These rules run
     only when the author adds or removes a journey, or chooses an opens-as value; a stored
     definition is read as written.
   - The add popover and the Journey panel's findings card say plainly that any journey saved here
     is accepted by the server as a way to submit, that the server holds every answer to the form's
     rules, asked or not, and that a required field left out blocks every submission unless a default
     answers it or only the host decides whether it is shown or required; the findings card lists each required field left out and each question on no step.

10. **"Opens as" is a row in the Form settings panel (ADR 0103), on the Form tab, and a select
    on the Journey panel.** A mode may contribute rows to that panel (`BuilderMode.formSettings`),
    drawn under its own heading; the row reads "Opens as", lists "The whole form" and every journey
    by name, and is hidden while there are no journeys. Choosing a journey commits `defaultJourneyId`
    at once through the catalog action `chooseOpensAs`; only `opensAs` is drafted on the form root
    (`BuilderRootSetting`, `setDraftRootSetting`), counted by the unsaved-changes prompt, and committed
    by the panel's Apply as one step of the form's history together with the default (decision 1,
    ADR 0180 decision 1). The Header & footer panel's Apply and Discard commit or drop it too, since
    that panel shares the root's draft. The Journeys mode stays the single owner of
    `FormDefinition.journey`.

    The Journey panel's select, "The form opens as", under its findings card, reads and writes the
    same property (`BuilderMode.rootChoices()`), so both agree after a change from either. Choosing a
    journey makes it the default and sets `opensAs: "journey"` in one catalog edit; choosing the whole
    form writes `opensAs: "form"`. Unlike the Form settings row, this control commits at once, as the
    document menu's "Set as default" does.

    The Default mark follows the real value: a journey's `isDefault` (the Default pill) is true only for
    the journey the form actually opens as, `opensAs` not `"form"` and `defaultJourneyId` (else the first)
    naming it. "Set as default" is `chooseOpensAs`, so making a journey the default also makes the form
    open as it; otherwise the action would change a field nothing shows. The overview's line, "the form
    opens as this", reads the same condition.

### Shell and hosts

11. **Shell wording and adding.** The shell's words come from the mode's `documents.noun`; PDF
    sets `"layout"`. A journey is added from the Journeys overview's New, the command palette's
    "New journey…" and a host's `newDocument` (ADR 0125 decision 6). When the active mode's list
    empties, the page returns to the form; with zero journeys the mode's idle controller holds an
    empty journey and no palette. A move to another mode's tree is drawn in one build: the canvas
    takes the renderer off its runtime while it hands over the tree's adapters and binding, so the
    old tree is never painted with the new renderers. An edit on the same tree keeps the runtime,
    and the tab or step open with it.

12. **Translations.** Journey texts are translations in the form's one map (ADR 0158): a
    journey's name and wording are under the kind `journeys`, keyed by journey id, with each
    page's title, description and wording under `pages › <page id>`; the texts of a
    journey's own node are under `components`, keyed by the node's own id. In the
    inspector each of these fields is one plain box for the default language, and the Languages
    workspace edits the translations.

    The host's translations catalog lists them too: a mode may offer
    `BuilderMode.translatableTexts()`, and the shell lists the form's texts, then each registered
    mode's, in the bar's order. The Journeys mode lists every journey's texts as committed, whether or not its designer
    was ever opened (`journeyTranslatableTexts`), each journey, page and own node a group of its own
    (`journey.<journeyId>[.<pageId or ownId>]`), which no form component id can be: the journey's
    name and wording, then each of its pages' title, description and wording, and each page's own
    nodes' texts after the page's.

13. **Try it runs the journey.** ADR 0141 holds it: the canvas's Try it runs the journey in a
    session of its own, with the Journey card drawing the map with the way taken (ADR 0119).

14. **Hosts.**
    - `<datum-form-builder>` has the mode on by default, with `journeys="off"` to opt
      out. A `workspaces` list without `journeys` (ADR 0125) leaves the side out as a hidden
      workspace does. The API is `journeyMode`, `journeyConfiguration` and the events in the
      guide.
    - The `definition` getter equals the seed byte for byte until the first journey edit: it keeps
      the seed's key order and the seed's own `localization` object while the builder's has the
      same content.
    - `<datum-form-builder>` registers the PDF side with `addMode(mode, { before: "journeys" })`, so a
      PDF side turned off and on again (`pdf="off"` lifted) keeps its layouts ahead of the journeys
      in the command palette's list of documents; a `before` that names no registered mode, or the
      form, appends, which is already the right order while the journeys are off.

15. **Form renames are followed in place.** `BuilderChangeEvent.renamed` reports a form
    component's rename; the mode rewrites every journey's page `components` entries and
    condition paths whose leading segment is the old id (`renameReferencesInConfiguration`), and
    each built designer in place with one `setProperties` under a syncing flag
    (`journeyTreeRenames`), so its undo history survives and the follow-up is one undo step
    per journey. The same step follows the rename into an open tree's own nodes (`fills`, a
    worked-out value's `to`, nested references and the form paths of own rules), and an own node
    renamed in its tree is followed into the journey's own rules and worked-out `value` expressions
    as one step, reported once with the rename (it joins the rename's own history entry), unless it was a node the
    shared rules drop (its id a form component's, a repeated id, an entry ignored): nothing read it, so
    what reads its old id goes on reading what it read. `setProperties` sets a rule in the same entry
    (`target: "rules"`) and puts a node's children whole (`target: "children"`). Where own nodes
    share an id, a follow-up by id would land on the first, so `journeyRenameEdits` writes the root's
    slots whole, every rename in its own place, still one step. A rename and every rewrite it makes
    is one history entry on the form's side (ADR 0180, decision 4). A form deletion is never propagated: it shows as a stale question, so undoing it on the form
    side repairs the journey, and the findings card's "Remove" (ADR 0171 decision 6) clears it
    when the deletion stands, together with the references and worked-out values whose form
    component is gone, in one undo step.

### The Step view and the inspector

16. **A journey is edited on the builder's own canvas, in two views.** Its node types are ordinary
    `ComponentDefinition`s (`journey-components.ts`) with inspectors, so slots, drafts, undo and
    drag apply unchanged. The Map | Step bar (ADR 0171, ADR 0119) offers two views: the
    map draws the whole journey, and the Step view draws one step as a person sees it, with the
    form's binding.
    - A step is filled from the components palette (journey-only fields, never sent) and from the
      Form fields panel (the form's fields). Questions move between steps and rules reorder
      through the Step view, the map's selection bar and the outline.
    - A new journey is one empty step. "Ask it here" (the findings card, the step's inspector)
      places a required field no step asks on the last step every path takes, as one undo step, and
      a step with nothing on it counts as one. The Form fields panel refuses an ending and a Check
      answers step (ADR 0172).

17. **The inspector edits a journey's parts, and each finding is drawn on the node it concerns.**
    A question on a step is the form field's own inspector with "Take it off this step"; a route has
    no inspector box of its own, since its target and condition are the Logic editor's. A step's
    finding is placed by the step's position (`JourneyDiagnostic.pageIndex`, trusted only when the
    page there has the finding's page id), so a step repeating an id carries its own findings, not
    the first step with that id. A route's finding is drawn on that route and a question's on that
    question; the journey's own findings, and a later journey that shares its id, are drawn on the root.
    In the inspector a finding sits under the box that puts it right (a step's id, title, server
    validation or kind, a question's form component, where a route goes). A finding with no box (a
    route's condition, which the Logic editor edits, or a step no path reaches) sits above the
    sections, as does the root's note for a later journey that shares its id; the root's other
    findings are said by the findings card alone. The words are Step throughout: diagnostics are reworded from their
    params, and the code keeps `page`.

18. **Journey-only fields are nodes of the designer's tree, in a chunk of their own.**
    - An own object entry is copied into its page's `content` slot under its own id, with its rules,
      slots and every key as written (`__proto__` included). A reference inside a layout of its own
      is a `journey-field` node with an internal id, like a page's string entry. Written back, a
      question at the top of a page is its component id, a node of the journey's own is written as it
      stands, and a question inside a layout is a reference `{ type: "journey-field", configuration }`;
      a reference read as an object is remembered per question node (`references`, kept by the mode
      beside `pageIds`) and written back with the keys it had. Internal ids are numbered around the
      form's ids, every own id and every page id. An entry the runtime ignores stays in the tree and
      goes back untouched.
    - A page, a route or a journey inside a node of the journey's own is never written: the journey
      is refused, said as a shape problem is. A worked-out value with no field or expression yet, and
      a blank "Fills form field", are left out of the journey as written, as a route with no target
      is (decision 3).
    - The designer's controller takes `canvasRoot` (what the canvas draws, with the own nodes' rules
      left off), `idPrefix` (what a new node is numbered under), `otherSlots`, `claimedIds()`,
      `replaceComponent` and `translatableTextsOf(root, { group, groupLabel })` (the texts
      of a subtree for a mode's catalog).
    - A journey-only field is the form's own type without its data key, PDF options and data source.
      "Ask differently here…" on a form field placed on a step puts one that fills it in its place,
      in one undo step (`BuilderController.replaceComponent`).
    - The designer loads the journey-only fields chunk (`journey-authoring.ts`) before it builds any
      journey's controller, since a controller's types are fixed when it is built; a load that fails
      is said once and tried again on the next activation, the next add and before another journey
      is opened. The mode takes the form's component definitions (`formDefinitions`), as the PDF mode
      does; without them the designer still draws a journey's own nodes and offers no journey-only
      field.

19. **"Ask it here" and the findings that place a field place fields only where every submittable path
    goes.** The place is found with `journeyCertainWalk`: a step the path always takes, not past a route
    that can skip it, and never an ending or a Check answers step. Failing that, they add a new
    unconditional step at the latest such position. A field is asked on a branch only on purpose: off the
    path a field is hidden and not required, so a placement on a skippable step would relax the form's
    Required without a word. A required field stays required on the server. No diagnostic warns of a
    field the author deliberately asks on a branch only: that is the ordinary branching pattern.

20. **`form` and `journey` are reserved journey ids** (`RESERVED_JOURNEY_IDS`), because hosts read them as
    sentinels: `"form"` for the whole form and `"journey"` for the default journey (ADR 0112 decision 6).
    The builder numbers new ids past them (`journey-1`), and a host's `addJourney` with either is refused.
    A file that already uses one still opens, and the Opens-as row keeps its option values distinct
    (decision 10).

## Reasoning

- **The first journey opens as the journey.** If adding a journey left the form opening whole, an
  author would build a journey in the Journeys workspace, try it, publish, and find the published
  form still a single page. The "Opens as" choice would live only in the Form settings panel, on
  another tab; nothing in the Journeys workspace would say the form does not open as the journey
  just made; and the document label's Default pill and the overview's "the form opens as this"
  line would say the opposite, because they follow `defaultJourneyId`, which is only the journey a
  form opens as *when* it opens as a journey. This was preferred over keeping the form opening
  whole and adding a hint, or asking at creation.
- **Opens-as is separate from the stakes.** The stakes of saving a journey (the server accepts
  every journey as a way to submit) are in the Context; decisions 9 and 10 move only which way
  the form opens by default.
- **A journey's own nodes live in the tree.** Putting them in the designer's tree under their own
  ids gives them the palette, canvas, inspector, undo and drag the form's components have, and one
  rename follows them as it follows a form reference.

## Consequences

- An author can make a journey, fill its steps from the form, write the Go to rules between them,
  try it with the map showing the way taken, and choose the default and what the form opens as, in any
  builder that embeds the mode.
- A form's first journey opens as the journey. An embedder that wants a freshly built form with
  one journey to stay single-page chooses "The whole form" or passes `journey="form"` to the
  element (ADR 0112 decision 6).
- Every journey an author saves is a declared way to submit; the builder says so where a
  journey is made and shown, and never offers a journey that starts empty.
- A form rename is one undo step on the form's side, with every rewrite it makes. Its Undo and
  Redo move the id back and again, and each journey follows in place with a single history entry
  of its own (decision 15), so none names an id the form does not have.
- The shell's seams are generic and other modes use them (`BuilderDocuments.noun`,
  `BuilderMode.variables`, `inspector.rules`, `formSettings`, `translatableTexts`,
  `addMode(mode, { before })`, the controller's hooks for a mode's own trees: `nodeLabel`, `idRow`,
  `problems`, `notes`, `fieldChoices`, `fieldPlaceholder`, `foldedSections`, `reservedIds`, and an
  `addTarget` that falls back by a slot's `allowedTypes`). A controller given none of the hooks
  behaves as for any other tree.
