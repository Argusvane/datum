# Writing a design-system binding

A binding makes the form renderer draw a design system's own markup. This guide is for the person
writing one, and for the person reading a reference binding to see how it was made. Hosts that
embed a form drawn with a binding also need [Host security](host-security.md).

## 1. What a binding is for

Datum draws every form through one renderer (`engine/form-engine/render/live/`). What a form is
drawn *with* is a **binding**. A binding is a module that turns each Datum component (a text field,
radios, a date, a fieldset, tabs) into the design system's markup. It also turns the form's chrome
(the error summary, journey buttons, the language switcher) into the design system's own pieces.

One rule settles most questions: **defer to the design system.** The design system's own markup,
CSS and script decide its look and its accessibility. If one of its components falls short, that
is for the design system to fix; the binding does not patch, gate or work around it. The binding
owns the integration. It draws each component faithfully, and it carries every Datum feature
through: configuration, rules, validation and the error summary, journeys, data grids,
translations, read-only and disabled, print, PDF, the builder canvas and agent tools. A check on
a binding tests that integration, never the design system's own quality.

Two consequences:

- Datum's own look is the built-in `datum` binding, the only look Datum ships. The nine bindings
  under `bindings/` (GCDS, USWDS, GOV.UK, Bootstrap, Nova Scotia, Alberta, Québec, Ontario, Fluent UI) are
  reference implementations. They test the infrastructure across very different design systems,
  and they serve as demos and starting points. Each one owns its own accessibility, which is its
  design system's. None carries a support promise: there is no per-release matrix and no
  version check.
- A binding never ships the design system's files. The **host** supplies the stylesheet, fonts
  and scripts (`assets`). The renderer fetches them, rewrites them for the shadow root and adopts
  them.

Everything draws inside the form's shadow root. There is no light-DOM mode and no detection of
the design system's version.

## 2. The package

A binding is a package at `bindings/<id>/`:

```
bindings/<id>/
  package.json        datumBinding { id, designSystem, release, bundle, global, budgetKb }, the pinned DS alias
  binding-check.json  the host's asset list as the kit and datum-binding-check use it
  src/index.ts        createBinding(lit, datum)
  reference/*.html    the design system's own markup, one case per file (section 9)
  tests/tier2/*.json  tier-2 cases and their baselines (section 9)
  docs/side-effects.md   what the binding does outside the form (section 7)
  tokens.json         optional: the token contract (section 10)
```

Create one with the scaffold:

```
node scripts/new-binding.mjs <id> --design-system "Name" --release 1.2.3 --package @scope/design-system
cd bindings/<id> && npm install && npm run kit:check
```

| option | meaning |
|---|---|
| `--design-system` | the design system's name (required) |
| `--release` | the one release the binding pins (required) |
| `--package` | the npm package that ships the design system's files: adds the pinned devDependency alias |
| `--global` | the IIFE's global name (default `DatumBinding<Id>`) |
| `--budget-kb` | the gzip budget of the ES bundle (default 12) |
| `--dir` | write the package somewhere other than `bindings/<id>` |
| `--dry-run` | print the files, write nothing |

A package written elsewhere (`--dir`) names itself to the kit as `--binding .`, the folder its
scripts run in, rather than by its id. The scaffold writes its scripts that way. Its
`@argusvane/datum-engine` devDependency and the kit paths are relative to this checkout, so the kit runs from
a checkout of this repository (section 9).

A fresh scaffold's `kit:check` passes the package, build, binding, checks and conformance steps.
Equality and behaviour exit 2, "nothing asserted", until a reference case replaces the skipped
placeholder in `reference/` and an adapter exists.

Fill the files in this order:

1. `binding-check.json`: the design system's stylesheet, fonts and scripts, as
   `/node_modules/<alias>/...` paths. The alias is the devDependency's name:
   `<package>-<release>` with `@` dropped and `/` turned into `-`. So `@picocss/pico` 2.1.1 is
   `picocss-pico-2.1.1`.
2. `src/index.ts` (section 3).
3. `reference/*.html` (section 9).
4. `docs/side-effects.md` (section 7).

`datumBinding` in `package.json`:

| key | meaning |
|---|---|
| `id` | the binding's id (`govuk`): what a host registers it under and an element names |
| `designSystem` | the design system's name |
| `release` | the one release pinned (informational: the pinned devDependency is the truth) |
| `bundle` | the ES module the build writes (`dist/govuk.js`); the IIFE has the same name with `.iife.js` |
| `global` | the IIFE's global (`DatumBindingGovuk`) |
| `budgetKb` | the gzip budget of the ES bundle; the kit build fails over it |
| `checks` | optional: scripts (relative to the package) that `kit:check` runs for what the corpus does not assert for this design system; each exits 0, or 1 for a failure |
| `entry` | optional: the binding module when it is not `src/index.ts` or `src/binding.ts` (or `binding` in `binding-check.json`) |

**What a host imports.** The reference packages' `exports` point `import` and `types` at the
TypeScript source (`./src/index.ts`, or `./src/binding.ts` for GCDS and Ontario; GCDS adds
`./print` and `./pdf`). A host that bundles with a TypeScript-aware bundler (Vite, esbuild)
imports the package by name. `npm run build` writes `dist/<id>.js` (ES) and `dist/<id>.iife.js`
(the `global`). Those are for a page without a bundler. `datum-binding-check --binding <id>`
bundles the module that `binding-check.json` names (`src/index.ts`, or `src/binding.ts`) for its run; given a module
path, it bundles that file (`dist/<id>.js` outside the repository). The scaffold writes no `exports` block, so add one when the package is to be imported by
name.

**One pinned release.** The design system is a devDependency alias that carries the release
(`"govuk-frontend-6.6.0": "npm:govuk-frontend@6.6.0"`). Moving to a new release is a manual refresh.
Datum ships none of the design system's files; the kit serves them from the package's own
`node_modules`. The binding's README names the release, because a host must serve that one.

**One release per page.** A web-component design system (GCDS, Alberta, Québec, Ontario, Fluent UI) defines
custom elements, and a page has one registry for them. A page that draws forms with a binding
serves one release of that design system to every form on it. [Host
security](host-security.md#one-release-of-each-design-system-per-page) has the rule for hosts.

## 3. The binding module

```ts
import type { BindingFactory, LiveBinding } from "…/render/live/contract.js";

export const createBinding: BindingFactory = (lit, datum): LiveBinding => ({
  id: "govuk",
  label: "GOV.UK Frontend",
  designSystem: { name: "GOV.UK Frontend", selfCheck(root) { /* what must have drawn */ return []; } },
  components: { text: …, radio: …, fieldset: …, tabs: … },   // adapters by component type
  css: "…",                    // rules for what the binding draws itself
  texts: GOVUK_TEXTS,          // the language pack (section 11)
  fallbackTokens: { "--color-text": "var(--govuk-text-colour, #0b0c0c)", … },
  focusTarget: (field) => firstControl(field),
  connect: (_root, form) => connectScripts(form),
});
```

The binding never imports lit by specifier. `createBinding(lit, datum)` receives the renderer's
one lit namespace (`html`, `svg`, `nothing`, `live`, `repeat`, `ifDefined`, `ref`, `unsafeSVG`)
and Datum's own binding. Import types only from the engine. The kit build fails if the bundle
carries lit-html or imports anything.

A host registers the binding once per page, with the design system's files:

```ts
import { bindings } from "@argusvane/datum";
import { createBinding } from "@argusvane/datum-binding-govuk";

bindings.register(bindings.fromFactory(createBinding), { assets });   // fromFactory passes the page's lit and Datum's binding
```

From then on an element whose `binding` property names `govuk` draws with it. The id `datum` is
reserved for Datum's own binding, which needs no registration. An id nothing has registered draws
the form with Datum's binding, said once per id on the console and as `datum-binding-error`
(`{ hook: "binding", id }`). A page without a
bundler loads `dist/govuk.iife.js` and calls
`bindings.fromFactory(window.DatumBindingGovuk.createBinding)`.

**Adapters** are objects: `{ kind: "field", template(state, on), capabilities, … }`. The renderer
builds the **state**: label, hint, `describedBy`, pre-worded errors, notices, count, options,
`hideLabel`, `pending` and so on. `errors` holds blocking errors only, worded, with `message` (the
errors joined) and `errorId`; `notices` holds warnings and information (`{ code, severity,
message }`) with their `noticeId`; `describedBy` lists only the ids this field's drawing carries, in
the engine's order; `text(property)` words a plugin type's own translated configuration. The
renderer also builds the **events** (`on.input`, `on.commit`,
`on.parts`). The adapter returns a lit template. The renderer owns focus, announcements, the
write guards for read-only and disabled, the summary links and the DOM contract.

**Lookup.** For a component type the renderer tries `binding.components[type]`, then
`binding.components[base]`, then `datum.components[type]`, then `datum.components[base]`. A type
the binding does not draw is drawn by Datum's adapter, marked `data-fallback`, tinted through
`fallbackTokens` (Datum's tokens mapped to the design system's custom properties), and recorded in
`unsupported()`, with a console warning once. A field type nothing draws gets the renderer's
unknown-component note, recorded the same way: a `div.datum-live-unknown` with `role="note"` that
names the type, worded by the form texts `unknownComponent` and `unknownComponentHint` (a page or
the binding's language pack rewords them), and the field's wrapper carries `data-kind="unknown"`,
in every mode. The warning, once per type, names the type, the component id and what to do. A
container no adapter draws is drawn by Datum's container adapter and never flattened. On the
builder canvas the note is the node's face, selectable and deletable, and the properties panel
says "Unknown component type" above its sections. A type is never dropped silently. An entry under a type may
be a list of adapters told apart by `when`, and each adapter says which node it draws with `kind`
(`field`, `group`, `tabs`, `grid` or `steps`).

**What the renderer writes, not the binding.** The renderer writes these on every field wrapper,
and an override never removes them:

- the state hooks `data-kind`, `data-required`, `data-invalid`, `data-readonly`,
  `data-disabled`, `data-over-limit`, `data-source` and `data-pending`;
- `data-component-id`, `data-container-id` and `data-value-path` (inside a grid row, the row's own
  path). Every container sits in a `data-container-id` wrapper that lays nothing out
  (`display: contents`);
- the `aria-invalid` rule.

It also writes the summary's `href` and calls `focus()`.

**File fields.** Picking and removing a file are announced by the renderer. The adapter draws an
empty live region (`role="status"`, `aria-live="polite"`) marked `data-file-status` (`FILE_STATUS_ATTRIBUTE`,
`render/live/contract.ts`), and the renderer fills it with the form text `fileAnnounced` for a pick
(`fileAnnouncedMany` for several files) and `fileRemoved` for a removal, then clears it after five
seconds so a stale line is not read again. A pick is read out only where the region also carries
`data-file-announce`; a removal always is. Focus stays in the field: the pressed Remove button
leaves with its row, so once the draw lands the field's focus target (the picker, or its first
control) takes it. The other marks an adapter may draw are `data-file-drop-status` (hears a
drag enter and leave) and `data-file-button` (a press inside it sets `data-file-press` on the
wrapper); the renderer itself sets `data-file-drag` on the wrapper while a file is dragged over it.
An adapter that draws none of the marks gets none of the behaviour, and nothing breaks.
Each `FileItem.id` is made from the attachment it names, not its place in the list, so key the
rows by it (lit's `repeat`) and bind Remove and Download to it: a Remove pressed again after its
file went removes nothing. A pick is written once its storage has answered, so the renderer asks
the write guard again then: a submission that started meanwhile, or a field made read-only or
disabled, refuses the write (`datum-binding-error {hook: "files"}`), and a file field in a data
grid row writes to that row wherever it has moved, or nowhere once the row is gone.

The builder canvas wraps the drawing
through `canvasHooks` (`decorateField`, `renderContainer` and `emptySlot`), each taking and
returning lit templates, never HTML strings.

**Ids.** The adapter writes every id the state names (hint, error, notice, count limit), and
writes `aria-describedby` from `state.describedBy`. It never assembles an IDREF of its own. A
design-system component that writes ids inside its own shadow root says so with
`idsWrittenBy: "component"`. Otherwise the renderer checks after each draw that every id in
`describedBy` is carried by an element of the form, and reports one that is not
(`datum-binding-error`, `hook: "ids"`).

### How the renderer draws

The element mounts the form into its shadow root with `mountLive(shadowRoot, options)`
(`render/live/mount.ts`). Each draw takes the runtime's render output, folds it into one
presentation tree (`render/core/presentation-tree.ts`: fields, groups, tabs, grids, steps and pages,
with names, row labels, tab slots, page texts and the translation catalog filled in), draws the tree
through the binding's adapters as lit-html templates, and hands the result to lit-html's `render`
against the shadow root. The live renderer, print and the PDF designer's preview read that one fold.
The first draw creates the nodes and every later draw changes only the parts that changed, so a
person typing keeps focus, caret and IME composition and a design system's web component keeps its
own state. The change events of one write are merged into one build, a build that a newer one
overtakes is dropped, and a draw asked for while an IME composition is open waits until it ends.

`mountLive` returns a `LiveForm`, whose members include `ready` (resolves once the first draw is
shown, rejects when the form could not be drawn), `updated()`, `focusField`, `focusErrors`,
`reveal`, `settleInput`, `setBusy`, `selfCheck`, `unsupported`, `adapterOf`, `tree`, `fields`,
`request` (build again) and `redraw` (draw the last output again). A mount's runtime, binding,
assets, mode and features are read once; wording, data sources, canvas hooks and colour scheme are
read at each build or draw.

Most of what the renderer does beyond drawing fields comes from `LiveFeature` modules the host
lists in `features`: the error summary, tabs, data grids, steps, chrome, notices, files, tooltips,
the count announcer, data-source states and the host's design-system files. `createDatumFeatures`
(`render/live/datum/options.ts`) is the one list the element, the builder canvas, the
feature-coverage harness and `datum-binding-check` mount with. A journey form adds the journey
kit's page feature. A feature can add field state, wrap field events, draw a container kind, fill
a region of the form (`FORM_REGIONS`), open whatever hides a field, and hear every draw and every
field's connection. A container kind that no feature draws has its children drawn in its wrapper,
never dropped.

### Lifecycle, guards and focus

Per field, in order: `when` selects the adapter, `template` draws, `after` runs on every draw,
`ready` runs for a new field (budgeted by `readyBudgetMs`, 3000 ms by default, `Infinity` for no
budget; a field that is late is shown as it is and reported), and `connect` runs and returns the cleanup that runs when the
field leaves or the form unmounts. The binding-level `connect(root, form)` runs once per mount
(section 6).

A hook that throws is reported as `datum-binding-error` on the host element, with `hook` one of
`render`, `when`, `template`, `after`, `ready`, `connect`, `focus`, `ids`, `self-check`, `assets`
and others, and the drawing falls back to Datum's. A broken binding never hides the form.

The write guard drops `input`, `parts`, `commit`, `files` and `remove` whenever the form is not
interactive or the field is read-only or disabled, and the stored answer is drawn back. A
read-only radio, checkbox or select takes focus but no change, so read-only never has to mean
disabled. An adapter with a custom control the generic guards cannot reach (a listbox of buttons)
adds `guard(field)`, which returns its cleanup.

Focus is the renderer's. After a check that finds errors, where focus goes is the binding's call,
`errorFocus`. `"summary"` (the default) focuses the summary, with the tab or step holding the first
error opened first. `"field"` focuses the first field in error, or the summary when no field can
take it. A form whose `focusFirstError` is `false` (its `errorPresentation`, or the definition's
`accessibility` block) sends focus to the summary and opens nothing. With no summary drawn the first
field takes it. `validate({ focus: false })` on `<datum-form>` and `<datum-form-renderer>` validates and shows the
errors without moving focus or scrolling, for a page that shows an error without asking anyone to
fix it. Within a field the target comes from the adapter's `focusTarget`, else the binding's, else
the renderer's. Afterwards the renderer checks
the deep active element; on a miss it focuses the wrapper and reports `hook: "focus"`. No binding
autofocuses.

`FormBusy` (`submitting`, `validating`, `navigating`) puts `aria-busy` on the form, and button
adapters draw `aria-disabled`. A field whose path-declared asynchronous check is running has
`pending`, and the renderer writes `data-pending` and `aria-busy` on its wrapper.

### Where the contract is written

`engine/form-engine/render/live/contract.ts` is the contract. It is commented as a reference: read
it once. The tables a first adapter needs:

- **Types you can register under `components`.** The engine's own field types are `text`,
  `textarea`, `number`, `date`, `checkbox`, `checkboxes`, `radio`, `select`, `file`,
  `signature`, `button`, `html` and `image`. The containers are `fieldset`, `panel`, `tabs`,
  `steps` and `dataGrid`. The others (`form`, `container`, `button-group`,
  `grid`, `step`) stay Datum's unless you draw them too.
  - The list is in `core/schema/component-kinds.ts`. The group names a hand-written tree may also
    use (`tab`, the content of one tab of a `tabs` container, and `repeatingSection`, a container
    bound to a collection) are in `core/tree/data-scope.ts`.
  - A type of your own goes in `kinds` with its base (section 8).
  - The renderer looks up `components[type]` by the exact type a component is written with. A
    misspelt key (`textArea`) is a type no form has, draws nothing, and nothing reports it.
- **Capabilities** (`registry/capabilities/drawing-capabilities.ts`): `notice`, `pending`,
  `tooltip`, `prefix`, `suffix`, `characterCount`, `hideLabel`, `placeholder`, `rowNumbers` and
  `workedOut`. Answer the ones your markup draws, and leave the rest out (`none`).
- **Words** (`state.words(key)`; the keys are `FormTextCatalog` in
  `core/localization/form-texts.ts`): `required` (the marker, `*`), `optional`, `errorPrefix`,
  `noticeWarning`, `noticeInfo`, `dateDay`, `dateMonth`, `dateYear`, `tooltipHelp` and
  `selectEmpty`.
- **Tokens for `fallbackTokens`**: the names in `FORM_TOKENS` (`render/live/datum/tokens.ts`),
  written with two leading dashes (`"--color-text"`). The renderer drops a name without them
  silently. The kit's binding step reports such a name, and any name that is not a Datum token.

### A first adapter

A text field in a design system whose whole field is a label, an input and a `<small>`:

```ts
const { html, nothing, ifDefined, live } = lit;

const text: FieldAdapter<TextFieldState> = {
  kind: "field",
  capabilities: { notice: "degraded", pending: "degraded", tooltip: "degraded", hideLabel: "drawn", placeholder: "drawn" },
  template: (state, on) => html`
    <label id=${state.labelId} for=${state.id} class=${state.hideLabel ? "first-visually-hidden" : nothing}>${state.label}</label>
    <input id=${state.id} type="text" name=${state.name}
      .value=${live(state.value)}
      placeholder=${ifDefined(state.placeholder)}
      autocomplete=${ifDefined(state.autocomplete)}
      inputmode=${ifDefined(state.inputMode)}
      spellcheck=${state.spellcheck === undefined ? nothing : String(state.spellcheck)}
      ?disabled=${state.disabled} ?readonly=${state.readOnly}
      aria-required=${state.required ? "true" : nothing}
      aria-invalid=${state.invalid ? "true" : nothing}
      aria-describedby=${ifDefined(state.describedBy.length ? state.describedBy.join(" ") : undefined)}
      @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
      @blur=${() => on.commit()} />
    ${state.errors.length ? html`<small id=${state.errorId} role="alert">${state.errors.join("; ")}</small>` : nothing}
    ${state.notices.length ? html`<small id=${state.noticeId}>${state.notices.map((notice) =>
      `${state.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")} ${notice.message}`).join(" ")}</small>` : nothing}
    ${state.hint ? html`<small id=${state.hintId}>${state.hint}</small>` : nothing}`
};
```

`first-visually-hidden` is a class the binding's `css` defines (see the visually-hidden rule below).

The rules this follows, which hold for every field adapter:

- **The wrapper is the renderer's.** Return the field's own parts, with no outer element, no
  state hook and no `data-component-id`. Draw the parts in the design system's own order (GOV.UK
  puts the hint before the control, Pico after).
- **Ids and wiring.** The control's id is `state.id`, and the label names it with `for`. Write
  every id the state carries where it belongs: `labelId`, `hintId`, `errorId`, `noticeId`,
  `characterCount.limitId`, `workedOutId`, and an option's `id` and `hintId`. Write
  `aria-describedby` from `state.describedBy`. `datum-binding-check` fails an id the markup names
  that nothing carries (HK-02).
- **ARIA states.** Write `aria-invalid="true"` only while `state.invalid`, and never `"false"`: a
  design system that colours `[aria-invalid=false]` green would colour every untouched field.
  Take `aria-required` from `state.required`. Warnings and info are `state.notices`, never invalid.
- **Value as a property.** Write `.value=${live(state.value)}` (likewise `.checked` and
  `.selected`). A value a rule wrote then shows, and another field's redraw does not overwrite a
  value being typed.
- **Input attributes.** A text box always writes `autocomplete`, `inputmode` and `spellcheck` from
  the state when it carries them, whatever the adapter's capabilities answer, and writes
  `placeholder` when it answers `placeholder` as drawn. `datum-binding-check` asserts all four
  (CAP-03).
- **Events.**
  - A text box reports `on.input(value, { interim: true })` on every `input`, and `on.commit()`
    when it is left (`blur`).
  - It also commits on `change`, which an autofill fires with no blur. The `blur` after a
    `change` must not commit a second time. Keep the changed elements in a module-level
    `WeakSet`, because a redraw between the two events replaces the listeners.
  - A number reports a number. A native `type="number"` box reports `Number(box.value)`, the empty
    string when emptied, and `{ badInput: true }` with the empty string when the browser holds
    text it cannot read. A number drawn as a text box (a design system whose number input rewrites
    what is typed) reports the text as typed with `{ interim: true, typed: "number" }`: the
    renderer reads it with the form's locale ("1,000", "2,5" in French), stores the number, or the
    text when it is none so validation says "number". Never read the text in the binding. Write
    the value back in `after` only when `state.standsFor(box.value)` is false, so the box keeps
    "1,000" while it stands for 1000 and the caret keeps its place.
  - Radios and selects report a final `on.input(value)` and then `on.commit()`.
  - Checkboxes report the list of chosen values (`on.input(values)`), then `on.commit()`.
  - A date reports `on.parts({ day, month, year }, { interim })` from its boxes. It commits when
    focus leaves the whole group, not between its boxes. A date drawn as the browser's own
    `type="date"` box reports `on.input(box.value, { interim: true })`, and `{ badInput: true }`
    with the empty string when the browser holds a date it cannot read (typed in part). Typing a
    part into an empty box fires no `input`, so read the box again on `blur`, before the commit.
- **No words of your own.** Markers, the error prefix, a date's "Day" and a notice's "Warning:"
  come from `state.words(...)`. The sentence of an error is `state.errors`.
- **A visually-hidden class.** If the design system has none for what it needs hidden (a hidden
  label, the character limit's sentence, an error prefix), write one in the binding's `css`.
- **Choices are a group.** Radios, checkboxes and a date are a `<fieldset>` with a legend (the
  state's `label`). Its `aria-invalid` and `aria-describedby` go on the fieldset. An option's own
  hint describes its box.
- **Date.** Mark each of the three boxes `data-value-part="day" | "month" | "year"`, and take
  Datum's `focusTarget`, which finds the first box still empty in drawn order (section 4).
- **Container.** A group adapter draws `state.legend` and `state.hint`, and puts `children` where
  the design system puts them (`fieldset`, a card for `panel`).
- **Form-level pieces.** `summary(entries, state)` draws a heading at `state.headingLevel`
  carrying `state.headingId`.
  - It draws one link per entry: `href`, and on click `preventDefault()` then `entry.focus()`.
  - It carries `role="alert"` and `tabindex="-1"`, except on the echo copy (`state.echo`), which
    has no role and is `aria-hidden`.
  - `notice(state)` draws the host's receipt the same way. Its `FormNoticeState`
    (`render/live/contract.ts`) carries `kind` (`success`, `info`, `warning` or `error`), `assertive`,
    `echo` and `kindWord`, with the title, message and details. Give an error `role="alert"` only
    when `state.assertive`, which is true on the draw that first shows the notice; every later draw
    of it is `role="status"`, since a new alert node would be announced again. Keep `tabindex="-1"`
    either way, and draw the echo copy (`state.echo`, the second copy at the other end of the form)
    `aria-hidden` with no role. Datum's own (`datumNotice`, `render/live/datum/notice.ts`) draws
    `datum-form__notice datum-form__notice--<kind>` (`--echo` on the copy), the same title, text and
    details whatever the placement, and no icon: a binding that wants one draws it in its own
    `notice`. A warning's fill is the token `color-warning-bg` (else `color-light`) with a
    `color-warning` edge, an error's fill and words are the summary's `color-error-bg` and
    `color-error`, and a warning's focus ring is the form's `focus-ring-color`, because the amber
    edge falls under 3:1 on a light page. Datum's `--warning` and `--error` rules sit at the same
    specificity as a bare `.datum-form__notice` rule, so a host's own `css` (which comes later)
    beats them: a host that styles the notice itself must give each kind its own rules, or an error
    draws as a success.
  - `review(state)` draws a journey's Check answers page (`kind: "review"`) between the page's
    heading and its own content: a heading per step (`section.title` at `state.headingLevel`,
    carrying `section.headingId`), then its items. A row puts `row.id` on its element and draws
    `row.label`, then `row.errors` (under `row.errorId`, each led by `state.errorPrefix` visually
    hidden), then `row.value` (lines split by `\n`), or the `row.enter` link in its place. A card
    (one row of a data grid) puts `card.id` on its element, its `title` at the level under the
    step's, its one `change` link, and its `rows`. A link is an `<a href>` showing `link.text`
    with `link.hidden` in the design system's visually hidden span; on click `preventDefault()`
    then `link.go()`. When `link.reordered`, `link.text` is `aria-hidden` and `link.hidden` is the
    whole name. A link on a row (or card) in error carries `link.describedBy`, its `errorId`: put
    it in the link's `aria-describedby`. A form that is not interactive gets no links at all (a
    missing answer's value is then empty). A password's value is a mask, never the answer. The
    renderer owns where the links go and focus: the error summary links to
    `row.id`, and focus comes back to the row's first link. Left out, Datum's own drawing
    (`state.content`) stands; it ships in the journeys chunk. GOV.UK draws `govuk-summary-list`
    and `govuk-summary-card` (`bindings/govuk/src/form.ts`).
- **What the design system's stylesheet does not reach.** `fallbackTokens` maps Datum's tokens to
  the design system's custom properties. They style what Datum draws inside the binding: the types
  you did not write.
- **A self-check.** `designSystem.selfCheck(root)` returns one problem for each thing the host's
  files should have supplied and did not: a custom property the markup reads, a script's result.
  It returns an empty list when they are there.
- **Author classes and looks.** `cssClasses` lists the classes an author may put in a component's
  `cssClass` and that the binding's CSS gives a meaning to. An entry is a bare name, or a
  declaration `{ name, label?, description?, types?, group?, groupLabel? }`. `label` and `description` are
  what the builder's Style tab shows (the four shared looks are worded by the builder's own text tables
  unless the binding relabels them); `types` names the component types the class applies to (as written
  or as the type they read as; absent means any component, an empty list none), so the tab offers it on
  those components only; classes that share a `group` exclude each other on one component (ticking one removes the
  others of the group from `cssClass` in the same edit), which the tab draws as one choice whose
  first option, Default, clears it and returns the component to what the binding draws with no
  class, headed by `groupLabel` when given. A name declared twice is one class: a later declaration
  replaces the earlier entry in its place, a later bare name never downgrades it.
  The class names are also the vocabulary the builder's class check notes a class outside of, with the
  shared panel looks always accepted: a binding that declares only those looks declares no vocabulary
  (the check reads token syntax alone), and one with classes of its own keeps them as its vocabulary with
  the looks accepted in addition. The look of a panel is the shared vocabulary every binding uses, so a form
  stays portable: `panel-plain` (the heading with the fields under it: no border, no background, no header
  band), `panel-outlined` (a border, with no header band and no fill), `panel-shaded` (a light
  background, with no border) and `panel-card` (a border, a header band behind the heading and a
  surface for the fields),
  all in the group `panel-look` for `panel` (`render/live/look-classes.ts`). A binding declares the ones
  it draws, writes their CSS from its own tokens, and decides what no class means: Datum's panel is
  the card, the GC Design System's is plain. A panel adapter puts `state.classNames` on its section (keeping only the last look
  class when a hand-written list holds two, since CSS cannot follow a class list's order) and
  keeps the heading a real heading in every look; a binding that declares none of them leaves its
  panel as it draws it. A look also prints: the print model carries it on the panel's group and each
  print theme draws it from its own tokens (`docs/print-support.md`, ADR 0035), so a binding writes
  no print CSS for it. A binding package that never imports the engine at run time restates the four
  declarations and holds them equal to the engine's with a test (`bindings/gcds/tests/panel.test.ts`).

## 4. Wrap and patch, never copy

Where the design system differs from Datum only a little, take Datum's adapter and wrap it. The
Québec fieldset draws its own legend and hint around Datum's group layouts:

```ts
const datumEntry = datum.components["fieldset"];
const datumGroup = (Array.isArray(datumEntry) ? datumEntry : datumEntry === undefined ? [] : [datumEntry])
  .find((adapter): adapter is GroupAdapter => adapter.kind === "group");

const fieldset: GroupAdapter = {
  kind: "group",
  name: "qc-fieldset",
  capabilities: { hideLabel: "drawn" },
  template(s, children) {
    if (s.legend === undefined) return datumGroup?.template(s, children) ?? children;
    const { legend: _legend, hint: _hint, hintId: _hintId, ...unnamed } = s;
    const inner = datumGroup?.template(unnamed, children) ?? children;   // Datum's layouts, no name of their own
    return html`<fieldset class="qc-fieldset" …><legend>…</legend>…${inner}</fieldset>`;
  }
};
```

Every reference date adapter keeps Datum's focus rule the same way, through
`datum.components.date`:

```ts
const datumDate = datum.components.date as FieldAdapter<DateFieldState> | undefined;
// …
focusTarget: (field, s) => datumDate?.focusTarget?.(field, s) ?? field.querySelector('[data-value-part="day"]')
```

Do not paste Datum's adapter into the binding: a copy stops tracking the renderer. The same holds
for a host that changes a binding without forking it:

```ts
import { bindings, extendBinding } from "@argusvane/datum";

const mine = extendBinding(bindings.fromFactory(createBinding), {
  components: { text: (base) => wrap(base) },   // a function of the binding's own entry
  css: "…",
});
```

`extendBinding(binding, overrides)` takes each component override as an adapter (or a list), or as
a function of the binding's existing entry that returns one. Every other key replaces the
binding's own. A plugin type's `adapter` (section 8) is laid over whichever binding draws the
form in the same way.

## 5. The Datum seams

The `datum` binding keeps its customisation seams as options of `createDatumBinding({ … })`
(`render/live/datum/options.ts`). They let a host restyle Datum without writing a binding:

| option | what it changes |
|---|---|
| `tokens`, `responsiveTokens`, `dark` | the token sets (`FORM_TOKENS`): light, by viewport or form width, and dark (`false` draws the light look in either scheme) |
| `frame` | frame presets beside the built-ins (`seamless`, `outlined`, `paper`): a label for a picker and the rules for `.datum-form--frame-<id>`; a preset under a built-in id restyles it |
| `parts` | `labelMarks`, `tooltipMark`, `errorMessage`, `optionRow`, `fieldShell`, `button`, `stepBack`, `summary`, `notice`, `status` (the in-flight line), `requiredNote`, `journeyHeading`, `journeyActions`, `journeyReview`; each is handed Datum's own drawing as `default`, to return, wrap or replace |
| `renderers` | per component type, an adapter or a list of adapters told apart by `when`, or a function of Datum's entry that wraps or patches it; container types take container adapters the same way |
| `chrome`, `languageSwitcher` | chrome part adapters by part type, and the language switcher, each handed Datum's own to wrap |
| `controls` | native-control choices: choice marks, error icon, summary list, error focus, tabs width (`tabsFrom`), number box, textarea rows, select placeholder and chevron, where a choice group carries its state (`choiceState`), ARIA states, option hints, group description and error placement, inline errors (alert or plain text), date controls, language links, and the container choices (panel and step regions, step pages, segments and progress, action order, button group) |
| `fieldOrder` | the order of label, description, control and error, and a date's part order (fixed, or a function of the locale) |
| `css`, `formClass` | rules after the sheet and the token sets; more classes on the form element |
| `texts`, `messages`, `cssClasses` | the binding's language pack; the author classes it gives a meaning to (Datum always declares the four panel looks, and a host's own join them; an entry under a look's name replaces it) |

Every option is typed and draws through lit templates; none takes an HTML string. A part or
override always stays inside the leaf: the field's wrapper, its state hooks, the ids the state
names, the write guard and the focus rules are the renderer's, out of a part's reach. A part that
returns `undefined` draws Datum's own, and one that throws does too, reported on the console once
per part.

`composeDatumOptions(base, …more)` builds one option set on another: overrides compose in order,
language packs merge and classes join. `createDatumFeatures(options)` lists the renderer's modules
for a mount, so a date's state follows the part order the drawing adapter uses. A design-system
binding does not use these options: it replaces adapters. They are for restyling Datum itself. Both are
exported, with their types (`DatumBindingOptions`, `DatumControls`, `DatumParts`, `DatumFrame`,
`DatumFieldOrder`, `AdapterOverride`, `ChromeOverride`, `DatumBinding`), by `datum-form.js`
(`@argusvane/datum`) and the engine's `render` entry, so a page on the bundle restyles Datum
without the engine's source. A host sets the result as the form's `binding`, or registers it
under an id of its own:

```js
import { createDatumBinding, bindings } from "./datum-form.js";

const acme = createDatumBinding({ id: "acme", label: "Acme", tokens: { "color-accent": "#00539b" } });
document.querySelector("datum-form").binding = acme;   // or bindings.register(acme), then .binding = "acme"
```

Frames are the one seam that is also part of the binding contract: `LiveBinding.frames` lists
the frame presets a binding adds, by id, and `chrome.frame` may name any of them under that
binding (an id no binding lists is drawn in the default frame, with a warning). The Datum
binding carries the frames its `frame` option was given. A design-system binding that offers a
frame lists it there and draws it in its own `css`, under `datum-form--frame-<id>`.

### Datum's markup, sheet and surface

What a host's CSS and tests can hold on to in the Datum binding.

- **Control classes.** Every control carries `datum-form__control datum-form__control--<kind>`,
  with `<kind>` one of `text`, `number`, `date`, `textarea`, `select`, `checkbox`, `radio` and
  `file`, on the field's own control and on every option input (`controlClassNames`,
  `render/live/datum/field-scaffold.ts`). The text-like kinds also carry
  `datum-form__control--box`, and the language switcher's select carries the `select` classes. The
  sheet selects on the class; the attributes stay in the markup for validation and the browser.
- **Resets at zero specificity.** `.datum-form :where(input, select, textarea, button)` inherits
  the font, and state rules are written as `.datum-form__control--text:where([aria-invalid="true"])`,
  so a host's bare class wins by cascade order alone. The read-only mode's rules stay strong: they
  are a mode, not a look.
- **Field state is on the field.** The renderer writes the state hooks on every field wrapper
  (section 3). Datum's field shell also carries `datum-form__field--<kind>` and the modifiers
  `--required`, `--invalid`, `--disabled`, `--readonly` and `--over-limit` (`fieldClassNames`), so a
  host's CSS reaches the label, hint, error and control from one selector. The sheet reads the
  hooks and the form's `data-mode` and `aria-busy`, never the modifier classes; the one modifier it
  selects on is the kind class. An invalid box's error border keys on the control's
  `aria-invalid` and on the wrapper's `data-invalid`, so it holds under every `controls.ariaStates`. The hooks are the selectors for tests, agent tools and a host's
  CSS across bindings; `datum-form__*` classes are Datum's own markup only.
- **Headings.** The panel title, step heading, notice title and summary heading are heading
  elements at a level under the form's own (`headingLevel`, the `heading-level` attribute of
  `<datum-form>`), and the summary's entries are links to their fields.
- **Accessibility of groups and choices.** These hold under the default `controls.ariaStates`
  (`"marked"`).
  - A group's required marker is words in its legend (`marksView` with `announced`,
    `render/live/datum/field-scaffold.ts`). The checkbox and date fieldsets carry no
    `aria-required`, because a `group` role has no required state; the radio group keeps it
    (`role="radiogroup"`). A control's own label draws the marker `aria-hidden`, because
    `aria-required` on the control carries it.
  - An invalid date marks every part `aria-invalid` and gives each `aria-describedby` the field's
    error id (`date.ts`); the fieldset keeps its own description. Under `ariaStates: "required"` a
    part is still described but not marked; under `"none"` only the fieldset is described.
  - `controls.choiceState` is `"group"` (the default: the state sits on the group) or `"each"`:
    `aria-required`, `aria-invalid` and `aria-describedby` (the input's hint, then the group's
    error) on every radio and checkbox, because some screen readers do not read a group's
    description. The native `required` attribute is never written: the browser's own validation
    bubble would answer an implicit submit, and on a checkbox it demands every box.
  - A labelled container is a `<fieldset>` named by its `<legend>` (`datum-form__group-label`, id
    `<instance key>__group-label`, `groupLabelId` in `groups.ts`), and the fieldset carries
    `aria-labelledby` and `aria-describedby`. A legend is outside the heading outline, so the
    group's label does not follow `headingLevel`; panel titles and step headings do. The sheet
    floats the legend so that it lays out as a grid item. A panel's section is described by its
    description (`aria-describedby`), and a hidden label hides the heading only: the description
    stays in sight.
- **Tokens.** Every value in Datum's sheet is a custom property with an engine literal as its
  fallback, and no colour is bare, so a form with no tokens set still paints from the literals.
  `FORM_TOKENS` (`render/live/datum/tokens.ts`, in tiers `base`, `derived` and `geometry`) lists
  each one with what it drives and its fallback, and a test holds it and the sheet to each other
  both ways. `DATUM_TOKENS` and `DATUM_DARK_TOKENS` (`default-tokens.ts`) are the studio look as
  literals. Geometry (focus ring, radii, control and button padding and size, label, hint and
  error type, spacing, layout width) is tokens too, so restyling a box is one line. A
  `:focus-visible` ring from the focus tokens covers controls, buttons, summary links and tabs.
  Light and dark share the geometry and type; the dark set holds its own palette. Each value of
  the light set is the studio's token (`builder/web-component/studio-tokens.ts`) copied as a
  literal, not read through `var(--db-*)`, so a change to a studio token is followed here by hand.
  Token by studio token:

  | Datum token | studio token |
  |---|---|
  | `color-text` | `db-ink` |
  | `color-muted`, `color-secondary` | `db-ink-muted` |
  | `color-input-border` | `db-line-input` |
  | `color-border` (the card line around panels and the frame) | `db-line-card` (`#9aa2ad` in the light set) |
  | `color-input-bg`, `color-panel` | `db-surface` |
  | `color-panel-header`, `color-light` | `db-surface-sunken` |
  | `color-accent` | `db-accent` |
  | `color-on-accent` | `db-accent-ink` |
  | `color-choice-mark` | `db-selected` |
  | `color-dark` | `db-ink` |
  | `color-error` | `db-danger` |
  | `color-error-bg` | `db-danger-soft` |
  | `color-error-border` | `db-danger-line` |
  | `color-success` | `db-ok` |
  | `color-warning` | `db-warn`; white text on it is `color-on-warning` (`#ffffff`) |
  | `font-family` | `db-font` |
  | `radius-control` | `db-radius-md` |
  | `radius-button` | `db-radius-pill` |
  | `radius-panel`, `radius-frame` | `db-radius-lg` |
  | `font-size-label` | `db-text-md`, at weight 500 |
  | `font-size-title` | `db-text-xl` |
  | `font-size-heading` | `db-text-lg` |
  | `spacing-field-gap` | `db-space-4` |

  The studio has no info colour: `color-info` is `#1c6e8c`, a teal that carries white text.
- **Choice controls and face.** Checkboxes and radios are native, 20px (`DATUM_CHOICE_CSS`; the
  option row keeps a 24px target through `--target-min-size`), painted through
  `accent-color` from `color-choice-mark` (else `color-accent`), unless `controls.choiceMarks` is
  `"drawn"`. `font-family` names Geist first and falls back to the system stack; the binding
  loads no font, and Geist reaches the page when a builder with `load-fonts` is on it.
- **Contrast floors.** Text, muted text, the accent, the error and white text on every filled
  button hold 4.5:1 on white and on the light well; input and error lines hold 3:1. The dark set
  names every colour the sheet reads, at 4.5:1 text and 3:1 input borders.
  `engine/tests/datum-token-contrast.test.ts` resolves every pair the stylesheet draws, in both
  sets, against the WCAG 2.2 AA floors.
- **Surface and scheme.** `.datum-form` reads `--color-surface` (default `transparent`) for its
  background and `--color-scheme` (default `normal`) for the CSS `color-scheme`. The light set
  leaves both unset. The dark set owns both: it paints its own surface and sets `dark`, which
  reaches the date picker, the select popup and the scrollbars a stylesheet cannot. Paper is
  light: the print document sets `color-scheme: light` on a white page, so the dark set never
  reaches print. The light set
  is applied on `.datum-form` and the dark set on `.datum-form--dark`, which the binding's
  `formClass` adds while the host's colour scheme is dark (`colorScheme` on the element;
  `dark: false` keeps the light look in either scheme). The engine's defaults do not respond to
  `prefers-color-scheme`: the host decides the page's scheme and passes it as `colorScheme`. A
  host that embeds the form on a card of its own paints the card in the form's surface colour, or
  a dark form shows a light frame.
- **The sheet's rules,** at low specificity so a host's `css` for the same state outranks them,
  held by `engine/tests/default-themes-gc-practices.test.ts`:
  - an invalid text, number, date, select or textarea, and an affix inside an invalid field, take
    `border-color: var(--color-error)`; a choice keeps its mark;
  - the help bubble (WCAG 1.4.13) is `tooltipView` (`render/live/tooltips.ts`) and answers the
    `tooltip` capability `drawn`: the bubble carries the id `<fieldId>__tooltip`, which joins the
    control's `aria-describedby`, and the control keeps no `title`. The mark is a keyboard stop
    named by the `tooltipHelp` text; the bubble shows on `:hover` and `:focus-within` and takes the
    pointer while shown. The renderer owns the rest under every binding: Escape closes the bubble
    (`data-dismissed`, cleared once the pointer and focus have left), Enter or Space on the mark
    toggles it, and a click on the mark or the bubble is not forwarded by the label to its control;
  - a disabled box outside read-only mode takes `--color-disabled-bg` (`#eceef1` in the light set,
    `#243245` in the dark set), the panel line, the muted ink and `cursor: not-allowed`;
  - at 320px the field, the control groups and the date group take `min-width: 0`, so a control's
    intrinsic width does not widen the grid;
  - the focus ring also covers the step label, the help mark and links in the html component and
    chrome html, and the native date picker's button: it would show Chrome's own ring in the
    browser's blue and no author state selector reaches it, so the sheet sets the ring's colour and
    offset on the pseudo-element outright;
  - every font size in `STUDIO_GEOMETRY` is in rem, so a larger browser text size gives a larger
    form (WCAG 1.4.4);
  - hints, errors and counts are 13px (`0.8125rem`) while the body stays 14px; the error is weight 600 and leads with a drawn icon
    (`controls.errorIcon`, drawn by default), so colour is not its only cue; `control-max-width`
    is `min(75ch, 100%)` and `text-max-width` caps hints, errors, counts and group descriptions at
    `65ch`;
  - a `number` draws as `type="text"` with a numeric `inputmode` (`controls.number`, `"text"` by
    default; the value is still stored as a number), and an invalid submit moves focus to the
    error summary (`errorFocus: "summary"`), whose entries link to each field; the first invalid
    field takes it only where there is no summary;
  - the default notice carries a visually hidden kind word ahead of its title or message, from the
    form texts `noticeSuccess`, `noticeInfo`, `noticeWarning` and `noticeError` ("Success: ",
    "Information: ", "Warning: " and "Error: " in English; other languages come from the form's
    translations or a binding's language pack);
  - the dark affix reads `color-text` (`DATUM_DARK_CSS`), because the muted ink is below 4.5:1 on the light well the
    affix sits on.
- **The builder's sheet follows the drawn form.** `.canvas-surface` reads `--db-sheet-bg` (default
  `#fff`). After each draw the canvas reads the drawn `<form>`'s computed background and writes it
  there, or removes it when the form is transparent (`syncSheetColour`). A builder theme never pins
  `--db-sheet-bg`. A dark builder draws the canvas in the dark scheme when the binding has a dark
  look (Datum's, or a binding's `darkVariant`), else light (`canvasColorScheme`).

## 6. Host files and scripts

`binding-check.json` is the asset list that the kit and `datum-binding-check` read, in the shape a
host gives the element:

```json
{ "designSystem": "GOV.UK Frontend", "binding": "src/index.ts",
  "stylesheets": ["/node_modules/govuk-frontend-6.6.0/dist/govuk/govuk-frontend.min.css"],
  "scripts": [{ "url": "/node_modules/govuk-frontend-6.6.0/dist/govuk/all.bundle.js", "classic": true }],
  "bodyClass": "govuk-frontend-supported" }
```

`bodyClass` and `lang` are the host page's own preconditions (GOV.UK's script needs a body class).
A host passes `assets` with the same entries as `{ url, integrity? }` objects. A script entry adds
`classic?`, and `attributes?` for a script that reads its own element (Québec's
`sdg-css-path`). `rootFontSize` gives the page's root size when the design system expects another.

The assets feature (`render/live/assets-feature.ts`) loads the files before the first draw; the loader
(`render/live/assets.ts`) is a chunk of its own, loaded only when a mount has files. The Datum
binding's sheet is bundled and never takes this path. A stylesheet is handled in four steps:

1. **Fetched** with `fetch()`, once per page per `(url, integrity)`, so it must be same-origin or
   served with CORS.
2. **Composed as text.** Every relative address is resolved against the sheet's own address: a
   `url()` in any case and a string inside `image-set()`, but nothing inside a comment or another
   string. Leading `@import` rules are replaced by the text they name, in place among the `@layer`
   statements around them (so the layer order stays the sheet's), keeping their `layer`,
   `supports()` and media conditions.
3. **Parsed and rewritten** over the browser's parsed `cssRules`, recursing into nested and
   grouping rules: selectors that open with `html`, `body` or `:root` (also inside a leading
   `:where()` or `:is()`) name `:host` instead (`shadowSheet`); page-only declarations on the bare
   page elements are dropped; `@font-face` rules are taken out; and when the design system expects
   a different root font size than the page has (`designSystem.rootFontSize` against
   `assets.rootFontSize`, default 16), `rem` lengths become `calc(n * var(--datum-rem))`.
4. **Adopted** into the root ahead of the renderer's own sheets, so the renderer's structure and
   the binding's `css` win a tie.

One constructed sheet per `(document, url, integrity, rewrite options)` is shared by every form
that names it, counted, and released with the last of them. The renderer notes the root's adopted
sheets before it adopts its own, and on unmount removes every sheet added since, including any a
design system's script adopted into the root while the form was mounted. Page CSS does not reach
the form, and the form's CSS does not reach the page.

**Fonts** are page-wide. A face declared inside a shadow root is never registered, so the faces
from the design system's stylesheets and from `assets.fonts` go into one document-level sheet per
binding (`document.adoptedStyleSheets`), and nothing else goes there. That sheet is shared by every
form drawn with the binding and removed with the last one. A font sheet that cannot be loaded is
reported (`datum-binding-error`, `hook: "assets"`) and the form still draws, because text falls
back to another face.

**Scripts** are the design system's, loaded once per page per absolute address, as a module unless
`classic` (classic scripts run in the order they are listed). A script the page already carries
counts as run. A script is never unloaded, because the custom elements it defines cannot be
undefined, and asking for an address already loaded with a different `integrity` is refused. The
browser checks a script's `integrity`; scripts are fetched with `crossorigin="anonymous"` so it can.
Where the browser has Trusted Types, a script's address is set through the `datum-assets` policy,
which a page that enforces them allows by that name. The policy is created on the first script a
binding asks for, so a page whose bindings load no script never creates it, and it passes only the addresses the loader was
handed from `assets.scripts`: it is not a general way past the page's policy. A page that refuses
the name refuses the script, and the form fails as below, naming the policy.

**Integrity.** `integrity` must be a list of `sha256-`, `sha384-` or `sha512-` digests, or the
mount fails. `fetch()` checks it for stylesheets and font sheets.

A stylesheet or script that cannot be had (CORS, network, HTTP error, integrity, CSP) means no
form: an alert (the `formNotShown` text) takes its place, the element emits
`datum-binding-error { hook: "assets", url }`, and `ready` rejects. The builder canvas is the same
element, so it fails the same way. There is no unrewritten fallback: a form half in the design
system's look and half in the browser's would look like a working form and not be one.
Design-system bindings do not work from `file://` pages, which refuse `fetch()`.
[Host security](host-security.md) has the directives, CORS and Trusted Types rules a host page needs.

`designSystem.rootFontSize` is one number. A stylesheet that sets the root size by media query
cannot be followed: Pico sets `html { font-size }` from 100% to 131.25% by viewport width. `rem`
inside the shadow root is the page's own root size, so on a wide page the form is smaller than
the design system's plain page. The kit reports this as the cost of the shadow root
(`shadowTransfer`), never as the binding's fault. Say so in `docs/side-effects.md`.

**Scoped scripts.** A design system's script looks for elements through `document`, which cannot
see into a shadow root. Where the design system supports a scope, start its script scoped to the
form in the binding's `connect(root, form)`. `connect` runs once per mount, after the first draw,
never on a redraw, and returns the cleanup:

- GOV.UK: `initAll({ scope: form })`, with `form` the `<form>` element in the shadow root (`root`
  itself is not an Element). The GOV.UK binding opts components in by markup (it writes
  `data-module="govuk-button"` on its buttons and on nothing else): its radios, checkboxes,
  character count, tabs and error summary look things up through `document`, so they are never
  marked for it. GOV.UK has no teardown, so the binding records the listeners and timers the start
  adds to `window` and `document` and the cleanup removes them.

Where the design system has no scope, draw its no-JavaScript baseline and let the renderer own
the behaviour (a character count it counts and announces). Bootstrap starts none: its plugins
are delegated from `document` and take no scope. USWDS starts none either: its published bundle
starts itself on `document.body` when it loads and exports no scoped start, and its delegated
handlers never match inside a shadow root (`bindings/uswds/docs/side-effects.md`). A Stencil library (GCDS, Ontario) upgrades its elements inside the shadow root
by itself and needs no `connect`. A throw in `connect` is reported as
`datum-binding-error { hook: "connect" }` and undone, never left half-wired.

**Third-party URLs in the design system's own stylesheet.** A stylesheet can reach for another
host at load time: `gcds.css` begins with an `@import` of Google Fonts, and its icon font is a
`url()` on the design system's CDN. A kit run that fetched them would draw its pictures from
whatever the host answered that day (Google serves two different stylesheets for one request,
naming different Noto Sans files, and one in five tier-2 runs drew the other). So the kit and
`datum-binding-check --offline` (which the kit passes) never reach the network. Two lists in
`binding-check.json` say what answers a third-party request instead:

```json
{ "routes": [
    { "match": "https://fonts.googleapis.com/css2",
      "stylesheets": [{ "path": "/node_modules/gcds-fonts-1.1.1/fonts/lato/gcds-lato.css",
                        "rebase": { "path/to/file/": "/node_modules/gcds-fonts-1.1.1/fonts/lato/" } }] },
    { "match": "https://cdn.design-system.canada.ca/@gcds-core/fonts@1.1.1/",
      "files": "/node_modules/gcds-fonts-1.1.1/fonts/" } ],
  "network": [{ "host": "cdn.example.org", "reason": "publishes its icon font only there" }] }
```

- A route answers every request whose URL starts with `match`. `stylesheets` answers with the
  listed stylesheets of the binding's own pinned packages, concatenated; their `url()`s resolve to
  the kit's server, which serves the font files from the same package. `rebase` replaces a
  placeholder prefix the package ships its `url()`s with (the GCDS font stylesheets ship
  `path/to/file/`). `files` mirrors a CDN folder (`match` ends in `/`) onto a folder of the pinned
  package: the URL's rest is the path under `files`.
- `network` lists a host the run may reach because no pinned package holds the file. It needs a
  reason; the kit reports the host as a known network dependency whenever a run used it.
- Any other request to a host that is not the kit's own server is aborted, and the step fails with
  a message that names the URL. `data:`, `blob:` and `about:` URLs are never touched.

**A defect of the design system itself.** A binding never patches or works around one. When a case
fails only because the design system's own element misbehaves (a case you can reproduce with the
design system's markup alone), declare it in `binding-check.json` with the reason:

```json
{ "known": [{ "case": "MV-01", "reason": "the design system's own field throws when it is put back in the DOM", "since": "2026-11-14" }] }
```

`case` is an id of the kit's behaviour suite (`BF`, `AF`, `MV`) or of the conformance suite; a case
that is not there is an error, so the list cannot go stale. A listed case that fails is reported as
`known` with its reason and counted apart from pass and fail, and the step exits 0 when only known
cases are left; a listed case that passes fails the step ("listed as known but passes: remove it").
The run's header lists each known defect, as it lists a network dependency.

The files stay in the pinned packages (`devDependencies`): a route copies nothing into the
repository. Routes apply to every page the kit opens for the binding (equality, behaviour, lint,
`datum-binding-check`), not to the package's own `checks` scripts, which launch their own
browser.

## 7. Side effects

A binding draws inside the shadow root, but the design system's script does not always stay
there. Each binding keeps `docs/side-effects.md`; the scaffold writes it with the headings below.
Write "none" under a heading where there is none:

- document-level styles and fonts: the renderer's one font sheet per binding, and any sheet the
  design system adopts, such as a Stencil library's shared sheet, which the renderer removes on
  unmount;
- listeners, timers and observers on `window`, `document` or `body`, and what `connect`'s cleanup
  removes;
- markers on `<body>` or `<html>`;
- nodes added outside the form's root (overlays, tooltips): `selfCheck` reports them;
- globals the classic script defines;
- what the host must provide: files, body class, page language, the page font and its licence.

A change the design system makes outside the form also goes in `designSystem.sideEffects` as
`{ target, effect }` entries. The self-check reports them, and so does the conformance suite's
run header, never as a problem. Examples are the page-wide font sheet, the page-wide custom-element
registry (the first definer wins, so a page draws every form of one web-component design system
with one release), Ontario's language toggle writing `<html lang>` and Québec's `qc-dark-theme`
class on `<html>`.

## 8. Capabilities, notices, pending and tier-2 types

**Capabilities.** For each drawing capability, an adapter answers `drawn`, `degraded` or `none`
(`tooltip`, `notice`, `pending`, `prefix`/`suffix`, `characterCount`, `hideLabel`,
`placeholder`, `rowNumbers`, `workedOut`). Answer what the markup *draws*, not whether the design
system's script runs. Markup drawn as its script would leave it, with the behaviour the renderer's,
is `drawn`; a character count the adapter draws is `drawn` whoever counts. `degraded` means drawn in
a reduced form: a tooltip, pending state or worked-out line is folded into the hint by the renderer,
a notice is hint-styled text led by its severity word, and a count is drawn but not announced.
`none` means not drawn: the id is left out of `describedBy`, and a use is recorded as `<component
id>: <capability>` in `unsupported()`. An unanswered capability is `none`. The capabilities are
separate from the editor capabilities (`registry/capabilities/field-capabilities.ts`), which say
what the inspector offers an author: whether a property can be authored says nothing about whether
a design system can draw it. The builder reads the answers (`capabilityAnswers`): it shows `drawn`,
shows `degraded` with a note, and hides `none`. Two flags say who runs a composite's keys and who
counts characters (`keyboard`, `countsCharacters`: `component` or `renderer`, default `renderer`).
Datum's code-point count and its over-limit error always apply, and no adapter writes `maxlength`.

**Notices.** Blocking errors and notices are different things. `FieldState.errors` holds blocking
errors only. Warnings and info arrive as `state.notices`, and are drawn with what the design
system offers: GOV.UK warning text and inset text, a USWDS slim alert, GCDS hint-styled text with
a severity word. Notices carry the `noticeId` in `describedBy`. They never set `aria-invalid`,
never enter the summary, and never use the error styling.

**Pending.** A field whose asynchronous check is running gets `state.pending`, and the renderer
writes `data-pending` and `aria-busy`. The adapter draws it with what the design system has, or
answers `degraded` (a word in the hint) or `none`.

**Tier-2 types and base types.** Two tiers:

1. The design system's own component draws a Datum component where its behaviour fits Datum's.
2. Where its behaviour differs drastically (the author's judgement, not a rule), the binding draws
   Datum's component in the design system's HTML and tokens. The package then registers an extra,
   design-system-specific type with a **base**, which wraps the official component: `gcds-date`,
   base `date`. The base is an engine type; there are no chains.

The type-to-base map travels as data. Every type has a base engine type, an engine type is its own
base, and a type that is not one (a plugin's, or a design system's tier-2 type) is read as the base
the definition's `kinds` map names (`kindOf(type, kinds)`, `registry/kinds.ts`). Validation, the
sandbox kernel, the agent's field kinds, the PDF and the renderer all ask it rather than switching
on a type name. The structure check refuses an entry whose base is not an engine type and an entry
that maps an engine type. A container base (`fieldset`, `panel`, `tabs`) is followed only by the
drawing, and only for a component that holds children. The definition carries `kinds: { "gcds-date": "date" }` for
every non-engine type it uses, so a sandbox or PDF program on a server validates the type as its
base without any binding code. `<datum-form-builder>` writes that entry on save and download for
each such type the form uses, keeping the entries of the file it opened. The engine's own
`<datum-builder>` writes no definition: a host that builds its own Save, Download or definition
from it must write the map itself, with `builder.controller.definitionKinds(opened.kinds)` (or
`definitionKindsFor(root, offeredKinds(...), opened.kinds)` from the engine's `registry` entry, given
the bases its catalogue and bindings offer), and should set `builder.controller.openedKinds = () =>
opened.kinds` when it opens a file, so Try it checks with the same map. A host that lends Try it
its own server checks (`TryItServerChecks.run`) must put the request's `kinds` into the kernel's
run context (`context.kinds`); dropped, the server checks such a type as nothing while the page
checks it as its base. The binding lists its types in `LiveBinding.kinds`, and a plugin type says its base as
`ComponentDefinition.base`. The renderer draws a form with the binding's `kinds` under the
definition's. A type used without the definition's entry is drawn as its base and reported in
`unsupported()`, because only the definition's map reaches validation and the server. Under another
binding, the lookup chain draws the base.

The package ships its tier-2 types as a FormPlugin. Each type is a `ComponentDefinition` with
`base`, an `adapter` factory `(lit, datum) => adapter`, and `palette.binding`, so the builder
offers the type only while that binding draws the canvas. From `bindings/gcds/src/plugin.ts`:

```ts
const date: ComponentDefinition = {
  type: "gcds-date",
  version: "1.0.0",
  base: "date",
  createDefault: () => ({ id: "gcds-date", type: "gcds-date", configuration: { label: "Date" } }),
  capabilities: fieldCapabilities(),
  adapter: (lit, datum) => createDate(lit, datum).gcdsDate,
  palette: { label: "GC date", group: "GC Design System", icon: "📅", binding: "gcds" }
};
export const gcdsPlugin: FormPlugin = { id: "gcds-components", version: "1.0.0", components: [date, header, card, link, details, notice, icon] };
```

A host registers it beside the binding: `plugins.register(gcdsPlugin)`. Content types that hold no
answer (GCDS's header, card, link) declare no base.

Tier-2 CSS is the binding's own and counts toward `budgetKb`. Without its script, a design system
such as GCDS ships only tokens and fonts, so the tier-2 drawing needs component CSS that the
binding writes from the design system's tokens. Tier-2 types have no external reference; the kit
compares them with their own accepted screenshots (section 9).

## 9. Testing a binding with the kit

The kit lives in `packages/datum/binding-kit/` and runs from the package:

```
npm run kit:check        package, build, tokens, binding, equality, behaviour, checks, conformance
npm run kit:build        the ES and IIFE bundles, with the import, lit-html and budgetKb gates
npm run kit:equality     only the equality cases          (--only a,b   --report dir   --update-baseline   --list)
npm run kit:behaviour    only the behaviour cases         (--only BF-01,AF-01)
npm run kit:conformance  only datum-binding-check         (--report dir   --only MNT,VAL   --baseline report.json)
npm run kit:serve        the reference and the binding side by side
```

`kit:check` takes `--only <steps>` and `--skip <steps>`, using the step names above.
`kit:check`, `kit:equality`, `kit:behaviour` and `kit:conformance` take
`--browser chromium|firefox|webkit` and `--port`; `kit:serve` takes `--port`; `kit:build` takes
`--binding` alone. Pixels are required in Chromium only;
boxes, text and behaviour are required in all three. `--binding` is a package id under
`bindings/`, `datum`, or a package folder (`.`). The kit's ports are 5200-5219.
`BINDING_KIT_PORTS=5600-5619` moves the range for a second checkout or agent. `--port` names one
port, inside the range or not. Exit codes: 0 pass, 1 a case failed, 2 usage error or nothing
asserted, 3 preflight, 4 internal.

The kit runs offline (section 6): the browser reaches the kit's server and the `routes` and
`network` of `binding-check.json`, and a request to anything else fails the step naming the URL.
`kit:serve` is a viewer in your own browser and is not restricted.

### Binding lint

The **binding** step loads the binding in the browser and reports what the renderer would ignore
silently:

- a `fallbackTokens` name without its two leading dashes, or one that is not a Datum token;
- a value the renderer refuses;
- an adapter with no `template` or `kind`;
- an `errorFocus` that is neither `summary` nor `field`.

`kit:check --only binding` runs it alone.

### Equality (tier 1)

`reference/<case>.html` is one case: a leading comment of JSON, then the markup that the design
system's own template (or documented example) produces. The kit draws it three ways on the pinned
release and compares them:

- **plain**: the markup in the document, with the design system's files loaded as its own page
  loads them;
- **shadow**: the same markup in a shadow root, with the files adopted by the renderer's own
  `adoptInto`;
- **binding**: the form the case describes, drawn by the binding.

The reference is the design system's markup with the design system's files only. A rule in the
binding's own `css` that changes a drawn case is a difference, and the case fails: drop the
rule, or mark the case `known` with the reason. The comparison covers what is seen and what is
read as text, never ARIA. `datum-binding-check` checks `aria-describedby` and the ids; a case does
not. The text lines are Datum's English wording unless the binding's pack changes it ("Label: This
field is required" for a summary entry, "1 error" for its heading, "Select..." for an empty
select), so a hand-written reference carries those words.

A case gates on shadow against binding: a loss the binding causes. Plain against shadow is
reported beside it as the cost of the shadow root, never the binding's. There are three
comparisons, each its own failure:

- **pixels**: the differing fraction, by default at most 0.05%;
- **every element's box, font and colour**, paired in document order, by default within ±1 px;
- **the composed-tree text lines** with their marks: `[visual]` (seen, and hidden from
  assistive technology), `[sr]` (read only), `[live]` (in a live region).

```html
<!-- datum-reference
{ "source": "govuk-frontend 6.6.0: components/input/fixtures.json, fixture \"with hint text\"",
  "components": [ { "id": "field1", "type": "text", "configuration": { "label": "…", "required": true } } ],
  "init": "window.GOVUKFrontend.initAll();",
  "steps": [ { "op": "validate" } ],
  "root": "form" }
-->
<form novalidate> …the design system's markup… </form>
```

| key | meaning |
|---|---|
| `source` | required: the template or page the markup comes from |
| `components` / `definition` | the form the binding draws (a list, or a full definition); `preset`, `locale`, `mode` set its answers, language and mode |
| `steps` | what is done to the drawn binding: `validate`, `focus`, `type`, `set`, `click`, `press`, `blur`, `settle`, `wait` |
| `root` | the selector in the markup that stands for Datum's `<form>` |
| `width` | the frame width in px (default 560) |
| `init` / `initShadow` | the design system's own start in the document / in the shadow root (none by default: a script that looks things up through `document` cannot run there) |
| `compareWith` | `"plain"`: hold the binding to the document picture, for a design system whose script changes what is drawn and cannot run in a shadow root |
| `focus` | a selector to focus in the markup (the binding side uses a `focus` step) |
| `tolerance` | `{ pixels, box }` |
| `ignoreText`, `ignoreBoxes` | `[{ match, reason }]`: lines or elements dropped from both sides, each with its reason |
| `known` | a reason: a documented gap; the case is reported as a known difference while it differs, and fails once it stops differing |
| `skip` | a reason: reported, not run |

States beyond first paint are cases of their own: an error after submit, focus, typed or preset
answers (the count), read-only and disabled (`mode`), a tab switched or a row added (`click`), a
translated form (`locale`).

**Generate references where the design system ships templates; hand-write them only where it
does not.** GOV.UK ships a `fixtures.json` per component, holding the options and the markup its
Nunjucks template renders. `bindings/govuk/reference/generate.mjs` renders those options with the
release's own macros, asserts the render equals the shipped fixture, writes the references, and
builds the form the binding draws from the same options. Where the design system ships no
templates, write the markup by hand from its documented examples and cite the page in `source`. A
hand-written reference can agree with a wrong binding (a `required` attribute the design
system's template has no parameter for), so prefer generated ones.

### Tier-2 baselines and sign-off

**Tier-2 cases** (`tests/tier2/<case>.json`, the same keys without markup or `source`) have no
reference. The binding's picture is compared with its own accepted baseline in
`tests/tier2/baseline/`. A first baseline is never accepted silently:

1. `--update-baseline` writes the candidate PNGs, lists them with their sha-256 in
   `manifest.json`, and leaves `signOff.reviewer` and `signOff.date` blank.
2. A person looks at each PNG and fills in the reviewer and a `YYYY-MM-DD` date.

Until the sign-off is filled in, the case fails. A PNG passes only when the sign-off names it with
the sha-256 it has now: changed bytes blank the reviewer and date, so a changed picture always
needs a fresh look, and a PNG added after the sign-off fails until it is signed off. Baselines are recorded per platform and browser; a
run on another platform reports the case as skipped, with that reason.

### Behaviour

One binding-agnostic suite (`behaviour.mjs`), the same cases for every binding:

| case | what it holds |
|---|---|
| BF-01 | back/forward without the page cache: the page loads again and the form is drawn again with the answers the page kept, in the design system's look |
| BF-02 | a page-cache restore (`pageshow`, `persisted`) leaves the form drawn and taking input |
| AF-01 | autofill (value set, `input` with `insertReplacementText`, `change`, no keys) on a text field reaches the answer and survives a redraw |
| AF-02 | the same on a select; skipped when the select draws no native `<select>` (a custom listbox, its combobox found by role), which a browser does not autofill, as VAL-05 skips |
| AF-03 | a field's `autocomplete` token reaches the control a browser autofills |
| MV-01..03 | the form element, or a `mountLive` host, moved in the DOM (in the same task, or later) keeps its form, answers and look |
| MV-04 | the element removed for good takes its sheets and fonts with it |

### Conformance

`datum-binding-check` (the conformance suite's command, `packages/conformance-suite`) is what a
binding's CI runs. `kit:conformance` runs it with the package's `binding-check.json`. For a module
kept outside `bindings/`, the command is
`datum-binding-check --binding src/index.ts --assets binding-check.json`. It covers:

- mount, assets, selfCheck and unmount;
- value round trips, errors, the summary and focus;
- the count announcer, read-only, dates, grids, tabs, journeys and translations;
- the DOM contract and accessibility references;
- capability honesty and tier-2 fallback.

It checks what Datum and the binding write, never the design system's internals. The binding's
capability answers choose which cases run, a case skipped for `none` is reported with its reason,
and a design system's console warnings are reported, never failed. The kit delegates
to it (`conformance.ts`), so a binding's CI and the kit agree. When the pinned release moves, run it
with `--baseline` against the report of the last known-good release. It prints which cases changed
state, which is the only place a release drift shows. The command's options, exit codes and cases
are in [Conformance suite](conformance-suite.md).

## 10. The token contract (GCDS pattern)

A binding that draws from design-system custom properties in its tier-2 CSS, print theme or PDF
theme can keep a `tokens.json`. GCDS shows the pattern; other bindings need not follow it:

```json
{ "generatedFrom": { "package": "@gcds-core/tokens", "version": "1.6.0" },
  "tokens": [ { "name": "--gcds-text-primary", "unit": "color" }, { "name": "--gcds-spacing-300", "unit": "rem" } ],
  "inferred": [ { "name": "pdf.page.margin", "unit": "pt", "reason": "INFERRED: GCDS publishes no print tokens" } ] }
```

The kit's `tokens` step checks every `var()` that the package's `src/`, `print/` and `pdf/` read
against the pinned release's own CSS. It reports a token that is:

- read but not listed;
- listed but not read;
- not declared by the release;
- of another unit than the release writes.

The units are `px`, `rem`, `pt`, `color`, `number`, `font-family`, `shadow` and `any`.
`lib/token-units.mjs` (no Node imports) holds what a theme imports:

- `lengthToPt(value, { remPt })` converts `px`, `rem` and `pt` to PDF points, and throws for
  anything else (`em`, `%`, `calc()`);
- `missingTokens(contract, read)` is what a print theme's `selfCheck` returns.

Generated values carry `generatedFrom`. Anything the design system does not publish is listed
under `inferred`, outside that block, with a reason that starts `INFERRED`.

## 11. Words and language packs

Every word an adapter draws comes from `state.words(key)` or `state.text(property)`; adapters
hard-code no words. Datum's built-in defaults are English only. Any other language comes from the
form's own translations or from a language pack the binding ships:

```ts
texts: { en: { optional: "(optional)", errorPrefix: "Error:", summaryHeading: "There is a problem" },
         cy: { … } },
messages: { en: { required: "Enter your {{label}}" } }
```

The order is: the host's texts, then the form's translations, then the binding's pack, then the
engine's English. A
binding that ships its own languages has fixtures for them. The conformance suite's I18N cases
check three things:

- a translated form draws translated labels, hints, options and the binding's own words;
- switching the locale re-words the form;
- a form in another language on an English page marks its language.

Besides English, GCDS, Québec, Nova Scotia and Ontario ship French; USWDS ships Spanish and
French; GOV.UK ships Welsh and French. Alberta's pack is English only, and Bootstrap ships none.
The error summary line is `summaryEntry` (GCDS
`"{{label}} - {{message}}"`).

## 12. Print and PDF

### Print themes

Print never loads a design system's JavaScript. Its components would not have hydrated when the
dialog opens, and hydrated ones clip long answers and split across pages. A print theme is a pure
function from the print model to static markup, styled by its own sheet, which may lean on the
design system's stylesheet and fonts:

```ts
export const gcdsPrintTheme: PrintTheme = {
  id: "gcds",
  label: "GC Design System",
  css: "…",                       // restates label, hint, input, radio, checkbox, legend, heading, table from --gcds-* tokens
  marginBox: "…",                 // declarations for the running header and footer lines
  texts: { … },                   // the theme's words, under the page's texts and the form's translations
  renditions: ["answers", "blank", "filled"],   // the renditions it draws; absent means answers and blank
  draw: { title, field, group, grid, section, content },   // partial: the basic theme draws what is left out
  selfCheck(doc) { /* a problem when a token tokens.json lists is not defined in doc */ }
};
```

- A drawer returns markup made by `context.html`, the `printHtml` tag it is handed, which escapes
  every value. Never import the tag. Markup is branded by the engine copy that drew the form, so a
  theme built as its own package draws through the tag it is handed. A drawer that returns a raw
  string, or throws, sets the theme aside, and the whole form prints with the basic theme.
- `filled` hands a drawer shapes the other renditions do not (a text without its affixes joined, a
  date as boxes with values, a select with every option listed), so a theme declares the renditions
  it draws in `renditions`. Asked for one it does not declare, the whole form prints with the basic
  theme and `datum-print` reports `fellBack` with the reason.
- The renderer owns what prints (`print.show`, rules), the wording, the structure (grids as table
  rows; tabs, steps and journey pages as headed sections in order), the page set-up and the breaks
  that keep a field whole.
- A host gives print the same `assets` it gives the binding. For a theme other than Datum's two
  (`basicPrintTheme`, `datumPrintTheme`), the stylesheets and font sheets are linked into the
  print document, and the scripts never are. `selfCheck` runs once those have loaded; any problem
  prints the whole form with the basic theme, and `datum-print` reports `fellBack`.
- A host sets the theme on the element: `form.printTheme = gcdsPrintTheme`.
- The page's own print (the browser's Print command) does not go through a print theme: it
  prints the live form as the binding draws it. From the window's `beforeprint` to its
  `afterprint`, `LiveContext.printing()` is true and the renderer draws tabs and steps flat
  (`TabsState.flat`, `StepsState.flat`), as in a review, synchronously inside the event. A tabs
  or steps adapter draws its flat view whenever `flat` is set, and the binding's own `@media
  print` rules hide what else should not reach paper (buttons, tooltips, file pickers).

`bindings/gcds/print/` is the worked example. GCDS's stylesheet ships only tokens and fonts
without its script, so the theme restates each component from the tokens, and its `selfCheck`
requires every token `tokens.json` lists. [Print support](print-support.md) describes print as a
form owner and a host see it.

### PDF themes

A binding's PDF theme is a separate, optional export: a `PdfThemeDefinition` with
`target: "pdf"` and an id of its own. The binding suggests it with `LiveBinding.pdfTheme`, either
an id the host's PDF theme registry holds or the theme object itself. The suggestion is never a
derivation: nothing about the binding's look is turned into paper. The PDF theme ladder is:

1. the theme the render call names;
2. the layout's own theme;
3. the host's `pdfTheme`;
4. the binding's suggestion;
5. `datum-pdf`.

A host-supplied, non-Datum PDF theme in a browser, using GCDS (`bindings/gcds/pdf/`):

```ts
import { pdfThemes } from "@argusvane/datum";
import { gcdsPdfTheme } from "@argusvane/datum-binding-gcds/pdf";

pdfThemes.register(gcdsPdfTheme);   // the GCDS binding's suggestion, pdfTheme: "gcds", now resolves
```

A host that registers nothing prints under `datum-pdf` and gets one `theme.notFound` warning.
The theme ships no font files. Its `assets.fonts` names the `@gcds-core/fonts` WOFF files relative
to the folder the host serves for the live form, and the PDF kernel converts WOFF to sfnt as it
loads them. Every value in the theme is read from the pinned `@gcds-core/tokens` release
(`pdf/tokens.generated.ts`, cut by `npm run tokens:generate`). `npm run test:pdf` renders a form
under the theme with the kernel.

A server host has no page to register a theme on. It maps the binding id to a PDF theme in its
catalog and supplies the theme object as a JSON file. With Spring Boot:

```properties
datum.bindings.routes.contact=gcds
datum.bindings.catalog.gcds.label=GC Design System
datum.bindings.catalog.gcds.pdf-theme=gcds
datum.bindings.pdf-themes.gcds=classpath:/pdf/gcds.json
```

FastAPI takes the same settings (`datum.bindings.catalog`, `datum.bindings.pdf_themes`). A PDF of
the route carries that theme object as the request's host theme, below the render call's and the
layout's own. The reply's `X-Datum-Pdf-Theme` names the theme the route's binding suggests, even
when a layout's own theme outranks it in the drawing. [Datum for Spring Boot](spring.md) and
[Datum for FastAPI](fastapi.md) list the settings.

Print and PDF are not part of the kit's equality. `datum-binding-check` runs its print and PDF
cases where a binding ships them (`print` and `pdf` in `binding-check.json`).

## 13. Limits of the checks

- Conformance does not check that `aria-describedby` on a choice group or a date fieldset names
  its hint: a binding that drops it on radios still passes. The equality cases do not read ARIA
  either.
- Pixels are verified in Chromium only. The kit runs in Firefox and WebKit when Playwright has
  those browsers.
