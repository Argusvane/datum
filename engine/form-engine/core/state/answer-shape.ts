/**
 * What a single answer may be, and when two answers are one: the runtime's write path reads
 * both, so a value the renderer cannot draw is refused before it is stored and a write that
 * changes nothing stays quiet.
 */

/**
 * The built-in types whose control holds one value: a text box, a text area, a number or date
 * control, a select, a radio group and a lone checkbox. Their answer is a scalar or nothing. A
 * checkbox group, a file field and a collection hold a list or a record, and a plugin's type is
 * the plugin's to judge, so neither is listed.
 */
export const SCALAR_ANSWER_TYPES: ReadonlySet<string> = new Set(["text", "textarea", "number", "date", "select", "radio", "checkbox"]);

/**
 * Whether a value is one a single-valued control can hold and draw: a string, a number or a
 * boolean, or no answer (`null`, `undefined`). An object, a list, a function, a symbol or a
 * bigint is not; `String()` on some objects throws (own `toString` / `valueOf` keys, no
 * prototype), a bigint has no JSON form to submit or save, and none of them is text a person
 * typed or picked.
 */
export function isScalarAnswer(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether two answers are the same: the same value (`Object.is`, so `NaN` is itself and `0` is
 * not `-0`), or plain data with the same content — lists item by item, plain records key by key
 * whatever their order. Anything else (a `File`, a `Map`, a class instance) is the same only as
 * the very same object: JSON would carry two different files alike as `{}`. A structure nested
 * deeper than 64 levels is taken as changed rather than walked further.
 */
export function sameAnswer(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (depth >= 64) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!sameAnswer(a[index], b[index], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) {
    return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !sameAnswer(a[key], b[key], depth + 1)) {
      return false;
    }
  }
  return true;
}
