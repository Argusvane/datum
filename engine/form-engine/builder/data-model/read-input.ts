import type { DataModel } from "./data-model.js";
import { dataModelFromJsonSchema } from "./from-json-schema.js";
import { dataModelFromSample } from "./from-sample.js";
import type { BuilderWords } from "../logic/builder-texts.js";
import { areaWords } from "../data/data-texts-en.js";

/** What pasted or opened text is taken to be. */
export type DataModelSourceKind = "sample" | "schema";

/** How to read it: as detected, or as the author says. */
export type DataModelReadAs = "auto" | DataModelSourceKind;

/** The largest input read, in characters: past this a paste is a mistake more often than a model. */
export const MAX_DATA_MODEL_INPUT = 2 * 1024 * 1024;

export type ReadDataModelResult =
  | { ok: true; readAs: DataModelSourceKind; detected: DataModelSourceKind; model: DataModel }
  | { ok: false; empty?: true; error?: string; line?: number; column?: number };

const JSON_TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_KEYWORDS = ["type", "$ref", "enum", "const", "properties", "items", "format", "oneOf", "anyOf", "allOf", "title", "description"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTypeName(value: unknown): boolean {
  return typeof value === "string" ? JSON_TYPES.has(value) : Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && JSON_TYPES.has(entry));
}

/**
 * Whether parsed JSON reads as a JSON Schema rather than a sample: it names a `$schema`, keeps
 * `$defs` or `definitions`, pairs a JSON type name with `properties`, `items` or `enum`, or has
 * `properties` whose every entry is itself a schema. Anything else is a sample.
 */
export function detectDataModelSource(value: unknown): DataModelSourceKind {
  if (!isRecord(value)) {
    return "sample";
  }
  if (typeof value.$schema === "string" || isRecord(value.$defs) || isRecord(value.definitions)) {
    return "schema";
  }
  if (isTypeName(value.type) && (isRecord(value.properties) || value.items !== undefined || Array.isArray(value.enum))) {
    return "schema";
  }
  if (isRecord(value.properties)) {
    const entries = Object.values(value.properties);
    if (entries.length > 0 && entries.every((entry) => isRecord(entry) && SCHEMA_KEYWORDS.some((keyword) => keyword in entry))) {
      return "schema";
    }
  }
  return "sample";
}

/** Line and column (from 1) of a character offset. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Where JSON text first stops being JSON, as a character offset; `undefined` when it parses.
 * Engines word their `JSON.parse` errors differently and some give no position at all, so the
 * place is found by scanning the grammar rather than read from the message.
 */
export function jsonErrorOffset(text: string): number | undefined {
  let index = 0;
  const fail = (): never => {
    throw index;
  };
  const space = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")) {
      index += 1;
    }
  };
  const string = (): void => {
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return;
      }
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char < " ") {
        fail();
      }
      index += 1;
    }
    fail();
  };
  const word = (literal: string): void => {
    if (!text.startsWith(literal, index)) {
      fail();
    }
    index += literal.length;
  };
  const value = (): void => {
    space();
    const char = text[index];
    if (char === "{") {
      index += 1;
      space();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        space();
        if (text[index] !== '"') {
          fail();
        }
        string();
        space();
        if (text[index] !== ":") {
          fail();
        }
        index += 1;
        value();
        space();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return;
        }
        fail();
      }
    }
    if (char === "[") {
      index += 1;
      space();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value();
        space();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return;
        }
        fail();
      }
    }
    if (char === '"') {
      string();
      return;
    }
    if (char === "t" || char === "f" || char === "n") {
      word(char === "t" ? "true" : char === "f" ? "false" : "null");
      return;
    }
    JSON_NUMBER.lastIndex = index;
    const number = JSON_NUMBER.exec(text);
    if (!number || number[0].length === 0) {
      fail();
    }
    index += number![0].length;
  };
  try {
    value();
    space();
    if (index < text.length) {
      fail();
    }
    return undefined;
  } catch (offset) {
    return typeof offset === "number" ? Math.min(offset, text.length) : undefined;
  }
}

function parseFailure(text: string, error: unknown, words: BuilderWords): ReadDataModelResult {
  const message = error instanceof Error ? error.message : String(error);
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  const position = /position (\d+)/i.exec(message);
  const scanned = lineColumn || position ? undefined : jsonErrorOffset(text);
  const where = lineColumn
    ? { line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
    : position
      ? lineAndColumn(text, Number(position[1]))
      : scanned !== undefined
        ? lineAndColumn(text, scanned)
        : undefined;
  return { ok: false, error: words.text("dataModel.input.notJson", { message }), ...(where ?? {}) };
}

/**
 * Reads pasted or opened text into a data model: parsed as JSON, taken as a sample or a JSON
 * Schema (`auto` detects which), and read. A failure says why, with the line and column of a
 * JSON syntax error; empty text is `{ ok: false, empty: true }`. Its messages read in `words`
 * (English when absent).
 */
export function readDataModelInput(text: string, readAs: DataModelReadAs = "auto", given?: BuilderWords): ReadDataModelResult {
  const words = areaWords(given);
  if (text.trim() === "") {
    return { ok: false, empty: true };
  }
  if (text.length > MAX_DATA_MODEL_INPUT) {
    return { ok: false, error: words.text("dataModel.input.tooBig", { kb: Math.round(text.length / 1024), mb: MAX_DATA_MODEL_INPUT / 1024 / 1024 }) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return parseFailure(text, error, words);
  }
  const detected = detectDataModelSource(value);
  const as = readAs === "auto" ? detected : readAs;
  let model: DataModel;
  try {
    model = as === "schema" ? dataModelFromJsonSchema(value, words) : dataModelFromSample(value, { words });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (isRecord(value) && isRecord(value.root) && value.root.type === "form") {
    model.notes.unshift({
      code: "form-definition",
      level: "warning",
      message: words.text("dataModel.input.formDefinition")
    });
  }
  return { ok: true, readAs: as, detected, model };
}
