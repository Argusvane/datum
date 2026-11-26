# Plugin Packaging and Discovery

The manifest describes a plugin; the loader reads and validates the descriptor and nothing else.
The sections after "Loading" cover how a page registers plugins, where each contribution lands and
how a plugin package builds its bundles.

## `plugin.manifest.json`

```jsonc
{
  "id": "acme-address-plugin",
  "version": "1.4.0",
  "engineRange": "^0.1.0",
  "environments": ["browser", "server"],
  "contributions": ["components", "validators", "hooks", "submissionHandlers"],
  "dependencies": [
    { "id": "acme-core", "versionRange": ">=1.0.0 <2.0.0" }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable plugin identifier. |
| `version` | yes | `major.minor.patch`. |
| `engineRange` | no | Engine versions the plugin supports (range grammar: [Sandbox ABI](../reference/sandbox-abi.md), "Version ranges"). Checked by `PluginPlatform` at install against `PluginCompatibilityPolicy.engineVersion`, or the engine's own version when the policy gives none. |
| `environments` | no | Subset of `browser` / `server` / `wasm`. Install is rejected in any other environment. |
| `contributions` | no | Declared contribution kinds: `components`, `validators`, `wasmPlugin`, `formulaFunctions`, `pdfRenditions`, `builderThemes`, `pdfThemes`, `dataSourceProviders`, `dataSources`, `hooks`, `submissionHandlers`. How a component type is drawn is the `adapter` of its `ComponentDefinition` (or the active binding's), not a manifest kind. Advisory — the actual `FormPlugin` object is the source of truth. |
| `dependencies` | no | `{ id, versionRange? }[]`. `versionRange` uses the same grammar as `engineRange` ([Sandbox ABI](../reference/sandbox-abi.md), "Version ranges"); both are parsed with `parseVersionRange` when the manifest loads, and a malformed range is an error. It feeds `PluginRegistry.resolveDependencyOrder`. |
| `signature` | no | Kept on the parsed manifest. Not read by the loader. |

## Loading

`plugins/manifest/load-plugin-manifest.ts#parsePluginManifest(input)` accepts a JSON string
or an object, validates the shape (including that every `*Range` parses), and returns a
typed `PluginManifest`. It performs no I/O — the host is responsible for locating manifest
files (e.g. globbing an in-repo `plugins/` directory) and pairing each with its `FormPlugin`
implementation.

## Install-time compatibility (`PluginPlatform`)

For each plugin, before registering its contributions, `PluginPlatform` rejects it (with a
`PLUGIN_INCOMPATIBLE` event and `onIncompatible` hook, install isolated) when:

1. `plugin.environments` is set and does not include the install environment;
2. `plugin.engineRange` is set and the engine version does not satisfy the range. The version
   checked is `PluginCompatibilityPolicy.engineVersion` when the policy gives one, otherwise the
   engine's own (`ENGINE_VERSION`).

## Registering plugins on a page

`@argusvane/datum` holds one plugin registry per page (`plugins`, in `packages/datum/src/plugins.ts`),
shared by every bundle through `globalThis[Symbol.for("datum.web-components.plugins")]` the way the
binding registry is. Every `<datum-form>` and `<datum-form-builder>` on the page takes up what it
holds.

```ts
import { plugins } from "@argusvane/datum";
import { acmeComponentsPlugin } from "@acme/datum-components";
plugins.register(acmeComponentsPlugin);
// <datum-form> draws the acme-* types; <datum-form-builder> lists them under their palette group.
```

| Member | Does |
|---|---|
| `register(plugin \| plugins, { assetsBase?, aliases? })` | Adds plugins. `assetsBase` is where the page serves the assets of the builder and PDF themes a plugin carries; `aliases` (`{ dark: "acme-dark" }`) are further ids for those themes. A plugin whose id and version are already registered is skipped, never an error, so a page that loads a bundle twice registers once. A plugin whose shape is wrong (a contribution list that is not a list of objects) is refused with a console error naming the plugin and the member, and the others are still registered. |
| `has(id, version?)`, `plugins()`, `registrations()` | What is registered, in registration order. |
| `components()`, `paletteEntries()` | The registered plugins' component definitions (a later plugin's type replaces an earlier one's) and the palette entries those definitions declare. |
| `createPlatform(extra?)` | A `PluginPlatform` seeded with the registered plugins and `extra`: one runtime's. |
| `subscribe(listener)` | Called after every registration that added a plugin; returns the unsubscribe. Listeners hear only additions. |

An element also takes plugins of its own (`plugins`, a property) and a registry of its own
(`pluginRegistry`), for one form alone. A registration made after an element has connected is taken
up: the form rebuilds its runtime, as it does for `componentDefinitions` (so register before the
person starts typing), and the builder re-lists its palette and catalogue through
`setComponentDefinitions`, which swaps the catalogue under the live controller and keeps the tree,
the undo history, unapplied drafts and the selection.

## Where each contribution lands

| `FormPlugin` field | Reaches |
|---|---|
| `components` | Both catalogues, through `mergeComponentDefinitions` (the standard catalogue, then the registered plugins' definitions, then the element's own, a definition replacing one beneath it by type). A definition's `adapter` and `css` reach the renderer under every binding; its `palette` reaches the builder's palette. |
| `builderThemes`, `pdfThemes` | The page's theme registries (`builderThemes.register`, `pdfThemes.register`), under the options given to `register`, so an id resolves. |
| `validators` | The runtime's pipeline, after the field constraints (`PluginPlatformResult.mergedValidators`, `ValidationPipeline.withStages`). |
| `formulaFunctions` | The runtime's formula functions, known before the definition is compiled (`PluginPlatformResult.mergedFormulaFunctions`). |
| `hooks`, `submissionHandlers`, `pdfRenditions` | The runtime, from the platform `FormRuntime` takes. |
| `wasmPlugin` | The sandbox `<datum-form wasm>` loads, before the page's `wasmPlugins`; a rebuilt runtime with the same modules keeps its sandbox. |
| `dataSources`, `dataSourceProviders` | Behind the page's own sources (`withPluginDataSources`: the page's set first, then a registered client runtime), on the runtime, the renderer, the builder's canvas and its picker. See [Data sources](../data-sources.md). |

A plugin carries no `capabilities` or `propertyEditors` of its own: a component's settings are its
definition's `capabilities` and `propertyEditor`, and how it is drawn is its `adapter`.

`createFormRuntime` builds a `PluginPlatform` over fresh engine registries for each runtime (the
registries refuse a second registration) when there is at least one plugin; a runtime without
plugins gets no platform. `FormRuntime.installedPlugins()` reports the platform's result: the ids
installed, rejected and initialized, and the merged contributions. The form element reads the sandbox
modules from it. A plugin whose `engineRange` the engine's `ENGINE_VERSION` does not satisfy is
warned about on the console and not installed.

A plugin's adapters read the configuration texts a form author translates through the state's
`text(property)`, which layers the form's translations and the host catalog, not through
`resolveLocalizedText` on the configuration. The plugin's definition declares those fields
`localized-text`.

A design-system binding package may export a `FormPlugin` beside its binding for the types only its
design system has: `bindings/gcds` exports `gcdsPlugin` (`gcds-date`, base `date`, and content types
drawn with real `gcds-*` elements). The host registers both, and the plugin's types are offered on
the palette only while that binding draws the canvas (`palette.binding`).

## Plugin bundles

A plugin package builds its own bundle with `npm run build` (`packages/datum/scripts/plugin-build.mjs`,
run from the package folder or given `--plugin-dir`). `plugins/icons-fontawesome` writes
`dist/datum-icons-fontawesome.js` and `.iife.js` (`window.DatumIconsFontAwesome`), which registers
Font Awesome as the default icon set on load and re-exports the set. A plugin entry imports neither
the renderer nor the builder.

The package describes its bundle in the `"datumPlugin"` block of its `package.json`; a field the build
does not know is an error.

| Field | Meaning |
|---|---|
| `id` | The package's id. |
| `bundle` | The file name: `dist/<bundle>.js` and `dist/<bundle>.iife.js`. |
| `global` | The classic script's `window` global. |
| `sentinel` | A literal string of the package's own library, asserted present in both formats. |
| `budgetKb` | The module's size budget. |

The build then checks that both files exist, that the sentinel is in each, that no plugin or binding
package the plugin depends on is inside either (each is a bundle of its own), and that the module is
within its budget. A binding package builds the same way through the binding kit
(`packages/datum/binding-kit/build.mjs`, its `"datumBinding"` block). `packages/datum`'s
`check-bundles.mjs` guards the other direction: it refuses a dependency of `packages/datum` or the
engine on any binding or plugin package, so none can reach the renderer, builder or PDF bundles.
