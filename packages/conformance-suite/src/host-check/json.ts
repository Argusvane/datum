/**
 * Reading a host's JSON the way the Java kit reads it with Jackson's tree: `path(...)` never throws
 * (a missing member is `undefined`, Jackson's MissingNode), `asString` is "" for anything that is
 * not a scalar, `asBoolean` takes a default for a missing member. A case written with these reads
 * the same answers the same way as its Java original.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The member at `keys` (object keys or array indexes), or undefined. */
export function path(value: unknown, ...keys: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of keys) {
    if (typeof key === "number") {
      if (!Array.isArray(at) || key < 0 || key >= at.length) return undefined;
      at = at[key];
    } else {
      if (!isRecord(at) || !Object.prototype.hasOwnProperty.call(at, key)) return undefined;
      at = at[key];
    }
  }
  return at;
}

/** Whether `value` is an object that has the member `key` (Jackson's `has`). */
export function has(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/** Jackson's `asString()`: a string as is, a number or boolean as its text, anything else "". */
export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Jackson's `asBoolean(default)`: a boolean as is, "true"/"false" text, a number other than 0, else the default. */
export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return fallback;
}

/**
 * JSON equality as Jackson's JsonNode.equals has it for these documents: objects equal member by
 * member whatever their order, arrays element by element in order, scalars by value. (Jackson also
 * tells an integer 1 from a decimal 1.0; JSON.parse cannot, so a host answering 1.0 where the golden
 * file says 1 passes here. Stated in the kit's notes.)
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEquals(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key]));
  }
  return false;
}

/** Short text of a value for a failure message. */
export function shown(value: unknown, limit = 300): string {
  const text = value === undefined ? "(missing)" : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
