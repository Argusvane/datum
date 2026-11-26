# ADR 0095: Host-wired components and plugins

## Status

Accepted.

## Context

The embeddable bundles carry the engine, its standard catalogue and the `datum` binding. A
design-system binding is a package a host installs and registers (`bindings.register`), never
part of a bundle. Components and plugins follow the same rule, and each needs a seam (an icon set
is a bundle a page adds in the same way, ADR 0048):

- **A component library is a plugin, not part of the standard catalogue.** A package that adds
  types ships a `FormPlugin` whose definitions say how each type is drawn; a host that wants the
  types registers it.
- **The engine's plugin platform needs a seam on the elements.** `PluginPlatform` (ADR 0001)
  installs every kind of contribution with dependency ordering and compatibility gates, and
  `FormRuntime` takes a platform and merges its hooks, submission handlers and PDF renditions.
  Per-kind element properties alone (`componentDefinitions`, `dataSources`, `wasmPlugins`, signing
  providers) would leave a plugin with validators, hooks, handlers or renditions needing a
  host-built `FormRuntime`.
- **A component's rules travel with the component.** A component library's types draw under
  whatever binding draws the form. If neither a `ComponentDefinition` nor a `FormPlugin` could
  carry a stylesheet, the only place for a component's rules would be a binding, and the
  component's look would depend on which binding the page happened to draw with: under any other
  binding the type would draw as unstyled markup. The coupling would also run the wrong way, a
  binding having to know every library a page might add.
- **Bundles stay free of modules they never use.** The engine root index re-exports every layer
  (`export *`), and Rollup keeps a re-exported module whose top-level statements it cannot prove
  pure.

## Decision

### 1. The standard catalogue is the engine's own types

`standardComponentDefinitions()` and `standardComponentTypes()`
(`packages/datum/src/standard-components.ts`) list the types the engine itself draws.
`mergeComponentDefinitions(extra, registered)` layers three lists (the standard catalogue, the
registered plugins' definitions, the element's own), a definition replacing one beneath it by
type, so `date` can be redrawn by a plugin and again by the page.

### 2. A component definition carries how it is drawn and listed

`ComponentDefinition` (`core/schema/contracts.ts`) carries what a type needs on both surfaces:

- `adapter`: the live renderer's adapter for the type (a field, group, tabs, grid or steps
  adapter, a list chosen by `when`, or a factory `(lit, datum) => entry` called with the
  renderer's lit namespace and the Datum binding, so a package built apart from the engine never
  imports lit). `plugins/component-adapters.ts` lays the definitions' adapters over whatever
  binding draws the form (`extendBinding`), so the type draws under every binding, on the form
  and on the builder's canvas alike. An entry of another shape is refused with a console warning
  (`componentAdapterProblem`).
- `css`: the type's own stylesheet, adopted after the binding's rules (decision 7).
- `base`: for a type the engine does not know, the engine type it reads as (`gcds-date` reads as
  `date`). The builder writes it into the saved definition's `kinds` map, which is how
  validation, the sandbox and the PDF treat the type as its base without the plugin's code.
- `palette?: { label, group?, icon?, binding? }`: how the type reaches the builder's palette with
  nothing but its definition (`paletteEntriesOf`, `builder/controller/builder-controller.ts`).
  `binding` names the binding the type belongs to, and the builder offers it only while that
  binding draws the canvas. The palette is the standard entries, the plugins' and the element's
  `componentTypes`, one entry per type, a later one replacing an earlier one's label and group in
  place. A definition with no `palette` gets no entry (the form root, a type the host lists in
  `componentTypes` itself), and the whole palette, plugin entries included, is under the
  `component-types` filter.

### 3. `plugins`: the page's plugin registry

`packages/datum/src/plugins.ts` is the seam, patterned on the binding registry: one object per
page, shared across the bundles through a global, with `plugins.register(plugin | plugins)`.
A plugin already registered (same id and version) is skipped, never an error, so a page that loads
a bundle twice registers once. Each element also takes plugins of its own (`plugins`) and a
registry of its own (`pluginRegistry`).

Each runtime gets a `PluginPlatform` of its own over fresh engine registries, because the
registries refuse a second registration; a runtime with no plugin gets none. A registration after
an element connected is taken up: the form rebuilds its runtime, and the builder swaps its
catalogue under the live controller, keeping the tree, the undo history, unapplied drafts and the
selection.

A design-system binding package may export a `FormPlugin` beside its binding for the types only
its design system has. The host registers both, and the plugin's types are offered on the palette
only while that binding draws the canvas.

`docs/plugins/packaging-and-discovery.md` ("Registering plugins on a page", "Where each
contribution lands") holds the registry's members and the table of which contribution reaches
which surface.

### 4. Plugin packages build their own bundles, and the guard

A plugin package builds its own bundle with `npm run build`
(`packages/datum/scripts/plugin-build.mjs`), and the build checks it: the package's own library
(its `sentinel`) is present in both formats, no plugin or binding package it depends on is inside
either, and the size is within its budget. The entry imports neither the renderer nor the builder.
A binding package builds the same way through the binding kit. Core's `check-bundles` refuses a
dependency of `packages/datum` or the engine on any binding or plugin package, so none can reach
the renderer, builder or PDF bundles. The package's `"datumPlugin"` block and the checks are in
`docs/plugins/packaging-and-discovery.md` ("Plugin bundles").

### 5. The engine is side-effect free

`engine/package.json` declares `"sideEffects": false`: the engine has no bare imports and no
top-level statement that registers, patches or defines anything (elements are defined by
explicit `define…Element()` calls from the bundles' entries), so Rollup may drop any engine
module nothing imports from, and a bundle that only registers an icon set or a plugin carries
only what that needs. A module that needs an import-time effect must be imported for it
explicitly by whoever needs it.

### 6. Plugin texts

A plugin adapter reads the configuration texts a form author translates through the state's
`text(property)`, which layers the form's translations and the host catalog (ADR 0158 carries
the translation model), not `resolveLocalizedText` on its configuration. A plugin definition
declares those fields `localized-text`.

### 7. A component carries its own stylesheet

1. **A definition carries its stylesheet.** `ComponentDefinition.css?: string[]`: rules for what
   the definition's `adapter` draws. `componentDrawingOf` (`plugins/component-adapters.ts`)
   collects the sheets of every definition the runtime's component registry holds (the builder's
   canvas: the controller's), once each, in definition order.
2. **The renderer adopts it after the binding's rules.** `withComponentDrawing` lays the definitions
   over the binding (`extendBinding`): each adapter replacing the binding's entry for its type, and
   the sheets appended to the binding's own `css`. The renderer adopts that into the form's shadow
   root after its structure sheet and the Datum sheet, so the rules reach what the adapter draws
   under every binding, on the running form and on the builder's canvas alike. Inside the shadow
   root the rules need no scoping prefix: nothing outside the form reaches them, and they reach
   nothing outside it.
3. **Order and specificity are those of rules a binding had written itself.** Component rules land
   after the binding's, so a binding that wants to restyle a component reaches for specificity. A
   host component that ships CSS needs no binding of its own to look right.

## Consequences

- Bindings, components, plugins and icons are all things a host wires: a bundle per package a
  page without a bundler adds, a registration for a page with one, and nothing a host did not
  ask for in the renderer or the builder bundle.
- One `FormPlugin` reaches both elements with every contribution the engine's platform
  understands, and a plugin's type draws under every binding through its definition's adapter.
- A form that names a type nothing draws is loud on both surfaces (a note where the component
  would be, a console warning, the builder's inspector saying so); ADR 0162 holds that rule.
- Every bundle a page loads carries its own copy of what it uses from the engine; a page that
  loads all of them downloads some engine code twice. The side-effect declaration keeps that
  to what each bundle uses.
- A plugin's component looks like itself on any form that registered the library, in the
  builder's canvas as in the running form, whatever the binding. A binding carries no rules for a
  component library, and a library depends on no binding.
- Print draws from its print theme (ADR 0035) and the PDF from renditions, so neither reads
  component CSS.
