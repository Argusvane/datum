import { kernelKindBase } from "./component-kinds.js";
import type { ValidationContext } from "./contracts.js";

/**
 * What a number or a date answer must be: one reading, shared by the browser's
 * field-constraints stage (`validation/core/field-constraints.ts`) and the validation kernel
 * (`validation/wasm/portable-kernel.ts`), which splices these declarations into the sandbox
 * program as they are. So they follow the kernel's rules: top-level `kernel*` function
 * declarations, inline literals, no module constants, no `Date` (the sandbox has none) and
 * nothing locale-sensitive. {@link ANSWER_KIND_FUNCTIONS} lists them for the kernel.
 *
 * Only the built-in `number`, `date`, `text` and `textarea` types are checked — what the markup
 * draws as a number box, a date control or a text box — and a number's or a date's declared
 * bounds (`min` / `max`). Every function takes the definition's `kinds` map as an optional last
 * argument and reads the type through it (`kernelKindBase`, `component-kinds.ts`): a plugin's or
 * a binding's type mapped to `date` is checked as a date; one the map does not name is not
 * checked, since neither side has a registry of plugin types to ask.
 * Emptiness comes first on both sides (`isEmptyValue` / `kernelIsEmptyValue`): an empty
 * answer is `required`'s to judge, never these. No answer is rewritten; this is validation only.
 */

/** A part of a date the date-parts renderer asks for, in the order a message names them. */
export type DatePart = "day" | "month" | "year";

/**
 * What the browser knows about a control that the stored value cannot say, keyed by
 * value path in `ValidationContext.inputStates`: a date typed in part (`incomplete`, with the
 * parts still empty) or a number box holding text the browser could not read (`badInput`).
 * Both store the empty answer. Client-only: never in a draft, the envelope or the sandbox.
 */
export type FieldInputState = NonNullable<ValidationContext["inputStates"]>[string];

/**
 * A number answer: a finite number, or a string that is a plain decimal numeral once trimmed
 * (`12`, `-3.5`, `1e3`, `.5`) — as host prefill, imports and draft files carry one. Anything
 * else is not: `1,000`, `0x10`, `Infinity`, `12 kg`, a boolean, a list, an object.
 *
 * A string is judged by its spelling alone, never by the value an engine parses it to: engines
 * round a numeral near the largest double differently (V8 reads some 309-digit numerals as
 * `Infinity` where QuickJS reads the largest finite double), and the verdict must be the same on
 * every host. So a numeral too large for a double (`1e999`) passes as a numeral.
 */
export function kernelIsNumberAnswer(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string") {
    return false;
  }
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

/**
 * A date answer: `YYYY-MM-DD` exactly, year 0001–9999, month 01–12, and a day the month has
 * (Gregorian leap years). Arithmetic only, so every engine reads it alike.
 */
export function kernelIsDateAnswer(value: unknown): boolean {
  if (typeof value !== "string" || value.length !== 10) {
    return false;
  }
  // Character codes, not a pattern: ASCII digits only (a digit of another script is no digit
  // here), the two hyphens in place, and the three numbers accumulated as they are read.
  let year = 0;
  let month = 0;
  let day = 0;
  for (let i = 0; i < 10; i += 1) {
    const code = value.charCodeAt(i);
    if (i === 4 || i === 7) {
      if (code !== 45) {
        return false;
      }
      continue;
    }
    const digit = code - 48;
    if (digit < 0 || digit > 9) {
      return false;
    }
    if (i < 4) {
      year = year * 10 + digit;
    } else if (i < 7) {
      month = month * 10 + digit;
    } else {
      day = day * 10 + digit;
    }
  }
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  switch (month) {
    case 2:
      return day <= ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28);
    case 4:
    case 6:
    case 9:
    case 11:
      return day <= 30;
    default:
      return day <= 31;
  }
}

/**
 * The code a non-empty answer of a component of `type` raises for its kind — `"number"`,
 * `"date"` or `"text"` — or `null` when it is one, or the type has no kind check. `undefined`
 * is never an answer, so `kernelAnswerKindCode(type, undefined) !== null` says whether `type`
 * is checked.
 *
 * A `text` or `textarea` answer is a string: a number, a boolean, a list or an
 * object sent for one raises `text`, so a length limit or a pattern cannot be dodged by
 * sending another JSON type, and such a value is never stored.
 */
export function kernelAnswerKindCode(type: string, value: unknown, kinds?: unknown): string | null {
  const base = kernelKindBase(type, kinds);
  if (base === "number") {
    return kernelIsNumberAnswer(value) ? null : "number";
  }
  if (base === "date") {
    return kernelIsDateAnswer(value) ? null : "date";
  }
  if (base === "text" || base === "textarea") {
    return typeof value === "string" ? null : "text";
  }
  return null;
}

/**
 * Whether an answer of a component of `type` is of the wrong shape although it reads as empty:
 * an empty list sent for a `text` or `textarea`. `isEmptyValue` calls a list with
 * no item empty for every type, which would let `[]` through as "no answer" and be stored.
 * `null` and `undefined` stay no answer.
 */
export function kernelAnswerIsWrongShape(type: string, value: unknown, kinds?: unknown): boolean {
  const base = kernelKindBase(type, kinds);
  return (base === "text" || base === "textarea") && Array.isArray(value);
}

/**
 * The bounds a `number` or `date` component declares (`configuration.min` / `max`), each read as the control's `min` / `max` attributes are: a number field's a finite
 * number or a plain numeral as text (read as the number), a date field's a real `YYYY-MM-DD`
 * date; anything else is no bound. Both are dropped when the minimum is above the maximum,
 * as `readLengthLimits` drops an inverted pair. `null` stands for no bound; any other type has
 * none. Shared by the browser's field-constraints stage and the kernel.
 */
export function kernelAnswerBounds(
  type: string,
  configuration: Record<string, unknown>,
  kinds?: unknown
): { min: number | string | null; max: number | string | null } {
  const base = kernelKindBase(type, kinds);
  function bound(key: string): number | string | null {
    const raw = configuration[key];
    if (base === "number") {
      if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : null;
      }
      if (typeof raw === "string" && kernelIsNumberAnswer(raw)) {
        const parsed = Number(raw.trim());
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }
    if (base === "date") {
      return kernelIsDateAnswer(raw) ? (raw as string) : null;
    }
    return null;
  }
  const min = bound("min");
  const max = bound("max");
  if (min !== null && max !== null && min > max) {
    return { min: null, max: null };
  }
  return { min, max };
}

/**
 * The code a valid `number` or `date` answer raises for a bound it breaks:
 * `"number.min"` / `"number.max"` / `"date.min"` / `"date.max"`, or `null` when it is within
 * both (a bound itself is within, the comparison inclusive) or the type has none. A number
 * answer is read as the number its spelling gives (a numeral too large for a double reads as
 * infinite, so it is above any maximum), a date compared as text by code unit, which for two
 * real `YYYY-MM-DD` dates is their order. Call it only after {@link kernelAnswerKindCode}
 * found the answer valid.
 */
export function kernelAnswerBoundCode(
  type: string,
  value: unknown,
  min: number | string | null,
  max: number | string | null,
  kinds?: unknown
): string | null {
  const base = kernelKindBase(type, kinds);
  if (base === "number") {
    const number = typeof value === "number" ? value : Number(String(value).trim());
    if (typeof min === "number" && number < min) {
      return "number.min";
    }
    if (typeof max === "number" && number > max) {
      return "number.max";
    }
    return null;
  }
  if (base === "date" && typeof value === "string") {
    if (typeof min === "string" && value < min) {
      return "date.min";
    }
    if (typeof max === "string" && value > max) {
      return "date.max";
    }
  }
  return null;
}

/**
 * Mirrors `isEmptyValue` (validation/core/field-constraints.ts), a non-finite number empty as
 * the `null` JSON carries it as — what a value handed in-process, never through JSON, holds.
 * A lone checkbox is answered only by `true` (`false`, `"false"`, `0` or `"yes"` is no answer),
 * a checkbox group only by a record with an entry `true` (a list or a text picks nothing).
 * Here, in core, so the form-test judge reads emptiness as the kernel does without importing
 * the validation layer; `portable-kernel.ts` re-exports it. `kinds` is the
 * definition's map: a type mapped to `checkbox` or `checkboxes` reads emptiness as its base does.
 */
export function kernelIsEmptyValue(value: unknown, type: string, kinds?: unknown): boolean {
  const base = kernelKindBase(type, kinds);
  // A lone checkbox is answered by `true` alone; a group by a record with a box ticked.
  if (base === "checkbox") {
    return value !== true;
  }
  if (base === "checkboxes") {
    return value === null || typeof value !== "object" || Array.isArray(value) || !Object.values(value).some((entry) => entry === true);
  }
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

/** This module's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const ANSWER_KIND_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelIsEmptyValue,
  kernelIsNumberAnswer,
  kernelIsDateAnswer,
  kernelAnswerKindCode,
  kernelAnswerIsWrongShape,
  kernelAnswerBounds,
  kernelAnswerBoundCode
];
