/**
 * RFC 8785, the JSON Canonicalization Scheme (JCS) — the text a submission signature covers. One rule set any language can follow, so a server rebuilds the
 * exact signed bytes without the engine:
 *
 * - object members sorted by their names as UTF-16 code units (JavaScript's own `<` on
 *   strings), written out here one by one — never through a JavaScript object, whose engine
 *   puts integer-like keys ("2", "10") first whatever the sort said;
 * - numbers as ECMAScript's Number-to-string writes them (what `JSON.stringify` does for a
 *   finite number: `1e+21`, `0.000001`, `-0` as `0`); NaN and the infinities are refused;
 * - strings escaped as `JSON.stringify` escapes them (`\"`, `\\`, `\b\f\n\r\t`, other controls
 *   as lowercase `\u00xx`, everything else as is — a lone surrogate as `\udxxx`, which I-JSON
 *   forbids and a strict server refuses);
 * - arrays in order, `true` / `false` / `null`, no whitespace;
 * - an `undefined`, function or symbol member left out, and `null` in an array — as JSON does.
 */

function fail(message: string): never {
  throw new TypeError(`JCS: ${message}`);
}

function write(value: unknown, out: string[], seen: Set<object>): boolean {
  if (value === null) {
    out.push("null");
    return true;
  }
  if (value && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return write((value as { toJSON: () => unknown }).toJSON(), out, seen);
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return true;
    case "number":
      if (!Number.isFinite(value)) {
        fail(`${String(value)} is not a JSON number`);
      }
      // ECMAScript Number::toString, which RFC 8785 §3.2.2.3 adopts; -0 is written 0.
      out.push(JSON.stringify(value));
      return true;
    case "string":
      out.push(JSON.stringify(value));
      return true;
    case "bigint":
      fail("a bigint has no JSON form");
    case "undefined":
    case "function":
    case "symbol":
      return false;
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) {
    fail("the value is circular");
  }
  seen.add(object);
  if (Array.isArray(object)) {
    out.push("[");
    object.forEach((entry, index) => {
      if (index > 0) {
        out.push(",");
      }
      if (!write(entry, out, seen)) {
        out.push("null");
      }
    });
    out.push("]");
  } else {
    const record = object as Record<string, unknown>;
    // Code-unit order: the default comparison of JavaScript strings.
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push("{");
    let first = true;
    for (const key of keys) {
      const mark = out.length;
      out.push(first ? "" : ",", JSON.stringify(key), ":");
      if (write(record[key], out, seen)) {
        first = false;
      } else {
        out.length = mark;
      }
    }
    out.push("}");
  }
  seen.delete(object);
  return true;
}

/**
 * The RFC 8785 canonical text of a JSON value. Throws a `TypeError` for what JSON cannot hold
 * (a non-finite number, a bigint, a circular value) and for a top-level `undefined`.
 */
export function canonicalizeJcs(value: unknown): string {
  const out: string[] = [];
  if (!write(value, out, new Set())) {
    fail("the value has no JSON form");
  }
  return out.join("");
}
