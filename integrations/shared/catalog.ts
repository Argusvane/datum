// What a host needs to know about the first-party bundles it ships: the
// engine's version, the component types a form may use with no extension, the engine's own looks
// (the Datum binding with the PDF theme it suggests, and the builder-shell themes) and the form tokens.
// Plugin packages (plugins/<id>) and design-system bindings (bindings/<id>) are not listed: no host ships them;
// a host that registers a binding adds its entry in its own configuration (datum.bindings.* / settings).
// Read from the sources the bundles are built from, so the catalog cannot drift from the bundles. Shared by every host's asset build: run by assets-lib.mjs readCatalog through vite-node; prints
// JSON on stdout.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_COMPONENT_TYPES } from "../../engine/form-engine/registry/engine-component-types.ts";
import { DATUM_BINDING_ID } from "../../engine/form-engine/render/live/datum/options.ts";
import { DEFAULT_PDF_THEME_ID } from "../../engine/form-engine/render/pdf/pdf-theme-defaults.ts";
import { FORM_TOKENS } from "../../engine/form-engine/render/live/datum/tokens.ts";
import { standardComponentTypes } from "../../packages/datum/src/standard-components.ts";
import { builderThemes } from "../../packages/datum/src/themes.ts";
import { FREEZE_INTRINSICS_SNIPPET } from "../../packages/quickjs-wasm-host/src/sandbox-program.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(repo, path), "utf8")) as Record<string, unknown>;

/** A theme's or binding's label is host data: text or `{ default, locales }` (LocalizedText); the catalog keeps the default wording. */
const labelOf = (label: unknown, id: string): string =>
  typeof label === "string" ? label : label && typeof label === "object" && typeof (label as { default?: unknown }).default === "string" ? (label as { default: string }).default : id;

// The bindings the bundles draw with no registration, each with the PDF theme a server host prints under when a route is
// drawn by it: the binding id -> PDF theme map the hosts read. A binding that suggests no PDF theme has no
// `pdfTheme`. Datum's is the only one: dark is the element's `scheme` attribute, not a binding, so it has no entry.
const builtinBindings: { id: string; label: string; pdfTheme?: string }[] = [{ id: DATUM_BINDING_ID, label: "Datum", pdfTheme: DEFAULT_PDF_THEME_ID }];

// The builder shell's own looks (not form looks).
const builderShellThemes = builderThemes.list().map((theme) => ({ id: theme.id, label: labelOf(theme.label, theme.id) }));

const catalog = {
  engineVersion: String(json("engine/package.json").version),
  knownComponentTypes: [...new Set([...ENGINE_COMPONENT_TYPES, ...standardComponentTypes().map((type) => type.type)])].sort(),
  builtinBindings,
  builderThemes: builderShellThemes,
  // The script a server host evaluates before any program (the sandbox freezes the intrinsics).
  freezeIntrinsicsSnippet: FREEZE_INTRINSICS_SNIPPET,
  formTokens: FORM_TOKENS.map((spec) => ({ name: spec.name, group: spec.group, tier: spec.tier, fallback: spec.fallback, what: spec.what }))
};

process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
