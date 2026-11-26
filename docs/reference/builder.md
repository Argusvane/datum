# The builder: shell, panels and look

How the builder looks and behaves to an author, and the attributes, properties, events and slots a host
meets on the way. Putting the element on a page, its core attributes and saving are in
[Embedding the form and the builder](embedding.md#embed-the-builder); every attribute, property, method and
event is in the [attribute reference](attributes.md).

## The bar

One bar runs along the top (ADR 0099). Its leading group holds the `toolbar-start` slot, undo and redo and
the command palette button; then come the workspace tabs, the name of the document on the page, and the
trailing group: the active mode's views switch, the full-window button, the `canvas-actions` and `toolbar`
slots, a "Changes not saved" cue while the form is unsaved (`saveState` is `"unsaved"`, which
`<datum-form-builder>` sets from `dirty`), the `history`, `comments`, `publish` and `account` slots, and the
menu. The shell's `::part` names are `wrap`, `bar`, `bar-start`, `workspaces`, `documents` and `bar-end`.

`full-window` (the bar's button and a palette command) fixes the builder over the whole window and holds the
page's scroll until it leaves; Escape does not leave it, since Escape clears the canvas selection;
`no-full-window` removes the button. `builder-full-window-change` (`{ fullWindow }`, bubbling and composed;
`datum-builder-full-window-change` on `<datum-form-builder>`) reports it.

### The document label

It names the form, PDF layout or journey on the page, with its kind (Form, PDF layout, Journey) and its
Default and badge words. For a layout or a journey it is the button for a menu: Rename (in place; Enter or
leaving the box commits, Escape cancels), Duplicate, Move up, Move down, Set as default and Delete (asked
twice). Documents are switched on the Journeys and PDF overviews, from the palette, or with
`builder.selectDocument(modeId, documentId)`, `setMode()` and `builder.newDocument(modeId, kind?)`;
`builder-document-change` reports a move. `showModeSwitch = false` hides the label, and `hiddenModeIds`
leaves modes' documents out (which is what `workspaces="pdf"` does to the form).

## File actions

The bar's menu (⋮, last on the bar) holds Save when the page asks for one (see "Saving and problems" in
[Embedding](embedding.md#embed-the-builder)), then the builder's own **New**, **Open** and **Download**
(ADR 0118), and the Dark mode switch at its foot; the arrows walk the items, and Escape, Tab and a click
elsewhere put the menu away. The menu shows even with `file-actions="off"`, for the Dark mode item. Only the
actions supplied show. They work over the whole definition: the tree, the languages, the identity, the PDF
layouts, the journeys and the tests.

- Each waits for unsaved inspector edits.
- New starts a form under a fresh neutral id, keeping `version` and `schemaVersion`, with an empty
  root holding one Submit button; it drops the languages, PDF layouts, journeys and tests. It asks
  "Start a new form in place of this one?" unless there is nothing to lose: no component but the
  untouched seeded Submit button, nothing set on the form itself (title, header, footer), no
  languages, no journeys, no tests and no PDF layout. `fileActions.isEmpty` replaces the journeys,
  tests and PDF layout part of that check (the builder still looks at the tree, the form's settings
  and the languages) and applies to whichever New is in use; `null` drops it.
- Open reads a file up to `max-definition-bytes` (2 MiB) and refuses text that is not JSON ("it is
  not JSON: …") or not a definition the builder can take. It checks that the root is the form
  (`type: "form"`), that every component is a node object, and the shapes of `localization`, `pdf`
  (each layout) and `journey` (each journey). The message names the place, for example
  `root.children.content[0] must be a component node object`. A refusal reads `Could not open
  "<name>": <message>.` and an unreadable file `Could not read "<name>": <message>.`; it shows on one
  line beside the menu and is whole in its title. The picker opens inside the author's click, and
  its input is cleared each time so a fixed file can be chosen again. An accepted file goes through `Replace this form with "<name>"?`. The
  replacement is all or nothing: the tree, the PDF side and the Journeys side take the new form
  together, and a definition the builder cannot take after all leaves the form as it stood.
- Download, where the browser has no `URL.createObjectURL`, says "Downloads are not available here." beside
  the menu instead. Otherwise it saves `JSON.stringify(definition, null, 2)` and a newline as `application/json`, named
  after the form's title as a slug (`customer-intake.json`), else after its id. A form with no
  Submit button still downloads, with a notice below the bar and `warnings` on the event
  (`code: "no-submit-button"`). With no Save of the page's own, a Download is the form's save and
  marks it clean; with one, it is an export and leaves the saved baseline alone.
- The question is one modal `dialog.db-confirm` (`role="alertdialog"`) with a title, the message, Cancel
  (focused first) and a danger-styled OK ("Start a new form", "Replace"); Escape cancels and focus goes
  back to the menu button. The message beside the menu is a `role="alert"` box outside the menu, so it stays in view once the menu is put away,
  with a Dismiss button,
  which returns focus to the item the message was about (Open for a refused or unreadable file,
  Download for "Downloads are not available here."), else to the first control shown. A new message
  replaces the old one. The words are the builder's own, in its text catalog (`shell.file.*`).
- Each completed action raises `datum-builder-file-action` (`{ action, name, definition }`),
  the definition being the form after it: after New or Open, the new one, ready to save.

`file-actions` picks which show: `"off"` for none, or a list such as `"open download"` (names it does not know are ignored). The
`fileActions` property hands in the page's own versions:
`builder.fileActions = { download: () => ({ name, text, type }) }`, where `null` hides a button
and a key that is missing or `undefined` keeps the builder's own (assigning `undefined` to the
property resets them all, and the getter returns the effective set, which is what the inner
`<datum-builder>` is given). `workspaces="pdf"` does not change them: New, Open and Download still
work over the whole definition, and `file-actions="off"` removes them there as anywhere.

### A host that writes the definition itself

The engine's own `<datum-builder>`, used bare (as a host that assembles its own bar uses it), hands its
wiring in through `fileActions`: `{ new?, open?, download?, save?, saveLabel?, isEmpty? }`. The
builder does the asking (the unsaved-edits guard, the questions, the file picker inside the author's click, the
size cap, the Blob download) and shows nothing for an action the host leaves out; the host does what only it
knows. `new()` loads the host's empty form. `open({ name, text })` checks the text and returns the step that puts
the form in place, or throws (or rejects) with the message the bar shows. `download()` returns
`{ name, text, type? }`, built over the whole schema view (tree, localization, PDF layouts, journeys, tests).
`save(context)` gets `{ localeChanges, trigger? }`. `isEmpty()` is the host's last word on whether a New loses
anything, since the shell cannot see the PDF layouts or journeys the host holds.

Such a host also writes the form's `kinds` map, the engine type each plugin or binding type reads as,
with `builder.controller.definitionKinds(opened.kinds)` (`opened` being the file it loaded, whose
entries are kept), and sets `builder.controller.openedKinds = () => opened.kinds` so Try it checks
with that map. A definition without it checks a `gcds-date` as nothing in the runtime, the sandbox
and on a server ([binding authoring](../binding-authoring.md), tier-2 types).

## Toolbar slots and host controls

The `toolbar-start` and `toolbar` slots put the page's own controls on the builder's bar. The
first leads the bar, before undo and redo; `toolbar` and `canvas-actions` sit in the bar's
trailing group. Besides those three, the bar has `history`, `comments`, `publish` and `account` places, each
drawn only when filled; `<datum-form-builder>` forwards every slot, `strip` and `panel` included.

A button or select slotted into `toolbar-start`, `toolbar`, `canvas-actions`,
`history`, `comments`, `publish` or `account`, or a button slotted into `strip`, is drawn in the
builder's own look, from its `--db-*` tokens: a pill on the backdrop, a round button inside the
leading pill for `toolbar-start`, a circle when it holds only an icon, and a strip launcher like
the strip's own items (`aria-selected="true"` and `aria-pressed="true"` take the selected fill).
Mark the page's main action (Save, Publish) with `data-builder-primary` for the accent pill. The
builder's rules weigh one element (`:where()` over the slot names), so a class of the page's
overrides them in every state, and a page's bare `button {}` reset does not. Each builder installs
the sheet once into its own root node (the document or the shadow root it lives in) when it
connects. Add `load-fonts` to load the builder's own face, Geist, from `builder-fonts/` beside
the bundle (ADR 0118, ADR 0124).

The shell draws its own glyphs (`SHELL_GLYPHS`) from the current icon set, so a new set redraws them. The names
it adds to the generic ones, each drawn by every shipped set, include `form-panel`, `chrome-panel`,
`outline-panel`, `variables-panel`, `settings-panel`, `document-menu`, `new-form`, `open-form` and
`download-form`.

## Workspaces

The bar's Form, Logic, Data, Languages, Journeys, PDF and Print tabs group the strip's panels by what the
author is doing (ADR 0125); Journeys and PDF show while their side is on. `workspace` picks the one to open on
(a workspace remembered under `persist-panels` wins), `hidden-workspaces` leaves some off, and
`datum-builder-workspace-change` says when the author moves. A switch waits for an unapplied draft like any
other. Give a strip item of your own `data-workspace="data"` (or several, space-separated) to show it in those
workspaces only; without one it shows in all. Under 1024px of builder the workspace tabs become a menu.

The tabs count problems: Data the form's data-key clashes, Journeys the journeys' errors (checked when the
page is idle), PDF the layouts' rule problems, and `builder.workspaceProblems = { … }` adds counts of your own.

### The Logic workspace

ADR 0127. Logic lists every rule of the form as a sentence, by kind and by
step, with the journeys' and PDF layouts' conditions read-only beside them, and flags rules that
hide each other. Choose a rule to edit its condition as rows, what happens to a hidden answer,
and try it against answers you type; Apply writes it as one undo step, and leaving with a rule
not applied asks first, through the same `requestLeave` as the inspector. The surface loads from
a `datum-builder-logic-surface-*.js` chunk the first time Logic opens.

### The Data workspace

ADR 0127. Data shows every answer the form stores as a table: where it is
saved, what kind of value, whether it is required. Filter it by step or by a journey's page, or
view it as JSON Schema or an example document. Choose an answer to set its data key, what
happens to it when a rule hides it, and whether PDFs carry it; Apply commits it as one undo
step. Its Import… dialog reads a JSON sample or schema and adds the missing fields, or replaces the
form's contents, as one undo step (the `data-model` feature, ADR 0143). The surface loads
from a `datum-builder-data-surface-*.js` chunk the first time Data opens.

### The Journeys and PDF overviews

ADR 0125. Each of the two workspaces opens on its own overview:
Journeys lists the journeys with their pages, what each asks and its problems; PDF lists the
layouts in the order their rules are tried, the default and each rule. A card's Open goes into its
designer ("‹ Journeys" or "‹ Layouts" on the canvas comes back), and + New starts a journey or a
layout. Both load from a `datum-builder-overview-surface-*.js` chunk the first time either opens.

## The strip and its panels

The strip opens one panel at a time beside the canvas; clicking the open panel's item puts the side column
away. The shell's panel ids, and the workspaces each is offered in:

| Id | Panel | Workspaces |
|---|---|---|
| `form` | Form settings | Form, Journeys, PDF |
| `chrome` | Header & footer | Form |
| `components` | Components | Journeys, PDF |
| `fields` | Form fields: a journey step's fields, offered while the Step view is up | Journeys |
| `outline` | Outline | Form, Logic, Journeys, PDF |
| `variables` | Variables | Logic, Data, Journeys, PDF, Print |
| `tests` | Tests | every workspace but Languages |
| `view` | View | Form |
| `settings` | Settings | every workspace |

A page's own launcher goes in the `strip` slot and its panel in the `panel` slot, paired by the same
`data-panel`; the shell shows and hides them together, ArrowUp and ArrowDown walk the page's
items after the shell's own (skipping hidden and disabled ones), and a click inside a page's
panel is not a click on its item. A page's panel is never remembered. `panel` and
`builder-panel-change` name the open panel.

### Form settings panel

ADR 0103, ADR 0111. The inspector fixed on the active document's root: on a form it is
the form's settings, on another mode's document that document's, under the mode's
`inspector.settingsLabel` ("Layout", "Journey"). It has the Settings tab, a Rules tab while the
root can carry rules, and its JSON behind ⋯; it has no Style tab and no Delete. Selecting the
root opens Form settings rather than the inspector. Its Header & footer section keeps the Frame picker and a
summary row per region; a row opens the panel on that region through the composed
`builder-open-panel` event (`{ panel: "chrome", region }`), which a host mounting the panel itself
can hear. A draft that cannot be saved is explained under its own box and the footer's summary
line, and Apply leads to the box (`BuilderController.problemsOf(componentId)` lists them per
component; `idError`, `cssClassError` and `dataKeyError` stay as the selection's).

### Header and footer panel

Form workspace only. It edits the root's chrome parts
directly: the header and then the footer, one block per part with its type, place and boxes, groups
indented with their own Add. It keeps no working copy: each edit writes the root's draft as it is
made, so the canvas previews it, and the Apply and Discard at its foot are the root's, shared with
Form settings. Its JSON behind ⋯ is the saved `chrome` block, read-only. The builder gives each
part an id (`part_1`, …) unique across both regions, and the texts are translated in the Languages
workspace under kind `chrome`.

### Variables panel

Lists what may be referenced and writes nothing. A click copies the reference, marks the row and says so in a live
region; the composed `builder-variable-pick` event (`{ reference, syntax, copied }`) lets a host
insert it into an editor of its own; a filter box narrows by reference or label, hiding a group with nothing left. The syntax comes
from the active mode's `BuilderMode.variables`, else `rules` on the form and `placeholders` on any
other mode, and a `syntax` a host sets on the panel wins. `rules`: fields by id, a repeating section
as itself with its fields as `row.<id>`, then the scopes (`component`, `component.part`, `row.key`,
`ancestor.containerId`, `host.key`) and the evaluator's functions. `placeholders`: fields by value
path in braces (a field inside a data-scoping container is `{{applicant.email}}`), each repeating
section's `{{row.field}}` and the row aliases `{{rowNumber}}`, `{{rowIndex}}` and `{{rowCount}}`,
`{{ancestor.<outer>.<field>}}` in a nested section, `{{page}}` and `{{pages}}` for a header or
footer, and `{{host.key}}`. `conditions` (Journeys): the form's fields by id, with no scoped paths
and no entries of a section, since a journey condition reaches a section only as a whole, then the
functions. By workspace: Data lists each answer at the path it is saved under (its data key, else
its id; a repeating section at its collection path) with the component id and key beside it, and no
functions, since nothing in Data takes a formula; Print lists the placeholders for a printed margin line (fields by value path, the page
counters, `{{title}}`, `{{date}}`, `{{receipt.reference}}` and the receipt's values by path, and
`{{host.key}}`), without a repeating section's rows or row aliases, since a margin box reads the form's own values; Logic and PDF keep
their syntax's list; Journeys adds the journey's
pages (their ids and `$end`) and its own and worked-out fields. The panel reads the form's own
controller on every tab. `buildVariablesModel(view, syntax, options)` composes the list from a
`NestedTreeNodeView` for hosts and tests. The Rules tab's note in the inspector names the panel, so an author
writing a rule is pointed at the list.

### View and Settings panels

The View panel holds what the canvas shows, for the preview only, and nothing in it reaches
the definition: the preview width, the design-system binding, the form chrome the preview is
drawn under (the page's frame, the form's header and footer shown or left out, the language
switcher), and "Show components a rule hides" (on by default; Try it shows what a person sees).

The Settings panel holds what the author tries the form with, kept on the builder for the
session: the language the canvas shows, the stand-in for the page's server in Try it (see
[Try it](#try-it)), and the data sources the form's choices name, each marked From the page, Simulated or
Not provided (Simulate takes one option a line as `value | label`, or a JSON list, and a simulated id wins
over the page's). Neither panel touches the definition.

## Drawers and width tiers

The side column and the inspector are drawers laid over the canvas at every width,
so opening a panel does not move the form. The side column is 240px by default (Tests opens at
360px, Form fields at 300px) and is dragged between 160px and 900px; the inspector is 300px,
between 200px and 560px, draws nothing while nothing is selected and folds to a stub. The side column's grip always draws a hairline; the inspector's only while hovered or held, since one drawn the drawer's height would cross the canvas under a short column. How many
are up depends on the builder's own width, not the window's: from 1280px both can be; from 900px
to under 1280px one beside the canvas (opening one folds or puts away the other); under 900px
the builder is narrow (`data-narrow`, `narrowLayout`): one at a time and no drag grips, both
drawers are put away on going narrow and come back as they were on widening; under 768px it is a
phone (ADR 0137). The form's sheet moves clear
of an open drawer by only as much as it needs, and when under 480px would be left beside it the
drawer lies over the sheet.

## The remembered layout

With `persist-panels="<key>"` (an empty value means the key
`default`) the shell writes, on every change, the open panel (or none), the two widths once
dragged, whether the inspector is folded, and the workspace when it is Form, Logic, Data,
Languages or Print (Journeys and PDF are not put back), and reads them when a shell with the same
key next connects. The panel can be any of the nine in the table above. The record is `localStorage` under `datum-builder:panels:<key>` where a probe
write succeeds, else a store for the page load, so a builder that re-connects still keeps its layout. A record from another version, one that does not
parse, or one naming a panel the shell lacks is ignored; widths are clamped to the limits above
on write and read. Nothing is written while the builder is narrow, or while one drawer has
yielded to the other at the medium width. A form with no panel in the record keeps the shell's
rule: the Components palette open for an empty form, shut for one with components. The colour
scheme is not in the record: it is the person's, kept per origin under `datum-builder:scheme`
whether or not `persist-panels` is set. `readPanelMemory`, `writePanelMemory`,
`clearPanelMemory` and `panelMemoryStore` come from the engine's builder index for a host that
resets a layout.

## The canvas

ADR 0126. The canvas edits by default: a click anywhere on a field
selects it, the canvas is one Tab stop, and the arrow keys walk the components (Alt with an arrow
moves one, Delete asks first, Enter opens the inspector). Try it on the canvas bar previews the
form live (`previewing` on `datum-builder-canvas`, and a `canvas-preview-change` event); the
same bar sets the preview to a desktop, tablet or phone width and steps through a form's steps.
The selected component's Move, Duplicate, Add logic and Delete sit in one bar at the bottom of
the canvas. The rail over the strip adds the common types after the selection, as the palette's
click does. The canvas bar zooms (− + Fit, the level back to 100%; the keys + − 0), and a click
on empty canvas puts the selection and the side panel down (asking first about unsaved edits).
The JSON boxes load their editor on first use, from a
`datum-builder-json-viewer-*.js` chunk beside the bundle: copy the builder's chunks with it.

## The inspector

ADR 0111. A head names the selected component and its type, and a `role="tablist"`
under it holds Field, Style and Logic (`data-inspector-tab` values `properties`, `style` and
`rules`). Style holds the presentation and PDF sections and, as named toggles, the classes the
canvas's binding declares for that component (`LiveBinding.cssClasses`; `BuilderController.styleOptions()`
lists them); the classes of one group are one radio choice with a Default that clears it, and there is no
free class box. Logic counts the component's rules and edits each in the formula editor
([docs/formulas.md](../formulas.md)). The JSON is behind ⋯, as a read-only view or, through Edit JSON,
as `{ id, type, configuration, rules? }` that goes into the draft: the type cannot change, and children
are left out ("Children are edited on the canvas."). A form component also shows a read-only **Saves to**
box with the path its answer is stored under. Drafts commit with **Apply** and **Discard**, with "Not
applied" beside them while the draft holds changes; Save is the page's. Leaving with a draft open asks
"Changes not applied" with Keep editing, Discard and Apply (`requestLeave(run)` runs `run` once it is settled;
`hasUnsavedChanges()` asks). The panel is a stack of floating cards in the drawer: the head, the ID and
Saves to rows, a card per section, rule or note, and Apply and Discard in a card of their own. The
column takes its content's height up to the drawer's, and a folded inspector is a round stub button.

## Try it

ADR 0141. While Try it previews the form, a panel beside it
shows the form filled in or read only, prints it, previews it as a PDF, runs the form's checks on
the answers (and the server's, when the page lends `builder.serverChecks`, a WebAssembly sandbox's
run), and shows the answers as a submission carries them. `serverChecks.run({ root, answers, locale,
kinds })` gets the form's `kinds` map when the form uses a plugin's or a binding's type (`gcds-date`):
put it into the sandbox run's `context.kinds`, or the server checks that type as nothing. The strip's Settings
panel lets an author try the form with simulated lists for its data sources, and the View panel previews it
under the page's chrome (see [View and Settings panels](#view-and-settings-panels)). Neither touches the definition.

### Submitting in Try it

The Settings panel's "Submitting in Try it" section is the stand-in for the page's server in Try it
(`TrySubmissionSettings`, kept on the builder for the session). It sets what the server does
(accepts, refuses, cannot be reached); how long it takes (0 to 10000 ms, 800 by default); where
"Submitting…" shows (top, bottom or both) and its wording, the form's own when blank; the receipt
(kind success or info, title, message, reference label, a reference pattern whose `{n}` is six
random digits, and where it shows); the refusal message; and whether the answers stay editable
after an accept or show read only. The "Host values" box takes a JSON object (the placeholder is
`{ "role": "admin" }`) that the preview's rules read under `host.`. It applies when it is left, not
on each keystroke; text that is not JSON, or JSON that is not an object, is said under the box and
the last good values stay applied, and an empty box is no context. Try it hands the same record to
the server's checks as `hostContext` in the request.

## The command palette

ADR 0100. Ctrl+K (Cmd+K on a Mac) inside the builder, or the search
button on its bar, opens a box that lists every command: the workspaces, the components to add,
the components to go to, the edits on the selection, the documents and the views. Typing
filters them, and Enter runs the highlighted one through the same path as its control. Add
your page's own commands with `builder.registerCommands({ commands: () => [...] })`, or open it
with `builder.openPalette()`. It loads from a `datum-builder-command-palette-*.js` chunk the
first time it opens (a failed load is tried again on the next open).

A command is `{ id, label, group, keywords?, shortcut?, enabled?, run }`. `group` is one of
`workspaces`, `add`, `go to`, `edit`, `documents`, `view` and `host`; `keywords` are matched beside
the label; `shortcut` is shown and never bound; `enabled` greys the command while it returns
false. `registerCommands(source)` returns the function that takes the source out again, and a source
that throws is logged and left out. The builder lists the commands afresh each time the palette
opens: a Go to workspace for each workspace on offer (disabled for the one on the page), one Add per
component type (placed after the selection, as a palette click is), one Go to per node of the
tree, by its label or else its id, the edits on the selection (undo, redo, duplicate, move, move up, move down, Logic while the
`logic` feature is on, delete; the selection's are enabled while a component other than the root
is selected), Open per document and New per mode that adds documents, the views (the strip's
panels the workspace on the page offers, full window, hidden components, Try it or Back to editing where the
canvas can be tried, and the three preview widths in
the Form workspace), and then the page's. Typing matches a subsequence of the label and keywords,
ranked by word-start hits, then a label hit over a keyword hit and a tight span over a loose one,
then group order; a disabled command lists after the enabled ones of its rank. With nothing
typed the list is Recent (the last five run, kept for the page's life), then every group. Up and
Down, Home and End move over the enabled rows, Enter runs, and Tab stays in the box. The box is a
combobox over a listbox, and the count of matches is announced. Ctrl+K and Cmd+K are handled only
when the event happens inside the builder, and the `palette` feature gates the key, the bar's
button and `openPalette()`: a page that wants the key for itself leaves the feature off. Every
command calls the control's own guarded method, so an unapplied edit still prompts and a fixed
widget still refuses deletion; the palette closes first, so a prompt never sits under it.

## Leaving the page

While the form is `dirty`, or an edit is held in a panel, `<datum-form-builder>` cancels
`beforeunload` so the browser asks in its own words; `leave-guard="off"` turns that off, and
`requestLeave(run)` is the guard for a route change the browser does not see (ADR 0179).

## The look and its dark scheme

ADR 0124, ADR 0157. The shell is drawn from `--db-*`
custom properties printed from one token list (`studio-tokens.ts`), measured against HDR floors
and WCAG 2.2 AA. Seven are the public tier, which a host or a registered builder theme may set and
rely on across versions: `--db-accent`, `--db-accent-hover`, `--db-accent-ink`, `--db-accent-text`,
`--db-accent-soft`, `--db-font` and `--db-font-mono`. Every other token is the `theme` tier, which
a theme may set but which can change between versions. The shell's layout values (among them
`--db-gap`, `--db-strip-w`, `--db-side-w`, `--db-props-w`, `--db-shell-top`, `--db-sheet-w`,
`--db-sheet-bg`, `--db-canvas-gap` and `--db-density-control-h`) are set by the shell or the page's
layout, never by a theme. Border width (`--db-border-w`, 1px), the radius steps, `--db-radius-pill`
(999px) and the code face are tokens too. `--db-accent-ink` is the colour of text and icons painted
on the accent (`#fff` in the light look, `#0f1114` in the dark one): a theme that sets its accent
sets its ink with it, at 4.5:1 or better, and picks an accent that also reads as a foreground on
the surfaces. Under forced colours the builder draws in system colours without shadows, and
motion tokens are 0ms under `prefers-reduced-motion`.

`scheme="dark"` (or the Dark mode item in the
menu) applies the dark palette, `STUDIO_DARK_TOKENS`, over any `theme` the host set: every colour is
the dark one and the host's type, space and radii stay. `theme="datum-dark"` is the dark scheme by
default; a choice the person made in the menu, kept per origin under `datum-builder:scheme`,
wins over it, and `scheme="light"` over it shows the built-in look. `no-scheme-toggle` takes the
switch off; `<datum-form-builder>` forwards `scheme` and re-emits `datum-builder-scheme-change`.
While the builder is dark the canvas draws the `datum` binding in its dark look, and a binding that
names a `darkVariant` (the id of another registered binding) is drawn under that variant; nothing
is written into the form. The View panel's binding picker then names what the canvas draws: a
binding reads under its dark variant's name, and the variant's own entry is left out.
