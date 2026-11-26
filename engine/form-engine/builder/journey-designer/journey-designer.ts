/**
 * The Journeys designer: everything the Journeys mode needs once it is on the page,
 * in one chunk the mode loads on its first activation — the tree mapping (`journey-tree.ts`),
 * the generator (`journey-from-form.ts`), the node types (`journey-components.ts`), the Step
 * view over the Form canvas (`step-view.ts`, `step-canvas-adapter.ts`), the findings
 * (`journey-checks.ts`, the builder's only way to `journey-diagnostics.ts`) and the add popover
 * and empty state (`journey-designer-panels.ts`). The flow map (`builder/journey-map/`)
 * is a chunk of its own again, which this one loads the first time the Map view is chosen
 * (`loadJourneyMap`), lending it the page words so it never loads them; so is the journey Try it
 * runs (`journey-preview.ts`), loaded ahead once a journey is on the
 * page and at the latest on the first Try it (`prepareTry`, `loadJourneyPreview`), which reads
 * the page words and checks already on the page; and so are the page-only fields
 * (`journey-authoring.ts`: their palette and inspector), loaded before
 * any journey's controller is built (`loadAuthoring`), whose types are fixed when it is built.
 * The mode itself (`journey-builder-mode.ts`),
 * the catalog and the model are in the builder's bundle; a page that never opens the Journeys
 * tab never loads any of this (`check-bundles` holds the line with the Step view's sentinel).
 *
 * `createJourneyDesigner` builds the part shared by every journey of a form — the form's index,
 * read afresh after each form edit — and hands out, per journey, the options its controller
 * takes and the live view its hooks read. Nothing here runs at import.
 */
import type { ComponentDefinition } from "../../core/schema/contracts.js";
import type { TextAddress, TextSources } from "../../core/localization/translations.js";
import { JOURNEY_END, type Journey } from "../../core/schema/journey.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { journeyCertainWalk } from "../../core/journey/journey-diagnostics.js";
import { BUTTON_COMPONENT_TYPE, readButtonAction } from "../../core/schema/button.js";
import { holdsData } from "../../core/tree/data-scope.js";
import type { BuilderComponentType, BuilderControllerOptions, BuilderProblem, InsertComponentEntry } from "../controller/builder-controller.js";
import type { InspectorChoice } from "../property-editor/inspector-model.js";
import type { JourneyMap, JourneyMapContext } from "../journey-map/journey-map.js";
import type { UnlistedJourney } from "./journey-catalog.js";
import type { BuilderTextCatalog, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./journey-texts-en.js";
import { checkJourneyTree, findingsSummary, indexJourneyTree, journeyFromTreePlaced, journeyPageNodes, writtenPageId, type JourneyFinding } from "./journey-checks.js";
import { journeyFieldRows, journeyFindingEntries, type JourneyFieldRow, type JourneyFindingEntry } from "./journey-findings.js";
import type { FindingNames } from "./journey-finding-words.js";
import {
  conditionTermsInWords,
  indexJourneyForm,
  journeyComponentDefinitions,
  journeyComponentTypes,
  journeyFieldChoices,
  journeyFieldPlaceholder,
  journeyFoldedSections,
  journeyIdleDefinitions,
  journeyIdRow,
  journeyMissingQuestions,
  journeyNodeLabel,
  journeyNotes,
  journeyPageIdProblems,
  pageName,
  conditionInWords,
  type JourneyDesignView,
  type JourneyFacesContext,
  type JourneyFormIndex
} from "./journey-components.js";
import {
  JOURNEY_DESIGNER_PANEL_STYLES,
  createJourneyAddPopover,
  createJourneyEmptyState,
  type JourneyAddPopover,
  type JourneyAddPopoverContext,
  type JourneyEmptyState
} from "./journey-designer-panels.js";
import { journeyFromForm, unassignedMembers, type JourneyShape } from "./journey-from-form.js";
import type { JourneyAuthoringLent } from "./journey-authoring.js";
import type { JourneyPreviewLent, JourneyPreviewSession, JourneyPreviewSessionOptions } from "./journey-preview.js";
import {
  JOURNEY_CONTENT_SLOT,
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_ROUTES_SLOT
} from "./journey-mode-model.js";
import { emptyJourneyTree, journeyFromTree, treeFromJourney } from "./journey-tree.js";
import { createJourneyStepView, type JourneyStepView } from "./step-view.js";
import { createStepCanvas } from "./step-canvas-adapter.js";
import { journeyReviewListing, reviewDropsEntry } from "./step-review.js";

export { emptyJourneyTree, journeyFromTree, journeyNodeTemplate, treeFromJourney } from "./journey-tree.js";
export { isOnePageShape, journeyFromForm, journeyPagesFromForm, unassignedMembers } from "./journey-from-form.js";
export type { JourneyShape } from "./journey-from-form.js";
export { checkJourneyTree, findingsSummary, indexJourneyTree, placeJourneyFindings } from "./journey-checks.js";
export type { JourneyCheck, JourneyFinding, JourneyNodePlacement, JourneyPageEntry, JourneyTreeIndex, PlacedJourneyFindings } from "./journey-checks.js";
export {
  JOURNEY_STAKES_TEXT,
  conditionInWords,
  conditionTermsInWords,
  indexJourneyForm,
  journeyComponentDefinitions,
  journeyComponentTypes
} from "./journey-components.js";
export type { JourneyDesignView, JourneyFacesContext, JourneyFormComponent, JourneyFormIndex } from "./journey-components.js";
export { journeyAddPopoverHtml, journeyEmptyStateHtml } from "./journey-designer-panels.js";
export type { JourneyAddChoice, JourneyAddPopover, JourneyAddPopoverContext, JourneyEmptyState } from "./journey-designer-panels.js";
// The try session's values (`createJourneyPreviewSession`, `previewJourney`, its texts) are its
// own chunk's: import them from `journey-preview.js`. Only its types pass through here.
export type {
  JourneyPreview,
  JourneyPreviewSession,
  JourneyPreviewSessionOptions,
  JourneyPreviewSubject,
  PreviewJourneyOptions
} from "./journey-preview.js";

export type { JourneyMap, JourneyMapContext, JourneyMapEdit, JourneyMapSubject } from "../journey-map/journey-map.js";
export { createJourneyStepView, stepPaletteTypes } from "./step-view.js";
export type { JourneyStepView, JourneyStepViewOptions } from "./step-view.js";
export type { JourneyFieldRow, JourneyFindingEntry, JourneyFindingFix, JourneyFindingFixKind } from "./journey-findings.js";
export { createStepCanvas, createStepInspection } from "./step-canvas-adapter.js";
export { createStepHistory } from "./step-history.js";

/**
 * A chunk's loader, one load per page shared by every designer on it: a failed load (the chunk
 * missing from the page's copy of the bundle, a network hiccup) is tried again next time rather
 * than remembered (the `loadJourneyDesigner` rule), so the view is not broken for the rest of
 * the page's life. Making one loads nothing.
 */
function retryingLoad<T>(load: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | undefined;
  return () => {
    if (!memo) {
      const next = load();
      next.catch(() => {
        if (memo === next) {
          memo = undefined;
        }
      });
      memo = next;
    }
    return memo;
  };
}

/**
 * What the try session's chunk reads of this one's modules, lent rather than imported: a chunk this
 * one loads never imports it, so a designer's chunk fetched again after a failed load, under
 * another URL, is the one the chunks it loads then read — see
 * `JourneyPreviewLent`. The flow map is lent its words the same way (`createMap`).
 */
export const JOURNEY_PREVIEW_LENT: JourneyPreviewLent = { journeyFromTreePlaced, indexJourneyTree, pageName };

/** What the page-only fields' chunk reads of this one's definitions, lent for the same reason. */
export const JOURNEY_AUTHORING_LENT: JourneyAuthoringLent = {
  journeyComponentDefinitions
};

/** The flow map's chunk, as `loadJourneyMap` resolves it. */
export type JourneyMapModule = typeof import("../journey-map/journey-map.js");

/** The flow map's chunk, loaded the first time the Map view is chosen. */
export const loadJourneyMap: () => Promise<JourneyMapModule> = /* @__PURE__ */ retryingLoad(() => import("../journey-map/journey-map.js"));

/** The try session's chunk, as `loadJourneyPreview` resolves it. */
export type JourneyPreviewModule = typeof import("./journey-preview.js");

/** The try session's chunk, loaded ahead once a journey is on the page, at the latest on the first Try it. */
export const loadJourneyPreview: () => Promise<JourneyPreviewModule> = /* @__PURE__ */ retryingLoad(() => import("./journey-preview.js"));

/** The page-only fields' chunk, as `loadJourneyAuthoring` resolves it. */
export type JourneyAuthoringModule = typeof import("./journey-authoring.js");

/**
 * The page-only fields' chunk: their palette entries, their cards and what their inspector
 * offers. Loaded with the designer, before any journey's controller is
 * built — the types a controller edits are fixed when it is built, and adding them later would
 * take its history.
 */
export const loadJourneyAuthoring: () => Promise<JourneyAuthoringModule> = /* @__PURE__ */ retryingLoad(() => import("./journey-authoring.js"));

/** What the designer reads from the builder around it. */
export interface JourneyDesignerContext {
  /** The form as committed: the tree the journeys are built over. */
  formRoot(): ComponentNode;
  /** The builder's locale, which the node labels and pickers resolve text in. */
  locale(): string;
  /**
   * What resolves a text in the builder's locale: the form's own translations and the host's
   * catalog, read live. Absent: every text is shown in the default language.
   */
  sources?(): TextSources | undefined;
  /** The builder's own words: its catalog per locale (the host's texts for the builder, `BuilderTextCatalog`). Absent: English. */
  textCatalog?(): BuilderTextCatalog | undefined;
  /** Which leaves carry no answer. Absent: the engine's. */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
  /** The form's component definitions, as the host registers them: what a presentation's page-only fields are made from. */
  formDefinitions?: (() => readonly ComponentDefinition[] | undefined) | undefined;
  /** The form's palette, whose groups and order the page-only fields follow. */
  formTypes?: (() => readonly BuilderComponentType[] | undefined) | undefined;
}

/** The builder's words for the designer: its locale and catalog, read live. */
function textOptionsOf(context: JourneyDesignerContext): BuilderTextOptions {
  return { locale: context.locale(), catalog: context.textCatalog?.() };
}

/** What the mode hands a try session: the session's options but what the designer lends (the page words, the form's index). */
export type JourneyPreviewContext = Omit<JourneyPreviewSessionOptions, "lent" | "formIndex">;

/** Makes the journey Try it runs, at once: what `prepareTry` resolves to once the chunk is in. */
export type JourneyTrySessionMaker = (context: JourneyPreviewContext) => JourneyPreviewSession;

/** One journey's part of the designer: what its controller is given, and what its hooks read. */
export interface JourneyEntryDesignOptions {
  /** The catalog entry's id, read live. */
  journeyId(): string;
  /** The journey's tree as the canvas shows it (drafts laid over): its controller's `previewSnapshot()`. */
  tree(): ComponentNode;
  /** The tree its controller is about to be built with, when `tree()` does not hold it yet: the own types it holds get a face. */
  root?: ComponentNode | undefined;
  /** The entry's page-id memory (`journey-tree.ts`), read, never changed here. */
  pageIds: ReadonlyMap<string, string>;
  /** The entry's route-link memory (`journey-tree.ts`), read, never changed here. */
  routeLinks?: ReadonlyMap<string, string> | undefined;
  /** The entry's memory of references as written (`journey-tree.ts`), read, never changed here. */
  references?: ReadonlyMap<string, Record<string, unknown>> | undefined;
  /** Declared journeys the catalog keeps without listing, for the root's findings. */
  unlisted?(): readonly UnlistedJourney[];
}

export interface JourneyEntryDesign {
  /** For the journey's `BuilderController.setOptions`, beside its `initialRoot`, `locale` and `localization`. */
  readonly builderOptions: BuilderControllerOptions;
  /** Forgets what was read from the tree: called on every change of the journey's controller. */
  invalidate(): void;
  /** The journey as the tree stands, its findings placed, and what it asks on no page. */
  view(): JourneyDesignView;
}

/** What the mode gives the designer to make a journey's Step view: the rest (words, names) the designer knows. */
export type JourneyStepViewContext = Pick<Parameters<typeof createJourneyStepView>[0], "form" | "journey" | "journeyId" | "base" | "hold" | "changed">;

export interface JourneyDesigner {
  entry(options: JourneyEntryDesignOptions): JourneyEntryDesign;
  /** For the mode's idle controller, while the form has no journey: a root with nothing to edit, and no palette. */
  idleOptions(): BuilderControllerOptions;
  /**
   * Brings the page-only fields' chunk in (`loadJourneyAuthoring`), which the journeys built
   * after it draw and offer; rejects when it cannot load (a journey built meanwhile draws its
   * own nodes as unknown and offers no page-only field), and the next call tries again.
   */
  loadAuthoring(): Promise<void>;
  /**
   * "Ask differently here…": the field of the journey's own that fills the form
   * component the question `nodeId` of `tree` reuses, and its id — for the question's place,
   * as one undo step. `undefined` when it cannot be made.
   */
  /**
   * The journey's own fields a rule of the node `nodeId` may read: a worked-out value
   * those of its page, `alone`; a page-only field every one but itself, beside the form's.
   * `undefined` for a node the journey does not own, or before the page-only chunk is in.
   */
  ownRuleFields(tree: ComponentNode, nodeId: string): { choices: InspectorChoice[]; alone: boolean } | undefined;
  askDifferently(
    tree: ComponentNode,
    nodeId: string,
    keep: { pageIds?: ReadonlyMap<string, string> | undefined; references?: ReadonlyMap<string, unknown> | undefined }
  ): { node: ComponentNode; id: string } | undefined;
  /**
   * `types` (a built journey's palette) with the designer's own three entries worded again in
   * the builder's locale and catalog as they stand now; every other entry is returned as it is
   * (the page-only chunk's entries keep the words they were built with until the journey is).
   */
  relabel(types: readonly BuilderComponentType[]): BuilderComponentType[];
  /** The form changed: the pickers and labels read it afresh on their next paint. */
  invalidateForm(): void;
  form(): JourneyFormIndex;
  /** The form's answer-holding components, every one of which a new journey puts on a page. */
  questionCount(): number;
  /** What `journey` asks on no page (`unassignedMembers`), over the form as it stands. */
  unassigned(journey: Journey): string[];
  /** The questions of a journey's tree whose form component the form no longer has: what "Remove missing" removes. */
  missingQuestions(tree: ComponentNode): string[];
  /**
   * The journey a new one starts as: one empty questions step titled
   * "Step 1" in the builder's words, with no fields. Its step id is the first `step-n` no
   * component of the form has. Its findings are the form's required fields it does not ask yet.
   */
  blank(options: { id: string; name: string }): Journey;
  /** The findings of `view`'s journey as the Journey panel's card lists them: errors first, each with its fixes (`journey-findings.ts`). */
  findingEntries(view: JourneyDesignView): JourneyFindingEntry[];
  /**
   * The form's fields as the Form fields panel lists them, in form order: on no step first
   * (the order is the panel's), each marked `here` when the step node `shown` asks it.
   */
  fieldRows(view: JourneyDesignView, shown: string | undefined, journeyId: string): JourneyFieldRow[];
  /**
   * The Go to rules of the step node `stepNodeId` as its Logic tab lists them: each written
   * rule in the order it is tried (`routeIndex`, its written position), then where the step goes
   * when none holds ("Otherwise"), unless an ending stops there or a rule always holds. `next` is
   * the page id of the step after it, which a New rule goes to; absent on the last step and on a
   * step whose rules are never tried. `undefined` while the step is not in the journey as written.
   */
  stepRules(view: JourneyDesignView, stepNodeId: string, journeyId: string): JourneyStepRules | undefined;
  /**
   * One placement of the form component `componentId` on the step `pageNodeId`, as the
   * `insertComponents` call the panel's click makes: before the step's closing buttons, never
   * after the form's Submit (as "Ask it here" puts it). Empty when the step is not in `tree`.
   */
  placeEntries(
    tree: ComponentNode,
    componentId: string,
    pageNodeId: string,
    pageIds?: ReadonlyMap<string, string>,
    references?: ReadonlyMap<string, unknown>
  ): InsertComponentEntry[];
  /**
   * Why no form field can be placed on the step node `pageNodeId` of `tree`, worded for the Form
   * fields panel: a Check answers step draws none, and on an exit step (no Continue, nothing
   * sent) a field is as unchecked as on no step yet stops counting as left out, as "Ask it
   * here" avoids it. `undefined` for a questions step, or one not in `tree`.
   */
  placeRefusal(tree: ComponentNode, pageNodeId: string): string | undefined;
  /**
   * The words of the Step view's "Ask differently here…" for the question `nodeId` of `tree`,
   * when it is offered there (`askDifferentlyOffered`: the journey's palette, `offeredTypes`,
   * has the page-only type, and the form field is one it may fill); `undefined` otherwise (and
   * before the page-only fields' chunk is in).
   */
  askDifferentlyLabel(
    tree: ComponentNode,
    nodeId: string,
    keep: { pageIds?: ReadonlyMap<string, string> | undefined; references?: ReadonlyMap<string, unknown> | undefined },
    offeredTypes: readonly string[]
  ): string | undefined;
  /** A journey made from the form; `title` heads the one page of a one-page shape (a one-page start is titled as the form). */
  fromForm(options: {
    id: string;
    name: string;
    shape: JourneyShape;
    title?: string | undefined;
    /** Where the translations of `title` live, and out: the pages titled from a text of the form (see `JourneyPagesFromFormOptions`). */
    titleFrom?: TextAddress | undefined;
    titleOrigins?: Array<{ pageId: string; from: TextAddress }> | undefined;
  }): Journey;
  /**
   * What "Add unassigned" inserts, as one `insertComponents` call: `members` as questions on
   * the selected page (or the page holding the selection) — or, for `place: "last"`, on the
   * last such page (a required field's "Ask it here", and a one-page journey's page whatever is
   * selected) — when it is a page every path takes (`journeyCertainWalk`: not past a
   * conditional route or an exit page, reached at all); else on one new
   * page where every path reaches it, as late as that allows ahead of the page that asks the
   * form's Submit (onto that page when it is the first and every path takes it). Off the path a
   * field is not required, so neither may quietly relax the form's
   * Required. Never after the Submit on the page they go to.
   * `pageIds` is the entry's page-id memory: a new node or page never takes an id a
   * route to a deleted page may still name, so the route stays unknown rather than quietly
   * going to the new page; nor one a reference was read from (`references`), which a
   * new question would be written as.
   */
  addUnassignedEntries(
    tree: ComponentNode,
    members: readonly string[],
    selectedId: string | undefined,
    pageIds?: ReadonlyMap<string, string>,
    place?: "selected" | "last",
    references?: ReadonlyMap<string, unknown>,
    routeLinks?: ReadonlyMap<string, string>
  ): InsertComponentEntry[];
  createAddPopover(host: HTMLElement, context: JourneyAddPopoverContext): JourneyAddPopover;
  createEmptyState(context: { onAdd(anchor: HTMLElement): void }): JourneyEmptyState;
  /**
   * The maker of the journey Try it runs (`journey-preview.ts`), once its chunk is in
   * (`loadJourneyPreview`): the mode loads it ahead, so Try it, whose session is made at once,
   * finds it in. The designer lends the session the page words and the form's index (the page
   * names and the fields a problem names). Rejects when the chunk cannot load; the next call
   * tries again.
   */
  prepareTry(): Promise<JourneyTrySessionMaker>;
  /**
   * The flow map's surface, once its chunk is in (`loadJourneyMap`): the journey on
   * the page as its steps and the ways between them. The designer lends it the form and the
   * page words. Rejects when the chunk cannot load; the next call tries again.
   */
  createMap(context: JourneyMapContext): Promise<JourneyMap>;
  /**
   * The Step view over one journey's controller (`step-view.ts`): the journey's step on the Form
   * canvas, drawn with the form's own binding. Made once per journey's controller; nothing is
   * changed on the controller until the view is entered.
   */
  stepView(options: JourneyStepViewContext): JourneyStepView;
  /** The popover's and the empty state's stylesheet, which the mode's `styles` carries once the designer is up (the map's comes with its chunk; the Try panel's Journey card is the try session's markup, in the panel's styles). */
  readonly panelStyles: string;
  readonly treeFromJourney: typeof treeFromJourney;
  readonly journeyFromTree: typeof journeyFromTree;
}

/** A step's Go to rules in words (`JourneyDesigner.stepRules`). */
export interface JourneyStepRules {
  pageId: string;
  note: string;
  rows: Array<{ title: string; reads?: string; routeIndex?: number }>;
  next?: string;
  newRule: string;
}

/** What the canvas draws of a journey while no step is shown (`BuilderControllerOptions.canvasRoot`): its root, with none of what the form's binding cannot draw. */
function undrawnJourney(root: ComponentNode): ComponentNode {
  const { children: _children, ...bare } = root;
  return bare;
}

/** Every id in a tree, for picking new ones. */
function idsOf(node: ComponentNode, into: Set<string> = new Set()): Set<string> {
  into.add(node.id);
  for (const group of Object.values(node.children ?? {})) {
    for (const child of group) {
      idsOf(child, into);
    }
  }
  return into;
}

/**
 * The form's components that are, or hold, a button that submits it (`submit` or `download`, as
 * a journey's page reads it, `journey-render.ts`): what a question that puts the form's Submit
 * on a page asks.
 */
function submitHolders(root: ComponentNode): Set<string> {
  const out = new Set<string>();
  const visit = (node: ComponentNode, above: readonly string[]): void => {
    const action = node.type === BUTTON_COMPONENT_TYPE ? readButtonAction(node.configuration) : undefined;
    if (action === "submit" || action === "download") {
      for (const id of [...above, node.id]) {
        out.add(id);
      }
    }
    for (const child of Object.values(node.children ?? {}).flat()) {
      visit(child, [...above, node.id]);
    }
  };
  for (const child of Object.values(root.children ?? {}).flat()) {
    visit(child, []);
  }
  return out;
}

/** Whether a question, or anything in a layout of the journey's own it holds, asks a component that is or holds the form's Submit. */
function holdsSubmit(node: ComponentNode, submits: ReadonlySet<string>): boolean {
  const componentId = (node.configuration as { componentId?: unknown } | undefined)?.componentId;
  return (
    (node.type === JOURNEY_FIELD_TYPE && typeof componentId === "string" && submits.has(componentId)) ||
    Object.values(node.children ?? {}).some((children) => children.some((child) => holdsSubmit(child, submits)))
  );
}

/**
 * Where a question put on `page` goes among what it holds: before the page's closing buttons (a
 * journey's last step ends with the form's Submit), and never after the form's Submit wherever it
 * sits on the step — a question added after it would be drawn below the button.
 */
function closingIndex(page: ComponentNode, submits: ReadonlySet<string>, form: JourneyFormIndex): number {
  const questions = page.children?.[JOURNEY_CONTENT_SLOT] ?? [];
  const isButton = (node: ComponentNode): boolean => {
    const componentId = (node.configuration as { componentId?: unknown } | undefined)?.componentId;
    return typeof componentId === "string" && form.components.get(componentId)?.type === "button";
  };
  let at = questions.length;
  while (at > 0 && isButton(questions[at - 1]!)) {
    at -= 1;
  }
  const submitAt = questions.findIndex((node) => holdsSubmit(node, submits));
  return submitAt >= 0 && submitAt < at ? submitAt : at;
}

/** A page whose kind is `"exit"`: content only, no Continue and no Submit. */
function isExitPage(node: ComponentNode): boolean {
  const configuration = node.configuration;
  return typeof configuration === "object" && configuration !== null && (configuration as { kind?: unknown }).kind === "exit";
}

/** A page whose kind is `"review"` (Check answers): it lists the answers and places no field, so a question never goes onto it. */
function isReviewPage(node: ComponentNode): boolean {
  const configuration = node.configuration;
  return typeof configuration === "object" && configuration !== null && (configuration as { kind?: unknown }).kind === "review";
}

/** `prefix_n` for the first n no id in `taken` has; the id is then taken. */
function freshId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}_${n}`)) {
    n += 1;
  }
  const id = `${prefix}_${n}`;
  taken.add(id);
  return id;
}

export function createJourneyDesigner(context: JourneyDesignerContext): JourneyDesigner {
  let authoringModule: JourneyAuthoringModule | undefined;
  let formVersion = 0;
  let formMemo: { version: number; locale: string; index: JourneyFormIndex } | undefined;
  const holdsOptions = context.isValueless ? { isValueless: context.isValueless } : {};

  const form = (): JourneyFormIndex => {
    const locale = context.locale();
    if (!formMemo || formMemo.version !== formVersion || formMemo.locale !== locale) {
      formMemo = { version: formVersion, locale, index: indexJourneyForm(context.formRoot(), locale, context.sources?.()) };
    }
    return formMemo.index;
  };

  const unassigned = (journey: Journey): string[] => unassignedMembers(context.formRoot(), journey, holdsOptions);

  /** What the author called the steps and the fields, for the findings' words (`journey-finding-words.ts`): a step by its name, a field by its label. */
  const findingNames = (tree: ComponentNode, journeyId: string): FindingNames => {
    const steps = new Map<string, string>();
    for (const page of indexJourneyTree(tree).pages) {
      if (!steps.has(page.pageId)) {
        steps.set(page.pageId, pageName(page, form(), context.locale(), context.sources?.(), journeyId));
      }
    }
    return { step: (pageId) => steps.get(pageId), field: (componentId) => form().components.get(componentId)?.label };
  };

  const entry = (options: JourneyEntryDesignOptions): JourneyEntryDesign => {
    let memo: { formVersion: number; locale: string; view: JourneyDesignView } | undefined;
    // What each step's drawing leaves out (a container placed beside its own parent), worked out
    // once per view for every step, not only the one shown: a warning like the check's own, so
    // the findings card and the map's counts say it too (`step-canvas-adapter.ts`).
    let drawing: string | undefined;
    let revision = 0;
    const stepDrawing = createStepCanvas({
      formRoot: () => context.formRoot(),
      pageNodeId: () => drawing,
      journeyId: options.journeyId,
      formRevision: () => formVersion,
      journeyRevision: () => revision,
      answerWord: () => builderText("journey.step.review.answer", undefined, textOptionsOf(context))
    });
    const withDrawnTwice = (tree: ComponentNode, check: ReturnType<typeof checkJourneyTree>): void => {
      revision += 1;
      const text = textOptionsOf(context);
      // The fields as the author knows them, by label: an id only for a component the form has no label for.
      const labelOf = (componentId: string): string => form().components.get(componentId)?.label ?? componentId;
      for (const page of journeyPageNodes(tree)) {
        drawing = page.id;
        for (const [nodeId, list] of stepDrawing.findings(tree, (left) =>
          builderText(
            "journey.designer.step.drawnTwice",
            { ids: left.ids.map(labelOf).join(", "), by: [...new Set(Object.values(left.drawnBy))].map(labelOf).join(", ") },
            text
          )
        )) {
          const kept: JourneyFinding[] = check.findings.byNode.get(nodeId) ?? [];
          check.findings.byNode.set(nodeId, [...kept, ...list]);
          check.findings.warnings += list.length;
        }
      }
    };
    const view = (): JourneyDesignView => {
      const locale = context.locale();
      if (!memo || memo.formVersion !== formVersion || memo.locale !== locale) {
        const tree = options.tree();
        const check = checkJourneyTree(context.formRoot(), tree, options.journeyId(), {
          pageIds: options.pageIds,
          routeLinks: options.routeLinks,
          references: options.references,
          unlisted: options.unlisted?.() ?? [],
          text: textOptionsOf(context),
          names: findingNames(tree, options.journeyId()),
          ...holdsOptions
        });
        withDrawnTwice(tree, check);
        memo = {
          formVersion,
          locale,
          view: { tree, index: indexJourneyTree(tree), check, unassigned: check.journey ? unassigned(check.journey) : [] }
        };
      }
      return memo.view;
    };
    const faces: JourneyFacesContext = {
      locale: () => context.locale(),
      sources: () => context.sources?.() ?? {},
      textCatalog: () => context.textCatalog?.(),
      form,
      formRoot: () => context.formRoot(),
      ...(context.isValueless ? { isValueless: context.isValueless } : {}),
      view,
      journeyId: () => options.journeyId(),
      pageIds: () => options.pageIds
    };
    /**
     * A step made a Check answers step while it asks form fields: refused under the Kind
     * box with the check's own words for it (`page.review-form-field`), so what the engine would
     * drop is said before it is saved. Only while the draft sets the kind; a step already in that
     * state is the findings card's, with its Take it off.
     */
    const reviewKindProblems = (edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderProblem[] => {
      if (edited.type !== JOURNEY_PAGE_TYPE || (edited.configuration as { kind?: unknown } | undefined)?.kind !== "review") {
        return [];
      }
      if (!(edited.children?.[JOURNEY_CONTENT_SLOT] ?? []).some(reviewDropsEntry)) {
        return [];
      }
      const swapped: ComponentNode = {
        ...tree,
        children: { ...(tree.children ?? {}), [JOURNEY_PAGES_SLOT]: (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).map((page) => (page.id === componentId ? edited : page)) }
      };
      const found = checkJourneyTree(context.formRoot(), swapped, options.journeyId(), {
        pageIds: options.pageIds,
        routeLinks: options.routeLinks,
        references: options.references,
        text: textOptionsOf(context),
        names: findingNames(swapped, options.journeyId()),
        ...holdsOptions
      });
      const index = indexJourneyTree(swapped);
      const messages = [...found.findings.byNode]
        .filter(([nodeId]) => index.pageOf.get(nodeId)?.nodeId === componentId)
        .flatMap(([, list]) => list.filter((finding) => finding.code === "page.review-form-field").map((finding) => finding.message));
      return messages.length > 0 ? [{ target: "kind", message: [...new Set(messages)].join(" ") }] : [];
    };
    const base: BuilderControllerOptions = {
      componentTypes: journeyComponentTypes(textOptionsOf(context)),
      componentDefinitions: journeyComponentDefinitions(faces),
      // The Step view draws the sheet (`step-view.ts`) in the form's binding and takes its options
      // when it is up. No fixed width: the sheet is fluid, the Form canvas's rule; no
      // device widths or grips, the bar is only zoom and Try it.
      previewWidths: false,
      // Until then the map's surface covers the sheet, which the canvas still draws underneath: the
      // journey's root alone, since the form's binding has no face for a step, a field or a route.
      canvasRoot: undrawnJourney,
      nodeLabel: (node) => journeyNodeLabel(faces, node),
      idRow: (node, place) => journeyIdRow(faces, node, place),
      problems: (edited, tree, componentId) => [
        ...journeyPageIdProblems(form(), edited, tree, componentId, textOptionsOf(context)),
        ...reviewKindProblems(edited, tree, componentId)
      ],
      // The formulas the designer writes as properties: a route's `when`, a
      // worked-out value's `value`. The controller holds a Save back while one does not parse,
      // as it does a form rule's, so a direct commitDraft stores no unparseable text.
      ruleTargets: ["when", "value"],
      fieldChoices: (node, field) => journeyFieldChoices(faces, node, field),
      // The findings again, under the boxes they are about; advisory.
      notes: (edited, _tree, componentId) => journeyNotes(faces, edited, componentId),
      foldedSections: (node) => journeyFoldedSections(node),
      fieldPlaceholder: (node, field) => journeyFieldPlaceholder(node, field),
      // A deleted page's node id is never handed out again: a route may still name it, and
      // would quietly go to a new page given it. Nor is a question's read
      // from a reference as written, which a new question would be written as.
      // The designer rewrites a journey's reads on a rename itself (journey-references.ts, one
      // step); the controller's own follow-up would record a second.
      renameFollowsRules: false,
      reservedIds: () => [...options.pageIds.keys(), ...(options.references?.keys() ?? [])]
    };
    // The page-only fields, when their chunk is in: laid over the designer's own,
    // fixed for the controller's life.
    const builderOptions = authoringModule
      ? authoringModule.withJourneyAuthoring(base, faces, {
          formDefinitions: context.formDefinitions?.(),
          formTypes: context.formTypes?.(),
          isValueless: context.isValueless,
          formRoot: () => context.formRoot(),
          tree: () => options.tree(),
          root: options.root,
          pageIds: options.pageIds,
          lent: JOURNEY_AUTHORING_LENT
        })
      : base;
    return {
      builderOptions,
      invalidate: () => {
        memo = undefined;
      },
      view
    };
  };

  const questionCount = (): number => {
    let count = 0;
    const visit = (node: ComponentNode): void => {
      const children = Object.values(node.children ?? {}).flat();
      if (children.length === 0) {
        count += holdsData(node, holdsOptions) ? 1 : 0;
        return;
      }
      children.forEach(visit);
    };
    Object.values(context.formRoot().children ?? {})
      .flat()
      .forEach(visit);
    return count;
  };

  const addUnassignedEntries = (
    tree: ComponentNode,
    members: readonly string[],
    selectedId: string | undefined,
    pageIds: ReadonlyMap<string, string> = new Map(),
    place: "selected" | "last" = "selected",
    references: ReadonlyMap<string, unknown> = new Map(),
    routeLinks: ReadonlyMap<string, string> = new Map()
  ): InsertComponentEntry[] => {
    if (members.length === 0) {
      return [];
    }
    // The ids a route to a deleted page may still name are taken too (see the interface), so are
    // remembered references' and the form's: no node of the designer's own takes a form
    // component's id.
    const formIds = idsOf(context.formRoot());
    const taken = idsOf(tree, new Set([...formIds, ...pageIds.keys(), ...references.keys()]));
    const index = indexJourneyTree(tree);
    const question = (componentId: string): ComponentNode => ({
      id: freshId(JOURNEY_FIELD_TYPE, taken),
      type: JOURNEY_FIELD_TYPE,
      configuration: { componentId }
    });
    // An exit page has no Continue and sends nothing: questions put there are as unchecked as on
    // no page, yet would stop counting as unassigned.
    const selectedPage = selectedId !== undefined ? index.pageOf.get(selectedId) : undefined;
    // The form's Submit, wherever a page asks it — by itself or in a group of buttons.
    const submits = submitHolders(context.formRoot());
    const pageNodes = tree.children?.[JOURNEY_PAGES_SLOT] ?? [];
    const submitPage = index.pages.find((page) => holdsSubmit(page.node, submits));
    // The pages every path takes, from the journey as it would be written (copies of the
    // memories: planning writes nothing). Off the path a field is hidden and not required,
    // so a page some path skips — a conditional route or an exit page
    // before it, a route past it — would relax the form's Required without a word.
    // A tree that cannot be written, or a journey nothing can be submitted through (every path
    // ends at an exit page, which `journey.no-end` reports), gives no walk: then only exit pages
    // are avoided, as before.
    const written = journeyFromTreePlaced(tree, "journey", {
      pageIds: new Map(pageIds),
      routeLinks: new Map(routeLinks),
      references: new Map(references) as Map<string, Record<string, unknown>>
    });
    const walk = written ? journeyCertainWalk(written.journey) : undefined;
    const certain = walk?.submittable ? walk : undefined;
    // An empty step is on the path as any other, so a new journey's one empty step is taken.
    const certainNodes = new Set(certain && written ? certain.pages.map((at) => written.placement.pages[at]?.nodeId) : []);
    // A review page is never one a question goes onto, whatever the walk says: it places no form field.
    const alwaysTaken = (page: { nodeId: string; node: ComponentNode }): boolean =>
      !isReviewPage(page.node) && (certain ? certainNodes.has(page.nodeId) : !isExitPage(page.node));
    let target =
      place === "last"
        ? [...index.pages].reverse().find(alwaysTaken)
        : selectedPage && alwaysTaken(selectedPage)
          ? selectedPage
          : undefined;
    // With no page chosen they get a page of their own, ahead of the page with the form's Submit
    // (below): after it, they would come after the Submit. When that page is the first, they go
    // onto it instead, before its Submit, so the journey still starts where it did.
    if (!target && submitPage && submitPage.nodeId === pageNodes[0]?.id && alwaysTaken(submitPage)) {
      target = submitPage;
    }
    if (target) {
      // Before the page's closing buttons (a one-page journey made from the form ends with the form's
      // Submit), and never after the form's Submit wherever it is on the page: a question added
      // after them would be drawn below the button.
      const questions = target.node.children?.[JOURNEY_CONTENT_SLOT] ?? [];
      const at = closingIndex(target.node, submits, form());
      return members.map((componentId, offset) => ({
        node: question(componentId),
        parentId: target.nodeId,
        slotId: JOURNEY_CONTENT_SLOT,
        ...(at < questions.length ? { index: at + offset } : {})
      }));
    }
    // One page of their own, under a page id no page, no form component and no route to a
    // deleted page has: before the page with the form's Submit, else at the end. Named as a
    // blank journey's first step is (`blank`): `step-n`, titled "Step n" in the builder's words.
    const pageIdsTaken = new Set<string>([...journeyPageNodes(tree).map(writtenPageId), ...pageIds.values(), ...formIds]);
    let n = index.pages.length + 1;
    while (pageIdsTaken.has(`step-${n}`)) {
      n += 1;
    }
    const page: ComponentNode = {
      id: freshId(JOURNEY_PAGE_TYPE, taken),
      type: JOURNEY_PAGE_TYPE,
      configuration: { pageId: `step-${n}`, title: builderText("journey.designer.step.newTitle", { n }, textOptionsOf(context)) },
      children: { [JOURNEY_CONTENT_SLOT]: members.map(question), [JOURNEY_ROUTES_SLOT]: [] }
    };
    let before = submitPage ? pageNodes.findIndex((node) => node.id === submitPage.nodeId) : -1;
    if (certain && written) {
      // Where every path reaches it: the latest such place ahead of the page with the form's
      // Submit (the start always is one), never after an exit page or a route that passes it.
      const writtenPages = written.placement.pages;
      const submitAt = submitPage ? writtenPages.findIndex((entry) => entry.nodeId === submitPage.nodeId) : -1;
      const slot = certain.slots.filter((at) => submitAt < 0 || at <= submitAt).at(-1) ?? 0;
      const ahead = writtenPages[slot]?.nodeId;
      before = ahead !== undefined ? pageNodes.findIndex((node) => node.id === ahead) : -1;
    }
    return [{ node: page, parentId: tree.id, slotId: JOURNEY_PAGES_SLOT, ...(before >= 0 ? { index: before } : {}) }];
  };

  const blank = ({ id, name }: { id: string; name: string }): Journey => {
    const taken = idsOf(context.formRoot());
    let n = 1;
    while (taken.has(`step-${n}`)) {
      n += 1;
    }
    return { id, name, pages: [{ id: `step-${n}`, title: builderText("journey.designer.step.newTitle", { n: 1 }, textOptionsOf(context)), components: [] }] };
  };

  const placeEntries = (
    tree: ComponentNode,
    componentId: string,
    pageNodeId: string,
    pageIds: ReadonlyMap<string, string> = new Map(),
    references: ReadonlyMap<string, unknown> = new Map()
  ): InsertComponentEntry[] => {
    const page = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).find((node) => node.id === pageNodeId && node.type === JOURNEY_PAGE_TYPE);
    // Never onto a step that asks nothing (`placeRefusal`).
    if (!page || componentId === "" || isReviewPage(page) || isExitPage(page)) {
      return [];
    }
    const taken = idsOf(tree, new Set([...idsOf(context.formRoot()), ...pageIds.keys(), ...references.keys()]));
    const question: ComponentNode = { id: freshId(JOURNEY_FIELD_TYPE, taken), type: JOURNEY_FIELD_TYPE, configuration: { componentId } };
    const at = closingIndex(page, submitHolders(context.formRoot()), form());
    const questions = page.children?.[JOURNEY_CONTENT_SLOT] ?? [];
    return [{ node: question, parentId: page.id, slotId: JOURNEY_CONTENT_SLOT, ...(at < questions.length ? { index: at } : {}) }];
  };

  const placeRefusal = (tree: ComponentNode, pageNodeId: string): string | undefined => {
    const page = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).find((node) => node.id === pageNodeId && node.type === JOURNEY_PAGE_TYPE);
    if (!page) {
      return undefined;
    }
    return isReviewPage(page)
      ? builderText("journey.step.fields.review", undefined, textOptionsOf(context))
      : isExitPage(page)
        ? builderText("journey.step.fields.exit", undefined, textOptionsOf(context))
        : undefined;
  };

  const stepRules = (view: JourneyDesignView, stepNodeId: string, journeyId: string): JourneyStepRules | undefined => {
    const journey = view.check.journey;
    const at = view.check.placement.pages.findIndex((page) => page.nodeId === stepNodeId);
    const page = journey?.pages[at];
    if (!page) {
      return undefined;
    }
    const say = (key: Parameters<typeof builderText>[0], values?: Record<string, string | number>): string => builderText(key, values, textOptionsOf(context));
    const named = (to: string): string => {
      const entry = view.index.pages.find((candidate) => candidate.pageId === to);
      return to === JOURNEY_END ? say("journey.rules.end") : entry ? pageName(entry, form(), context.locale(), context.sources?.(), journeyId) : `“${to}”`;
    };
    // A rule with no condition to a later step (or the end) always holds: nothing after it is
    // tried, so nothing falls through. The walk ignores a rule to an unknown, the same or an
    // earlier step (`journeyPath`), so such a rule leaves the Otherwise row in place.
    let always = false;
    const rows: JourneyStepRules["rows"] = (page.routes ?? []).map((route, routeIndex) => {
      const target = named(route.to);
      const blank = route.when === undefined || (typeof route.when === "string" && route.when.trim() === "");
      const to = route.to === JOURNEY_END ? journey.pages.length : journey.pages.findIndex((candidate) => candidate.id === route.to);
      always ||= blank && to > at;
      const condition = blank ? "" : (conditionInWords(route.when, form()) ?? (typeof route.when === "string" ? route.when : "…"));
      return { title: say("journey.rules.route", { number: routeIndex + 1, target }), reads: say(blank ? "journey.rules.always" : "journey.rules.when", { target, condition }), routeIndex };
    });
    // An ending stops the journey and a Check answers step goes on to the end: neither tries its rules.
    const never = page.kind === "exit" || page.kind === "review";
    const next = journey.pages[at + 1]?.id;
    if (!never && !always) {
      rows.push({ title: say("journey.rules.otherwise", { target: named(next ?? JOURNEY_END) }) });
    }
    return { pageId: page.id, note: say(never ? "journey.rules.never" : "journey.rules.note"), rows, ...(next !== undefined && !never ? { next } : {}), newRule: say("journey.rules.new") };
  };

  return {
    entry,
    blank,
    placeEntries,
    placeRefusal,
    stepRules,
    askDifferentlyLabel: (tree, nodeId, keep, offeredTypes) =>
      authoringModule?.askDifferentlyOffered(tree, nodeId, context.formRoot(), keep, offeredTypes) === true
        ? builderText("journey.designer.askDifferently", undefined, textOptionsOf(context))
        : undefined,
    findingEntries: (view) => journeyFindingEntries(view, form(), new Set(journeyMissingQuestions(form(), view.tree)), textOptionsOf(context)),
    fieldRows: (view, shown, journeyId) =>
      journeyFieldRows({
        view,
        form: form(),
        shown,
        formRoot: context.formRoot(),
        pageName: (nodeId) => {
          const page = view.index.pages.find((entry) => entry.nodeId === nodeId);
          return page ? pageName(page, form(), context.locale(), context.sources?.(), journeyId) : nodeId;
        }
      }),
    loadAuthoring: async () => {
      authoringModule ??= await loadJourneyAuthoring();
    },
    askDifferently: (tree, nodeId, keep) => authoringModule?.askDifferently(tree, nodeId, context.formRoot(), keep),
    ownRuleFields: (tree, nodeId) => authoringModule?.ownRuleFields(tree, nodeId, context.locale(), context.sources?.(), context.isValueless),
    idleOptions: () => ({
      componentTypes: [],
      componentDefinitions: journeyIdleDefinitions(),
      initialRoot: emptyJourneyTree(),
      previewWidths: false,
      nodeLabel: () => builderText("journey.designer.noJourney", undefined, textOptionsOf(context)),
      idRow: () => ({ mode: "hidden" })
    }),
    relabel: (types) => {
      const fresh = new Map(journeyComponentTypes(textOptionsOf(context)).map((entry) => [entry.type, entry]));
      return types.map((entry) => fresh.get(entry.type) ?? entry);
    },
    invalidateForm: () => {
      formVersion += 1;
    },
    form,
    questionCount,
    unassigned,
    missingQuestions: (tree) => journeyMissingQuestions(form(), tree),
    fromForm: ({ id, name, shape, title, titleFrom, titleOrigins }) =>
      journeyFromForm(context.formRoot(), { id, name, shape, ...holdsOptions, ...(title !== undefined ? { title } : {}), titleFrom, titleOrigins }),
    addUnassignedEntries,
    stepView: (stepContext) =>
      createJourneyStepView({
        ...stepContext,
        pageName: (page) => pageName(page, form(), context.locale(), context.sources?.(), stepContext.journeyId()),
        fieldLabel: (componentId) => form().components.get(componentId)?.label ?? componentId,
        text: () => textOptionsOf(context),
        tagWords: () => authoringModule?.stepTagWords(textOptionsOf(context)) ?? { notSent: "" }
      }),
    createAddPopover: (host, popoverContext) => createJourneyAddPopover(host, popoverContext),
    createEmptyState: (emptyContext) => createJourneyEmptyState(emptyContext),
    prepareTry: async () => {
      const module = await loadJourneyPreview();
      return (tryContext) => module.createJourneyPreviewSession({ ...tryContext, formIndex: form, lent: JOURNEY_PREVIEW_LENT, text: () => textOptionsOf(context) });
    },
    createMap: async (mapContext) => {
      const module = await loadJourneyMap();
      return module.createJourneyMap({
        ...mapContext,
        text: () => textOptionsOf(context),
        // The designer's own words for a step and its ways, so the map says what the inspector says.
        words: (journeyName, journeyId) => ({
          journeyName,
          text: textOptionsOf(context),
          condition: (expression) => conditionTermsInWords(expression, form()),
          pageName: (page) => pageName(page, form(), context.locale(), context.sources?.(), journeyId),
          summary: (findings) => findingsSummary(findings, textOptionsOf(context)),
          // The form field a page fills or works out, by its label as the cards name it.
          field: (componentId) => form().components.get(componentId)?.label ?? componentId,
          // What a Check answers step lists, read off the journey as it stands (`step-review.ts`).
          listed: (check) => journeyReviewListing(context.formRoot(), check.journey, { ownership: check.ownership, isValueless: context.isValueless }).count,
          ...holdsOptions
        })
      });
    },
    panelStyles: JOURNEY_DESIGNER_PANEL_STYLES,
    treeFromJourney,
    journeyFromTree
  };
}
