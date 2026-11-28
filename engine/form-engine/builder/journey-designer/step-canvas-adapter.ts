/**
 * One journey step on the Form canvas in edit mode: what the
 * Journeys workspace's Step view draws (`step-view.ts` builds it). Belongs in the designer
 * chunk: it imports only types, `journey-mode-model.ts` (static) and nothing of the canvas.
 *
 * The canvas keeps ONE controller, the journey's: its tree holds the step's membership and
 * order, so selection, drag, the selection bar's Move/Duplicate/Delete and undo of a move are
 * the journey controller's own. What the canvas draws is not the journey tree but a step root
 * built from it, handed to the journey controller as three options:
 *
 * - `canvasRoot` ({@link StepCanvas.canvasRoot}): the root is the page node (its id), typed and
 *   configured as the form's root, with one slot (`content`, the page's own slot id), so a drop
 *   on the step lands in the page's `content`;
 * - `canvasView` ({@link StepCanvas.canvasView}): the controller builds the view of that root as
 *   it builds its own tree view, and this prunes it (a placed form container's slots are the
 *   form's) and names each node as the journey node it stands for;
 * - `canvasJourneyView` ({@link StepCanvas.journeyView}): the page the renderer draws the root as
 *   (heading, counter, Back, Continue), never saved;
 * - the chrome: `canvasTags` ({@link StepCanvas.tags}, a journey-only field's "Not sent"),
 *   `canvasRegionOwner` ({@link StepCanvas.regionOwner}, the step's heading and buttons select
 *   the page node) and `canvasSelectTarget` ({@link StepCanvas.selectTargets}, a field inside a
 *   placed form container is the placement's). Each takes the caller's words where
 *   it words anything; make the three functions once, so the options keep their identity;
 * - the inspector: {@link createStepInspection} is what the mode answers as
 *   `BuilderMode.inspection` / `subscribeInspection` / `inspectorActions`, so a placement is
 *   edited on the FORM controller and offers "Take it off this step".
 *
 * In the drawn root:
 * - a placement (`journey-field_n`, a form field on the step) is drawn under ITS OWN node id
 *   with the form field's type, configuration and subtree, as the person sees it; the form id is
 *   read back through {@link StepCanvas.roles};
 * - a node of the journey's own (a journey-only field, an alias with `fills`) is drawn as it
 *   stands, rules stripped (as `journeyCanvasRoot` does), so the binding draws the real field;
 * - a worked-out value (`journey-value`) is drawn as the form field it works out (its type and
 *   configuration, its own label over the field's), as the runtime's combined root does.
 *
 * Rules are stripped from every drawn node: the value paths of a placement are not the form
 * field's (they sit under the journey node id), so a form rule would read the wrong answers.
 *
 * A Check answers step (`kind: "review"`) draws the engine's own review over the form: it
 * places no form field, so what the engine drops there is not drawn (a placement, an own node
 * holding one), and its page carries the whole journey (`journey`, `path`, `pageOf`) so the
 * list the renderer builds names the answers the steps ask. The form itself rides in a second
 * slot of the root ({@link REVIEW_ANSWERS_SLOT}), never a member of the page: the renderer lists
 * from it and draws none of it, the listed fields answering a placeholder (`step-review.ts`).
 *
 * No id is ever drawn twice (a tree with one would not be read, `ComponentTree`): every drawn id
 * is checked against one set, the form's ids and the journey's own alike, in drawing order. What
 * would be drawn a second time is left out, with what it holds, and said as a finding on the
 * journey node that drew without it ({@link StepCanvas.findings}).
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { Journey, JourneyPage, JourneyPageKind } from "../../core/schema/journey.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { BuilderController, CanvasViewTools } from "../controller/builder-controller.js";
import type { BuilderInspectorAction, BuilderModeInspection } from "../web-component/builder-modes.js";
import type { NestedTreeNodeView, NestedTreeSlotView } from "../tree-editor/nested-tree-view.js";
import type { JourneyFinding } from "./journey-checks.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_PAGES_SLOT, JOURNEY_PAGE_TYPE, writtenPageId } from "./journey-mode-model.js";
import { journeyFromTree } from "./journey-tree.js";
import {
  REVIEW_ANSWERS_SLOT,
  reviewAnswersForm,
  reviewDropsEntry,
  reviewListedIds,
  reviewPageOf,
  reviewRowComponent,
  reviewRowIdPrefix
} from "./step-review.js";

/** The `type` of a worked-out value (`PRESENTATION_VALUE_TYPE`), spelled here to import nothing of the schema's values. */
const WORKED_OUT_TYPE = "journey-value";

/** The code of a finding about ids left out of the step's drawing: the engine's own for a form field a page shows twice. */
export const STEP_DRAWN_TWICE_CODE = "component.placed-twice";

export interface StepCanvasContext {
  /** The form as the author sees it: the FORM controller's `previewSnapshot()` (its drafts laid over). */
  formRoot(): ComponentNode;
  /** The page node on the canvas; `undefined` for the journey's first. */
  pageNodeId(): string | undefined;
  /** The catalog entry's id: what a page's texts are addressed under. */
  journeyId(): string;
  /**
   * The FORM controller's `changeRevision()`. With {@link journeyRevision} and
   * {@link pageNodeId} it is what the step is built again on: every read between two changes
   * (the canvas reads the root and its view about ten times a paint) takes the same build.
   */
  formRevision(): number;
  /** The JOURNEY controller's `changeRevision()`; see {@link formRevision}. */
  journeyRevision(): number;
  /** The answer a Check answers step's rows show while it is edited, in the builder's words. Absent: "Answer". */
  answerWord?(): string;
}

/** What one drawn node stands for. */
export type StepNodeRole =
  | { role: "step"; pageNodeId: string }
  /** A form field on the step: `nodeId` is the journey node (`journey-field_n`), `componentId` the form's. `repeat`: earlier placements of the same field on this step. */
  | { role: "placement"; nodeId: string; componentId: string; repeat: number }
  /** A form component inside a placed form container: drawn under its form id, owned by the placement. */
  | { role: "placed"; componentId: string; placementId: string }
  /** A node of the journey's own: a journey-only field (never sent), or an alias (`fills`). */
  | { role: "own"; nodeId: string; fills?: string | undefined }
  /** A worked-out value, drawn as the form field it works out (`to`). */
  | { role: "worked-out"; nodeId: string; to: string };

/** Where a selection of a drawn node goes. */
export interface StepSelectionRoute {
  /** What the journey controller selects (the canvas outline, the selection bar, the keyboard walk). */
  journeyNodeId: string | undefined;
  /** What the inspector edits, and on which controller. */
  inspect:
    | { controller: "form"; componentId: string; placementId: string }
    | { controller: "journey"; nodeId: string }
    | undefined;
}

/**
 * Ids the step's drawing left out because they were drawn already (see the module comment):
 * `nodeId` is the journey node that drew without them (a placement, or a node of the journey's
 * own whose own id was taken), `ids` the outermost ids left out (each with what it holds), and
 * `drawnBy` the drawn node that holds each first.
 */
export interface StepDrawnTwice {
  nodeId: string;
  ids: string[];
  drawnBy: Record<string, string>;
}

/** The words {@link StepCanvas.tags} tags with, from the caller's builder text tables (this module holds no author text). */
export interface StepTagWords {
  /** A journey-only field's tag (the authoring table's "not sent" word). */
  notSent: string;
}

/** The words {@link StepCanvas.regionOwner} names the step with, from the caller's builder text tables. */
export interface StepOwnerWords {
  /**
   * The accessible name of the step's heading and buttons on the canvas: `number` is the step's
   * place as its counter says it (absent for an exit step, which has none), `name` its title
   * (else its written id).
   */
  step(place: { number: number | undefined; name: string }): string;
}

export interface StepCanvas {
  /** `BuilderControllerOptions.canvasRoot` for the journey controller while the Step view is up. */
  canvasRoot(journeyTree: ComponentNode): ComponentNode;
  /**
   * `BuilderControllerOptions.canvasView` for the journey controller while the Step view is up:
   * the controller's view of the drawn root, pruned and named. A placement's and a worked-out
   * value's slots are left out (a placed container's children are the form's, never the step's
   * membership: no drop zone, no walk inside); each is named as the journey names its node; the
   * root is named as the step and its one slot is the page's `content`, with the page's
   * definition and allowed types. A node of the journey's own keeps its slots and allowed types.
   */
  canvasView(view: NestedTreeNodeView, tools: CanvasViewTools): NestedTreeNodeView;
  /** `BuilderControllerOptions.canvasJourneyView`: the page the renderer draws the root as (Back, the counter, the heading, Continue). */
  journeyView(journeyTree: ComponentNode): JourneyView | undefined;
  /** Every drawn id and what it stands for. */
  roles(journeyTree: ComponentNode): ReadonlyMap<string, StepNodeRole>;
  /** Where a click on a drawn node (or a selection made elsewhere) goes. */
  route(drawnId: string | undefined, journeyTree: ComponentNode): StepSelectionRoute;
  /** Each step a form field is placed on, in the journey's order: what the Form fields panel and "On a step" read. */
  placementsOf(componentId: string, journeyTree: ComponentNode): Array<{ pageNodeId: string; nodeId: string }>;
  /**
   * The drawn ids that carry a tag, and its words: a journey-only field is tagged
   * `words.notSent` (the caller's, read from the authoring table by the authoring chunk).
   * The mode hands these to the canvas hooks.
   */
  tags(journeyTree: ComponentNode, words: StepTagWords): Map<string, string>;
  /**
   * `BuilderControllerOptions.canvasSelectTarget`: each form component
   * drawn inside a placed form container -> its placement. A click on one selects the whole
   * placed group; the canvas draws it with no box, grip or bar of its own.
   */
  selectTargets(journeyTree: ComponentNode): Map<string, string>;
  /**
   * `BuilderControllerOptions.canvasRegionOwner`: the step's heading, counter, Back,
   * Continue and Submit select the step (the page node), and are named by `words.step`.
   */
  regionOwner(journeyTree: ComponentNode, words: StepOwnerWords): { id: string; label: string } | undefined;
  /** What the step's drawing left out, in drawing order (see {@link StepDrawnTwice}). */
  drawnTwice(journeyTree: ComponentNode): readonly StepDrawnTwice[];
  /**
   * {@link drawnTwice} as findings by journey node id (`PlacedJourneyFindings.byNode`'s shape), a
   * warning each, worded by `message` (the mode's, from the builder's text tables).
   */
  findings(journeyTree: ComponentNode, message: (left: StepDrawnTwice) => string): Map<string, JourneyFinding[]>;
  /** "Take it off this step": the placement out of the page, one undo step on the journey controller; the form field is untouched. */
  takeOff(journey: BuilderController, placementId: string): boolean;
  /**
   * The form component a drawn row of the shown Check answers step stands for, from the DOM id
   * the drawing gave the row; `undefined` for anything that is no row (a card, an error line, a
   * step that is not a Check answers step).
   */
  reviewRow(journeyTree: ComponentNode, elementId: string): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pagesOf(tree: ComponentNode): ComponentNode[] {
  return tree.children?.[JOURNEY_PAGES_SLOT] ?? [];
}

function formIndex(root: ComponentNode): Map<string, ComponentNode> {
  const byId = new Map<string, ComponentNode>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
    stack.push(...Object.values(node.children ?? {}).flat());
  }
  return byId;
}

interface Built {
  root: ComponentNode;
  roles: Map<string, StepNodeRole>;
  page: ComponentNode | undefined;
  /** Drawn id -> the journey node it stands for (a placement's, a worked-out value's). */
  sources: Map<string, ComponentNode>;
  drawnTwice: StepDrawnTwice[];
  /** A Check answers step's journey as written, the page the engine would show each answer on, and the step's id in it. */
  review?: { journey: Journey; pageOf: Record<string, string>; pageId: string };
}

function kindOf(node: ComponentNode): JourneyPageKind {
  const kind = configurationOf(node).kind;
  return kind === "exit" || kind === "review" ? kind : "questions";
}

export function createStepCanvas(context: StepCanvasContext): StepCanvas {
  let memo: { key: string; built: Built } | undefined;

  const pageOf = (tree: ComponentNode): ComponentNode | undefined => {
    const wanted = context.pageNodeId();
    const pages = pagesOf(tree);
    return (wanted !== undefined ? pages.find((page) => page.id === wanted) : undefined) ?? pages[0];
  };

  /**
   * The step as drawn. `tree` must be the journey controller's `previewSnapshot()` as of its
   * current revision (what every caller hands in): between two changes of either controller,
   * or of the step shown, the build made first is the answer.
   */
  const build = (tree: ComponentNode): Built => {
    const pageNodeId = context.pageNodeId();
    const key = `${context.formRevision()}\u0000${context.journeyRevision()}\u0000${pageNodeId ?? ""}`;
    if (memo && memo.key === key) {
      return memo.built;
    }
    const form = context.formRoot();
    const byId = formIndex(form);
    const roles = new Map<string, StepNodeRole>();
    const sources = new Map<string, ComponentNode>();
    const drawnTwice: StepDrawnTwice[] = [];
    const page = pageOf(tree);
    /** Every id drawn so far, form ids and the journey's own alike: the one set nothing is drawn twice against. */
    const drawn = new Map<string, string>();
    /** The form fields a placement on this step has drawn (under its journey node id), and what drew each. */
    const placedFields = new Map<string, string>();
    const placedCount = new Map<string, number>();
    const rootId = page?.id ?? `${JOURNEY_PAGE_TYPE}_none`;
    drawn.set(rootId, rootId);
    const reviewPage = page !== undefined && kindOf(page) === "review";

    const leftOut = (nodeId: string, ids: string[], drawnBy: Record<string, string>): void => {
      if (ids.length > 0) {
        drawnTwice.push({ nodeId, ids, drawnBy });
      }
    };

    /**
     * The form subtree under a placement: rules stripped, every id claimed; one drawn already
     * (under its form id, or as a placement of its own earlier on the step) is left out with
     * what it holds, so no field is drawn twice whichever of the two comes first.
     */
    const placeForm = (field: ComponentNode, placementId: string): ComponentNode => {
      const ids: string[] = [];
      const drawnBy: Record<string, string> = {};
      const copy = (node: ComponentNode): ComponentNode => {
        const { rules: _rules, children, ...rest } = node;
        const out: ComponentNode = { ...rest, configuration: structuredClone(node.configuration ?? {}) } as ComponentNode;
        if (children) {
          out.children = Object.fromEntries(
            Object.entries(children).map(([slot, held]) => [
              slot,
              held.flatMap((child) => {
                // Drawn already: under its own id (inside a container placed before), or as a
                // placement of its own before this one (under the placement's node id).
                const holder = drawn.get(child.id) ?? placedFields.get(child.id);
                if (holder !== undefined) {
                  ids.push(child.id);
                  drawnBy[child.id] = holder;
                  return [];
                }
                drawn.set(child.id, placementId);
                roles.set(child.id, { role: "placed", componentId: child.id, placementId });
                return [copy(child)];
              })
            ])
          );
        }
        return out;
      };
      const out = copy(field);
      leftOut(placementId, ids, drawnBy);
      return out;
    };

    const convert = (node: ComponentNode): ComponentNode | undefined => {
      const holder = drawn.get(node.id);
      if (holder !== undefined) {
        // The journey's own id is drawn already (a form id a placed container drew): left out, with what it holds.
        leftOut(node.id, [node.id], { [node.id]: holder });
        return undefined;
      }
      // A Check answers step asks nothing: the engine drops a placement, a worked-out value and an
      // own node holding one there, so the canvas draws none (the findings say which).
      if (reviewPage && reviewDropsEntry(node)) {
        return undefined;
      }
      const configuration = configurationOf(node);
      if (node.type === JOURNEY_FIELD_TYPE) {
        const componentId = stringOf(configuration.componentId);
        const field = byId.get(componentId);
        if (!field || field.id === form.id) {
          // A missing field (or none chosen yet) is not drawn; the findings card reports it with a Remove fix.
          return undefined;
        }
        drawn.set(node.id, node.id);
        const repeat = placedCount.get(componentId) ?? 0;
        placedCount.set(componentId, repeat + 1);
        roles.set(node.id, { role: "placement", nodeId: node.id, componentId, repeat });
        sources.set(node.id, node);
        // A field this step draws already (placed before, or inside a container placed before) is drawn again without what it holds.
        const before = placedFields.get(componentId) ?? drawn.get(componentId);
        placedFields.set(componentId, before ?? node.id);
        if (repeat > 0 || before !== undefined) {
          const top = Object.values(field.children ?? {}).flat().map((child) => child.id);
          leftOut(node.id, top, Object.fromEntries(top.map((id) => [id, drawn.get(id) ?? before ?? node.id])));
          return { id: node.id, type: field.type, configuration: structuredClone(field.configuration ?? {}) };
        }
        return { ...placeForm(field, node.id), id: node.id };
      }
      if (node.type === WORKED_OUT_TYPE) {
        const to = stringOf(configuration.to);
        const field = byId.get(to);
        roles.set(node.id, { role: "worked-out", nodeId: node.id, to });
        sources.set(node.id, node);
        if (!field) {
          return undefined;
        }
        drawn.set(node.id, node.id);
        const own = stringOf(configuration.label);
        return {
          id: node.id,
          type: field.type,
          configuration: { ...structuredClone(configurationOf(field)), ...(own !== "" ? { label: own } : {}) }
        };
      }
      // A node of the journey's own: drawn as it stands (rules stripped), what it holds converted.
      drawn.set(node.id, node.id);
      const fills = stringOf(configuration.fills);
      roles.set(node.id, { role: "own", nodeId: node.id, ...(fills !== "" ? { fills } : {}) });
      const { rules: _rules, children, ...rest } = node;
      const copy: ComponentNode = { ...rest, configuration: structuredClone(node.configuration ?? {}) } as ComponentNode;
      if (children) {
        copy.children = Object.fromEntries(
          Object.entries(children).map(([slot, held]) => [slot, held.map(convert).filter((child): child is ComponentNode => child !== undefined)])
        );
      }
      return copy;
    };

    const content = (page?.children?.[JOURNEY_CONTENT_SLOT] ?? []).map(convert).filter((node): node is ComponentNode => node !== undefined);
    const slots: Record<string, ComponentNode[]> = { [JOURNEY_CONTENT_SLOT]: content };
    let review: Built["review"];
    if (reviewPage) {
      // The whole journey as written, so the list the renderer builds is the journey's own; a
      // journey that cannot be written draws the step with no list.
      const journey = journeyFromTree(tree, context.journeyId());
      const at = pagesOf(tree).findIndex((node) => node.id === page.id);
      const written = at >= 0 ? journey?.pages[at]?.id : undefined;
      if (journey && written !== undefined) {
        const pageOf = reviewPageOf(form, journey);
        const listed = new Set(reviewListedIds(journey, pageOf).flatMap((step) => step.ids));
        slots[REVIEW_ANSWERS_SLOT] = reviewAnswersForm(form, listed, new Set(drawn.keys()), context.answerWord?.() ?? "Answer");
        review = { journey, pageOf, pageId: written };
      }
    }
    const root: ComponentNode = {
      id: rootId,
      type: form.type,
      configuration: structuredClone(form.configuration ?? {}),
      children: slots
    };
    if (page) {
      roles.set(page.id, { role: "step", pageNodeId: page.id });
    }
    const built: Built = { root, roles, page, sources, drawnTwice, ...(review ? { review } : {}) };
    memo = { key, built };
    return built;
  };

  const canvasView = (view: NestedTreeNodeView, tools: CanvasViewTools): NestedTreeNodeView => {
    const built = build(tools.root);
    const nameOf = (node: ComponentNode): string => tools.viewOf(node).label;
    const prune = (node: NestedTreeNodeView): NestedTreeNodeView => {
      const role = built.roles.get(node.id);
      if (role?.role === "placement" || role?.role === "worked-out") {
        const source = built.sources.get(node.id);
        return { ...node, ...(source ? { label: nameOf(source) } : {}), slots: [] };
      }
      return { ...node, slots: node.slots.map((slot) => ({ ...slot, children: slot.children.map(prune) })) };
    };
    const drawnContent = view.slots.find((slot) => slot.slotId === JOURNEY_CONTENT_SLOT);
    const children = (drawnContent?.children ?? []).map(prune);
    const page = built.page;
    if (!page) {
      return { ...view, slots: [{ slotId: JOURNEY_CONTENT_SLOT, definition: undefined, allowedTypes: undefined, multiple: true, children }] };
    }
    // The step's root is the page: its name, and its content slot as the page declares it (never the form root's other slots).
    const pageView = tools.viewOf({ ...page, children: { [JOURNEY_CONTENT_SLOT]: [] } });
    const declared = pageView.slots.find((slot) => slot.slotId === JOURNEY_CONTENT_SLOT);
    // A Check answers or an exit step asks no form field: its empty content is a drop zone with no
    // words, never the questions step's "Nothing asked on this step yet" (a blank `emptyHint`).
    const definition = declared?.definition && kindOf(page) !== "questions" ? { ...declared.definition, emptyHint: "" } : declared?.definition;
    const slot: NestedTreeSlotView = {
      slotId: JOURNEY_CONTENT_SLOT,
      definition,
      allowedTypes: declared?.allowedTypes,
      multiple: declared?.multiple ?? true,
      children
    };
    return { ...view, label: pageView.label, slots: [slot] };
  };

  const journeyView = (tree: ComponentNode): JourneyView | undefined => {
    const built = build(tree);
    const page = built.page;
    if (!page) {
      return undefined;
    }
    const pages = pagesOf(tree);
    const index = pages.findIndex((node) => node.id === page.id);
    // The counter counts questions and Check answers pages, as the engine's JourneyView does; an exit page has no number.
    const counted = pages.filter((node) => kindOf(node) !== "exit");
    const review = built.review;
    const { pageId: _pageId, ...pageConfiguration } = configurationOf(page);
    // A Check answers step is the page as the journey is written (its settings as the engine reads them, a select's
    // "false" a boolean), else the page as the tree holds it.
    const journeyPage = (review?.journey.pages[index] ?? { ...pageConfiguration, id: writtenPageId(page) }) as JourneyPage;
    const journey = review?.journey ?? ({ ...configurationOf(tree), id: context.journeyId(), pages: [] } as unknown as Journey);
    const ids = review ? review.journey.pages.map((entry) => entry.id) : pages.map(writtenPageId);
    const back = index > 0 ? ids[index - 1] : undefined;
    // No path while editing: the counter and Back follow the list order (the map's), the last step submits
    // (a Check answers step is always the last the path takes: the engine ends the walk there).
    return {
      journeyId: context.journeyId(),
      journey,
      pageId: journeyPage.id,
      page: journeyPage,
      kind: kindOf(page),
      path: ids,
      index,
      total: counted.length,
      number: Math.max(1, counted.findIndex((node) => node.id === page.id) + 1),
      completed: [],
      frontierPageId: journeyPage.id,
      ...(back !== undefined ? { backPageId: back } : {}),
      final: index === pages.length - 1 || kindOf(page) === "review",
      end: "end",
      members: (built.root.children?.[JOURNEY_CONTENT_SLOT] ?? []).map((node) => node.id),
      pageOf: review?.pageOf ?? {},
      validation: { continue: "defer", server: false, onUnavailable: "block" } as JourneyView["validation"]
    };
  };

  const route = (drawnId: string | undefined, tree: ComponentNode): StepSelectionRoute => {
    const role = drawnId !== undefined ? build(tree).roles.get(drawnId) : undefined;
    switch (role?.role) {
      case "placement":
        return { journeyNodeId: role.nodeId, inspect: { controller: "form", componentId: role.componentId, placementId: role.nodeId } };
      case "placed": {
        // The whole placed group: the placement selected, the form container it places
        // inspected; the field inside is edited in the Form workspace.
        const placement = build(tree).roles.get(role.placementId);
        const componentId = placement?.role === "placement" ? placement.componentId : role.componentId;
        return { journeyNodeId: role.placementId, inspect: { controller: "form", componentId, placementId: role.placementId } };
      }
      case "own":
      case "worked-out":
        return { journeyNodeId: role.nodeId, inspect: { controller: "journey", nodeId: role.nodeId } };
      case "step":
        return { journeyNodeId: role.pageNodeId, inspect: { controller: "journey", nodeId: role.pageNodeId } };
      default:
        return { journeyNodeId: undefined, inspect: undefined };
    }
  };

  const placementsOf = (componentId: string, tree: ComponentNode): Array<{ pageNodeId: string; nodeId: string }> => {
    const out: Array<{ pageNodeId: string; nodeId: string }> = [];
    for (const page of pagesOf(tree)) {
      const stack = [...(page.children?.[JOURNEY_CONTENT_SLOT] ?? [])].reverse();
      while (stack.length > 0) {
        const node = stack.pop() as ComponentNode;
        if (node.type === JOURNEY_FIELD_TYPE && stringOf(configurationOf(node).componentId) === componentId) {
          out.push({ pageNodeId: page.id, nodeId: node.id });
        }
        stack.push(...Object.values(node.children ?? {}).flat().reverse());
      }
    }
    return out;
  };

  const tags = (tree: ComponentNode, words: StepTagWords): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [id, role] of build(tree).roles) {
      if (role.role === "own" && role.fills === undefined) {
        out.set(id, words.notSent);
      }
    }
    return out;
  };

  const selectTargets = (tree: ComponentNode): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [id, role] of build(tree).roles) {
      if (role.role === "placed") {
        out.set(id, role.placementId);
      }
    }
    return out;
  };

  const regionOwner = (tree: ComponentNode, words: StepOwnerWords): { id: string; label: string } | undefined => {
    const page = build(tree).page;
    if (!page) {
      return undefined;
    }
    const counted = pagesOf(tree).filter((node) => kindOf(node) !== "exit");
    const at = counted.findIndex((node) => node.id === page.id);
    const configuration = configurationOf(page);
    const name = stringOf(configuration.title) || stringOf(configuration.label) || writtenPageId(page);
    return { id: page.id, label: words.step({ number: at < 0 ? undefined : at + 1, name }) };
  };

  const findings = (tree: ComponentNode, message: (left: StepDrawnTwice) => string): Map<string, JourneyFinding[]> => {
    const out = new Map<string, JourneyFinding[]>();
    for (const left of build(tree).drawnTwice) {
      const list = out.get(left.nodeId) ?? [];
      list.push({ severity: "warning", code: STEP_DRAWN_TWICE_CODE, message: message(left) });
      out.set(left.nodeId, list);
    }
    return out;
  };

  const reviewRow = (tree: ComponentNode, elementId: string): string | undefined => {
    const review = build(tree).review;
    if (!review) {
      return undefined;
    }
    const prefix = reviewRowIdPrefix(review.pageId);
    // The drawing ids a row `<step>__review-<value path>`, and the error lines under it `…__error`.
    if (!elementId.startsWith(prefix) || elementId.endsWith("__error")) {
      return undefined;
    }
    return reviewRowComponent(context.formRoot(), elementId.slice(prefix.length));
  };

  return {
    canvasRoot: (tree) => build(tree).root,
    canvasView,
    journeyView,
    roles: (tree) => build(tree).roles,
    route,
    placementsOf,
    tags,
    selectTargets,
    regionOwner,
    drawnTwice: (tree) => build(tree).drawnTwice,
    findings,
    takeOff: (journey, placementId) => journey.requestRemoveComponents([placementId]),
    reviewRow
  };
}

/** The words of the Step view's inspector buttons, from the caller's builder text tables (this module holds no author text). */
export interface StepInspectionWords {
  /** The inspector's button on a form field placed on the step ("Take it off this step"). */
  takeOff: string;
  /** What the canvas's selection bar Delete says for one ("Take off this step"). */
  takeOffBar: string;
}

export interface StepInspectionContext {
  /** The controller of the journey shown (the canvas's). */
  journey(): BuilderController;
  /** The form's controller, where a placed form field is inspected. */
  form: BuilderController;
  canvas: StepCanvas;
  words(): StepInspectionWords;
  /** Whether the Step view is up: the inspector is routed only then. Absent: always. */
  active?(): boolean;
}

/**
 * The inspection seam for the Journeys mode: what `BuilderMode.inspection`, `subscribeInspection` and
 * `inspectorActions` answer while the Step view is up: a form field placed on the step (or a
 * placed group, its container) is inspected on the FORM controller under its form
 * id, with its usual tabs, and offers "Take it off this step" (one undo step on the journey's
 * controller; the form field and its other steps untouched), which is also what the canvas bar's
 * Delete does for it. A journey-only field, an alias, a worked-out value and the step itself are
 * inspected on the journey's controller (`inspection()` is `undefined`).
 */
export interface StepInspection {
  inspection(): BuilderModeInspection | undefined;
  /** The shell's listener: told by {@link notify}. The shell reads {@link inspection} again on every selection of the journey's controller itself. */
  subscribeInspection(listener: () => void): () => void;
  inspectorActions(): BuilderInspectorAction[];
  /** The mode tells the shell the answers moved without a selection of the journey's (the Step view up or down, another step shown). */
  notify(): void;
}

/** The id of the inspector's "Take it off this step" button (`data-inspector-mode-action`). */
export const STEP_TAKE_OFF_ACTION = "take-off";

export function createStepInspection(context: StepInspectionContext): StepInspection {
  const listeners = new Set<() => void>();
  const routeNow = (): StepSelectionRoute | undefined => {
    if (context.active && !context.active()) {
      return undefined;
    }
    const journey = context.journey();
    const selected = journey.selectedComponentId();
    return selected === undefined ? undefined : context.canvas.route(selected, journey.previewSnapshot());
  };
  return {
    inspection: () => {
      const inspect = routeNow()?.inspect;
      return inspect?.controller === "form" ? { controller: context.form, componentId: inspect.componentId } : undefined;
    },
    subscribeInspection: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    inspectorActions: () => {
      const inspect = routeNow()?.inspect;
      if (inspect?.controller !== "form") {
        return [];
      }
      const words = context.words();
      const journey = context.journey();
      const placementId = inspect.placementId;
      return [{ id: STEP_TAKE_OFF_ACTION, label: words.takeOff, deleteLabel: words.takeOffBar, run: () => void context.canvas.takeOff(journey, placementId) }];
    },
    notify: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
}

/**
 * Routes the journey controller's selection to the inspector: a placement (or a form node in a
 * placed container) is inspected on the FORM controller, under its form id; anything else on
 * the journey's. What the inspection seam (the shell pointing the inspector at another controller) is
 * driven by. Returns the unsubscribe.
 */
export function followStepSelection(
  journey: BuilderController,
  canvas: StepCanvas,
  onRoute: (route: StepSelectionRoute) => void
): () => void {
  return journey.on("selection", () => {
    onRoute(canvas.route(journey.selectedComponentId(), journey.previewSnapshot()));
  });
}
