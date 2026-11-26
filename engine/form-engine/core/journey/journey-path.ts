import type { ComponentNode } from "../schema/types.js";
import type { Expression } from "../expressions/expression.js";
import type { Journey, PresentationNode, PresentationReference } from "../schema/journey.js";
import type {
  JourneyDecision,
  JourneyOwnership,
  JourneyPathInput,
  JourneyPlacement,
  JourneyTrace
} from "./journey-types.js";
import {
  journeyCollectionPathOf,
  journeyHoldsOwnAnswer,
  journeyLeadingSegment,
  journeyOwn
} from "./journey-shared.js";

// The helpers every form needs live apart, so a bundle without journeys does not carry the
// path engine; they are re-exported here for importers of the path engine.
export { journeyCollectionPathOf, journeyHoldsOwnAnswer, journeyLeadingSegment, journeyOwn };

/**
 * The journey path engine: which pages a set of answers takes, and where each
 * component stands against that path.
 *
 * This module runs in two places from the same source, like the validation kernel
 * (`validation/wasm/portable-kernel.ts`): the browser runtime imports it, and the
 * sandbox program splices its functions' source in, so a server re-validating a submission
 * works out the same path the person took. Hence the kernel's rules here too: type-only
 * imports bar the shared helpers (`journey-shared.ts`), top-level `function`
 * declarations only, each referencing only the others and those helpers (all in
 * {@link JOURNEY_PATH_FUNCTIONS}) and standard globals, no module constants (the end target is
 * spelled `"$end"`, which is `JOURNEY_END`), and plain records rather than Maps.
 *
 * Every record here is keyed by ids and value keys that come from outside — an author's page
 * and component ids, a submission's keys — so an id such as `constructor`, `toString` or
 * `__proto__` must behave like any other. The records this module builds have no prototype
 * (`Object.create(null)`), and it reads records handed to it through {@link journeyOwn}: a
 * runtime's own records, or ones that crossed a JSON boundary, have `Object.prototype` again.
 *
 * **Presentations.** A page may hold nodes the presentation owns beside the form
 * component ids it lists: fields, texts and layouts of its own, an alias (`configuration.fills`),
 * a worked-out value (`journey-value`), and references to form components (`journey-field`).
 * What such a page *places* — which form fields count as asked on it — is decided here, once,
 * for the browser and the server alike, by static usability rules read from the definition
 * alone ({@link journeyOwnNodeUsable}, {@link journeyTargetUsable}, {@link journeyOwnership}).
 * A node that breaks one is ignored on both sides rather than refused: only a malformed shape
 * drops a journey. This module never reads an own node's `rules`, nor a worked-out value's
 * expression: those run in the browser only.
 *
 * It may call nothing outside its own list, which holds the shared helpers too. Where it needs a
 * reading another spliced module owns, it keeps a copy pinned by a test
 * ({@link journeyHoldsOwnAnswer}).
 */

/**
 * The tree a route's `when` holds once the definition is compiled: a tree as it is, or the
 * object form's `expression`. A formula string is no tree here: every runtime compiles the
 * definition before the path is worked out (`kernelCompileDefinition`,
 * `core/expressions/compile.ts`), which replaces each formula by its tree and drops one that
 * does not parse, so a string that still reaches the walk reads as a condition that does not
 * hold (the route is not taken), as a formula that failed to parse does. A
 * copy of the fold's `kernelCompiledRule` reading, since this module calls only its own.
 */
export function journeyRuleTree(source: unknown): Expression | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (typeof record.kind === "string") {
    return source as Expression;
  }
  const expression = record.expression;
  if (typeof expression === "object" && expression !== null && !Array.isArray(expression) && typeof (expression as Record<string, unknown>).kind === "string") {
    return expression as Expression;
  }
  return undefined;
}

/**
 * Who owns a value key: the pages of the component it names; else, for a repeating section's
 * entries or a data grid's rows, the pages of the section or grid whose collection path holds
 * them — the key itself, or its part before the first `[` (`order.items[0].sku` ->
 * `order.items`); else the pages of its leading segment's component. The id of a node a
 * presentation owns never places a key: its answers are not form values, and a
 * collection path or a leading segment spelled like one still belongs to the form.
 */
export function journeyPagesOfKey(ownership: JourneyOwnership, key: string): string[] | undefined {
  const ownNodes = ownership.ownNodes;
  const direct = journeyOwn(ownership.pagesOf, key);
  if (direct !== undefined && (ownNodes === undefined || journeyOwn(ownNodes, key) !== true)) {
    return direct;
  }
  const collections = ownership.collectionOwners;
  let sectionId = journeyOwn(collections, key);
  const bracket = key.indexOf("[");
  if (sectionId === undefined && bracket > 0) {
    sectionId = journeyOwn(collections, key.slice(0, bracket));
  }
  if (sectionId !== undefined) {
    return journeyOwn(ownership.pagesOf, sectionId);
  }
  const leading = journeyLeadingSegment(key);
  if (leading === key || (ownNodes !== undefined && journeyOwn(ownNodes, leading) === true)) {
    return undefined;
  }
  return journeyOwn(ownership.pagesOf, leading);
}

/**
 * The value keys the form under `root` defines that carry no entry index: the kernel's
 * allowlist (`kernelKnownKeyShapes`, `validation/wasm/portable-kernel.ts`) without the shapes
 * holding `[` or `]` — a field's value path, a data-scoping container's, a repeating section's
 * collection path (a data grid's among them). A copy, kept here because this
 * module calls nothing outside its own list; `engine/tests/journey-path.test.ts` holds the two
 * to one result. What rule I reads: the key an own answer lives under,
 * `@<presentation id>.<own id>`, never holds an index, so it can only meet one of these. The
 * record has no prototype. Walks with an explicit stack, however deep the form nests.
 */
export function journeyFormKeys(root: ComponentNode): Record<string, true> {
  const known = Object.create(null) as Record<string, true>;
  const stack: Array<{ node: ComponentNode; prefix: string; level: number }> = [];
  const top = root.children ? Object.keys(root.children) : [];
  for (const slot of top) {
    for (const child of (root.children as Record<string, ComponentNode[]>)[slot] ?? []) {
      stack.push({ node: child, prefix: "", level: 2 });
    }
  }
  while (stack.length > 0) {
    const item = stack.pop() as { node: ComponentNode; prefix: string; level: number };
    const node = item.node;
    const configuration = node.configuration;
    const settings: Record<string, unknown> =
      configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
    const collection = journeyCollectionPathOf(node);
    let childPrefix: string;
    if (collection !== undefined) {
      // One written with brackets defines nothing, nor anything under it.
      if (/[[\]]/.test(collection)) {
        continue;
      }
      known[collection] = true;
      // An entry's fields are keyed with an index; a section or a grid inside keeps its own path.
      childPrefix = collection + "[]";
    } else {
      const dataKey = settings.dataKey;
      const segment = typeof dataKey === "string" && /^[A-Za-z0-9_-]+$/.test(dataKey) && !/^\d+$/.test(dataKey) ? dataKey : node.id;
      const path = item.prefix.length > 0 ? item.prefix + "." + segment : segment;
      const scopes = node.type === "container" && settings.scopeData !== false;
      // The kernel's `kernelClaimsData`: a node with a place of its own in the data.
      if ((node.collection !== undefined || scopes || journeyHoldsOwnAnswer(node)) && !/[[\]]/.test(path)) {
        known[path] = true;
      }
      childPrefix = scopes ? path : item.prefix;
    }
    // Nothing below the deepest level a tree may nest is read (the root is level 1).
    const groups = node.children && item.level < journeyMaxDepth() ? Object.keys(node.children) : [];
    for (const slot of groups) {
      for (const child of (node.children as Record<string, ComponentNode[]>)[slot] ?? []) {
        stack.push({ node: child, prefix: childPrefix, level: item.level + 1 });
      }
    }
  }
  return known;
}

/**
 * The usability rule a presentation's own node breaks by itself, whatever it holds:
 * `"A"`, `"B"`, `"C"`, `"H"` or `"I"`, the first that applies, or `""` when it breaks none.
 *
 * - **A.** Its id follows the component-id grammar (`core/tree/component-id.ts`), is not the id
 *   of a form component (`formIds` holds each as an own key), and is not the id of an own node
 *   met earlier in the presentation (`seen`).
 * - **B.** Its type is not one a presentation cannot hold: a repeating section, a data grid, a
 *   file, a signature, a steps container or a step.
 * - **C.** It binds no data of its own: no `collection`, no `configuration.dataKey`, and it is
 *   not a data-scoping container (a `container` that does
 *   not say `scopeData: false`, the kernel's `kernelIsDataScopeContainer`).
 * - **H.** The presentation's own id (`presentationId`, the journey's) follows the component-id
 *   grammar too. So the keys own answers live under always start `@<presentation id>.` exactly,
 *   and no two presentations share them; a journey of component ids alone owns nothing, so a
 *   hand-written id outside the grammar keeps working there.
 * - **I.** A node holding an answer (not a worked-out value, which holds none) is not stored
 *   under a key the form defines: `@<presentation id>.<own id>` is none of `formKeys`
 *   ({@link journeyFormKeys}). An alias too — were its target unusable, its answer would live
 *   there. Otherwise an own answer would be a form value and leave the browser.
 *
 * The node's id is added to `seen` whatever the verdict — an id belongs to the first node that
 * carries it, usable or not — so the nodes of a presentation must be asked in its own order:
 * pages, then entries, then each entry's nodes. `seen` must have no prototype. Not for a
 * reference (`journey-field`), which is no node of the presentation's own.
 */
export function journeyOwnNodeRule(
  node: PresentationNode,
  formIds: Record<string, unknown>,
  seen: Record<string, true>,
  presentationId: string,
  formKeys: Record<string, true>
): "" | "A" | "B" | "C" | "H" | "I" {
  const id: unknown = node.id;
  let rule: "" | "A" | "B" | "C" | "H" | "I" = "";
  // The component-id grammar (core/tree/component-id.ts): `constructor` and `prototype` are reserved there too (the translations map cannot hold them).
  if (typeof id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) || id === "constructor" || id === "prototype" || journeyOwn(formIds, id) !== undefined || journeyOwn(seen, id) === true) {
    rule = "A";
  }
  if (typeof id === "string") {
    seen[id] = true;
  }
  if (rule !== "") {
    return rule;
  }
  if (["repeatingSection", "dataGrid", "file", "signature", "steps", "step", "wizard", "wizardStep"].indexOf(node.type) >= 0) {
    return "B";
  }
  const configuration = node.configuration;
  const settings: Record<string, unknown> =
    configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? configuration : {};
  if (
    (node as { collection?: unknown }).collection !== undefined ||
    settings.dataKey !== undefined ||
    (node.type === "container" && settings.scopeData !== false)
  ) {
    return "C";
  }
  if (typeof presentationId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(presentationId)) {
    return "H";
  }
  if (node.type !== "journey-value" && journeyHoldsOwnAnswer(node) && journeyOwn(formKeys, "@" + presentationId + "." + (id as string)) === true) {
    return "I";
  }
  return "";
}

/**
 * Whether a page's own entry can be used (rules A–C, H and I): the node and every own
 * node under it breaks none of them ({@link journeyOwnNodeRule}). One node that does drops the
 * whole entry, on both sides — the browser does not draw it and the server places nothing
 * through it — and the builder reports it. The references inside it (`journey-field`) are not
 * judged here: one that names no form component is skipped by itself (rule D).
 *
 * Every own id in the entry is added to `seen`, usable or not, so entries must be asked in the
 * presentation's order — pages, then entries — with one `seen` (no prototype) for the whole
 * presentation. `formIds` holds each form component id as an own key (a `nodeById` record),
 * `presentationId` is the journey's id and `formKeys` the form's keys ({@link journeyFormKeys}).
 * {@link journeyOwnership} asks exactly this, so a caller replaying it lands on the same
 * entries.
 */
export function journeyOwnNodeUsable(
  entry: PresentationNode,
  formIds: Record<string, unknown>,
  seen: Record<string, true>,
  presentationId: string,
  formKeys: Record<string, true>
): boolean {
  let usable = true;
  const stack: unknown[] = [entry];
  while (stack.length > 0) {
    const held = stack.pop() as PresentationNode | PresentationReference | null | undefined;
    if (held === null || typeof held !== "object" || held.type === "journey-field") {
      continue;
    }
    const node = held as PresentationNode;
    if (journeyOwnNodeRule(node, formIds, seen, presentationId, formKeys) !== "") {
      usable = false;
    }
    const children: unknown = node.children;
    if (children === null || typeof children !== "object") {
      continue;
    }
    for (const slot of Object.keys(children)) {
      const nodes: unknown = (children as Record<string, unknown>)[slot];
      if (Array.isArray(nodes)) {
        for (const child of nodes) {
          stack.push(child);
        }
      }
    }
  }
  return usable;
}

/**
 * The deepest a definition may nest components, counting the root as level 1: a copy of
 * `kernelMaxComponentDepth` (`core/expressions/compile.ts`), kept here because the path engine
 * calls nothing outside its own list; `engine/tests/journey-walk-depth.test.ts` holds the two to
 * one number. Every walk up or down the form's tree stops at it, so a tree that loops back on
 * itself, or nests past anything a run accepts, ends instead of walking forever.
 */
export function journeyMaxDepth(): number {
  return 32;
}

/**
 * Whether a form component can be the target of an alias (`configuration.fills`) or of a
 * worked-out value (`configuration.to`) — rule E: a value leaf of the form. It is a
 * component of the form other than the root, it holds an answer of its own
 * ({@link journeyHoldsOwnAnswer}: no group, section, grid, container or valueless type), it
 * sits in no repeating section and no data grid, and it is not calculated (`rules.value`: the
 * form works it out itself). `nodeById` and `parentOf` index the form's tree, as
 * `kernelTreeIndex` builds them (`validation/wasm/portable-kernel.ts`). With an unusable
 * target an alias is a plain own field and a worked-out value is ignored.
 */
export function journeyTargetUsable(
  targetId: string,
  nodeById: Record<string, ComponentNode>,
  parentOf: Record<string, string>,
  rootId: string
): boolean {
  const node = journeyOwn(nodeById, targetId);
  if (node === undefined || targetId === rootId || !journeyHoldsOwnAnswer(node)) {
    return false;
  }
  // By truthiness, as every rule is read: a hand-written `rules: null` is no rule.
  const rules = node.rules;
  if (rules && rules.value) {
    return false;
  }
  let parent = journeyOwn(parentOf, targetId);
  for (let step = 1; parent !== undefined && step < journeyMaxDepth(); step += 1) {
    const ancestor = journeyOwn(nodeById, parent);
    if (ancestor !== undefined && ancestor.collection !== undefined) {
      return false;
    }
    parent = journeyOwn(parentOf, parent);
  }
  // A chain that has not ended by the deepest a tree may nest loops: nothing to fill there.
  return parent === undefined;
}

/**
 * Whether an entry of a page's own places a form component: a reference
 * (`journey-field`), a node naming a field to fill (`configuration.fills`) or a worked-out value
 * (`journey-value`), anywhere in it. Read from the shape alone, whatever the usability rules make
 * of the target. A review page places no form component, so {@link journeyOwnership} drops such
 * an entry there whole, and the presentation index replays it. Walks with a stack of its own.
 */
export function journeyEntryPlacesForm(entry: PresentationNode): boolean {
  const stack: unknown[] = [entry];
  while (stack.length > 0) {
    const held = stack.pop();
    if (held === null || typeof held !== "object" || Array.isArray(held)) {
      continue;
    }
    const node = held as { type?: unknown; configuration?: unknown; children?: unknown };
    if (node.type === "journey-field" || node.type === "journey-value") {
      return true;
    }
    const configuration = node.configuration;
    if (configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)) {
      const fills = (configuration as Record<string, unknown>).fills;
      if (typeof fills === "string" && fills !== "") {
        return true;
      }
    }
    const children = node.children;
    if (children !== null && typeof children === "object") {
      for (const slot of Object.keys(children)) {
        const nodes: unknown = (children as Record<string, unknown>)[slot];
        if (Array.isArray(nodes)) {
          for (const child of nodes) {
            stack.push(child);
          }
        }
      }
    }
  }
  return false;
}

/**
 * Which pages own which components of the form under `root`.
 *
 * A string entry of a page is a form component, placed with its subtree, as ever. An object
 * entry is a node the presentation owns; what it places is decided by the usability
 * rules, read from the definition alone so the browser and the server place alike:
 *
 * - an own entry that breaks rule A, B, C, H or I anywhere in it is dropped whole
 *   ({@link journeyOwnNodeUsable}); otherwise it is a member of its page, and each of its own
 *   nodes stands on that page under its own id (`ownNodes`);
 * - a reference (`journey-field`) puts the form component it names, with its subtree, on the
 *   page — at the top of a page exactly as the component's id written as a string would; one
 *   naming no form component, or the root, is skipped by itself (rule D);
 * - an alias — an own node that holds a value itself (rule F) and whose `configuration.fills`
 *   names a usable target (rule E, {@link journeyTargetUsable}) — puts its target on the page
 *   (`aliasOf`); several aliases may fill one field, on branches that exclude each other, say;
 * - a worked-out value (`journey-value`) puts its target `configuration.to` on the page
 *   (`workedOutOf`) when the target is usable (rule E) and nothing else in the presentation
 *   places it — not listed, referenced or filled on any page, and not worked out by an earlier
 *   node (rule G); otherwise the node is ignored.
 *
 * An ancestor of anything placed that is on no page itself is structural. `order` stays the
 * form's own: no walker of it sees a presentation's node. The presentation records are attached only when a page holds an object
 * entry, so a journey of component ids alone has the ownership it always had.
 *
 * A review page (`kind: "review"`) places no form component: it lists the path's answers, it
 * does not ask them. Its string entries and references are skipped, and an own entry that
 * places a form field ({@link journeyEntryPlacesForm}) is dropped whole, after the usability
 * walk has seen its ids; what stays is content of the journey's own (a declaration). So its page
 * scope holds no form component on either side (`page.review-form-field` names each one).
 */
export function journeyOwnership(root: ComponentNode, journey: Journey): JourneyOwnership {
  const order: string[] = [];
  const parentOf = Object.create(null) as Record<string, string>;
  const nodeById = Object.create(null) as Record<string, ComponentNode>;
  const collectionOwners = Object.create(null) as Record<string, string>;
  const stack: ComponentNode[] = [root];
  // The level of each node on the stack (the root is 1); a node at the deepest level is not opened.
  const levels: number[] = [1];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    const level = levels.pop() as number;
    order.push(node.id);
    nodeById[node.id] = node;
    const collectionPath = node.id === root.id ? undefined : journeyCollectionPathOf(node);
    // Document order, first wins: two sections sharing a collection path is a hand-written slip.
    if (collectionPath !== undefined && journeyOwn(collectionOwners, collectionPath) === undefined) {
      collectionOwners[collectionPath] = node.id;
    }
    const children: ComponentNode[] = [];
    const groups = node.children && level < journeyMaxDepth() ? Object.keys(node.children).map((slot) => (node.children as Record<string, ComponentNode[]>)[slot]) : [];
    for (const group of groups) {
      for (const child of group ?? []) {
        parentOf[child.id] = node.id;
        children.push(child);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as ComponentNode);
      levels.push(level + 1);
    }
  }

  const pagesOf = Object.create(null) as Record<string, string[]>;
  const membersOf = Object.create(null) as Record<string, string[]>;
  const listed = Object.create(null) as Record<string, true>;

  /** Puts one id — a form leaf or an own node — on a page. */
  function placeId(id: string, pageId: string): void {
    const owners = pagesOf[id] ?? (pagesOf[id] = []);
    if (owners.indexOf(pageId) < 0) {
      owners.push(pageId);
    }
  }
  /** Puts a form component and its subtree on a page. */
  function placeSubtree(node: ComponentNode, pageId: string): void {
    const subtree: ComponentNode[] = [node];
    // Below the placed node, within what is left of the deepest level a tree may nest.
    const levels: number[] = [1];
    while (subtree.length > 0) {
      const current = subtree.pop() as ComponentNode;
      const level = levels.pop() as number;
      placeId(current.id, pageId);
      const groups = current.children && level < journeyMaxDepth() ? Object.keys(current.children).map((slot) => (current.children as Record<string, ComponentNode[]>)[slot]) : [];
      for (const group of groups) {
        for (const child of group ?? []) {
          subtree.push(child);
          levels.push(level + 1);
        }
      }
    }
  }
  /** A node's configuration as a record, whatever a hand-written one holds. */
  function settingsOf(node: { configuration?: unknown }): Record<string, unknown> {
    const configuration = node.configuration;
    return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
  }
  /** Rule D: the form component a reference names, when the form has it below the root. */
  function referenced(node: { configuration?: unknown }): string | undefined {
    const componentId = settingsOf(node).componentId;
    return typeof componentId === "string" && nodeById[componentId] !== undefined && componentId !== root.id ? componentId : undefined;
  }

  // What the presentation's own nodes place. Attached only when a page holds one.
  let presentation = false;
  const ownNodes = Object.create(null) as Record<string, true>;
  const aliasOf = Object.create(null) as Record<string, string>;
  const workedOutOf = Object.create(null) as Record<string, string>;
  const seen = Object.create(null) as Record<string, true>;
  /** The form's keys (rule I), read once the presentation holds an own entry. */
  let formKeys: Record<string, true> | undefined;
  /** Worked-out values, in the presentation's order: judged once every page has placed the rest (rule G). */
  const workedOut: Array<{ nodeId: string; to: unknown; pageId: string; members: string[] | undefined }> = [];

  for (const page of journey.pages) {
    const members: string[] = [];
    const review = page.kind === "review";
    for (const listedEntry of page.components ?? []) {
      if (typeof listedEntry !== "string" && (listedEntry === null || typeof listedEntry !== "object")) {
        // Neither an id nor a node: nothing the shape check lets through, and nothing to place.
        continue;
      }
      if (typeof listedEntry === "string" || listedEntry.type === "journey-field") {
        if (review) {
          // A review page asks nothing of the form: a reference still makes this a presentation.
          if (typeof listedEntry !== "string") {
            presentation = true;
          }
          continue;
        }
        // A form component, by its id or — at the top of a page — by a reference to it.
        let componentId: string | undefined;
        if (typeof listedEntry === "string") {
          componentId = listedEntry;
        } else {
          presentation = true;
          componentId = referenced(listedEntry);
        }
        const node = componentId !== undefined ? nodeById[componentId] : undefined;
        if (componentId === undefined || !node || componentId === root.id || members.indexOf(componentId) >= 0) {
          continue;
        }
        members.push(componentId);
        listed[componentId] = true;
        placeSubtree(node, page.id);
        continue;
      }

      const entry = listedEntry as PresentationNode;
      presentation = true;
      if (formKeys === undefined) {
        formKeys = journeyFormKeys(root);
      }
      if (!journeyOwnNodeUsable(entry, nodeById, seen, journey.id, formKeys)) {
        continue;
      }
      if (review && journeyEntryPlacesForm(entry)) {
        continue;
      }
      members.push(entry.id);
      const nodes: Array<PresentationNode | PresentationReference> = [entry];
      while (nodes.length > 0) {
        const node = nodes.pop() as PresentationNode | PresentationReference;
        if (node === null || typeof node !== "object") {
          continue;
        }
        if (node.type === "journey-field") {
          const componentId = referenced(node);
          if (componentId !== undefined) {
            listed[componentId] = true;
            placeSubtree(nodeById[componentId] as ComponentNode, page.id);
          }
          continue;
        }
        const own = node as PresentationNode;
        if (own.type === "journey-value") {
          workedOut.push({ nodeId: own.id, to: settingsOf(own).to, pageId: page.id, members: own === entry ? members : undefined });
          continue;
        }
        ownNodes[own.id] = true;
        placeId(own.id, page.id);
        const children: unknown = own.children;
        if (children !== undefined) {
          // A layout of the presentation's own: what it holds is placed, in document order.
          const held: Array<PresentationNode | PresentationReference> = [];
          if (children !== null && typeof children === "object") {
            for (const slot of Object.keys(children)) {
              const group: unknown = (children as Record<string, unknown>)[slot];
              if (Array.isArray(group)) {
                for (const child of group) {
                  held.push(child as PresentationNode | PresentationReference);
                }
              }
            }
          }
          for (let index = held.length - 1; index >= 0; index -= 1) {
            nodes.push(held[index] as PresentationNode | PresentationReference);
          }
          continue;
        }
        // Rules E and F: an alias is an own field holding a value that fills a usable target.
        const fills = settingsOf(own).fills;
        if (typeof fills === "string" && journeyHoldsOwnAnswer(own) && journeyTargetUsable(fills, nodeById, parentOf, root.id)) {
          aliasOf[own.id] = fills;
          listed[fills] = true;
          placeId(fills, page.id);
        }
        // Otherwise content of the presentation's own: a field kept in the browser, a text, a button.
      }
    }
    membersOf[page.id] = members;
  }

  // Rule G: a worked-out value sets its target only when nothing else in the presentation
  // places it; the first to claim a field places it, so a later one finds it taken.
  for (const candidate of workedOut) {
    const to = candidate.to;
    if (typeof to === "string" && journeyTargetUsable(to, nodeById, parentOf, root.id) && pagesOf[to] === undefined) {
      workedOutOf[candidate.nodeId] = to;
      ownNodes[candidate.nodeId] = true;
      placeId(candidate.nodeId, candidate.pageId);
      listed[to] = true;
      placeId(to, candidate.pageId);
    } else if (candidate.members !== undefined) {
      // Ignored, and the whole of its entry: the page does not draw it.
      const position = candidate.members.indexOf(candidate.nodeId);
      if (position >= 0) {
        candidate.members.splice(position, 1);
      }
    }
  }

  const structural = Object.create(null) as Record<string, true>;
  for (const componentId of Object.keys(listed)) {
    let parent = parentOf[componentId];
    for (let step = 1; parent !== undefined && step < journeyMaxDepth(); step += 1) {
      if (pagesOf[parent] === undefined) {
        structural[parent] = true;
      }
      parent = parentOf[parent];
    }
  }

  const ownership: JourneyOwnership = { rootId: root.id, order, pagesOf, membersOf, structural, collectionOwners };
  if (presentation) {
    ownership.ownNodes = ownNodes;
    ownership.aliasOf = aliasOf;
    ownership.workedOutOf = workedOutOf;
  }
  return ownership;
}

/**
 * The path a set of answers takes through `journey`: one forward walk. Every page the walk
 * reaches is on the path and is shown, even when nothing on it shows (no components, or all of
 * them hidden): passing a page by is a route its predecessor's author writes. A review page
 * ends the walk with a submit, as running off the end does; an exit page ends it with no
 * submit; a page has no condition of its own, so branching is its predecessors' routes.
 * Leaving a page, its routes are tried in order and the first that matches — a later page, or
 * `"$end"` — wins, else the walk falls through to the next page. Routes only go forward, so the
 * walk always ends. A route to an earlier or unknown page is passed over.
 */
export function journeyPath(journey: Journey, input: JourneyPathInput): JourneyTrace {
  const pages = journey.pages;
  const indexOf = Object.create(null) as Record<string, number>;
  pages.forEach((page, index) => {
    if (indexOf[page.id] === undefined) {
      indexOf[page.id] = index;
    }
  });

  // The prefix view: what a condition may read. Answers of components on no page from the
  // start; a page's own answers once the page is on the path.
  const view = Object.create(null) as Record<string, unknown>;
  const pending = Object.create(null) as Record<string, true>;
  // Page id -> the pending keys it owns, asked once per key here so taking a page moves only its
  // own keys (the walk was pages x keys: a journey at the page caps outran the sandbox budget).
  const keysOfPage = Object.create(null) as Record<string, string[]>;
  for (const key of Object.keys(input.values)) {
    const owners = journeyPagesOfKey(input.ownership, key);
    if (owners === undefined || owners.length === 0) {
      view[key] = input.values[key];
    } else {
      pending[key] = true;
      for (const owner of owners) {
        const held = keysOfPage[owner] ?? (keysOfPage[owner] = []);
        held.push(key);
      }
    }
  }

  const path: string[] = [];
  const decisions: JourneyDecision[] = [];
  let end: "end" | "exit" = "end";
  let index = 0;
  while (index < pages.length) {
    const page = pages[index] as (typeof pages)[number];
    const isExit = page.kind === "exit";
    const isReview = page.kind === "review";
    path.push(page.id);
    for (const key of keysOfPage[page.id] ?? []) {
      if (pending[key] === true) {
        view[key] = input.values[key];
        delete pending[key];
      }
    }
    if (isExit) {
      end = "exit";
      break;
    }
    if (isReview) {
      // The last page before the end: its routes, and any page after it, are never taken.
      decisions.push({ kind: "next", pageId: page.id, to: "$end" });
      break;
    }

    let next = index + 1;
    let routed = false;
    const routes = page.routes ?? [];
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex] as (typeof routes)[number];
      const target = route.to === "$end" ? pages.length : indexOf[route.to];
      if (target === undefined || target <= index) {
        continue;
      }
      if (route.when !== undefined) {
        const routeWhen = journeyRuleTree(route.when);
        if (routeWhen === undefined || input.evaluate(routeWhen, view) !== true) {
          continue;
        }
      }
      decisions.push({ kind: "route", pageId: page.id, routeIndex, to: route.to });
      next = target;
      routed = true;
      break;
    }
    if (!routed) {
      const fallsTo = pages[next];
      decisions.push({ kind: "next", pageId: page.id, to: fallsTo ? fallsTo.id : "$end" });
    }
    index = next;
  }

  return { pages: path, end, decisions };
}

/**
 * Where each node stands against a path: `"on"` (on a page the path takes), `"off"` (only on
 * pages it skips) or `"unassigned"` (on no page). The root and the ancestors of listed
 * components that no page lists are left out: they are never folded.
 */
export function journeyPlacements(ownership: JourneyOwnership, trace: JourneyTrace): Record<string, JourneyPlacement> {
  const onPath = Object.create(null) as Record<string, true>;
  for (const pageId of trace.pages) {
    onPath[pageId] = true;
  }
  const placements = Object.create(null) as Record<string, JourneyPlacement>;
  for (const componentId of ownership.order) {
    if (componentId === ownership.rootId) {
      continue;
    }
    const owners = journeyOwn(ownership.pagesOf, componentId);
    if (owners !== undefined && owners.length > 0) {
      let on = false;
      for (const pageId of owners) {
        if (onPath[pageId]) {
          on = true;
          break;
        }
      }
      placements[componentId] = on ? "on" : "off";
    } else if (journeyOwn(ownership.structural, componentId) !== true) {
      placements[componentId] = "unassigned";
    }
  }
  return placements;
}

/** Component id -> the earliest page on the path holding it. */
export function journeyPageOfComponent(ownership: JourneyOwnership, trace: JourneyTrace): Record<string, string> {
  const position = Object.create(null) as Record<string, number>;
  trace.pages.forEach((pageId, index) => {
    position[pageId] = index;
  });
  const out = Object.create(null) as Record<string, string>;
  for (const componentId of Object.keys(ownership.pagesOf)) {
    let best: string | undefined;
    let bestIndex = -1;
    for (const pageId of journeyOwn(ownership.pagesOf, componentId) ?? []) {
      const at = position[pageId];
      if (at !== undefined && (bestIndex < 0 || at < bestIndex)) {
        best = pageId;
        bestIndex = at;
      }
    }
    if (best !== undefined) {
      out[componentId] = best;
    }
  }
  return out;
}

/** The first page on the path not completed — the furthest a person may go — else the last. */
export function journeyFrontier(trace: JourneyTrace, completed: readonly string[]): string | undefined {
  for (const pageId of trace.pages) {
    if (completed.indexOf(pageId) < 0) {
      return pageId;
    }
  }
  return trace.pages.length > 0 ? trace.pages[trace.pages.length - 1] : undefined;
}

/** Whether `pageId` is on the path at or before the frontier. */
export function journeyReachable(trace: JourneyTrace, completed: readonly string[], pageId: string): boolean {
  const at = trace.pages.indexOf(pageId);
  if (at < 0) {
    return false;
  }
  const frontier = journeyFrontier(trace, completed);
  const frontierAt = frontier === undefined ? -1 : trace.pages.indexOf(frontier);
  return at <= frontierAt;
}

/**
 * Every way out of every page, ignoring conditions: the fall-through to the next page and each
 * forward route; a review page's one way out is the end. What a diagnostic or a flow map reads.
 */
export function journeyStaticGraph(journey: Journey): {
  pages: string[];
  edges: Array<{ from: string; to: string; kind: "next" | "route"; routeIndex?: number; conditional: boolean }>;
} {
  const pages = journey.pages.map((page) => page.id);
  const indexOf = Object.create(null) as Record<string, number>;
  pages.forEach((pageId, index) => {
    if (indexOf[pageId] === undefined) {
      indexOf[pageId] = index;
    }
  });
  const edges: Array<{ from: string; to: string; kind: "next" | "route"; routeIndex?: number; conditional: boolean }> = [];
  journey.pages.forEach((page, index) => {
    if (page.kind === "exit") {
      return;
    }
    if (page.kind === "review") {
      // The walk ends at a review page: its one way out is the end.
      edges.push({ from: page.id, to: "$end", kind: "next", conditional: false });
      return;
    }
    const routes = page.routes ?? [];
    let unconditional = false;
    routes.forEach((route, routeIndex) => {
      const target = route.to === "$end" ? pages.length : indexOf[route.to];
      if (target === undefined || target <= index || unconditional) {
        return;
      }
      edges.push({ from: page.id, to: route.to, kind: "route", routeIndex, conditional: route.when !== undefined });
      if (route.when === undefined) {
        unconditional = true;
      }
    });
    if (!unconditional) {
      const next = journey.pages[index + 1];
      edges.push({ from: page.id, to: next ? next.id : "$end", kind: "next", conditional: false });
    }
  });
  return { pages, edges };
}

/**
 * The path engine's functions, for the sandbox program to splice in beside the kernel's
 * (`PORTABLE_KERNEL_FUNCTIONS`). Every function above must be here, and so must the shared
 * helpers this module re-exports (`journey-shared.ts`), in the places they always held.
 */
export const JOURNEY_PATH_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  journeyOwn,
  journeyMaxDepth,
  journeyRuleTree,
  journeyLeadingSegment,
  journeyCollectionPathOf,
  journeyPagesOfKey,
  journeyHoldsOwnAnswer,
  journeyFormKeys,
  journeyOwnNodeRule,
  journeyOwnNodeUsable,
  journeyTargetUsable,
  journeyEntryPlacesForm,
  journeyOwnership,
  journeyPath,
  journeyPlacements,
  journeyPageOfComponent,
  journeyFrontier,
  journeyReachable,
  journeyStaticGraph
];
