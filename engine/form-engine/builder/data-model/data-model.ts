/**
 * A form's data model: the shape of the document a form's answers describe — which
 * keys it has, what kind of value sits at each, which are required, what choices they allow —
 * read from a form definition, from a JSON sample, or from a JSON Schema, so the three can be
 * compared and a form built from the other two.
 *
 * It describes the **nested document** (`{ "billing": { "street": "…" } }`). A submission's
 * `values` carry the same data as a flat map keyed by value path (`"billing.street"`); the
 * model is the shape that map spells out.
 *
 * Pure and DOM-free, with no module-level side effects: the builder's Data workspace draws
 * it, a host or a test may read it directly, and nothing here runs until it is called.
 */
import { isPrototypeName } from "../../core/tree/prototype-names.js";

/** What kind of value sits at a place in the document. */
export type DataModelKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "file"
  | "null"
  | "unknown";

/**
 * A refinement of a kind: a string's `date`, `email` or `multiline`; an object's `flags` (one
 * boolean per option, how a checkboxes group stores its picks).
 */
export type DataModelFormat =
  | "date"
  | "date-time"
  | "time"
  | "email"
  | "uri"
  | "uuid"
  | "multiline"
  | "flags"
  | (string & {});

/** Something worth saying about a node or the whole model: a rename, an approximation, a limit. */
export interface DataModelNote {
  code: string;
  level: "info" | "warning";
  message: string;
}

/** One allowed value of a choice, with the words a reader sees for it. */
export interface DataModelOption {
  value: string;
  label?: string;
  description?: string;
}

/** One place in the document. */
export interface DataModelNode {
  /** Its own key in the object that holds it; `""` for the document itself. */
  key: string;
  /** The key as the source wrote it, when it had to change to be usable (`"first name"`). */
  sourceKey?: string;
  /**
   * Where it sits, `[]` marking the entries of a list: `billing.street`, `items`, `items[].sku`;
   * `""` for the document itself.
   */
  path: string;
  kind: DataModelKind;
  /** Whether `null` is allowed besides the kind. */
  nullable?: boolean;
  format?: DataModelFormat;
  required?: boolean;
  /** Required while a rule says so (a form's `requiredWhen`), on top of `required`. */
  requiredWhen?: boolean;
  label?: string;
  description?: string;
  /** The values a choice allows. */
  options?: DataModelOption[];
  /** The data source a choice takes its options from, when it names one instead. */
  optionsSource?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** For a list: at least this many entries. */
  minItems?: number;
  default?: unknown;
  /** An object's keys, in order. */
  children?: DataModelNode[];
  /** A list's entries: the one node every entry is. */
  items?: DataModelNode;
  /** From a form: the component that holds this place, and its type. */
  componentId?: string;
  componentType?: string;
  /** From a form: a repeating section's collection path as written. */
  collectionPath?: string;
  /** From a form: an object no container stands for — the parent of a section filed under a dotted path. */
  implicit?: boolean;
  notes?: DataModelNote[];
}

/** Where a model came from. */
export type DataModelSource = "form" | "sample" | "schema";

export interface DataModel {
  source: DataModelSource;
  /** The document: an object at path `""`. */
  root: DataModelNode;
  title?: string;
  description?: string;
  /** What is worth saying about the whole — keywords a schema used that were not read, say. */
  notes: DataModelNote[];
}

/** An empty document. */
export function emptyDataModelRoot(): DataModelNode {
  return { key: "", path: "", kind: "object", children: [] };
}

/** `parent` + `key` as a model path. */
export function joinDataModelPath(parent: string, key: string): string {
  return parent.length > 0 ? `${parent}.${key}` : key;
}

/** The path of a list's entries. */
export function entriesPath(path: string): string {
  return `${path}[]`;
}

/** Visits every node of the model below the document, depth-first in order, with its parent. */
export function walkDataModel(
  model: DataModel | DataModelNode,
  visit: (node: DataModelNode, parent: DataModelNode) => void | "skip"
): void {
  const root = "root" in model ? model.root : model;
  const walk = (node: DataModelNode): void => {
    for (const child of childrenOf(node)) {
      if (visit(child, node) === "skip") {
        continue;
      }
      walk(child);
    }
  };
  walk(root);
}

/**
 * The nodes directly below `node`: an object's keys, or a list's entry node. A list of plain
 * values has its entry node too (`tags[]`), so a walk reaches the kind of each entry.
 */
export function childrenOf(node: DataModelNode): DataModelNode[] {
  if (node.kind === "object") {
    return node.children ?? [];
  }
  if (node.kind === "array" && node.items) {
    return [node.items];
  }
  return [];
}

/** Every node of the model by path, the document included under `""`. */
export function indexDataModel(model: DataModel): Map<string, DataModelNode> {
  const byPath = new Map<string, DataModelNode>([["", model.root]]);
  walkDataModel(model, (node) => {
    if (!byPath.has(node.path)) {
      byPath.set(node.path, node);
    }
  });
  return byPath;
}

/** Adds a note to a node, once per code. */
export function addNote(node: { notes?: DataModelNote[] }, note: DataModelNote): void {
  const notes = (node.notes ??= []);
  if (!notes.some((existing) => existing.code === note.code && existing.message === note.message)) {
    notes.push(note);
  }
}

/** A key's words for a reader: `firstName` → "First name", `address_line_1` → "Address line 1", `postalCODE` → "Postal CODE". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_\-.]+/g, " ")
    // lower→Upper and letter→digit boundaries; an acronym run stays together.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (spaced.length === 0) {
    return key;
  }
  const words = spaced.split(" ").map((word, index) => {
    // An acronym (two or more capitals) keeps its case; any other word after the first is lower case.
    if (/^[A-Z0-9]{2,}$/.test(word)) {
      return word;
    }
    return index === 0 ? word : word.toLowerCase();
  });
  const first = words[0]!;
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

const KEY_CHARACTERS = /[^A-Za-z0-9_-]+/g;
const USABLE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * A key a component can store under (the data-key grammar) made from whatever a
 * sample or a schema calls it: a usable name kept as it is; otherwise accents folded, anything
 * outside letters, digits, `_` and `-` turned into `_`, and an all-digit key given a leading
 * `_`. Nothing usable left becomes `field`.
 */
export function dataKeyFromName(name: string): string {
  if (isPrototypeName(name)) {
    // A name every object has: stored under it a value would set a prototype, not a key.
    return `${name}_key`;
  }
  if (USABLE_KEY.test(name) && !/^\d+$/.test(name)) {
    return name;
  }
  const trimmed = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
  let key = trimmed.replace(KEY_CHARACTERS, "_");
  // Underscores the replacement put at either end go; ones the name had stay.
  if (!trimmed.startsWith("_")) {
    key = key.replace(/^_+/, "");
  }
  if (!trimmed.endsWith("_")) {
    key = key.replace(/_+$/, "");
  }
  if (key.length === 0) {
    return "field";
  }
  return /^\d+$/.test(key) ? `_${key}` : key;
}

/**
 * Keys for an object's members as the source names them: each usable one kept, the rest made
 * usable, a second use of one key numbered (`name_2`). Returns the key per source name, in order,
 * with a note for every one that changed.
 */
export function assignKeys(names: readonly string[]): Array<{ name: string; key: string; note?: DataModelNote }> {
  const used = new Set<string>();
  return names.map((name) => {
    const base = dataKeyFromName(name);
    let key = base;
    let counter = 2;
    while (used.has(key)) {
      key = `${base}_${counter}`;
      counter += 1;
    }
    used.add(key);
    if (key === name) {
      return { name, key };
    }
    return {
      name,
      key,
      note: {
        code: "renamed",
        level: "warning",
        message: isPrototypeName(name)
          ? `Stored as "${key}": "${name}" is a name every object has, so it cannot be a key. The source calls it "${name}".`
          : `Stored as "${key}": a key may hold letters, digits, _ and - only, and must be unique in its object. The source calls it "${name}".`
      }
    };
  });
}
