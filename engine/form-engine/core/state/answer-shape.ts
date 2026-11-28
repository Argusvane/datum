/**
 * What a single answer may be, how a checkbox's or a checkbox group's answer is stored, and
 * when two answers are one: the runtime's write path reads them all, so a value the renderer
 * cannot draw is refused before it is stored, a checkbox's answer is kept in the one shape every
 * surface reads, and a write that changes nothing stays quiet.
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

/**
 * A lone checkbox's answer as it is stored: the text `"true"` is `true` and `"false"` is
 * `false`, as a host's prefill or an older draft may spell them. Every other value is kept as
 * written, as a number box keeps text that is no number: the box is ticked only by `true`, and
 * anything else (`false`, `0`, `1`, `"yes"`) is no tick, and no answer to `required`.
 */
export function checkboxAnswer(value: unknown): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

/**
 * A checkbox group's answer as it is stored: one boolean per option (`{ cat: true, dog: false }`),
 * the record the renderer writes. A list of the values picked (`["cat"]`) becomes that record,
 * `true` for each value in it and `false` for each of `options` (the group's inline options)
 * it leaves out; a finite number in it picks its string form. A list holding anything else,
 * and every other value, is kept as written.
 */
export function checkboxesAnswer(value: unknown, options: readonly string[]): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const picked: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item === "string") {
      picked.push(item);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      picked.push(String(item));
    } else {
      return value;
    }
  }
  // A plain object, as the renderer writes it; defined, so an option `__proto__` is a key.
  const record: Record<string, boolean> = {};
  const tick = (option: string, on: boolean): void => {
    Object.defineProperty(record, option, { value: on, enumerable: true, writable: true, configurable: true });
  };
  for (const option of options) {
    tick(option, picked.includes(option));
  }
  for (const option of picked) {
    tick(option, true);
  }
  return record;
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
