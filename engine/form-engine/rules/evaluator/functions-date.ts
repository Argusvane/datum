/**
 * The date group of the formula function library: civil-date arithmetic over `YYYY-MM-DD`
 * strings, integers only. The sandbox has no `Date`, and nothing here may read a clock: the
 * day comes from the evaluation context (`today()` and `age()` are handled in the evaluator,
 * which calls `kernelDateCall("dateDiff", [dateOfBirth, today, "years"])` for `age`).
 *
 * Kernel-shaped like the evaluator: the sandbox program splices these
 * functions' source in beside the portable kernel, so the file holds top-level `function`
 * declarations only, named with the kernel's prefix, referencing only other spliced functions
 * and standard globals; no module constants, no closures, no `Date`, no `Intl`, no
 * `Math.random`. Regex literals inside a body are fine. Every function is listed in
 * {@link DATE_FUNCTIONS}, which `PORTABLE_KERNEL_FUNCTIONS` spreads.
 *
 * `kernelExprCall` (evaluator.ts) asks {@link kernelDateHandles} before calling
 * {@link kernelDateCall}; the two stay parallel so neither needs a sentinel. The rows of
 * `FORMULA_FUNCTION_TABLE` this group evaluates: isDate, date, dateAdd, dateDiff, year, month,
 * day, dayOfWeek, startOfMonth, endOfMonth, isWeekend. A day is valid when
 * `kernelIsDateAnswer` (core/schema/answer-kinds.ts, spliced through `ANSWER_KIND_FUNCTIONS`)
 * says so. Unknown-typed input yields `undefined`, never a throw.
 */

import { kernelIsDateAnswer } from "../../core/schema/answer-kinds.js";

/** Whether `name` is a function this group evaluates. */
export function kernelDateHandles(name: string): boolean {
  switch (name) {
    case "isDate":
    case "date":
    case "dateAdd":
    case "dateDiff":
    case "year":
    case "month":
    case "day":
    case "dayOfWeek":
    case "startOfMonth":
    case "endOfMonth":
    case "isWeekend":
      return true;
    default:
      return false;
  }
}

/** Days since 1970-01-01 of a civil date (Hinnant's days_from_civil). */
function kernelDateToDays(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date `[year, month, day]` of a day count (Hinnant's civil_from_days). */
function kernelDateFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

/** `[year, month, day]` of a valid `YYYY-MM-DD` string, else undefined. */
function kernelDateParts(value: unknown): [number, number, number] | undefined {
  if (!kernelIsDateAnswer(value)) {
    return undefined;
  }
  const text = value as string;
  return [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))];
}

/** Writes a civil date as `YYYY-MM-DD`; undefined outside years 1 to 9999. */
function kernelDateFormat(year: number, month: number, day: number): string | undefined {
  // Whole numbers in range only: a count that overflowed to `NaN` or `Infinity` upstream is no
  // date, and `"0NaN-aN-aN"` must never be one.
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  return (
    ("0000" + year).slice(-4) + "-" + ("00" + month).slice(-2) + "-" + ("00" + day).slice(-2)
  );
}

/** The last day of a month, from the day counts of its neighbours. */
function kernelDateMonthLength(year: number, month: number): number {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return kernelDateToDays(nextYear, nextMonth, 1) - kernelDateToDays(year, month, 1);
}

/** Evaluates `name` over `args`; `undefined` for a name this group does not handle. */
export function kernelDateCall(name: string, args: unknown[]): unknown {
  const first = args[0];
  if (name === "isDate") {
    return kernelIsDateAnswer(first);
  }
  if (name === "date") {
    if (typeof first !== "string") {
      return undefined;
    }
    const head = first.slice(0, 10);
    return kernelIsDateAnswer(head) ? head : undefined;
  }
  const a = kernelDateParts(first);
  if (a === undefined) {
    return undefined;
  }
  if (name === "year") {
    return a[0];
  }
  if (name === "month") {
    return a[1];
  }
  if (name === "day") {
    return a[2];
  }
  if (name === "dayOfWeek" || name === "isWeekend") {
    const weekday = ((((kernelDateToDays(a[0], a[1], a[2]) + 3) % 7) + 7) % 7) + 1;
    return name === "isWeekend" ? weekday >= 6 : weekday;
  }
  if (name === "startOfMonth") {
    return kernelDateFormat(a[0], a[1], 1);
  }
  if (name === "endOfMonth") {
    return kernelDateFormat(a[0], a[1], kernelDateMonthLength(a[0], a[1]));
  }
  if (name === "dateAdd") {
    const unit = args[2];
    const raw = args[1];
    if (typeof raw !== "number" || !isFinite(raw)) {
      return undefined;
    }
    const amount = Math.trunc(raw);
    if (unit === "days" || unit === "weeks") {
      // Years 1 to 9999 are under 3.7 million days either side of any day: past a few million,
      // or past what a double holds once multiplied, there is no date to name.
      const delta = amount * (unit === "weeks" ? 7 : 1);
      if (!isFinite(delta) || Math.abs(delta) > 4000000) {
        return undefined;
      }
      const moved = kernelDateFromDays(kernelDateToDays(a[0], a[1], a[2]) + delta);
      return kernelDateFormat(moved[0], moved[1], moved[2]);
    }
    if (unit === "months" || unit === "years") {
      const total = a[0] * 12 + (a[1] - 1) + amount * (unit === "years" ? 12 : 1);
      if (!isFinite(total)) {
        return undefined;
      }
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      if (year < 1 || year > 9999) {
        return undefined;
      }
      const last = kernelDateMonthLength(year, month);
      return kernelDateFormat(year, month, a[2] > last ? last : a[2]);
    }
    return undefined;
  }
  if (name === "dateDiff") {
    const b = kernelDateParts(args[1]);
    const unit = args[2];
    if (b === undefined) {
      return undefined;
    }
    if (unit === "days" || unit === "weeks") {
      const days = kernelDateToDays(b[0], b[1], b[2]) - kernelDateToDays(a[0], a[1], a[2]);
      return unit === "weeks" ? Math.trunc(days / 7) + 0 : days + 0;
    }
    if (unit === "months" || unit === "years") {
      // Whole months from the earlier day to the later one, signed. A month is complete when the
      // later day reaches the earlier day's number in its month, or is the last day of its month
      // while the earlier number is past it (the clamp `dateAdd` makes: 31 January plus a month
      // is the last day of February), so `dateDiff(a, dateAdd(a, n, unit), unit)` is `n`.
      // Counted from the earlier day so the answer for (a, b) is minus the answer for (b, a).
      const backwards = kernelDateToDays(b[0], b[1], b[2]) < kernelDateToDays(a[0], a[1], a[2]);
      const first = backwards ? b : a;
      const second = backwards ? a : b;
      let months = (second[0] - first[0]) * 12 + (second[1] - first[1]);
      if (months > 0 && second[2] < first[2] && second[2] !== kernelDateMonthLength(second[0], second[1])) {
        months = months - 1;
      }
      const whole = unit === "years" ? Math.trunc(months / 12) : months;
      return (backwards ? -whole : whole) + 0;
    }
    return undefined;
  }
  return undefined;
}

/** This group's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const DATE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelDateHandles,
  kernelDateToDays,
  kernelDateFromDays,
  kernelDateParts,
  kernelDateFormat,
  kernelDateMonthLength,
  kernelDateCall
];
