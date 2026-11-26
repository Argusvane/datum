const COMPONENT_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Ids no component may take, though they match the pattern. A rule reads `component` (the rule's
 * own value), `host` (the host's values), `row` (a grid row) and `ancestor` (an enclosing scope)
 * as names of its own, so a component given one could never be read by its id. The translations
 * map cannot key `constructor` or `prototype` (`isSafeSegment` in core/localization/translations.ts): a component given one would keep its translations under an id it no longer
 * has. `__proto__` already fails the pattern.
 */
const RESERVED_COMPONENT_IDS: ReadonlySet<string> = new Set(["component", "host", "row", "ancestor", "constructor", "prototype"]);

/** Whether `value` is one of the words no component may take as its id. */
export function isReservedComponentId(value: string): boolean {
  return RESERVED_COMPONENT_IDS.has(value);
}

/**
 * Whether `value` follows the id grammar (a letter, then letters, digits, `_` or `-`), reserved
 * or not: the grammar journey ids share with components, which reserve other words.
 */
export function fitsComponentIdGrammar(value: string): boolean {
  return COMPONENT_ID_REGEX.test(value);
}

export function isValidComponentId(value: string): boolean {
  return COMPONENT_ID_REGEX.test(value) && !RESERVED_COMPONENT_IDS.has(value);
}

/**
 * Why `value` cannot be a component id, in the one wording every route that takes an id uses
 * (the inspector, the JSON tab, an add or a rename, the agent); `undefined` when it can.
 */
export function componentIdProblem(value: string): string | undefined {
  if (RESERVED_COMPONENT_IDS.has(value)) {
    return `"${value}" cannot be a component id: it is a reserved word (component, host, row, ancestor, constructor and prototype are).`;
  }
  if (!COMPONENT_ID_REGEX.test(value)) {
    return `"${value}" cannot be a component id: start with a letter, then letters, digits, _ or -.`;
  }
  return undefined;
}

export function assertValidComponentId(value: string): void {
  const problem = componentIdProblem(value);
  if (problem !== undefined) {
    throw new Error(problem);
  }
}
