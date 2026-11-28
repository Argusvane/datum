import type { BuilderWords } from "../logic/builder-texts.js";
import { areaWords } from "../data/data-texts-en.js";
import {
  addNote,
  assignKeys,
  entriesPath,
  joinDataModelPath,
  type DataModel,
  type DataModelKind,
  type DataModelNode,
  type DataModelNote,
  type DataModelOption
} from "./data-model.js";

/**
 * Reading a JSON Schema — the subset of draft-07 and 2020-12 a form can use: the
 * types, properties and their order, `required`, `items`, choices (`enum`, `const`, a `oneOf`
 * of `const`s), `format`, the string and number bounds, titles and descriptions, and local
 * `$ref`s. What a form cannot hold is named in one note rather than silently lost.
 */

/** Keywords this reader acts on. */
const READ_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "prefixItems",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "$ref",
  "title",
  "description",
  "default",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "contentEncoding",
  "nullable"
]);

/** Keywords that say nothing a form needs, passed over without a note. */
const QUIET_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
  "$anchor",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "additionalProperties",
  "maxItems",
  "uniqueItems",
  "contentMediaType"
]);

const MAX_DEPTH = 32;

/**
 * The most places one read emits. Shared $refs expand once per use, so a small diamond of
 * definitions doubles the tree at every level; the cap turns that into a clear error.
 */
export const MAX_SCHEMA_NODES = 10_000;

interface ReadContext {
  /** Places read so far. */
  count: number;
  root: Record<string, unknown>;
  /** Keywords met that nothing here reads. */
  ignored: Set<string>;
  /** The words of the notes read here. */
  words: BuilderWords;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const TYPE_KINDS: Record<string, DataModelKind> = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null"
};

/** Follows a local JSON Pointer (`#`, `#/$defs/address`, `#/definitions/a~1b`). */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let cursor: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(part)];
    } else if (isRecord(cursor)) {
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * `pattern` split at each `|` outside any group or class: its top-level branches. An anchor
 * binds to its own branch only (`^a|b$` is "starts with a, or ends with b").
 */
function topLevelBranches(pattern: string): string[] {
  const branches: string[] = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
      }
      continue;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "|" && depth === 0) {
      branches.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(pattern.slice(start));
  return branches;
}

/** Whether `pattern` is one non-capturing group around everything: `(?:…)`. */
function isWrapped(pattern: string): boolean {
  if (!pattern.startsWith("(?:") || !pattern.endsWith(")")) {
    return false;
  }
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
      }
      continue;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index < pattern.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * A JSON Schema `pattern` — found anywhere in the text, as ECMA-262 `test` does — as a form's
 * pattern, which the whole answer must match (`^(?:…)$`, the `pattern` attribute's reading).
 * Each top-level branch is read on its own, as its anchors bind to it alone: an anchored
 * branch keeps its body, and an unanchored side becomes "anything" (`^a|b$` is
 * `(?:a)[\s\S]*|[\s\S]*(?:b)`). Refused, with a note, when the form's reading (the `u` flag)
 * cannot compile it.
 */
export function patternForForm(pattern: string, given?: BuilderWords): { pattern?: string; note?: DataModelNote } {
  const words = areaWords(given);
  const result = topLevelBranches(pattern)
    .map((branch) => {
      const anchoredStart = branch.startsWith("^");
      const anchoredEnd = branch.endsWith("$") && !branch.endsWith("\\$");
      let body = branch.slice(anchoredStart ? 1 : 0, anchoredEnd ? branch.length - 1 : branch.length);
      if (anchoredStart && anchoredEnd) {
        while (isWrapped(body)) {
          body = body.slice(3, -1);
        }
        return body;
      }
      return `${anchoredStart ? "" : "[\\s\\S]*"}(?:${body})${anchoredEnd ? "" : "[\\s\\S]*"}`;
    })
    .join("|");
  try {
    new RegExp(`^(?:${result})$`, "u");
  } catch {
    return {
      note: {
        code: "pattern-unusable",
        level: "warning",
        message: words.text("dataModel.pattern.unusable", { pattern })
      }
    };
  }
  return { pattern: result };
}

function kindOfValues(values: readonly unknown[]): DataModelKind {
  if (values.length === 0) {
    return "unknown";
  }
  if (values.every((value) => typeof value === "string")) {
    return "string";
  }
  if (values.every((value) => typeof value === "number")) {
    return values.every((value) => Number.isInteger(value)) ? "integer" : "number";
  }
  if (values.every((value) => typeof value === "boolean")) {
    return "boolean";
  }
  return "unknown";
}

function optionOf(value: unknown, extra: { title?: unknown; description?: unknown } = {}): DataModelOption {
  const option: DataModelOption = { value: String(value) };
  if (typeof extra.title === "string" && extra.title !== "" && extra.title !== option.value) {
    option.label = extra.title;
  }
  if (typeof extra.description === "string" && extra.description !== "") {
    option.description = extra.description;
  }
  return option;
}

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && (value.type === "null" || (Array.isArray(value.type) && value.type.length === 1 && value.type[0] === "null"));
}

function isConstBranch(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "const" in value;
}

/** A schema with its `$ref` resolved and its `allOf` folded in, siblings laid over (the 2020-12 reading). */
function flatten(schema: Record<string, unknown>, context: ReadContext, stack: readonly string[], notes: DataModelNote[]): { schema: Record<string, unknown>; stack: readonly string[] } | "cycle" {
  let current = schema;
  let refs = stack;
  let hops = 0;
  while (typeof current.$ref === "string" && hops < MAX_DEPTH) {
    const ref = current.$ref;
    if (!ref.startsWith("#")) {
      notes.push({ code: "ref-not-followed", level: "warning", message: context.words.text("dataModel.ref.notFollowed", { ref }) });
      const { $ref: _ignored, ...rest } = current;
      current = rest;
      break;
    }
    if (refs.includes(ref)) {
      return "cycle";
    }
    const target = resolvePointer(context.root, ref);
    if (!isRecord(target)) {
      notes.push({ code: "ref-missing", level: "warning", message: context.words.text("dataModel.ref.missing", { ref }) });
      const { $ref: _ignored, ...rest } = current;
      current = rest;
      break;
    }
    const { $ref: _ref, ...siblings } = current;
    current = { ...target, ...siblings };
    refs = [...refs, ref];
    hops += 1;
  }
  if (Array.isArray(current.allOf)) {
    const { allOf, ...rest } = current;
    let merged: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const part of allOf) {
      if (!isRecord(part)) {
        continue;
      }
      const flat = flatten(part, context, refs, notes);
      if (flat === "cycle") {
        continue;
      }
      if (isRecord(flat.schema.properties)) {
        mergeProperties(properties, flat.schema.properties);
      }
      if (Array.isArray(flat.schema.required)) {
        required.push(...flat.schema.required.filter((entry): entry is string => typeof entry === "string"));
      }
      merged = { ...merged, ...flat.schema };
    }
    if (isRecord(rest.properties)) {
      mergeProperties(properties, rest.properties);
    }
    if (Array.isArray(rest.required)) {
      required.push(...rest.required.filter((entry): entry is string => typeof entry === "string"));
    }
    current = { ...merged, ...rest };
    if (Object.keys(properties).length > 0) {
      current.properties = properties;
    }
    if (required.length > 0) {
      current.required = [...new Set(required)];
    }
  }
  return { schema: current, stack: refs };
}

/**
 * Copies `source`'s own properties onto `target` as plain data properties. `Object.assign` would
 * run the `__proto__` setter for a property of that name, swapping the prototype of `target`
 * and losing the property; defining it keeps it an ordinary own key, which the key assignment
 * downstream then renames as it does at the top level.
 */
function mergeProperties(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const name of Object.keys(source)) {
    Object.defineProperty(target, name, {
      value: source[name],
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
}

/** Whether an object schema is the attachment a file field stores (`{ storage, name, type, size }`). */
function isAttachmentSchema(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  return isRecord(properties) && ["storage", "name", "type", "size"].every((key) => key in properties);
}

function read(
  input: unknown,
  key: string,
  path: string,
  context: ReadContext,
  stack: readonly string[],
  depth: number
): DataModelNode {
  const node: DataModelNode = { key, path, kind: "unknown" };
  context.count += 1;
  if (context.count > MAX_SCHEMA_NODES) {
    throw new Error(context.words.text("dataModel.schema.tooBig", { max: MAX_SCHEMA_NODES.toLocaleString("en-US") }));
  }
  if (input === true || input === undefined) {
    return node;
  }
  if (input === false) {
    addNote(node, { code: "never", level: "warning", message: context.words.text("dataModel.schema.never") });
    return node;
  }
  if (!isRecord(input)) {
    return node;
  }
  if (depth > MAX_DEPTH) {
    addNote(node, { code: "too-deep", level: "warning", message: context.words.text("dataModel.schema.tooDeep") });
    return node;
  }
  const notes: DataModelNote[] = [];
  const flat = flatten(input, context, stack, notes);
  for (const note of notes) {
    addNote(node, note);
  }
  if (flat === "cycle") {
    addNote(node, { code: "recursive", level: "warning", message: context.words.text("dataModel.schema.recursive") });
    return node;
  }
  let schema = flat.schema;
  const refs = flat.stack;
  for (const keyword of Object.keys(schema)) {
    if (!READ_KEYWORDS.has(keyword) && !QUIET_KEYWORDS.has(keyword)) {
      context.ignored.add(keyword);
    }
  }

  // Choices, and the X-or-null shape, from oneOf / anyOf.
  let options: DataModelOption[] | undefined;
  let nullable = schema.nullable === true;
  if (schema.nullable === true) {
    addNote(node, { code: "openapi-nullable", level: "info", message: context.words.text("dataModel.schema.nullable") });
  }
  for (const combinator of ["oneOf", "anyOf"] as const) {
    const branches = schema[combinator];
    if (!Array.isArray(branches) || branches.length === 0) {
      continue;
    }
    if (branches.every(isConstBranch)) {
      options = branches.filter((branch) => branch.const !== null).map((branch) => optionOf(branch.const, branch));
      nullable ||= branches.some((branch) => branch.const === null);
      const kind = kindOfValues(branches.map((branch) => branch.const).filter((value) => value !== null));
      if (schema.type === undefined) {
        schema = { ...schema, type: kind === "unknown" ? undefined : kind };
      }
    } else {
      const others = branches.filter((branch) => !isNullSchema(branch));
      nullable ||= others.length < branches.length;
      if (others.length > 1) {
        addNote(node, {
          code: "first-choice",
          level: "warning",
          message: context.words.text("dataModel.schema.firstChoice", { count: others.length, combinator })
        });
      }
      const first = others[0];
      if (isRecord(first)) {
        const { [combinator]: _dropped, ...rest } = schema;
        const inner = flatten(first, context, refs, []);
        schema = inner === "cycle" ? rest : { ...inner.schema, ...rest };
      }
    }
  }

  // The type, stated or implied.
  const types = Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === "string") : typeof schema.type === "string" ? [schema.type] : [];
  nullable ||= types.includes("null");
  const nonNull = types.filter((type) => type !== "null");
  let kind: DataModelKind;
  if (nonNull.length > 1) {
    kind = "unknown";
    addNote(node, { code: "several-kinds", level: "warning", message: context.words.text("dataModel.schema.severalKinds", { kinds: nonNull.join(context.words.text("dataModel.sep")) }) });
  } else if (nonNull.length === 1) {
    kind = TYPE_KINDS[nonNull[0]!] ?? "unknown";
  } else if (types.length === 1) {
    kind = "null";
  } else if (isRecord(schema.properties)) {
    kind = "object";
  } else if (schema.items !== undefined || schema.prefixItems !== undefined) {
    kind = "array";
  } else if (Array.isArray(schema.enum)) {
    kind = kindOfValues(schema.enum.filter((value) => value !== null));
  } else if ("const" in schema) {
    kind = kindOfValues([schema.const]);
  } else {
    kind = "unknown";
  }
  node.kind = kind;
  if (nullable && kind !== "null") {
    node.nullable = true;
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.includes(null) && kind !== "null") {
      node.nullable = true;
    }
    options = schema.enum.filter((value) => value !== null).map((value) => optionOf(value));
  } else if ("const" in schema && schema.const !== null && options === undefined) {
    options = [optionOf(schema.const)];
    addNote(node, { code: "one-value", level: "info", message: `One value is allowed: ${String(schema.const)}.` });
  }
  if (options && options.length > 0 && kind !== "boolean" && kind !== "object" && kind !== "array") {
    node.options = options;
  }

  if (typeof schema.title === "string" && schema.title !== "") {
    node.label = schema.title;
  }
  if (typeof schema.description === "string" && schema.description !== "") {
    node.description = schema.description;
  }
  if ("default" in schema) {
    node.default = schema.default;
  }

  if (kind === "string") {
    if (typeof schema.format === "string" && schema.format !== "") {
      node.format = schema.format;
    }
    if (typeof schema.pattern === "string" && schema.pattern !== "") {
      const converted = patternForForm(schema.pattern, context.words);
      if (converted.pattern !== undefined) {
        node.pattern = converted.pattern;
      }
      if (converted.note) {
        addNote(node, converted.note);
      }
    }
    for (const bound of ["minLength", "maxLength"] as const) {
      const value = schema[bound];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        node[bound] = Math.floor(value);
      }
    }
    if (schema.contentEncoding === "base64") {
      node.kind = "file";
      addNote(node, {
        code: "base64-file",
        level: "warning",
        message: context.words.text("dataModel.schema.base64")
      });
    }
  }

  if (kind === "number" || kind === "integer") {
    if (typeof schema.minimum === "number") {
      node.minimum = schema.minimum;
    }
    if (typeof schema.maximum === "number") {
      node.maximum = schema.maximum;
    }
    const unchecked = ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"].filter((keyword) => schema[keyword] !== undefined);
    if (unchecked.length > 0) {
      addNote(node, { code: "number-bounds", level: "info", message: context.words.text("dataModel.schema.unchecked", { keywords: unchecked.join(context.words.text("dataModel.sep")) }) });
    }
  }

  if (kind === "object") {
    if (isAttachmentSchema(schema)) {
      node.kind = "file";
      return node;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
    node.children = [];
    for (const { name, key: childKey, note } of assignKeys(Object.keys(properties))) {
      const child = read(properties[name], childKey, joinDataModelPath(path, childKey), context, refs, depth + 1);
      if (childKey !== name) {
        child.sourceKey = name;
      }
      if (note) {
        addNote(child, note);
      }
      if (required.has(name)) {
        child.required = true;
      }
      node.children.push(child);
    }
  }

  if (kind === "array") {
    if (Array.isArray(schema.items) || schema.prefixItems !== undefined) {
      addNote(node, { code: "tuple", level: "warning", message: context.words.text("dataModel.schema.tuple") });
    } else if (schema.items !== undefined) {
      node.items = read(schema.items, "", entriesPath(path), context, refs, depth + 1);
      // A list of choices keeps the choices on its entries.
      if (options && options.length > 0 && !node.items.options) {
        node.items.options = options;
      }
    }
    if (typeof schema.minItems === "number" && schema.minItems >= 1) {
      node.minItems = Math.floor(schema.minItems);
    }
  }
  return node;
}

/**
 * The data model a JSON Schema describes. The schema must describe an object at the top —
 * the answers of a form are always an object — and throws otherwise.
 */
export function dataModelFromJsonSchema(schema: unknown, given?: BuilderWords): DataModel {
  const words = areaWords(given);
  if (!isRecord(schema)) {
    throw new Error(words.text("dataModel.schema.notObject"));
  }
  const context: ReadContext = { count: 0, root: schema, ignored: new Set(), words };
  const root = read(schema, "", "", context, [], 0);
  if (root.kind !== "object") {
    throw new Error(words.text("dataModel.schema.topObject"));
  }
  const model: DataModel = { source: "schema", root, notes: [] };
  if (root.label) {
    model.title = root.label;
  }
  if (root.description) {
    model.description = root.description;
  }
  if (context.ignored.size > 0) {
    model.notes.push({
      code: "ignored-keywords",
      level: "info",
      message: words.text("dataModel.schema.ignored", { keywords: [...context.ignored].sort().join(words.text("dataModel.sep")) })
    });
  }
  return model;
}
