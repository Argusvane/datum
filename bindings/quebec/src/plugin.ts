/**
 * The Québec design system FormPlugin: the tier-2 component type, wrapping
 * the design system's own component where it is drastically different from Datum's (the binding
 * author's judgement). Registered beside the binding by a host that draws with it
 * (`plugins.register(quebecPlugin)`). The builder lists the type only while the Québec binding draws
 * the canvas (`palette.binding`); it draws under any binding, but the element exists only on a page
 * that loads the design system's script.
 *
 * - `qc-select`, base `select`: the official `<qc-select>`, a custom listbox (a button and a list in
 *   its own shadow root, search and its own keys, the native select hidden). The default `select`
 *   is Datum's native select in Québec's face (select.ts).
 *
 * The definition carries `base`, so the builder writes `kinds: { "qc-select": "select" }` into a saved
 * form and validation, the sandbox and the PDF read the type as its base without this code. The
 * adapter is a factory `(lit) => adapter`: the host passes the renderer's one lit, so this file
 * imports none (type imports only).
 */
import type { CapabilityDefinition, ComponentDefinition, FormPlugin, PropertyEditorField } from "../../../engine/form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../../../engine/form-engine/core/schema/types.js";
import { createSelects } from "./select.js";
import type { Lit } from "./shared.js";

export const QUEBEC_PLUGIN_ID = "quebec-components";

/** The type: the official listbox. */
export const QUEBEC_SELECT_TYPE = "qc-select";

/** The palette heading the package's types are listed under. */
const GROUP = "Québec design system";

/** The binding the type belongs to: the builder offers it only while it draws the canvas. */
const BINDING = "quebec";

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

const listbox: ComponentDefinition = {
  type: QUEBEC_SELECT_TYPE,
  version: "1.0.0",
  base: "select",
  createDefault: () => ({
    id: QUEBEC_SELECT_TYPE,
    type: QUEBEC_SELECT_TYPE,
    configuration: { label: "Choose one", options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }] }
  }),
  capabilities: [
    words("label", "Label"),
    words("description", "Description"),
    words("tooltip", "Tooltip", "Shown with the description: the toolkit's qc-tooltip cannot be used inside the form (see the binding's side-effects notes)."),
    flag("required", "Required"),
    flag("disabled", "Disabled", "Always disabled. Use a rule's “Enabled when” for a conditional one."),
    text("dataKey", "Data key", "The name this answer is stored under in the submitted data. Blank uses the ID."),
    text("cssClass", "CSS classes", "Space-separated class names, added to this component's element."),
    property("options", { type: "options-editor", label: "Options", description: "The choices this field offers." })
  ],
  adapter: (lit: Lit) => createSelects(lit).listbox,
  palette: { label: "Québec select", group: GROUP, icon: "▾", binding: BINDING }
};

export const quebecPlugin: FormPlugin = {
  id: QUEBEC_PLUGIN_ID,
  version: "1.0.0",
  components: [listbox]
};
