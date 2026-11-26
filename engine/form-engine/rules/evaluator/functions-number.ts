import { kernelExprAsNumber, kernelExprNumbers } from "./evaluator.js";

/**
 * The number group of the formula function library.
 *
 * Kernel-shaped like the evaluator: the sandbox program splices these
 * functions' source in beside the portable kernel, so the file holds top-level `function`
 * declarations only, named with the kernel's prefix, referencing only other spliced functions
 * and standard globals; no module constants, no closures, no `Date`, no `Intl`, no
 * `Math.random`. Regex literals inside a body are fine. Every function is listed in
 * {@link NUMBER_FUNCTIONS}, which `PORTABLE_KERNEL_FUNCTIONS` spreads.
 *
 * `kernelExprCall` (evaluator.ts) asks {@link kernelNumberHandles} before calling
 * {@link kernelNumberCall}; the two stay parallel so neither needs a sentinel. The rows of
 * `FORMULA_FUNCTION_TABLE` this group evaluates: isNumber, avg (a list argument contributes
 * its items and an empty item is left out, as `kernelExprNumbers` in the evaluator reads them
 * for sum, min and max), roundTo,
 * roundUp, roundDown, modulo, power, sqrt, clamp, number. (sum, min, max, count, abs, round,
 * floor and ceil stay in the evaluator.) Unknown-typed input yields `undefined`, never a throw.
 */

/**
 * A finite number from a number or numeric text; `undefined` for anything else. Text reads
 * as a decimal numeral only (`kernelExprAsNumber`): `0x10`, `0b11` and `Infinity` are text.
 * Never negative zero.
 */
function kernelNumberRead(value: unknown): number | undefined {
  const n = kernelExprAsNumber(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `value` times ten to the `places`, by the exponent form of its shortest decimal spelling
 * (`1.005` is `1.005e+0`, so at 2 places `1.005e2`, exactly 100.5): the shift never goes
 * through string concatenation, so a magnitude already written with an exponent (`1e-7`) shifts
 * as well as any other.
 */
function kernelNumberShift(value: number, places: number): number {
  const parts = value.toExponential().split("e");
  return Number((parts[0] as string) + "e" + String(Number(parts[1]) + places));
}

/**
 * Rounds `value` at `scale` decimal places. `mode` 0 = half away from zero, 1 = away from
 * zero, 2 = towards zero. The decimal shift goes through the exponent of the number's
 * shortest spelling ({@link kernelNumberShift}) so 1.005 at 2 places is 1.01 rather than the
 * float's 1.00, and 1e-7 at 2 places is 0 rather than left alone.
 */
function kernelNumberRound(value: number, scale: number, mode: number): number {
  const places = Math.trunc(scale);
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const shifted = kernelNumberShift(magnitude, places);
  if (!Number.isFinite(shifted)) {
    return value;
  }
  let whole: number;
  if (mode === 1) {
    whole = Math.ceil(shifted);
  } else if (mode === 2) {
    whole = Math.floor(shifted);
  } else {
    whole = Math.floor(shifted + 0.5);
  }
  const back = kernelNumberShift(whole, -places);
  return Number.isFinite(back) ? sign * back + 0 : value;
}

/** Whether `name` is a function this group evaluates. */
export function kernelNumberHandles(name: string): boolean {
  switch (name) {
    case "isNumber":
    case "avg":
    case "roundTo":
    case "roundUp":
    case "roundDown":
    case "modulo":
    case "power":
    case "sqrt":
    case "clamp":
    case "number":
      return true;
    default:
      return false;
  }
}

/** Evaluates `name` over `args`; `undefined` for a name this group does not handle. */
export function kernelNumberCall(name: string, args: unknown[]): unknown {
  switch (name) {
    case "isNumber":
      return kernelNumberRead(args[0]) !== undefined;
    case "avg": {
      // As `sum` reads its arguments: empty items left out, a non-numeric one makes no answer.
      const items = kernelExprNumbers(args);
      if (items === undefined || items.length === 0) {
        return undefined;
      }
      let total = 0;
      for (const n of items) {
        total += n;
      }
      const mean = total / items.length;
      return Number.isFinite(mean) ? mean + 0 : undefined;
    }
    case "roundTo":
    case "roundUp":
    case "roundDown": {
      const n = kernelNumberRead(args[0]);
      if (n === undefined) {
        return undefined;
      }
      let scale = 0;
      if (args.length > 1 && args[1] !== undefined) {
        const s = kernelNumberRead(args[1]);
        if (s === undefined) {
          return undefined;
        }
        scale = s;
      } else if (name === "roundTo") {
        return undefined;
      }
      return kernelNumberRound(n, scale, name === "roundTo" ? 0 : name === "roundUp" ? 1 : 2);
    }
    case "modulo": {
      const a = kernelNumberRead(args[0]);
      const b = kernelNumberRead(args[1]);
      if (a === undefined || b === undefined || b === 0) {
        return undefined;
      }
      // Truncated: the sign of the remainder is the dividend's (modulo(-7, 3) is -1).
      return (a % b) + 0;
    }
    case "power": {
      const a = kernelNumberRead(args[0]);
      const b = kernelNumberRead(args[1]);
      if (a === undefined || b === undefined) {
        return undefined;
      }
      const result = Math.pow(a, b);
      return Number.isFinite(result) ? result + 0 : undefined;
    }
    case "sqrt": {
      const a = kernelNumberRead(args[0]);
      return a === undefined || a < 0 ? undefined : Math.sqrt(a);
    }
    case "clamp": {
      const a = kernelNumberRead(args[0]);
      const lo = kernelNumberRead(args[1]);
      const hi = kernelNumberRead(args[2]);
      if (a === undefined || lo === undefined || hi === undefined || lo > hi) {
        return undefined;
      }
      return Math.min(Math.max(a, lo), hi) + 0;
    }
    case "number":
      return typeof args[0] === "string" ? kernelNumberRead(args[0]) : undefined;
    default:
      return undefined;
  }
}

/** This group's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const NUMBER_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelNumberRead,
  kernelNumberShift,
  kernelNumberRound,
  kernelNumberHandles,
  kernelNumberCall
];
