/**
 * The list group of the formula function library.
 *
 * Kernel-shaped like the evaluator: the sandbox program splices these
 * functions' source in beside the portable kernel, so the file holds top-level `function`
 * declarations only, named with the kernel's prefix, referencing only other spliced functions
 * and standard globals; no module constants, no closures, no `Date`, no `Intl`, no
 * `Math.random`. Regex literals inside a body are fine. Every function is listed in
 * {@link LIST_FUNCTIONS}, which `PORTABLE_KERNEL_FUNCTIONS` spreads.
 *
 * `kernelExprCall` (evaluator.ts) asks {@link kernelListHandles} before calling
 * {@link kernelListCall}; the two stay parallel so neither needs a sentinel. The rows of
 * `FORMULA_FUNCTION_TABLE` this group evaluates: first, last, distinct, sort, reverse, append,
 * pluck, any, all. (selected and count stay in the evaluator as `kernelExprSelected`.)
 * Unknown-typed input yields `undefined`, never a throw.
 */

/**
 * The most items a list function accepts, `MAX_FORMULA_LIST_ITEMS`: a list over it gives no
 * answer and one warning (the list sibling of the 10,000 character text cap). A function, not a
 * constant, because spliced source has no module constants.
 */
export function kernelMaxFormulaListItems(): number {
  return 10000;
}

/** Whether `name` is a function this group evaluates. */
export function kernelListHandles(name: string): boolean {
  return (
    name === "first" ||
    name === "last" ||
    name === "distinct" ||
    name === "sort" ||
    name === "reverse" ||
    name === "append" ||
    name === "pluck" ||
    name === "any" ||
    name === "all"
  );
}

/** Evaluates `name` over `args`; `undefined` for a name this group does not handle. */
export function kernelListCall(name: string, args: unknown[]): unknown {
  const list = args[0];
  if (name === "append") {
    if (list === undefined) {
      return [args[1]];
    }
    return Array.isArray(list) ? list.concat([args[1]]) : undefined;
  }
  if (!Array.isArray(list)) {
    return undefined;
  }
  if (name === "first") {
    return list[0];
  }
  if (name === "last") {
    return list[list.length - 1];
  }
  if (name === "reverse") {
    return list.slice().reverse();
  }
  if (name === "distinct") {
    // A Set: linear in the list, where a search of the kept items was quadratic. Items are the
    // same when a Set says so: numbers and texts by value (NaN with NaN, 0 with -0), objects
    // and lists by identity, so two records that merely look alike both stay.
    const seen = new Set<unknown>();
    const kept: unknown[] = [];
    for (let i = 0; i < list.length; i += 1) {
      if (!seen.has(list[i])) {
        seen.add(list[i]);
        kept.push(list[i]);
      }
    }
    return kept;
  }
  if (name === "sort") {
    let numbers = 0;
    let texts = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (typeof list[i] === "number") {
        numbers += 1;
      } else if (typeof list[i] === "string") {
        texts += 1;
      }
    }
    // Numbers by value or texts by code unit; any other mix has no order, so no answer.
    if (numbers !== list.length && texts !== list.length) {
      return undefined;
    }
    const copy = list.slice();
    if (numbers === list.length) {
      return copy.sort((a: number, b: number) => a - b);
    }
    return copy.sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (name === "pluck") {
    const key = args[1];
    const out: unknown[] = [];
    if (typeof key !== "string") {
      return undefined;
    }
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (row !== null && typeof row === "object" && !Array.isArray(row) && Object.prototype.hasOwnProperty.call(row, key)) {
        const value = (row as Record<string, unknown>)[key];
        if (value !== undefined) {
          out.push(value);
        }
      }
    }
    return out;
  }
  if (name === "any") {
    return list.some((item: unknown) => item === true);
  }
  if (name === "all") {
    return list.every((item: unknown) => item === true);
  }
  return undefined;
}

/** This group's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const LIST_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [kernelMaxFormulaListItems, kernelListHandles, kernelListCall];
