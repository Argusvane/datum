/**
 * The Alberta Design System FormPlugin: the tier-2 component types, each
 * wrapping the design system's own component where it is drastically different from Datum's
 * (the binding author's judgement). Registered beside the binding by a host that draws with
 * it (`plugins.register(albertaPlugin)`). The builder lists the types only while the Alberta
 * binding draws the canvas (`palette.binding`); the types draw under any binding, but the elements
 * exist only on a page that loads the design system's components.
 *
 * - `goa-date-picker`, base `date`: the official `<goa-date-picker type="input">`. It says a date
 *   only when whole, and keeps the parts a person typed to itself, so it is read through its inner
 *   controls. The default `date` is Datum's own date in Alberta's pieces (date.ts).
 * - `goa-dropdown`, base `select`: the official dropdown's own listbox, a custom control. The
 *   default `select` is the same component drawn native (a real `<select>` in Alberta's face).
 *
 * The definition carries `base`, so the builder writes `kinds: { "goa-date-picker": "date", ... }`
 * into a saved form and validation, the sandbox and the PDF read the type as its base without this
 * code. The adapters are factories `(lit, datum) => adapter`: the host passes the renderer's one
 * lit and Datum's binding, so this file imports neither (type imports only).
 */
import type { CapabilityDefinition, ComponentDefinition, FormPlugin, PropertyEditorField } from "../../../engine/form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../../../engine/form-engine/core/schema/types.js";
import { createDate, ALBERTA_DATE_TYPE } from "./date.js";
import { createFields } from "./fields.js";
import type { Lit } from "./shared.js";

export const ALBERTA_PLUGIN_ID = "alberta-components";

/** The palette heading the package's types are listed under. */
const GROUP = "Alberta Design System";

/** The binding the types belong to: the builder offers them only while it draws the canvas. */
const BINDING = "alberta";

/** The listbox's type: the dropdown's own custom control, base `select`. */
export const ALBERTA_DROPDOWN_TYPE = "goa-dropdown";

/** Writes a capability's configuration onto a component: every one of these is a plain configuration key. */
function merge(component: ComponentNode, configuration: unknown): ComponentNode {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return component;
  }
  const base = component.configuration && typeof component.configuration === "object" && !Array.isArray(component.configuration) ? (component.configuration as Record<string, unknown>) : {};
  return { ...component, configuration: { ...base, ...(configuration as Record<string, unknown>) } };
}

const property = (id: string, field: Omit<PropertyEditorField, "id" | "propertyPath"> & { propertyPath?: string }): CapabilityDefinition => ({
  id,
  version: "1.0.0",
  configureEditor: () => ({ fields: [{ id, propertyPath: id, ...field }] }),
  apply: merge
});

const text = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "text", label, ...(description !== undefined ? { description } : {}) });
const words = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "localized-text", label, ...(description !== undefined ? { description } : {}) });
const flag = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "boolean", label, ...(description !== undefined ? { description } : {}) });

/** The usual editor set for a value-bearing field. */
const fieldCapabilities = (): CapabilityDefinition[] => [
  words("label", "Label"),
  words("description", "Description"),
  words("tooltip", "Tooltip", "Shown with the description, as the Alberta Design System has no hover help on a field."),
  flag("required", "Required"),
  flag("disabled", "Disabled", "Always disabled. Use a rule's “Enabled when” for a conditional one."),
  text("dataKey", "Data key", "The name this answer is stored under in the submitted data. Blank uses the ID."),
  text("cssClass", "CSS classes", "Space-separated class names, added to this component's element.")
];

const datePicker: ComponentDefinition = {
  type: ALBERTA_DATE_TYPE,
  version: "1.0.0",
  base: "date",
  createDefault: () => ({ id: ALBERTA_DATE_TYPE, type: ALBERTA_DATE_TYPE, configuration: { label: "Date" } }),
  capabilities: fieldCapabilities(),
  adapter: (lit: Lit) => createDate(lit).datePicker,
  palette: { label: "Alberta date picker", group: GROUP, icon: "📅", binding: BINDING }
};

const dropdown: ComponentDefinition = {
  type: ALBERTA_DROPDOWN_TYPE,
  version: "1.0.0",
  base: "select",
  createDefault: () => ({ id: ALBERTA_DROPDOWN_TYPE, type: ALBERTA_DROPDOWN_TYPE, configuration: { label: "Choose one", options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }] } }),
  capabilities: [...fieldCapabilities(), property("options", { type: "options-editor", label: "Options", description: "The choices this field offers." })],
  adapter: (lit: Lit) => createFields(lit).listbox,
  palette: { label: "Alberta dropdown", group: GROUP, icon: "▾", binding: BINDING }
};

export const albertaPlugin: FormPlugin = {
  id: ALBERTA_PLUGIN_ID,
  version: "1.0.0",
  components: [datePicker, dropdown]
};
