# ADR 0162: The renderer is a lit-html update step, and the binding contract

## Status

Accepted.

## Context

`<datum-form-renderer>` draws one form many ways: in Datum's own look, in a design system's
markup, on the builder's canvas, read-only. Whatever draws it, the drawing has to survive the next
change. A person typing keeps their focus, caret and IME composition; a design system's web
component keeps its own state; a screen reader keeps its place. A renderer that rebuilds the form's
markup on every change has to save and restore all of that by hand, and it never gets all of it.
A renderer that keeps its nodes between draws gets it for free.

A design system's form components come with their own markup, classes, web components, focus
habits and accessibility work. A Datum form comes with things no design system knows about: rules,
validation and its wording, an error summary, journeys, data grids, translations, read-only and
disabled modes, per-field pending checks, print, PDF, the builder canvas and agent tools. If a
binding had to rebuild any of those, every binding would rebuild it differently. If Datum patched
a design system's components, Datum would be overriding the design system's own judgement.

## Decision

### One draw loop, in `render/live/`

The element mounts the form into its shadow root with `mountLive(shadowRoot, options)`
(`engine/form-engine/render/live/mount.ts`). Each draw:

1. takes the runtime's render output (`render/core/runtime-render-bridge.ts`);
2. folds it into the presentation tree (`render/core/presentation-tree.ts`): fields, groups,
   tabs, grids, steps and pages, with names, row labels, tab slots, page texts and the
   translation catalog filled in. The live renderer, print (ADR 0035) and the PDF designer's
   preview all read this one fold, so they agree on what a group, a tab, a row and a page are
   called;
3. draws the tree through the binding's adapters (this record's contract, below) as lit-html
   templates;
4. hands the result to lit-html's `render` against the shadow root.

The first draw creates the nodes. Every later draw changes only the parts that changed. The change
events of one write are merged into one build, and a build that a newer one overtakes is dropped.
A draw asked for while an IME composition is open waits until the composition ends.

`mountLive` returns a `LiveForm` (`ready`, `updated()`, `focusField`, `unsupported`, `selfCheck`
and the rest of its members, in `mount.ts`). Options a mount is made from (runtime, binding,
assets, mode, features) are read once. Everything else (wording, data sources, canvas hooks,
colour scheme) is read at each build or draw, so the element hands an object of getters over its
own settings and asks for a build or a draw when one changes.

### Features plug in

Most of what the renderer does beyond drawing fields (the error summary, tabs, data grids, steps,
chrome, notices, files, tooltips, the count announcer, data-source states, the host's
design-system files) comes from `LiveFeature` modules the host lists in `features`.
`createDatumFeatures` (`render/live/datum/options.ts`) is the one list that the element (the
builder canvas is one), the feature-coverage harness and `datum-binding-check` mount with, so they
never disagree on what is drawn. A journey form adds the journey kit's page feature, which lives
in the journeys chunk (ADR 0144). A container kind that no feature draws still has its children
drawn in its wrapper. They are never dropped.

### The ownership rule

The renderer owns structure and behaviour. A binding owns leaf markup.

- **The renderer** owns the answers and their writes, rules, validation and the wording
  of every error, the error summary's entries, focus, the state hooks, read-only and disabled
  modes, grid rows, tabs, steps, journey pages, the character count's announcer, file picking and
  dropping and the announcing of a pick and a removal, tooltip dismissal, and the ids that tie a
  control to its description.
- **A binding** draws each leaf (an input, a choice, a date, a button, a container's shell) in its
  design system's own vocabulary, from state the renderer has already resolved.

For a design-system binding, the design system's own implementation decides look, markup and
accessibility. Where a design system's component falls short, that is the design system's to fix:
Datum does not patch, gate or work around it. Datum's own best practice lives in the Datum binding
(ADR 0163), the only official one. Checks on a binding (ADR 0164) test the integration, meaning
what Datum passes in, owns or adds. They never test the design system's own quality.

### What the renderer writes, whatever draws the leaves

Every field wrapper carries `data-component-id` and `data-value-path` (a grid row's own path inside
a row), and the state hooks of `STATE_HOOKS` (`contract.ts`): `data-kind`, `data-required`,
`data-invalid` (blocking errors only), `data-readonly`, `data-disabled`, `data-over-limit`,
`data-source` and `data-pending`. Every container sits in a `data-container-id` wrapper that lays
nothing out. Only the renderer writes these, and no override removes them. The agent layer
(ADR 0155), the builder canvas and host CSS read them. The builder canvas wraps the drawing
through `canvasHooks`, which take and return templates, never HTML strings.

Picking and removing a file are announced by the renderer, not the binding. The binding draws the
file field's empty polite status region (`role="status"`, `aria-live="polite"`), marked `data-file-status` (`FILE_STATUS_ATTRIBUTE`,
`render/live/contract.ts`), and the renderer fills it with the `fileAnnounced` text for a pick
(`fileAnnouncedMany` for several files) and the `fileRemoved` text for a removal. Focus stays in
the field: once the row is gone, the field's focus target (the picker) takes it. The marks and the
rules for them are in [`docs/binding-authoring.md`](../binding-authoring.md), section 3.

### A binding module

A binding is a plain object (`LiveBinding`, `engine/form-engine/render/live/contract.ts`, which
lists everything a binding may give). A binding module exports `createBinding(lit, datum)`: the
host passes in the renderer's lit namespace (see "One copy, never in a program") and the Datum
binding. The Datum binding is passed so the module can wrap or patch one of Datum's adapters
(`{ ...datum.components.date, template }`) rather than copy it. A host registers a binding with
`registerBinding(binding, { assets })`, which the web components expose as `bindings.register`, or
sets the object on the element's `binding` property. The id `datum` is reserved for Datum's
binding, which needs no registration. An id nothing has registered draws the form with Datum's
binding, reported once per id on the console and as `datum-binding-error` (`hook: "binding"`, with
the id). The binding never carries its design system's files; the
host does (ADR 0164).

### One copy, never in a program

`render/live/lit.ts` is the only module that imports `lit-html`. A binding never imports lit by
specifier. It exports `createBinding(lit, datum)` and is handed the `lit` namespace (`html`, `svg`,
`nothing`, `live`, `repeat`, `ifDefined`, `ref`, `unsafeSVG`; never `render`), so a binding works
on a page with no bundler and the page carries one lit copy.

At its top level lit-html reads `document`, calls `Math.random()` and creates a Trusted Types
policy. In the sandbox or the PDF program (ADR 0029, ADR 0043) that would be a ReferenceError or
lost determinism. The sentinel is two checks that hold the same rules:
`packages/datum/scripts/guards/16-lit-isolation.mjs` over the source and the built bundles, and
`engine/tests/live-lit-isolation.test.ts` over the source. The three programs
(`datum-wasm.js`, `datum-sandbox-program.js`, `datum-pdf-program.js`) contain no lit-html; nothing
a DOM-free entry imports reaches `lit.ts` at run time (the entries are listed in the guard's
`DOM_FREE_ROOTS`); and `render/index.ts` re-exports only DOM-free pieces from `render/live/`,
never the renderer.

### Trusted Types

lit-html creates a policy named `lit-html`. A host that enforces
`require-trusted-types-for 'script'` allows it in its `trusted-types` directive, together with
`datum-print` (ADR 0035) and, where a binding loads a script, `datum-assets` (ADR 0164). The engine's own `unsafeHTML` (Datum's sanitized static markup: an `html` block, a
chrome `html` part) goes through lit's policy and is not in the namespace bindings receive. No
renderer code sets `innerHTML` from a string, and `<datum-form>` builds its own shadow tree from
elements and adopts its rules as a constructed sheet, so the form draws under Trusted Types and a
`style-src` without `'unsafe-inline'`.

### Author classes and looks

`cssClasses` is how a binding says which classes in a component's `cssClass` it gives a meaning
to. A class has meaning only where a binding gives it one, so the form definition carries a name
and never a border or a colour, and a form that moves to another binding keeps working. How the
builder normalises the list, offers the classes on the Style tab, groups them and checks a class
against the vocabulary is in [`docs/binding-authoring.md`](../binding-authoring.md), section 3,
"Author classes and looks".

The look of a panel is the shared vocabulary (`render/live/look-classes.ts`), one group,
`panel-look`: `panel-plain` (the heading with the fields under it: no border, no background, no header band), `panel-outlined` (a border, with no header band and no fill), `panel-shaded` (a light background, with no border) and `panel-card` (a border, a header band behind the heading and a surface for the fields). The same names mean
the same four looks under every binding that declares them, so the vocabulary is the engine's and
each binding writes the CSS from its own tokens. What no class means is the binding's choice:
Datum's panel is the card, the GC Design System's is plain. In every look the heading stays a real
heading and the section stays named by it. A look also prints: the print model carries it and each
print theme draws it from its own tokens (ADR 0035), so a binding writes no print CSS for it.

When a hand-written `cssClass` holds two looks, the last one written is the look in every surface:
paper takes it, the Style tab checks it, and the panel adapters put only that look's class on the
section (CSS cannot follow a class list's order), the author's other classes untouched. A binding
that never imports the engine at run time restates the four declarations and holds them equal to
the engine's with a test.

### Kinds, bases and the lookup chain

Every component type has a base engine type. An engine type is its own base. Any other type (a
plugin's, or a design system's own tier-2 type such as `gcds-date`) is read as the engine type the
definition's `kinds` map names (`FormDefinition.kinds`, `{ "gcds-date": "date" }`). The kind
registry (`registry/kinds.ts`, with the type table in `core/schema/component-kinds.ts`) answers
`kindOf(type, kinds)`. Validation, the sandbox kernel, the agent's field kinds, the PDF and the
renderer all ask it rather than switching on a type name.

So a mapped type is checked, filled and printed as its base from the definition alone, on a server
with no binding code. The types a host offers say their base as data (`LiveBinding.kinds`,
`ComponentDefinition.base` on a plugin type), and the builder writes the entry for each such type
a form uses into the definition's `kinds` on save (`definitionKindsFor`). The checks on the map,
and what the renderer does with a type the map leaves out, are in the guide, section 8.

The renderer picks an adapter by the chain `binding[type] → binding[base] → datum[type] →
datum[base]` (`resolveAdapter`). What the binding does not draw is drawn by Datum's adapter, which
carries the binding's `fallbackTokens` (Datum tokens set to the design system's values), so it sits
in the design system's palette.

### A type nothing draws is said, not swallowed

A field type that none of the four steps draws is drawn as a note in its place (`datum-live-unknown`,
`role="note"`, naming the type), with `data-kind="unknown"` on its wrapper, in every mode. The note
is worded by the form's texts `unknownComponent` and `unknownComponentHint`, which a page or a
binding's language pack rewords. A container no adapter draws is drawn by Datum's container
adapter, never flattened, so its children stay.

Each such use is recorded in the form's `unsupported()` list and the renderer warns on the console
once per type, naming the type, the component id and what to do. A field Datum's adapter draws
inside another binding is recorded and warned about the same way, and its wrapper carries
`data-fallback`.

On the builder canvas the note is the node's face, selectable and deletable, and the properties
panel says "Unknown component type" above its sections (`InspectorModel.unknownType`, set when the
registry cannot resolve the type). The PDF designer's own node types have definitions, so they are
never flagged; the PDF's own handling of an unknown type is ADR 0043.

### Capabilities are answers, as data

Drawing capabilities (`registry/capabilities/drawing-capabilities.ts`) are separate from the editor
capabilities (`registry/capabilities/field-capabilities.ts`, what the inspector offers an author),
because whether a property can be authored says nothing about whether a design system can draw
it. For each capability an adapter answers `drawn`, `degraded` or `none`, and an unanswered
capability is `none`. The builder's inspector reads the answers (`capabilityAnswers`): it shows
`drawn`, shows `degraded` with a note, and hides `none`, so what a binding cannot draw is visible
and never silently dropped. The answers describe what is drawn, not whether the design system's
script runs. Two behaviour flags say who runs the keys of a composite and who counts characters
(`keyboard`, `countsCharacters`), and Datum's code-point count and its over-limit error always
apply. What each answer means for a given capability is in the guide, section 8.

### What an adapter is given

`FieldState` arrives already worded and resolved. `errors` holds blocking errors only; `notices`
holds warnings and info. A notice never sets `invalid` or `aria-invalid`, never enters the summary
and is never drawn in the design system's error style. `describedBy` lists only ids this field's
drawing carries, in the engine's order.

An adapter words nothing itself (it asks `words` for any word it draws), assembles no IDREF and
writes no state hook. A design system's component that writes its own ids inside its shadow root
declares `idsWrittenBy: "component"`. Otherwise the renderer checks after each draw that every id
in `describedBy` is carried by an element of the form, and reports one that is not.

Words come in one order: the host's texts, then the form's `texts` translations (ADR 0158), then
the binding's language pack, then the engine's English. English is the only built-in language.

### Lifecycle, guards and errors

A hook that throws is reported as `datum-binding-error` on the host element, and the drawing falls
back to Datum's. A broken binding never hides the form. The per-field order of the hooks is in the
guide, section 3.

The write guard drops `input`, `parts`, `commit`, `files` and `remove` whenever the form is not
interactive or the field is read-only or disabled, and the stored answer is drawn back. A
read-only radio, checkbox or select takes focus but no change, so read-only never has to mean
disabled. An adapter with a custom control the generic guards cannot reach (a listbox of buttons)
adds `guard(field)`.

Focus is the renderer's. After a check that finds errors, where focus goes is the binding's call,
`LiveBinding.errorFocus`. `"summary"` (the default) focuses the summary, with the tab or step
holding the first error opened first. `"field"` focuses the first field in error, or the summary
when no field can take it. A form whose `focusFirstError` is `false` (its `errorPresentation`, or
the definition's `accessibility`) sends focus to the summary and opens nothing. With no summary
drawn the first field takes it. `validate({ focus: false })` on `<datum-form>` and `<datum-form-renderer>` validates
and shows the errors without moving focus, for a page that shows an error without asking anyone to
fix it. Within a field the target comes from the adapter's `focusTarget`, else the binding's, else
the renderer's. Afterwards the renderer checks the deep active element. On a miss it focuses the
wrapper and reports `hook: "focus"`. No binding autofocuses.

### Overrides wrap, never copy

`extendBinding(binding, overrides)` replaces or wraps parts of a binding. A component override is
an adapter or a function of the binding's own entry. A plugin type's `ComponentDefinition.adapter`
(an adapter, or a factory `(lit, datum) => entry`) is laid over whatever binding draws the form,
so it draws under every binding. A host changes one adapter without forking the binding.

## Reasoning

Why lit-html: it is a template literal tag and a diffing `render`. It brings no component model,
so a design system's own web components and plain DS HTML are drawn the same way. It renders into
a shadow root as readily as into a document. It lets an adapter be a pure function from state to
template, which can be tested, wrapped and patched.

## Consequences

- A binding is small, its leaves only, and every Datum feature reaches every binding through the
  renderer.
- What a binding cannot draw is visible in three places: the inspector, `unsupported()` and
  `selfCheck()`. It is never silently dropped.
- `datum-binding-check` (ADR 0164) holds a binding to this contract; it never judges the design
  system.
- Datum's code holds no focus-rescue logic: no saving and restoring of the caret, the selection,
  open panels or typed dates across draws.
- jsdom lacks constructed sheets in shadow roots, `ResizeObserver`, `matchMedia`, `inert` and
  accessible names, so the renderer's behaviour is held in a real browser by the feature-coverage
  harness (`engine/feature-coverage`, `npm run test:features` in `engine/`, Playwright).
  Per-module unit tests stay in jsdom.
- lit adds to the form bundle's size. `packages/datum/scripts/check-bundles.mjs` holds
  the entries to their gzip budgets.
