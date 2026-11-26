import { isFileAttachment } from "../../core/schema/file-upload.js";
import type { BuilderWords } from "../logic/builder-texts.js";
import { areaWords } from "../data/data-texts-en.js";
import { MAX_SCHEMA_NODES } from "./from-json-schema.js";
import {
  addNote,
  assignKeys,
  entriesPath,
  joinDataModelPath,
  type DataModel,
  type DataModelNode
} from "./data-model.js";

/**
 * Reading a JSON sample: an example of the document a form should produce, whose
 * values say what kind each key holds. Every entry of a list is read and merged, so a key one
 * entry has and another lacks is still found; a value that is `null` in one place and text in
 * another is text that may be `null`.
 *
 * A sample says what a value looks like, never what is required or allowed — that is a JSON
 * Schema's to say — so nothing read here is required, and no choices are inferred.
 */

type StringFormat = "date" | "date-time" | "email" | "uri";

type Shape =
  | { kind: "null" }
  | { kind: "boolean"; nullable: boolean }
  | { kind: "number"; nullable: boolean }
  | { kind: "string"; nullable: boolean; formats: Set<StringFormat | "none">; multiline: boolean }
  | { kind: "file"; nullable: boolean }
  | { kind: "array"; nullable: boolean; items: Shape | undefined }
  | { kind: "object"; nullable: boolean; keys: Map<string, Shape> }
  | { kind: "mixed"; nullable: boolean; kinds: Set<string> };

export interface DataModelFromSampleOptions {
  /** Text longer than this many characters reads as multi-line; default 80. */
  longText?: number;
  /** The words of the notes read here, in the builder's locale; English when absent. */
  words?: BuilderWords;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI = /^https?:\/\/\S+$/;

function formatOf(value: string): StringFormat | "none" {
  const date = DATE.exec(value);
  if (date) {
    const month = Number(date[2]);
    const day = Number(date[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? "date" : "none";
  }
  if (DATE_TIME.test(value)) {
    return "date-time";
  }
  if (EMAIL.test(value)) {
    return "email";
  }
  if (URI.test(value)) {
    return "uri";
  }
  return "none";
}

function shapeOf(value: unknown, longText: number): Shape {
  if (value === null || value === undefined) {
    return { kind: "null" };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", nullable: false };
  }
  if (typeof value === "number") {
    return { kind: "number", nullable: false };
  }
  if (typeof value === "string") {
    const blank = value.trim() === "";
    return {
      kind: "string",
      nullable: false,
      // An empty value says nothing about the format the others agree on.
      formats: blank ? new Set() : new Set([formatOf(value)]),
      multiline: value.includes("\n") || value.length > longText
    };
  }
  if (Array.isArray(value)) {
    let items: Shape | undefined;
    for (const entry of value) {
      const shape = shapeOf(entry, longText);
      items = items ? merge(items, shape) : shape;
    }
    return { kind: "array", nullable: false, items };
  }
  if (typeof value === "object") {
    if (isFileAttachment(value)) {
      return { kind: "file", nullable: false };
    }
    const keys = new Map<string, Shape>();
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.set(key, shapeOf(entry, longText));
    }
    return { kind: "object", nullable: false, keys };
  }
  return { kind: "mixed", nullable: false, kinds: new Set([typeof value]) };
}

function withNull<T extends Shape>(shape: T): Shape {
  return shape.kind === "null" ? shape : { ...shape, nullable: true };
}

function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "null") {
    return withNull(b);
  }
  if (b.kind === "null") {
    return withNull(a);
  }
  const nullable = a.nullable || b.nullable;
  if (a.kind === "mixed" || b.kind === "mixed" || a.kind !== b.kind) {
    const kinds = new Set<string>();
    for (const shape of [a, b]) {
      if (shape.kind === "mixed") {
        shape.kinds.forEach((kind) => kinds.add(kind));
      } else {
        kinds.add(shape.kind);
      }
    }
    return { kind: "mixed", nullable, kinds };
  }
  switch (a.kind) {
    case "string": {
      const other = b as Extract<Shape, { kind: "string" }>;
      return { kind: "string", nullable, formats: new Set([...a.formats, ...other.formats]), multiline: a.multiline || other.multiline };
    }
    case "array": {
      const other = b as Extract<Shape, { kind: "array" }>;
      const items = a.items && other.items ? merge(a.items, other.items) : (a.items ?? other.items);
      return { kind: "array", nullable, items };
    }
    case "object": {
      const other = b as Extract<Shape, { kind: "object" }>;
      const keys = new Map(a.keys);
      for (const [key, shape] of other.keys) {
        const existing = keys.get(key);
        keys.set(key, existing ? merge(existing, shape) : shape);
      }
      return { kind: "object", nullable, keys };
    }
    default:
      return { ...a, nullable };
  }
}

/** Places made so far by one read, held to the schema reader's cap. */
interface Count {
  places: number;
}

function toNode(shape: Shape, key: string, path: string, words: BuilderWords, count: Count): DataModelNode {
  count.places += 1;
  if (count.places > MAX_SCHEMA_NODES) {
    throw new Error(words.text("dataModel.sample.tooBig", { max: MAX_SCHEMA_NODES.toLocaleString("en-US") }));
  }
  switch (shape.kind) {
    case "null": {
      const node: DataModelNode = { key, path, kind: "null" };
      addNote(node, { code: "only-null", level: "info", message: words.text("dataModel.onlyNull") });
      return node;
    }
    case "boolean":
    case "number":
    case "file":
      return { key, path, kind: shape.kind, ...(shape.nullable ? { nullable: true } : {}) };
    case "string": {
      const node: DataModelNode = { key, path, kind: "string", ...(shape.nullable ? { nullable: true } : {}) };
      const formats = [...shape.formats];
      const only = formats.length === 1 ? formats[0] : undefined;
      if (only !== undefined && only !== "none") {
        node.format = only;
      } else if (shape.multiline) {
        node.format = "multiline";
      }
      return node;
    }
    case "mixed": {
      const node: DataModelNode = { key, path, kind: "unknown", ...(shape.nullable ? { nullable: true } : {}) };
      addNote(node, {
        code: "several-kinds",
        level: "warning",
        message: words.text("dataModel.sample.severalKinds", { kinds: [...shape.kinds].sort().join(words.text("dataModel.sep")) })
      });
      return node;
    }
    case "array": {
      const node: DataModelNode = { key, path, kind: "array", ...(shape.nullable ? { nullable: true } : {}) };
      if (shape.items) {
        node.items = toNode(shape.items, "", entriesPath(path), words, count);
      } else {
        addNote(node, { code: "empty-list", level: "warning", message: words.text("dataModel.sample.emptyList") });
      }
      return node;
    }
    case "object": {
      const node: DataModelNode = { key, path, kind: "object", children: [], ...(shape.nullable ? { nullable: true } : {}) };
      for (const { name, key: childKey, note } of assignKeys([...shape.keys.keys()])) {
        const child = toNode(shape.keys.get(name)!, childKey, joinDataModelPath(path, childKey), words, count);
        if (childKey !== name) {
          child.sourceKey = name;
        }
        if (note) {
          addNote(child, note);
        }
        node.children!.push(child);
      }
      return node;
    }
  }
}

/**
 * The data model a JSON sample implies. The sample must be an object at the top — the answers
 * of a form are always an object — and throws otherwise.
 */
export function dataModelFromSample(value: unknown, options: DataModelFromSampleOptions = {}): DataModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(areaWords(options.words).text("dataModel.sample.notObject"));
  }
  const root = toNode(shapeOf(value, options.longText ?? 80), "", "", areaWords(options.words), { places: 0 });
  return { source: "sample", root, notes: [] };
}
