/**
 * How deep a value nests, measured without recursion: the builder clones, walks and prints what
 * it is handed, and a rule tree or a component tree nested thousands of levels exhausts the call
 * stack long before any size cap is reached. Hosts read at most this many levels (the QuickJS
 * request limit), so a value past it is refused where it enters rather than half-handled.
 */

/** The most levels of records and lists a form (or a value written into it) may nest. */
export const NESTING_MAX = 320;

/** Whether `value` nests (records and lists, counted from 1 at the value itself) more than `max` levels. */
export function nestsPast(value: unknown, max: number = NESTING_MAX): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const stack: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: object; depth: number };
    if (depth > max) {
      return true;
    }
    for (const member of Array.isArray(node) ? node : Object.values(node)) {
      if (typeof member === "object" && member !== null) {
        stack.push({ node: member, depth: depth + 1 });
      }
    }
  }
  return false;
}
