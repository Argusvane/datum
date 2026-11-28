/**
 * The journey flow map's model: the designer's view of a journey, with its graph
 * facts (`journeyFlow`), as the nodes and edges the map draws — in words, sized, and tied to
 * the designer's node ids so a click selects what it shows.
 *
 * | Node   | Key               | Drawn as                                              | A click selects |
 * |--------|-------------------|-------------------------------------------------------|-----------------|
 * | Start  | `$start`          | a pill                                                | the root        |
 * | Step   | `page:<step key>` | a card: number, name, id and questions, notes, stubs  | the step        |
 * | End    | `$end`            | a pill; "No path submits" when no path reaches it     | the root        |
 *
 * A step's key is its node id, or `#<n>` for a step written from outside the pages slot, which
 * the map draws but cannot select. A step is one box, and every way out of it leaves the box:
 * there is no diamond. A step has no condition of its own; its routes are tried in order, an
 * unconditional one ending the list as it ends the path's; else the walk falls through to the
 * next step in order.
 *
 * | Edge    | From → to                       | Label                                                   |
 * |---------|---------------------------------|---------------------------------------------------------|
 * | `start` | Start → the first step          | none                                                    |
 * | `route` | a step → its target             | "n · If ‹condition›", "n · Otherwise" or "n · Always"; the number whenever the step has two or more routes or ways out |
 * | `next`  | a step → the next step in order | "Otherwise" after a drawn conditional route, else none  |
 *
 * No step is passed over: every step the path reaches is shown, whatever shows on it. A
 * step with nothing on it is drawn as any other, its card saying "No fields yet", with a plain
 * line onward; skipping a step is a Go to rule the author writes.
 *
 * **Edge ids.** An edge's `key` is its id: what `data-edge` carries, what the map's
 * `setState({ takenEdges })` names, and what {@link journeyMapEdgeId} builds — `start`;
 * `route:<step key>:<route index>` (the route's written position, 0-based, as the runtime's
 * decisions name it); `next:<step key>`. A way is named by the step it leaves
 * and how it leaves; where it goes follows from the journey. A step's ids hold while its node id
 * does (a new title or condition keeps them), but a route's is positional: reorder or delete a
 * step's routes and `route:<step>:0` names whichever route is now first. A state is the walk of
 * the journey as it stands, so whoever sets it sets it again on every change of the journey.
 *
 * Route numbers are the route's position in the journey as written, the "Route n" the
 * findings and the stubs speak of; a route with no target yet is not written, so it has no
 * number. A route the walk never takes (to a missing or earlier step, on an exit step, after
 * one that always matches) and a route with no target yet are not edges but stubs: rows at the
 * foot of their step's card, three at most, then "+n more". A stub is coloured as the finding
 * about it is (an error, a warning), and muted where no finding speaks of it (a route on an
 * exit step, a route with no target yet).
 *
 * A chip that cannot say its whole condition in two lines shortens the questions' labels, never
 * the tests: 'If Do you live in this… equals “no”' still says which answer takes the route. Only
 * when the labels cut to nothing are not enough does it take a third line, and past that cut
 * its end. A step that shares its id with a later one says so: the runtime shows it with that
 * step's questions.
 *
 * A presentation's step counts, among its questions, its references and its own
 * fields however deep in its own layouts — an alias is one — but not a worked-out value, a
 * paragraph or a layout. A row of its card says what it fills and what it works out ("Fills
 * Email", "Works out Annual income", each field named once, in step order, by the label the
 * designer lends, else its id), and its description the same in a sentence; its badge counts
 * the findings on everything in it.
 *
 * The main line is flagged (`spine`) for the layout to keep straight: from Start, each step's
 * way on when no route matches (its fall-through, or its unconditional route).
 *
 * Words come in through {@link JourneyMapWords}, so the map's chunk never loads the designer's
 * faces. Pure and deterministic; nothing runs at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { PRESENTATION_VALUE_TYPE, type Journey } from "../../core/schema/journey.js";
import type { JourneyFlow, JourneyFlowEdge, JourneyFlowIgnoreReason } from "../../core/journey/journey-flow.js";
import { journeyHoldsOwnAnswer, journeyOwn } from "../../core/journey/journey-shared.js";
import type { JourneyCheck, JourneyFinding, JourneyPageEntry, JourneyTreeIndex } from "../journey-designer/journey-checks.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_ROUTE_TYPE, JOURNEY_ROUTES_SLOT } from "../journey-designer/journey-mode-model.js";
import { estimateTextWidth, wrapText, type FlowLayoutInput } from "./journey-map-layout.js";
import type { JourneyMapLayout } from "./journey-map-preferences.js";
import type { BuilderPluralKey, BuilderTextKey, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderPlural, builderText } from "./journey-map-texts-en.js";

// The layout is the viewer's preference, read by the mode before this chunk loads: its type and
// its reading live in the static preferences module, and are shared from there.
export { normalizeJourneyMapLayout } from "./journey-map-preferences.js";
export type { JourneyMapLayout } from "./journey-map-preferences.js";

/**
 * A condition in words, as the Rules tab says it (`conditionInWords`): its terms joined by
 * "and" or "or", each a subject (a question's label, which a chip may shorten) and its test
 * ('equals “no”', which a chip always shows whole). A formula the sentence cannot word is one
 * term, the printed formula as its subject and no test.
 */
export interface JourneyMapCondition {
  join: "and" | "or";
  terms: ReadonlyArray<{ subject: string; test: string }>;
}

/** The words the designer lends the map (from `conditionInWords`, `pageName` and `findingsSummary`). */
export interface JourneyMapWords {
  /** The journey's name as the mode shows it: its name, else its id. */
  journeyName: string;
  /** A condition in words; `undefined` for one the engine cannot evaluate (a custom condition). */
  condition(expression: unknown): JourneyMapCondition | undefined;
  /** What a page is called beside its number. */
  pageName(page: JourneyPageEntry): string;
  /** "1 error, 2 warnings"; `undefined` for none. */
  summary(findings: { errors: number; warnings: number }): string | undefined;
  /** A form component's label: what a page's own field fills or its worked-out value sets. Without it, its id. */
  field?(componentId: string): string;
  /** Which components hold no answer beyond the engine's own (the mode's `isValueless`): no card counts one as a question. */
  isValueless?(node: ComponentNode): boolean;
  /** The builder's locale and catalog for the map's own words; English when absent. */
  text?: BuilderTextOptions;
  /** A map to look at, not to edit (the surface's `readOnly`): its words offer nothing to select. */
  readOnly?: boolean;
  /**
   * How many answers a Check answers step lists, read off the journey as it stands (the form is
   * the designer's to read, not the map's): "Check answers · 7 listed". Without it the card says
   * only "Check answers".
   */
  listed?(check: JourneyCheck): number;
}

/** What the map reads of the designer's view of a journey (`JourneyDesignView` fits). */
export interface JourneyMapSource {
  tree: ComponentNode;
  index: JourneyTreeIndex;
  check: JourneyCheck;
}

export type JourneyMapSeverity = "error" | "warning";

export interface JourneyMapFindings {
  errors: number;
  warnings: number;
}

interface JourneyMapNodeBase {
  /** The layout's key: unique in the graph. */
  key: string;
  /** List order, which is also a topological order. */
  order: number;
  width: number;
  height: number;
  /** The designer node a click selects; absent when nothing can be. */
  select?: string;
}

export interface JourneyMapTerminal extends JourneyMapNodeBase {
  kind: "start" | "end";
  /** The focusable item's key: `$start` or `$end`. */
  item: string;
  text: string;
  /** End when no path reaches it (a journey with no pages included); never Start. */
  failing: boolean;
  ariaLabel: string;
}

/** Where a card's rows sit, from its top. Baselines, in the card's own coordinates. */
export interface JourneyMapCardRows {
  title: number[];
  meta: number;
  notes: number[];
  /** The rule above the stubs; absent without stubs. */
  divider?: number;
  stubs: number[];
}

/** A route the map shows as a row at the foot of its page's card rather than as an edge. */
export interface JourneyMapStub {
  /** The route's node id: its item key and what a click selects; absent when the map cannot select it. */
  item?: string;
  /** Why it is not drawn: the flow's reason, or no target chosen yet. */
  reason: JourneyFlowIgnoreReason | "no-target";
  /** The finding about it: an error or a warning; a note where no finding speaks of it. */
  severity: JourneyMapSeverity | "note";
  /** The written position, 1-based; absent for a route with no target yet. */
  number?: number;
  /** "⊘ 3 · back to Page 2: ignored", cut to the card. */
  text: string;
  /** The same, whole. */
  fullText: string;
  ariaLabel: string;
}

export interface JourneyMapPage extends JourneyMapNodeBase {
  kind: "page";
  /** The page's node id, its item key; absent when the map cannot select it. */
  item?: string;
  /** Position in the journey as written. */
  index: number;
  /** "Page 3": the tree's numbering, as the cards say it. */
  number: number;
  pageId: string;
  name: string;
  exit: boolean;
  /** No path reaches it (`page.unreachable`). */
  unreachable: boolean;
  titleLines: string[];
  /** "income · 3 questions", whole. */
  meta: string;
  /** {@link meta} as the card draws it: wrapped to the card's width, never cut while it fits {@link JOURNEY_MAP_METRICS}`.card.metaLines` lines. */
  metaLines: string[];
  /** What it fills and works out, then what to know of it ("Exit · stops here"), each cut to the card. */
  notes: string[];
  /** The page's own findings and those of everything in it. */
  findings: JourneyMapFindings;
  /** "▲ 3", or absent. */
  badge?: string;
  badgeSeverity?: JourneyMapSeverity;
  /** Every stub; the card shows the first {@link JOURNEY_MAP_METRICS}`.card.stubsShown`. */
  stubs: JourneyMapStub[];
  /** The row after the shown stubs, when some are not shown: selects the page. */
  more?: { item?: string; text: string; ariaLabel: string };
  rows: JourneyMapCardRows;
  /** Everything the card says, in sentences: its aria-label, and its line in the text list. */
  description: string;
}

export type JourneyMapNode = JourneyMapTerminal | JourneyMapPage;

export type JourneyMapEdgeKind = "start" | "route" | "next";

export interface JourneyMapLabel {
  /** The whole text. */
  text: string;
  lines: string[];
  width: number;
  height: number;
  /** A route's chip is an item of its own (the route's node id); other chips are not focusable. */
  item?: string;
  ariaLabel?: string;
  /** "▲ 2" when the route has findings. */
  badge?: string;
  badgeSeverity?: JourneyMapSeverity;
}

export interface JourneyMapEdge {
  /** Its id: see "Edge ids" in the module comment ({@link journeyMapEdgeId}). */
  key: string;
  from: string;
  to: string;
  kind: JourneyMapEdgeKind;
  /** Try order among its source's edges. */
  order: number;
  weight: number;
  /** Part of the main line (see the module comment). */
  spine: boolean;
  /** Some walk takes it. */
  live: boolean;
  /** A route with a condition. */
  conditional: boolean;
  /** Taken only when what comes before does not. */
  otherwise: boolean;
  /** The route's written position, 0-based. */
  routeIndex?: number;
  select?: string;
  label?: JourneyMapLabel;
}

export interface JourneyMapGraph {
  /** The last graph that could be drawn, kept while the tree cannot be written. */
  stale: boolean;
  /** Why the map is stale: the `journey.unwritable` message. */
  problem?: string;
  /** "7 steps · 2 exits · 3 branch points · 1 error, 2 warnings": the announcement and the words list's label. */
  status: string;
  /** The plain counts the bar shows: "4 steps · 3 errors · 1 warning", errors and warnings left out at zero. */
  bar: string;
  /** The map's aria-label. */
  label: string;
  /** Drawn to look at, not to edit (`JourneyMapWords.readOnly`): its items are images, not buttons. Absent otherwise. */
  readOnly?: true;
  counts: { pages: number; exits: number; branchPoints: number; errors: number; warnings: number };
  nodes: JourneyMapNode[];
  edges: JourneyMapEdge[];
  /** The focusable items' keys in reading order: Start, each page then its route chips and stubs, End. */
  readingOrder: string[];
}

/** A way on the map, as {@link journeyMapEdgeId} names it: `from` is a step's key (its node id). */
export type JourneyMapWay = { kind: "start" } | { kind: "next"; from: string } | { kind: "route"; from: string; routeIndex: number };

/**
 * The id of a way on the map, its edge's `key` (see "Edge ids" in the module comment): `start`,
 * `route:<step>:<route index>` (the route's written position, 0-based), `next:<step>`, where
 * `<step>` is the step's node id. A route's id follows its position, not its
 * node: reordered, the same id names another route.
 */
export function journeyMapEdgeId(way: JourneyMapWay): string {
  switch (way.kind) {
    case "start":
      return "start";
    case "route":
      return `route:${way.from}:${way.routeIndex}`;
    default:
      return `next:${way.from}`;
  }
}

/** Sizes the map's boxes are drawn at. The layout estimates text at these sizes. */
export const JOURNEY_MAP_METRICS = {
  card: {
    width: 208,
    padX: 12,
    top: 10,
    bottom: 9,
    minHeight: 52,
    discX: 22,
    discY: 21,
    discR: 11,
    titleX: 40,
    titleWidth: 156,
    titlePx: 13,
    titleLine: 16,
    metaPx: 11,
    metaLine: 15,
    /** The lines a card's caption may take before the last is cut: it wraps rather than ending in "…". */
    metaLines: 3,
    noteLine: 15,
    stubGap: 7,
    stubPx: 11,
    stubLine: 16,
    stubsShown: 3
  },
  pill: { width: 104, wideWidth: 140, height: 30, px: 12 },
  chip: { px: 11, line: 14, padX: 7, padY: 4, maxWidth: 168, maxLines: 2, badgeGap: 5, handle: 14, hit: 24 }
} as const;

const START = "$start";
const END = "$end";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

function tx(words: JourneyMapWords, key: BuilderTextKey, params?: Record<string, string | number>): string {
  return builderText(key, params, words.text);
}

/** A count with its noun in the map's words (`base` is a plural key of the builder catalog). */
function countOf(words: JourneyMapWords, base: BuilderPluralKey, count: number): string {
  return builderPlural(base, count, undefined, words.text);
}

/** What a Check answers step's card and sentence say it is: "Check answers · 7 listed", "a Check answers step listing 7 answers". */
function reviewWhat(view: JourneyMapSource, words: JourneyMapWords): { card: string; sentence: string } {
  const listed = words.listed?.(view.check);
  return listed === undefined
    ? { card: tx(words, "journey.map.review.plain"), sentence: tx(words, "journey.map.review.an.plain") }
    : {
        card: tx(words, "journey.map.review", { listed: countOf(words, "journey.map.listed", listed) }),
        sentence: tx(words, "journey.map.review.an", { answers: countOf(words, "journey.map.answers", listed) })
      };
}

function countFindings(lists: ReadonlyArray<readonly JourneyFinding[] | undefined>): JourneyMapFindings {
  const out: JourneyMapFindings = { errors: 0, warnings: 0 };
  for (const list of lists) {
    for (const finding of list ?? []) {
      out[finding.severity === "error" ? "errors" : "warnings"] += 1;
    }
  }
  return out;
}

function badgeOf(findings: JourneyMapFindings): { badge?: string; badgeSeverity?: JourneyMapSeverity } {
  const total = findings.errors + findings.warnings;
  return total > 0 ? { badge: `▲ ${total}`, badgeSeverity: findings.errors > 0 ? "error" : "warning" } : {};
}

/** A chip: `fitted` (its text as shown, `text` unless shortened) in lines cut to the chip's width, and its size. */
function chip(
  text: string,
  badge: string | undefined,
  fitted: string = text,
  maxLines: number = JOURNEY_MAP_METRICS.chip.maxLines
): Pick<JourneyMapLabel, "text" | "lines" | "width" | "height"> {
  const m = JOURNEY_MAP_METRICS.chip;
  const reserve = badge !== undefined ? m.badgeGap + estimateTextWidth(badge, m.px) : 0;
  const lines = wrapText(fitted, m.maxWidth - 2 * m.padX - reserve, m.px, maxLines);
  const widest = lines.reduce((most, line) => Math.max(most, estimateTextWidth(line, m.px)), 0);
  return { text, lines, width: Math.ceil(widest + reserve + 2 * m.padX), height: 2 * m.padY + m.line * Math.max(1, lines.length) };
}

/**
 * A chip that says nothing: the small square a lone unconditional rule keeps on its line, so the
 * rule can still be clicked (it opens in the Logic editor) while the line stays clean. `text` is
 * the words it would have said, for the tooltip; nothing is drawn in it.
 */
function handleChip(text: string): Pick<JourneyMapLabel, "text" | "lines" | "width" | "height"> {
  return { text, lines: [], width: JOURNEY_MAP_METRICS.chip.handle, height: JOURNEY_MAP_METRICS.chip.handle };
}

/** A condition said whole, or with each question's label cut to `subjectWidth`; a custom one as such. */
function conditionText(condition: JourneyMapCondition | undefined, subjectWidth = Infinity, text?: BuilderTextOptions): string {
  if (condition === undefined) {
    return builderText("journey.map.condition.custom", undefined, text);
  }
  const px = JOURNEY_MAP_METRICS.chip.px;
  return condition.terms
    .map((term) => {
      const subject = subjectWidth === Infinity ? term.subject : cut(term.subject, subjectWidth, px);
      // A formula term has no test: the printed formula is the whole of it.
      return term.test === "" ? subject : `${subject} ${term.test}`;
    })
    .join(` ${builderText(condition.join === "or" ? "cond.join.or" : "cond.join.and", undefined, text)} `);
}

/**
 * A chip saying `lead`, the condition, then `trail`. Where the whole does not fit in the chip's
 * lines, the questions' labels are cut, as little as will do, so the tests — the answers that
 * take the way — and the trail are always whole; where cutting the labels to nothing is not
 * enough (two tests and a trail), the chip takes a line more; only past that is the end cut.
 */
function conditionChip(lead: string, condition: JourneyMapCondition | undefined, trail: string, badge?: string, words?: BuilderTextOptions): Pick<JourneyMapLabel, "text" | "lines" | "width" | "height"> {
  const m = JOURNEY_MAP_METRICS.chip;
  const text = `${lead}${conditionText(condition, Infinity, words)}${trail}`;
  const room = m.maxWidth - 2 * m.padX - (badge !== undefined ? m.badgeGap + estimateTextWidth(badge, m.px) : 0);
  const lineCount = (candidate: string): number => wrapText(candidate, room, m.px, Number.MAX_SAFE_INTEGER).length;
  if (condition === undefined || lineCount(text) <= m.maxLines) {
    return chip(text, badge);
  }
  const cutTo = (width: number): string => `${lead}${conditionText(condition, width, words)}${trail}`;
  const lines = lineCount(cutTo(0)) <= m.maxLines ? m.maxLines : m.maxLines + 1;
  if (lineCount(text) <= lines) {
    return chip(text, badge, text, lines);
  }
  // The widest a label may be, found by halving: the most of each label that still fits.
  let low = 0;
  let high = Math.ceil(Math.max(...condition.terms.map((term) => estimateTextWidth(term.subject, m.px))));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineCount(cutTo(middle)) <= lines) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return chip(text, badge, cutTo(low), lines);
}

/** One line cut to `width` with an ellipsis. */
function cut(text: string, width: number, px: number): string {
  return wrapText(text, width, px, 1)[0] ?? "";
}

/** The caption of a card (its step id and what it holds) in the lines it is drawn in, the badge kept clear of each. */
function metaLinesOf(meta: string, reserve: number): string[] {
  const m = JOURNEY_MAP_METRICS.card;
  return wrapText(meta, m.titleWidth - reserve, m.metaPx, m.metaLines);
}

/** The rows of a card and its height. */
function cardRows(titleLines: number, metaLines: number, notes: number, stubRows: number): { rows: JourneyMapCardRows; height: number } {
  const m = JOURNEY_MAP_METRICS.card;
  let y = m.top;
  const title: number[] = [];
  for (let line = 0; line < titleLines; line += 1) {
    title.push(y + 12 + line * m.titleLine);
  }
  y += Math.max(1, titleLines) * m.titleLine;
  const meta = y + 12;
  y += Math.max(1, metaLines) * m.metaLine;
  const noteLines: number[] = [];
  for (let note = 0; note < notes; note += 1) {
    noteLines.push(y + 12);
    y += m.noteLine;
  }
  const rows: JourneyMapCardRows = { title, meta, notes: noteLines, stubs: [] };
  if (stubRows > 0) {
    rows.divider = y + 3;
    y += m.stubGap;
    for (let stub = 0; stub < stubRows; stub += 1) {
      rows.stubs.push(y + 12);
      y += m.stubLine;
    }
  }
  return { rows, height: Math.max(m.minHeight, y + m.bottom) };
}

interface PageFacts {
  index: number;
  entry: JourneyPageEntry | undefined;
  /** The node id a click selects; undefined when the page cannot be selected. */
  nodeId: string | undefined;
  key: string;
  number: number;
  name: string;
  /** "Page 3 · Contact", as the cards and sentences name the page. */
  label: string;
}

/** Page `index` of the journey as written, found in the tree through its placement. */
function pageFacts(view: JourneyMapSource, index: number, pageId: string, words: JourneyMapWords): PageFacts {
  const placed = view.check.placement.pages[index]?.nodeId ?? "";
  const found = placed !== "" ? view.index.pageOf.get(placed) : undefined;
  const entry = found !== undefined && found.nodeId === placed ? found : undefined;
  const number = entry?.number ?? index + 1;
  const name = entry !== undefined ? words.pageName(entry) : pageId;
  return {
    index,
    entry,
    nodeId: entry?.nodeId,
    key: `page:${entry?.nodeId ?? `#${index + 1}`}`,
    number,
    name,
    label: tx(words, "journey.map.page.ref", { number, name })
  };
}

function reference(page: PageFacts): string {
  return page.label;
}

/** What a page holds however deep, its own nodes and their layouts' too, as its card says it. */
interface PageContent {
  /** Anything at all. */
  any: boolean;
  /** The form's questions and the page's own fields, an alias among them. */
  questions: number;
  /** What it fills and what it works out, a row each, cut to the card: "Fills Email", "Works out Annual income". */
  notes: string[];
  /** The same in a sentence, " It fills Email; it works out Annual income.", or "". */
  said: string;
  /** The page's own findings and its content's; its routes' are on their chips. */
  findings: JourneyMapFindings;
}

function pageContent(view: JourneyMapSource, entry: JourneyPageEntry | undefined, words: JourneyMapWords): PageContent {
  // What the shared ownership says of the page's own entries (`JourneyCheck.ownership`):
  // one it does not use asks, fills and works out nothing, nor does a second entry with an id met
  // on the page; a question at the top of a page always counts, as it did. With no journey
  // written there is no ownership: every entry counts as a question, and nothing is named.
  const own = view.check.ownership;
  const members = own && (journeyOwn(own.membersOf, entry?.pageId ?? "") ?? []);
  const used = new Set<string>();
  const inUse = (node: ComponentNode): boolean =>
    node.type === JOURNEY_FIELD_TYPE || !members || (!used.has(node.id) && members.includes(node.id) && !!journeyOwn(own?.ownNodes ?? {}, node.id) && !!used.add(node.id));
  // In document order, so what it fills and works out is said in the order the page asks it.
  const stack = (entry?.node.children?.[JOURNEY_CONTENT_SLOT] ?? []).map((node): [ComponentNode, boolean] => [node, inUse(node)]).reverse();
  const any = stack.length > 0;
  // Each node's findings once: nodes sharing an id share them.
  const keys = new Set([entry?.nodeId]);
  const fills = new Set<string>();
  const works = new Set<string>();
  let questions = 0;
  const name = (into: Set<string>, record: Record<string, string> | undefined, id: string): void => {
    const target = record && journeyOwn(record, id);
    if (target) {
      into.add(words.field?.(target) ?? target);
    }
  };
  while (stack.length > 0) {
    const [node, live] = stack.pop() as [ComponentNode, boolean];
    keys.add(node.id);
    stack.push(...Object.values(node.children ?? {}).flat().reverse().map((child): [ComponentNode, boolean] => [child, live]));
    if (!live) {
      continue;
    }
    if (node.type === PRESENTATION_VALUE_TYPE) {
      name(works, own?.workedOutOf, node.id);
    } else if (node.type === JOURNEY_FIELD_TYPE || (journeyHoldsOwnAnswer(node) && !words.isValueless?.(node))) {
      questions += 1;
      name(fills, own?.aliasOf, node.id);
    }
  }
  const notes: string[] = [];
  for (const [verb, names] of [["journey.map.fills", fills], ["journey.map.worksOut", works]] as const) {
    const all = [...names];
    const last = all.pop();
    if (last !== undefined) {
      const list = all.length > 0 ? `${all.join(", ")} ${tx(words, "cond.join.and")} ${last}` : last;
      notes.push(tx(words, verb, { list }));
    }
  }
  return {
    any,
    questions,
    notes: notes.map((note) => cut(note, JOURNEY_MAP_METRICS.card.titleWidth, JOURNEY_MAP_METRICS.card.metaPx)),
    said: notes.length > 0 ? ` ${tx(words, "journey.map.said", { notes: notes.map((note) => note[0]!.toLowerCase() + note.slice(1)).join(`; ${tx(words, "journey.map.said.next")} `) })}` : "",
    findings: countFindings([...keys].map((key) => view.check.findings.byNode.get(key as string)))
  };
}

/**
 * The map of the journey in `view`, from its graph facts. The tree cannot be written
 * (`check.journey` is undefined): `previous`, marked stale and stripped of nodes the tree no
 * longer has, else the pages alone. See the module comment.
 */
export function journeyMapGraph(view: JourneyMapSource, flow: JourneyFlow | undefined, words: JourneyMapWords, previous?: JourneyMapGraph): JourneyMapGraph {
  const journey = view.check.journey;
  if (journey === undefined) {
    const problem =
      view.check.findings.root.find((finding) => finding.code === "journey.unwritable")?.message ??
      (view.check.problems.length > 0 ? view.check.problems.join("; ") : undefined);
    return previous !== undefined ? staleJourneyMapGraph(previous, view, problem) : pagesOnlyGraph(view, words, true, problem);
  }
  if (flow === undefined || flow.pages.length !== journey.pages.length) {
    return pagesOnlyGraph(view, words, false, undefined);
  }
  return fullGraph(view, journey, flow, words);
}

/**
 * A page's stubs: its written routes the walk never takes, then its routes with no target yet
 * (which are not written, so have no number), in the order of the tree's routes slot.
 */
function pageStubs(view: JourneyMapSource, journey: Journey, flow: JourneyFlow, pages: readonly PageFacts[], index: number, words: JourneyMapWords): JourneyMapStub[] {
  const page = pages[index] as PageFacts;
  const written = journey.pages[index]!;
  const placed = view.check.placement.pages[index]?.routes ?? [];
  const treeRoutes = (page.entry?.node.children?.[JOURNEY_ROUTES_SLOT] ?? []).filter((child) => child.type === JOURNEY_ROUTE_TYPE);
  const treeOrder = new Map(treeRoutes.map((route, at) => [route.id, at]));
  const writtenRoutes = new Set(placed);
  const stubs: Array<{ at: number; stub: JourneyMapStub }> = [];
  for (const ignored of flow.ignored) {
    if (ignored.from !== index) {
      continue;
    }
    const number = ignored.routeIndex + 1;
    const placedNode = placed[ignored.routeIndex];
    const routeNode = placedNode !== undefined && placedNode !== "" ? placedNode : undefined;
    const to = written.routes?.[ignored.routeIndex]?.to ?? "";
    const targetPage = ignored.to !== undefined && ignored.to < pages.length ? pages[ignored.to] : undefined;
    let short: string;
    let why: string;
    switch (ignored.reason) {
      case "unknown-target":
        short = tx(words, "journey.map.stub.missing", { to });
        why = tx(words, "journey.map.stub.missing.why", { to });
        break;
      case "self":
        short = tx(words, "journey.map.stub.self");
        why = tx(words, "journey.map.stub.self.why");
        break;
      case "backward":
        short = tx(words, "journey.map.stub.backward", { number: targetPage?.number ?? "?" });
        why = tx(words, "journey.map.stub.backward.why", { page: targetPage !== undefined ? reference(targetPage) : tx(words, "journey.map.earlier") });
        break;
      case "exit":
        short = tx(words, "journey.map.stub.exit");
        why = tx(words, "journey.map.stub.exit.why");
        break;
      case "review":
        short = tx(words, "journey.map.stub.review");
        why = tx(words, "journey.map.stub.review.why");
        break;
      default: {
        const before = (ignored.shadowedBy ?? 0) + 1;
        short = tx(words, "journey.map.stub.shadowed", { before });
        why = tx(words, "journey.map.stub.shadowed.why", { before });
      }
    }
    const fullText = tx(words, "journey.map.stub.full", { number, short });
    stubs.push({
      at: (routeNode !== undefined ? treeOrder.get(routeNode) : undefined) ?? treeRoutes.length + ignored.routeIndex,
      stub: {
        ...(routeNode !== undefined ? { item: routeNode } : {}),
        reason: ignored.reason,
        // As the findings about it: route.unknown-target and route.backward are errors,
        // route.shadowed a warning; nothing is said of a route only on an exit page, or on a
        // Check answers page, which leaves only for the end.
        severity: ignored.reason !== "exit" && ignored.reason !== "review" && ignored.reason !== "shadowed" ? "error" : ignored.reasons.includes("shadowed") ? "warning" : "note",
        number,
        text: cut(fullText, JOURNEY_MAP_METRICS.card.width - 2 * JOURNEY_MAP_METRICS.card.padX, JOURNEY_MAP_METRICS.card.stubPx),
        fullText,
        ariaLabel: tx(words, "journey.map.stub.aria", { number, page: reference(page), why })
      }
    });
  }
  treeRoutes.forEach((route, at) => {
    if (!writtenRoutes.has(route.id)) {
      stubs.push({
        at,
        stub: {
          item: route.id,
          reason: "no-target",
          severity: "note",
          text: tx(words, "journey.map.stub.noTarget"),
          fullText: tx(words, "journey.map.stub.noTarget"),
          ariaLabel: tx(words, "journey.map.stub.noTarget.aria", { page: reference(page) })
        }
      });
    }
  });
  return stubs.sort((a, b) => a.at - b.at).map((entry) => entry.stub);
}

function fullGraph(view: JourneyMapSource, journey: Journey, flow: JourneyFlow, words: JourneyMapWords): JourneyMapGraph {
  const count = journey.pages.length;
  const rootId = view.tree.id;
  const pages = journey.pages.map((page, index) => pageFacts(view, index, page.id, words));
  const arrival = (index: number): string => (index >= count ? END : (pages[index] as PageFacts).key);
  const target = (index: number): string => (index >= count ? tx(words, "journey.map.target.end") : reference(pages[index] as PageFacts));
  const routeNodeOf = (index: number, routeIndex: number): string | undefined => {
    const id = view.check.placement.pages[index]?.routes[routeIndex];
    return id !== undefined && id !== "" ? id : undefined;
  };
  const conditionWords = (expression: unknown): string => conditionText(words.condition(expression), Infinity, words.text);
  // The last page written under each id: a page sharing its id shows that page's questions
  // (the runtime keys a page's questions by its id).
  const lastWithId = new Map<string, number>();
  journey.pages.forEach((page, index) => lastWithId.set(page.id, index));

  const nodes: JourneyMapNode[] = [];
  const edges: JourneyMapEdge[] = [];
  const readingOrder: string[] = [START];
  let exits = 0;
  let branchPoints = 0;

  nodes.push({
    kind: "start",
    key: START,
    item: START,
    order: 0,
    width: JOURNEY_MAP_METRICS.pill.width,
    height: JOURNEY_MAP_METRICS.pill.height,
    select: rootId,
    text: tx(words, "journey.map.start"),
    failing: false,
    ariaLabel: count === 0 ? tx(words, "journey.map.start.empty") : tx(words, "journey.map.start.aria", { target: target(0) })
  });
  edges.push({
    key: journeyMapEdgeId({ kind: "start" }),
    from: START,
    to: arrival(0),
    kind: "start",
    order: 0,
    weight: 3,
    spine: true,
    live: count > 0,
    conditional: false,
    otherwise: false
  });

  // A step's own ways out: its drawn routes in written order, then its fall-through.
  const flowEdgesOf: JourneyFlowEdge[][] = pages.map(() => []);
  for (const edge of flow.edges) {
    flowEdgesOf[edge.from]?.push(edge);
  }

  pages.forEach((page, index) => {
    const facts = flow.pages[index]!;
    const written = journey.pages[index]!;
    const pageKey = page.key;
    const id = pageKey.slice(5);
    const select = page.nodeId !== undefined ? { select: page.nodeId } : {};
    const own = flowEdgesOf[index] ?? [];

    const content = pageContent(view, page.entry, words);
    const lastSharing = lastWithId.get(written.id) ?? index;
    const sharedWith = lastSharing > index ? pages[lastSharing] : undefined;

    // The step's ways out, each leaving its box: its drawn routes, then its fall-through.
    // Numbered whenever the step has more than one route or way out, so a stub's "4 always
    // wins" names a number the map shows.
    const waysOut = own.length;
    const numbered = waysOut >= 2 || (written.routes?.length ?? 0) >= 2;
    const chips: string[] = [];
    const leaves: string[] = [];
    let lone = "";
    const spineEdge = own.find((edge) => edge.kind === "next") ?? own.find((edge) => edge.kind === "route" && !edge.conditional);
    own.forEach((edge, at) => {
      const spine = edge === spineEdge;
      if (edge.kind === "next") {
        edges.push({
          key: journeyMapEdgeId({ kind: "next", from: id }),
          from: pageKey,
          to: arrival(edge.to),
          kind: "next",
          order: at,
          weight: 3,
          spine,
          live: edge.live,
          conditional: false,
          otherwise: edge.otherwise,
          ...select,
          ...(edge.otherwise ? { label: chip(tx(words, "journey.map.chip.otherwise"), undefined) } : {})
        });
        leaves.push(tx(words, edge.otherwise ? "journey.map.leaves.otherwise" : "journey.map.leaves.then", { target: target(edge.to) }));
        lone = tx(words, edge.otherwise ? "journey.map.leaves.otherwise" : "journey.map.leaves.thenFirst", { target: target(edge.to) });
        return;
      }
      const routeIndex = edge.routeIndex as number;
      const number = routeIndex + 1;
      const route = written.routes?.[routeIndex];
      const routeNode = routeNodeOf(index, routeIndex);
      const prefix = numbered ? `${number} · ` : "";
      const findings = routeNode !== undefined ? countFindings([view.check.findings.byNode.get(routeNode)]) : { errors: 0, warnings: 0 };
      const badge = badgeOf(findings);
      const summary = words.summary(findings);
      const how = edge.conditional
        ? tx(words, "journey.map.how.if", { condition: conditionWords(route?.when) })
        : tx(words, edge.otherwise ? "journey.map.how.otherwise" : "journey.map.how.always");
      // The one way out of a step with no condition needs no words on its line: only a small
      // handle to click. A number, a finding or any second way brings the words back.
      const bare = !numbered && !edge.conditional && !edge.otherwise && badge.badge === undefined;
      const label: JourneyMapLabel = {
        ...(edge.conditional
          ? conditionChip(`${prefix}${tx(words, "journey.map.if")} `, words.condition(route?.when), "", badge.badge, words.text)
          : bare
            ? handleChip(tx(words, "journey.map.chip.always"))
            : chip(`${prefix}${tx(words, edge.otherwise ? "journey.map.chip.otherwise" : "journey.map.chip.always")}`, badge.badge)),
        ...badge,
        ...(routeNode !== undefined
          ? { item: routeNode, ariaLabel: tx(words, "journey.map.route.aria", { number, page: reference(page), how, target: target(edge.to), summary: summary ? ` ${summary}.` : "" }) }
          : {})
      };
      if (routeNode !== undefined) {
        chips.push(routeNode);
      }
      edges.push({
        key: journeyMapEdgeId({ kind: "route", from: id, routeIndex }),
        from: pageKey,
        to: arrival(edge.to),
        kind: "route",
        order: at,
        weight: spine ? 3 : 1,
        spine,
        live: edge.live,
        conditional: edge.conditional,
        otherwise: edge.otherwise,
        routeIndex,
        ...(routeNode !== undefined ? { select: routeNode } : {}),
        label
      });
      leaves.push(tx(words, "journey.map.leaves.route", { number, how, target: target(edge.to) }));
    });

    // A branch point: a step some walk leaves by more than one way.
    if (facts.onPath && waysOut >= 2) {
      branchPoints += 1;
    }
    if (facts.exit) {
      exits += 1;
    }

    const stubs = pageStubs(view, journey, flow, pages, index, words);

    // The card.
    const m = JOURNEY_MAP_METRICS.card;
    const findings = content.findings;
    const badge = badgeOf(findings);
    const unreachable = !facts.onPath;
    // A questions step with nothing on it yet is drawn as any other: it shows only its buttons.
    const noFields = !content.any && !facts.exit && facts.review !== true;
    const notes = [...content.notes];
    if (noFields) {
      notes.push(tx(words, "journey.map.note.nothing"));
    }
    if (facts.exit) {
      notes.push(tx(words, "journey.map.note.exit"));
    }
    if (sharedWith !== undefined) {
      notes.push(tx(words, "journey.map.note.shares", { number: sharedWith.number }));
    }
    if (unreachable) {
      notes.push(tx(words, "journey.map.note.unreachable"));
    }
    const shown = Math.min(stubs.length, m.stubsShown);
    const hidden = stubs.length - shown;
    const titleLines = wrapText(page.name, m.titleWidth, m.titlePx, 2);
    const reserve = badge.badge !== undefined ? estimateTextWidth(badge.badge, m.metaPx) + 6 : 0;
    const review = facts.review === true ? reviewWhat(view, words) : undefined;
    const what = facts.exit ? tx(words, "journey.map.exitPage") : review ? review.card : countOf(words, "journey.map.questions", content.questions);
    const meta = `${written.id} · ${what}`;
    const metaLines = metaLinesOf(meta, reserve);
    const { rows, height } = cardRows(titleLines.length, metaLines.length, notes.length, shown + (hidden > 0 ? 1 : 0));

    const sentences: string[] = [
      tx(words, "journey.map.sentence.page", { number: page.number, count, name: page.name, id: written.id, what: facts.exit ? tx(words, "journey.map.exitPage.an") : review ? review.sentence : what, said: content.said })
    ];
    if (sharedWith !== undefined) {
      sentences.push(tx(words, "journey.map.sentence.shares", { page: reference(sharedWith) }));
    }
    if (noFields) {
      sentences.push(tx(words, "journey.map.sentence.nothing"));
    }
    if (unreachable) {
      sentences.push(tx(words, "journey.map.sentence.noPath"));
    }
    if (facts.exit) {
      sentences.push(tx(words, "journey.map.sentence.stops"));
    } else if (leaves.length === 1 && own[0]?.kind === "next") {
      sentences.push(`${lone}.`);
    } else if (leaves.length > 0) {
      sentences.push(tx(words, "journey.map.sentence.leaves", { leaves: leaves.join("; ") }));
    }
    if (stubs.length > 0) {
      sentences.push(tx(words, "journey.map.sentence.ignored", { routes: countOf(words, "journey.map.routes", stubs.length) }));
    }
    const summary = words.summary(findings);
    if (summary !== undefined) {
      sentences.push(`${summary}.`);
    }

    const card: JourneyMapPage = {
      kind: "page",
      key: pageKey,
      order: index + 1,
      width: m.width,
      height,
      ...(page.nodeId !== undefined ? { select: page.nodeId, item: page.nodeId } : {}),
      index,
      number: page.number,
      pageId: written.id,
      name: page.name,
      exit: facts.exit,
      unreachable,
      titleLines,
      meta,
      metaLines,
      notes: notes.map((note) => cut(note, m.titleWidth, m.metaPx)),
      findings,
      ...badge,
      stubs,
      rows,
      description: sentences.join(" ")
    };
    if (hidden > 0) {
      card.more = {
        ...(page.nodeId !== undefined ? { item: `more:${page.nodeId}` } : {}),
        text: tx(words, "journey.map.more", { count: hidden }),
        ariaLabel: tx(words, words.readOnly === true ? "journey.map.more.aria.readOnly" : "journey.map.more.aria", { routes: countOf(words, "journey.map.moreIgnored", hidden), page: reference(page), pronoun: tx(words, hidden === 1 ? "journey.map.it" : "journey.map.them") })
      };
    }
    nodes.push(card);
    if (card.item !== undefined) {
      readingOrder.push(card.item);
    }
    readingOrder.push(...chips);
    for (const stub of card.stubs.slice(0, shown)) {
      if (stub.item !== undefined) {
        readingOrder.push(stub.item);
      }
    }
    if (card.more?.item !== undefined) {
      readingOrder.push(card.more.item);
    }
  });

  const failing = !flow.ends;
  nodes.push({
    kind: "end",
    key: END,
    item: END,
    order: count + 1,
    width: failing ? JOURNEY_MAP_METRICS.pill.wideWidth : JOURNEY_MAP_METRICS.pill.width,
    height: JOURNEY_MAP_METRICS.pill.height,
    select: rootId,
    text: tx(words, failing ? "journey.map.end.failing" : "journey.map.end"),
    failing,
    ariaLabel:
      count === 0
        ? tx(words, "journey.map.end.aria.empty")
        : failing
          ? tx(words, "journey.map.end.aria.failing")
          : tx(words, "journey.map.end.aria.submits")
  });
  readingOrder.push(END);

  const counts = { pages: count, exits, branchPoints, errors: view.check.findings.errors, warnings: view.check.findings.warnings };
  return { stale: false, status: statusOf(counts, words), bar: barOf(counts, words), label: labelOf(counts, words), ...readOnlyOf(words), counts, nodes, edges, readingOrder };
}

function statusOf(counts: JourneyMapGraph["counts"], words: JourneyMapWords): string {
  const parts = [countOf(words, "journey.map.pages", counts.pages)];
  if (counts.exits > 0) {
    parts.push(countOf(words, "journey.map.exits", counts.exits));
  }
  if (counts.branchPoints > 0) {
    parts.push(countOf(words, "journey.map.branchPoints", counts.branchPoints));
  }
  const summary = words.summary(counts);
  if (summary !== undefined) {
    parts.push(summary);
  }
  return parts.join(" · ");
}

/** The bar's counts: the steps, then errors and warnings only when there are some, from the journey's own findings. */
function barOf(counts: JourneyMapGraph["counts"], words: JourneyMapWords): string {
  const parts = [countOf(words, "journey.map.pages", counts.pages)];
  if (counts.errors > 0) {
    parts.push(countOf(words, "journey.map.errors", counts.errors));
  }
  if (counts.warnings > 0) {
    parts.push(countOf(words, "journey.map.warnings", counts.warnings));
  }
  return parts.join(" · ");
}

function labelOf(counts: JourneyMapGraph["counts"], words: JourneyMapWords): string {
  const exits = counts.exits > 0 ? tx(words, "journey.map.label.exits", { exits: countOf(words, "journey.map.exits", counts.exits) }) : "";
  return tx(words, words.readOnly === true ? "journey.map.label.readOnly" : "journey.map.label", { name: words.journeyName, pages: countOf(words, "journey.map.pages", counts.pages), exits });
}

function readOnlyOf(words: JourneyMapWords): { readOnly?: true } {
  return words.readOnly === true ? { readOnly: true } : {};
}

/** The pages of the tree with no edges: before any journey could be written, or with no graph facts. */
function pagesOnlyGraph(view: JourneyMapSource, words: JourneyMapWords, stale: boolean, problem: string | undefined): JourneyMapGraph {
  const rootId = view.tree.id;
  const m = JOURNEY_MAP_METRICS.card;
  const total = view.index.pages.length;
  const nodes: JourneyMapNode[] = [
    {
      kind: "start",
      key: START,
      item: START,
      order: 0,
      width: JOURNEY_MAP_METRICS.pill.width,
      height: JOURNEY_MAP_METRICS.pill.height,
      select: rootId,
      text: tx(words, "journey.map.start"),
      failing: false,
      ariaLabel: tx(words, "journey.map.start.of")
    }
  ];
  const readingOrder = [START];
  let exits = 0;
  view.index.pages.forEach((entry, index) => {
    const name = words.pageName(entry);
    const exit = configurationOf(entry.node).kind === "exit";
    if (exit) {
      exits += 1;
    }
    const content = pageContent(view, entry, words);
    const { findings } = content;
    const badge = badgeOf(findings);
    const titleLines = wrapText(name, m.titleWidth, m.titlePx, 2);
    const review = configurationOf(entry.node).kind === "review" ? reviewWhat(view, words) : undefined;
    const noFields = !content.any && !exit && review === undefined;
    const notes = [...(noFields ? [tx(words, "journey.map.note.nothing")] : []), ...content.notes, ...(exit ? [tx(words, "journey.map.note.exit")] : [])];
    const what = exit ? tx(words, "journey.map.exitPage") : review ? review.card : countOf(words, "journey.map.questions", content.questions);
    const reserve = badge.badge !== undefined ? estimateTextWidth(badge.badge, m.metaPx) + 6 : 0;
    const meta = `${entry.pageId} · ${what}`;
    const metaLines = metaLinesOf(meta, reserve);
    const { rows, height } = cardRows(titleLines.length, metaLines.length, notes.length, 0);
    nodes.push({
      kind: "page",
      key: `page:${entry.nodeId}`,
      order: index + 1,
      width: m.width,
      height,
      select: entry.nodeId,
      item: entry.nodeId,
      index,
      number: entry.number,
      pageId: entry.pageId,
      name,
      exit,
      unreachable: false,
      titleLines,
      meta,
      metaLines,
      notes,
      findings,
      ...badge,
      stubs: [],
      rows,
      description: [
        tx(words, "journey.map.sentence.page", { number: entry.number, count: total, name, id: entry.pageId, what: exit ? tx(words, "journey.map.exitPage.an") : review ? review.sentence : what, said: content.said }),
        ...(noFields ? [tx(words, "journey.map.sentence.nothing")] : [])
      ].join(" ")
    });
    readingOrder.push(entry.nodeId);
  });
  nodes.push({
    kind: "end",
    key: END,
    item: END,
    order: total + 1,
    width: JOURNEY_MAP_METRICS.pill.width,
    height: JOURNEY_MAP_METRICS.pill.height,
    select: rootId,
    text: tx(words, "journey.map.end"),
    failing: false,
    ariaLabel: tx(words, "journey.map.end.of")
  });
  readingOrder.push(END);
  const counts = { pages: total, exits, branchPoints: 0, errors: view.check.findings.errors, warnings: view.check.findings.warnings };
  const graph: JourneyMapGraph = { stale, status: statusOf(counts, words), bar: barOf(counts, words), label: labelOf(counts, words), ...readOnlyOf(words), counts, nodes, edges: [], readingOrder };
  if (problem !== undefined) {
    graph.problem = problem;
  }
  return graph;
}

/**
 * `previous` kept while the tree cannot be written: marked stale, with `problem`, and with every
 * select and item naming a node the tree no longer has taken away — edits go on while the tree
 * is unwritable, and a click must not select a node that is gone.
 */
export function staleJourneyMapGraph(previous: JourneyMapGraph, view: JourneyMapSource, problem: string | undefined): JourneyMapGraph {
  const known = new Set<string>(view.index.pageOf.keys());
  known.add(view.tree.id);
  const keep = <T extends { select?: string; item?: string }>(value: T, itemIsNode: boolean): T => {
    const out = { ...value };
    if (out.select !== undefined && !known.has(out.select)) {
      delete out.select;
    }
    if (itemIsNode && out.item !== undefined && !known.has(out.item)) {
      delete out.item;
    }
    return out;
  };
  const nodes: JourneyMapNode[] = previous.nodes.map((node) => {
    if (node.kind === "page") {
      const page = keep(node, true);
      page.stubs = page.stubs.map((stub) => keep(stub, true));
      if (page.more !== undefined && page.item === undefined) {
        const { item: _gone, ...more } = page.more;
        page.more = more;
      }
      return page;
    }
    return keep(node, false);
  });
  const edges = previous.edges.map((edge) => {
    const out = keep(edge, false);
    if (out.label !== undefined) {
      const label = keep(out.label, true);
      if (label.item === undefined) {
        delete label.ariaLabel;
      }
      out.label = label;
    }
    return out;
  });
  const items = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "page") {
      if (node.item !== undefined) {
        items.add(node.item);
      }
      for (const stub of node.stubs) {
        if (stub.item !== undefined) {
          items.add(stub.item);
        }
      }
      if (node.more?.item !== undefined) {
        items.add(node.more.item);
      }
    } else {
      items.add(node.item);
    }
  }
  for (const edge of edges) {
    if (edge.label?.item !== undefined) {
      items.add(edge.label.item);
    }
  }
  const graph: JourneyMapGraph = {
    ...previous,
    stale: true,
    nodes,
    edges,
    readingOrder: previous.readingOrder.filter((item) => items.has(item))
  };
  if (problem !== undefined) {
    graph.problem = problem;
  } else {
    delete graph.problem;
  }
  return graph;
}

/**
 * The lines the highlight of `key` lights (an item's key, or `edge:<key>` for a line): a chip's
 * own line; for Start, End or a step, every line into and out of it.
 */
export function journeyMapLitEdges(graph: JourneyMapGraph, key: string): Set<string> {
  const chip = key.startsWith("edge:") ? key.slice(5) : graph.edges.find((edge) => edge.label?.item === key)?.key;
  if (chip !== undefined) {
    return new Set([chip]);
  }
  const out = new Set<string>();
  const node = graph.nodes.find(
    (candidate) => candidate.item === key || (candidate.kind === "page" && (candidate.stubs.some((stub) => stub.item === key) || candidate.more?.item === key))
  );
  if (node !== undefined) {
    for (const edge of graph.edges) {
      if (edge.from === node.key || edge.to === node.key) {
        out.add(edge.key);
      }
    }
  }
  return out;
}

/** The layout's input for `graph` drawn as `layout` asks. */
export function journeyMapLayoutInput(graph: JourneyMapGraph, layout: JourneyMapLayout): FlowLayoutInput {
  return {
    nodes: graph.nodes.map((node) => ({
      key: node.key,
      order: node.order,
      width: node.width,
      height: node.height,
      shape: node.kind === "page" ? "box" : "pill"
    })),
    edges: graph.edges.map((edge) => ({
      key: edge.key,
      from: edge.from,
      to: edge.to,
      order: edge.order,
      weight: edge.weight,
      spine: edge.spine,
      ...(edge.label !== undefined ? { label: { width: edge.label.width, height: edge.label.height } } : {})
    })),
    direction: layout.direction
  };
}
