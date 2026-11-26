/**
 * Field kinds and options: how a
 * drawn component reads as an answer the assistant tools can write. Moved here from
 * `agent/form/describe.ts` so the builder's Try it tool reads a field the way the renderer's
 * answer-writing tool does without carrying the renderer catalogue: nothing in `agent/answers/`
 * imports `agent/form/` or `agent/builder/`, and nothing here words a hint or names a tool
 * (guard 15 keeps the renderer's tool names out of the builder bundle). `describe.ts`
 * re-exports every name, so the form modules import them where they always did.
 */

import { isGroupNode } from "../../core/tree/data-scope.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";
import { kindOf as registryKindOf, type FieldKind } from "../../registry/kinds.js";
import { cutString } from "../result-caps.js";

// The kind vocabulary is the kind registry's (`registry/kinds.ts`); named here too, where every
// agent module has always imported it.
export type { FieldKind };

export interface Option {
  value: string;
  label: string;
  description?: string;
}

export interface FieldColumn {
  key: string;
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
}

/** The longest label and description a result carries ; longer text is cut with an ellipsis. */
export const LABEL_CAP = 200;
export const DESCRIPTION_CAP = 500;

/**
 * Two plugin type names read by kind before any evidence, as they always were: neither is an
 * engine type, so the kind registry has no entry for them unless a definition maps them.
 */
const PLUGIN_KIND_BY_TYPE: Readonly<Record<string, FieldKind>> = {
  boolean: "boolean",
  multiselect: "multichoice"
};

/** Types drawn without an answer: not listed as fields, refused as unfillable when addressed by id. */
const STATIC_TYPES: ReadonlySet<string> = new Set(["html", "image"]);

/**
 * The kind a drawn component answers as: a collection, the kind registry's kind for its type
 * (an engine type's, or the base's that the definition's `kinds` map gives a plugin or binding
 * type), a group, then a plugin type by evidence (options make a choice, or a multichoice when
 * the value is a record or an array; a file slot makes a file), else text.
 */
export function kindOfNode(model: RenderComponentModel, kinds?: Readonly<Record<string, string>> | undefined): FieldKind {
  const node = model.node;
  if (node.collection !== undefined || model.rows !== undefined) {
    return "collection";
  }
  // A value-bearing kind by type; a container's `group` and a grid's `collection` are read
  // from the node itself below and above, as the evidence of its children and rows says.
  const registered = registryKindOf(model.type, kinds)?.kind;
  const byType = registered !== undefined && registered !== "group" && registered !== "collection" ? registered : PLUGIN_KIND_BY_TYPE[model.type];
  if (byType !== undefined) {
    return byType;
  }
  if (isGroupNode(node)) {
    return "group";
  }
  if (model.optionState.items.length > 0) {
    return model.value !== null && typeof model.value === "object" && !Array.isArray(model.value) ? "multichoice" : Array.isArray(model.value) ? "multichoice" : "choice";
  }
  if (model.file !== undefined) {
    return "file";
  }
  return "text";
}

// The renderer's own name for the same reading; one body, two names.
export { kindOfNode as kindOf };

/** Static drawn things and buttons: never listed, refused when addressed. */
export function unfillableStaticKind(model: RenderComponentModel): "button" | "static" | undefined {
  if (model.type === "button") {
    return "button";
  }
  if (STATIC_TYPES.has(model.type)) {
    return "static";
  }
  return undefined;
}

/** A collection drawn inside another's row template: a plain group with no row runtime. */
export function isNestedCollection(model: RenderComponentModel): boolean {
  return model.node.collection !== undefined && model.rows === undefined;
}

export function isCalculated(model: RenderComponentModel): boolean {
  return model.readOnly || model.node.rules?.value !== undefined;
}

/** The component's options as the model resolved them (in its locale), labels and descriptions capped. */
export function optionsOf(model: RenderComponentModel): Option[] {
  return model.optionState.items.map((item) => {
    const option: Option = { value: item.value, label: cutString(item.label, LABEL_CAP) };
    if (item.description !== undefined && item.description !== "") {
      option.description = cutString(item.description, DESCRIPTION_CAP);
    }
    return option;
  });
}
