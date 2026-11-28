# Journeys

The decisions are ADR 0112 (journeys and the step model), ADR 0178 (the fold and server parity), ADR 0171
(the Step view), ADR 0172 (the Check answers step), ADR 0115 (journeys in the builder), ADR 0119 (the flow
map, editing on it and Try it), ADR 0121 (journey-only fields) and ADR 0144 (the journey engine seam).

In the builder the word is Step; the definition, the events and the code keep `page`.

A form is written once, its data model and its questions, and asked as a journey: one or a
few questions to a step, branches that go past whole sections, a step that stops the journey, a
step that lists the answers for the person to check, and checks at the end (ADR 0112). Journeys sit on the
definition beside `pdf`, a list that names components by id, the way PDF layouts do; a page is
not a node of the tree, so the tree stays the one form and its data model does not change. A
component brings its subtree onto the page, and may sit on several pages (the same question on
two branches that exclude each other). The site's live demo asks its sixth example this way;
here it is with the server checks a service would add, `eq(path, value)` standing for the
rules language's `{ kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } }`:

```js
journey: {
  journeys: [{
    id: "eligibility",
    name: { default: "Check and apply", locales: { "fr-CA": "Vérifier et demander" } },
    // progress: "none",                      // no "Step 2 of 4" over each heading (absent: the count)
    // heading: "hidden",                     // no page heading: the form's title heads each page
    validation: { end: "server" },            // Submit asks the service first (absent: the browser checks every step at the end)
    texts: { continue: { default: "Continue", locales: { "fr-CA": "Continuer" } } },
    pages: [
      { id: "home", title: "Your home", components: ["mainHome"],
        routes: [{ when: eq("mainHome", "no"), to: "ineligible" }] },
      { id: "ownership", title: "Owning or renting", components: ["tenure"],
        routes: [{ when: eq("tenure", "own"), to: "work" }] },  // an owner goes past the landlord
      { id: "landlord", title: "Your landlord", components: ["landlordName", "landlordConsent"] },
      { id: "work", title: "The work", components: ["upgrade", "cost", "rebateAmount"],
        validation: { server: true } },       // Continue asks the service too
      { id: "contact", title: "How to reach you", components: ["fullName", "email", "apply"],
        routes: [{ to: "$end" }] },
      { id: "ineligible", kind: "exit", title: "You cannot apply for this rebate", components: ["notEligibleNote"] }
    ]
  }],
  defaultJourneyId: "eligibility",            // absent: the first
  opensAs: "journey"                          // absent: a journey whenever there is one
}
```

A step has no condition of its own (ADR 0112): the path reaches a step by falling through to it or by
a route, and every step it reaches is shown, even one with nothing on it or with all its questions
hidden. Nothing is skipped by itself; passing a step by is a Go to rule on the step before it. A page that
carries a `when` is refused, by the browser and by the server (`journey.invalid`). Leaving a step, its `routes` are tried in
order and the first that matches wins — a later page, or `"$end"` — else the path falls
through to the next page; routes only go forward, so the path always ends, and it is a
function of the answers. An `exit` page ends the journey with no Submit, and a submission whose
path ends at one is refused, by the browser and by the server (`journey.exit`). A condition
reads only the answers of the pages already on the path, and of components on no page, so an
answer left on an abandoned branch cannot steer. A component off the path is hidden, never
validated and never required: the landlord's required fields above do not stop an owner. Its
answer is kept, so switching back to the branch restores it, and it is not submitted unless its
own `hiddenValueBehavior` or the journey's `offPathValues` says so. The browser and the sandbox
run one fold of the answers (`kernelFoldSubmittable`), so a server that receives the envelope
works the path out again and lands on the same pages and the same verdict (ADR 0178); the envelope
names the journey (`submission.journey = { id }`) and never the path (see "On the server").
`diagnoseJourneys(definition)` lists what will not work as written: a backward route, a page no
path reaches, a condition that reads a later page, a question on no page — and, for the fields a
journey owns (ADR 0121), an alias filling a field of another kind, a worked-out value
reading another page, a field kept in the browser that fills nothing, each finding naming the
node it is about (`ownNodeId`); their codes are under "Diagnostics for journey-only fields". The
engine exports it;
the `datum-form.js` bundle loads it on demand (`await loadJourneyDiagnostics()`), and
`<datum-form debug>` logs it once per definition.

## In the builder

The builder writes the block too (ADR 0115). The Journeys workspace lists each journey as a document
in the bar's dropdown, after the form and its PDF layouts, each edited over a controller of its own, so
undo and selection survive a move between them. `+` offers "New journey…": a name, "One empty step" or,
when there is one, a copy of a journey. A new journey is one empty step, "Step 1", with nothing on it
(ADR 0112). The bar reads **Map | Step**, and a journey of one step opens on its Step view.

**The Map** (ADR 0119) draws the journey as a flow: Start, a card per step, every Go to rule
as a labelled line from its step, the fall-through to the next step labelled "Otherwise" after a rule
with a condition, endings dashed, and End, which reads "No path submits" when every path stops at an
ending. There are no decision shapes and nothing is passed over. A step with nothing on it reads "No
fields yet". It is drawn Top down or Left to right (`journeyMode.mapLayout`, remembered per viewer under
`persist-panels`, never in the definition), follows every edit as it is typed, and is a lazy chunk loaded
the first time it is shown. It is edited from its bar and its selection bar: **Add step** (after the
selected one, else at the end), **New rule** (from the selected step to the next), and for a selected step
Open, Move up, Move down, Duplicate and Delete (off on the only step), each one undo entry, with the
unsaved-edits prompt. A click selects; Enter, a double click or Open show the Step view on that step; a
click on a rule's label opens it in the Logic editor. The bar counts plainly, "4 steps · 3 errors ·
1 warning". The arrows walk the map, Alt with an arrow follows a way, + - 0 zoom.

**The Step view** (ADR 0171) is the form canvas showing one step as a person sees it: its heading, its
counter, its fields, Back and Continue (or Submit), with the form's binding and the edit chrome on. The
canvas bar carries "‹ Journeys", the stepper "‹ Step 2 of 4 · name ›", zoom, Fit and Try it. There is no
Edit | Preview switch: a journey runs in Try it. A step is filled two ways. The **components palette**
adds journey-only fields (see "Fields only the journey asks"). The **Form fields**
panel on the activity strip, offered in the Step view only, lists the form's fields, "Not on a step" then
"On a step" with the step's name; a click or a drag places one before the step's closing buttons. It
refuses an ending and a Check answers step and says why. An empty questions step says what goes there; an ending and a
Check answers step show an empty zone with no words, since nothing is asked there. Selecting a form field shows the form's
inspector with "Take it off this step"; the step, its buttons and heading, and a journey-only field are
the journey's. A field inside a placed container selects the whole placed group. While the Step view is
up, Undo and Redo step one history over the form and the journey. A press on the step's Back or Continue
opens its Wording section.

**Go to rules** are the only way to move between steps other than falling through. The Logic workspace
lists them as "Go to a step" rules (ADR 0127), and a route has no Rules tab and no inspector box of its own:
its target and condition are the Logic editor's. The editor has the formula box (ADR 0140) and the rule's own
rows:

- **From**: fixed once the rule is saved. For a new rule it is a select of the steps that can have a rule
  (an ending or a Check answers step cannot), grouped by journey when there are several.
- **Go to**: a later step or "the end", never an earlier or the same step. A stored target that the path
  would ignore stays listed, so the box says what is stored.
- **The condition**, with its Reads as line and its Try it, which answers "Goes to X" or "Not taken".
- **"Tried 1st of 2 from this step"**, with Move up and Move down, on a step with more than one rule. A move
  is applied at once, one undo entry each, and a warning shows when a rule before this one always matches. A
  new rule goes before the step's first rule that has no condition, else last.
- **"Pinned by"**: the tests that read the rule.
- **Remove rule.**

Apply writes the route's `to`, `when` and position on the journey's controller in one undo entry; the form's
controller is not written. The editor opens from a rule's label on the map, New rule on the map bar, the step
inspector's Logic tab and the Logic workspace's own list. A request made before the surface exists is held for
ten seconds. A selected step's inspector has **Step | Logic**; Logic lists its rules in the order they are
tried, "Otherwise" last, each opening in the editor, with New rule. A condition reads only the answers of
steps already on the path. The Variables panel lists what it may read.

**The Journey panel** (the root inspector) leads with a **findings card**: errors, then warnings, from
`diagnoseJourneys`, each with its fix ("Ask it here", "Make it optional on the form", "Remove"), and
pressing a finding selects its node and brings the Step view to that step. Then "The form opens as" (ADR
0115), which commits at once and keeps focus across the repaint, then the journey's name, Progress (Count the steps, or None), Step heading, Answers off the path,
validation ("On Continue": move on and check at the end, or check each step; "The check when the person
submits") and Wording. A step's inspector holds its id (labelled "Step id", its box showing the step's node id as the
placeholder a blank id is written as), title, description, Kind (Questions, Exit or Check answers) and the
validation and wording it overrides; the Wording sections of the journey and of a step start folded. The ID row is
read-only on the root, showing the journey id, and hidden below it. Findings never hold Save back; only a step id changed
to one another step or a form component already has does. Form rules always hold (ADR 0178): a question on
no step is judged exactly as the whole form judges it, so a required field no step asks blocks every
submission through the journey, and the builder marks it as the error it is (see "Questions no step asks").
One exception: a left-out question whose visibility reads `host.` stays hidden and unchecked on both sides,
and the builder names it as a warning. Every journey saved is one the server accepts a submission through,
whatever `opensAs` says, which the builder says wherever a journey is made.

**Try it** runs the journey with the edits as they stand, drafts included: the answers survive each
edit, server checks are off, and Submit checks the answers as a submit does, sends nothing, and is
answered "The journey would submit here" or taken to the first step with an answer to fix. The Journey
card holds the real map, read only, marking the current step and the way taken so far (ADR 0119); the
path line and Restart stay, and "Open this step" opens the Step view on the step the run is on. Recording a
test from Try it writes `change <field>` for a Change link (docs/form-tests.md).

**Where "Ask it here" puts a field.** "Ask it here" and the other findings that place a field put it only
where every submittable path goes: on the last step the path always takes, never on an ending or a Check
answers step, nor past a route that can skip it. Failing that, they add a new unconditional step at the
latest such position. A required field stays required on the server, and no finding warns of a field the
author deliberately asks on a branch only: that is the ordinary branching pattern.

**Journey ids.** `form` and `journey` are reserved ids, because hosts read them as sentinels (see "Which
journey opens"). The builder numbers new ids past them (`journey-1`), and a host's `addJourney` with either
is refused. A file that already uses one still opens, and the Opens-as row keeps its option values distinct.

**What the builder writes back.** A journey read into the designer and written back unedited is the one read, and
a second round trip is identical to the first, so opening every journey leaves `definition.journey` as it was.
Every key the builder does not know stays, on the block, on each journey, page and route, in `texts` and in
`validation`. A blank step id is written as the step's node id (made unique among the steps). A route to a step
becomes that step's id; a route whose target step was deleted keeps the id that step was last written under, so it
shows as `route.unknown-target` rather than vanishing; an unknown target from the file stays; a route with no
target and a question with no component are left out. The journey's keys are written in the builder's own order (`id`, `name`, `progress`, `heading`,
`offPathValues`, `validation`, `texts`, then the keys it does not know, and `pages` last), so `heading` follows `progress`. A blank select is an absent key, `"true"` and `"false"`
become booleans, `kind: "questions"` is absent, and empty lists, empty objects and blank texts are absent.

**Check answers** is a step kind (ADR 0172), chosen in the step's Kind box. The Step view draws the real
list over placeholder answers, pressing a row opens a Wording box for it, and the inspector's "Answers
listed" section is a read-only list of what the step will show (a line with the count, then each step that asks
one and its answers, worded as the row will be), with Not provided (`emptyOptional`), Show Change links
(`change`) and a Wording box for a row. A Check answers step
places no form field, so the Form fields panel refuses it, and the map names it "Check answers · 7 listed".

The first journey also writes `opensAs: "journey"`, so the form opens as that journey until the author
says otherwise in the Journey panel's or the Form panel's "Opens as" row (ADR 0115), which lists the whole
form and every journey by name. The journey's `⋯` menu renames it (the id stays), copies it, removes it
and sets it as default, marked Default in the dropdown. Journey texts are translated in the per-node
grids and listed in the builder's translations catalog after the form's, keyed
`journey.<journeyId>.<pageId>.<prop>`, and a form component renamed on the form's side is followed into
every journey. `<datum-form-builder>` has the mode on by default, reseeded on Open and New: `features="-journeys"` leaves it out, the
definition's journeys passing through untouched, and a `workspaces` list without `journeys` leaves the side out as a
hidden workspace does; the Form panel's "Opens as" row has a link, "Open the journeys", to the default journey; `journeyMode` is its catalog API and
`journeyConfiguration` the block as edited (assigning it reseeds the journeys, and a shape the builder refuses is
reported as `journeys.invalid` and leaves them as they are); `modes` lists `"journeys"`; `datum-journey-change`
(`{ journey?, configuration, definition, reason }`, `journey` being the one edited, added, renamed, copied,
removed or made the default; a page or journey given another id also carries `renamed: { journeyId, from, to }`)
and `datum-journey-select` (`{ journeyId, journey }`) report it;
and `definition` is the one given, byte for byte, until a journey is edited, keeping the seed's key order and its own
`localization` object while the builder's has the same content. `datum-builder-change` reports mode `"journeys"` with
the reasons `"journeys"` (the catalog) and `"form-rename"` (a form component's rename followed, with `renamed` on
the event). The Variables panel takes a `"conditions"` syntax for a rule's condition: fields and functions, with no
`row.`, `ancestor.` or `host.` paths. A host that replaces or renames a journey whose designer is built but not on
the page has that designer follow: a name alone goes into its tree, any other change builds it afresh when it is
next shown.

A **one-step journey** is another way to fill the same form, such as a short public version (ADR 0112 and
ADR 0121). With `heading: "hidden"` — the journey's "Step heading" setting in the builder — no step
heading is drawn: the form's title heads the page as it heads the whole form (the chrome draws it when no `form-title`
part does, and a form that shows no title has no heading on the page either), the step's description opens its
fields (`<p class="datum-form__journey-description">` in Datum's drawing), no count is drawn, and focus on a step
change goes to the step's `<form>`, which carries `tabindex="-1" data-journey-page-focus` and no `aria-labelledby`
(so does a step that is untitled, and the fallback when a binding's heading cannot take focus; Tab from there
reaches the first field, and its focus ring is off). The builder does not draw the Progress help line while the
heading is hidden, and does not report `page.no-title`, since no heading would show the step id. Neither
`validateJourneyShape` nor the kernel checks the key, and any value but `"hidden"` reads as shown. Running, a one-step
journey draws no Back, and a Submit unless the step holds the form's own.

### The map in detail

- **Facts.** `journeyFlow(journey)` (`core/journey/journey-flow.ts`, engine-root API) takes no form. It is built
  on `diagnoseJourney`'s own walk graph and search (`journeyWalkGraph`, `exploreJourneyWalks`), so a step the
  map draws as unreachable is `page.unreachable` and an End that reads "No path submits" is `journey.no-end`.
  It adds which ways are live, the "Otherwise" of a fall-through and the ignored routes with their reasons,
  ranked unknown target, self, backward, exit, review, shadowed. A route is numbered `n · …` when its step has
  more than one way out, and a route that always matches ends the list: nothing falls through after it and
  the step's later routes are rows saying so. A Check answers step has one line, to End, and its routes are ignored. A step whose fields may all be hidden has one line on too.
- **Ids.** Each way has a stable id from the step it leaves and how: `start`, `route:<step>:<index>` with the
  route's written position, and `next:<step>`, `<step>` being the designer's node id (`journeyMapEdgeId`).
  Renaming a title or a condition keeps them, and Try it uses them to mark the ways taken.
- **Cards.** A card's meta line reads "income · 3 questions": questions are a step's references and its own
  fields however deep in its own layouts, an alias counts as one, and a worked-out value, a paragraph, a button,
  a layout and a type the mode says holds no answer (`isValueless`) do not. Notes under it name what the step
  fills and works out, "Fills Email", "Works out Annual income", each form field once in step order, joined
  "Email, Name and Phone" and cut to the card's width (the card's description, its `aria-label` and its tooltip give the whole text), from the shared ownership (`JourneyCheck.ownership`) so the card never names what
  the runtime ignores; with no ownership nothing is named. Findings on any node in the step, own nodes
  and the references in their layouts included (placed by `ownNodeId`), count on its badge once however many nodes share an id. `JourneyDiagnostic.pageIndex` places a
  finding on the step at that position, trusted only when that step has the finding's step id.
- **Layout.** Direction is Top down or Left to right (`journeyMode.mapLayout`). One in-house deterministic
  layered layout serves both (`journey-map-layout.ts`): ranks on doubled layers, a virtual vertex per layer an
  edge crosses, barycentre sweeps whose swaps are kept only when they cross less, an alignment that keeps the main
  line straight first, coordinates that never overlap, and a track of its own in each gap for every line that
  moves sideways. Lines cross no box and no label. Colours come only from `--db-*` tokens, aliased once on the
  surface, so every builder theme restyles the map. The picture's text is drawn at the fixed sizes its layout
  measures; everything around it reads the type scale. A palette drag over the map stops at it, so it never aims
  at the sheet the map hides.
- **Selection.** A step selected anywhere (the outline, the inspector, the Step view, an undo) is marked on its
  card with `aria-current`; a route is marked on its label or row and its step as holding it; a question marks
  its step; the root marks Start, and End selects it too. A selection made elsewhere is scrolled into view
  below the sticky head and clear of the side drawer; a map shown afresh brings the selection, else Start,
  into view.
- **Zoom.** 25% to 200% in steps of 1.25. Fit fits across the flow only (the width Top down, the height Left to
  right), less the page's padding and the map's head, never below 60% (the 11px text is then about 7px, the
  least that still reads) and never above its own size; 100% draws at its own size. A new journey or a direction
  fits again. The viewBox stays in the layout's units. Zoom in and Zoom out are `aria-disabled` at 200% and 25%;
  a zoom by the author keeps the focused item in view, and the scale is said in a `role=status` once the steps
  rest.
- **The head** (the bar, the zoom, the status line) sticks to the canvas page's top and left edges, clear of the
  side drawer, so it stays in reach scrolling either way. The drawer lies over the canvas's start edge, so the
  head and the foot (the counts) stick clear of it: inside the canvas the shell's `--db-side-w` is how far the
  drawer reaches (`0px` while it is folded, `.wrap[data-side-collapsed]`), and the surface's `--jm-cover` is that
  reach, less what would leave the head under 160px wide. The picture itself is covered where the drawer lies, as
  every canvas surface is. The counts are announced in a `role=status` of their
  own only once they rest, never per keystroke.
- **Keyboard.** The picture is one tab stop, and focus is not selection, so arrowing never raises the
  unsaved-edits prompt. The arrows walk the items in reading order (a step, its ways out in try order, its
  ignored routes, the next step); Alt with an arrow follows a way to where it goes, or back to where it came
  from; Home and End; Enter or Space selects, and Enter on a step also opens it in the Step view; a double
  click or Shift+Enter opens it; Delete or Backspace on a step deletes it, and focus then goes to the step that
  takes its place; `+`, `=`, `-` and `0` zoom, never with Ctrl or Cmd, which stay the browser's and the canvas's
  (Cmd+Z undoes the journey); Escape clears the highlight. Focus or hover lights a node's lines and dims the
  others; text is never faded.
- **The bar** is a toolbar, one tab stop with the arrows between its buttons (Direction, Zoom, and Add step and
  New rule when the map edits), `aria-pressed` on the choices, names holding what the buttons show ("100%,
  actual size"); the direction arrows are `aria-hidden`. The selection bar is a toolbar named "Selected step: {name}".
- **Accessibility.** The SVG is `role=group` with `aria-roledescription="journey map"` and a label that says
  how to move in it. Every item is `role=button` with a full `aria-label`, written in reading order (a step's
  card, then the labels of its ways out, then its rows) so a screen reader's browse order is the arrows'; no
  button sits inside another; plain lines and labels that are not items are `aria-hidden`. An item's tooltip
  `<title>` sits with its picture in an `aria-hidden` group inside the item, since a `<title>` of the item's own
  becomes its accessible description (SVG-AAM) and Chrome would read a card's sentence twice, a label's words
  after its route's. Every step, way out and stub carries its full sentence, so no second list of the map is kept:
  a hidden duplicate would be read twice in browse mode. In forced colours the aliases every rule reads become
  system colours (Canvas, CanvasText, GrayText, Highlight), since inside SVG nothing is forced and the state
  rules outrank any rule of the block's own; a disabled button keeps GrayText. Colour is never the only signal:
  endings are dashed, ways no path takes dotted, an ignored route has ⊘, findings ▲n, and every label has words.
- **Drawing cost.** The SVG is a pure string (`journeyMapSvg`), written only when it differs from what is shown,
  drawn at most once per task, with each layout kept per input (four kept) and the graph facts per designer view.
  Selection, highlight, roving tab stop and zoomed size are laid on after each write, and focus goes back to
  the item that had it. `show` is idempotent: the mode shows the map on every form change, and the same journey
  again only catches up on the selection and the room it has; a new journey is drawn afresh and fitted. Hidden,
  the map only notes it is stale (a form edit made on another tab too, which the mode passes on) and catches up when shown; its size observer runs only while it is shown, on the
  scroller's border box, which the scroller's own scrollbar never moves, so a fit that brings a scrollbar on
  cannot refit in a loop.
- **A tree that cannot be written** keeps the last map that could be drawn: its lines muted at full strength
  (never faded under 3:1), the picture outlined dashed, its words whole, the `journey.unwritable` message above
  it, and nothing absent from the tree selectable.
- **In Try it** the Journey card holds a kept, live, read-only map instance (`setState({ currentNodeId,
  takenEdges })` marks the current step and the ways taken by class only, and scrolls the current step into
  view; `readOnly` removes selection and editing and keeps zoom, the walk keys and hover). The runtime's last
  trace (`FormRuntime.journeyTrace()`) gives the ways taken, so only the ways behind the current step are marked
  and Back unmarks what it leaves; a step reached by a Change link says so and where Continue returns. The Try
  panel rewrites its HTML on every render and keeps only nodes a mode names (`BuilderModeTryIt.kept`, `drawn`),
  moved from the old markup to the new inside one task with scroll and focus put back, so typing an answer does
  not rebuild the map. In the Journeys workspace the Try column is 400px wide and the map's stage is a
  fixed-height window that keeps the current step in view, its direction and zoom bar off.
- **Remembered per viewer.** `journeyMode.mapLayout` is `{ direction: "down" | "right" }`, assigning it draws a map
  on the page again, and where the host remembers panels (`persist-panels`) it is kept under
  `datum-builder:journey-map:<key>` in the same store as `{ version: 1, direction }`, read strictly (anything
  else is none), and written under the key the host gives at the time: nothing is written once it drops
  `persist-panels`. The zoom and the view are not remembered.

## The running page

The page draws a heading that takes focus on Continue, Back and a jump (`journeyHeading`, the
count inside it), its components, and Continue — or Submit on the last step, unless the step holds a
submit or download button of the form's own, which keeps passkey signing and custom submission modes — with
Back beside them on every step but the first (`journeyActions`; a steps container's own Back is the
`stepBack` part). Enter continues, and submits on the last step. While a move or a server check is out the
buttons are `aria-disabled`, never `disabled`. Focus goes to the heading after a forward, back, jump or Change
move and to the first error after an error move. The count, "Step 2 of 5" (the `pageOf`
text), is drawn unless the journey's `progress` is `"none"`; it counts the steps on the path that ask
questions or check answers, so an ending is not counted. The wording (`back`, `continue`, `submit`,
`pageOf`, `checking`, `serverUnavailable`, and for a Check answers step `change`, `changeHidden`,
`notProvided`, `enterAnswer`) is a step's `texts` over its journey's, over the host page's `texts` and the
binding's language pack, each per locale ([docs/translation-support.md](../translation-support.md)).

**Checking is on Submit.** `validation.continue` absent is `"defer"`: Continue moves on, and Submit checks
every step on the path, taking the person to the earliest step with an error. `"page"` checks a step on
Continue and stays while an error blocks; a deferred step that already holds an error is checked on
Continue so a fix can be confirmed. `validation.server` on a step is ignored while the step is deferred.
A blocked submit, a rejected submission or `setErrors` opens the earliest step holding an error, except
from a Check answers step, which stays and lists them; a draft resumes on the step the person reached, and resuming checks no deferred step.
Read-only and PDF render every answer, never one step; a print follows the person's path, each step on it a
headed section in order (ADR 0035); a live print also brings, from each step off the path, only the components whose
`print.show` is `"always"`, placed by the journey's order and marked off the path ([docs/print-support.md](../print-support.md)).

After every change the completed steps are kept to the path as the answers now draw it, so changing an earlier
answer that reroutes the path drops the completion of the steps that left it. Errors on no step stay in the
summary, which is scoped to the step. A draft carries the journey, the step and the completed steps, and never
the result of a server check.

## Check answers

A step of kind `review` (ADR 0172) lists the answers the person has given, by step, and sends them. It is
the last step of the journey, one per journey, and holds no form field of its own; it may hold content of
the journey's own, such as a declaration. The path ends there with a submit and never tries its routes.

```js
{ id: "check", kind: "review", title: "Check your answers",
  components: [{ id: "declaration", type: "html", configuration: { content: "By sending this you agree." } }],
  review: { labels: { fullName: "Your name" }, emptyOptional: "notProvided", change: true } }
```

- **What is listed.** The answers of the questions steps on the path, in path order, under each step's
  title. A field is listed under the earliest step on the path that asks it. A hidden field, a field off
  the path and a journey-only field are not listed. A row shows the label (or `review.labels[id]`, a plain
  string translated at `journeys › <journey id> › pages › <page id> › review › labels › <component id>`),
  the answer in words as print words it, and a **Change** link named "Change {label}". A required field
  with no answer reads "Enter {label}" and links to its step. An optional field left blank reads "Not
  provided", or is left out when `emptyOptional` is `"omit"`. A data grid or repeating section is one card
  per row, titled by the row's heading, with one Change.
- **Change and return.** Change calls `goToPage(id, { direction: "change" })`. Continue or Back from the
  changed step goes to the first step on the path not yet completed, else back to the Check answers step, so
  a changed answer that adds a step asks it before returning. Any other move gives the return up.
  `datum-page-change` reports the direction `change`; the runtime's `PAGE_CHANGED` also carries `returnPageId` while a return holds, and
  `beforePageChange` sees the direction. The runtime keeps the return target (`JourneyState.returnTo`, also in the draft). A change is
  allowed to a completed step or to the first step not yet completed, never to the Check answers step itself; a jump, a blocked submit's
  move, a restart or a path that no longer takes the Check answers step gives the return up. `change: false` draws no Change links.
- **A blocked send stays.** A failed submit from the step does not move to the earliest error: the step lists
  each error on its row, an error summary links to each, and Change opens the step.
- **Diagnostics.** Errors: `page.review-repeated`, `page.review-not-last`, `page.review-form-field`. Warning:
  `page.review-bypassed`, a route to the end from an earlier step that submits without passing it.
- The Datum binding draws it (`datumReview`: a `div[data-journey-review]` with a heading and a description list per step,
  `part="review"` and `part="review-card"`); a binding supplies `review` to draw its
  own, as the GOV.UK binding does with a `govuk-summary-list` per step and a `govuk-summary-card` per data-grid row. The list's code is part of the journeys files and
  loads only for a journey that has such a step. A Change link's name is "Change {label}", with the words after
  "Change" visually hidden, and after a change the list takes focus back to the row that was pressed. The
  step's page scope holds no form id on either side.

## Fields only the journey asks

A step may also hold fields of its own (ADR 0121), which the builder words journey-only. The live step is
then drawn from the form's root with one more slot for them (`FormRuntime.journeyRenderRoot()`); a review, a
printed copy and a PDF draw the form alone, so such a field never shows there. Its answer stays in the
browser, at `@<journey id>.<field id>`, and is never sent, printed or exported. An alias
(`configuration.fills`) is drawn with its own label, help and Required marker, and reads and writes the form
field it fills, taking that field's hidden, disabled and read-only state. A worked-out value
(`type: "journey-value"`) is drawn as a read-only copy of the form field it sets — that field's type and
options, and its label unless the node has one — with the line "Worked out from your answers" (the
`workedOut` text), which describes the control. A reference inside an own layout draws the form component it names in its place, once. A
form field's errors show under the alias or copy standing for it, and the summary's link and the first focus go
there (see "Errors" under "How journey-only fields run"). On `<datum-form>`, `values`, `datum-change` and `datum-submit` carry the form's answers alone:
`presentationValues()` returns the own answers by field id, and drafts keep them. A write to an own field is
not reported as `datum-change`; a worked-out value it moves is, as a change of that form field.
`packages/datum/demo/presentation.html` shows a journey with an alias and a worked-out value beside a
one-step journey, and what is submitted beside what stays in the browser.

The builder authors them (ADR 0121). In the Step view the palette lists the form's own groups (Fields, Choices, Layout, Content, Actions), whose members are
journey-only fields, and a Journey group that holds the worked-out value. A journey-only field is the form's own
type without its data key, PDF options and data source; repeating sections, data grids, files, signatures, steps,
a plain `container` and anything that scopes data are not offered. A layout of the step's own takes journey-only
fields and Form fields, in every slot, never steps, routes or worked-out values. A new node gets an id nothing
else has: not a form component's, not another own node's, not a step's; a worked-out value is numbered
`worked-out_n`, since `journey-` is the designer's own prefix. An own node's id is edited in its ID row, and an id
the form, a step or the designer has holds Apply back.

Each is drawn as the real field with a "Not sent" tag, "Fills: Email", "Worked out into: Annual income", and a
note tag for its own rule, "Shown when …". The Step view draws a copy of the step whose own nodes carry no rules
and no `hidden` flag, so a rule worked out over blank answers never hides the field being edited. "Fills" is said
only of an alias the runtime takes (`aliasOf`); one filling a field that is gone, worked out or otherwise unusable
is "Not sent". Of several own nodes on a step sharing an id, each carries the findings about it.

The inspector of a field that holds an answer starts with "Fills form field", which offers only the form's value
fields its answer fits (a choice's options must be among the field's) and the journey does not place already;
one that fills nothing is "kept in the browser: checked here and kept in drafts; never sent, printed or exported."
A worked-out value picks its form field the same way, less any an alias fills. On the Rules tab a worked-out
value has "Worked out as" (its expression), and its field box offers the own fields of its step. A journey-only
field has the form's conditions for its type (shown, required where the type offers Required, enabled,
read-only) and never a calculation or a default; its box offers the form's fields and the journey's own, while a
step's or a route's condition reads the form's fields alone. "Ask differently here…" on a form field placed on a
step, beside "Take it off this step", puts a journey-only field of the same type in its place, filling it, with
the label, help, options and constraints (required, pattern, lengths, `min`, `max`) copied and a fresh id, as one
undo step, and selects it, so the author can word it differently.

The fixes under a finding are actions: `map.target-conflict` offers "Remove this worked-out value" and
`field.goes-nowhere` "Fill a form field…", which selects the field with its picker first. They sit under their
finding in the inspector and in the Journey panel's findings card; the other findings say what is wrong and leave
the fix to the author. Focus follows each fix ("Ask differently here…" to the new field, "Remove this worked-out
value" to the step that held it, "Fill a form field…" to the "Fills form field" box, "Ask it here" to the field it
placed, "Make it optional on the form" to the field on the Form tab); when a fix takes away the control that held
focus, focus goes to the next finding, else the panel's active tab. "Ask it here" and the Form fields panel insert
before the step's closing buttons. "Remove" on a question whose form component is gone also takes off the
references inside own layouts and the worked-out values whose form field is gone, in the same undo step, and "Ask
it here" never numbers a new question under the node id of a deleted reference written as an object. An input two
required calculations read offers one "Make … optional on the form" per calculation, each named. A worked-out
value with no field or no expression yet, and a blank "Fills form field", are left out of the journey as written,
as a route with no target is, since either would fail the shape check and stop the journey from being saved.

A page, a route or a journey inside a node of the journey's own is never written: the journey is refused, said as
a shape problem is. Internal ids in the designer's tree are numbered around the form's ids, every own id and every
step id, and a step written under its node id (its id left blank) is read under that id again. The controller
finds only the first of two nodes sharing an id (an own id repeated, or one named `journey`). An own entry the
runtime ignores stays in the tree as written and goes back untouched. A rename of a form component is followed
into an open journey's own nodes (`fills`, a worked-out value's `to`, nested references and the form paths of own
rules) as one `setProperties` step, and an own node renamed in its tree is followed into the journey's own rules
and worked-out `value` expressions (bare id paths) as one step, unless it was a node the shared rules drop, which
nothing read. Their texts are in the translations catalog under `journey.<journeyId>.<ownId>.<prop>`. Try it
indexes the journey-only fields afresh on every edit, so a field dropped in is asked at once, and a rebuilt Try it
runtime keeps the journey's own answers (`@<id>.<own id>`) and drops any other journey's. A host lends the form's
definitions (`formDefinitions` on the mode, as `<datum-form-builder>` does); the journey-only fields are a lazy
chunk of their own, loaded with the designer, and without the definitions the designer still draws a journey's
own nodes and offers no journey-only field.

### What a step may hold

A step's `components` is `(string | node | reference)[]` (`JourneyPageEntry`). A string is a form component,
drawn exactly as on the form with its subtree. An object is one of the journey's own:

- a **journey-only node** `{ id, type, configuration?, rules?, children? }`: a field, text or layout;
- an **alias**, a journey-only value field with `configuration.fills` naming a form field;
- a **worked-out value**, a node of type `journey-value` (`PRESENTATION_VALUE_TYPE`) with
  `configuration: { to, value, label? }`, `value` being formula text or the object form (ADR 0139);
- a **reference** `{ type: "journey-field", configuration: { componentId } }` (`PRESENTATION_REFERENCE_TYPE`),
  usually inside a layout of the step's own. Alone in the step's list it places its component as an id does.

`validateJourneyShape` and the kernel's `kernelIsJourney` accept the same shapes, and a table test holds them
to one verdict: a malformed shape makes the browser drop the journey and the kernel answer `journey.invalid`.
An entry that is well formed and cannot be used is ignored the same way on both sides, by rules read from the
definition alone (`core/journey/journey-path.ts`, spliced into the sandbox program), and the builder reports
each one. A node that breaks A, B, C, H or I drops its whole top-level entry; D to G drop only what they name: the
reference, the alias's `fills`, or the worked-out value.

| Rule | An own entry is ignored when |
|---|---|
| A | A node's id is not a component id (a letter first, then letters, digits, `_` or `-`; not `constructor` or `prototype`), is a form component's id, or is the id of a node met earlier in the journey. |
| B | Its type is a repeating section, a data grid, a file, a signature, a steps container or a step. |
| C | It binds data of its own: a `collection`, a `dataKey`, or a data-scoping container (a `container` that does not say `scopeData: false`). |
| D | A reference names no form component, or the root. |
| E | What an alias fills or a worked-out value sets is not a value leaf of the form: it is the root, holds no answer of its own, sits in a repeating section or a data grid, or is calculated (`rules.value`). An alias is then a plain own field and a worked-out value is ignored. |
| F | An alias holds no answer itself (`fills` on a layout, say): its `fills` is ignored and the node is what its type makes it, content, or a layout when it has children. |
| G | A worked-out value's target is placed another way on any step (listed, referenced or filled) or worked out by an earlier node. |
| H | The journey's own id is not a component id: every own entry of it is dropped, so own answers always live under `@<journey id>.` exactly and two journeys never share them. A journey of component ids alone owns nothing, so a hand-written id outside the grammar keeps working there. |
| I | An own field's answer key `@<journey id>.<own id>` is a key the form defines (a hand-written collection path, a data path or a container named with `@`; an alias counts, since were its target unusable its answer would live there). The form's keys are the kernel's allowlist without the entry shapes (`journeyFormKeys`, held to `kernelKnownKeyShapes` by a test). |

Several aliases may fill one field, on branches that exclude each other, say. Ownership (`journeyOwnership`)
is what the runtime, the kernel and the builder all read: a string entry places a form component with its
subtree, a usable own entry is a member of its step with each of its nodes under its own id (`ownNodes`), a
reference places the form component it names, an alias places its target (`aliasOf`) and a worked-out value
places its target (`workedOutOf`). Ancestors of anything placed that are on no step themselves are structural,
so a target inside a section that is on no step is still shown and required. A context that names a step
(`context.page`) gets `pageComponentIds`, the form components in scope for it by the kernel's own placement;
the submissions service's `pageScope` reads the same ownership. No step is passed over for being empty: an own
entry that references, fills or works out components whose visibility rules hide them leaves its step on the path.

### How journey-only fields run

- **Where answers live.** A journey-only field's answer is at `@<journey id>.<field id>` (`isPresentationKey(key,
  defines)`: it starts with `@` and the form does not define it; paths may start with `@` in their first
  segment only). An alias has no copy: it reads and writes the value path of the form field it fills. A
  worked-out value holds no answer either; the runtime writes the form field it works out
  (`presentationValuePathOf(id)` says where any node's answer lives; the runtime hands it to the component models
  as value-path overrides, and the render layer derives none of this again). The journey-only index
  (`core/journey/presentation.ts`) runs in the browser only and is never spliced into the sandbox program; it reads
  the shared ownership and does not decide placement again.
- **The form pipeline never sees them.** Calculations, the fold, validation, the sandbox request, the envelope,
  step and end checks, PDF, CSV, and the data-source and submit-hook contexts are built from `formValues()`,
  the state without own answers, so a form calculation that reads an own id gets nothing. Drafts keep own
  answers in every store and in the draft file, and the `draftStore` seam takes them with the rest.
- **The kernel knows no `@` keys.** A key a client sends is an unknown key of the form's: `unknownFields:
  "strip"` drops it, `"keep"` keeps it unread (a kept key steers no calculation, rule or route, though plugin
  validators still receive it), `"reject"` answers `unknown_field`. The kernel reads no own node's rules and no
  worked-out value's expression. A form that defines a key starting with `@` keeps it as form data.
- **Worked-out values** are computed in the browser from the step's own fields that show, in up to three rounds.
  A value is written once at least one readable source is answered, and is not marked dirty. When every source
  is empty again the runtime clears only a value it wrote itself (`state.journey.written`, kept in drafts), so a
  prefilled or drafted answer stays until a source is answered; once a source is answered, an expression that
  throws or gives nothing empties the form field, a prefill included. When the form field already holds exactly
  what the expression gives, the runtime takes it as its own write. A resumed draft is worked out from its own
  answers alone, so a source hidden under the draft's answers is never read, a `written` entry whose field
  the running journey does not work out is dropped, and a resume without `written` keeps what it finds. Values that do not settle after three rounds raise one
  blocking form-level error, `map.unsettled`, on Continue and on submit.
- **State and checks.** An own node's state is laid over the fold's settled view and never fed back into the
  fold, which is the server's too. One merged lookup, the overlay first and then the form's, backs
  `effectiveState`, `isRequired`, `requiredMap`, the hidden-error policy and the stale-error sweep. An alias takes the form field's visible, disabled and read-only state and is required by its own tick or
  rule, or by the form field's; an alias of a hidden form field is hidden, so its own Required and checks never
  apply whatever the form field's hidden-validation settings say. The copy of a worked-out value is read-only. An
  own node on a step the path skips is hidden, and never validated or required. A visibility rule on a node that
  is, or holds, an alias, a worked-out value or a reference is never read (`own.hides-form-field`). Own fields
  are checked by their own rules in a stage of their own (`presentation-fields`): Continue holds a step to its
  own fields and the form fields placed on it, and a submit judges the whole path the same way. Own fields that are off the path or hidden never block.
- **Errors.** `JourneyView.hosts` maps a form field to the own node that stands for it on the current step, the
  first alias that shows, else the worked-out copy, and its errors are shown there and counted for it, never
  beside a field that is not drawn; the summary's link and the first focus go to the node. A host's error on an own
  node (`setErrors` with its id) stands until that node's answer changes, as on a form field. When the node
  already shows the same code with the same message the second copy is dropped. `datum-page-change`'s
  `errorCount` counts the errors as the step draws them. Outside the live step no own node is drawn, so a
  review or a printed copy shows an alias's errors on the form field it fills, once, and leaves out any other
  own node's. Leaving the journey clears the errors on its own nodes and stops its worked-out values; what
  they set stays as ordinary answers.
- **`clientDerived`** (`kernelClientDerived`; on `KernelOutcome`, `WasmSubmissionOutcome` and the submissions
  service's `SubmissionRecord`, with a log line) lists the value paths of the judged answers that were worked
  out in the browser and kept as sent: the target of a worked-out value that is on the path, or kept off it
  (`offPathValues: "retain"`), a calculation the kernel could not reproduce while a value was there, and any
  calculation reading one of those. It is present only when there is one, for forms without a journey too. An
  alias is never listed: its answer is the person's own. The server holds a filled form field to its kind
  (ADR 0122), so a forged non-numeric answer worked into a `number` field is refused with `number`.
- **Drawing.** `journeyPageComponents` draws the form component a reference names in the reference's place, with
  its subtree and inside its layouts; a component already drawn on the step is not drawn again, and a submit
  button of the journey's own, or one a reference names, is the step's own Submit. An adapter that draws the
  worked-out line itself answers the `workedOut` capability `drawn`; otherwise the renderer draws it in the
  field's wrapper. A host's data-source set is handed `formValues()`, not the raw state.
- **API.** On `FormRuntime`: `formValues()`, `presentationValues()` (own answers by own field id, aliases not
  listed, `{}` when none), `presentationIndex()`, `presentationValuePathOf(id)` and `journeyRenderRoot()` (the
  form root plus a last slot, `@presentation`, holding the `@<journey id>` container). `datum-page-change` takes
  its title from the combined root. A worked-out value is reported as a change of its form field whatever write
  moved it (an own field it reads, an alias's form field, a form answer that hides one of its sources), typed or
  final as that write was.
- **What is not supported.** An own field that names a data source draws its inline options alone: neither the
  runtime nor a host's data-source set is asked for it (a worked-out copy is drawn with its form field's
  options, from the host's set when that is where they come from). An entry that binds data breaks rule C, so
  nothing of it is drawn; nothing throws on either. Journey-only fields hold no repeating sections, data grids,
  files, signatures, steps or data-scoping containers, no targets in repeating sections or grids, no
  worked-out sources on another step, and no own `rules.value` or `defaultValue`.

### Questions no step asks

A journey leaving a form field off every step does not relax the form. The builder reads it as the fold does:

- A required form field left out is an error, `component.unassigned` with `required: true`, when the field has
  `configuration.required` or `rules.requiredWhen` (read by truthiness, as the fold reads it; `requiredWhen:
  null` is no rule). The fixes are "Ask it here" and "Make it optional on the form". `requiredField` is the
  field whose Required it is: for a data-scoping container left out whole, the first field in it a step can ask
  (else the first hidden for good that opts in), and what "Make it optional on the form" opens.
- Every other omission is a warning per field, under one summary on the journey, `presentation.fields-left-out`,
  whose stakes text counts the required fields left out.
- A left-out field whose own `visibleWhen` or any ancestor's reads `host.`, or whose own `requiredWhen` reads
  `host.`, is a warning with `required: false` and `hostBound: true` and is never counted as a required field
  left out; `rule.reads-host` says the same for a component on no step and, on a structural ancestor, names the
  components on no step under it.
- A field hidden on the form that opts in to both `hiddenRequiredBehavior: "required"` and
  `hiddenValidationBehavior: "validate"` is, when left out, required and validated on both sides exactly as in
  whole-form mode. One opt-in alone enforces nothing, on the whole form or through a journey: a hidden field
  not validated is held to the shape of its answer alone. A field hidden by its configuration is otherwise off
  screen on both sides, unless a `visibleWhen` may show it, when it is judged like a shown field.
- A required field hidden for good is never "asked": no step can show a field hidden on the form with no rule to
  show it, so the finding carries `hidden: true`, its error says what would let a submission pass (the host or
  a default filling it), and the findings card offers "Make it optional on the form" for that field alone. A
  container holding a field a step can ask as well is reported for that field (`requiredField`, "Ask it
  here") and the hidden one as `component.hidden-required` beside it; the same code keeps the error standing
  once the field is on a step, since every side still refuses `required` for a field hidden for good. The findings card
  offers "Make it optional on the form" on the field's own row, or on the row of the container reported whole with it. `unassignedMembers` lists a hidden field a rule may show, never one hidden for good.
- A literal default answers the field. A required field answered by a literal `rules.defaultValue` that is not
  empty for its type is a warning, not an error: the browser submits the default unchanged, so the form's rule
  is met without asking. Empty is read as `required` reads an answer (`isEmptyValue`, `kernelIsEmptyValue`,
  mirrored by `journeyEmptyAnswer`): blank or white-space text, an empty list, anything but `true` on a checkbox and no box
  ticked answer nothing. A default worked out from other answers (a path, a calculation) may seed nothing, so it
  lifts nothing: the error stands, worded "its default, worked out from other answers, must come to one".
- A required calculated field whose input is left out is `calc.input-left-out`. The diagnostics pass over a
  calculated field (`rules.value`) as a question nobody answers, but the fold holds it to its Required wherever
  it sits, and with an input it reads on no step it comes out empty, so every side refuses every submission. The
  error is reported on the input (the component a step can ask, itself or the container left out whole above
  it), with `requiredField` the calculated field; "Ask it here" adds the input, "Make it optional on the
  form" opens the calculation, and it is counted among the required fields left out, once per calculated field.
  It is raised when the calculation comes to nothing for want of that input, read from the expression as the
  evaluator works it out with that input unanswered and everything else answered: arithmetic and the number and
  text functions come to nothing when an operand does; `sum`, `len`, `count` and `today()` always come to a
  value; a `concat` comes to nothing only when every argument is missing or a literal blank once joined; a
  `coalesce` comes to its first argument that is not null when its inputs are missing, so it passes over a bare
  path (and arithmetic over one) and stops at any other argument, which comes to a value all the same, so it
  reports the inputs before that argument; a literal that is empty for the calculated field's type does the same
  (`coalesce(a, "")` is empty when `a` is missing) and any other literal makes it a value; a comparison, a condition and a function that returns
  true or false (`contains`, `empty`, `startsWith`, `any`) come to a value, except on a checkbox, where `false`
  is no answer, so any input they read counts; an `if` comes to nothing only when every branch does, and on a
  checkbox every `when` of it counts too. A calculation it reads is followed into what that reads. An input
  answered by a non-empty literal default, or by a default that is a plain path to a value leaf a step asks, gets
  the warning a default gets. An input hidden on the form for good is not the journey's doing and is not
  reported. An input whose visibility only the host decides is still the error: it is on no step, so nobody can
  answer it, whatever the host says; this is the one place where host gating does not turn the finding into a
  warning. The check reads the expression, not the answers: it assumes everything the journey does ask is
  answered, and it does not look into calculations inside a repeating section's entries.
- A left-out field is the form's: it is visible under its own rules, so an explicit `hiddenValueBehavior` of
  `exclude-from-submission` or `clear` on it does not drop its answer, and route conditions can read it. The
  browser's `effectiveState(id)`, `isRequired(id)` and `requiredMap()` report it as on the form. A journey
  that places every field folds exactly as the whole form does.

### Diagnostics for journey-only fields

`diagnoseJourney` judges the journey's own nodes node by node, from the shared ownership and rules above, so the
builder cannot disagree with the browser or the server. An entry a rule drops is said only for why it is dropped
(each node that drops it, rule H once per entry); in an entry in use, each node's problems are said on it. A
finding about an own node carries `ownNodeId`: the node's id, or, for a reference inside an own layout, which has
no id, the id of the layout holding it, with `componentId` the form component it names. It also carries `pageId`
and `pageIndex`, with `componentId` the form field concerned (what an alias fills or a worked-out value sets).
A finding about a step, a route or a form component carries none, even when it names an own field
(`condition.reads-presentation-field` stays on its condition), except where a node of the journey's own is what
places the form component: `component.placed-twice` carries the `ownNodeId` of the placement that repeats, and
`page.entry-field` about a reference in an own layout carries that layout's. Where own nodes on one step share an
id, a finding about a later one also carries `ownNodeRepeat`, how many come before it, which the designer keeps
as `JourneyFinding.repeat`. A finding a usability
rule stands behind carries the rule's letter (`rule`); only `presentation.entry-unusable` carries `entryId`.
`page.no-title` borrows as the runtime heads the step: a node of the step's own lends its own label alone, and a
worked-out value with no label at all its field's; an alias with no label, or a worked-out value labelled
blank, lends nothing, and the step is headed by its id.

| Code | Severity | When |
|---|---|---|
| `field.id-clash` | error | An own node's id is a form component's or an earlier own node's (rule A: the entry is dropped on both sides), a step's of the journey, or `journey` or starts `journey-` (the designer's own; both sides still draw the node). |
| `field.unsupported-type` | error | Rule B: a type a journey cannot hold as its own (dropped). |
| `field.data-binding` | error | Rule C: a collection, `dataKey` or a data-scoping container (dropped). |
| `presentation.entry-unusable` | error | What no code here names: an id outside the component-id grammar (A), `fills` on a node that holds no answer (F), a journey id outside the grammar (H), an own answer at a key the form uses (I). |
| `page.unknown-component`, `page.root-component` | error | Also for a reference inside an own layout naming no form component, or the form itself (rule D), on the layout. |
| `map.unknown-target` | error | An alias's `fills` or a worked-out value's `to` names no form component (rule E). |
| `map.target-unusable` | error | It names one that is not a value leaf: the form itself, a group, a valueless type, a calculated field, a field in a repeating section or a data grid (rule E). |
| `map.target-conflict` | error | A worked-out value whose field the journey already places (listed, referenced or filled by an alias, on any step) or an earlier one works out (rule G). |
| `map.shape-mismatch` | error | An alias asks for another kind of answer than its field holds (text, a choice, a list of ticks, a number, a date, a tick; a choice or a date may fill a text field), or a worked-out expression certainly comes to another shape (a sum into text, a concatenation into a number). A worked-out value that copies one own field of its step (its expression a bare path to it) is held to that field's own shape, as an alias is. |
| `map.options-not-subset` | error | A choice alias offers an option value its field's inline list lacks (not checked against a field whose list comes from a data source). |
| `map.reads-other-page` | error | A worked-out value reads a form field, or an own field of another step; the browser reads its step's own fields alone. Names an alias on the step that fills the form field, when there is one. |
| `map.sources-conditional` | error, or a warning under Required-when | The field worked out is required without a literal default and every own field its expression reads may be hidden: while they are, the step cannot be passed. An error when the form requires the field outright; a warning under a Required-when rule, which may hold only while a source shows. |
| `map.reads-no-source` | error, or a warning | A worked-out value whose expression reads none of its step's own fields (nothing, or `host.` values and literals alone). The browser works a value out only once one of its step's own value fields is answered, so on a step with none it never is. Not said when one of them is sure to be answered. An error when the form requires the field outright without a literal default; else a warning. |
| `own.hides-form-field` | error | An alias, a worked-out value, or an own layout holding one or a reference, has a visibility rule or `hidden`: never read. |
| `data-key.reserved-prefix` | warning | A repeating section's or a data grid's collection path starts with `@`, as the keys journeys keep their own answers under do. Both sides keep, send and judge such a form value as any other; rule I's `presentation.entry-unusable` is the error where an own field's key would meet it. Once per component in `diagnoseJourneys`. |
| `field.goes-nowhere` | warning | An own value field with no `fills` that no worked-out value of its step and no own rule reads. Kept in the browser only, which is allowed. Never for a type `isValueless` names. |
| `map.target-hidden` | warning | An alias or a worked-out value of a field hidden for good: it never shows. |
| `condition.reads-client-derived` | warning | A condition reads a field a worked-out value sets, or a calculation reading one, which is what `kernelClientDerived` lists. |
| `component.placed-twice` | warning | A form field placed more than once on one step where one of them is an alias or a reference in an own layout; once for the outermost component. |
| `rule.unknown-field` | warning | An own node's rule the browser reads for its kind (an alias's Required-when alone; a worked-out value's expression) reads what it never can: a path naming no form component and no own field or alias in use, a key under `@`, a worked-out value, a node with no answer. |
| `condition.reads-presentation-field` | error | A route condition reads an own id or an `@` key. |
| `rule.reads-presentation-field` | error | A form rule or calculation reads an own id or an `@` key. |
| `component.unassigned` | error, or a warning | A form field on no step; see "Questions no step asks". |
| `component.hidden-required` | error | A required field hidden for good, which no step can ask. |
| `calc.input-left-out` | error, or a warning | A required calculation empty for want of an input no step asks; a warning when the input's default answers. |
| `presentation.fields-left-out` | warning | The summary of the optional fields left out. |

## Which journey opens

Which journey opens is the definition's to propose and the host's to decide, as
`localization.defaultLocale` is against `locale` — `journey` on `<datum-form>`, or the `journey`
option of `FormRuntime`:

| `journey` | Opens |
|---|---|
| a journey's id | that journey; an id the form does not have warns once, and the definition decides |
| `"form"` | the whole form on one page |
| `"journey"` | the definition's default journey, even when it opens as a form |
| unset | the definition's choice: `opensAs`, then `defaultJourneyId`, then the first journey |

`page` opens a page the person may already reach (a deep link, a resume point). At the start
only the first page is reachable, so a later page waits: a draft being restored whose
completed pages reach it opens there, and the person's first move forgets it. A draft being
restored resumes its own journey over both. `journeys()` lists `{ id, label }` for a
picker; `nextPage()`, `previousPage()` and `goToPage(id)` answer `{ ok, pageId, reason? }`, a
jump reaching only pages at or before the first one not yet completed; a `beforePageChange`
hook may veto a move. Every move is reported as `datum-page-change` — the page's id, its title
in the form's locale, how it was reached (`start`, `resume`, `forward`, `back`, `jump`,
`change`, `error`), where it sits on the path and the errors that block — and the runtime publishes
`JOURNEY_CHANGED`, `PAGE_CHANGED`, `PAGE_BLOCKED` and `JOURNEY_CHECK_STARTED` / `COMPLETED`
on its event bus.

## Server checks

The definition says when the service checks the answers; the host says how. `validation.server:
true` on a page (on the journey, for every page) makes Continue ask the service once the
page's own checks pass — a registration number, an address — and `validation.end: "server"`
makes Submit ask it to check the whole journey, after the browser's validation and the sandbox
and before the envelope is completed, signed or delivered, so nobody signs answers the service
will refuse. The way there is `serverValidator`, a function handed each check (`{ formId,
formVersion, journeyId, scope: "page" | "journey", pageId?, values, locale }`, and beside it a
signal to abandon it by and `document`, the submission envelope over those values as Submit
builds it) that resolves with `{ errors }` as `setErrors` takes them; or `validate-url`, a URL
the element posts the check to as a Datum host's `POST /api/submissions/validate` takes it,
`{ document, scope, pageId? }` as `application/json`, reading `errors` (and `notes`, as
warnings) back from a 200 or a 422, an `accepted` flag that disagrees with them voiding the
reply (`createFetchJourneyValidator(url, { headers, credentials })` builds the same for a page
with a token to send); `validate-timeout` bounds each check (10 seconds unless set; `0`, none). A
server that cannot be reached — a timeout, a network failure, a 5xx, a malformed reply, or no
validator at all — is `validation.onUnavailable`'s to decide: `"block"` (the default: the page
stays, with "We could not check your answers. Try again.") or `"continue"`. So is any other status than 200 and
422, a 4xx included (a lapsed session or a moved route is no verdict on the answers): the page is
held as in an outage, and `onUnavailable` decides (ADR 0112). A reply that only warns stops Continue once, and
Continue again with the same answers goes on. A page's check that came back clean is remembered in memory
for exactly that request (the SHA-256 of the whole request: scope, journey, page, every submittable answer
and the locale), so Continue asks again only when something changed; the end check is never remembered, and
nothing about a check is kept in a draft. An answer changed while a check was out drops its reply, and Back, a
jump or leaving the journey calls a check in flight off. An error the server reported stays on its field until
that answer changes; the page's own re-validation does not clear it. The end check's errors have their own
source, `journey-server`, apart from the `serverValidationRunner` stage of a host that runs its hooks in
process; a host that configures both runs its hooks twice. A download button skips the end check, and the
builder's preview never asks. On the server, `@argusvane/datum-submissions`' `validate` is receive's verdict and hooks with
nothing stored — the page's part of it for `scope: "page"` — and `POST /api/submissions/validate`
its route, answering 200 `{ accepted, errors }`; the check's body is what the route takes, and `receive`
refuses a body that carries a `scope` or a `pageId`. Both accept a result that has only warnings; `receive`
refuses on a blocking error alone.

## On the server

The envelope names the journey and nothing more. `submission.journey = { id }` is absent without a journey, so
every existing signature and digest is unchanged; it is signed under the `submission` and `envelope` signing
scopes, not under `values`, and the sandbox's `WasmSubmissionContext.journey` carries it. The submissions
service refuses an envelope that names a journey the definition does not have (`journey.unknown`). A context
whose journey is not a usable journey, by the shape rules the browser's reader applies (`validateJourneyShape`),
fails closed (`journey.invalid`), and a path that ends at an exit page is refused (`journey.exit`). All three use
the stage `journey`.

A submission that names none is judged by the form's only journey, else the one `journey.defaultJourneyId`
names, and is refused with `journey.required` (stage `journey`, a rejected record on `receive`, a 422) when the
form has several and no usable default; `journey.opensAs: "form"` keeps the whole-form delivery. A check
(`validate`, any scope) that names none is judged the same way. "Names none" is absent, `null`, `{}` or
`{ id: null }`; an array, a non-string id or `""` is `journey.unknown`. On a server host an amendment is judged
by the original record's journey.

The service keeps the delivered document byte for byte, because its digest and signatures cover it. It also
stores the values the verdict judged on the record: the kernel's submittable values, recomputed calculations
included. PDFs, exports and aggregates read those values. A warning on the record lists any keys the fold
withheld from what was delivered.

## While the journeys runtime loads

`<datum-form>` builds its runtime in a later microtask for every form, so a plain form's `datum-ready` does not
fire inside `append()`: a host that reads `element.runtime` straight after attaching waits for `datum-ready` or
`ready`. A form with no journeys, or whose `features` leave journeys out, awaits nothing: no fetch and no chunk
request. A definition with journeys (`readJourneys(definition).length > 0`) that allows them awaits the
journeys chunk (`datum-form-journey-engine-chunk-*.js`, the path engine inside, the one journeys file the
renderer needs); one with a Check answers step also awaits that step's chunk (`datum-form-journey-review-chunk-*.js`),
and the two are fetched at once, so the wait is the slower of them. The chunk is already resolved when another
journey form on the page loaded it. Prefetch starts at definition time when the definition has journeys and
journeys is allowed, and at connect when `journey` (not `"form"`) is set or `features` lists `journeys` and a
`src` is pending. `journey="form"` on a journey definition still waits, since the journey can be switched
later without a rebuild. A `features` list that omits journeys on a journey definition is ignored with one
console warning, and the file is never requested.

While a build is pending:

- `values`, `page`, `journey`, `locale` and `draftKey` queue and are applied at build.
- The promise-returning methods (`validate`, `submit`, `submitAndDownload`, `nextPage`, `previousPage`,
  `goToPage`, `print`, `renderPdf`, `downloadPdf`, `hasDraft`, `restoreDraft`, `clearDraft`) queue and run in call
  order once built.
- The two methods that return synchronously and cannot queue, `setErrors()` and `setLocale()`, throw "has no form
  yet: the form is still building; call this after datum-ready (or await `ready`)" (the locale is still kept
  and applied at build).
- Synchronous reads (`runtime`, `errors`, `values`, `page`, `activeLocale`, `journeys()`, `presentationValues()`,
  `pdfLayouts()`) answer without throwing, reading the form being replaced until the swap.
- Disconnecting the element rejects the queued calls ("removed from the page before its journeys runtime was
  built"); a detached element builds nothing, and attaching requests a fresh build.
- A newer definition or `features` change discards a stale build, and the old runtime stays bound until the
  swap, not the request. Answers carried over a translations-only rebuild come from the bound runtime only when it
  was built for the current definition.

`element.ready: Promise<void>` settles when the element next reaches a ready state for its current definition.
It resolves once `datum-ready` has been dispatched, and at once when the form is ready already. It rejects
with the build's error (a `ChunkLoadError` when the journeys runtime did not arrive, or the refusal when the
runtime would not take the definition; the card and `datum-error` are raised as well), and asked for after a
failure it still rejects until a new build is requested. A build that a newer request replaced does not reject
it, so a stale chunk failing late settles nothing. The next build (Retry, a new definition, any setting that
rebuilds) makes `ready` a fresh promise, and a rejection nobody awaited is not an unhandled rejection. A `src`
that cannot be fetched, or is not a usable definition, rejects it with the error; with no definition it stays
pending until one is set and built, and a detached element stays pending until attached and built. There is no
`whenReady()` or `updateComplete`.

If the chunk does not arrive, queued and later calls reject with a `ChunkLoadError` naming the journeys runtime,
the cause the browser's error, and the two synchronous methods throw it. The element shows an inline
`[data-form-error][data-journeys-error][role="alert"]` card with a `button[data-journeys-retry]`, worded by the
`journeysUnavailable` and `retry` form texts, and hides the inner renderer; `datum-error { message, cause }` fires
once per failure burst. The next attempt retries the import (a failed import is forgotten and `?retry=n` is
applied, since a browser keeps a failed dynamic import of one URL). A journey form is never silently rendered
as one page. Hook-driven page changes (a `beforePageChange` returning a promise) settle one microtask later
than a move without hooks, with identical order and payloads.

`new FormRuntime`, `createFormRuntime` and the builder's preview stay synchronous. Their default engine is a slot
on `globalThis[Symbol.for("datum.journeyEngine.default")]` (`setDefaultJourneyEngine`, `defaultJourneyEngine`; the
render kit has its own, `setDefaultJourneyRenderKit`), initially `NoopJourneyEngine`: a runtime built with it
from a definition that has journeys (and `journey` neither `"form"` nor `"off"`) logs one console warning and runs
as one page. Nothing registers on import (the engine package is `sideEffects: false`). `datum-form.js` never
registers an engine and `<datum-form>` always passes its own, Noop or the loaded one. In `@argusvane/datum`,
`createFormRuntime` takes `journeyEngine?` and does not default to the eager one, so a host-built journey
runtime is Noop unless the host takes the pair from `loadJourneyEngine()` (see
[docs/integration-recipes.md](../integration-recipes.md)); a failure rejects with a `ChunkLoadError` and is
forgotten, so the next call retries. `datum-engine.js` defaults to `EagerJourneyEngine`, imported statically,
and `datum-builder.js` registers `EagerJourneyEngine` and `EagerJourneyRenderKit` in the page slots on load.
The debug-only diagnostics chunk imports the engine chunk statically, so `reportJourneyDiagnostics` runs only
when the definition has journeys and `debug` on a plain form does not fetch the runtime.

## Recipes

Two recipes for a page that hosts a journey — the address bar in step with the page, and GOV.UK's
"Error: " before the document's title while the page shows errors:

```js
const form = document.querySelector("datum-form");
const service = document.title;
const pageInUrl = () => new URLSearchParams(location.search).get("page") ?? undefined;
const withPage = (page) => { const url = new URL(location.href); url.searchParams.set("page", page); return url; };
form.page = pageInUrl();                               // a deep link, honoured when the person may reach it

let heading = "";
const retitle = (errors) => { document.title = `${errors > 0 ? "Error: " : ""}${heading ? `${heading} – ` : ""}${service}`; };
form.addEventListener("datum-ready", ({ detail }) => {
  // The entry the person arrived by names the page the journey opened on.
  if (form.page) history.replaceState({ page: form.page }, "", withPage(form.page));
  // A Continue the page's errors stopped moves nowhere, so the runtime is the one to ask.
  detail.runtime.events().subscribe("PAGE_BLOCKED", ({ data }) => {
    if (data.reason === "validation" || data.reason === "server") retitle(1);
  });
});
form.addEventListener("datum-page-change", ({ detail }) => {
  // A move the address bar made is in the history already; a start or a resume replaces.
  if (pageInUrl() !== detail.pageId) {
    const write = detail.direction === "start" || detail.direction === "resume" ? "replaceState" : "pushState";
    history[write]({ page: detail.pageId }, "", withPage(detail.pageId));
  }
  heading = detail.title;
  retitle(detail.errorCount);
});
addEventListener("popstate", async () => {
  const page = pageInUrl();
  // Back and Forward in the browser are jumps; one the journey refuses puts the address back.
  if (page && page !== form.page && !(await form.goToPage(page)).ok) {
    history.replaceState({ page: form.page }, "", withPage(form.page));
  }
});
```
