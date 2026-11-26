import type { DataModelNode, DataModelNote } from "./data-model.js";
import type { BuilderTextKey, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "../data/data-texts-en.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";

/**
 * How well a component can hold a place in the data: `exact` stores exactly what the model
 * says, `approximate` stores it in a nearby shape (text for a date and time, one object of
 * booleans for a list of choices) and says how, `unsupported` has no component to build.
 */
export type DataModelFit = "exact" | "approximate" | "unsupported";

export interface DataModelMapping {
  /** The component type the node becomes; unset when it becomes none. */
  type?: string;
  fit: DataModelFit;
  /** What the author should know about it: an approximation, a fallback, why nothing is built. */
  notes: DataModelNote[];
  /** Configuration the mapping itself sets (a keyboard hint, `multiple` on a file field). */
  configuration?: Record<string, unknown>;
}

/** Up to this many choices a radio group; more, a select. */
export const RADIO_MAX_OPTIONS = 5;


const NOTE_KEYS = {
  "no-type": "dataModel.map.noType",
  fallback: "dataModel.map.fallback",
  "as-text": "dataModel.map.asText",
  "options-as-text": "dataModel.map.optionsAsText",
  "bounds-hint": "dataModel.map.boundsHint",
  "whole-numbers": "dataModel.map.wholeNumbers",
  "required-checkbox": "dataModel.map.requiredCheckbox",
  "empty-list": "dataModel.map.emptyList",
  "list-in-entry": "dataModel.map.listInEntry",
  "list-of-lists": "dataModel.map.listOfLists",
  flags: "dataModel.map.flags",
  "mixed-list": "dataModel.map.mixedList",
  lines: "dataModel.map.lines",
  "unknown-kind": "dataModel.map.unknownKind"
} as const satisfies Record<string, BuilderTextKey>;

/**
 * Which component a place in the data becomes, and how well it fits. Only types
 * `hasType` knows are chosen: each wish falls back to the next (a date to text), and the
 * fallback is noted. `inEntry` is true inside a repeating section's entry, where a list of
 * entries cannot be built.
 */
export function mappingFor(
  node: DataModelNode,
  hasType: (type: string) => boolean,
  inEntry = false,
  radioMax = RADIO_MAX_OPTIONS,
  text?: BuilderTextOptions
): DataModelMapping {
  const note = (code: keyof typeof NOTE_KEYS, params?: Record<string, string | number>, level: DataModelNote["level"] = "warning"): DataModelNote => ({
    code,
    level,
    message: builderText(NOTE_KEYS[code], params, text)
  });
  const pick = (wanted: readonly string[], fit: DataModelFit, notes: DataModelNote[] = [], configuration?: Record<string, unknown>): DataModelMapping => {
    const type = wanted.find(hasType);
    if (type === undefined) {
      return { fit: "unsupported", notes: [note("no-type", { type: wanted[0] ?? "" })] };
    }
    if (type !== wanted[0]) {
      return {
        type,
        fit: "approximate",
        notes: [...notes, note("fallback", { wanted: wanted[0] ?? "", type })],
        ...(configuration ? { configuration } : {})
      };
    }
    return { type, fit, notes, ...(configuration ? { configuration } : {}) };
  };

  switch (node.kind) {
    case "string": {
      if (node.options && node.options.length > 0) {
        return pick(node.options.length <= radioMax ? ["radio", "select", "text"] : ["select", "radio", "text"], "exact");
      }
      if (node.format === "date") {
        return pick(["date", "text"], "exact");
      }
      if (node.format === "date-time" || node.format === "time") {
        return pick(["text"], "approximate", [note("as-text", { kind: builderText(node.format === "time" ? "dataModel.map.kindTime" : "dataModel.map.kindDateTime", undefined, text) })]);
      }
      if (node.format === "email") {
        return pick(["text"], "exact", [], { autocomplete: "email", inputmode: "email" });
      }
      if (node.format === "uri") {
        return pick(["text"], "exact", [], { inputmode: "url" });
      }
      if (node.format === "multiline" || (node.maxLength ?? 0) >= 256) {
        return pick(["textarea", "text"], "exact");
      }
      return pick(["text"], "exact");
    }
    case "number":
    case "integer": {
      if (node.options && node.options.length > 0) {
        return pick(node.options.length <= radioMax ? ["radio", "select", "text"] : ["select", "radio", "text"], "approximate", [
          note("options-as-text")
        ]);
      }
      const notes: DataModelNote[] = [];
      if (node.minimum !== undefined || node.maximum !== undefined) {
        notes.push(note("bounds-hint", undefined, "info"));
      }
      if (node.kind === "integer") {
        notes.push(note("whole-numbers"));
        return pick(["number", "text"], "approximate", notes);
      }
      return pick(["number", "text"], "exact", notes);
    }
    case "boolean": {
      const notes = node.required
        ? [note("required-checkbox", undefined, "info")]
        : [];
      return pick(["checkbox", "text"], "exact", notes);
    }
    case "object": {
      if (node.format === "flags") {
        return pick(["checkboxes", "container"], "exact");
      }
      return pick(["container"], "exact");
    }
    case "array": {
      const items = node.items;
      if (!items) {
        return { fit: "unsupported", notes: [note("empty-list")] };
      }
      if (items.kind === "object") {
        if (inEntry) {
          return { fit: "unsupported", notes: [note("list-in-entry")] };
        }
        // A list of objects is a data grid: the browser draws and collects its rows.
        // Without the type (a registry that lacks it) it falls back to a repeating section, noted.
        return pick([DATA_GRID_COMPONENT_TYPE, "panel", "fieldset"], "exact");
      }
      if (items.kind === "array") {
        return { fit: "unsupported", notes: [note("list-of-lists")] };
      }
      if (items.kind === "file") {
        return pick(["file"], "exact", [], { multiple: true });
      }
      if (items.options && items.options.length > 0) {
        return pick(["checkboxes", "textarea", "text"], "approximate", [
          note("flags")
        ]);
      }
      if (items.kind === "unknown") {
        return { fit: "unsupported", notes: [note("mixed-list")] };
      }
      return pick(["textarea", "text"], "approximate", [note("lines")]);
    }
    case "file": {
      const fromText = node.notes?.some((entry) => entry.code === "base64-file") ?? false;
      return pick(["file"], fromText ? "approximate" : "exact");
    }
    default:
      return pick(["text"], "approximate", [note("unknown-kind")]);
  }
}
