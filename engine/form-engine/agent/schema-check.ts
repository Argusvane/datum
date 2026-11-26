/**
 * The registrar's schema-subset check. Chrome validates nothing
 * against a tool's inputSchema, so the registrar enforces the small keyword
 * subset the catalogues are allowed to use: type, required, enum, items, minimum,
 * maximum, maxLength. Unknown top-level keys are not refused: they are dropped from the input
 * the tool sees and reported so the registrar can name them in `warnings` (models add stray
 * keys). Values inside open objects (a property typed `object` without `properties`, such as
 * `answers` or `configuration`) are not checked here; the catalogue coerces them.
 *
 * Pure: no DOM, no engine imports.
 */

/** One violation, keyed by the offending property (`""` for the input itself, dotted for nested keys). */
export interface SchemaProblem {
  key: string;
  expected: string;
}

export interface CheckedInput {
  /** The input the tool sees: known top-level keys only. */
  input: Record<string, unknown>;
  /** Every violation at once (`bad-input.details.problems`); empty when the input passes. */
  problems: SchemaProblem[];
  /** Top-level keys the schema does not list, dropped from `input`. */
  ignoredKeys: string[];
}

type Schema = Record<string, unknown>;

const TYPE_WORDS: Record<string, string> = {
  object: "a JSON object",
  string: "a string",
  integer: "an integer",
  number: "a number",
  boolean: "a boolean",
  array: "an array"
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaOf(value: unknown): Schema | undefined {
  return isPlainObject(value) ? value : undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function joinKey(parent: string, child: string): string {
  return parent === "" ? child : `${parent}.${child}`;
}

/**
 * Checks one value against its property schema, collecting problems under `key`. Recurses into
 * closed objects (those with `properties`) and arrays with an `items` schema; open objects are
 * left to the catalogue.
 */
function checkValue(schema: Schema, value: unknown, key: string, problems: SchemaProblem[]): void {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== undefined && !matchesType(type, value)) {
    problems.push({ key, expected: TYPE_WORDS[type] ?? type });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    problems.push({ key, expected: `one of: ${schema.enum.map((allowed) => String(allowed)).join(", ")}` });
    return;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push({ key, expected: `at least ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push({ key, expected: `at most ${schema.maximum}` });
    }
    return;
  }
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      problems.push({ key, expected: `at most ${schema.maxLength} characters` });
    }
    return;
  }
  if (Array.isArray(value)) {
    const items = schemaOf(schema.items);
    if (items !== undefined) {
      value.forEach((item, index) => checkValue(items, item, `${key}[${index}]`, problems));
    }
    return;
  }
  if (isPlainObject(value)) {
    const properties = schemaOf(schema.properties);
    if (properties === undefined) {
      // An open object: the catalogue coerces what is inside.
      return;
    }
    checkObject(properties, schema.required, value, key, problems);
  }
}

function checkObject(
  properties: Schema,
  required: unknown,
  value: Record<string, unknown>,
  key: string,
  problems: SchemaProblem[]
): void {
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && value[name] === undefined) {
        problems.push({ key: joinKey(key, name), expected: "required" });
      }
    }
  }
  for (const [name, propertySchema] of Object.entries(properties)) {
    const property = schemaOf(propertySchema);
    if (property === undefined || value[name] === undefined) {
      continue;
    }
    checkValue(property, value[name], joinKey(key, name), problems);
  }
}

/**
 * Enforces a tool's inputSchema over an input: `type` (object, string, integer, number,
 * boolean, array), `required`, `enum`, `items`, `minimum` / `maximum` and `maxLength`; unknown
 * top-level keys are dropped and listed in `ignoredKeys`; a non-object input is one problem
 * keyed `""`. Returns the input the tool may see plus every problem found.
 */
export function checkInput(schema: Record<string, unknown>, input: unknown): CheckedInput {
  if (!isPlainObject(input)) {
    return { input: {}, problems: [{ key: "", expected: "a JSON object" }], ignoredKeys: [] };
  }
  const problems: SchemaProblem[] = [];
  const properties = schemaOf(schema.properties) ?? {};
  const known: Record<string, unknown> = {};
  const ignoredKeys: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) {
      known[name] = value;
    } else {
      ignoredKeys.push(name);
    }
  }
  checkObject(properties, schema.required, known, "", problems);
  return { input: known, problems, ignoredKeys };
}
