import type { Expression, RuleSource } from "../expressions/expression.js";
import { kernelIsExpressionTree, kernelRuleExpression } from "../expressions/compile.js";
import { kernelParseFormula } from "../expressions/formula.js";
import { formulaFunctionSignatures } from "../expressions/function-table.js";
import type { Journey, PresentationNode, PresentationReference } from "../schema/journey.js";
import type { ComponentNode, ComponentRules } from "../schema/types.js";
import { ComponentTree } from "../tree/component-tree.js";
import { buildValuePaths } from "../tree/data-scope.js";
import { journeyEntryPlacesForm, journeyFormKeys, journeyHoldsOwnAnswer, journeyMaxDepth, journeyOwn, journeyOwnNodeUsable } from "./journey-path.js";
import type { JourneyOwnership } from "./journey-types.js";
export { workedOutTextOwner } from "./worked-out-text.js";

/**
 * The presentation index: the nodes a running presentation — a journey, one page or
 * many — owns, as the **browser** runtime reads them. Built once per journey, beside its
 * ownership, from the definition alone.
 *
 * Browser only. Nothing here is spliced into the sandbox program: a server never reads an own
 * node's rules, a worked-out value's expression, or a key an own answer lives under. What a
 * page *places* — the one thing both sides must agree on — is the ownership's
 * (`journeyOwnership`, `journey-path.ts`), and this module reads that result rather than
 * deciding again: it replays the ownership's own usability walk (`journeyOwnNodeUsable`, in the
 * presentation's order) and takes the aliases and worked-out values from its records.
 *
 * Where the answers live:
 * - an **alias** (`configuration.fills`, in `ownership.aliasOf`) reads and writes the value
 *   path of the form field it fills: there is no second copy;
 * - a **worked-out value** (`journey-value`, in `ownership.workedOutOf`) holds no answer: the
 *   runtime writes the form field it works out, and the page draws a read-only copy of it;
 * - every other own field is stored at `@<presentation id>.<field id>` — a key the form
 *   pipeline never sees ({@link isPresentationKey}).
 */

/** What every key of a presentation's own answers starts with. No form id or data key can. */
export const PRESENTATION_KEY_PREFIX = "@";

/**
 * The slot of the combined render root that holds the presentation's container
 * (`FormRuntime.journeyRenderRoot`): the last one, after the form's own, so everything that
 * reads a root's first slot still reads the form's.
 */
export const PRESENTATION_SLOT = "@presentation";

/**
 * Whether a value key is a presentation's own answer: it starts with `@` and the
 * form does not define it (`defines`: the sandbox's allowlist, `kernelDefinesKey`). Such a key
 * is kept in the state and in drafts and never reaches the form pipeline — calculations, the
 * fold, validation, the sandbox, the envelope. A hand-written form that does define an
 * `@`-key (a collection path written so, say) keeps it: it is a form value like any other.
 */
export function isPresentationKey(key: string, defines: (key: string) => boolean): boolean {
  return key.startsWith(PRESENTATION_KEY_PREFIX) && !defines(key);
}

/**
 * The id of a presentation's synthetic container, and so the first segment of its own answers'
 * keys: `@<presentation id>`, exactly. A presentation whose id is outside the component-id
 * grammar owns nothing (rule H, `journeyOwnNodeRule`): its container stays empty and no key is
 * ever built under it, so no two presentations share a key space.
 */
export function presentationContainerId(presentationId: string): string {
  return PRESENTATION_KEY_PREFIX + presentationId;
}

/** What a node of the presentation's container is to the runtime. */
export type PresentationNodeKind =
  /** An own field whose answer lives at its `@` key. */
  | "field"
  /** An own field that fills a form field. */
  | "alias"
  /** The read-only copy of the form field a worked-out value sets. */
  | "worked-out"
  /** The placeholder of a reference to a form component, inside an own layout. */
  | "reference"
  /** An own layout: a node with children. */
  | "layout"
  /** Own content that holds no answer: a paragraph, an image, a button. */
  | "content";

/** An own field that fills a form field. */
export interface PresentationAlias {
  nodeId: string;
  targetId: string;
  /** The form field's value path: where the alias reads and writes. */
  targetPath: string;
  pageId: string;
}

/** A worked-out value in use. */
export interface PresentationWorkedOut {
  nodeId: string;
  targetId: string;
  /** The form field's value path: where the runtime writes the result. */
  targetPath: string;
  /** `configuration.value`: evaluated in the browser only, over the sources by id. */
  expression: Expression;
  /**
   * What the expression may read: the own value fields on the node's page, in the page's order —
   * plain own fields and aliases (which read the form field they fill), never another
   * worked-out value.
   */
  sourceIds: string[];
  pageId: string;
}

/** A reference to a form component inside an own layout, as its placeholder in the container. */
export interface PresentationReferencePlaceholder {
  /** `@<presentation id>/ref-<n>`, numbered from 1 in the presentation's order. */
  id: string;
  /** The form component to draw in its place. */
  componentId: string;
  pageId: string;
}

export interface PresentationIndex {
  presentationId: string;
  /** `@<presentation id>`: the synthetic container's id, and the prefix of the own answers' keys. */
  containerId: string;
  /**
   * The synthetic, data-scoping `container` holding the presentation's usable own entries, in
   * the presentation's order (pages, then entries): each own node as a component, a
   * `journey-value` as a read-only copy of its target, each usable reference as a placeholder.
   */
  container: ComponentNode;
  /**
   * A root of type `form` — carrying the form root's id — whose one slot
   * ({@link PRESENTATION_SLOT}) holds {@link container}, so the tree's own path builder gives
   * `@<presentation id>.<id>` for every own node. What {@link tree} is built over.
   */
  root: ComponentNode;
  tree: ComponentTree;
  /** Every node of the container, in document order: own nodes and reference placeholders. */
  order: string[];
  /** No prototype, like every record here: keyed by ids an author chose. */
  nodeById: Record<string, ComponentNode>;
  /** Node id -> the own node that holds it; absent for a page's top-level entry. */
  parentOf: Record<string, string>;
  /** Node id -> the page it stands on. */
  pageOf: Record<string, string>;
  kindOf: Record<string, PresentationNodeKind>;
  /** Own field id -> its `@` key, for the fields of kind `"field"`. */
  ownKeys: Record<string, string>;
  /** Alias id -> what it fills. */
  aliasOf: Record<string, PresentationAlias>;
  /** The aliases, in the presentation's order. */
  aliases: PresentationAlias[];
  /** Worked-out node id -> what it works out. */
  workedOutOf: Record<string, PresentationWorkedOut>;
  /** The worked-out values in use, in the presentation's order. */
  workedOut: PresentationWorkedOut[];
  /** Placeholder id -> the reference it stands for. */
  referenceOf: Record<string, PresentationReferencePlaceholder>;
  /**
   * The nodes that are, or contain, an alias, a reference or a worked-out value: their own
   * visibility is never read — hiding one would hide a form field the server still asks for.
   */
  mapped: Record<string, true>;
  /**
   * Page id -> the form components the page draws itself: the ones it lists or references, with
   * their subtrees. A form field that is only filled or worked out on a page is not among them.
   */
  drawnOf: Record<string, Record<string, true>>;
  /**
   * Where a node's answer is stored: an alias and a worked-out copy at the form field's value
   * path, any other own field at its `@` key. `undefined` for a node that holds no answer
   * (a layout, a paragraph, a placeholder) and for an id the presentation does not own.
   */
  keyOf(id: string): string | undefined;
  /** The own field of kind `"field"` whose answer is stored at `key`. */
  idOfKey(key: string): string | undefined;
  /** {@link isPresentationKey} with the form's `defines`. */
  isPresentationKey(key: string): boolean;
}

function settingsOf(node: { configuration?: unknown }): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

/**
 * Whether `value` reads as a rule source: what a worked-out value's `configuration.value` must
 * be. A formula string, an expression tree, or the object form (`RuleSource`); the shape only.
 */
function isExpression(value: unknown): value is RuleSource {
  if (typeof value === "string") {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" || typeof record.formula === "string" || kernelIsExpressionTree(record.expression);
}

/**
 * The tree a worked-out value's `configuration.value` stands for. A journey the runtime reads
 * is compiled first (`FormRuntime.journeys`), so this is a tree or the object form's
 * `expression`; a formula that still reaches here is parsed against the built-in functions
 * (a plugin function is unknown at this point, which makes such a formula unusable here, as a
 * formula that does not parse is: the worked-out value is dropped like one with no target).
 */
function ruleTreeOf(value: unknown): Expression | undefined {
  return kernelRuleExpression(value, kernelParseFormula, formulaFunctionSignatures());
}

/** The configuration keys a worked-out value's copy does not take from its target: where it is stored and how it behaves hidden are the target's alone. */
const COPY_DROPS: readonly string[] = [
  "dataKey",
  "hidden",
  "hiddenValueBehavior",
  "hiddenValidationBehavior",
  "hiddenRequiredBehavior",
  "required",
  "disabled",
  "fills"
];

/**
 * The index of a journey's own nodes, or `undefined` for a journey that holds none — one of
 * component ids alone (`ownership.ownNodes` absent), which runs exactly as it always did.
 *
 * `root` is the form's tree, `ownership` the journey's (`journeyOwnership(root, journey)`), and
 * `defines` says whether the form defines a value key (`kernelDefinesKey` over
 * `kernelKnownKeyShapes`).
 */
export function buildPresentationIndex(
  root: ComponentNode,
  journey: Journey,
  ownership: JourneyOwnership,
  defines: (key: string) => boolean
): PresentationIndex | undefined {
  const ownNodes = ownership.ownNodes;
  if (ownNodes === undefined) {
    return undefined;
  }
  const aliasTargets = ownership.aliasOf ?? (Object.create(null) as Record<string, string>);
  const workedOutTargets = ownership.workedOutOf ?? (Object.create(null) as Record<string, string>);

  // The form's tree, by id, and where each of its components is stored.
  const formById = Object.create(null) as Record<string, ComponentNode>;
  const formStack: ComponentNode[] = [root];
  // Each walk down the form stops at the deepest level a tree may nest (the root is level 1), so
  // a tree that holds itself ends.
  const formLevels: number[] = [1];
  while (formStack.length > 0) {
    const node = formStack.pop() as ComponentNode;
    const level = formLevels.pop() as number;
    formById[node.id] = node;
    if (level >= journeyMaxDepth()) {
      continue;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group ?? []) {
        formStack.push(child);
        formLevels.push(level + 1);
      }
    }
  }
  const formPaths = buildValuePaths(root);
  const pathOfTarget = (targetId: string): string => formPaths.get(targetId) ?? targetId;

  const containerId = presentationContainerId(journey.id);
  const order: string[] = [];
  const nodeById = Object.create(null) as Record<string, ComponentNode>;
  const parentOf = Object.create(null) as Record<string, string>;
  const pageOf = Object.create(null) as Record<string, string>;
  const kindOf = Object.create(null) as Record<string, PresentationNodeKind>;
  const ownKeys = Object.create(null) as Record<string, string>;
  const idsByKey = Object.create(null) as Record<string, string>;
  const aliasOf = Object.create(null) as Record<string, PresentationAlias>;
  const aliases: PresentationAlias[] = [];
  const workedOutOf = Object.create(null) as Record<string, PresentationWorkedOut>;
  const workedOut: PresentationWorkedOut[] = [];
  const referenceOf = Object.create(null) as Record<string, PresentationReferencePlaceholder>;
  const mapped = Object.create(null) as Record<string, true>;
  const drawnOf = Object.create(null) as Record<string, Record<string, true>>;
  /** Page id -> its own value fields (plain fields and aliases), in order: what a worked-out value may read. */
  const sourcesOf = Object.create(null) as Record<string, string[]>;
  const entries: ComponentNode[] = [];
  let references = 0;

  /** Rule D, as the ownership reads it: the form component a reference names, below the root. */
  const referenced = (node: { configuration?: unknown }): string | undefined => {
    const componentId = settingsOf(node).componentId;
    return typeof componentId === "string" && formById[componentId] !== undefined && componentId !== root.id ? componentId : undefined;
  };
  const markDrawn = (pageId: string, componentId: string): void => {
    const drawn = drawnOf[pageId] ?? (drawnOf[pageId] = Object.create(null) as Record<string, true>);
    const stack: ComponentNode[] = [formById[componentId] as ComponentNode];
    // Below the referenced component, within what is left of the deepest level a tree may nest.
    const levels: number[] = [1];
    while (stack.length > 0) {
      const node = stack.pop() as ComponentNode;
      const level = levels.pop() as number;
      drawn[node.id] = true;
      if (level >= journeyMaxDepth()) {
        continue;
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group ?? []) {
          stack.push(child);
          levels.push(level + 1);
        }
      }
    }
  };
  const register = (node: ComponentNode, kind: PresentationNodeKind, pageId: string, parentId: string | undefined): void => {
    order.push(node.id);
    nodeById[node.id] = node;
    pageOf[node.id] = pageId;
    kindOf[node.id] = kind;
    if (parentId !== undefined) {
      parentOf[node.id] = parentId;
    }
  };

  /** An own layout being built: its slots so far, and where the walk stands in its children. */
  interface OpenLayout {
    node: ComponentNode;
    id: string;
    children: Record<string, unknown>;
    slotNames: string[];
    slot: number;
    child: number;
    drawn: ComponentNode[];
    /** No prototype: a slot is named by its author, and may be called `__proto__`. */
    slots: Record<string, ComponentNode[]>;
    holdsMapped: boolean;
  }
  const open: OpenLayout[] = [];
  /** What {@link visit} answers for a layout: its children are walked next, on {@link open}. */
  const OPENED = "opened" as const;

  /**
   * One node of a usable entry as a component; `undefined` for what the page does not draw (a
   * reference naming no form component, a worked-out value the ownership ignores). Returns
   * whether the node is, or holds, something mapped to the form. A layout is registered here and
   * left open ({@link OPENED}): {@link synthesize} walks its children.
   */
  const visit = (
    held: PresentationNode | PresentationReference,
    pageId: string,
    parentId: string | undefined
  ): { node: ComponentNode; mapped: boolean } | typeof OPENED | undefined => {
    if (held === null || typeof held !== "object") {
      return undefined;
    }
    if (held.type === "journey-field") {
      const componentId = referenced(held);
      if (componentId === undefined) {
        return undefined;
      }
      references += 1;
      const placeholder: PresentationReferencePlaceholder = { id: `${containerId}/ref-${references}`, componentId, pageId };
      const node: ComponentNode = { id: placeholder.id, type: "journey-field", configuration: { componentId } };
      referenceOf[placeholder.id] = placeholder;
      register(node, "reference", pageId, parentId);
      markDrawn(pageId, componentId);
      mapped[node.id] = true;
      return { node, mapped: true };
    }
    const own = held as PresentationNode;
    const settings = settingsOf(own);
    if (own.type === "journey-value") {
      const targetId = journeyOwn(workedOutTargets, own.id);
      const target = targetId !== undefined ? formById[targetId] : undefined;
      const expression = isExpression(settings.value) ? ruleTreeOf(settings.value) : undefined;
      if (targetId === undefined || target === undefined || expression === undefined) {
        return undefined;
      }
      // A read-only copy of the form field: its type and everything that says how it is drawn
      // (options, a number's bounds, its help), under the node's own label when it has one.
      const configuration: Record<string, unknown> = { ...settingsOf(target) };
      for (const key of COPY_DROPS) {
        delete configuration[key];
      }
      if (settings.label !== undefined) {
        configuration.label = settings.label;
      }
      configuration.readOnly = true;
      // `inheritsLabel` says the label is the target's own words, so the copy words it at the
      // target's address (workedOutTextOwner); an authored label stays the node's.
      configuration.presentation =
        settings.label !== undefined ? { kind: "worked-out", to: targetId } : { kind: "worked-out", to: targetId, inheritsLabel: true };
      const node: ComponentNode = { id: own.id, type: target.type, configuration };
      const record: PresentationWorkedOut = { nodeId: own.id, targetId, targetPath: pathOfTarget(targetId), expression, sourceIds: [], pageId };
      workedOutOf[own.id] = record;
      workedOut.push(record);
      register(node, "worked-out", pageId, parentId);
      mapped[node.id] = true;
      return { node, mapped: true };
    }

    const node: ComponentNode = { id: own.id, type: own.type, configuration: own.configuration ?? {} };
    // By truthiness, as every rule is read: a hand-written `rules: null` is no rule.
    if (own.rules) {
      node.rules = own.rules as ComponentRules;
    }
    const children: unknown = own.children;
    if (children !== undefined) {
      register(node, "layout", pageId, parentId);
      const record = children !== null && typeof children === "object" ? (children as Record<string, unknown>) : {};
      open.push({
        node,
        id: own.id,
        children: record,
        slotNames: Object.keys(record),
        slot: 0,
        child: 0,
        drawn: [],
        slots: Object.create(null) as Record<string, ComponentNode[]>,
        holdsMapped: false
      });
      return OPENED;
    }

    const targetId = journeyOwn(aliasTargets, own.id);
    if (targetId !== undefined) {
      const alias: PresentationAlias = { nodeId: own.id, targetId, targetPath: pathOfTarget(targetId), pageId };
      aliasOf[own.id] = alias;
      aliases.push(alias);
      register(node, "alias", pageId, parentId);
      (sourcesOf[pageId] ?? (sourcesOf[pageId] = [])).push(own.id);
      mapped[own.id] = true;
      return { node, mapped: true };
    }
    if (journeyHoldsOwnAnswer(own)) {
      const key = `${containerId}.${own.id}`;
      ownKeys[own.id] = key;
      idsByKey[key] = own.id;
      register(node, "field", pageId, parentId);
      (sourcesOf[pageId] ?? (sourcesOf[pageId] = [])).push(own.id);
      return { node, mapped: false };
    }
    register(node, "content", pageId, parentId);
    return { node, mapped: false };
  };

  /**
   * A usable entry as a component, with everything under it, in document order: each node
   * registered before its children, a layout's slots filled once they are walked. An explicit
   * stack ({@link open}) rather than recursion, so a layout nested however deep — which both
   * shape checks accept — never exhausts the call stack.
   */
  const synthesize = (entry: PresentationNode, pageId: string): { node: ComponentNode; mapped: boolean } | undefined => {
    const first = visit(entry, pageId, undefined);
    if (first !== OPENED) {
      return first;
    }
    for (;;) {
      const layout = open[open.length - 1] as OpenLayout;
      if (layout.slot < layout.slotNames.length) {
        const slotName = layout.slotNames[layout.slot] as string;
        const group: unknown = layout.children[slotName];
        const members: unknown[] = Array.isArray(group) ? group : [];
        if (layout.child < members.length) {
          const made = visit(members[layout.child] as PresentationNode | PresentationReference, pageId, layout.id);
          layout.child += 1;
          if (made !== OPENED && made !== undefined) {
            layout.drawn.push(made.node);
            layout.holdsMapped = layout.holdsMapped || made.mapped;
          }
          continue;
        }
        layout.slots[slotName] = layout.drawn;
        layout.drawn = [];
        layout.slot += 1;
        layout.child = 0;
        continue;
      }
      // Every slot walked: the layout is done, and goes into the one around it.
      open.pop();
      layout.node.children = layout.slots;
      if (layout.holdsMapped) {
        mapped[layout.id] = true;
      }
      const around = open[open.length - 1];
      if (around === undefined) {
        return { node: layout.node, mapped: layout.holdsMapped };
      }
      around.drawn.push(layout.node);
      around.holdsMapped = around.holdsMapped || layout.holdsMapped;
    }
  };

  // The ownership's own walk, replayed: pages, then entries, one `seen` for the presentation,
  // the same presentation id and form keys (rules H and I).
  const seen = Object.create(null) as Record<string, true>;
  const formKeys = journeyFormKeys(root);
  for (const page of journey.pages) {
    // A review page places no form component (`journeyOwnership`): nothing of the form is drawn
    // on it, and an own entry that would place one is dropped whole.
    const review = page.kind === "review";
    for (const entry of page.components ?? []) {
      if (typeof entry === "string") {
        if (!review && formById[entry] !== undefined && entry !== root.id) {
          markDrawn(page.id, entry);
        }
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      if (entry.type === "journey-field") {
        // At the top of a page a reference is the component itself: a member under its own id.
        const componentId = review ? undefined : referenced(entry);
        if (componentId !== undefined) {
          markDrawn(page.id, componentId);
        }
        continue;
      }
      const own = entry as PresentationNode;
      if (!journeyOwnNodeUsable(own, formById, seen, journey.id, formKeys)) {
        continue;
      }
      if (review && journeyEntryPlacesForm(own)) {
        continue;
      }
      // A worked-out value at the top of a page that the ownership ignores is no member of it.
      if (own.type === "journey-value" && journeyOwn(workedOutTargets, own.id) === undefined) {
        continue;
      }
      const made = synthesize(own, page.id);
      if (made !== undefined) {
        entries.push(made.node);
      }
    }
  }
  for (const record of workedOut) {
    record.sourceIds = [...(sourcesOf[record.pageId] ?? [])];
  }

  const container: ComponentNode = { id: containerId, type: "container", configuration: {}, children: { content: entries } };
  const indexRoot: ComponentNode = { id: root.id, type: "form", configuration: {}, children: { [PRESENTATION_SLOT]: [container] } };

  return {
    presentationId: journey.id,
    containerId,
    container,
    root: indexRoot,
    tree: new ComponentTree(indexRoot),
    order,
    nodeById,
    parentOf,
    pageOf,
    kindOf,
    ownKeys,
    aliasOf,
    aliases,
    workedOutOf,
    workedOut,
    referenceOf,
    mapped,
    drawnOf,
    keyOf: (id) => journeyOwn(aliasOf, id)?.targetPath ?? journeyOwn(workedOutOf, id)?.targetPath ?? journeyOwn(ownKeys, id),
    idOfKey: (key) => journeyOwn(idsByKey, key),
    isPresentationKey: (key) => isPresentationKey(key, defines)
  };
}
