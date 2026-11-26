/**
 * A journey as the designer's tree, and back. The Journeys mode edits one journey with
 * an ordinary `BuilderController`, so its undo, drafts, selection, drag and inspector are the
 * form's own; this module is the mapping between that tree and the `Journey` the definition holds.
 *
 * | Node               | Node id         | Children                        | Configuration                                   |
 * |--------------------|-----------------|---------------------------------|-------------------------------------------------|
 * | `journey` (root)   | `journey`       | `pages`                         | the journey minus `id` and `pages`              |
 * | `journey-page`     | internal        | `content`, `routes`             | the page minus `id`, `components`, `routes`, plus `pageId` |
 * | `journey-field`    | internal        | none                            | `{ componentId }`, plus a written reference's other keys |
 * | `journey-route`    | internal        | none                            | `{ to, when?, missingTo? }` plus the route's own other keys |
 * | a node of its own  | its own id      | its own slots, as written       | as written (`rules` too)                         |
 *
 * Node ids are internal (`journey-page_1`, `journey-field_3`, …, the controller's own numbering),
 * never page ids: a page id may be any non-empty string (`"1"`, two pages sharing one), while a
 * node id must follow the component-id grammar and be unique, so any usable journey opens. A
 * route's `to` names a page *node*, so editing a page's id never breaks a route pointing at it.
 *
 * **Nodes a presentation owns** (an own field, text or layout, an alias with
 * `configuration.fills`, a worked-out value of type `journey-value`) are the stored shape itself:
 * a page's object entry is a deep copy in the page's `content` slot, under its own id, with its
 * own slots, rules and every key as written, and is written back as it stands. A reference to a
 * form component inside a layout of the journey's own is a `journey-field` node like a page's
 * question, with an internal id, written back as a reference (`{ type: "journey-field",
 * configuration: { componentId } }`); so is a reference written as an object at the top of a
 * page. A reference read from the file is remembered as written (`references`), so it is written
 * back with the keys it had — an `id` it carried (ignored by every reader), a key no reader
 * knows, a top-level object rather than the id string it means. Every other question at the top
 * of a page is written as its component id. Nothing about whether a node of the journey's own is
 * usable (the usability rules, `journey-path.ts`) changes how it is read or written: an entry
 * the runtime ignores is kept in the tree as written and written back untouched, and the checks
 * say why it is ignored.
 *
 * Internal ids are numbered around every id already taken — the form's component ids
 * (`formIds`), every id a node of the journey's own carries (all the way down its layouts), and
 * the journey's page ids — so a hand-written own id such as `journey-field_1` keeps its node and a
 * question beside it takes `journey-field_2`. A page written under its node id (its page id left
 * blank) is read under that id again. Ids the tree cannot tell apart stay as written and
 * are written back as they were, but the controller finds only the first node with an id: two
 * nodes of the journey's own sharing one (which the runtime ignores, rule A), or one named as
 * the root (`journey`).
 *
 * Writing a journey back (`journeyFromTree`):
 * - a blank `pageId` becomes the node id (made unique among the pages);
 * - a route's `to` naming a page node becomes that page's id; `"$end"` stays; a target node that
 *   is gone becomes the page id that node was last written as (`pageIds`), so a route to a
 *   deleted page survives as the unknown target `diagnoseJourney` reports, rather than vanishing
 *   and changing the path; else the unknown target the file held (`missingTo`); else the route
 *   is left out, as one whose target is not chosen yet. A route whose id there (a deleted
 *   page's, the file's, one typed) is the id a page is written under goes to that page, and
 *   from then on follows the page's node (`routeLinks`) while it has an id of its own, so
 *   editing the page's id does not break it either;
 * - a question with no `componentId` is left out, at the top of a page and inside a layout; so
 *   is a worked-out value with no form field or no expression yet, and a blank
 *   `fills` (the picker's empty choice) is no key;
 * - a node of the journey's own is written as it stands, its keys in their order (`children`
 *   last, as the builder's tree keeps them), a key such as `__proto__` included;
 * - a blank select is an absent key, `"true"`/`"false"` are booleans, `kind: "questions"` is
 *   absent, and empty `components`, `routes`, `validation`, `texts` and blank texts are absent;
 * - every key the builder does not know — on the journey, a page, a route, `texts` (a theme's
 *   own words) or `validation` — is written back as it was.
 * - Known keys are written in the order the engine's own journeys use (`id`, `name`, `progress`, `heading`,
 *   …, `pages`; a page's `id`, `kind`, `title`, …; a route's `when`, `to`), unknown ones after
 *   them; `texts` and `validation` keep their own order. A journey read and written back
 *   unedited is equal to the one read — byte for byte when written in that order, the shared
 *   presentation fixture among them — and a second round trip is identical to the first.
 *
 * Two keys are the builder's own, so a page key named `pageId` or a route key named `missingTo`
 * would be taken for them; neither is a journey key.
 *
 * Nothing written fails `validateJourneyShape` (`readJourneys` would silently drop the journey):
 * a tree that would is reported through `onError` and gives `undefined`, and the caller keeps
 * the last journey that was usable.
 *
 * Both directions walk a journey's own layouts with a stack of their own, as the shape check
 * does, so a deeply nested hand-written page cannot exhaust the call stack.
 *
 * In the designer's lazy chunk; free of work at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { JOURNEY_END, PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE, validateJourneyShape, type Journey, type JourneyPage } from "../../core/schema/journey.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_ID,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT
} from "./journey-mode-model.js";

export interface JourneyTreeOptions {
  /**
   * Page node id -> the page id the node was last read or written as. Filled by both directions,
   * and read when a route's target node has gone. The mode keeps one per journey, for as long as
   * its designer lives, so undoing a page's deletion finds the route pointing at it again.
   */
  pageIds?: Map<string, string>;
  /**
   * Route node id -> the page node a route with no page node of its own was found to go to: a
   * route to an id the file named, to a deleted page, or a page id typed as its target, once a
   * page with that id is written. Filled by `journeyFromTree` and read by it first, so the route
   * follows that page when its id is edited later. The mode keeps one per journey beside
   * `pageIds`.
   */
  routeLinks?: Map<string, string>;
  /**
   * Question node id -> the reference it was read from, as written: a reference to a
   * form component written as an object, inside a layout of the journey's own or at the top of
   * a page. Filled by `treeFromJourney` and read by `journeyFromTree`, which writes such a
   * question back with the keys the reference had (its `configuration` as the node now holds
   * it). A question it does not name is written as a component id at the top of a page and as
   * `{ type: "journey-field", configuration }` inside a layout. The mode keeps one per journey
   * beside `pageIds`.
   */
  references?: Map<string, Record<string, unknown>>;
  /**
   * The form's component ids, which no node of the designer's own takes: read by
   * `treeFromJourney`, which numbers its internal ids around them as it does around the
   * journey's own ids and page ids.
   */
  formIds?: Iterable<string>;
}

export interface JourneyFromTreeOptions extends JourneyTreeOptions {
  /** Hears why the tree could not be written as a usable journey (`validateJourneyShape`'s problems). */
  onError?: (problems: string[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Defines `key` on `target`, never assigns it: a key such as `__proto__` stays a key of the copy, as written. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The keys of `record` other than `omit`, cloned, in their order. */
function without(record: Record<string, unknown>, omit: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omit.includes(key)) {
      define(out, key, clone(value));
    }
  }
  return out;
}

/**
 * A deep copy of `source`, a node of the journey's own, and of every node in its
 * slots, visited in document order with a stack of its own rather than recursion. `replace` is
 * asked about each node under it as it is visited: `undefined` copies it as this one is copied,
 * `null` leaves it out of its slot, anything else stands in its place. Keys keep their order and
 * are defined, never assigned, so a key such as `__proto__` stays a key of the copy.
 */
function copyNodes(source: Record<string, unknown>, replace: (child: Record<string, unknown>) => unknown): Record<string, unknown> {
  const top: Record<string, unknown> = {};
  /** What a slot holds in the place of a child left out, until the slot is closed up. */
  const gap: unknown[] = [];
  const slotsCopied: Array<{ slots: Record<string, unknown>; slot: string; held: unknown[] }> = [];
  interface Visit {
    node: Record<string, unknown>;
    /** Where the copy goes: the top, or a place in a slot. */
    target?: Record<string, unknown>;
    held?: unknown[];
    at?: number;
  }
  const stack: Visit[] = [{ node: source, target: top }];
  while (stack.length > 0) {
    const visit = stack.pop() as Visit;
    let target = visit.target;
    if (target === undefined) {
      const replaced = replace(visit.node);
      if (replaced !== undefined) {
        (visit.held as unknown[])[visit.at as number] = replaced === null ? gap : replaced;
        continue;
      }
      target = {};
      (visit.held as unknown[])[visit.at as number] = target;
    }
    const deeper: Visit[] = [];
    for (const [key, value] of Object.entries(visit.node)) {
      if (key !== "children" || !isRecord(value)) {
        define(target, key, clone(value));
        continue;
      }
      const slots: Record<string, unknown> = {};
      for (const [slot, children] of Object.entries(value)) {
        if (!Array.isArray(children)) {
          define(slots, slot, clone(children));
          continue;
        }
        const held: unknown[] = [];
        for (const child of children) {
          if (isRecord(child)) {
            deeper.push({ node: child, held, at: held.length });
            held.push(gap);
          } else {
            held.push(clone(child));
          }
        }
        define(slots, slot, held);
        slotsCopied.push({ slots, slot, held });
      }
      define(target, "children", slots);
    }
    // Last first, so the nodes are visited — and anything numbered as they are — in document order.
    for (let index = deeper.length - 1; index >= 0; index -= 1) {
      stack.push(deeper[index]!);
    }
  }
  for (const { slots, slot, held } of slotsCopied) {
    if (held.includes(gap)) {
      define(slots, slot, held.filter((child) => child !== gap));
    }
  }
  return top;
}

/** Every id a node of the journey's own carries, all the way down its layouts (a reference carries none). */
function ownIdsOf(entries: readonly unknown[], into: Set<string>): void {
  const stack: unknown[] = [...entries];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || node.type === PRESENTATION_REFERENCE_TYPE) {
      continue;
    }
    if (typeof node.id === "string") {
      into.add(node.id);
    }
    for (const held of isRecord(node.children) ? Object.values(node.children) : []) {
      if (Array.isArray(held)) {
        stack.push(...held);
      }
    }
  }
}

/** The designer's tree for a journey with no pages: what a new, blank designer starts from. */
export function emptyJourneyTree(): ComponentNode {
  return { id: JOURNEY_ROOT_ID, type: JOURNEY_ROOT_TYPE, configuration: {}, children: { [JOURNEY_PAGES_SLOT]: [] } };
}

/**
 * What a node of each designer type starts as when the palette adds one (a component
 * definition's `createDefault`): every slot present, so the controller's add finds `pages` on
 * the root and `content` and `routes` on a page, and every value blank until the author picks
 * it. The id is a placeholder the controller replaces. `undefined` for any other type.
 */
export function journeyNodeTemplate(type: string): ComponentNode | undefined {
  switch (type) {
    case JOURNEY_ROOT_TYPE:
      return emptyJourneyTree();
    case JOURNEY_PAGE_TYPE:
      return {
        id: JOURNEY_PAGE_TYPE,
        type,
        configuration: { pageId: "" },
        children: { [JOURNEY_CONTENT_SLOT]: [], [JOURNEY_ROUTES_SLOT]: [] }
      };
    case JOURNEY_FIELD_TYPE:
      return { id: JOURNEY_FIELD_TYPE, type, configuration: { componentId: "" } };
    case JOURNEY_ROUTE_TYPE:
      return { id: JOURNEY_ROUTE_TYPE, type, configuration: { to: "" } };
    default:
      return undefined;
  }
}

/**
 * The designer's tree for `journey`. The journey is not changed, and the tree shares nothing
 * with it. A page's nodes of its own are copied into its `content` slot as written,
 * beside its questions, in the page's order (see the module comment).
 */
export function treeFromJourney(journey: Journey, options: JourneyTreeOptions = {}): ComponentNode {
  // Every id the designer's own node ids must avoid: the root's, the form's, the
  // journey's own nodes', each one handed out, and the page ids — a page's node may take its
  // own page id (a page written under its node id reopens under it), never another page's.
  const taken = new Set<string>([JOURNEY_ROOT_ID, ...(options.formIds ?? [])]);
  const pagesWithId = new Map<string, number>();
  for (const page of journey.pages) {
    pagesWithId.set(page.id, (pagesWithId.get(page.id) ?? 0) + 1);
    ownIdsOf(page.components ?? [], taken);
  }
  const counters = new Map<string, number>();
  /** `prefix_n` for the first n from the last one handed out that nothing has; the id is then taken. */
  const fresh = (prefix: string): string => {
    let n = counters.get(prefix) ?? 1;
    while (taken.has(`${prefix}_${n}`) || pagesWithId.has(`${prefix}_${n}`)) {
      n += 1;
    }
    counters.set(prefix, n + 1);
    const id = `${prefix}_${n}`;
    taken.add(id);
    return id;
  };

  // A page written under a node id of the designer's (its page id left blank) is read under it
  // again, while no other page and nothing else has it; every other page is numbered around.
  const keepsItsId = journey.pages.map((page) => /^journey-page_\d+$/.test(page.id) && pagesWithId.get(page.id) === 1 && !taken.has(page.id));
  journey.pages.forEach((page, index) => {
    if (keepsItsId[index]) {
      taken.add(page.id);
    }
  });
  const pageNodeIds = journey.pages.map((page, index) => (keepsItsId[index] ? page.id : fresh(JOURNEY_PAGE_TYPE)));
  // A route goes to the first page carrying its target id, as the path engine's does.
  const nodeOfPageId = new Map<string, string>();
  journey.pages.forEach((page, index) => {
    if (!nodeOfPageId.has(page.id)) {
      nodeOfPageId.set(page.id, pageNodeIds[index] as string);
    }
  });

  /** A question node for a reference written as an object, remembered as written. */
  const referenceNode = (reference: Record<string, unknown>): ComponentNode => {
    const id = fresh(JOURNEY_FIELD_TYPE);
    options.references?.set(id, clone(reference));
    return { id, type: JOURNEY_FIELD_TYPE, configuration: clone(isRecord(reference.configuration) ? reference.configuration : {}) };
  };

  const pages = journey.pages.map((page, index): ComponentNode => {
    const nodeId = pageNodeIds[index] as string;
    options.pageIds?.set(nodeId, page.id);
    // What the page lists, in its order: a component id or a reference is a question; any other
    // entry is a node of the journey's own, copied as written with its references as questions.
    const content = (page.components ?? []).map((entry): ComponentNode => {
      if (typeof entry === "string") {
        return { id: fresh(JOURNEY_FIELD_TYPE), type: JOURNEY_FIELD_TYPE, configuration: { componentId: entry } };
      }
      const record = entry as unknown as Record<string, unknown>;
      if (record.type === PRESENTATION_REFERENCE_TYPE) {
        return referenceNode(record);
      }
      return copyNodes(record, (child) => (child.type === PRESENTATION_REFERENCE_TYPE ? referenceNode(child) : undefined)) as unknown as ComponentNode;
    });
    const routeNodes = (page.routes ?? []).map((route): ComponentNode => {
      const record = route as unknown as Record<string, unknown>;
      const target = route.to === JOURNEY_END ? JOURNEY_END : nodeOfPageId.get(route.to);
      const configuration: Record<string, unknown> = {
        to: target ?? "",
        ...(target === undefined ? { missingTo: route.to } : {}),
        ...without(record, ["to"])
      };
      return { id: fresh(JOURNEY_ROUTE_TYPE), type: JOURNEY_ROUTE_TYPE, configuration };
    });
    return {
      id: nodeId,
      type: JOURNEY_PAGE_TYPE,
      configuration: { pageId: page.id, ...without(page as unknown as Record<string, unknown>, ["id", "components", "routes"]) },
      children: { [JOURNEY_CONTENT_SLOT]: content, [JOURNEY_ROUTES_SLOT]: routeNodes }
    };
  });

  return {
    id: JOURNEY_ROOT_ID,
    type: JOURNEY_ROOT_TYPE,
    configuration: without(journey as unknown as Record<string, unknown>, ["id", "pages"]),
    children: { [JOURNEY_PAGES_SLOT]: pages }
  };
}

// --- writing back ------------------------------------------------------------

/** Whether a text is empty: nothing, or a blank string (a definition text is a string). */
function isBlankText(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return typeof value === "string" ? value.trim() === "" : false;
}

/** A select's value: blank (`""`, `null`, absent) is no value. */
function selected(value: unknown): unknown {
  return value === "" || value === null ? undefined : value;
}

/** A condition: absent when blank. */
function condition(value: unknown): unknown {
  return value === "" || value === null ? undefined : value;
}

/** `validation` with blanks gone and `server` a boolean; its other keys as they are. Absent when empty. */
function normalizedValidation(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    let item: unknown = raw;
    if (key === "continue" || key === "onUnavailable" || key === "end") {
      item = selected(raw);
    } else if (key === "server") {
      item = raw === "true" ? true : raw === "false" ? false : selected(raw);
    }
    if (item !== undefined) {
      define(out, key, clone(item));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `texts` with blank entries gone; a theme's own keys as they are. Absent when empty. */
function normalizedTexts(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(value)) {
    if (!isBlankText(text)) {
      define(out, key, clone(text));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A review step's `review` block as written (Check answers): `emptyOptional` and `change` are
 * selects, so a blank is no key and `"true"`/`"false"` are booleans; `labels` is the row wording
 * by component id, a blank row dropped (it reads as the field's own label); every other key as
 * it was. Absent when nothing is left, so a step that lists everything as the defaults say writes
 * no block. Kept whatever the step's kind, as the schema reads it on any page.
 */
function normalizedReview(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    let item: unknown = raw;
    if (key === "emptyOptional") {
      item = selected(raw);
    } else if (key === "change") {
      item = raw === "true" ? true : raw === "false" ? false : selected(raw);
    } else if (key === "labels") {
      item = normalizedReviewLabels(raw);
    }
    if (item !== undefined) {
      define(out, key, clone(item));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `review.labels` with blank wording gone (no wording is the field's own label); anything that is not a map as it was. */
function normalizedReviewLabels(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(value)) {
    if (!isBlankText(text)) {
      define(out, key, clone(text));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Writes `value` under `key` unless it is absent. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    define(target, key, value);
  }
}

/** Copies the keys of `configuration` the builder does not know, in their order. */
function putUnknown(target: Record<string, unknown>, configuration: Record<string, unknown>, known: readonly string[]): void {
  for (const [key, value] of Object.entries(configuration)) {
    if (!known.includes(key) && value !== undefined) {
      define(target, key, clone(value));
    }
  }
}

function text(value: unknown): unknown {
  return isBlankText(value) ? undefined : clone(value);
}

/** The children of `node` that `keep` keeps, from `preferred` first, then every other slot in order. */
function childrenWhere(node: ComponentNode, preferred: string, keep: (child: ComponentNode) => boolean): ComponentNode[] {
  const children = node.children ?? {};
  const slots = [preferred, ...Object.keys(children).filter((slot) => slot !== preferred)];
  return slots.flatMap((slot) => (children[slot] ?? []).filter(keep));
}

/** The children of `node` of `type`, from `preferred` first, then every other slot in order. */
function childrenOfType(node: ComponentNode, type: string, preferred: string): ComponentNode[] {
  return childrenWhere(node, preferred, (child) => child.type === type);
}

/** The node types of the designer's own frame, which a page's content never writes as an entry. */
function isFrameType(type: string): boolean {
  return type === JOURNEY_ROOT_TYPE || type === JOURNEY_PAGE_TYPE || type === JOURNEY_ROUTE_TYPE;
}


/** A question's component id, when one is chosen. */
function chosenComponent(node: ComponentNode): string | undefined {
  const componentId = configurationOf(node).componentId;
  return typeof componentId === "string" && componentId.trim() !== "" ? componentId : undefined;
}

/**
 * A question written as a reference: with the keys the reference it was read from
 * had (`references`), else `{ type, configuration }`; its configuration as the node holds it.
 * `undefined` for a question with no component chosen, which is left out.
 */
function writtenReference(node: ComponentNode, references: ReadonlyMap<string, Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  if (chosenComponent(node) === undefined) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  const read = references?.get(node.id);
  for (const key of read ? Object.keys(read) : ["type", "configuration"]) {
    define(out, key, key === "type" ? JOURNEY_FIELD_TYPE : key === "configuration" ? clone(node.configuration) : clone(read?.[key]));
  }
  if (!("configuration" in out)) {
    define(out, "configuration", clone(node.configuration));
  }
  return out;
}

/** A finished way to work a value out, as the schema accepts it: a non-empty formula string, or the object form. */
function finishedWorkedOutValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return isRecord(value) && (typeof value.kind === "string" || typeof value.formula === "string" || isRecord(value.expression));
}

/**
 * A worked-out value the author has not finished: no form field chosen, or no way to
 * work it out yet. Left out of the journey written until it is, as a route with no target is —
 * written, it would fail the shape check and the whole journey could not be saved.
 */
function unfinishedWorkedOut(node: Record<string, unknown>): boolean {
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  return node.type === PRESENTATION_VALUE_TYPE && (typeof configuration.to !== "string" || configuration.to === "" || !finishedWorkedOutValue(configuration.value));
}

/**
 * A node of the journey's own as written, with a blank "Fills form field" (the picker's empty
 * choice, `""`) left out wherever it sits: a blank `fills` fails the shape check, and means no
 * form field filled — the field stays in the browser. Journeys are JSON data, and `JSON.parse`
 * defines every key, `__proto__` included, as written.
 */
function withoutBlankFills(written: unknown): unknown {
  return JSON.parse(JSON.stringify(written), (key, value: unknown) => (key === "fills" && value === "" ? undefined : value));
}

/**
 * What a page of the tree lists, in its order: a question is its component id — or
 * the reference it was read from, as written — and a node of the journey's own is written as it
 * stands, each question under it a reference; a worked-out value not finished yet is left out,
 * and so is a blank "Fills form field". A page, a route or a journey inside a node of the
 * journey's own — past a slot's check, or hand-written — goes into `misplaced`, never written.
 */
function writtenEntries(page: ComponentNode, references: ReadonlyMap<string, Record<string, unknown>> | undefined, misplaced: string[]): JourneyPage["components"] {
  return childrenWhere(page, JOURNEY_CONTENT_SLOT, (child) => !isFrameType(child.type)).flatMap((child): NonNullable<JourneyPage["components"]> => {
    if (child.type === JOURNEY_FIELD_TYPE) {
      const componentId = chosenComponent(child);
      if (componentId === undefined) {
        return [];
      }
      return [references?.has(child.id) ? (writtenReference(child, references) as unknown as NonNullable<JourneyPage["components"]>[number]) : componentId];
    }
    if (unfinishedWorkedOut(child as unknown as Record<string, unknown>)) {
      return [];
    }
    const written = copyNodes(child as unknown as Record<string, unknown>, (held) =>
      held.type === JOURNEY_FIELD_TYPE
        ? (writtenReference(held as unknown as ComponentNode, references) ?? null)
        : isFrameType(held.type as string)
          ? (misplaced.push(`${held.id as string} (${held.type as string}) is inside ${child.id}; pages and routes go on the journey`), null)
          : unfinishedWorkedOut(held)
            ? null
            : undefined
    );
    return [withoutBlankFills(written) as NonNullable<JourneyPage["components"]>[number]];
  });
}

// The keys the builder writes itself on each node; any other is the author's, kept as written.
// Arrays rather than Sets, so nothing is built when the module loads.
const ROOT_KEYS: readonly string[] = ["id", "pages", "name", "progress", "heading", "offPathValues", "validation", "texts"];
const PAGE_KEYS: readonly string[] = [
  "id",
  "components",
  "routes",
  "pageId",
  "kind",
  "title",
  "description",
  "validation",
  "texts",
  "review"
];
const ROUTE_KEYS: readonly string[] = ["to", "when", "missingTo"];

/**
 * The journey the tree holds, under the id `journeyId` (the catalog entry's; the tree carries
 * none). `undefined` when it would not pass `validateJourneyShape` — a route condition that is
 * not an expression, a value no select offers, a page carrying a `when` (pages have no condition)
 * — after telling `onError` why.
 */
export function journeyFromTree(root: ComponentNode, journeyId: string, options: JourneyFromTreeOptions = {}): Journey | undefined {
  const pageNodes = childrenOfType(root, JOURNEY_PAGE_TYPE, JOURNEY_PAGES_SLOT);

  // Page ids first, so a route can name any page, earlier or later.
  const explicit = new Set<string>();
  for (const node of pageNodes) {
    const pageId = configurationOf(node).pageId;
    if (typeof pageId === "string" && pageId.trim() !== "") {
      explicit.add(pageId);
    }
  }
  const pageIdOfNode = new Map<string, string>();
  const used = new Set<string>(explicit);
  for (const node of pageNodes) {
    const pageId = configurationOf(node).pageId;
    if (typeof pageId === "string" && pageId.trim() !== "") {
      pageIdOfNode.set(node.id, pageId);
      continue;
    }
    let candidate = node.id;
    for (let n = 2; used.has(candidate); n += 1) {
      candidate = `${node.id}-${n}`;
    }
    used.add(candidate);
    pageIdOfNode.set(node.id, candidate);
  }
  const pageIdsWritten = new Set(pageIdOfNode.values());
  // The first page written under each id, as the path engine finds a route's target.
  const nodeOfPageIdWritten = new Map<string, string>();
  for (const [nodeId, pageId] of pageIdOfNode) {
    if (!nodeOfPageIdWritten.has(pageId)) {
      nodeOfPageIdWritten.set(pageId, nodeId);
    }
  }

  /** A route found to go to a written page by its id: from now on it goes to that page's node. */
  const linked = (routeId: string, pageId: string): string => {
    const node = nodeOfPageIdWritten.get(pageId);
    if (node !== undefined) {
      options.routeLinks?.set(routeId, node);
    }
    return pageId;
  };

  const routeTarget = (routeId: string, configuration: Record<string, unknown>): string | undefined => {
    const to = typeof configuration.to === "string" ? configuration.to : "";
    if (to === JOURNEY_END) {
      // Chosen now: any page it was found to go to before no longer counts.
      options.routeLinks?.delete(routeId);
      return JOURNEY_END;
    }
    const target = pageIdOfNode.get(to);
    if (target !== undefined) {
      options.routeLinks?.delete(routeId);
      return target;
    }
    // A page it was found to go to before, followed while that page has an id of its own: so a
    // page added under the id a route names takes the route with it through a later rename. A
    // page whose id is blank again (its id typed, then undone) never takes it.
    const link = options.routeLinks?.get(routeId);
    const linkedNode = link !== undefined ? pageNodes.find((node) => node.id === link) : undefined;
    const linkedId = linkedNode !== undefined ? configurationOf(linkedNode).pageId : undefined;
    if (typeof linkedId === "string" && linkedId.trim() !== "") {
      return linkedId;
    }
    const remembered = to !== "" ? options.pageIds?.get(to) : undefined;
    if (remembered !== undefined) {
      // The page it pointed at was deleted: keep the route, now to a page the journey lacks.
      return linked(routeId, remembered);
    }
    if (to !== "" && pageIdsWritten.has(to)) {
      // A page id typed where a node id belongs (the JSON view): it still says where to go.
      return linked(routeId, to);
    }
    const missing = configuration.missingTo;
    return typeof missing === "string" && missing !== "" ? linked(routeId, missing) : undefined;
  };

  // A page, a route or a journey inside a node of the journey's own: the journey is
  // refused, as the shape check refuses one, so none ever reaches the definition.
  const misplaced: string[] = [];
  const pages = pageNodes.map((node): JourneyPage => {
    const configuration = configurationOf(node);
    const page: Record<string, unknown> = { id: pageIdOfNode.get(node.id) as string };
    const kind = selected(configuration.kind);
    put(page, "kind", kind === "questions" ? undefined : clone(kind));
    put(page, "title", text(configuration.title));
    put(page, "description", text(configuration.description));

    const components = writtenEntries(node, options.references, misplaced) ?? [];
    put(page, "components", components.length > 0 ? components : undefined);

    const routes = childrenOfType(node, JOURNEY_ROUTE_TYPE, JOURNEY_ROUTES_SLOT).flatMap((routeNode) => {
      const routeConfiguration = configurationOf(routeNode);
      const to = routeTarget(routeNode.id, routeConfiguration);
      if (to === undefined) {
        return [];
      }
      const route: Record<string, unknown> = {};
      put(route, "when", clone(condition(routeConfiguration.when)));
      route.to = to;
      putUnknown(route, routeConfiguration, ROUTE_KEYS);
      return [route];
    });
    put(page, "routes", routes.length > 0 ? routes : undefined);

    put(page, "validation", normalizedValidation(configuration.validation));
    put(page, "texts", normalizedTexts(configuration.texts));
    put(page, "review", normalizedReview(configuration.review));
    putUnknown(page, configuration, PAGE_KEYS);
    return page as unknown as JourneyPage;
  });

  for (const [nodeId, pageId] of pageIdOfNode) {
    options.pageIds?.set(nodeId, pageId);
  }

  const configuration = configurationOf(root);
  const journey: Record<string, unknown> = { id: journeyId };
  put(journey, "name", text(configuration.name));
  put(journey, "progress", clone(selected(configuration.progress)));
  put(journey, "heading", clone(selected(configuration.heading)));
  put(journey, "offPathValues", clone(selected(configuration.offPathValues)));
  put(journey, "validation", normalizedValidation(configuration.validation));
  put(journey, "texts", normalizedTexts(configuration.texts));
  putUnknown(journey, configuration, ROOT_KEYS);
  journey.pages = pages;

  const problems = [...misplaced, ...validateJourneyShape(journey, { allowRepeatedPageIds: true })];
  if (problems.length > 0) {
    options.onError?.(problems);
    return undefined;
  }
  return journey as unknown as Journey;
}
