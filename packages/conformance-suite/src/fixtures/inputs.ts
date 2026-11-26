import type { Json } from "../observation.js";
import type { DefinitionBuilder } from "../vectors/schema.js";

/**
 * Building blocks the program-side vector packs (RES, OPT, FIL, CTX, CAN, SEC) share: answers for
 * the fixture form as the browser stores them (flat keys), hostile shapes, and edits of the
 * fixture's form root. Everything here is data or a pure function; nothing talks to a program.
 */

/** A valid submission of the fixture form in the flat key spelling the runtime stores (`addr.pick`, `rows[0].sku`). */
export function flatValid(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    name: "Ada Lovelace",
    code: "AB1234",
    "addr.city": "Ottawa",
    "addr.pick": "ok",
    tags: { x: true, y: false },
    "rows[0].sku": "s1",
    "rows[0].n": 1,
    ...overrides
  };
}

/** `flatValid` with some keys removed first (to replace a container or a list with another spelling). */
export function flatWithout(keys: string[], overrides: Record<string, Json> = {}): Record<string, Json> {
  const base = flatValid();
  for (const key of keys) {
    delete base[key];
  }
  return { ...base, ...overrides };
}

/** `[[[...]]]`, `depth` levels deep. */
export function nestedArray(depth: number): Json {
  let value: Json = [];
  for (let level = 1; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

/** `{ n: { n: ... leaf } }`, `depth` objects deep. */
export function nestedObject(depth: number, leaf: Json, key = "n"): Json {
  let value: Json = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = { [key]: value };
  }
  return value;
}

/** Parses JSON text so a `__proto__` key stays an own property, as a request body carries it. */
export const parsed = (text: string): Json => JSON.parse(text) as Json;

type Node = Record<string, unknown>;
const contentOf = (root: Node): Node[] => ((root["children"] as { content: Node[] }).content);

/** Appends components to the form root's content. */
export const addComponents =
  (...nodes: Node[]): DefinitionBuilder =>
  (root) => {
    contentOf(root).push(...nodes.map((node) => structuredClone(node)));
    return root;
  };

/** Merges keys into the form root's configuration. */
export const configure =
  (patch: Record<string, unknown>): DefinitionBuilder =>
  (root) => {
    root["configuration"] = { ...(root["configuration"] as Node), ...patch };
    return root;
  };

/** Applies builders in order. */
export const compose =
  (...builders: DefinitionBuilder[]): DefinitionBuilder =>
  (root) =>
    builders.reduce((current, build) => build(current), root);

export const textNode = (id: string, configuration: Node = {}, rules?: Node): Node => ({ id, type: "text", configuration, ...(rules !== undefined ? { rules } : {}) });

export const selectNode = (id: string, values: string[], configuration: Node = {}): Node => ({
  id,
  type: "select",
  configuration: { options: values.map((value) => ({ value, label: value })), ...configuration }
});

/** The fixture form's own rule shape for a formula run on the server only. */
export const secretRule = (formula: string): Node => ({ run: "server-secret", formula });

/** `count` data-scoping containers c0 > c1 > ... around `inner` (`count` 21 gives a 21-level shape). */
export function containerChain(count: number, inner: Node): Node {
  let node = inner;
  for (let level = count - 1; level >= 0; level -= 1) {
    node = { id: `c${level}`, type: "container", configuration: {}, children: { default: [node] } };
  }
  return node;
}

/** What a filler posts at the key `c0` of {@link containerChain}: `{ c1: { c2: ... { c<count-1>: leaf } } }`. */
export function containerPost(count: number, leaf: Json): Json {
  let value: Json = leaf;
  for (let level = count - 1; level >= 1; level -= 1) {
    value = { [`c${level}`]: value };
  }
  return value;
}
