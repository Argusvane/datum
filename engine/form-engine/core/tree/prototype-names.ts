/**
 * Names that reach an object's prototype instead of a key of its own: a property path, rule
 * name or data key spelling one would write to, read from or delete on `Object.prototype`.
 * The agent layer and the controller refuse the same three, so the tree owns the one list.
 */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `name` is `__proto__`, `constructor` or `prototype`, whole (`__proto`, `constructorName` are not). */
export function isPrototypeName(name: string): boolean {
  return PROTOTYPE_NAMES.has(name);
}

/** The first segment of the dotted `path` that is a prototype name, or `undefined` when none is. */
export function prototypeSegmentOf(path: string): string | undefined {
  return path.split(".").find(isPrototypeName);
}

/** Throws when a segment of the dotted `path` would reach a prototype. */
export function assertSafePropertyPath(path: string): void {
  const segment = prototypeSegmentOf(path);
  if (segment !== undefined) {
    throw new Error(`Invalid property path "${path}": "${segment}" is a reserved name.`);
  }
}
