/**
 * The Ontario Design System FormPlugin: the component types only this design system has,
 * drawn with the real `ontario-*` element. Registered beside the binding by a host that draws with it
 * (`plugins.register(ontarioPlugin)`). The builder lists the types only while the Ontario binding draws
 * the canvas (`palette.binding`); the types draw under any binding, but the element exists only on a page
 * that loads the design system's components.
 *
 * - `ontario-date`: tier 2, base `date`. The official `<ontario-date-input>`; the definition carries
 *   `base: "date"`, so the builder writes `kinds: { "ontario-date": "date" }` into a saved form and
 *   validation, the sandbox and the PDF read it as a date without this code.
 *
 * The adapter is a factory `(lit, datum) => adapter`: the host passes the renderer's one lit and
 * Datum's binding, so this file imports neither (type imports only).
 */
import type { CapabilityDefinition, ComponentDefinition, FormPlugin, PropertyEditorField } from "../../../engine/form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../../../engine/form-engine/core/schema/types.js";
import { createDate, ONTARIO_DATE_TYPE } from "./date.js";
import type { Lit } from "./shared.js";

export const ONTARIO_PLUGIN_ID = "ontario-components";

/** The palette heading the package's types are listed under. */
const GROUP = "Ontario Design System";

/** The binding the types belong to: the builder offers them only while it draws the canvas. */
const BINDING = "ontario";

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
  words("tooltip", "Tooltip", "Shown with the description: this type is the official ontario-date-input, which takes no hint expander."),
  flag("required", "Required"),
  flag("disabled", "Disabled", "Always disabled. Use a rule's “Enabled when” for a conditional one."),
  text("dataKey", "Data key", "The name this answer is stored under in the submitted data. Blank uses the ID."),
  text("cssClass", "CSS classes", "Space-separated class names, added to this component's element.")
];

const date: ComponentDefinition = {
  type: ONTARIO_DATE_TYPE,
  version: "1.0.0",
  base: "date",
  createDefault: () => ({ id: ONTARIO_DATE_TYPE, type: ONTARIO_DATE_TYPE, configuration: { label: "Date" } }),
  capabilities: fieldCapabilities(),
  adapter: (lit: Lit, datum: Parameters<typeof createDate>[1]) => createDate(lit, datum).ontarioDate,
  palette: { label: "Ontario date", group: GROUP, icon: "📅", binding: BINDING }
};

export const ontarioPlugin: FormPlugin = {
  id: ONTARIO_PLUGIN_ID,
  version: "1.0.0",
  components: [date]
};
