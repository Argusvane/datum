/**
 * A host context (what the rules' `host.` paths read) as the runtimes keep it: plain JSON data,
 * copied, so nothing the page holds on to can change it behind the runtime's back. A value JSON
 * cannot carry (a function, a symbol, a bigint, `NaN` or an infinity, a `Date`, a `Map`, a class
 * instance) is left out with its path named, as is anything nested deeper than
 * {@link HOST_CONTEXT_MAX_DEPTH} or past {@link HOST_CONTEXT_MAX_VALUES} values in all (a cycle
 * ends there too). An `undefined` entry is left out silently, as JSON leaves it out. The rest is
 * kept: a context with one bad entry still drives the rules its good entries feed.
 *
 * It lives in the engine so `<datum-form>`'s `hostContext` property and the builder's Try it
 * Settings (host values to preview a `host.` rule with) take exactly the same rules.
 */

/** How deep a host context may nest (the record itself the first level): the sandbox's bound on the data it is handed. */
export const HOST_CONTEXT_MAX_DEPTH = 64;

/** How many values a host context may hold in all. */
export const HOST_CONTEXT_MAX_VALUES = 10_000;

export interface PlainHostContext {
  /** The copy to use; `undefined` when the value was none, or no record at all. */
  context: Record<string, unknown> | undefined;
  /** What was left out and why, one line each, in the order met; empty when nothing was. */
  problems: string[];
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** `value` as `<datum-form>` keeps it: see the module comment. `null` and `undefined` are no context. */
export function plainHostContext(value: unknown): PlainHostContext {
  const problems: string[] = [];
  if (value === undefined || value === null) {
    return { context: undefined, problems };
  }
  if (typeof value !== "object" || Array.isArray(value) || !isPlainObject(value)) {
    problems.push(`hostContext must be a plain object of JSON values, not ${Array.isArray(value) ? "a list" : typeof value === "object" ? "an object of another kind" : `a ${typeof value}`}`);
    return { context: undefined, problems };
  }
  let count = 0;
  const copy = (item: unknown, path: string, depth: number): { keep: boolean; value?: unknown } => {
    count += 1;
    if (count > HOST_CONTEXT_MAX_VALUES) {
      if (count === HOST_CONTEXT_MAX_VALUES + 1) {
        problems.push(`${path}: more than ${HOST_CONTEXT_MAX_VALUES} values in all; the rest are left out`);
      }
      return { keep: false };
    }
    if (item === null || typeof item === "boolean" || typeof item === "string") {
      return { keep: true, value: item };
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        problems.push(`${path}: a number JSON cannot carry (NaN or an infinity)`);
        return { keep: false };
      }
      return { keep: true, value: item === 0 ? 0 : item };
    }
    if (typeof item !== "object") {
      problems.push(`${path}: a ${typeof item}`);
      return { keep: false };
    }
    if (depth >= HOST_CONTEXT_MAX_DEPTH) {
      problems.push(`${path}: nested deeper than ${HOST_CONTEXT_MAX_DEPTH} levels`);
      return { keep: false };
    }
    if (Array.isArray(item)) {
      const list: unknown[] = [];
      for (let index = 0; index < item.length; index += 1) {
        const entry: unknown = item[index];
        // JSON writes an empty slot of a list as null; so does this copy.
        const kept = entry === undefined ? { keep: true, value: null } : copy(entry, `${path}[${index}]`, depth + 1);
        list.push(kept.keep ? kept.value : null);
      }
      return { keep: true, value: list };
    }
    if (!isPlainObject(item)) {
      const name = (item as { constructor?: { name?: unknown } }).constructor?.name;
      problems.push(`${path}: an object that is not a plain object (${typeof name === "string" && name !== "" ? name : "unknown prototype"})`);
      return { keep: false };
    }
    return { keep: true, value: record(item as Record<string, unknown>, path, depth) };
  };
  // Built from entries, so an own `__proto__` key stays a key and never sets a prototype.
  const record = (item: Record<string, unknown>, path: string, depth: number): Record<string, unknown> => {
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(item)) {
      const entry = item[key];
      if (entry === undefined) {
        continue;
      }
      const kept = copy(entry, path === "" ? key : `${path}.${key}`, depth + 1);
      if (kept.keep) {
        entries.push([key, kept.value]);
      }
    }
    return Object.fromEntries(entries);
  };
  return { context: record(value as Record<string, unknown>, "", 1), problems };
}
