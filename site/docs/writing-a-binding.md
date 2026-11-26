# Writing a binding

A binding makes a form draw in your design system's own markup and components. Write one when your team has a design system and wants every field, group and button to come out the way that system writes it.

## What a binding owns

A binding owns the leaf markup: how a text field, a set of radios, a date, a fieldset or a tab strip is written in the design system's elements and classes. It also owns the stylesheet for anything it draws itself.

The renderer keeps everything that behaves:

- Rules, validation and errors.
- The error summary and its links.
- Focus and announcements.
- Read-only and disabled.
- Journeys and data grids.
- Translations.
- Print and the PDF layer.

They work through any binding, because the binding only returns markup for state the renderer hands it.

The design system is the authority for its own look and accessibility. A binding draws it as the design system writes it, and Datum makes no accessibility claim for it.

## The package

A binding is a package with a module that exports a factory, and a file that lists the design system's files:

```
bindings/<id>/
  package.json        datumBinding { id, designSystem, release, bundle, global, budgetKb }
  binding-check.json  the design system's stylesheets, fonts and scripts, for the checks
  src/index.ts        createBinding(lit, datum)
  reference/*.html    the design system's own markup, one case per file
  docs/side-effects.md   what the binding does outside the form
```

In a checkout of the repository, `node scripts/new-binding.mjs <id> --design-system "Name" --release 1.2.3 --package @scope/design-system` writes this skeleton.

The factory receives the page's one lit namespace and Datum's own binding. A binding never imports lit itself.

```ts
export const createBinding: BindingFactory = (lit, datum): LiveBinding => ({
  id: "bootstrap",
  label: "Bootstrap 5",
  designSystem: { name: "Bootstrap 5", selfCheck: (root) => [] },
  components: { text: fields.text, select: fields.select, fieldset: containers.fieldset },
  css: "…"
});
```

A host builds it with `bindings.fromFactory(createBinding)` and registers the result with `bindings.register`, as described in [Design-system bindings](/bindings). A component type the binding does not write is drawn by Datum's own adapter, so a binding can start with a few types and grow.

## The adapter contract

Adapters are looked up by component type, in this order: the binding's entry for the type, the binding's entry for its `base`, Datum's entry for the type, Datum's entry for the base. A type the binding does not write is drawn by Datum. Each adapter says which node it draws with its `kind`, so a field adapter is never asked to draw a container.

| `kind` | Draws | `template` is called with |
|---|---|---|
| `field` | A leaf: an input, a choice, a date, a file field, a button, static content. | `(state, on)` |
| `group` | A container around its children, which the renderer drew. The adapter says where they go. | `(state, children)` |
| `tabs` | A tabs container. Which tab shows, the arrow keys and opening a tab for an error stay the renderer's. | `(state)` |
| `grid` | A data grid or repeating section. Rows, bounds and focus after a row button stay the renderer's. | `(state)` |
| `steps` | A steps container: the indicator, the shown step, Back and Continue. Navigation and focus stay the renderer's. | `(state)` |

An entry in `components` is one adapter, or a list: the first whose `when(state)` holds draws, and one without `when` is the default. A `when` that throws counts as not holding and is reported as `datum-binding-error`.

### A field adapter

The renderer builds the state: the label, hint, ids to point `aria-describedby` at, the worded errors, notices, the character count, options, and whether the field is required, invalid, disabled or read-only. It also hands in `on`, to report what the person did. The adapter returns a template.

This is the text field of the Bootstrap binding, shortened:

```ts
const text: FieldAdapter<TextFieldState> = {
  kind: "field",
  capabilities: { notice: "drawn", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" },
  template(s, on) {
    return html`<div class="mb-3">${label(s)}
      <input class=${cls("form-control", s.invalid && "is-invalid")}
        id=${s.id} name=${s.name} type="text"
        .value=${live(s.value)}
        aria-describedby=${ifDefined(describedByOf(s.describedBy))}
        aria-invalid=${flag(s.invalid)}
        ?required=${s.required} ?disabled=${s.disabled} ?readonly=${s.readOnly}
        @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
        @blur=${() => on.commit()} />
      ${hint(s)}</div>`;
  }
};
```

The rules every adapter follows:

- Return the field's own parts. The renderer writes the wrapper and its state attributes.
- Write every id the state names, and `aria-describedby` from `state.describedBy`. Never build an id of your own, unless the adapter says `idsWrittenBy: "component"`.
  - With `"component"`, the design system's component writes ids inside its own shadow root and is told the words by property.
  - With `"binding"`, the default, the renderer checks after every draw that each id in `describedBy` is carried by an element, and reports one that is not.
- Set `aria-invalid="true"` only while the field is invalid, never `"false"`.
- Set the value as a property with `.value=${live(state.value)}`.
- Report typing with `on.input(value, { interim: true })` and a finished edit with `on.commit()`. A date reports `on.parts({ day, month, year })`.
- Take every word (the required mark, "Optional", an error prefix) from `state.words(...)`.

`state` carries, besides the members on [Components of your own](/custom-components#the-adapter), the members of its type:

- Text: `placeholder`, `prefix`, `suffix`, `tooltip`, `characterCount`, `autocomplete`, `inputMode`, `minLength`, `maxLength`, `pattern`.
- Text area: `rows`.
- Number: `min`, `max`, `step` and `standsFor(text)`.
- Choices: `options`, `emptyLabel`, `selected` or `checked`.
- Date: `parts` and `missingParts`.
- File field: `files`, `multiple` and `accept`.
- Button: `action`, `variant` and `size`.

`on` has `input(value, { interim?, badInput?, typed? })`, `parts`, `commit`, and for a file field `files`, `remove` and `download`.

`typed: "number"` hands the renderer the text typed in a text box drawn for a number, which it reads with the form's locale, the same under every binding.

Optional members of a field adapter:

| Member | Use |
|---|---|
| `name` | A name for the inspector and the conformance report. |
| `when(state)` | Chooses between several adapters of one type. |
| `behaviour` | `{ keyboard, countsCharacters }`, each `"component"` or `"renderer"` (default `"renderer"`): who runs the keys of a composite, and who counts and announces characters. |
| `after(field, state)` | Runs after every draw, given the field's wrapper. Must be safe to repeat. |
| `ready(field)` | Resolves when the design system's component has drawn itself. The renderer waits, within a budget. |
| `connect(field, state)` | Once, after `ready`: what lives as long as the field. Returns its cleanup. |
| `focusTarget(field, state)` | The element focus goes to for a summary link, an error or a new row. |
| `guard(field)` | Makes a custom control honour read-only. Returns its cleanup. |
| `idsWrittenBy` | `"binding"` (default) or `"component"`. |

The order for a field is:

1. Choose the adapter.
2. `template`.
3. `after` (every draw).
4. `ready` (new fields).
5. `connect` (returns its cleanup, run when the field leaves or the form unmounts).

### Capability answers

An adapter answers, per drawing capability, `drawn`, `degraded` or `none`. A capability left out is `none`.

| Answer | Meaning |
|---|---|
| `drawn` | The adapter draws what the state carries for it, as authored. The renderer adds the behaviour it owns. |
| `degraded` | Drawn in a reduced form the renderer may complete: a tooltip or pending word folded into the hint, a notice drawn as hint-styled text with its severity word, row numbers that cannot be turned off. A degraded count is drawn but not announced. |
| `none` | Not drawn. The renderer leaves the capability's id out of `describedBy` and records `<component id>: <capability>` in `unsupported()` (and warns once) when the form uses it. The builder hides the setting. |

The capabilities, and the kinds they are asked of:

| Capability | Asked of | What drawing it means |
|---|---|---|
| `notice` | every field | Warnings and info on a field, apart from its errors. |
| `pending` | every field | That an async check is running. Degraded is a word in the hint. |
| `tooltip` | every field | Help on hover and focus. Degraded folds the text into the hint. |
| `prefix`, `suffix` | text, number | Text before or after the control, inside the box. |
| `characterCount` | text | The running count against the limit. Datum counts code points and raises the over-limit error whatever you answer. |
| `hideLabel` | every field | The label hidden visually and still the accessible name. |
| `placeholder` | text, number, choice | Ghost text, or a select's empty caption. |
| `rowNumbers` | data grids | The number heading of each row. |
| `workedOut` | every field | A journey page's line saying the value is worked out from other answers. |

`unsupported()` is a method of the live form: it lists what the form uses that the binding does not draw.

### Containers and the rest

- **`group`.** Draws a legend and hint and places its children.
  - Its state has `legend`, `hint`, `hintId`, `hideLegend`, `legendMark`, `level`, `layout`, `spans` (a grid's column widths out of 12), `slots`, `items` and `eachItem`.
  - Draw the items with `eachItem` so the renderer can key them.
  - `formLabelled: true` on an adapter that draws the form root as no group lets the renderer name the `<form>` itself.
- **`tabs`.** Receives `tabs` (each with `label`, `selected`, `tabId`, `panelId`, `errorCount`, `select()` and `content`), `narrow` (below `tabsNarrowBelow`) and `flat` (every panel drawn headed, for a review or print).
  - Every panel is drawn; hide all but the selected one.
  - Write the `tabId` and `panelId` the state names.
- **`grid`.** Receives `columns`, `rows` (with `cells`, `remove`, `moveUp`, `moveDown`), `layout` (`table` or `stacked`), `responsive`, `offers`, `add`, `addId`, `captions` and the grid's own `errors`.
  - `layouts` on the adapter says which it draws; one that draws no table is always handed `stacked`.
- **`steps`.** Receives `steps` (each with `label`, `status`, `statusText`, `tag`, `shown`, `headingId`, `content`, `select`), `back`, `next`, `progress`, `others`, `flat` and `busy`.
  - Keep `headingId` and `tabindex="-1"` on a step's heading: focus goes there when it opens.

## What the binding object holds

The factory returns a `LiveBinding`. Only `id`, `label` and `components` are required.

| Member | What it is |
|---|---|
| `id`, `label` | The name an element uses and the name in a picker. `datum` is refused: it is Datum's own. |
| `components` | Adapters by component type: Datum's engine types and the binding's own. |
| `kinds` | The binding's own types and the engine type each reads as: `{ "gcds-date": "date" }`. A form that uses one without the definition's own `kinds` entry is drawn as its base and reported in `unsupported()`. The builder offers these types in its palette under the binding and writes the entry into the definition on save. |
| `css` | Rules for what the binding draws itself, adopted after the host's stylesheets. |
| `designSystem` | `{ name, rootFontSize?, selfCheck?, sideEffects? }`. `selfCheck(root)` runs after the first draw is ready and returns one string per problem: what the binding relies on that the design system must have drawn. `sideEffects` lists what the design system's own code changes outside the form (`[{ target, effect }]`): reported with the self-check, never as a problem. |
| `connect(root, form)` | Starts the design system's own script scoped to the form. Called once per mount after the first draw, never on a redraw. `form` is an element inside the shadow root. Returns its cleanup (or a promise of one). A throw is reported as `datum-binding-error` with hook `connect`. |
| `ready(root)` | A stand-in `ready` for an adapter without one. |
| `focusTarget(field, state)` | The default focus target for the binding's field adapters. |
| `fallbackTokens` | Datum tokens set to the design system's values, for what Datum draws inside this binding: every element the renderer marks `data-fallback` (a field wrapper, a container's wrapper, a journey page's heading and buttons, chrome, the summary, the receipt) wherever Datum's adapter or hook draws it. See [Tokens](/tokens). |
| `frames` | Frame presets the binding adds, `{ id: { label, css } }`; the binding's `css` draws each under `datum-form--frame-<id>`. A built-in id relabels the built-in. |
| `formClass` | Classes on the form element: a string, or a function of `{ colorScheme, locale }` for a dark variant. |
| `darkVariant` | The id of the binding a picker offers as this one's dark look. |
| `dateOrder(locale)` | The order the binding's date adapters draw a date's parts in, so focus goes to the first part lacking. |
| `errorFocus` | `summary` (default) or `field`: where focus goes after a check that found errors. |
| `tabsNarrowBelow` | The form width in CSS px under which tabs take the narrow view. Left out, tabs keep their strip. |
| `texts`, `messages` | The binding's language pack: form text keys, and validation messages by code, each by locale. |
| `cssClasses` | The classes an author may put in `cssClass` under this binding. The builder's Style tab offers them. |
| `unwordedErrors` | `"noted"`: the builder notes under the messages box each error an author left unworded, for a design system that asks for each error to be written for its question. |
| `summary(entries, state)`, `notice(state)`, `status(state)`, `requiredNote(state)` | The error summary, the receipt after a submission, the in-flight line and the required-mark sentence. Left out, Datum's. |
| `page` | `{ heading(state), actions(state) }`: a journey page's heading and its Continue and Back. |
| `languageSwitcher(state)` | The language switcher. |
| `chrome` | `{ [partType]: { template(state) } }`: chrome parts. |
| `pdfTheme` | A PDF theme suggestion. See [PDF and print themes](#pdf-and-print-themes). |

`extendBinding(binding, overrides)`, exported by `datum-form.js`, returns a binding with some members replaced or wrapped, so a host changes one adapter without copying the binding. A component override is an adapter, a list, or a function of the binding's own entry that returns one.

A binding wraps or patches Datum's adapters, which the factory receives as `datum`, rather than copying them: `{ ...datum.components.date, template }`.

Datum's own binding, with its tokens, frames, parts and controls, is made by `createDatumBinding`; see [Look and chrome](/look#restyling-it).

## Assets

A binding never ships the design system's files. The host serves them and passes them as `assets`, through `bindings.register(binding, { assets })` or the element's `assets` property.

| Key | Holds |
|---|---|
| `stylesheets` | `[{ url, integrity? }]`. Fetched, rewritten for the form's shadow root and adopted. |
| `fonts` | `[{ url, integrity? }]`. The renderer puts the `@font-face` rules of the stylesheets in the document, in one sheet per binding, because a shadow root cannot register a font. |
| `scripts` | `[{ url, integrity?, classic?, attributes? }]`. A module by default. `classic: true` runs it as a classic script. `attributes` sets attributes on its `<script>` element, for a script that reads its own (`document.currentScript`). |
| `rootFontSize` | The host page's root font size in px, when the design system's stylesheet expects another. The renderer rewrites `rem` lengths. |

```js
bindings.register(binding, {
  assets: {
    stylesheets: [{ url: "/design-system/bootstrap.min.css", integrity: "sha384-..." }],
    scripts: []
  }
});
```

The renderer fetches each stylesheet and:

- Inlines its leading `@import`s.
- Resolves its `url()`s.
- Rewrites `:root`, `html` and `body` selectors to the form's root.
- Checks `integrity` on every stylesheet and script.

A file that cannot be had stops the form drawing and the element raises `datum-binding-error`; there is no unrewritten fallback. List the same files in `binding-check.json` so the checks load them. What the host serves, and the headers it needs, is on [Design-system bindings](/bindings#hosting-the-files).

A design system's script looks for elements through `document`, which cannot see into a shadow root.

- Where the design system supports a scope, start it scoped in `connect(root, form)`.
- Where it has none, draw its no-JavaScript baseline and let the renderer own the behaviour.

## PDF and print themes

Print draws a static theme of its own and never loads the design system's scripts.

- A binding can ship a print theme and set it with `form.printTheme`.
- A binding can also suggest a PDF theme with its `pdfTheme` field, either the id of a theme the host registered or the theme object.
- The suggestion is only a suggestion: it ranks below the theme a render call, a layout or the host names, and a host that registers nothing prints with Datum's own.

See [PDFs](/pdf) and [Printing](/print).

## Checking a binding

The binding kit runs from the package, offline, against the pinned design system:

```
cd bindings/<id>
npm install
npm run kit:check       package, build, tokens, binding, equality, behaviour, checks, conformance
npm run kit:equality    only the cases that compare your markup with the design system's own
npm run kit:behaviour   only the behaviour cases (autofill, back and forward, moving the element)
npm run kit:serve       the reference and the binding side by side
```

`datum-binding-check` is the conformance suite's command, and what a binding's own CI runs. It mounts the binding in a browser and checks what Datum and the binding write: value round trips, errors, the summary and focus, read-only, dates, grids, tabs, journeys, translations, and that the ids the markup names exist.

```
npx --package @argusvane/datum-conformance-suite datum-binding-check --binding ./dist/my-binding.js --assets assets.json --report out/
npx --package @argusvane/datum-conformance-suite datum-binding-check --list
```

Its exit codes:

- 0: every case passes.
- 1: a case fails.
- 2: a usage error, or nothing was asserted.
- 3: a tool or browser is missing, an asset cannot be reached or the binding's own self-check fails.
- 4: an internal error.

It checks the integration, never the design system's own quality. See [Conformance](/conformance).

### binding-check.json and the kit

`binding-check.json` is the asset list the kit and `datum-binding-check` read, in the shape a host gives the element. Its keys:

| Key | Meaning |
|---|---|
| `designSystem` | The design system's name. |
| `binding` | The binding module, relative to the file (`src/index.ts`). |
| `stylesheets`, `scripts`, `fonts` | The files, as paths under `/node_modules/<pinned package>/...`. A script is a path or `{ url, classic, attributes }`. |
| `bodyClass` | A class the host page's `<body>` needs for the design system's script to start. |
| `lang` | The page language the checks load the page in. |
| `print`, `pdf` | The package's print theme and PDF theme modules. They enable the print and PDF cases. |
| `roots` | Folders, relative to the file, that stand in for the CDN. Default: the file's own folder. |
| `routes` | Answers a request for a third-party URL from the design system's pinned packages. `{ match, stylesheets }` serves the listed stylesheets (with `rebase` for a placeholder prefix in their `url()`s); `{ match, files }` mirrors a CDN folder onto a folder of the pinned package. |
| `network` | `[{ host, reason }]`: hosts a run may reach because no pinned package holds the file. Reported as a known network dependency. |
| `known` | `[{ case, reason, since }]`: a behaviour or conformance case the design system itself fails (a defect of its own, never patched by the binding). Reported as known with its reason and counted apart from pass and fail; a listed case that passes fails the run, so the list cannot go stale. |

The kit runs offline (`--offline`): a request to any host the kit's server, a route or `network` does not answer is aborted, and the step fails naming the URL. A design system whose stylesheet imports a CDN font needs a `route` or a `network` entry.

In the package's `package.json`, `datumBinding` holds:

| Key | Meaning |
|---|---|
| `id`, `designSystem`, `release` | The binding's id, the design system's name and the one release it pins. |
| `bundle`, `global` | The ES module the build writes (`dist/<id>.js`) and the global of its IIFE. |
| `budgetKb` | The gzip budget of the ES bundle. |
| `checks` | Optional: scripts the kit runs for what the shared checks do not assert for this design system. Each exits 0, or 1 for a failure. |
| `entry` | Optional: the binding module when it is not `src/index.ts` or `src/binding.ts`. |

`kit:check` runs eight steps, in order:

1. `package` (the package block and routes)
2. `build`
3. `tokens` (a token contract file, when the package has one)
4. `binding` (lints the binding object for what the renderer would ignore)
5. `equality` (your markup against `reference/*.html`)
6. `behaviour`
7. `checks`
8. `conformance`

`--skip` and `--only` take step names. The build fails if the bundle has any import, carries lit-html (lit arrives through `createBinding(lit, datum)`), or is over `budgetKb`.

`datum-binding-check` takes `--binding`, `--assets`, `--only`, `--baseline`, `--report`, `--browser` (`chromium`, `firefox`, `webkit`), `--port`, `--case-timeout`, `--offline`, `--continue`, `--list` and `--help`.

It needs Playwright and, for any binding but Datum's own, esbuild.

## Reference bindings

Nine bindings in `bindings/` are starting points:

- The GC Design System
- GOV.UK Frontend
- The U.S. Web Design System
- Bootstrap 5
- The Nova Scotia pattern library
- The Alberta Design System
- The Québec design system
- The Ontario Design System
- Fluent UI

Bootstrap is the simplest to read. They are references and demos, they carry no support promise, and Datum makes no accessibility claim for any of them.
