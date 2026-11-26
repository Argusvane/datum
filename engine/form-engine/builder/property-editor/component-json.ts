/**
 * The inspector's JSON view of one component, as text the author edits. The view
 * shows exactly what applying it changes — the component's id, its type (which cannot change)
 * and the two blocks a draft holds, `configuration` and `rules` — and leaves out what a draft
 * cannot hold: the children, which are edited on the canvas, and a repeating section's
 * `collection`. Pasting a whole node from elsewhere still applies when what it carries beyond
 * that matches the component as it is; anything else is said under the box, with the line
 * and column where it can be placed.
 */
import type { ComponentNode, ComponentRules } from "../../core/schema/types.js";
import { isPrototypeName } from "../../core/tree/prototype-names.js";
import { componentIdProblem, isReservedComponentId } from "../../core/tree/component-id.js";
import { isRuleSourceShape } from "./rules-model.js";

/** What the box can say is wrong with its text, and where (1-based) when there is a place to point at. */
export interface ComponentJsonProblem {
  message: string;
  /** Character offset in the text the problem is at. */
  offset?: number;
  line?: number;
  column?: number;
}

/** The parts of a component the JSON edits, read from the text. */
export interface ComponentJsonValue {
  id: string;
  configuration: Record<string, unknown>;
  rules: ComponentRules | undefined;
}

export type ComponentJsonRead = { ok: true; value: ComponentJsonValue } | { ok: false; problem: ComponentJsonProblem };

export interface ComponentJsonReadOptions {
  /** Whether the id may change from here: not on the root, nor where the tree's owner shows it read-only. */
  idEditable: boolean;
  /** The plugin functions the host wired, so a tree calling one is a valid rule; absent: built-ins only. */
  knownFunctions?: Iterable<string> | undefined;
  /**
   * The property paths the site manages (`managed-settings`): a text that changes one is refused
   * in the words an assistant's write gets. A path under `rules` reads the rules; any other, the
   * configuration. Absent: none.
   */
  managed?: readonly string[] | undefined;
}

/** The value at the dotted `path` of `target`, own keys only; `undefined` when a step is missing. */
function valueAt(target: unknown, path: string): unknown {
  let cursor: unknown = target;
  for (const part of path.split(".")) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

/** What a read means for the draft: the configuration keys to set and to remove, the rules, the id. */
export interface ComponentJsonChanges {
  /** A new id, when the text names another one. */
  id: string | undefined;
  set: Array<{ key: string; value: unknown }>;
  remove: string[];
  /** The rules to draft, when they differ (`value` undefined: no rules). */
  rules: { value: ComponentRules | undefined } | undefined;
}

const SHOWN_KEYS = ["id", "type", "configuration", "rules"] as const;
/** Keys a pasted node may carry that the view does not show: accepted while they say what the component already has. */
const FIXED_KEYS = ["children", "collection"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The text the JSON view shows for `node` (its draft applied): id, type, configuration, then rules when it has any. */
export function componentJsonText(node: ComponentNode): string {
  const shown: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    configuration: isPlainObject(node.configuration) ? node.configuration : {}
  };
  if (node.rules && Object.keys(node.rules).length > 0) {
    shown.rules = node.rules;
  }
  return JSON.stringify(shown, null, 2);
}

/** Line and column (1-based) of `offset` in `text`. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1] ?? "").length + 1 };
}

function placed(text: string, message: string, offset: number | undefined): ComponentJsonProblem {
  return offset === undefined ? { message } : { message, offset, ...lineColumnAt(text, offset) };
}

/** Where a top-level key is written, for a shape problem about it: its first `"key":` in the text. */
function keyOffset(text: string, key: string): number | undefined {
  const pattern = new RegExp(`${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const match = pattern.exec(text);
  return match ? match.index : undefined;
}

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message);
  }
}

/**
 * Where JSON that `JSON.parse` refused first goes wrong, and why, in the builder's words. The
 * browsers' own messages differ (and Safari's names no place at all), so the text is walked
 * here, only once a parse has failed.
 */
export function locateJsonSyntaxError(text: string): { message: string; offset: number } | undefined {
  let at = 0;
  const space = (): void => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) {
      at += 1;
    }
  };
  const fail = (message: string, offset = at): never => {
    throw new JsonSyntaxError(message, offset);
  };
  const expectEnd = (): void => {
    if (at >= text.length) {
      fail("The JSON ends too soon: something is not closed.");
    }
  };
  const string = (): void => {
    const start = at;
    at += 1;
    for (;;) {
      if (at >= text.length) {
        fail("This text is never closed: a double quote is missing.", start);
      }
      const char = text.charAt(at);
      if (char === '"') {
        at += 1;
        return;
      }
      if (char === "\n" || char.charCodeAt(0) < 0x20) {
        fail("Text in quotes cannot run onto a new line; write \\n instead.");
      }
      if (char === "\\") {
        const next = text.charAt(at + 1);
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
            fail("A \\u escape needs four hex digits.");
          }
          at += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(next) || next === "") {
          fail(`"\\${next}" is not an escape JSON knows.`);
        }
        at += 2;
        continue;
      }
      at += 1;
    }
  };
  const value = (): void => {
    space();
    expectEnd();
    const char = text.charAt(at);
    if (char === "{") {
      at += 1;
      space();
      if (text.charAt(at) === "}") {
        at += 1;
        return;
      }
      for (;;) {
        space();
        expectEnd();
        if (text.charAt(at) !== '"') {
          fail(text.charAt(at) === "}" ? "A comma cannot come before }." : "Expected a key in double quotes.");
        }
        string();
        space();
        expectEnd();
        if (text.charAt(at) !== ":") {
          fail("Expected a colon after the key.");
        }
        at += 1;
        value();
        space();
        expectEnd();
        if (text.charAt(at) === ",") {
          at += 1;
          continue;
        }
        if (text.charAt(at) === "}") {
          at += 1;
          return;
        }
        fail("Expected a comma or }.");
      }
    }
    if (char === "[") {
      at += 1;
      space();
      if (text.charAt(at) === "]") {
        at += 1;
        return;
      }
      for (;;) {
        space();
        if (text.charAt(at) === "]") {
          fail("A comma cannot come before ].");
        }
        value();
        space();
        expectEnd();
        if (text.charAt(at) === ",") {
          at += 1;
          continue;
        }
        if (text.charAt(at) === "]") {
          at += 1;
          return;
        }
        fail("Expected a comma or ].");
      }
    }
    if (char === '"') {
      string();
      return;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      number.lastIndex = at;
      const match = number.exec(text);
      if (!match) {
        fail("Not a number JSON can read.");
      }
      at += match![0].length;
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return;
      }
    }
    fail(char === "'" ? "Text needs double quotes, not single ones." : `Unexpected "${char}".`);
  };
  try {
    space();
    if (at >= text.length) {
      fail("The box is empty: it needs the component's JSON.");
    }
    value();
    space();
    if (at < text.length) {
      fail("Unexpected text after the JSON: there is one object to write.");
    }
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return { message: error.message, offset: error.offset };
    }
    throw error;
  }
  return undefined;
}

/**
 * Reads the JSON box's text against `node` — the component as drafted. A text that does not
 * parse, or parses to something that is not this component's JSON, is a problem; anything else
 * is the id, configuration and rules to draft.
 */
export function readComponentJson(text: string, node: ComponentNode, options: ComponentJsonReadOptions): ComponentJsonRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const located = locateJsonSyntaxError(text);
    return {
      ok: false,
      problem: located
        ? placed(text, located.message, located.offset)
        : { message: error instanceof Error ? error.message : "The JSON does not parse." }
    };
  }
  const refuse = (message: string, key?: string): ComponentJsonRead => ({
    ok: false,
    problem: placed(text, message, key !== undefined ? keyOffset(text, key) : undefined)
  });
  if (!isPlainObject(parsed)) {
    return refuse('The JSON must be one object: { "id": …, "type": …, "configuration": { … } }.');
  }
  for (const key of Object.keys(parsed)) {
    if ((SHOWN_KEYS as readonly string[]).includes(key) || (FIXED_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    return refuse(`"${key}" is not part of a component, which has "id", "type", "configuration" and "rules". A setting goes inside "configuration".`, key);
  }
  if (!("id" in parsed)) {
    return refuse('The component needs an "id".');
  }
  if (typeof parsed.id !== "string") {
    return refuse('"id" must be text in double quotes.', "id");
  }
  if (parsed.id !== node.id && !options.idEditable) {
    return refuse(`The ID cannot change here: it stays "${node.id}".`, "id");
  }
  // A reserved word is refused here, at the key, in the words the id box uses for it.
  if (parsed.id !== node.id && isReservedComponentId(parsed.id)) {
    return refuse(componentIdProblem(parsed.id)!, "id");
  }
  if ("type" in parsed && parsed.type !== node.type) {
    return refuse(`The type cannot change: this component is a "${node.type}". Add a new component of the other type instead.`, "type");
  }
  if (!isPlainObject(parsed.configuration)) {
    return refuse(
      "configuration" in parsed
        ? '"configuration" must be an object (it can be empty: {}).'
        : 'The component needs a "configuration" object (it can be empty: {}).',
      "configuration"
    );
  }
  for (const key of Object.keys(parsed.configuration)) {
    // A draft is written key by key, and a dot would be read as a path into a nested block.
    // ...and a name every object has would set the draft's prototype, not a setting.
    if (key.includes(".") || key.trim() === "" || isPrototypeName(key)) {
      return refuse(`"${key}" cannot be a configuration key here.`, key);
    }
  }
  if ("children" in parsed && !same(parsed.children, node.children)) {
    return refuse('"children" cannot be applied here: children are edited on the canvas. Take it out to apply the rest.', "children");
  }
  if ("collection" in parsed && !same(parsed.collection, node.collection)) {
    return refuse('"collection" cannot change here. Take it out to apply the rest.', "collection");
  }
  let rules: ComponentRules | undefined;
  if ("rules" in parsed && parsed.rules !== null) {
    if (!isPlainObject(parsed.rules)) {
      return refuse('"rules" must be an object, one formula or expression per rule.', "rules");
    }
    const current = (node.rules ?? {}) as Record<string, unknown>;
    for (const [key, rule] of Object.entries(parsed.rules)) {
      if (isPrototypeName(key)) {
        return refuse(`"${key}" cannot be a rule name: it is a name every object has.`, key);
      }
      // Only a rule the text changes is checked: one the component already carries applies as it is.
      // A rule is a formula string, an expression tree, or the object form { formula | expression, run }.
      if (rule !== null && !same(rule, current[key]) && !isRuleSourceShape(rule, options.knownFunctions)) {
        return refuse(`The rule "${key}" is not a valid expression: a formula string, a tree where every node has a known "kind", or { "formula", "run" }.`, key);
      }
    }
    const kept = Object.fromEntries(Object.entries(parsed.rules).filter(([, rule]) => rule !== null && rule !== undefined));
    rules = Object.keys(kept).length > 0 ? (kept as ComponentRules) : undefined;
  }
  // A setting the site manages stays as it is: the text may carry it unchanged, never change it.
  const nextRules = "rules" in parsed ? rules : node.rules;
  for (const path of options.managed ?? []) {
    const underRules = path === "rules" || path.startsWith("rules.");
    const before = underRules ? valueAt({ rules: node.rules }, path) : valueAt(node.configuration, path);
    const after = underRules ? valueAt({ rules: nextRules }, path) : valueAt(parsed.configuration, path);
    if (!same(before ?? null, after ?? null)) {
      return refuse(`${path} is managed by the site; nothing was written.`, path.split(".").pop());
    }
  }
  return { ok: true, value: { id: parsed.id, configuration: parsed.configuration, rules } };
}

/** What drafting `next` over `node` (as drafted) takes: only what differs. */
export function componentJsonChanges(node: ComponentNode, next: ComponentJsonValue): ComponentJsonChanges {
  const current = isPlainObject(node.configuration) ? node.configuration : {};
  const set = Object.entries(next.configuration)
    .filter(([key, value]) => !(key in current) || !same(current[key], value))
    .map(([key, value]) => ({ key, value: structuredClone(value) }));
  const remove = Object.keys(current).filter((key) => current[key] !== undefined && !(key in next.configuration));
  const rulesBefore = node.rules && Object.keys(node.rules).length > 0 ? node.rules : undefined;
  return {
    id: next.id !== node.id ? next.id : undefined,
    set,
    remove,
    rules: same(rulesBefore, next.rules) ? undefined : { value: next.rules ? structuredClone(next.rules) : undefined }
  };
}

/** Whether `changes` changes anything at all. */
export function hasComponentJsonChanges(changes: ComponentJsonChanges): boolean {
  return changes.id !== undefined || changes.set.length > 0 || changes.remove.length > 0 || changes.rules !== undefined;
}
