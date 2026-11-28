import {
  createFormTextResolver,
  type FormTextCatalog,
  type FormTextResolver
} from "../../core/localization/form-texts.js";
import { resolveText, type FormTranslations, type LanguagePack, type TextSources } from "../../core/localization/translations.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { GRID_COMPONENT_TYPE, gridColumnSlotIds } from "../../core/schema/grid.js";
import { readLegendMark } from "../../core/schema/legend-mark.js";
import {
  STEPS_COMPONENT_TYPE,
  STEP_COMPONENT_TYPE,
  activeStepId,
  stepNodesOf,
  stepStatus,
  type StepStatus,
  type StepsNavigationState
} from "../../core/schema/steps.js";
import {
  DATA_GRID_COMPONENT_TYPE,
  DATA_GRID_ROWS_CAP,
  dataGridSettingsOf,
  rowOperationsOf,
  type DataGridLayout
} from "../../core/schema/data-grid.js";
import { holdsData, isDataScopeContainer } from "../../core/tree/data-scope.js";
import { baseTypeOf, drawnBaseOf } from "../../registry/kinds.js";
import { ALWAYS_CONTAINER_TYPES, LAYOUT_CONTAINER_TYPES } from "../../registry/engine-component-types.js";
import { leftOffScreen } from "./print-options.js";
import type { LayoutSpec, RenderCollectionRows, RenderComponentModel } from "./component-model.js";
import type { RenderMode } from "./render-contracts.js";
import type { RenderJourneyMeta } from "./journey-render.js";
import type { JourneyRenderKit } from "./journey-render-kit.js";
import { defaultJourneyRenderKit } from "./journey-render-kit-default.js";
import { containerCaptionOf, gridOfCellError, rowHeadingOf, rowModelsByValuePath } from "./error-wording.js";

/**
 * The presentation fold: the render output (a flat, depth-first model list with parent links)
 * folded into the tree a renderer draws, every word in it already chosen. One walk for every
 * reader — the live renderer, print, the PDF designer's preview — so they agree on what a
 * group is called, what a tab, a step or a row is named and which words a journey page says.
 *
 * What it does, in the order the walk meets it:
 * - Children are taken slot by slot, in the container's declared slot order (a `tabs`'s tabs, a
 *   layout `grid`'s columns, else the node's own slot keys), then any slot a child occupies that
 *   the container does not declare: the order the engine's markup draws them in.
 * - A hidden component takes its subtree with it, unless the caller keeps hidden ones. On a
 *   screen (`surface: "screen"`), so does a component drawn on paper only (`print.on: "paper"`
 *   where `paperOnlyApplies`: static content, an image, a container of only those); a fold that
 *   keeps hidden ones keeps it, marked as a hidden one is (`visible: false`) and `paperOnly`.
 * - A container is never flattened. Its kind comes from the type it is drawn as: `tabs`,
 *   `steps`, a collection-bound container (`grid`: a data grid, a repeating section), else
 *   `group`. The definition's `kinds` map reads a design system's own type as an engine type: a
 *   leaf mapped to a value type is a field of that base, and a component holding children mapped
 *   to a container base (`gcds-tabs`, base `tabs`) is that container (`drawnBaseOf`). A container
 *   that is not one of the engine's, and that the caller does not know either, is folded as a
 *   group marked `unknown` and listed in {@link PresentationTree.unknownContainers}.
 * - An engine container that folds to nothing is dropped, as the markup draws nothing for it; an
 *   unknown one stays, since saying it is unknown is the point, and so does a known plugin
 *   container, which draws its wrapper (a notice's title) without children.
 * - Words: a group's legend only when its author gave it a label (`model.label` falls back to the
 *   id); a tab's label at `components › <tabs id> › tabs › <tab id> › label` in the translations,
 *   else "Tab n"; a step's label, else "Step n", its status words and the "Step n of N" line; a
 *   row's label from the container's `rowLabel` with `{{n}}` filled (spaces inside the braces
 *   allowed), else "Row n"; a grid's captions from its configuration, translated, else the form
 *   texts. The form texts are layered: a journey's and its page's texts over the host's, over the
 *   binding's language pack, over the engine's English.
 * - A journey page (`meta.journey`) is the one top node, a `page` holding the page's components
 *   (the journey kit picks them out of the tree); `pages` instead folds the whole form into one
 *   page node per page listed, in order, as a printed journey shows its path.
 *
 * Plain data out: nodes hold the models they came from by reference, nothing is drawn.
 */

/** A tab or step a node sits behind: which one must be open for the node to be seen, outermost first. */
export type PresentationReveal =
  | { kind: "tab"; tabsId: string; slotId: string }
  | { kind: "step"; stepsId: string; stepId: string };

interface NodeBase {
  /** The component id (for a page: the page id). */
  id: string;
  /**
   * The instance: the component id, or for a component drawn in a row of a collection its
   * row-scoped field id (every row's copy shares the component id).
   */
  key: string;
  /** The model the node folds; absent on a page, which is no component. */
  model?: RenderComponentModel;
  /**
   * Whether the model is visible (`false` only when the fold keeps hidden components): a rule
   * hides it, or a screen fold kept a component drawn on paper only ({@link paperOnly}).
   */
  visible: boolean;
  /** A screen fold that keeps hidden components kept this one, which is drawn on paper only (`print.on: "paper"`). */
  paperOnly?: true;
  /** The tabs and steps that must be open for this node to be seen, outermost first. */
  reveal: PresentationReveal[];
}

/** A component the binding draws as one piece: an input, a button, static content, an image. */
export interface PresentationField extends NodeBase {
  kind: "field";
  model: RenderComponentModel;
  /** The type written on the component. */
  type: string;
  /** The engine type it is read as (itself for an engine type; its base in the definition's `kinds` map otherwise). */
  base: string;
  /** In a row of a collection: the row's label ("Row 2", "Child 2"), for a summary line or a hidden header. */
  rowLabel?: string;
}

/** One slot of a container, with the nodes folded into it. */
export interface PresentationSlot {
  slotId: string;
  children: PresentationNode[];
}

/** A container drawn as a group around its children: a fieldset, panel, section, layout grid, row, button group, a lone step. */
export interface PresentationGroup extends NodeBase {
  kind: "group";
  model: RenderComponentModel;
  type: string;
  base: string;
  /** The author's label; absent when the author gave none (the group is then unnamed). */
  legend?: string;
  /** The description, under the legend; absent without a legend, which it rides with. */
  hint?: string;
  /** The legend is visually hidden (it still names the group). */
  hideLegend: boolean;
  /** `configuration.legendMark`: the required or optional mark after the legend. */
  legendMark?: "required" | "optional";
  /** Nesting depth, counted from the form's heading level (`headingLevel`, 1 by default) for a container directly in the form or page: it heads itself a level under this. */
  level: number;
  layout: LayoutSpec;
  classNames: string[];
  /** The slots in drawn order; `children` is every slot's children in that order. */
  slots: PresentationSlot[];
  children: PresentationNode[];
  /** No adapter the caller knows and no engine container of that base: reported, drawn as a plain group. */
  unknown?: true;
}

export interface PresentationTab {
  slotId: string;
  /** The tab's label in the form's language, else "Tab n" by its place. */
  label: string;
  /** Blocking errors on the components inside the tab. */
  errorCount: number;
  children: PresentationNode[];
}

export interface PresentationTabs extends NodeBase {
  kind: "tabs";
  model: RenderComponentModel;
  type: string;
  /** The engine type it is drawn as: `tabs`, for the engine's own and for a type the definition's `kinds` map gives that base. */
  base: string;
  legend?: string;
  hint?: string;
  hideLegend: boolean;
  level: number;
  classNames: string[];
  /** Every slot the tabs declare or a child occupies, in that order. */
  tabs: PresentationTab[];
}

export interface PresentationStep {
  id: string;
  model: RenderComponentModel;
  /** The step's label, else "Step n" by its place. */
  label: string;
  status: StepStatus;
  /** What a screen reader hears after the label: "completed", "not completed", or nothing for the active step. */
  statusText: string;
  /** "Step 2 of 3": the words a step heading opens with. */
  tag: string;
  /**
   * A rule hides it (or, on a screen, it is drawn on paper only): listed (the indicator counts
   * it) but holding nothing unless the fold keeps hidden components.
   */
  visible: boolean;
  /** Kept by a screen fold that keeps hidden components, though drawn on paper only. */
  paperOnly?: true;
  /** Drawn now: the active step on a live form, every step in a review. */
  shown: boolean;
  hideLabel: boolean;
  classNames: string[];
  slots: PresentationSlot[];
  children: PresentationNode[];
}

export interface PresentationSteps extends NodeBase {
  kind: "steps";
  model: RenderComponentModel;
  type: string;
  level: number;
  classNames: string[];
  activeStepId: string | undefined;
  /** "Step n of N" for the active step; empty when the container holds no step. */
  progress: string;
  steps: PresentationStep[];
  /** What else the container holds beside its steps (not drawn by the engine's markup either). */
  others: PresentationNode[];
  /** The step Back goes to, with its words; absent on the first step and in a review. */
  back?: { stepId: string; label: string };
  /** The step Continue goes to, with its words; absent on the last step and in a review. */
  next?: { stepId: string; label: string };
}

export interface PresentationGridColumn {
  id: string;
  /** The column's heading: its component's label, empty when the author gave none. */
  label: string;
  required: boolean;
  model: RenderComponentModel;
}

export interface PresentationGridCell {
  columnId: string;
  /** The row's copy of the column's component, folded (a container column holds several). Empty when the row draws none. */
  children: PresentationNode[];
}

export interface PresentationGridRow {
  index: number;
  /**
   * The row's identity: the grid's key and the entry's stable key (`row.rowKey`), which a
   * removal or a move leaves with the row; positional (`collectionPath[index]`) only when the
   * output carries no entry keys.
   */
  key: string;
  label: string;
  cells: PresentationGridCell[];
  /** The row buttons that can be pressed now (the grid offers them, the bounds allow, nothing is locked). */
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

/** A collection-bound container: a data grid, or a repeating section drawn the same way stacked. */
export interface PresentationGrid extends NodeBase {
  kind: "grid";
  model: RenderComponentModel;
  type: string;
  base: string;
  legend?: string;
  hint?: string;
  hideLegend: boolean;
  legendMark?: "required" | "optional";
  level: number;
  classNames: string[];
  collectionPath: string;
  /** The grid's layout setting; a repeating section is `stacked`. */
  layout: DataGridLayout;
  showHeader: boolean;
  showRowNumbers: boolean;
  columns: PresentationGridColumn[];
  rows: PresentationGridRow[];
  /** The buttons the grid offers (live form only); each may still be disabled, see the row's and {@link canAdd}. */
  actions: { add: boolean; remove: boolean; reorder: boolean };
  canAdd: boolean;
  minRows: number;
  maxRows: number | undefined;
  /** Disabled or read-only: no button can be pressed. */
  locked: boolean;
  captions: { add: string; remove: string; moveUp: string; moveDown: string; empty: string; actions: string };
  /** The grid's own blocking errors, then each cell error no drawn row owns, worded. */
  errorMessages: string[];
}

/** A journey page, or one page of a printed journey's path. */
export interface PresentationPage extends NodeBase {
  kind: "page";
  /** The page's heading in the form's language; empty for an untitled page, which draws none. */
  title: string;
  description?: string;
  /** "Page n of N" when the journey counts its question pages. */
  progress?: string;
  heading: "shown" | "hidden";
  back?: { pageId: string; label: string };
  /** Continue on an inner question page, Submit on the last unless the page has its own; none on an exit page. */
  action?: { kind: "continue" | "submit"; label: string };
  /** A server check is out: the words of the checking line. */
  checking?: string;
  /** The page meta the node was folded from; absent for a page of {@link PresentationFoldOptions.pages}. */
  journey?: RenderJourneyMeta;
  children: PresentationNode[];
}

export type PresentationNode =
  | PresentationField
  | PresentationGroup
  | PresentationTabs
  | PresentationSteps
  | PresentationGrid
  | PresentationPage;

export interface PresentationTree {
  mode: RenderMode;
  locale: string;
  /** The form's top nodes; on a journey page, the page alone. */
  nodes: PresentationNode[];
  /** The journey page, when one is drawn (the same object as `nodes[0]`). */
  page?: PresentationPage;
  /** Every field in drawn order, rows included. */
  fields: PresentationField[];
  /** Containers folded as plain groups because nothing knows their type, once per component. */
  unknownContainers: Array<{ componentId: string; type: string }>;
  /** The form texts the tree was worded with, for what the renderer words itself (the summary heading, a notice). */
  text: FormTextResolver;
}

/** What the fold reads from a render output. */
export interface PresentationFoldInput {
  mode: RenderMode;
  components: readonly RenderComponentModel[];
  meta: {
    navigation: StepsNavigationState;
    journey?: RenderJourneyMeta | undefined;
  };
}

export interface PresentationFoldOptions {
  /** The language the output was built in (the state's locale). */
  locale: string;
  /** The host's form texts (`ErrorWordingSources.texts`); a journey's and its page's sit over them. */
  texts?: FormTextCatalog | undefined;
  /** The binding's language pack, under the host's texts and over the engine's English. */
  bindingTexts?: FormTextCatalog | undefined;
  /** The binding's language pack by locale (`LiveBinding.texts`), under the form's `texts` translations and over the engine's English. */
  bindingPack?: LanguagePack | undefined;
  /** The definition's own translations. */
  translations?: FormTranslations | undefined;
  /** The host's translations; an entry there wins over the definition's. */
  translationCatalog?: TranslationCatalog | undefined;
  /** The definition's `kinds` map (type -> engine type). */
  kinds?: Readonly<Record<string, string>> | undefined;
  /** What picks a journey page's components; the default kit when absent (the Noop draws the form whole). */
  journeyKit?: JourneyRenderKit | undefined;
  /** Keep hidden components (`visible: false` on their nodes), as the builder canvas and a print plan want. */
  includeHidden?: boolean | undefined;
  /**
   * What the tree is drawn on. `"screen"` (the live renderer) leaves out a component drawn on
   * paper only (`print.on: "paper"` where `paperOnlyApplies`), as it leaves out a hidden one;
   * `"paper"` (print) and absent fold every component.
   */
  surface?: "screen" | "paper" | undefined;
  /**
   * Keep an engine container with nothing in it (a group, tabs or steps whose slots are all
   * empty) rather than leaving it out: the builder canvas, where an empty container is a place
   * to drop the first component into.
   */
  keepEmpty?: boolean | undefined;
  /**
   * How a collection-bound container folds its rows: one per entry (`"entries"`, the default), or
   * the template's children at their own ids as its one row, with no row button (`"template"`,
   * what the builder canvas draws while editing).
   */
  dataGridRows?: "entries" | "template" | undefined;
  /** A container type the caller can draw although it is no engine container (a plugin's): not reported. */
  isKnownContainer?: ((type: string, model: RenderComponentModel) => boolean) | undefined;
  /**
   * Each data grid's row bounds as the runtime last worked them out (`FormRuntime.dataGridRowBounds`):
   * its formulas' where they came to a whole number. A grid not named keeps its configuration's.
   */
  dataGridRowBounds?: Readonly<Record<string, { minRows: number; maxRows: number | undefined }>> | undefined;
  /**
   * A printed journey's path: the whole form folded into one page per entry, in order, each holding
   * the components it lists (with their subtrees), each component once: on the earliest page that
   * lists it or a container holding it. Wins over `meta.journey`.
   */
  pages?: ReadonlyArray<{ pageId: string; title: string; description?: string | undefined; members: readonly string[] }> | undefined;
  /**
   * The form's own heading level, its place in the page's outline (the host's `headingLevel`); 1
   * when left out. A container directly in the form (or a journey page) is at this level and
   * heads itself a level under it; a printed journey's pages head at it, their containers one
   * level further down.
   */
  headingLevel?: number | undefined;
}

/** The engine's own containers, by type: the registry's two lists. */
const ENGINE_CONTAINER_TYPES: ReadonlySet<string> = new Set([...ALWAYS_CONTAINER_TYPES, ...LAYOUT_CONTAINER_TYPES]);

/** The slot a child is filed under when its model carries none. */
const FALLBACK_SLOT_ID = "content";

function configurationOf(node: ComponentNode): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

/** Whether the author gave the component a label (`model.label` falls back to the id). */
function hasConfiguredLabel(node: ComponentNode): boolean {
  const raw = configurationOf(node)["label"];
  return (typeof raw === "string" && raw.length > 0) || (raw !== null && typeof raw === "object" && !Array.isArray(raw));
}

function legendMarkOf(node: ComponentNode): "required" | "optional" | undefined {
  return readLegendMark(node.configuration);
}

/** A `tabs` container's declared tabs: id and default-language label, in authored order. */
function tabDescriptorsOf(node: ComponentNode): Array<{ id: string; label: string | undefined }> {
  const raw = configurationOf(node)["tabs"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ id: string; label: string | undefined }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    const label = (entry as { label?: unknown }).label;
    out.push({ id, label: typeof label === "string" ? label : undefined });
  }
  return out;
}

/** The slots a container declares through its configuration, else its node's own slot keys. `base` is the type it is drawn as. */
function declaredSlotIds(node: ComponentNode, base: string): string[] {
  if (base === "tabs") {
    const declared = tabDescriptorsOf(node).map((tab) => tab.id);
    if (declared.length > 0) {
      return declared;
    }
  }
  if (base === GRID_COMPONENT_TYPE) {
    return gridColumnSlotIds(node.configuration);
  }
  return Object.keys(node.children ?? {});
}

/**
 * A node's instance key: the component id, or for one drawn in a row of a collection the row's
 * stable key (`rowKey`, from the enclosing row) plus the id, so a keyed repeat moves the node
 * with its row; the row-scoped field id (positional) when the row carries no stable key.
 */
function instanceKeyOf(model: RenderComponentModel, rowKey: string | undefined): string {
  if (model.row === undefined) {
    return model.id;
  }
  return rowKey !== undefined ? `${rowKey}/${model.id}` : model.accessibility.fieldId;
}

/** Whether a row template holds an answer to count a row by: a field, or a container holding one. */
function holdsAnswers(nodes: readonly ComponentNode[]): boolean {
  return nodes.some((node) =>
    node.children !== undefined
      ? holdsAnswers(Object.values(node.children).flat())
      : holdsData(node) && !isDataScopeContainer(node) && node.collection === undefined
  );
}

function childrenMapOf(models: readonly RenderComponentModel[]): Map<string, RenderComponentModel[]> {
  const map = new Map<string, RenderComponentModel[]>();
  for (const model of models) {
    if (model.parentId === undefined) {
      continue;
    }
    const list = map.get(model.parentId);
    if (list) {
      list.push(model);
    } else {
      map.set(model.parentId, [model]);
    }
  }
  return map;
}

/** Blocking errors on the fields under `nodes`, rows included. */
function blockingCount(nodes: readonly PresentationNode[]): number {
  let count = 0;
  const visit = (node: PresentationNode): void => {
    switch (node.kind) {
      case "field":
        count += node.model.blockingErrors.length;
        return;
      case "group":
      case "page":
        node.children.forEach(visit);
        return;
      case "tabs":
        node.tabs.forEach((tab) => tab.children.forEach(visit));
        return;
      case "steps":
        node.steps.forEach((step) => step.children.forEach(visit));
        node.others.forEach(visit);
        return;
      case "grid":
        count += node.errorMessages.length;
        node.rows.forEach((row) => row.cells.forEach((cell) => cell.children.forEach(visit)));
        return;
    }
  };
  nodes.forEach(visit);
  return count;
}

/** Folds a render output into its worded presentation tree. */
export function foldPresentation(
  output: PresentationFoldInput,
  options: PresentationFoldOptions
): PresentationTree {
  const locale = options.locale;
  const kit = options.journeyKit ?? defaultJourneyRenderKit();
  const journey = options.pages === undefined ? output.meta.journey : undefined;
  const text = createFormTextResolver(
    locale,
    journey ? kit.pageTexts(options.texts, journey.texts) : options.texts,
    options.bindingTexts,
    { translations: options.translations, catalog: options.translationCatalog, pack: options.bindingPack }
  );
  const sources: TextSources = { translations: options.translations, catalog: options.translationCatalog };
  const live = output.mode === "interactive";
  const includeHidden = options.includeHidden === true;
  const keepEmpty = options.keepEmpty === true;
  const onScreen = options.surface === "screen";
  /** Read once per model: whether a screen leaves it out as drawn on paper only. The root never is. */
  const paperOnlyRead = new Map<RenderComponentModel, boolean>();
  const paperOnly = (model: RenderComponentModel): boolean => {
    if (!onScreen || model.parentId === undefined) {
      return false;
    }
    let read = paperOnlyRead.get(model);
    if (read === undefined) {
      read = leftOffScreen(model.node, options.kinds);
      paperOnlyRead.set(model, read);
    }
    return read;
  };
  /** Whether the model is seen here: a rule shows it, and the surface draws it. */
  const shown = (model: RenderComponentModel): boolean => model.visible && !paperOnly(model);
  const navigation = output.meta.navigation;

  const byId = new Map<string, RenderComponentModel>();
  for (const model of output.components) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  const rowModels = rowModelsByValuePath(output);
  const fields: PresentationField[] = [];
  const unknownContainers: Array<{ componentId: string; type: string }> = [];
  const reported = new Set<string>();

  interface Scope {
    /** Children by parent id: the output's, or one row's. */
    childrenOf: ReadonlyMap<string, RenderComponentModel[]>;
    level: number;
    reveal: PresentationReveal[];
    rowLabel?: string;
    /** The enclosing row's stable key, when its entry has one. */
    rowKey?: string;
  }

  const isContainer = (model: RenderComponentModel, scope: Scope): boolean =>
    model.node.children !== undefined ||
    model.rows !== undefined ||
    model.isLayoutContainer ||
    ENGINE_CONTAINER_TYPES.has(baseTypeOf(model.type, options.kinds)) ||
    (scope.childrenOf.get(model.id)?.length ?? 0) > 0;

  /** A container's children grouped by slot: declared slots first, then any a child occupies. */
  const slotsOf = (model: RenderComponentModel, scope: Scope): Array<{ slotId: string; models: RenderComponentModel[] }> => {
    const children = scope.childrenOf.get(model.id) ?? [];
    const bySlot = new Map<string, RenderComponentModel[]>();
    for (const child of children) {
      const slotId = child.slotId ?? FALLBACK_SLOT_ID;
      const list = bySlot.get(slotId);
      if (list) {
        list.push(child);
      } else {
        bySlot.set(slotId, [child]);
      }
    }
    const slotIds = [...new Set([...declaredSlotIds(model.node, drawnBaseOf(model.node, options.kinds)), ...bySlot.keys()])];
    return slotIds.map((slotId) => ({ slotId, models: bySlot.get(slotId) ?? [] }));
  };

  const foldSlots = (model: RenderComponentModel, scope: Scope, inner: Scope): PresentationSlot[] =>
    slotsOf(model, scope).map(({ slotId, models }) => ({ slotId, children: models.flatMap((child) => foldOne(child, inner)) }));

  const legendOf = (model: RenderComponentModel): Pick<PresentationGroup, "legend" | "hint" | "hideLegend" | "legendMark"> => {
    const named = hasConfiguredLabel(model.node);
    const mark = legendMarkOf(model.node);
    return {
      ...(named ? { legend: model.label } : {}),
      ...(named && model.description !== undefined ? { hint: model.description } : {}),
      hideLegend: configurationOf(model.node)["hideLabel"] === true,
      ...(mark !== undefined ? { legendMark: mark } : {})
    };
  };

  const common = (model: RenderComponentModel, scope: Scope) => ({
    id: model.id,
    key: instanceKeyOf(model, scope.rowKey),
    model,
    visible: shown(model),
    ...(paperOnly(model) ? { paperOnly: true as const } : {}),
    reveal: scope.reveal
  });

  const foldTabs = (model: RenderComponentModel, scope: Scope): PresentationTabs | undefined => {
    const declared = tabDescriptorsOf(model.node);
    const { legend, hint, hideLegend } = legendOf(model);
    const tabs = slotsOf(model, scope).map(({ slotId, models }, index): PresentationTab => {
      const inner: Scope = { ...scope, level: scope.level + 1, reveal: [...scope.reveal, { kind: "tab", tabsId: model.id, slotId }] };
      const children = models.flatMap((child) => foldOne(child, inner));
      const authored = declared.find((tab) => tab.id === slotId)?.label;
      const label =
        authored !== undefined
          ? resolveText(authored, { kind: "components", owner: model.id, path: ["tabs", slotId, "label"] }, locale, sources)
          : undefined;
      // A tab the descriptor leaves untitled is named by the label of the `tab` component that is
      // its content, when the author gave it one; the tab container draws no legend of its own.
      const own = models.length === 1 && models[0]?.type === "tab" && hasConfiguredLabel(models[0].node) ? models[0].label : undefined;
      return {
        slotId,
        // An untitled tab is named by its place, never its id.
        label: label !== undefined && label.length > 0 ? label : own !== undefined && own.length > 0 ? own : text("tabFallback", { n: index + 1 }),
        errorCount: blockingCount(children),
        children
      };
    });
    if (tabs.every((tab) => tab.children.length === 0) && !keepEmpty) {
      return undefined;
    }
    return {
      kind: "tabs",
      ...common(model, scope),
      type: model.type,
      base: "tabs",
      ...(legend !== undefined ? { legend } : {}),
      ...(hint !== undefined ? { hint } : {}),
      hideLegend,
      level: scope.level,
      classNames: model.classNames,
      tabs
    };
  };

  const foldSteps = (model: RenderComponentModel, scope: Scope): PresentationSteps | undefined => {
    const stepNodes = stepNodesOf(model.node);
    const review = !live;
    // A step its rules hide is listed but never the one shown, nor where Back or Continue go:
    // the next step shown takes its place, else the one before it.
    const open = (id: string): boolean => {
      const step = byId.get(id);
      return review || includeHidden || step === undefined || shown(step);
    };
    const asked = activeStepId(model.node, navigation);
    const askedIndex = stepNodes.findIndex((step) => step.id === asked);
    const active =
      asked === undefined || open(asked)
        ? asked
        : (stepNodes.slice(askedIndex + 1).find((step) => open(step.id)) ?? stepNodes.slice(0, askedIndex).reverse().find((step) => open(step.id)))?.id ??
          asked;
    const total = stepNodes.length;
    const steps: PresentationStep[] = [];
    const others: PresentationNode[] = [];
    for (const { models } of slotsOf(model, scope)) {
      for (const child of models) {
        const index = child.type === STEP_COMPONENT_TYPE ? stepNodes.findIndex((step) => step.id === child.id) : -1;
        if (index < 0) {
          others.push(...foldOne(child, { ...scope, level: scope.level + 1 }));
          continue;
        }
        // Every step is listed, as the indicator lists them; a hidden one holds nothing.
        const inner: Scope = { ...scope, level: scope.level + 1, reveal: [...scope.reveal, { kind: "step", stepsId: model.id, stepId: child.id }] };
        const slots = shown(child) || includeHidden ? foldSlots(child, scope, inner) : [];
        const status = stepStatus(child.id, active, navigation);
        steps.push({
          id: child.id,
          model: child,
          label: hasConfiguredLabel(child.node) ? child.label : text("stepFallback", { n: index + 1 }),
          status,
          statusText: status === "completed" ? text("stepCompleted") : status === "active" ? "" : text("stepNotCompleted"),
          tag: text("stepOf", { n: index + 1, total }),
          visible: shown(child),
          ...(paperOnly(child) ? { paperOnly: true as const } : {}),
          shown: review || child.id === active,
          hideLabel: configurationOf(child.node)["hideLabel"] === true,
          classNames: child.classNames,
          slots,
          children: slots.flatMap((slot) => slot.children)
        });
      }
    }
    if (steps.every((step) => step.children.length === 0) && others.length === 0 && !(keepEmpty && steps.length > 0)) {
      return undefined;
    }
    const activeIndex = Math.max(0, stepNodes.findIndex((step) => step.id === active));
    const previous = review ? undefined : stepNodes.slice(0, activeIndex).reverse().find((step) => open(step.id));
    const following = review ? undefined : stepNodes.slice(activeIndex + 1).find((step) => open(step.id));
    return {
      kind: "steps",
      ...common(model, scope),
      type: model.type,
      level: scope.level,
      classNames: model.classNames,
      activeStepId: active,
      progress: total > 0 ? text("stepOf", { n: activeIndex + 1, total }) : "",
      steps,
      others,
      ...(previous ? { back: { stepId: previous.id, label: text("back") } } : {}),
      ...(following ? { next: { stepId: following.id, label: text("continue") } } : {})
    };
  };

  const foldGrid = (model: RenderComponentModel, rows: RenderCollectionRows, scope: Scope): PresentationGrid => {
    const isDataGrid = baseTypeOf(model.type, options.kinds) === DATA_GRID_COMPONENT_TYPE;
    const settings = isDataGrid ? dataGridSettingsOf(model.node) : undefined;
    const given = options.dataGridRowBounds;
    // Own keys only: a grid called `constructor` reads no prototype's.
    const bounds = (isDataGrid && given && Object.prototype.hasOwnProperty.call(given, model.id) ? given[model.id] : undefined) ?? settings;
    const minRows = bounds?.minRows ?? 0;
    const maxRows = bounds?.maxRows;
    const operations = rowOperationsOf(model.node);
    // The template drawn as the one row (the builder canvas) offers no row button.
    const template = options.dataGridRows === "template";
    const actions = template
      ? { add: false, remove: false, reorder: false }
      : { add: live && operations.add, remove: live && operations.remove, reorder: live && operations.reorder };
    const locked = model.disabled || model.readOnly;
    // The template's children in slot order name the columns; a column hidden by a rule is not drawn.
    const columnsModels = slotsOf(model, scope)
      .flatMap((slot) => slot.models)
      .filter((child) => shown(child) || includeHidden);
    const columns = columnsModels.map((child) => ({
      id: child.id,
      label: hasConfiguredLabel(child.node) ? child.label : "",
      required: child.accessibility.required,
      model: child
    }));
    const count = rows.entries.length;
    /** The template's children at their own ids, as the grid's one row. */
    const templateRow = (): PresentationGridRow => {
      const label = rowHeadingOf(model.node, 1, locale, sources, text);
      const rowScope: Scope = { childrenOf: scope.childrenOf, level: scope.level + 1, reveal: scope.reveal, rowLabel: label };
      return {
        index: 0,
        key: `${instanceKeyOf(model, scope.rowKey)}#template`,
        label,
        cells: columns.map((column) => ({ columnId: column.id, children: foldOne(column.model, rowScope) })),
        canRemove: false,
        canMoveUp: false,
        canMoveDown: false
      };
    };
    const rowsOut = template ? [templateRow()] : rows.entries.map((entry, index): PresentationGridRow => {
      const label = rowHeadingOf(model.node, index + 1, locale, sources, text);
      const entryKey = entry.find((candidate) => candidate.row?.rowKey !== undefined)?.row?.rowKey;
      const stableKey = entryKey !== undefined ? `${instanceKeyOf(model, scope.rowKey)}#${entryKey}` : undefined;
      const rowScope: Scope = {
        childrenOf: childrenMapOf(entry),
        level: scope.level + 1,
        reveal: scope.reveal,
        rowLabel: label,
        ...(stableKey !== undefined ? { rowKey: stableKey } : {})
      };
      const cells = columns.map((column) => {
        const cell = entry.find((candidate) => candidate.parentId === model.id && candidate.id === column.id);
        return { columnId: column.id, children: cell ? foldOne(cell, rowScope) : [] };
      });
      return {
        index,
        key: stableKey ?? `${rows.collectionPath}[${index}]`,
        label,
        cells,
        canRemove: actions.remove && !locked && count > minRows,
        canMoveUp: actions.reorder && !locked && index > 0,
        canMoveDown: actions.reorder && !locked && index < count - 1
      };
    });
    // The grid's own errors, then each cell error no drawn row owns, worded by its field's catalog.
    const own = model.errorMessages ?? [];
    const cellMessages = output.components.flatMap((child) =>
      child.blockingErrors.flatMap((error, at) =>
        gridOfCellError(byId, rowModels, error)?.id === model.id ? [child.errorMessages?.[at] ?? error.code] : []
      )
    );
    const { legend, hint, hideLegend, legendMark } = legendOf(model);
    return {
      kind: "grid",
      ...common(model, scope),
      type: model.type,
      base: baseTypeOf(model.type, options.kinds),
      ...(legend !== undefined ? { legend } : {}),
      ...(hint !== undefined ? { hint } : {}),
      hideLegend,
      ...(legendMark !== undefined ? { legendMark } : {}),
      level: scope.level,
      classNames: model.classNames,
      collectionPath: rows.collectionPath,
      layout: settings?.layout ?? "stacked",
      showHeader: settings?.showHeader ?? true,
      showRowNumbers: settings?.showRowNumbers ?? configurationOf(model.node)["showRowNumbers"] !== false,
      columns,
      rows: rowsOut,
      actions,
      canAdd: actions.add && !locked && count < (maxRows ?? DATA_GRID_ROWS_CAP) && holdsAnswers(Object.values(model.node.children ?? {}).flat()),
      minRows,
      maxRows,
      locked,
      captions: {
        add: containerCaptionOf(model.node, "addLabel", locale, sources) ?? text("dataGridAdd"),
        remove: containerCaptionOf(model.node, "removeLabel", locale, sources) ?? text("dataGridRemove"),
        moveUp: text("dataGridMoveUp"),
        moveDown: text("dataGridMoveDown"),
        empty: containerCaptionOf(model.node, "emptyText", locale, sources) ?? text("dataGridEmpty"),
        actions: text("dataGridActions")
      },
      errorMessages: [...own, ...cellMessages]
    };
  };

  const foldGroup = (model: RenderComponentModel, scope: Scope): PresentationGroup | undefined => {
    const type = drawnBaseOf(model.node, options.kinds);
    const known = !ENGINE_CONTAINER_TYPES.has(type) && options.isKnownContainer?.(model.type, model) === true;
    const unknown = !ENGINE_CONTAINER_TYPES.has(type) && !known;
    if (unknown && !reported.has(model.id)) {
      reported.add(model.id);
      unknownContainers.push({ componentId: model.id, type: model.type });
    }
    const slots = foldSlots(model, scope, { ...scope, level: scope.level + 1 });
    const children = slots.flatMap((slot) => slot.children);
    // An engine container with nothing in it draws nothing; a plugin's known container keeps its
    // wrapper (a notice's title, an empty details), as the markup does.
    if (children.length === 0 && !unknown && !known && !keepEmpty) {
      return undefined;
    }
    // A step outside a steps container is a section headed by its label, else its id, as the
    // engine's markup heads it.
    const legend = type === STEP_COMPONENT_TYPE && !hasConfiguredLabel(model.node) ? { legend: model.id } : {};
    return {
      kind: "group",
      ...common(model, scope),
      type: model.type,
      base: type,
      ...legendOf(model),
      ...legend,
      level: scope.level,
      layout: model.layout,
      classNames: model.classNames,
      slots,
      children,
      ...(unknown ? { unknown: true as const } : {})
    };
  };

  const foldOne = (model: RenderComponentModel, scope: Scope): PresentationNode[] => {
    if (!shown(model) && !includeHidden) {
      return [];
    }
    if (model.rows !== undefined) {
      return [foldGrid(model, model.rows, scope)];
    }
    if (!isContainer(model, scope)) {
      const field: PresentationField = {
        kind: "field",
        ...common(model, scope),
        type: model.type,
        base: baseTypeOf(model.type, options.kinds),
        ...(scope.rowLabel !== undefined && model.row !== undefined ? { rowLabel: scope.rowLabel } : {})
      };
      fields.push(field);
      return [field];
    }
    const type = drawnBaseOf(model.node, options.kinds);
    const folded = type === "tabs" ? foldTabs(model, scope) : type === STEPS_COMPONENT_TYPE ? foldSteps(model, scope) : foldGroup(model, scope);
    return folded ? [folded] : [];
  };

  /**
   * The root's children, folded at the given level (the root is the form, not a node). A root the
   * author gave a label is a group carrying that label as its legend (and hint), which the adapter
   * drawing it draws, or, for an adapter that draws the root as no group (`formLabelled`), the
   * renderer gives the `<form>` as its accessible name; a hint alone has no group to describe. The group's
   * children keep the level they had without it (a legend is no heading, so the root costs no
   * heading level), and a root with no label folds to its children alone. A root of a
   * non-engine type the caller draws (`isKnownContainer`) is always a group.
   */
  const foldRoot = (models: readonly RenderComponentModel[], level: number): PresentationNode[] => {
    const root = models.find((model) => model.parentId === undefined);
    if (!root) {
      return [];
    }
    const scope: Scope = { childrenOf: childrenMapOf(models), level, reveal: [] };
    const slots = slotsOf(root, scope).map(({ slotId, models: children }) => ({
      slotId,
      children: children.flatMap((child) => foldOne(child, scope))
    }));
    const children = slots.flatMap((slot) => slot.children);
    const base = drawnBaseOf(root.node, options.kinds);
    // A root of a type of its own that the caller draws (a design-time canvas's: the PDF
    // designer's page sheet, a journey's face) is always its group, labelled or not and empty or
    // not: its drawing is the canvas's face, where an empty slot still takes a drop.
    const ownRoot = !ENGINE_CONTAINER_TYPES.has(base) && options.isKnownContainer?.(root.type, root) === true;
    if (!ownRoot && (!hasConfiguredLabel(root.node) || children.length === 0)) {
      return children;
    }
    return [
      {
        kind: "group",
        ...common(root, scope),
        type: root.type,
        base,
        ...legendOf(root),
        level,
        layout: root.layout,
        classNames: root.classNames,
        slots,
        children
      }
    ];
  };

  // The form's place in the page's outline: the levels below count from it.
  const formLevel = Math.min(6, Math.max(1, Math.round(Number.isFinite(options.headingLevel) ? (options.headingLevel as number) : 1)));
  let nodes: PresentationNode[];
  let page: PresentationPage | undefined;
  if (options.pages !== undefined) {
    // One page per entry, each component once, in the order the pages list them: a component
    // belongs to the earliest page that draws it, whether it lists it or a container it lists
    // holds it, so a later page leaves it out (as Check answers does).
    const placed = new Set<string>();
    nodes = options.pages.map((entry) => {
      const members = entry.members.filter((id) => !placed.has(id));
      const drawn = kit.pageComponents(output.components, { members }).filter((model) => model.parentId === undefined || !placed.has(model.id));
      for (const model of drawn) {
        if (model.parentId !== undefined) {
          placed.add(model.id);
        }
      }
      return {
        kind: "page" as const,
        id: entry.pageId,
        key: entry.pageId,
        visible: true,
        reveal: [],
        title: entry.title,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        heading: "shown" as const,
        children: foldRoot(drawn, formLevel + 1)
      };
    });
  } else if (journey) {
    // A questions page or a Check answers page (`kind: "review"`): both count and both have an action.
    const questions = journey.kind !== "exit";
    page = {
      kind: "page",
      id: journey.pageId,
      key: journey.pageId,
      visible: true,
      reveal: [],
      title: journey.title,
      ...(journey.description !== undefined ? { description: journey.description } : {}),
      // An exit page is no question and has no place in the count.
      ...(journey.progress === "count" && questions ? { progress: text("pageOf", { n: journey.number, total: journey.total }) } : {}),
      heading: journey.heading,
      ...(journey.backPageId !== undefined ? { back: { pageId: journey.backPageId, label: text("back") } } : {}),
      ...(questions && !journey.final
        ? { action: { kind: "continue" as const, label: text("continue") } }
        : questions && !journey.hasOwnSubmit
          ? { action: { kind: "submit" as const, label: text("submit") } }
          : {}),
      ...(journey.pending !== undefined ? { checking: text("checking") } : {}),
      journey,
      children: foldRoot(kit.pageComponents(output.components, journey), formLevel)
    };
    nodes = [page];
  } else {
    nodes = foldRoot(output.components, formLevel);
  }

  return {
    mode: output.mode,
    locale,
    nodes,
    ...(page ? { page } : {}),
    fields,
    unknownContainers,
    text
  };
}

/** Every node of a tree, depth first, rows and tab panels included: for a reader looking for one. */
export function presentationNodes(nodes: readonly PresentationNode[]): PresentationNode[] {
  const out: PresentationNode[] = [];
  const visit = (node: PresentationNode): void => {
    out.push(node);
    switch (node.kind) {
      case "field":
        return;
      case "group":
      case "page":
        node.children.forEach(visit);
        return;
      case "tabs":
        node.tabs.forEach((tab) => tab.children.forEach(visit));
        return;
      case "steps":
        node.steps.forEach((step) => step.children.forEach(visit));
        node.others.forEach(visit);
        return;
      case "grid":
        node.rows.forEach((row) => row.cells.forEach((cell) => cell.children.forEach(visit)));
        return;
    }
  };
  nodes.forEach(visit);
  return out;
}

