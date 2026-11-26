/**
 * The static check for calculations that feed one another, shared by the browser's dependency
 * graph (`DependencyGraph.findCalculationCycle`) and the sandbox kernel, which names the cycle
 * when its recompute does not settle.
 *
 * Kernel-shaped like the evaluator: the sandbox program splices these
 * functions' source in beside the portable kernel, so the file holds top-level `function`
 * declarations only, referencing only each other and standard globals; no module constants.
 * Every function is listed in {@link CALCULATION_CYCLE_FUNCTIONS}, which `PORTABLE_KERNEL_FUNCTIONS`
 * spreads.
 */

/**
 * The component id a read depends on: the path up to its first `[` or `.`. A contextual read
 * (`row.`, `ancestor.`, `host.`, `component`) depends on no calculation by id: the empty text.
 */
export function kernelCalculationInput(path: string): string {
  if (
    path === "component" ||
    path.startsWith("component.") ||
    path.startsWith("row.") ||
    path.startsWith("ancestor.") ||
    path.startsWith("host.")
  ) {
    return "";
  }
  const bracket = path.indexOf("[");
  const dot = path.indexOf(".");
  let end = path.length;
  if (bracket >= 0 && bracket < end) {
    end = bracket;
  }
  if (dot >= 0 && dot < end) {
    end = dot;
  }
  return path.slice(0, end);
}

/**
 * A cycle among calculations as an ordered id list that ends where it began (`a`, `b`, `a`), or
 * `undefined`. `ids` are the calculations in order; `inputs[i]` are the component ids the
 * calculation `ids[i]` reads (any that is not a calculation is ignored). Depth-first in the
 * given order with an explicit path, so a chain of any length is checked.
 */
export function kernelFindCalculationCycle(ids: string[], inputs: string[][]): string[] | undefined {
  const at = Object.create(null) as Record<string, number>;
  const state: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    at[ids[i] as string] = i;
    state.push(0);
  }
  for (let root = 0; root < ids.length; root += 1) {
    if (state[root] !== 0) {
      continue;
    }
    const path: number[] = [root];
    const next: number[] = [0];
    state[root] = 1;
    while (path.length > 0) {
      const top = path.length - 1;
      const node = path[top] as number;
      const list = inputs[node] as string[];
      if ((next[top] as number) >= list.length) {
        state[node] = 2;
        path.pop();
        next.pop();
        continue;
      }
      const input = list[next[top] as number] as string;
      next[top] = (next[top] as number) + 1;
      const target = at[input];
      if (target === undefined) {
        continue;
      }
      if (state[target] === 1) {
        const cycle: string[] = [];
        for (let i = path.indexOf(target); i < path.length; i += 1) {
          cycle.push(ids[path[i] as number] as string);
        }
        cycle.push(ids[target] as string);
        return cycle;
      }
      if (state[target] === 0) {
        state[target] = 1;
        path.push(target);
        next.push(0);
      }
    }
  }
  return undefined;
}

/** This module's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const CALCULATION_CYCLE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelCalculationInput,
  kernelFindCalculationCycle
];
