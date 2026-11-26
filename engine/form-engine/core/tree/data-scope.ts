import type { ComponentNode } from "../schema/types.js";
import { BUTTON_COMPONENT_TYPE } from "../schema/button.js";
import { HTML_COMPONENT_TYPE } from "../schema/static-html.js";
import { IMAGE_COMPONENT_TYPE } from "../schema/image.js";
import { SIGNATURE_COMPONENT_TYPE } from "../schema/signature.js";
import { DATA_GRID_COMPONENT_TYPE } from "../schema/data-grid.js";

/**
 * Where a component's answer lives in the data: data-scoping containers, data keys and
 * repeating sections.
 *
 * Everywhere else in the engine a component's value is stored under its own id, flat —
 * `values["email"]`. Two things change that:
 *
 * - A `container` makes its id a level in the data for its subtree: a field `email` inside a
 *   container `applicant` is stored under the key `"applicant.email"`.
 * - A data key (`configuration.dataKey`) sets a node's own segment apart from its
 *   id: a field `billing_street` keyed `street` inside a container keyed `billing` is stored
 *   under `"billing.street"`. Unset, the segment is the id, exactly as before.
 *
 * The runtime's state and a submission's `values` are a **flat map keyed by value path**:
 * `{ "applicant.email": "a@b.co", "items[0].sku": "A1" }`. The nested document that map
 * describes — `{ applicant: { email } }` — is what a reader (or the builder's Data workspace) sees,
 * not what is submitted.
 *
 * Two identifiers are deliberately kept apart, and it is worth being explicit about which is
 * which:
 *
 * - The **component id** is what an author addresses — a rule's `visibleWhen`, an error's
 *   `componentId`, the builder's selection, the input's DOM id. It stays flat and unique
 *   across the form.
 * - The **value path** is where the datum lives. Only this nests, and only this a data key
 *   renames.
 *
 * Keeping rules on component ids is what makes a container or a key a *data* decision rather
 * than a refactor: dropping a field into one changes the shape of the submission without
 * rewriting every rule that mentions it.
 */

export const DATA_CONTAINER_COMPONENT_TYPE = "container";

/** Where a node's own data segment is set: `configuration.dataKey`. */
export const DATA_KEY_PROPERTY = "dataKey";

/** The path-segment grammar (`core/tree/component-path.ts`), which a data key must fit. */
const DATA_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALL_DIGITS = /^\d+$/;

/** Types that carry no answer: nothing is stored for them, so they claim no place in the data. */
const VALUELESS_TYPES: ReadonlySet<string> = new Set([
  BUTTON_COMPONENT_TYPE,
  HTML_COMPONENT_TYPE,
  IMAGE_COMPONENT_TYPE,
  SIGNATURE_COMPONENT_TYPE
]);

/**
 * Types that group other components. A node with a `children` map is a group whatever its
 * type; these are groups even when a hand-written tree leaves the map out. A data grid is one: its children are the template of a row, and its rows are a collection like any
 * repeating section's, so nothing here reads it apart from its `collection` binding.
 */
const GROUP_TYPES: ReadonlySet<string> = new Set([
  "form",
  "fieldset",
  "panel",
  "grid",
  "tabs",
  "tab",
  "steps",
  "step",
  "repeatingSection",
  DATA_GRID_COMPONENT_TYPE,
  DATA_CONTAINER_COMPONENT_TYPE
]);

function configurationRecord(node: ComponentNode): Record<string, unknown> | undefined {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : undefined;
}

function join(prefix: string, segment: string): string {
  return prefix.length > 0 ? `${prefix}.${segment}` : segment;
}

/**
 * Whether a node nests its descendants' values under its own segment. Set
 * `configuration.scopeData: false` on a `container` to keep it purely visual — a grouping box
 * that leaves the data flat.
 */
export function isDataScopeContainer(node: ComponentNode): boolean {
  if (node.type !== DATA_CONTAINER_COMPONENT_TYPE) {
    return false;
  }
  const configuration = configurationRecord(node);
  if (!configuration) {
    return true;
  }
  return configuration.scopeData !== false;
}

/**
 * Whether `value` may be a data key: the path-segment grammar (letters, digits, `_`, `-`) and
 * not digits alone — an all-digit key reads as a list position to JSON Pointer and to most
 * path tools.
 */
export function isValidDataKey(value: unknown): value is string {
  return typeof value === "string" && DATA_KEY_PATTERN.test(value) && !ALL_DIGITS.test(value) && value !== "__proto__";
}

/**
 * Why `value` cannot be a data key, in words for the builder; `undefined` when it can, and
 * when no key is set at all (unset, `""`), since the id is then the segment.
 */
export function dataKeyProblemOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return "A data key must be text.";
  }
  if (ALL_DIGITS.test(value)) {
    return "A data key cannot be digits alone: it would read as a position in a list.";
  }
  if (!DATA_KEY_PATTERN.test(value)) {
    return "Use letters, digits, _ or - only: no spaces, dots or brackets.";
  }
  // The kernel refuses the name too: a key spelled so would set a record's prototype, not a value.
  if (value === "__proto__") {
    return "The name __proto__ is not allowed as a data key or a path.";
  }
  return undefined;
}

/** The node's own segment in the data: its valid data key, else its id. */
export function dataKeyOf(node: ComponentNode): string {
  const key = configurationRecord(node)?.[DATA_KEY_PROPERTY];
  return isValidDataKey(key) ? key : node.id;
}

/**
 * Where a repeating section's entries live: `collection.collectionPath` as written (not
 * prefixed by any container above it), else the node's id; `undefined` for a node that is not
 * a repeating section. The runtime, the PDF and the sandbox all read entries here.
 */
export function collectionPathOf(node: ComponentNode): string | undefined {
  const binding = node.collection;
  if (!binding) {
    return undefined;
  }
  const configured = binding.collectionPath;
  return typeof configured === "string" && configured.length > 0 ? configured : node.id;
}

/** Whether a node groups other components: a `children` map, or one of the grouping types. Exported for the agent catalogue's `kindOf`, which must never copy the list. */
export function isGroupNode(node: ComponentNode): boolean {
  return node.children !== undefined || GROUP_TYPES.has(node.type);
}

/**
 * Value path per component id: the node's own segment (its data key, else its id), prefixed by
 * the segment of every data-scoping container above it. A form with no `container` and no key
 * in it produces an identity map, which is why every existing form is unaffected.
 *
 * Repeating sections add no level here: this is the path a field's own control reads and
 * writes. Where a section's *entries* live is {@link collectionPathOf}; a field's place within
 * an entry is {@link buildRowKeys}; the two together are {@link buildDataPaths}.
 */
export function buildValuePaths(root: ComponentNode): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (node: ComponentNode, prefix: string): void => {
    const path = join(prefix, dataKeyOf(node));
    paths.set(node.id, path);
    // The container contributes its own segment as the next prefix; anything else passes its
    // own prefix straight through, so a `fieldset` inside a container does not add a level.
    const childPrefix = isDataScopeContainer(node) ? path : prefix;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  };
  // The form root is not itself a level in the data.
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }
  paths.set(root.id, root.id);
  return paths;
}

/**
 * Where each component's data sits in the document the form describes, with `[]` marking a
 * repeating section's entries: `billing.street`, `items` (the section), `items[].sku` (a
 * field of each entry). A section's entries live at its collection path as written, wherever
 * the section sits — a section nested in another one included, as the runtime keeps them.
 */
export function buildDataPaths(root: ComponentNode): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (node: ComponentNode, prefix: string): void => {
    const collection = collectionPathOf(node);
    let childPrefix: string;
    if (collection !== undefined) {
      paths.set(node.id, collection);
      childPrefix = `${collection}[]`;
    } else {
      const path = join(prefix, dataKeyOf(node));
      paths.set(node.id, path);
      childPrefix = isDataScopeContainer(node) ? path : prefix;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  };
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }
  paths.set(root.id, root.id);
  return paths;
}

/**
 * Each component's key within an entry of the repeating section it sits in — its data key
 * (else its id), under any data-scoping container inside the entry (`address.city`). Only
 * components inside a section are listed; a section nested in another one is a list of its
 * own (the runtime keeps its entries at its own collection path), so it is not a key of the
 * outer entry, and its fields are keyed relative to it.
 */
export function buildRowKeys(root: ComponentNode): Map<string, string> {
  const keys = new Map<string, string>();
  const walk = (node: ComponentNode, rowPrefix: string | null): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (collectionPathOf(child) !== undefined) {
          walk(child, "");
          continue;
        }
        let nextPrefix = rowPrefix;
        if (rowPrefix !== null) {
          const key = join(rowPrefix, dataKeyOf(child));
          keys.set(child.id, key);
          nextPrefix = isDataScopeContainer(child) ? key : rowPrefix;
        }
        walk(child, nextPrefix);
      }
    }
  };
  walk(root, collectionPathOf(root) !== undefined ? "" : null);
  return keys;
}

/**
 * The repeating section whose entry each component's rules read as `row.` (the collection path
 * of the innermost section it sits in), for every component inside a section. A section nested
 * in another one reads the row it sits in, not its own: its own entries are what its fields read.
 */
export function buildRowCollections(root: ComponentNode): Map<string, string> {
  const rows = new Map<string, string>();
  const walk = (node: ComponentNode, row: string | undefined): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (row !== undefined) {
          rows.set(child.id, row);
        }
        walk(child, collectionPathOf(child) ?? row);
      }
    }
  };
  walk(root, collectionPathOf(root));
  return rows;
}

/**
 * Whether a node claims a place in the data: a value-bearing field, a data-scoping container
 * or a repeating section (a data grid is one, through its `collection`). The root,
 * grouping containers and components that carry no answer (a button, static HTML, an image, a
 * signature's participants) claim none.
 */
function claimsData(node: ComponentNode, isValueless: (node: ComponentNode) => boolean): boolean {
  if (node.collection !== undefined || isDataScopeContainer(node)) {
    return true;
  }
  if (isGroupNode(node)) {
    return false;
  }
  return !isValueless(node);
}

function defaultIsValueless(node: ComponentNode): boolean {
  return VALUELESS_TYPES.has(node.type);
}

/**
 * Whether a node has a place of its own in the data — an answer, an object (a data-scoping
 * container), a list of entries (a repeating section, a data grid) — as opposed to grouping
 * others (a fieldset, a panel, the form root) or carrying no answer at all (a button, static
 * HTML, an image). `isValueless` says which leaves carry none; the default knows the engine's.
 */
export function holdsData(node: ComponentNode, options: { isValueless?: (node: ComponentNode) => boolean } = {}): boolean {
  return claimsData(node, options.isValueless ?? defaultIsValueless);
}

/**
 * Value path -> the ids of the components whose answer is stored there, in document order.
 * Normally one id per path; two only where a hand-written definition gives two components
 * one place (see {@link findDataKeyProblems}), and then both see the value.
 */
export function buildComponentIdsByPath(
  root: ComponentNode,
  options: { isValueless?: (node: ComponentNode) => boolean } = {}
): Map<string, string[]> {
  const isValueless = options.isValueless ?? defaultIsValueless;
  const paths = buildValuePaths(root);
  const byPath = new Map<string, string[]>();
  const visit = (node: ComponentNode): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (claimsData(child, isValueless)) {
          const path = paths.get(child.id) ?? child.id;
          const owners = byPath.get(path);
          if (owners) {
            owners.push(child.id);
          } else {
            byPath.set(path, [child.id]);
          }
        }
        visit(child);
      }
    }
  };
  visit(root);
  return byPath;
}

/**
 * Re-keys a path-keyed value map by component id, for rule evaluation: a rule says
 * `visibleWhen: billing_street` and reads the answer stored at `billing.street`. Keys no
 * component owns (collection rows, host extras) pass through first; owned values are laid over
 * them, so a component's own answer wins over a stray key that happens to match its id.
 */
export function valuesByComponentId(
  values: Record<string, unknown>,
  idsByPath: ReadonlyMap<string, readonly string[]>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const owned: Array<[readonly string[], unknown]> = [];
  for (const [key, value] of Object.entries(values)) {
    const ids = idsByPath.get(key);
    if (ids && ids.length > 0) {
      owned.push([ids, value]);
    } else {
      out[key] = value;
    }
  }
  for (const [ids, value] of owned) {
    for (const id of ids) {
      out[id] = value;
    }
  }
  return out;
}

/** A place in the data two components cannot both take, or a key that cannot be used. */
export interface DataKeyProblem {
  code: "invalid-key" | "duplicate-path" | "path-conflict";
  /** Where the problem is, as {@link buildDataPaths} writes it (`billing.street`, `items[].sku`). */
  path: string;
  /** The components involved, in document order. */
  componentIds: string[];
  /** The problem in words, for the builder. */
  message: string;
}

type SlotKind = "value" | "object" | "array";

interface DataSlot {
  path: string;
  kind: SlotKind;
  componentId: string;
}

/**
 * Everything wrong with where a form's answers would be stored:
 *
 * - `invalid-key`: a data key that is set but unusable (the id is used instead);
 * - `duplicate-path`: two components storing at one place. Two data-scoping containers may
 *   share a place — their fields merge into one object, so an object can be split across
 *   tabs — but a field, a section or a grid may not share with anything;
 * - `path-conflict`: a place nested under one that cannot hold it — a field under another
 *   field, `a.b` under a list `a`, `a[]` under an object `a`.
 *
 * `isValueless` says which leaves carry no answer; the default knows the engine's own
 * (button, html, image, signature). A builder with a registry passes a test of its own.
 */
export function findDataKeyProblems(
  root: ComponentNode,
  options: { isValueless?: (node: ComponentNode) => boolean } = {}
): DataKeyProblem[] {
  const isValueless = options.isValueless ?? defaultIsValueless;
  const problems: DataKeyProblem[] = [];
  const slots: DataSlot[] = [];

  const walk = (node: ComponentNode, prefix: string): void => {
    const rawKey = configurationRecord(node)?.[DATA_KEY_PROPERTY];
    const keyProblem = dataKeyProblemOf(rawKey);
    const collection = collectionPathOf(node);
    let childPrefix = prefix;
    let ownPath: string;
    if (collection !== undefined) {
      ownPath = collection;
      slots.push({ path: collection, kind: "array", componentId: node.id });
      childPrefix = `${collection}[]`;
    } else {
      ownPath = join(prefix, dataKeyOf(node));
      if (isDataScopeContainer(node)) {
        slots.push({ path: ownPath, kind: "object", componentId: node.id });
        childPrefix = ownPath;
      } else if (claimsData(node, isValueless)) {
        slots.push({ path: ownPath, kind: "value", componentId: node.id });
      }
    }
    if (keyProblem !== undefined) {
      problems.push({
        code: "invalid-key",
        path: ownPath,
        componentIds: [node.id],
        message: `The data key of ${node.id} cannot be used, so its id is used instead. ${keyProblem}`
      });
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  };
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }

  const byPath = new Map<string, DataSlot[]>();
  for (const slot of slots) {
    const list = byPath.get(slot.path);
    if (list) {
      list.push(slot);
    } else {
      byPath.set(slot.path, [slot]);
    }
  }

  const duplicated = new Set<string>();
  for (const [path, list] of byPath) {
    if (list.length > 1 && list.some((slot) => slot.kind !== "object")) {
      duplicated.add(path);
      const ids = list.map((slot) => slot.componentId);
      problems.push({
        code: "duplicate-path",
        path,
        componentIds: ids,
        message: `${ids.join(" and ")} would store their answers in one place, ${path}. Give one of them another data key.`
      });
    }
  }

  // A slot nested under another: find each slot's nearest claimed ancestor place.
  for (const slot of slots) {
    for (let index = slot.path.length - 1; index > 0; index -= 1) {
      const char = slot.path[index];
      if (char !== "." && char !== "[") {
        continue;
      }
      const parentPath = slot.path.slice(0, index);
      const parents = byPath.get(parentPath);
      if (!parents) {
        continue;
      }
      if (duplicated.has(parentPath)) {
        // The place above is already reported as shared; what sits under it follows from that.
        break;
      }
      const nestedAs: SlotKind = char === "." ? "object" : "array";
      const clash = parents.find((parent) => parent.kind !== nestedAs);
      if (clash) {
        const why =
          clash.kind === "value"
            ? `${clash.componentId} stores a single answer at ${parentPath}`
            : clash.kind === "array"
              ? `${clash.componentId} stores a list of entries at ${parentPath}`
              : `${clash.componentId} stores an object at ${parentPath}`;
        problems.push({
          code: "path-conflict",
          path: slot.path,
          componentIds: [clash.componentId, slot.componentId],
          message: `${slot.componentId} cannot be stored at ${slot.path}: ${why}.`
        });
      }
      break;
    }
  }

  return problems;
}

/**
 * Resolves value paths for a tree, with the identity fallback that keeps every caller honest:
 * a component the map has not seen (added since the map was built, or addressed by a host that
 * never had one) reads and writes under its own id, exactly as before.
 */
export function createValuePathResolver(root: ComponentNode): (componentId: string) => string {
  const paths = buildValuePaths(root);
  return (componentId) => paths.get(componentId) ?? componentId;
}

/** Whether a tree contains any data-scoping container at all. */
export function hasDataScopes(root: ComponentNode): boolean {
  if (isDataScopeContainer(root)) {
    return true;
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      if (hasDataScopes(child)) {
        return true;
      }
    }
  }
  return false;
}
