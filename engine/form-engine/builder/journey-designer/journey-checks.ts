/**
 * What is wrong with the journey on the designer's canvas, and where to say so.
 *
 * `diagnoseJourney` judges a `Journey`: its findings name a page by its page id, a
 * route by its position among the page's routes, a question by its component id. The designer's
 * tree names nodes by internal ids (`journey-tree.ts`), page ids may repeat, and a route with no
 * target yet is left out of the journey written, so neither a page id nor a route's position
 * finds its node on its own. The journey is therefore written from a copy of the tree whose
 * pages and routes each carry their node id under a key of their own — a key the writer keeps,
 * as it keeps every key it does not know — and the findings are placed through it:
 *
 * | Finding carries                         | Drawn on                                              |
 * |-----------------------------------------|-------------------------------------------------------|
 * | the journey only (`journey.*`)          | the root                                              |
 * | a page (`page.*`)                       | the page at its position (`pageIndex`), else the first page with that id (`page.duplicate-id`: the page repeating it) |
 * | a page and a route (`route.*`, a route's `condition.*`) | that route of that page, by position too |
 * | a node of the journey's own (`ownNodeId`; `presentation.entry-unusable`'s `entryId`) | that node, on the finding's page (any page when it names none), however deep in a layout of the journey's own; where the tree has no such node, as if it named none; about a later one of several sharing an id on the page, marked with its place among them (`repeat`) |
 * | a page and a component (`page.unknown-component`, `page.entry-field`, `page.root-component`) | the first question on that page listing it, inside a layout of the journey's own too |
 * | a component only                        | `component.unassigned`, `component.hidden-required` and `calc.input-left-out` in the tray (the last under the input a page can ask); `component.multiple-pages` on every question listing it; the rest on the root |
 *
 * A route condition's findings stay there even when they name a node of the journey's own (a
 * condition reading one, say): the route is what to fix. A finding
 * on a node of the journey's own counts like any other, in the totals and for its page.
 *
 * Findings are advisory: nothing here holds a Save back (only a page id the draft changes to a
 * taken one does, `journey-components.ts`). Declared journeys the catalog keeps without listing
 * (`unlistedJourneysOf`) are the root's findings too: a later journey with this one's id, which
 * nothing can open, and journeys that cannot be read at all.
 *
 * In the designer's lazy chunk (the only place the builder reaches `journey-diagnostics.ts`);
 * nothing here runs at import.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { Journey } from "../../core/schema/journey.js";
import { diagnoseJourney, type JourneyDiagnostic } from "../../core/journey/journey-diagnostics.js";
import { journeyOwnership } from "../../core/journey/journey-path.js";
import type { JourneyOwnership } from "../../core/journey/journey-types.js";
import type { UnlistedJourney } from "./journey-catalog.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderPlural, builderText } from "./journey-texts-en.js";
import { wordDiagnostic, type FindingNames } from "./journey-finding-words.js";
import {
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_ROUTES_SLOT,
  writtenPageId
} from "./journey-mode-model.js";
import { journeyFromTree, type JourneyFromTreeOptions } from "./journey-tree.js";

/** One finding as the canvas draws it. */
export interface JourneyFinding {
  severity: "error" | "warning";
  /** A `JourneyDiagnosticCode`, or the designer's own (`journey.unwritable`, `journey.unreadable`). */
  code: string;
  message: string;
  /**
   * `component.unassigned` of a field the form requires: the tray's error, with its
   * fix-its. Also `component.hidden-required` (a required field hidden for good, wherever it
   * sits) and a `calc.input-left-out` error (the input of a required calculation, on no page).
   */
  required?: boolean;
  /**
   * With `required`: the field whose Required makes it so (the member itself, the first a page
   * can ask inside a container reported whole, or the calculated field an input feeds): what
   * "Make it optional on the form" opens.
   */
  requiredField?: string;
  /** With `required`: that field is hidden on the form for good, so no page can ask it and the tray offers no "Ask it here". */
  hidden?: boolean;
  /** `component.unassigned` of a field held to its Required only as the host decides: neither side enforces it through this journey. */
  hostBound?: boolean;
  /**
   * On a finding drawn on a node of the journey's own whose id earlier own nodes on its page
   * share (`ownNodeRepeat`): how many of them come before the node it is about. It is
   * kept under the id with the others, so a face drawing each of those nodes shows the findings
   * whose `repeat` is its own place among them (absent: the first), and the first node never
   * shows that a later one repeats its id.
   */
  repeat?: number;
}

/** A journey's findings, each where it applies. */
export interface PlacedJourneyFindings {
  /** About the journey as a whole: the root's face. */
  root: JourneyFinding[];
  /** About a page, a question or a route: by the designer's node id. */
  byNode: Map<string, JourneyFinding[]>;
  /**
   * The tray's findings, by form component id: `component.unassigned` (the questions on no
   * page), `component.hidden-required` and `calc.input-left-out`.
   */
  unassigned: Map<string, JourneyFinding[]>;
  errors: number;
  warnings: number;
}

/** Where the written journey's pages and routes came from: the node behind each. */
export interface JourneyNodePlacement {
  /** One per page written, in order: its node, its page id, and the node behind each route written. */
  pages: ReadonlyArray<{ nodeId: string; pageId: string; routes: readonly string[] }>;
  /** The tree the journey was written from, for the questions on each page. */
  tree: ComponentNode;
}

/** One page of the designer's tree, as the faces and pickers speak of it. */
export interface JourneyPageEntry {
  nodeId: string;
  /** 1-based, in the tree's order: what the canvas calls it ("Page 2"). */
  number: number;
  /** The id the page is written under: its `pageId`, else its node id. */
  pageId: string;
  node: ComponentNode;
}

/** The designer's tree, indexed once for the faces, the pickers and the outline. */
export interface JourneyTreeIndex {
  pages: JourneyPageEntry[];
  /**
   * Page node id -> the page; the id of every node in a page — a question, a route, a node of
   * the journey's own and everything in its layouts — -> the page holding it.
   */
  pageOf: Map<string, JourneyPageEntry>;
  /** Form component id -> the numbers of the pages asking it — at the top of the page or inside a layout of the journey's own — in order. */
  pagesListing: Map<string, number[]>;
}

/** The journey the tree writes, and what is wrong with it, placed. */
export interface JourneyCheck {
  /** The journey as it would be written; `undefined` when the tree cannot be (see `problems`). */
  journey: Journey | undefined;
  /** Why the tree cannot be written (`validateJourneyShape`'s words); empty when it can. */
  problems: string[];
  findings: PlacedJourneyFindings;
  placement: JourneyNodePlacement;
  /**
   * The shared ownership of the journey written (`journeyOwnership`): which own
   * entries are in use, what each fills and works out — what the flow map's cards say of them.
   * Absent when the tree cannot be written.
   */
  ownership?: JourneyOwnership;
}

export interface CheckJourneyTreeOptions {
  /** The builder's locale and catalog for the findings' words; English when absent. */
  text?: BuilderTextOptions | undefined;
  /** The entry's node id -> page id memory (see `journey-tree.ts`); read, never changed here. */
  pageIds?: ReadonlyMap<string, string> | undefined;
  /** The entry's route-link memory (see `journey-tree.ts`); read, never changed here. */
  routeLinks?: ReadonlyMap<string, string> | undefined;
  /** The entry's memory of references as written (see `journey-tree.ts`); read, never changed here. */
  references?: ReadonlyMap<string, Record<string, unknown>> | undefined;
  /** Declared journeys the catalog keeps without listing: those naming this journey's id, and the unreadable ones, are the root's findings. */
  unlisted?: readonly UnlistedJourney[] | undefined;
  /** Which components hold no answer beyond the engine's own (the mode's `isValueless`), for the findings (`diagnoseJourney`). */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
  /**
   * What the author called the steps and the fields: given, each finding is said as the builder says it (a step by its
   * name, a field by its label, "step" for "page"; `journey-finding-words.ts`). Absent, the diagnostics' own words.
   */
  names?: FindingNames | undefined;
}

/** The key a page or route of the copy carries its node id under. Not a journey key; stripped before the journey is handed on. */
const NODE_MARK = "__datumJourneyNode";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

function slotChildren(node: ComponentNode, slotId: string, type: string): ComponentNode[] {
  return (node.children?.[slotId] ?? []).filter((child) => child.type === type);
}

/** Whether a node is one of the designer's own (the root, a page, a question, a route), not a node of the journey's own. */
function isDesignerNode(node: ComponentNode): boolean {
  return node.type === JOURNEY_ROOT_TYPE || node.type === JOURNEY_PAGE_TYPE || node.type === JOURNEY_FIELD_TYPE || node.type === JOURNEY_ROUTE_TYPE;
}

/** Every node in `node`'s slots, all the way down — a node of the journey's own nests — in document order, with a stack of its own. */
function nodesWithin(node: ComponentNode): ComponentNode[] {
  const out: ComponentNode[] = [];
  const stack: ComponentNode[] = Object.values(node.children ?? {})
    .flat()
    .reverse();
  while (stack.length > 0) {
    const next = stack.pop() as ComponentNode;
    out.push(next);
    const children = Object.values(next.children ?? {}).flat();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  return out;
}

/** The questions of a page — its own and those inside its layouts — in document order. */
function questionsOf(page: ComponentNode): ComponentNode[] {
  return nodesWithin(page).filter((node) => node.type === JOURNEY_FIELD_TYPE);
}

/** The page nodes of a designer tree, in order. */
export function journeyPageNodes(root: ComponentNode): ComponentNode[] {
  return slotChildren(root, JOURNEY_PAGES_SLOT, JOURNEY_PAGE_TYPE);
}

export { writtenPageId };

/** Indexes the designer's tree: its pages in order, which page holds each question and route, where each form component is listed. */
export function indexJourneyTree(root: ComponentNode): JourneyTreeIndex {
  const pages: JourneyPageEntry[] = [];
  const pageOf = new Map<string, JourneyPageEntry>();
  const pagesListing = new Map<string, number[]>();
  journeyPageNodes(root).forEach((node, at) => {
    const entry: JourneyPageEntry = { nodeId: node.id, number: at + 1, pageId: writtenPageId(node), node };
    pages.push(entry);
    pageOf.set(node.id, entry);
    for (const child of nodesWithin(node)) {
      pageOf.set(child.id, entry);
    }
    for (const question of questionsOf(node)) {
      const componentId = configurationOf(question).componentId;
      if (typeof componentId === "string" && componentId !== "") {
        const listing = pagesListing.get(componentId) ?? [];
        if (!listing.includes(entry.number)) {
          listing.push(entry.number);
        }
        pagesListing.set(componentId, listing);
      }
    }
  });
  return { pages, pageOf, pagesListing };
}

/** A copy of the tree whose pages and routes carry their node ids, for {@link checkJourneyTree}. */
function markedTree(root: ComponentNode): ComponentNode {
  const mark = (node: ComponentNode): ComponentNode => ({ ...node, configuration: { ...configurationOf(node), [NODE_MARK]: node.id } });
  return {
    ...root,
    children: {
      ...(root.children ?? {}),
      [JOURNEY_PAGES_SLOT]: (root.children?.[JOURNEY_PAGES_SLOT] ?? []).map((page) =>
        page.type !== JOURNEY_PAGE_TYPE
          ? page
          : {
              ...mark(page),
              children: {
                ...(page.children ?? {}),
                [JOURNEY_ROUTES_SLOT]: (page.children?.[JOURNEY_ROUTES_SLOT] ?? []).map((route) => (route.type === JOURNEY_ROUTE_TYPE ? mark(route) : route))
              }
            }
      )
    }
  };
}

/** The journey with the node marks taken out again, and where each page and route came from. */
function unmarked(marked: Journey, tree: ComponentNode): { journey: Journey; placement: JourneyNodePlacement } {
  const pages: Array<{ nodeId: string; pageId: string; routes: string[] }> = [];
  const journey: Journey = {
    ...marked,
    pages: marked.pages.map((page) => {
      const { [NODE_MARK]: pageMark, ...rest } = page as unknown as Record<string, unknown>;
      const routes: string[] = [];
      const clean = rest as unknown as Journey["pages"][number];
      if (page.routes) {
        clean.routes = page.routes.map((route) => {
          const { [NODE_MARK]: routeMark, ...routeRest } = route as unknown as Record<string, unknown>;
          routes.push(typeof routeMark === "string" ? routeMark : "");
          return routeRest as unknown as NonNullable<Journey["pages"][number]["routes"]>[number];
        });
      }
      pages.push({ nodeId: typeof pageMark === "string" ? pageMark : "", pageId: page.id, routes });
      return clean;
    })
  };
  return { journey, placement: { pages, tree } };
}

/**
 * The journey the tree holds, as `journeyFromTree` writes it, and which node each page and route
 * was written from — what the findings are placed through, and what the preview keys its pages
 * by (`journey-preview.ts`). `undefined` when the tree cannot be written, after `onError`.
 */
export function journeyFromTreePlaced(
  tree: ComponentNode,
  journeyId: string,
  options: JourneyFromTreeOptions = {}
): { journey: Journey; placement: JourneyNodePlacement } | undefined {
  const marked = journeyFromTree(markedTree(tree), journeyId, options);
  return marked ? unmarked(marked, tree) : undefined;
}

/** The codes about a page and one component on it that belong to that component's question. */
const QUESTION_CODES: readonly string[] = ["page.unknown-component", "page.entry-field", "page.root-component", "page.review-form-field"];

/** The codes about a form component the tray draws, with their fix-its. */
const TRAY_CODES: readonly string[] = ["component.unassigned", "component.hidden-required", "calc.input-left-out"];

/** Places `diagnostics` on the nodes they concern (see the module comment). */
export function placeJourneyFindings(diagnostics: readonly JourneyDiagnostic[], placement: JourneyNodePlacement): PlacedJourneyFindings {
  const placed: PlacedJourneyFindings = { root: [], byNode: new Map(), unassigned: new Map(), errors: 0, warnings: 0 };
  const treePages = new Map(journeyPageNodes(placement.tree).map((node) => [node.id, node]));
  const add = (list: Map<string, JourneyFinding[]>, key: string, finding: JourneyFinding): void => {
    const existing = list.get(key);
    if (existing) {
      existing.push(finding);
    } else {
      list.set(key, [finding]);
    }
  };
  /**
   * The page a finding is about: the one at its position when it names one (`pageIndex`), so
   * a page repeating an id carries its own findings; else the first page written
   * under its id, as routes find it.
   */
  const pageFor = (diagnostic: JourneyDiagnostic): (typeof placement.pages)[number] | undefined => {
    const { pageId, pageIndex } = diagnostic;
    if (pageId === undefined) {
      return undefined;
    }
    const placed = pageIndex !== undefined ? placement.pages[pageIndex] : undefined;
    return placed !== undefined && placed.pageId === pageId ? placed : placement.pages.find((page) => page.pageId === pageId);
  };
  const questionsListing = (pageNodeId: string | undefined, componentId: string): string[] => {
    const pages = pageNodeId !== undefined ? [treePages.get(pageNodeId)] : [...treePages.values()];
    return pages.flatMap((page) =>
      page ? questionsOf(page).filter((question) => configurationOf(question).componentId === componentId).map((question) => question.id) : []
    );
  };
  /**
   * The node of the journey's own a finding is about, when the tree holds it: the one
   * its `ownNodeId` names, else — for `presentation.entry-unusable` — the entry its `entryId`
   * names; looked for on the finding's page, or on every page when it names none.
   */
  const ownNodeFor = (diagnostic: JourneyDiagnostic, pageNodeId: string | undefined): string | undefined => {
    const named = diagnostic.ownNodeId;
    const nodeId = named !== undefined && named !== "" ? named : diagnostic.code === "presentation.entry-unusable" ? diagnostic.entryId : undefined;
    if (nodeId === undefined) {
      return undefined;
    }
    const pages = pageNodeId !== undefined ? [treePages.get(pageNodeId)] : [...treePages.values()];
    return pages.some((page) => page !== undefined && nodesWithin(page).some((node) => node.id === nodeId && !isDesignerNode(node))) ? nodeId : undefined;
  };

  for (const diagnostic of diagnostics) {
    // The journey-wide count of fields left out says again what each field's own warning says: the card lists those, once.
    if (diagnostic.code === "presentation.fields-left-out") {
      continue;
    }
    const finding: JourneyFinding = {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.required !== undefined ? { required: diagnostic.required } : {}),
      ...(diagnostic.requiredField !== undefined ? { requiredField: diagnostic.requiredField } : {}),
      ...(diagnostic.hidden !== undefined ? { hidden: diagnostic.hidden } : {}),
      ...(diagnostic.hostBound !== undefined ? { hostBound: diagnostic.hostBound } : {})
    };
    if (diagnostic.severity === "error") {
      placed.errors += 1;
    } else {
      placed.warnings += 1;
    }
    const page = pageFor(diagnostic);
    if (page && diagnostic.code === "page.duplicate-id") {
      // Said of the pages that repeat an id, which routes never reach, not of the first: each
      // on its own when the finding says where it is, else on every repeat.
      if (diagnostic.pageIndex !== undefined && page === placement.pages[diagnostic.pageIndex]) {
        add(placed.byNode, page.nodeId, finding);
        continue;
      }
      const repeats = placement.pages.filter((entry) => entry.pageId === page.pageId).slice(1);
      for (const repeat of repeats.length > 0 ? repeats : [page]) {
        add(placed.byNode, repeat.nodeId, finding);
      }
      continue;
    }
    if (page) {
      if (diagnostic.routeIndex !== undefined) {
        const routeNode = page.routes[diagnostic.routeIndex];
        add(placed.byNode, routeNode !== undefined && routeNode !== "" ? routeNode : page.nodeId, finding);
        continue;
      }
    }
    // About a node of the journey's own: on that node, wherever it sits on the page.
    const own = ownNodeFor(diagnostic, page?.nodeId);
    if (own !== undefined) {
      add(placed.byNode, own, diagnostic.ownNodeRepeat !== undefined ? { ...finding, repeat: diagnostic.ownNodeRepeat } : finding);
      continue;
    }
    if (page) {
      if (diagnostic.componentId !== undefined && QUESTION_CODES.includes(diagnostic.code)) {
        const [question] = questionsListing(page.nodeId, diagnostic.componentId);
        add(placed.byNode, question ?? page.nodeId, finding);
        continue;
      }
      add(placed.byNode, page.nodeId, finding);
      continue;
    }
    if (TRAY_CODES.includes(diagnostic.code) && diagnostic.componentId !== undefined) {
      add(placed.unassigned, diagnostic.componentId, finding);
      continue;
    }
    // On every question asking the field: a field on several pages, or a required one asked only where some paths skip.
    if (diagnostic.code === "component.multiple-pages" && diagnostic.componentId !== undefined) {
      const questions = questionsListing(undefined, diagnostic.componentId);
      if (questions.length > 0) {
        for (const question of questions) {
          add(placed.byNode, question, finding);
        }
        continue;
      }
    }
    placed.root.push(finding);
  }
  return placed;
}

/** The root's findings about declared journeys the catalog keeps without listing. */
function unlistedFindings(journeyId: string, unlisted: readonly UnlistedJourney[], text?: BuilderTextOptions): JourneyFinding[] {
  const out: JourneyFinding[] = [];
  const sameId = unlisted.filter((entry) => entry.reason === "duplicate-id" && entry.id === journeyId).length;
  if (sameId > 0) {
    out.push({
      severity: "error",
      code: "journey.duplicate-id",
      message: builderPlural("journey.check.duplicate", sameId, { journeys: builderPlural("journey.check.laterJourneys", sameId, undefined, text), id: journeyId }, text)
    });
  }
  const unreadable = unlisted.filter((entry) => entry.reason === "unreadable");
  if (unreadable.length > 0) {
    const first = unreadable[0]!;
    out.push({
      severity: "warning",
      code: "journey.unreadable",
      message: builderPlural("journey.check.unreadable", unreadable.length, { problem: first.problems.length > 0 ? ` (${first.problems[0]})` : "" }, text)
    });
  }
  return out;
}

/**
 * Writes the designer's tree as a journey, diagnoses it over the form under `formRoot`, and
 * places the findings. A tree that cannot be written (a route condition that is not an expression,
 * a value no select offers) gives no journey, and says why as a root finding.
 */
export function checkJourneyTree(formRoot: ComponentNode, tree: ComponentNode, journeyId: string, options: CheckJourneyTreeOptions = {}): JourneyCheck {
  let problems: string[] = [];
  // Copies of the memory: writing records the page ids it wrote and the routes it linked, and a check must not.
  const written = journeyFromTreePlaced(tree, journeyId, {
    pageIds: new Map(options.pageIds ?? []),
    routeLinks: new Map(options.routeLinks ?? []),
    references: new Map(options.references ?? []),
    onError: (found) => {
      problems = found;
    }
  });
  const extra = unlistedFindings(journeyId, options.unlisted ?? [], options.text);
  if (!written) {
    const findings: PlacedJourneyFindings = {
      root: [
        {
          severity: "error",
          code: "journey.unwritable",
          message: builderText("journey.check.unwritable", { problems: problems.join("; ") }, options.text)
        },
        ...extra
      ],
      byNode: new Map(),
      unassigned: new Map(),
      errors: 1,
      warnings: 0
    };
    for (const finding of extra) {
      findings[finding.severity === "error" ? "errors" : "warnings"] += 1;
    }
    return { journey: undefined, problems, findings, placement: { pages: [], tree } };
  }
  const { journey, placement } = written;
  const diagnostics = diagnoseJourney(formRoot, journey, { isValueless: options.isValueless });
  const { names } = options;
  const findings = placeJourneyFindings(names ? diagnostics.map((diagnostic) => ({ ...diagnostic, message: wordDiagnostic(diagnostic, names) })) : diagnostics, placement);
  findings.root.unshift(...extra);
  for (const finding of extra) {
    findings[finding.severity === "error" ? "errors" : "warnings"] += 1;
  }
  return { journey, problems, findings, placement, ownership: journeyOwnership(formRoot, journey) };
}

/** "2 errors, 3 warnings", or `undefined` for none. */
export function findingsSummary(findings: Pick<PlacedJourneyFindings, "errors" | "warnings">, text?: BuilderTextOptions): string | undefined {
  const parts: string[] = [];
  if (findings.errors > 0) {
    parts.push(builderPlural("journey.check.errors", findings.errors, undefined, text));
  }
  if (findings.warnings > 0) {
    parts.push(builderPlural("journey.check.warnings", findings.warnings, undefined, text));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}
