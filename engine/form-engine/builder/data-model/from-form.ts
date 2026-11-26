import type { ComponentNode } from "../../core/schema/types.js";
import { parseInlineOptions } from "../../core/schema/inline-options.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { readLengthLimits } from "../../core/schema/length-limits.js";
import { ruleExpression } from "../property-editor/rule-source.js";
import {
  collectionPathOf,
  dataKeyOf,
  findDataKeyProblems,
  isDataScopeContainer
} from "../../core/tree/data-scope.js";
import {
  addNote,
  emptyDataModelRoot,
  entriesPath,
  joinDataModelPath,
  type DataModel,
  type DataModelFormat,
  type DataModelKind,
  type DataModelNode,
  type DataModelOption
} from "./data-model.js";

/**
 * How a component takes part in the data: a `value` of some kind, a `scope` (a data-scoping
 * container — an object), a `group` that only arranges others, or `none` (a button, static
 * HTML). A repeating section is recognised by its `collection` binding, whatever its type.
 */
export type DataModelClassification =
  | { role: "value"; kind: DataModelKind; format?: DataModelFormat; choice?: "one" | "many" }
  | { role: "scope" }
  | { role: "group" }
  | { role: "none" };

/** The engine's own types and the well-known names hosts use, by what they store. */
const VALUE_TYPES: Record<string, { kind: DataModelKind; format?: DataModelFormat; choice?: "one" | "many" }> = {
  text: { kind: "string" },
  tel: { kind: "string" },
  password: { kind: "string" },
  email: { kind: "string", format: "email" },
  url: { kind: "string", format: "uri" },
  textarea: { kind: "string", format: "multiline" },
  number: { kind: "number" },
  currency: { kind: "number" },
  rating: { kind: "number" },
  checkbox: { kind: "boolean" },
  toggle: { kind: "boolean" },
  boolean: { kind: "boolean" },
  select: { kind: "string", choice: "one" },
  radio: { kind: "string", choice: "one" },
  // One boolean per option, every option present: `{ email: true, phone: false }`.
  checkboxes: { kind: "object", format: "flags", choice: "many" },
  multiselect: { kind: "array", choice: "many" },
  date: { kind: "string", format: "date" },
  time: { kind: "string", format: "time" },
  datetime: { kind: "string", format: "date-time" },
  file: { kind: "file" }
};

const NONE_TYPES: ReadonlySet<string> = new Set(["html", "image", "button", "signature"]);

const GROUP_TYPES: ReadonlySet<string> = new Set([
  "form",
  "fieldset",
  "panel",
  "grid",
  "tabs",
  "tab",
  "steps",
  "step",
  "repeatingSection",
  // Buttons side by side: a group of actions, never a value.
  "button-group"
]);

/**
 * How the engine's own types (and the common names for others) take part in the data;
 * `undefined` for a type it does not know, which a caller's `classify` decides.
 */
export function classifyComponentForDataModel(node: ComponentNode): DataModelClassification | undefined {
  if (node.type === "container") {
    return isDataScopeContainer(node) ? { role: "scope" } : { role: "group" };
  }
  const value = VALUE_TYPES[node.type];
  if (value) {
    return { role: "value", ...value };
  }
  if (NONE_TYPES.has(node.type)) {
    return { role: "none" };
  }
  if (GROUP_TYPES.has(node.type)) {
    return { role: "group" };
  }
  return undefined;
}

export interface DataModelFromFormOptions {
  /** The locale labels are read in; default `en`. */
  locale?: string;
  /**
   * How a type the engine does not know takes part — a host's own components. Asked first for
   * every component; `undefined` falls back to the engine's reading, and a type nobody knows is
   * a group when it has children and a value of unknown kind when it has none.
   */
  classify?: (node: ComponentNode) => DataModelClassification | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A definition text as the data model names things by: the string in the form's default language. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parentPathOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(0, dot);
}

function lastSegmentOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? path : path.slice(dot + 1);
}

/**
 * The data model a form's answers describe: every component with a place in the data, at that
 * place — keyed by its data key (else its id), nested under the data-scoping containers above
 * it, a repeating section's (or a data grid's) fields inside its entries at its
 * collection path — with
 * the kind of value its type stores, whether it is required, its label and its choices. Where
 * two components would share a place, or a key cannot be used, the nodes say so.
 */
export function dataModelFromForm(root: ComponentNode, options: DataModelFromFormOptions = {}): DataModel {
  const locale = options.locale ?? "en";
  const classify = (node: ComponentNode): DataModelClassification =>
    options.classify?.(node) ??
    classifyComponentForDataModel(node) ??
    (node.children && Object.keys(node.children).length > 0 ? { role: "group" } : { role: "value", kind: "unknown" });

  const model: DataModel = { source: "form", root: emptyDataModelRoot(), notes: [] };
  const title = text(record(root.configuration).title);
  if (title) {
    model.title = title;
  }
  const byComponent = new Map<string, DataModelNode>();

  /** The object at `path` below the document, made (as an implicit object) where no container stands for it. */
  const objectAt = (path: string): DataModelNode => {
    let holder = model.root;
    if (path === "") {
      return holder;
    }
    for (const segment of path.split(".")) {
      const children = (holder.children ??= []);
      let next = children.find((child) => child.key === segment && child.kind === "object" && child.format !== "flags");
      if (!next) {
        next = { key: segment, path: joinDataModelPath(holder.path, segment), kind: "object", children: [], implicit: true };
        children.push(next);
      }
      holder = next;
    }
    return holder;
  };

  const labelled = (node: ComponentNode, out: DataModelNode): void => {
    const configuration = record(node.configuration);
    const label = text(configuration.label) ?? text(configuration.title);
    if (label) {
      out.label = label;
    }
    const description = text(configuration.description);
    if (description) {
      out.description = description;
    }
  };

  const placeList = (node: ComponentNode, path: string, holder: DataModelNode, inEntry: boolean): DataModelNode => {
    const parent = objectAt(parentPathOf(path));
    const list: DataModelNode = {
      key: lastSegmentOf(path),
      path,
      kind: "array",
      items: { key: "", path: entriesPath(path), kind: "object", children: [] },
      componentId: node.id,
      componentType: node.type
    };
    labelled(node, list);
    (parent.children ??= []).push(list);
    byComponent.set(node.id, list);
    if (inEntry) {
      addNote(list, {
        code: "nested-section",
        level: "warning",
        message: `A section inside another section's entry keeps its entries at its own path, ${path}, not inside each outer entry.`
      });
    } else if (parent.path !== holder.path) {
      addNote(list, {
        code: "section-path",
        level: "info",
        message: `Stored at ${path}${holder.path ? `, not under ${holder.path}` : ""}: a section's entries live at its collection path as written.`
      });
    }
    return list;
  };

  const valueNode = (
    node: ComponentNode,
    classification: Extract<DataModelClassification, { role: "value" }>,
    key: string,
    path: string,
    inEntry: boolean
  ): DataModelNode => {
    const configuration = record(node.configuration);
    const out: DataModelNode = { key, path, kind: classification.kind, componentId: node.id, componentType: node.type };
    if (classification.format) {
      out.format = classification.format;
    }
    labelled(node, out);
    if (configuration.required === true) {
      out.required = true;
      if (inEntry) {
        addNote(out, {
          code: "required-in-entry",
          level: "warning",
          message: "Required inside a section's entry: the form checks it outside any entry, so a sandboxed submit is refused until the browser can collect entries."
        });
      }
    }
    if (node.rules?.requiredWhen) {
      out.requiredWhen = true;
    }
    if (typeof configuration.pattern === "string" && configuration.pattern.length > 0) {
      out.pattern = configuration.pattern;
    }
    const lengths = readLengthLimits(configuration);
    if (lengths.minLength !== undefined) {
      out.minLength = lengths.minLength;
    }
    if (lengths.maxLength !== undefined) {
      out.maxLength = lengths.maxLength;
    }
    if (classification.kind === "number" || classification.kind === "integer") {
      if (typeof configuration.min === "number") {
        out.minimum = configuration.min;
      }
      if (typeof configuration.max === "number") {
        out.maximum = configuration.max;
      }
    }
    const defaultValue = ruleExpression(node.rules?.defaultValue);
    if (defaultValue && defaultValue.kind === "literal") {
      out.default = defaultValue.value;
    }
    if (classification.choice) {
      const sourceId = readSourceId(configuration);
      const options: DataModelOption[] = parseInlineOptions(configuration.options).map((option) => {
        const entry: DataModelOption = { value: option.value };
        const label = text(option.label);
        if (label !== undefined && label !== option.value) {
          entry.label = label;
        }
        const description = text(option.description);
        if (description) {
          entry.description = description;
        }
        return entry;
      });
      if (sourceId) {
        out.optionsSource = sourceId;
      } else if (options.length > 0) {
        out.options = options;
      }
      if (classification.format === "flags") {
        // Every option is present in the answer, true or false.
        out.children = (sourceId ? [] : options).map((option) => ({
          key: option.value,
          path: joinDataModelPath(path, option.value),
          kind: "boolean" as const,
          ...(option.label ? { label: option.label } : {})
        }));
      } else if (classification.kind === "array") {
        out.items = { key: "", path: entriesPath(path), kind: "string", ...(out.options ? { options: out.options } : {}) };
      }
    }
    if (classification.kind === "file" && configuration.multiple === true) {
      out.kind = "array";
      out.items = { key: "", path: entriesPath(path), kind: "file" };
    }
    return out;
  };

  const place = (node: ComponentNode, holder: DataModelNode, inEntry: boolean): void => {
    const collection = collectionPathOf(node);
    if (collection !== undefined) {
      const list = placeList(node, collection, holder, inEntry);
      list.collectionPath = collection;
      visit(node, list.items!, true);
      return;
    }
    const classification = classify(node);
    if (classification.role === "none") {
      return;
    }
    if (classification.role === "group") {
      visit(node, holder, inEntry);
      return;
    }
    const key = dataKeyOf(node);
    const path = joinDataModelPath(holder.path, key);
    const children = (holder.children ??= []);
    if (classification.role === "scope") {
      // Two containers may share an object: their fields meet in it.
      let object = children.find((child) => child.key === key && child.kind === "object" && child.format !== "flags" && child.componentType === "container");
      const implicit = children.find((child) => child.key === key && child.implicit);
      object ??= implicit;
      if (!object) {
        object = { key, path, kind: "object", children: [], componentId: node.id, componentType: node.type };
        labelled(node, object);
        children.push(object);
      } else if (object.implicit) {
        delete object.implicit;
        object.componentId = node.id;
        object.componentType = node.type;
        labelled(node, object);
      }
      byComponent.set(node.id, object);
      visit(node, object, inEntry);
      return;
    }
    const value = valueNode(node, classification, key, path, inEntry);
    children.push(value);
    byComponent.set(node.id, value);
  };

  const visit = (node: ComponentNode, holder: DataModelNode, inEntry: boolean): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        place(child, holder, inEntry);
      }
    }
  };

  visit(root, model.root, false);

  for (const problem of findDataKeyProblems(root)) {
    for (const id of problem.componentIds) {
      const node = byComponent.get(id);
      if (node) {
        addNote(node, { code: problem.code, level: "warning", message: problem.message });
      }
    }
  }
  return model;
}
