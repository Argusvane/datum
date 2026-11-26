import { kernelContainerBase, kernelEngineKind, kernelIsEngineType, kernelIsKindBase, kernelKindBase } from "../core/schema/component-kinds.js";
import type { ComponentNode } from "../core/schema/types.js";

/**
 * The kind registry: what every component type is, as plain data. An engine type is its own
 * base; any other type (a plugin's, a design-system binding's tier-2 type such as `gcds-date`)
 * is read as the engine type the definition's `kinds` map gives it (`FormDefinition.kinds`).
 * Every reading that used to switch on a literal type — validation, the kernel, the agent's
 * field kinds, the PDF — asks {@link kindOf} (or, in sandbox-shaped code, `kernelKindBase` in
 * `core/schema/component-kinds.ts`, which holds the type table this module reads), so a mapped
 * type is checked, filled and printed as its base without its plugin's code.
 *
 * A type mapped to a container base (`gcds-tabs`, base `tabs`) is drawn as that container and
 * read as itself everywhere else: {@link containerBaseOf} is the drawing's reading, and only for a
 * component that holds children (`core/schema/component-kinds.ts` says why).
 *
 * Nothing here is sandbox-unsafe: it is data and pure functions over it.
 */

/**
 * How a component's answer reads: the vocabulary the agent tools describe a field by, and the
 * one drawing capabilities are declared per. `group` is a container's, `collection` a
 * repeating section's or a data grid's.
 */
export type FieldKind = "text" | "number" | "date" | "boolean" | "choice" | "multichoice" | "collection" | "file" | "signature" | "group";

/** What a component type is, by {@link kindOf}. */
export interface KindEntry {
  /** The type as written on the component. */
  type: string;
  /** The engine type it is read as: `type` itself for an engine type, else its base in the definition's `kinds` map. */
  base: string;
  /** How its answer reads; absent for a type that holds no answer (a button, static HTML, an image). */
  kind?: FieldKind;
}

/**
 * The entry for `type`: its base engine type and that base's kind, through the definition's
 * `kinds` map (read tolerantly: an entry whose base is not an engine type maps nothing).
 * `undefined` for a type that is neither an engine type nor mapped (an unknown type).
 */
export function kindOf(type: string, kinds?: Readonly<Record<string, string>> | undefined): KindEntry | undefined {
  const base = kernelKindBase(type, kinds);
  const kind = kernelEngineKind(base);
  if (kind === undefined) {
    return undefined;
  }
  return kind === "" ? { type, base } : { type, base, kind: kind as FieldKind };
}

/** The engine type `type`'s answer is read as: its answer base in the definition's `kinds` map, else itself. */
export function baseTypeOf(type: string, kinds?: Readonly<Record<string, string>> | undefined): string {
  return kernelKindBase(type, kinds);
}

/**
 * The engine container a component of `type` holding children is drawn as: its container base in
 * the definition's `kinds` map (`fieldset`, `panel`, `tabs`), else itself. Asked only of a
 * component that holds children; a leaf is read by {@link baseTypeOf}.
 */
export function containerBaseOf(type: string, kinds?: Readonly<Record<string, string>> | undefined): string {
  return kernelContainerBase(type, kinds);
}

/**
 * The engine type a component is drawn as: its container base when it holds children and the
 * map gives it one ({@link containerBaseOf}), else its answer base ({@link baseTypeOf}).
 */
export function drawnBaseOf(node: Pick<ComponentNode, "type" | "children">, kinds?: Readonly<Record<string, string>> | undefined): string {
  const answer = kernelKindBase(node.type, kinds);
  return answer === node.type && node.children !== undefined ? kernelContainerBase(node.type, kinds) : answer;
}

/**
 * `root` with every component whose type the definition's `kinds` map gives a base read as that
 * base (`type` replaced, everything else shared): for a reader that switches on types
 * throughout, such as the PDF model, which then prints a `gcds-date` as a date and a
 * `gcds-tabs` holding children as tabs. The tree handed in is never changed, and comes back as
 * it is when the map renames nothing in it.
 */
export function withBaseTypes(root: ComponentNode, kinds: Readonly<Record<string, string>> | undefined): ComponentNode {
  if (kinds === undefined || kinds === null || typeof kinds !== "object" || Object.keys(kinds).length === 0) {
    return root;
  }
  const rewrite = (node: ComponentNode): ComponentNode => {
    const base = typeof node.type === "string" ? drawnBaseOf(node, kinds) : node.type;
    let children: Record<string, ComponentNode[]> | undefined;
    if (node.children !== undefined && node.children !== null && typeof node.children === "object") {
      for (const slot of Object.keys(node.children)) {
        const group = node.children[slot];
        if (!Array.isArray(group)) {
          continue;
        }
        const next = group.map((child) => (child !== null && typeof child === "object" ? rewrite(child) : child));
        if (next.some((child, index) => child !== group[index])) {
          children ??= { ...node.children };
          children[slot] = next;
        }
      }
    }
    if (base === node.type && children === undefined) {
      return node;
    }
    return { ...node, type: base, ...(children !== undefined ? { children } : {}) };
  };
  return rewrite(root);
}

/**
 * The bases the types a host offers read as, from the sources in order (the first that names a
 * usable base for a type wins): each a map of type to base, such as a plugin's component
 * definitions' `base` and a binding's own `kinds`. An engine type and a base the definition's map
 * may not hold (`kernelIsKindBase`) are left out.
 */
export function offeredKinds(...sources: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (source === undefined || source === null || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const [type, base] of Object.entries(source)) {
      if (Object.prototype.hasOwnProperty.call(out, type) || kernelIsEngineType(type) || typeof base !== "string" || !kernelIsKindBase(base)) {
        continue;
      }
      // Defined, not assigned: a type named `__proto__` is an entry, not a prototype.
      Object.defineProperty(out, type, { value: base, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/**
 * The `base` each component definition declares, by type: a source for {@link offeredKinds} (a
 * plugin's or a binding's tier-2 type, such as `gcds-date` with base `date`). A definition with no
 * string `base` gives no entry, and the first definition of a type wins.
 */
export function basesOf(definitions: ReadonlyArray<{ readonly type: string; readonly base?: unknown }> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const definition of definitions ?? []) {
    if (definition !== null && typeof definition === "object" && typeof definition.type === "string" && typeof definition.base === "string" && !Object.prototype.hasOwnProperty.call(out, definition.type)) {
      // Defined, not assigned: a type named `__proto__` is an entry, not a prototype.
      Object.defineProperty(out, definition.type, { value: definition.base, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/** Every type `root`'s tree uses, in tree order, each once. */
function typesUsed(root: ComponentNode): string[] {
  const seen = new Set<string>();
  const visit = (node: ComponentNode, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 256) {
      return;
    }
    if (typeof node.type === "string") {
      seen.add(node.type);
    }
    const children = node.children;
    if (children !== undefined && children !== null && typeof children === "object") {
      for (const slot of Object.keys(children)) {
        const group = children[slot];
        if (Array.isArray(group)) {
          for (const child of group) {
            visit(child, depth + 1);
          }
        }
      }
    }
  };
  visit(root, 0);
  return [...seen];
}

/**
 * The `kinds` map a definition saves for `root`: an entry for every type the tree uses
 * that is not an engine type, its base from `offered` (what the host's plugins and bindings say
 * the type reads as, {@link offeredKinds}), else the entry `current` (the map the definition was
 * loaded with) already gives it. Entries for types the tree no longer uses are dropped, and so is
 * a base the map may not hold. `undefined` when no entry is left. `current` itself when the map
 * comes out the same, so a definition read back unedited is the one given.
 */
export function definitionKindsFor(
  root: ComponentNode,
  offered: Readonly<Record<string, string>> | undefined,
  current?: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const held = current !== undefined && current !== null && typeof current === "object" && !Array.isArray(current) ? current : undefined;
  for (const type of typesUsed(root)) {
    if (kernelIsEngineType(type)) {
      continue;
    }
    const fromOffer = offered !== undefined && Object.prototype.hasOwnProperty.call(offered, type) ? offered[type] : undefined;
    const fromCurrent = held !== undefined && Object.prototype.hasOwnProperty.call(held, type) ? held[type] : undefined;
    const base = typeof fromOffer === "string" && kernelIsKindBase(fromOffer) ? fromOffer : typeof fromCurrent === "string" && kernelIsKindBase(fromCurrent) ? fromCurrent : undefined;
    if (base !== undefined) {
      Object.defineProperty(out, type, { value: base, enumerable: true, writable: true, configurable: true });
    }
  }
  const keys = Object.keys(out);
  if (keys.length === 0) {
    return undefined;
  }
  if (held !== undefined) {
    const heldKeys = Object.keys(held);
    if (heldKeys.length === keys.length && heldKeys.every((type) => out[type] === held[type])) {
      return held as Record<string, string>;
    }
  }
  return out;
}
