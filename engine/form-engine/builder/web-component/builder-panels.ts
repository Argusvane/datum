import { BuilderController, dependentLines, dependentsHeading, type BuilderChangeEvent, type BuilderChangeReason, type BuilderComponentType, type CanvasRegionOwner, type UnsavedChangesPrompt } from "../controller/builder-controller.js";
import type { CanvasMoveHost } from "../drag-drop/move-ui.js";
import type { BuilderMode, BuilderTrySession, CanvasSurfaceOptions } from "./builder-modes.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import { BuilderWords, builderText, formatListText, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { kernelRegexRisky } from "../../core/expressions/compile.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import {
  INLINE_OPTIONS_PROPERTY,
  MAX_IMPORTED_OPTIONS,
  MAX_IMPORTED_OPTIONS_BYTES,
  parseInlineOptions,
  type InlineOption
} from "../../core/schema/inline-options.js";
import { SEAMLESS_FRAME_ID, readFormChromeConfiguration, resolveFrame, type FormChromeConfiguration } from "../../core/schema/form-chrome.js";

import {
  parseValidationMessageCatalog,
  type ValidationMessageCatalog
} from "../../core/localization/validation-messages.js";
import type { LocalizedText } from "../../core/schema/contracts.js";
import { base64ToBytes, matchesAccept, readAcceptTokens, type Base64FileAttachment } from "../../core/schema/file-upload.js";
import { readIccColorSpace } from "../../core/schema/pdf-layout.js";
import { embeddedBytesProblem, type DefinitionBudget } from "../definition-budget.js";
import { encodeBase64 } from "../../render/core/file-storage.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { writeDragPayload } from "../drag-drop/html5-drag-drop.js";
import { defineDatumLocaleSelectElement } from "../../render/web-component/locale-select-element.js";
import {
  DATUM_FORM_RENDERER_TAG,
  DatumFormRendererElement,
  defineDatumFormRendererElement,
  isCaretControl,
  type DatumFormActionDetail,
  type RenderHostRuntime
} from "../../render/web-component/form-renderer-element.js";
import { extendBinding, type LiveBinding } from "../../render/live/contract.js";
import type { PrintTheme } from "../../render/print/theme.js";
import { withComponentDrawing, type ComponentDrawing } from "../../plugins/component-adapters.js";
import { lit } from "../../render/live/lit.js";
import { bindingById } from "../../render/live/binding-registry.js";
import { createDatumBinding } from "../../render/live/datum/options.js";
import { buildCanvasHooks, CANVAS_HOOK_STYLES } from "./canvas-hooks.js";
import { BuilderPreviewRuntime } from "../preview/builder-preview-runtime.js";
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
// A type only: a value import from under form-tests/ would put the Tests chunk in the entry.
import type { CanvasScenarioShowing, TestsAssertSnapshot, TestsCanvasRecording, TestsRecordListener, TestsShowingGivens } from "../form-tests/tests-model.js";
import type {
  ComponentNode,
  ComponentRules,
  LocalizationConfiguration
} from "../../core/schema/types.js";
import {
  applicableRuleDescriptors,
  buildRuleEditorState,
  composeRuleSource,
  parseExpressionJson,
  ruleRunControl,
  withRule,
  RULE_DESCRIPTOR_BY_KEY,
  type RuleDescriptor,
  type RuleEditorMode,
  type RuleKey
} from "../property-editor/rules-model.js";
import type { Expression, RuleSource, RunScope } from "../../core/expressions/expression.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { FormulaFunctionTableRow } from "../../registry/formula-functions/formula-function-registry.js";
import type { BuilderFormSettingReadOnlyRow, BuilderFormSettingRow, BuilderInspectorAction, BuilderModeChoice, BuilderModeFinding, BuilderModeRules, BuilderModeWays, BuilderOpenModeDetail } from "./builder-modes.js";
import {
  applyBlockers,
  inspectorHints,
  inspectorWarnings,
  PATTERN_PRESET_PATH,
  patternPresetWrites,
  rewordPatternPreset,
  suggestedPatternPreset,
  valueMapWith,
  valueMapWithout,
  drawnInspectorModel,
  type BuilderDrawingSource,
  type InspectorField,
  type InspectorModel,
  type InspectorNotice
} from "../property-editor/inspector-model.js";
import { ruleExpression as ruleExpressionOf, ruleRun, ruleText } from "../property-editor/rule-source.js";
import { cssClassTokens } from "../property-editor/css-classes.js";
import { formulaFieldsOf, type FormulaField } from "../formula/formula-fields.js";
import { formulaEditorState, type FormulaEditorState } from "../formula/formula-textarea.js";
import { loadFormulaEditor, type FormulaEditorModule } from "../formula/formula-editor-loader.js";
import type { CodeMirrorFormulaEditor } from "../formula/formula-editor.js";
import { FORMULA_SNIPPETS, feelName, formulaFunctionRows, formulaSignatures, pluginSnippets, type FormulaFunctionRow } from "../formula/feel-functions.js";
import { printFormulaTokens } from "../formula/feel-print.js";
import { BUILDER_DRAG_MIME_TYPE } from "../drag-drop/html5-drag-drop.js";
import { FormEventType } from "../../core/events/event-types.js";
import type {
  BuilderTrySubmitDetail,
  TryCheckOutcome,
  TryItController,
  TryItPdfSource,
  TryItServerChecksSource,
  TryShowingGiven,
  TrySubmitOutcome
} from "./try-it-types.js";
import { defaultIconSet, renderIcon, type IconSet } from "../../render/icons/icon-set.js";
import {
  FILE_CHOICE_NONE,
  FILE_CHOICE_UPLOAD,
  builderTokens,
  paletteGroupsHtml,
  declaredSlotsByComponent,
  slotEmptyHintsByComponent,
  dropZoneOnPath,
  markDropZones,
  placeMarker,
  slotPlaces,
  zoneInsertion,
  deleteConfirmHtml,
  hasStyleSections,
  STYLE_SECTION_IDS,
  unsavedChangesPromptHtml,
  optionsEditorHtml,
  optionsRowHasText,
  OPTIONS_EDITOR_STYLES,
  type TranslationCoverageEntry,
  translationCoverageOf,
  type OptionsEditorFrame,
  type OptionsEditorRow,
  type OptionsEditorSuggestionGroup,
  type OptionsEditorView,
  inspectorFooterHtml,
  problemCountText,
  problemText,
  propertiesPanelHtml,
  ruleBoxDescription,
  ruleFeedbackHtml,
  esc,
  type DeleteConfirmation,
  type FormulaFieldView,
  type InspectorNoteView,
  type RuleHtmlOptions,
  type RuleReadsToken,
  type RuleView,
  type UnsavedChangesPromptView,
  type InspectorTab,
  type JsonEditView,
  TOOLBAR_STYLES,
  CANVAS_PANEL_STYLES,
  CANVAS_CHROME_STYLES,
  PROPERTIES_STYLES,
  INSPECTOR_STUB_STYLES
} from "./builder-shared.js";
import { isStarterSubmitButton } from "./starter-submit.js";
import { rovingToolbar } from "./toolbar-roving.js";
import type { JsonViewer, JsonViewerOptions } from "./json-viewer.js";
import { mountJsonViewerAfter } from "./json-viewer-loader.js";
import {
  type ComponentJsonProblem,
  componentJsonChanges,
  componentJsonText,
  hasComponentJsonChanges,
  readComponentJson
} from "../property-editor/component-json.js";
import { beginDialogDrag, captureDialogFrame, openDialogModally } from "./dialog-frame.js";
import { isEvaluableExpression } from "../../core/expressions/condition-shape.js";
import { kernelFoldHoldsOwnAnswer, kernelJsonAnswers } from "../../core/state/submittable-fold.js";
import { DATA_KEY_PROPERTY, buildValuePaths, holdsData } from "../../core/tree/data-scope.js";
import { extractDependencies } from "../../rules/dependencies/dependency-extractor.js";
import { DEFAULT_FORMULA_ERRORS, formulaErrorsHint, formulaErrorsOf } from "./formula-settings.js";
import { assistantsChoiceOf, assistantsDraftValue, assistantsHint } from "./assistants-settings.js";
import { guardRemoteImages, newRemoteLoadToken } from "./remote-images.js";
import { showBuilderModal } from "./modal-place.js";

/**
 * Why a "Required when" on `node` would never be enforced, or `undefined` where the
 * fold reads it. The fold reads the rule only on a component that holds an answer of its own —
 * none of the engine's groups, grids and static blocks (`kernelFoldHoldsOwnAnswer`), and none
 * of a plugin's display components, which the kernel cannot tell from a field except by the
 * `required` capability their definitions leave out (`typeOffersRequired`) — and outside a
 * repeating section, whose rows neither side folds one by one. On any other node the rule is
 * never read, so the tab says so rather than "checked in the browser and by the server".
 */
/** The sections the properties panel draws for `model`: without the boxes the canvas's binding does not draw. */
function drawnModel(model: InspectorModel | undefined): InspectorModel | undefined {
  return model === undefined ? undefined : drawnInspectorModel(model);
}

/**
 * What a number box drafts: nothing when it is empty or not a finite number. A browser reports ""
 * for a cleared box and for half-typed text ("-", "1e", "1."), and Number("") is 0, which would
 * save a limit of 0 where the author meant none. The live box keeps its text (keepLiveControl).
 */
/**
 * The id of the row of a Check answers step's list a press on the step's heading region landed
 * on (`render/live/journey-review.ts` ids each row `<step>__review-<value path>`): the drawn row
 * in the press's path, else, since the region's drawing is inert and an inert element is never a
 * click's target, the smallest row whose box holds the point. `undefined` for a press elsewhere.
 */
function pressedReviewRow(region: HTMLElement, path: readonly HTMLElement[], event: MouseEvent): string | undefined {
  const isRow = (id: unknown): id is string => typeof id === "string" && id.includes("__review-") && !id.endsWith("__error");
  const inPath = path.find((el) => isRow(el?.id));
  if (inPath) {
    return inPath.id;
  }
  let best: { id: string; area: number } | undefined;
  for (const el of region.querySelectorAll<HTMLElement>('[id*="__review-"]')) {
    if (!isRow(el.id)) {
      continue;
    }
    const box = el.getBoundingClientRect();
    if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom && box.width * box.height > 0) {
      const area = box.width * box.height;
      if (best === undefined || area < best.area) {
        best = { id: el.id, area };
      }
    }
  }
  return best?.id;
}

function numberBoxValue(text: string): number | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function requiredWhenGap(controller: BuilderController, node: ComponentNode, nodeId: string, words?: BuilderTextOptions): string | undefined {
  if (!kernelFoldHoldsOwnAnswer(node) || !controller.typeOffersRequired(node.type)) {
    return builderText("gap.noAnswer", undefined, words);
  }
  if (insideRepeatingSection(controller.snapshot(), nodeId)) {
    return builderText("gap.repeating", undefined, words);
  }
  return undefined;
}

/** The calendar day of `date` where the author sits, as `YYYY-MM-DD` (the day Record lends a preview that has none). */
function recordingCalendarDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whether the component `id` sits under a repeating section (an ancestor with a `collection`), as the fold's `kernelFoldInSection` reads it. */
/**
 * Value path -> the data source id its component's options come from (`configuration.data.sourceId`),
 * for every component naming one: where a scenario's `given options for <path>` lands on the
 * canvas, as the test runner finds it.
 */
function showingSourceIds(root: ComponentNode): Map<string, string> {
  const paths = buildValuePaths(root);
  const sources = new Map<string, string>();
  const visit = (node: ComponentNode): void => {
    const data = (node.configuration as { data?: { sourceId?: unknown } } | undefined)?.data;
    const sourceId = data !== null && typeof data === "object" ? data.sourceId : undefined;
    const path = paths.get(node.id);
    if (typeof sourceId === "string" && sourceId !== "" && path !== undefined) {
      sources.set(path, sourceId);
    }
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children ?? []) {
        visit(child);
      }
    }
  };
  visit(root);
  return sources;
}

function insideRepeatingSection(root: ComponentNode, id: string): boolean {
  const walk = (node: ComponentNode, ancestorsHaveCollection: boolean): boolean | undefined => {
    const childrenInSection = ancestorsHaveCollection || node.collection !== undefined;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (child.id === id) {
          return childrenInSection;
        }
        const found = walk(child, childrenInSection);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(root, false) === true;
}

/**
 * Describes a pending delete for the confirmation overlay. Both panels resolve it the same
 * way, from whatever the controller currently holds.
 */
/** The tree view's node for `componentId`, wherever it sits. */
function findTreeNode(
  node: NestedTreeNodeView,
  componentId: string
): NestedTreeNodeView | undefined {
  if (node.id === componentId) {
    return node;
  }
  for (const slot of node.slots) {
    for (const child of slot.children) {
      const hit = findTreeNode(child, componentId);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

function describeDelete(
  controller: BuilderController | undefined,
  componentId: string,
  words?: BuilderTextOptions
): DeleteConfirmation | undefined {
  if (!controller) {
    return undefined;
  }
  const view = findTreeNode(controller.treeView(), componentId);
  if (!view) {
    return undefined;
  }
  const count = (node: NestedTreeNodeView): number =>
    node.slots.reduce(
      (total, slot) => total + slot.children.reduce((sum, child) => sum + 1 + count(child), 0),
      0
    );
  // Named as the inspector names it: by the id its ID row shows, or by its label alone where
  // that row shows none (a mode's own node ids).
  const row = controller.idRow(componentId);
  const idShown = row?.mode === "hidden" ? false : row?.mode === "static" && row.text !== undefined ? row.text : undefined;
  // What else names it: listed, with the box that clears them in the same undo step.
  const dependents = controller.dependentsOf(componentId);
  return {
    componentId,
    label: view.label,
    descendantCount: count(view),
    ...(idShown !== undefined ? { idShown } : {}),
    ...(dependents.length > 0 ? { dependents: { heading: dependentsHeading(dependents.length, words), lines: dependentLines(dependents, words) } } : {})
  };
}

/**
 * Whether a delete confirmation's "Also remove references" box is ticked: the component and
 * everything that names it then go as one undo step (`BuilderController.remove` with
 * `removeReferences`). Unticked, or a dialog with no such box: the plain removal.
 */
function removesReferences(dialog: Element | null | undefined): boolean {
  return dialog?.querySelector<HTMLInputElement>("input[data-confirm-also-remove]")?.checked === true;
}

/**
 * The unsaved-changes prompt as the properties panel shows it: what the controller is
 * holding, named by the tree view's label so the author can tell which edits these are.
 */
export function describeUnsavedChanges(
  controller: BuilderController,
  prompt: UnsavedChangesPrompt,
  /** What the panel itself could not read for that component (an expression that does not parse). */
  panelProblems: readonly string[] = []
): UnsavedChangesPromptView {
  // The held component's own problems — never another component's, whichever is selected.
  const problems = [...controller.problemsOf(prompt.componentId).map((problem) => problem.message), ...panelProblems];
  return {
    componentId: prompt.componentId,
    label: findTreeNode(controller.treeView(), prompt.componentId)?.label ?? prompt.componentId,
    action: prompt.action,
    ...(prompt.componentId === controller.rootId() ? { isRoot: true } : {}),
    blocked: problems.length > 0,
    ...(problems.length > 0 ? { problems } : {})
  };
}

export type { BuilderTrySubmitDetail } from "./try-it-types.js";

/**
 * The Try it chunk: the panel's markup and checks and the logic behind it, fetched the
 * first time the author tries the form. A rejected load is forgotten (the `retryingLoad` rule of
 * the journey designer), never kept with `??=`, so Try again asks the network again.
 */
type TryItModule = typeof import("./try-it.js");

let tryItLoad: Promise<TryItModule> | undefined;

function loadTryIt(): Promise<TryItModule> {
  if (!tryItLoad) {
    const next = import("./try-it.js");
    next.catch(() => {
      if (tryItLoad === next) {
        tryItLoad = undefined;
      }
    });
    tryItLoad = next;
  }
  return tryItLoad;
}

/**
 * The Try it panel's place: its column on the canvas's end edge, as wide as the inspector, the
 * page making room for it; on a phone, the Results sheet. Here rather than in the chunk so the
 * panel sits right (and says "Starting Try it…") while the chunk loads; the cards' look is the
 * chunk's.
 */
const TRY_PANEL_PLACE_STYLES = `
  .panel--canvas { --db-try-w: min(320px, calc(100% - 2 * var(--db-gap, 12px) - 280px)); }
  /* The Journeys workspace's Try it holds the journey's map: a wider column, which scrolls. */
  .panel--canvas[data-try-journeys] { --db-try-w: min(400px, calc(100% - 2 * var(--db-gap, 12px) - 280px)); }
  .panel--canvas[data-try-shown] { --db-props-w: calc(var(--db-try-w) + var(--db-gap, 12px)); }
  /* Placed physically, as the drawers and the canvas's bars are: the bars clear --db-props-w on the right. */
  .panel--canvas[data-try-shown] .canvas-page { --page-end: calc(var(--db-try-w) + 2 * var(--db-gap, 12px)); padding-right: var(--page-end); }
  .try-panel {
    position: absolute; z-index: var(--db-z-canvas-ui); top: var(--db-gap, 12px); bottom: var(--db-gap, 12px);
    right: var(--db-gap, 12px); width: var(--db-try-w);
    display: flex; flex-direction: column; gap: var(--db-space-2); overflow: auto; pointer-events: none;
    font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
  }
  .try-panel[hidden] { display: none; }
  /* A selection action a feature leaves out (the logic one without the logic feature) is not drawn: the button's own display would beat the attribute. */
  .selection-btn[hidden] { display: none; }
  /* Its head is a phone's: elsewhere the panel is a column of cards with no title of its own. */
  .try-sheet-head, .try-grab { display: none; }
  :host([data-phone]) .try-sheet-head {
    display: flex; align-items: center; position: sticky; top: 0; z-index: 1; padding: var(--db-space-2) 0;
    background: var(--db-surface);
  }
  .try-sheet-title { flex: 1; margin: 0; font-size: var(--db-text-xl); font-weight: 600; }
  .try-sheet-title:focus { outline: none; }
  .try-close {
    flex: none; inline-size: 44px; block-size: 44px; padding: 0; border: 0; border-radius: var(--db-radius-pill);
    background: transparent; color: var(--db-ink-muted); display: grid; place-items: center; cursor: pointer;
  }
  .try-close:hover { background: var(--db-surface-hover); color: var(--db-ink); }
  .try-close:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
  .try-load {
    pointer-events: auto; flex: none; display: grid; gap: var(--db-space-2); justify-items: start; margin: 0;
    padding: var(--db-space-3) var(--db-space-4); background: var(--db-surface); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-xl); box-shadow: var(--db-shadow-card); font-size: var(--db-text-sm); color: var(--db-ink-muted);
  }
  .try-load[data-try-load="failed"] { color: var(--db-danger); }
  :host([data-phone]) .try-panel { display: none; }
  :host([data-phone][data-results-open]) .panel--canvas::after {
    content: ""; position: absolute; inset: 0; z-index: 29; background: var(--db-scrim);
  }
  :host([data-phone][data-results-open]) .try-panel:not([hidden]) {
    display: flex; position: absolute; z-index: 30; inset: auto 0 0 0; top: auto; width: auto; max-height: 70%;
    gap: 0; padding: 0 var(--db-space-4) calc(var(--db-space-4) + env(safe-area-inset-bottom, 0px));
    overflow: auto; overscroll-behavior: contain; pointer-events: auto;
    background: var(--db-surface); border-radius: 22px 22px 0 0; box-shadow: var(--db-shadow-drawer);
  }
`;

/**
 * Detail of `builder-open-panel`: a panel asking the shell to open another one — the Form
 * panel's Header or Footer row opening the Header & footer panel on that region.
 * Composed, so a host that mounts a panel on its own hears it too.
 */
export interface BuilderOpenPanelDetail {
  panel: "chrome" | "form";
  /** For the Header & footer panel: the region to put focus in. */
  region?: "header" | "footer";
  /**
   * For the Form panel: go to this problem of the form root's draft (see
   * `BuilderController.problemsOf`), or the first one when it names none — the Header &
   * footer panel's Save shares the root's draft, but the boxes it cannot save past are the
   * Form panel's.
   */
  problem?: string;
}

export const DATUM_BUILDER_TOOLBAR_TAG = "datum-builder-toolbar";
export const DATUM_BUILDER_CANVAS_TAG = "datum-builder-canvas";
export const DATUM_BUILDER_PROPERTIES_TAG = "datum-builder-properties";
export const DATUM_BUILDER_FORM_PANEL_TAG = "datum-builder-form-panel";

/**
 * Base for the independently-usable builder panels. Assign a shared
 * {@link BuilderController} via the `controller` property; the panel re-renders on every
 * controller `change` / `selection`. It stops listening while out of the document and listens
 * again when put back, so a panel moved in the DOM keeps its controller.
 */
export abstract class BuilderPanelElement extends HTMLElementBase {
  protected readonly root: ShadowRoot;
  protected ctrl: BuilderController | undefined;
  /**
   * Whether the controller on the panel is the builder's own — the form, the primary mode —
   * rather than another mode's. The form-level controls, the properties panel's
   * Localization section and the canvas's locale switcher, edit and read
   * `FormDefinition.localization`, which belongs to the form alone: another mode's tree (a
   * PDF layout) declares the form's locales so its own text is authored per locale, but has
   * no localization of its own to edit. The shell sets this as it re-points the panels; a
   * panel used on its own is the form's.
   */
  protected primaryValue = true;
  private iconsValue: IconSet | undefined;
  private unsub: Array<() => void> = [];
  /** What this panel last wrote into its root; see {@link writeMarkup}. */
  private lastMarkup: string | undefined;
  /** Depth of {@link suspendPaints} calls: a caller setting several properties paints once. */
  private suspended = 0;
  /** Set when a paint was skipped, so it is made up as soon as the panel can draw again. */
  private missedPaint = false;
  /**
   * Where the panel's own Undo and Redo keys go: the shell's one method, which asks
   * the mode's history first (a journey's Step view undoes over the form and the journey). No
   * paint. Unset (a panel used on its own): the panel's controller's own Undo and Redo.
   */
  public historyStep: ((controller: BuilderController, direction: "undo" | "redo") => void) | undefined;

  /** Undo or Redo from the panel's keys: through {@link historyStep} when the shell set one, else on the panel's controller. */
  protected stepHistory(direction: "undo" | "redo"): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (this.historyStep) {
      this.historyStep(controller, direction);
    } else if (direction === "undo") {
      controller.undo();
    } else {
      controller.redo();
    }
  }

  /**
   * Paints — unless there is nobody to paint to. A panel behind its strip item is not on
   * screen, and a caller part-way through setting several properties has not finished saying
   * what to draw; either way the paint is skipped and made up the moment the panel can draw
   * again. Everything inside the panel asks for a paint this way, so the panel is drawn once
   * per thing that actually changed rather than once per property that was assigned.
   */
  protected paint(): void {
    if (this.suspended > 0 || this.hidden) {
      this.missedPaint = true;
      return;
    }
    this.missedPaint = false;
    this.render();
  }

  /**
   * Holds this panel's paints until the matching {@link resumePaints}. Synchronous, so a
   * caller that sets a controller, an icon set and a label in a row still leaves the panel
   * painted by the time it returns — just once instead of three times.
   */
  public suspendPaints(): void {
    this.suspended += 1;
  }

  public resumePaints(): void {
    this.suspended = Math.max(0, this.suspended - 1);
    if (this.suspended === 0 && this.missedPaint) {
      this.paint();
    }
  }

  /**
   * What the panel does when its controller reports a change. Every panel repaints by
   * default; one whose content cannot depend on what the change was says so by overriding
   * this, and is spared building markup it would then throw away (see {@link writeMarkup}).
   * The event itself comes along for a panel that reads more than the reason (`live`, a draft
   * write under a box still being typed into, see {@link BuilderChangeEvent}).
   */
  protected onControllerChange(_reason: BuilderChangeReason, _event?: BuilderChangeEvent): void {
    this.paint();
  }

  /** The same, for a change of selection. */
  protected onSelectionChange(): void {
    this.paint();
  }

  /** The canvas drew the form and how the selection is drawn moved (`BuilderController.drawingChanged`); nothing to do by default. */
  protected onDrawingChange(): void {}

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /**
   * The icon set the panel's chrome is drawn from. Unset, the default set —
   * whatever the page registered with `setDefaultIconSet`, else the engine's own drawings.
   * The shell forwards its `options.icons` here; a panel used on its own takes it directly.
   */
  public set icons(value: IconSet | undefined) {
    if (this.iconsValue === value) {
      return;
    }
    this.iconsValue = value;
    this.onIconsChange();
  }

  public get icons(): IconSet | undefined {
    return this.iconsValue;
  }

  /** The set to draw with right now. */
  protected iconSet(): IconSet {
    return this.iconsValue ?? defaultIconSet();
  }

  /** The set's CSS for this panel's shadow root; empty when the set needs none. */
  protected iconCss(): string {
    return this.iconSet().css ?? "";
  }

  /** A full repaint by default; a panel whose shell is built once repaints its glyphs instead. */
  protected onIconsChange(): void {
    this.paint();
  }

  public set controller(controller: BuilderController | undefined) {
    this.teardown();
    this.ctrl = controller;
    this.subscribe();
    this.paint();
  }

  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  public set primary(value: boolean) {
    if (this.primaryValue === value) {
      return;
    }
    this.primaryValue = value;
    this.paint();
  }

  public get primary(): boolean {
    return this.primaryValue;
  }

  public get collapsed(): boolean {
    return this.hasAttribute("collapsed");
  }

  public set collapsed(value: boolean) {
    if (value) {
      this.setAttribute("collapsed", "");
    } else {
      this.removeAttribute("collapsed");
    }
    this.paint();
  }

  static get observedAttributes(): string[] {
    return ["collapsed", "hidden"];
  }

  public attributeChangedCallback(_name: string): void {
    // `hidden` coming off is what makes a deferred paint due; `paint` works that out itself.
    this.paint();
  }

  public connectedCallback(): void {
    // Back in the document after a move: the subscriptions the disconnect dropped come back.
    // The paint draws whatever the controller did meanwhile.
    if (this.unsub.length === 0) {
      this.subscribe();
    }
    this.paint();
  }

  public disconnectedCallback(): void {
    this.teardown();
  }

  /** Listens to the controller on the panel, if there is one; {@link teardown} stops it. */
  private subscribe(): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    this.unsub.push(controller.on("change", (event) => this.onControllerChange(event.reason, event)));
    this.unsub.push(controller.on("selection", () => this.onSelectionChange()));
    this.unsub.push(controller.on("drawing", () => this.onDrawingChange()));
  }

  private teardown(): void {
    for (const off of this.unsub) {
      off();
    }
    this.unsub = [];
  }

  protected toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.dispatchEvent(
      new CustomEvent("panel-toggle", {
        detail: { collapsed: this.collapsed },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * Writes `markup` into the panel's root, unless that is already exactly what the panel
   * shows — in which case nothing is touched and this answers `false`, so the caller can skip
   * the work that follows a paint (re-binding, restoring focus, mounting an editor).
   *
   * A docked panel hears every change its controller reports, which is every keystroke of a
   * draft edit: the palette redrew its whole catalogue, and the Form panel its
   * whole root, while an author typed a field's label into the inspector. The outline was
   * given a guard of its own for this reason; this is that guard for the rest, and it cannot
   * change what a panel shows, since the markup it skips is the markup already there.
   */
  protected writeMarkup(markup: string): boolean {
    if (markup === this.lastMarkup) {
      return false;
    }
    this.lastMarkup = markup;
    this.root.innerHTML = markup;
    return true;
  }

  /** What the panel currently shows, for a caller that must compare before tearing anything down. */
  protected shownMarkup(): string | undefined {
    return this.lastMarkup;
  }

  /** The panel's DOM has moved on from its last markup in place (a typed box's text): the next paint writes the markup whatever it is. */
  protected forgetMarkup(): void {
    this.lastMarkup = undefined;
  }

  protected abstract render(): void;
}

// --- Toolbar ---------------------------------------------------------------


/**
 * A panel's title is a real heading (h2, the level the shell gives its drawers) that looks as the
 * old title div did: the heading's own margins and size are reset, and the strong inside keeps
 * the panel-head look. `panel-title--hidden` keeps the heading for assistive technology when the
 * panel draws no visible title (the Components palette).
 */
export const PANEL_TITLE_STYLES = `
  .panel-title { margin: 0; font: inherit; color: inherit; }
  .panel-title--hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
`;

/**
 * The palette's keyboard. The component list is one Tab stop with the arrow keys
 * moving inside it (a roving tabindex), so a keyboard author reaches the canvas in a few Tabs
 * instead of walking every component button; a "Skip to canvas" button, the first stop, jumps
 * straight there. It is drawn only while it has focus; its label is the core key `components.skip`.
 */
const PALETTE_NAV_STYLES = `
  .panel-head--bare { flex-wrap: wrap; }
  .palette-skip {
    position: absolute; inline-size: 1px; block-size: 1px; margin: -1px; padding: 0; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .palette-skip:focus {
    position: static; inline-size: auto; block-size: auto; margin: 0; padding: var(--db-space-1) var(--db-space-2);
    overflow: visible; clip: auto; flex: 0 0 100%; text-align: start;
    border-radius: var(--db-radius-sm); background: var(--db-accent-soft); color: var(--db-accent-text);
    font: inherit; font-size: var(--db-text-sm); font-weight: 500;
  }
`;

/** What the roving list can stand on: a component button, or a group heading reachable by the arrows only. */
const PALETTE_STOP = ".palette-list [data-palette-type], .palette-list summary";

/** A stable name for a palette control, so focus and the roving stop survive a repaint of the markup. */
function paletteKeyOf(element: Element | null | undefined): string | undefined {
  if (!element) {
    return undefined;
  }
  const type = element.getAttribute("data-palette-type");
  if (type !== null) {
    return `item:${type}`;
  }
  if (element.matches(".palette-list summary")) {
    return `group:${(element.parentElement as HTMLElement | null)?.dataset.paletteGroup ?? ""}`;
  }
  if (element.hasAttribute("data-palette-skip")) {
    return "skip";
  }
  return element.hasAttribute("data-palette-filter") ? "filter" : undefined;
}

export class DatumBuilderToolbarElement extends BuilderPanelElement {
  private bound = false;
  /** The one list stop that is in the Tab order (see {@link applyRoving}); a key from {@link paletteKeyOf}. */
  private rovingKey: string | undefined;
  /** Palette groups the author closed, by label, so a repaint does not reopen them. */
  private collapsedGroups = new Set<string>();
  /** Live text of the palette's filter box; entries not matching it are left out. */
  private paletteFilter = "";
  /** The builder's words (the text catalog) for the panel's head and filter. */
  private readonly words = new BuilderWords();

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.paint();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.paint();
    }
  }

  private wordsFor(fallbackLocale: string | undefined): BuilderTextOptions {
    const locale = this.words.locale ?? fallbackLocale;
    return {
      ...(locale !== undefined ? { locale } : {}),
      ...(this.words.catalog ? { catalog: this.words.catalog } : {})
    };
  }

  /**
   * The palette listing under the current filter. A filter match is by visible label or by
   * component type, and while a filter is active every group renders open — a match hidden
   * under a closed heading would read as no match at all (the author's own open/closed
   * memory is untouched and comes back when the box clears).
   */
  private paletteListHtml(): string {
    const types = this.ctrl?.offeredTypes() ?? [];
    this.paintedTypes = types;
    const filter = this.paletteFilter.trim().toLowerCase();
    const visible = filter
      ? types.filter(
          (entry) =>
            String(entry.label ?? entry.type).toLowerCase().includes(filter) ||
            entry.type.toLowerCase().includes(filter)
        )
      : types;
    const listing = paletteGroupsHtml(visible, filter ? new Set<string>() : this.collapsedGroups, this.iconSet(), this.wordsFor(undefined));
    return listing.trim() === "" ? `<p class="empty">${esc(this.words.text("toolbar.noMatch"))}</p>` : listing;
  }

  /**
   * The catalogue lists what can be *added* to the form. Nothing an author edits, selects or
   * previews changes it, so those changes are dropped here rather than rebuilding a list of
   * every registered component — which a docked palette otherwise did on every keystroke.
   */
  protected override onControllerChange(reason: BuilderChangeReason): void {
    if (reason === "preview" && this.ctrl !== undefined && this.ctrl.offeredTypes() !== this.paintedTypes) {
      // Another list of types (the Journeys Step view hides some, `BuilderComponentType.hidden`): a palette
      // listing what it no longer offers must say so, though nothing was edited.
      this.paint();
      return;
    }
    if (reason === "edit" || reason === "select" || reason === "preview") {
      return;
    }
    this.paint();
  }

  /** The list of types the palette was last drawn from: a change of list is what a preview change is read for. */
  private paintedTypes: readonly BuilderComponentType[] | undefined;

  /** The palette draws nothing about the selection. */
  protected override onSelectionChange(): void {}

  /**
   * The list stops the arrow keys visit, in reading order: every component button in an open
   * group, and every group heading (the only keyboard way to open a closed group). Items inside
   * a closed group are not stops, since the browser does not draw them.
   */
  private rovingStops(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>(PALETTE_STOP)].filter(
      (stop) => stop.tagName === "SUMMARY" || stop.closest("details:not([open])") === null
    );
  }

  /**
   * One list stop is in the Tab order and the rest are not (a roving tabindex): the one last
   * visited, else the first component button. The state is a key kept on the panel, not the
   * markup, so it survives a repaint, a filter that removes and restores rows, and a group
   * opening or closing. Group headings are never Tab stops unless one is the stop being rested on.
   */
  private applyRoving(): void {
    const stops = this.rovingStops();
    const all = this.root.querySelectorAll<HTMLElement>(PALETTE_STOP);
    const current = stops.find((stop) => paletteKeyOf(stop) === this.rovingKey) ?? stops.find((stop) => stop.tagName !== "SUMMARY") ?? stops[0];
    for (const stop of all) {
      stop.setAttribute("tabindex", stop === current ? "0" : "-1");
    }
  }

  /** Moves focus to the canvas, the palette's "Skip to canvas". */
  private skipToCanvas(): void {
    const scope = this.getRootNode() as ParentNode;
    (scope.querySelector?.(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement | null | undefined)?.focusCanvasRegion();
  }

  protected render(): void {
    // No heading and no undo/redo: the panel is a palette and nothing else. Undo/redo are
    // form-wide actions that belong on the builder's own bar, not tucked into one panel's
    // header, and the heading only repeated what a column of component buttons already says.
    // Nor a collapse control: the shell's activity strip opens and closes the panel.
    const markup = `
      <style>${builderTokens()}${TOOLBAR_STYLES}${PANEL_TITLE_STYLES}${PALETTE_NAV_STYLES}${this.iconCss()}</style>
      <div class="panel card-stack">
        <div class="card is-pinned panel-head panel-head--bare">
          <h2 class="panel-title panel-title--hidden">${esc(this.words.text("components.title"))}</h2>
          <button type="button" class="palette-skip" data-palette-skip>${esc(this.words.text("components.skip"))}</button>
          <input class="palette-filter" type="search" data-palette-filter
            placeholder="${esc(this.words.text("components.filter.placeholder"))}" aria-label="${esc(this.words.text("components.filter.label"))}"
            value="${esc(this.paletteFilter)}" />
        </div>
        <div class="card palette-list">${this.paletteListHtml()}</div>
      </div>`;
    // A rewrite of the markup drops the focused control with it: note which it was, put it back.
    const focused = paletteKeyOf(this.root.activeElement);
    if (!this.writeMarkup(markup)) {
      // The catalogue does not depend on what is being typed into a field; most of the
      // changes that reach a docked palette leave it drawing exactly this.
      return;
    }
    this.bind();
    this.applyRoving();
    if (focused !== undefined) {
      [...this.root.querySelectorAll<HTMLElement>("[data-palette-skip], [data-palette-filter], " + PALETTE_STOP)]
        .find((control) => paletteKeyOf(control) === focused)
        ?.focus();
    }
  }

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    // The list is one Tab stop: the arrow keys, Home and End walk its component buttons and group
    // headings (a heading's own Enter and Space open and close it; a button's add). At either end
    // the walk wraps, since Tab is what leaves the list. Typing a letter to jump is not offered.
    this.root.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const stop = (event.target as Element).closest?.<HTMLElement>(PALETTE_STOP);
      if (!stop || (event as KeyboardEvent).altKey || (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey) {
        return;
      }
      const stops = this.rovingStops();
      const at = stops.indexOf(stop);
      const to =
        key === "ArrowDown" ? (at + 1) % stops.length
        : key === "ArrowUp" ? (at - 1 + stops.length) % stops.length
        : key === "Home" ? 0
        : key === "End" ? stops.length - 1
        : undefined;
      if (to === undefined || at < 0) {
        return;
      }
      event.preventDefault();
      stops[to]!.focus();
    });
    // Landing on a stop, by key, click or Shift+Tab from further on, is where the list rests next.
    this.root.addEventListener("focusin", (event) => {
      const stop = (event.target as Element).closest?.<HTMLElement>(PALETTE_STOP);
      if (stop) {
        this.rovingKey = paletteKeyOf(stop);
        this.applyRoving();
      }
    });
    // `<details>` folds itself; only the memory of which groups are closed is ours. `toggle`
    // does not bubble, so listen on the capture phase (as the properties panel does).
    this.root.addEventListener(
      "toggle",
      (event) => {
        const target = event.target as HTMLDetailsElement;
        const group = target.dataset?.paletteGroup;
        if (group === undefined) {
          return;
        }
        if (target.open) {
          this.collapsedGroups.delete(group);
        } else {
          this.collapsedGroups.add(group);
        }
        // The buttons inside a group that closed are no longer stops, and they are again when it opens.
        this.applyRoving();
      },
      true
    );
    this.root.addEventListener("click", (event) => {
      // Palette items now carry an icon, so the click can land on a child element. Every
      // lookup here resolves through `closest` rather than trusting `event.target` directly.
      const target = event.target as Element;
      if (target.closest?.("[data-palette-skip]")) {
        this.skipToCanvas();
        return;
      }
      const addType = target.closest?.<HTMLElement>("[data-add-type]")?.dataset.addType;
      if (addType && this.ctrl) {
        // After the selection, in its slot when that takes the type; else at the end.
        const selected = this.ctrl.selectedComponentId();
        this.ctrl.requestAddAfter(addType, selected !== undefined && selected !== this.ctrl.rootId() ? selected : undefined);
      }
    });
    // Typing repaints only the listing, never the whole panel, so the box keeps its focus
    // and caret through every keystroke.
    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target?.dataset?.paletteFilter === undefined) {
        return;
      }
      this.paletteFilter = target.value;
      const list = this.root.querySelector(".palette-list");
      if (list) {
        list.innerHTML = this.paletteListHtml();
        this.applyRoving();
      }
    });
    this.root.addEventListener("dragstart", (event) => {
      const dragEvent = event as DragEvent;
      const dt = dragEvent.dataTransfer;
      const item = (dragEvent.target as Element).closest?.<HTMLElement>("[data-palette-type]");
      const type = item?.dataset.paletteType;
      if (!dt || !type || !this.ctrl) {
        return;
      }
      writeDragPayload(dt, this.ctrl.dragPayloadForType(type));
      // Drag the whole palette row, so the cursor carries something recognisable.
      if (typeof dt.setDragImage === "function") {
        dt.setDragImage(item as Element, 12, 12);
      }
    });
  }
}

// --- Canvas -------------------------------------------------------------

/** A field's own controls, which a click in edit mode selects rather than works. */
/** How long a failed Logic model load is left alone before a rule draw asks again, unless another selection is opened. */
const LOGIC_MODEL_RETRY_MS = 30_000;

const EDIT_INERT_CONTROLS = "input, select, textarea, button, a, label, summary, option";

/** Everything a person could focus in a field's own markup; edit mode takes it out of the Tab order. */
const FIELD_FOCUSABLES = "input, select, textarea, button, a[href], summary, [tabindex]";

/**
 * The boxes the canvas hooks draw around what is not a component but selects one (a journey
 * step's heading, counter and buttons, whatever binding drew them; canvas-hooks.ts): their
 * drawing is inert and out of the Tab order as a field's leaf is.
 */
const REGION_BOX = ".db-region";

/** The canvas's components in reading order (depth first, slot by slot), the root left out: what the arrow keys walk. */
function readingOrder(view: NestedTreeNodeView): NestedTreeNodeView[] {
  const out: NestedTreeNodeView[] = [];
  const walk = (node: NestedTreeNodeView): void => {
    for (const slot of node.slots) {
      for (const child of slot.children) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(view);
  return out;
}

/** The device widths the canvas bar offers: desktop, tablet, phone. */
const DEVICE_WIDTHS: ReadonlyArray<{ id: "desktop" | "tablet" | "phone"; label: BuilderTextKey; width: number; glyph: string }> = [
  { id: "desktop", label: "canvas.device.desktop", width: 1280, glyph: "M3 5h18v11H3zM8 20h8M12 16v4" },
  { id: "tablet", label: "canvas.device.tablet", width: 768, glyph: "M6 3h12v18H6zM11 18h2" },
  { id: "phone", label: "canvas.device.phone", width: 390, glyph: "M8 3h8v18H8zM11 18h2" }
];

const strokeIcon = (path: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;

/**
 * Writes `text` as the whole of `element`'s content, only when it is not that already. Writing
 * `textContent` replaces the text node even with the same words, which marks the canvas's bar for
 * layout; the inspector reads its scroll offset in the same commit, so an unchanged readout would
 * force a layout of the whole builder there (about 10 ms at 200 fields).
 */
function writeText(element: Element, text: string): void {
  if (element.textContent !== text || element.children.length > 0) {
    element.textContent = text;
  }
}

/** The selection bar's actions, in its order. */
/**
 * The canvas's zoom (the journey map's steps): a step multiplies or divides by 1.25,
 * between a quarter and twice the size. Fit shows the whole sheet in the page, never above 100%.
 */
const CANVAS_ZOOM_STEP = 1.25;
const CANVAS_ZOOM_MIN = 0.25;
const CANVAS_ZOOM_MAX = 2;
/** The most a surface that zooms itself (the PDF's pages) is zoomed by the bar: its viewer holds the same. */
const SURFACE_ZOOM_MAX = 8;
/** How far a press moves before it is a pan, not a click; how much of the sheet a pan keeps in view; one Shift+arrow step. */
const PAN_SLOP = 4;
const PAN_KEEP = 96;
const PAN_STEP = 48;

interface PanRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The Move to... dialog and the keyboard move mode: a lazy chunk, loaded on the first
 * Move to... or `M`. A rejected load is forgotten, as `loadTryIt`'s is, so the next press asks again.
 */
type MoveUiModule = typeof import("../drag-drop/move-ui.js");
type CanvasMoveType = InstanceType<MoveUiModule["CanvasMove"]>;

let moveUiLoad: Promise<MoveUiModule> | undefined;

let canvasDatum: LiveBinding | undefined;

/** One Datum binding for every canvas on the page: the base a tree's own types are laid over when the canvas draws with Datum's. */
function canvasDatumBinding(): LiveBinding {
  return (canvasDatum ??= createDatumBinding());
}

function loadMoveUi(): Promise<MoveUiModule> {
  if (!moveUiLoad) {
    const next = import("../drag-drop/move-ui.js");
    next.catch(() => {
      if (moveUiLoad === next) {
        moveUiLoad = undefined;
      }
    });
    moveUiLoad = next;
  }
  return moveUiLoad;
}

const SELECTION_ACTIONS: ReadonlyArray<{ id: "up" | "down" | "move" | "duplicate" | "logic" | "delete"; label: BuilderTextKey; tip?: BuilderTextKey; glyph: string }> = [
  { id: "up", label: "common.moveUp", glyph: "M12 19V5M6 11l6-6 6 6" },
  { id: "down", label: "common.moveDown", glyph: "M12 5v14M6 13l6 6 6-6" },
  // Anywhere it may go; the dialog's and the move mode's words are the chunk's.
  { id: "move", label: "canvas.action.move", tip: "canvas.action.moveTip", glyph: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" },
  { id: "duplicate", label: "canvas.action.duplicate", glyph: "M9 9h11v11H9zM5 15H4V4h11v1" },
  { id: "logic", label: "canvas.action.logic", glyph: "M6 3v6a3 3 0 003 3h6a3 3 0 013 3v6M6 21v-2M18 3v2" },
  { id: "delete", label: "common.delete", glyph: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" }
];

/**
 * The build-mode canvas. It mounts the real `<datum-form-renderer>` over a
 * {@link BuilderPreviewRuntime}, so what the author sees is what the form renders — the same
 * drawing, binding, layout and conditional-visibility behaviour, produced by the same code
 * (the canvas is not a second renderer). The builder's own contribution is chrome: selection outlines, drag handles and
 * drop zones, injected as the live renderer's canvas hooks (`CanvasHooks`) and styled through the renderer's
 * `extraStyles`, so it never displaces a field from where the live form puts it.
 */
/**
 * What Try it tries while a mode's tree is on the canvas: the form, by its own
 * controller, and the mode, for what it adds (`BuilderMode.tryIt`). Set by the shell.
 */
export interface CanvasTryForm {
  controller: BuilderController;
  mode: BuilderMode;
  /** The workspace Try it runs in ("journeys", "pdf"): the PDF card leads in "pdf". */
  workspace?: string | undefined;
}

export class DatumBuilderCanvasElement extends BuilderPanelElement implements TestsCanvasRecording {
  /** The phone tier is the shell's to say: the canvas redraws its chrome when it does. */
  static override get observedAttributes(): string[] {
    return [...BuilderPanelElement.observedAttributes, "data-phone"];
  }

  /**
   * Puts keyboard focus on the canvas: the one Tab stop that holds the form's components (the
   * arrow keys walk them from there), so the palette's "Skip to canvas" lands on the first
   * component's neighbourhood without selecting anything. Whether the canvas took it, which it
   * does not while a mode's surface has hidden the sheet.
   */
  public focusCanvasRegion(): boolean {
    const page = this.root.querySelector<HTMLElement>(".canvas-page");
    if (!page) {
      return false;
    }
    page.focus();
    return this.root.activeElement === page;
  }

  private bound = false;
  private rendererEl: DatumFormRendererElement | undefined;
  private preview: BuilderPreviewRuntime | undefined;
  /** A mode's own surface, shown in the sheet's place while set (see {@link showSurface}). */
  private surfaceEl: HTMLElement | undefined;
  private surfaceStyles: string | undefined;
  /**
   * What the surface on the canvas says about the canvas's own tools: whether the
   * bar's zoom tools drive it (and how) and whether Try it applies. Unset while the sheet shows.
   */
  private surfaceShown: { zoom?: ((to: number | "fit") => void) | undefined; zoomable: boolean; tryable: boolean; selectionBar: boolean } | undefined;
  /** The active mode's worded actions in the bar (see {@link setModeActions}), and the mode's name for their folded card. */
  private modeActionsValue: HTMLElement[] = [];
  private modeActionsLabel: string | undefined;
  private modeActionsObserver: MutationObserver | undefined;
  /** Puts the selection bar's and the canvas bar's one Tab stop right at once (see {@link rovingToolbar}). */
  private syncSelectionTools: (() => void) | undefined;
  private syncCanvasTools: (() => void) | undefined;
  /** True once the author chose a zoom for this tree; a fixed sheet's auto-fit then stays out of the way. */
  private zoomChosen = false;
  /** The fixed sheet width last seen, so a different one (another PDF layout) lets the auto-fit act again. */
  private appliedFixedWidth: number | undefined;
  private fitObserver: ResizeObserver | undefined;
  private fitObserved: Element | undefined;
  /**
   * Measures the sheet and the room it has: the sheet at its own size, the page's content box.
   * A seam: jsdom has no layout, so a test replaces it with fixed numbers.
   */
  public measureFit: () => { sheetWidth: number; sheetHeight: number; roomWidth: number; roomHeight: number } = () => this.measureLayout();
  /** Reused insertion marker; positioned imperatively during a drag (no innerHTML churn). */
  private marker: HTMLElement | undefined;
  private activeZone: HTMLElement | undefined;
  /** Each drawn component's place in its slot, read off the tree while a drag is over a zone. */
  private dragPlaces: Map<string, number> | undefined;
  private dropTarget: { parentId: string; slotId: string; index: number } | undefined;
  /** The node whose drag is in flight; the `.db-dragging` class lands on it a tick after
   * `dragstart` (see below), so this must outlive the handler — and be cleared on `dragend`
   * so a drag the browser aborted cannot mark the node after the fact. */
  private dragSourceNode: HTMLElement | undefined;
  private sheetDrag: { edge: "left" | "right"; startX: number; startW: number; lastW?: number } | undefined;
  /**
   * Where the author has moved the sheet from its centred place, in screen pixels (a drag on
   * empty canvas, a middle-button drag, Shift with an arrow key), and the drag in flight. A
   * translate on the sheet, apart from the page's scroll, so the centring and the zoom keep
   * working as they did: Fit puts the sheet back, as does another mode's tree.
   */
  private panX = 0;
  private panY = 0;
  private panDrag: { pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; range: PanRange | undefined } | undefined;
  /** The click that ends a pan is part of it: it must not clear the selection. */
  private panEndedAt = -1;
  /** The preview width most recently applied to the sheet, so a mere re-render (selection,
   * typing) never touches the author's scroll position — only a width *change* re-centers. */
  private appliedSheetWidth: number | undefined;
  /** The selection the preview was last asked to show, so only a *change* of selection opens
   * the tab or step it sits on — see {@link render}. */
  private revealedSelectionId: string | undefined;
  /** The controller whose tree the sheet last drew, so a move to another's is drawn in one go — see {@link render}. */
  private paintedController: BuilderController | undefined;
  /** That controller's {@link BuilderController.canvasRevision} when last drawn: another is a sheet of another kind over it. */
  private paintedCanvasRevision: number | undefined;
  /** A change since the last paint added a component (and selected it): the paint scrolls it into view. */
  private addedSincePaint = false;
  /** The scroll that follows an add, until its box is drawn; a later add takes over. */
  private addScroll: object | undefined;
  /** Preview ("Try it"): the form live, the builder's chrome put away. Edit is the default. */
  private previewingValue = false;
  /** Which optional parts of the canvas exist (the builder's `features`); all of them unless the shell says otherwise. */
  private canvasFeaturesValue = { tryIt: true, logic: true };
  /** How the Try it panel shows the form; the panel's other state lives in the chunk. */
  private tryMode: "interactive" | "readonly" = "interactive";
  private serverChecksValue: TryItServerChecksSource | undefined;
  private tryPdfValue: TryItPdfSource | undefined;
  /** The Try it chunk's controller once the chunk is in, the load in flight, and whether the last load failed. */
  private tryIt: TryItController | undefined;
  private tryLoading: Promise<TryItController | undefined> | undefined;
  private tryLoadFailed = false;
  /** The chunk's CSS, kept so a rebuilt shadow root gets it again (see {@link ensureTryStyles}). */
  private tryCss: string | undefined;
  /** A Try again was pressed: focus moves to the panel's first control when the chunk arrives. */
  private tryRetried = false;
  /** The plugin formula functions the host wired; see {@link formulaFunctions}. */
  private formulaFunctionsValue: FormulaFunctionsSource | undefined;
  private trySettingsControllerValue: BuilderController | undefined;
  /** Try it in a mode's workspace: what the shell says is tried there; see {@link tryForm}. */
  private tryFormValue: CanvasTryForm | undefined;
  /** The mode's session while Try it runs one (`BuilderModeTryIt.session`). */
  private trySession: BuilderTrySession | undefined;
  /** Whether the renderer was handed the form's data sources for a session's runtime, so they come off after. */
  private sessionSources = false;
  /** The session's runtime whose changes the Try panel follows, and the way to stop following. */
  private sessionWatch: { runtime: BuilderTrySession["runtime"]; stop: () => void } | undefined;
  /** The mode whose session would not start this Try it: said once, the shared preview tried instead. */
  private sessionFailedFor: BuilderMode | undefined;
  private tryPdfModeValue: (() => BuilderMode | undefined) | undefined;
  /** The zoom of a self-zooming surface (a template's page viewer) as Try it started over it, put back after. */
  private trySurfaceZoom: number | undefined;
  private pdfConfigurationValue: (() => PdfConfiguration | undefined) | undefined;
  /** The host chrome last handed to the renderer, so an unchanged one is not handed again (every assignment repaints). */
  private appliedChrome: FormChromeConfiguration | undefined;
  /** The sheet's zoom: 1 is the form at its own size. The canvas's for the session, never the definition's. */
  private zoomValue = 1;
  /** Which step the stepper shows, per steps container, until the preview's markup says otherwise. */
  private stepperAt = new Map<string, number>();
  /** Watches the preview's markup so a repaint's fields are taken out of the Tab order again in edit mode. */
  private inertWatch: MutationObserver | undefined;
  /** Stops the remote-picture guard on the renderer's shadow root. */
  private remoteImageGuard: (() => void) | undefined;
  private watchedRoot: ParentNode | undefined;
  /** The renderer element that has the canvas's action and language listeners; a renderer built later takes its own. */
  private boundRenderer: DatumFormRendererElement | undefined;
  /** Names the document load the canvas shows; a new one is made on every load, so confirmations never carry over. */
  private loadToken = newRemoteLoadToken();
  private inertQueued = false;
  /**
   * What the inspector reads of the form this canvas draws (`BuilderController.setDrawingSource`):
   * the mounted form's adapters, the binding's capability answers and the name it draws under.
   */
  private readonly drawingSource: BuilderDrawingSource = {
    adapterOf: (id) => this.rendererEl?.live?.adapterOf(id),
    capabilitiesOf: (type) => this.rendererEl?.capabilitiesOf(type),
    bindingLabel: () => {
      const given = this.rendererEl?.binding;
      const resolved = typeof given === "string" ? bindingById(given) : (given ?? canvasDatumBinding());
      return resolved?.label ?? (typeof given === "string" ? given : "Datum");
    }
  };
  /** What the inspector last read of the selection's drawing, so a draw that moved nothing wakes nothing. */
  private drawingSignal: string | undefined;
  /** The Move to... dialog and the keyboard move mode, once their chunk is in. */
  private mover: CanvasMoveType | undefined;

  constructor() {
    super();
    defineDatumFormRendererElement();
  }

  protected override onControllerChange(reason: BuilderChangeReason, event?: BuilderChangeEvent): void {
    if (event?.live) {
      // A formula box still being typed into (the inspector's Logic tab): the draft changed,
      // but a half-written rule is nothing to preview by. The panel that made the write sends
      // a plain `edit` when the author leaves the box, and the preview catches up then.
      return;
    }
    if (reason === "add") {
      this.addedSincePaint = true;
    }
    if (reason === "init") {
      this.loadToken = newRemoteLoadToken();
    }
    if (this.pendingEditOptions !== undefined && !this.ctrl?.unsavedChangesPrompt()) {
      // The prompt that held the hint's selection is gone. Apply and Discard follow with a
      // selection event (which settles the target); Keep editing and a refused Apply send none,
      // so a target still unselected a microtask on is stale and would open the options editor
      // on some later, ordinary selection of that field.
      const target = this.pendingEditOptions;
      queueMicrotask(() => {
        if (this.pendingEditOptions === target && this.ctrl?.selectedComponentId() !== target) {
          this.pendingEditOptions = undefined;
        }
      });
    }
    super.onControllerChange(reason, event);
  }

  /**
   * Brings a component just added into view once the preview draws it: a
   * palette click puts it where the selection is, or at the end of the form, often below the
   * pane. "Nearest", so a drop — under the pointer already — scrolls nothing.
   */
  private scrollToAdded(componentId: string): void {
    const token = (this.addScroll = {});
    let ticks = 0;
    const step = (): void => {
      if (this.addScroll !== token) {
        return;
      }
      const box = [...(this.previewRoot()?.querySelectorAll<HTMLElement>(".db-node[data-component-id]") ?? [])].find((node) => node.dataset.componentId === componentId);
      if (box) {
        box.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        return;
      }
      if ((ticks += 1) < 40) {
        setTimeout(step, 25);
      }
    };
    setTimeout(step, 0);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    // A sheet drag in flight when the canvas leaves the document must not leave its window
    // listeners behind.
    window.removeEventListener("mousemove", this.onSheetDrag);
    window.removeEventListener("mouseup", this.onSheetDragEnd);
    this.sheetDrag = undefined;
    this.fitObserver?.disconnect();
    this.fitObserver = undefined;
    this.fitObserved = undefined;
    this.remoteImageGuard?.();
    this.remoteImageGuard = undefined;
    this.watchedRoot = undefined;
    this.endPan();
    // A mode's session goes with the canvas: its answers kept, its runtime disposed.
    this.endTrySession();
  }

  /** How far the sheet is moved from its centred place, in screen pixels. */
  public get pan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  /** Moves the sheet to an offset from its centred place, in screen pixels; `(0, 0)` centres it again. */
  public panTo(x: number, y: number): void {
    const range = this.panRange();
    this.panX = range ? Math.min(range.maxX, Math.max(range.minX, x)) : x;
    this.panY = range ? Math.min(range.maxY, Math.max(range.minY, y)) : y;
    this.applyPan();
  }

  /**
   * How far the sheet may move: always some of it left in the page, so it can never be lost
   * off an edge. `undefined` where nothing is measured (no layout yet), when any offset goes.
   */
  private panRange(): PanRange | undefined {
    const surface = this.root?.querySelector<HTMLElement>(".canvas-surface");
    const page = this.root?.querySelector<HTMLElement>(".canvas-page");
    if (!surface || !page) {
      return undefined;
    }
    const sheet = surface.getBoundingClientRect();
    const room = page.getBoundingClientRect();
    if (sheet.width === 0 || room.width === 0) {
      return undefined;
    }
    // The sheet's place with no offset, then how far each way keeps PAN_KEEP pixels of it in view.
    const left = sheet.left - this.panX;
    const right = sheet.right - this.panX;
    const top = sheet.top - this.panY;
    const bottom = sheet.bottom - this.panY;
    const keep = Math.min(PAN_KEEP, sheet.width / 2, sheet.height / 2);
    return {
      minX: Math.min(0, room.left + keep - right),
      maxX: Math.max(0, room.right - keep - left),
      minY: Math.min(0, room.top + keep - bottom),
      maxY: Math.max(0, room.bottom - keep - top)
    };
  }

  /** The offset on the sheet: a translate the zoom would scale, so given in the sheet's own pixels. */
  private applyPan(): void {
    const surface = this.root?.querySelector<HTMLElement>(".canvas-surface");
    if (surface) {
      surface.style.translate = this.panX === 0 && this.panY === 0 ? "" : `${this.panX / this.zoomValue}px ${this.panY / this.zoomValue}px`;
    }
  }

  private readonly onPanMove = (event: PointerEvent): void => {
    const drag = this.panDrag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // A press that barely moves is a click (it selects, or clears the selection).
      if (Math.hypot(dx, dy) < PAN_SLOP) {
        return;
      }
      drag.moved = true;
      drag.range = this.panRange();
      this.root.querySelector<HTMLElement>(".canvas-page")?.setAttribute("data-panning", "");
    }
    const range = drag.range;
    this.panX = range ? Math.min(range.maxX, Math.max(range.minX, drag.originX + dx)) : drag.originX + dx;
    this.panY = range ? Math.min(range.maxY, Math.max(range.minY, drag.originY + dy)) : drag.originY + dy;
    this.applyPan();
  };

  private readonly onPanEnd = (event: PointerEvent): void => {
    if (this.panDrag && event.pointerId === this.panDrag.pointerId) {
      if (this.panDrag.moved) {
        this.panEndedAt = event.timeStamp;
      }
      this.endPan();
    }
  };

  private endPan(): void {
    window.removeEventListener("pointermove", this.onPanMove);
    window.removeEventListener("pointerup", this.onPanEnd);
    window.removeEventListener("pointercancel", this.onPanEnd);
    this.panDrag = undefined;
    this.root?.querySelector<HTMLElement>(".canvas-page")?.removeAttribute("data-panning");
  }

  /**
   * Live resize while a sheet edge is being dragged. The sheet is centered, so pulling one
   * edge outward widens it on both sides — the width moves by twice the pointer's travel.
   * Styles are written directly here and the result committed to the controller only on
   * release, so the preview is not rebuilt on every mousemove.
   */
  private readonly onSheetDrag = (event: MouseEvent): void => {
    const drag = this.sheetDrag;
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    if (!drag || !surface) {
      return;
    }
    // The pointer travels in screen pixels; the sheet's width is in its own, which the zoom scales.
    const travel = (event.clientX - drag.startX) / this.zoomValue;
    const raw = drag.edge === "right" ? drag.startW + travel * 2 : drag.startW - travel * 2;
    // No upper bound: wider than the pane is allowed — the page scrolls sideways to reach
    // the overflow — and the width is the author's call. A drag is self-limiting anyway
    // (each one adds at most twice the pointer's travel).
    const next = Math.round(Math.max(280, raw));
    drag.lastW = next;
    surface.style.width = `${next}px`;
    surface.style.maxWidth = "none";
    // Re-centered on every move: the scroller lays an over-wide sheet out from its start,
    // and holding the scroll at center is what makes the drag grow both edges evenly.
    this.appliedSheetWidth = next;
    this.syncSheetRoom(surface);
    this.centerSheetScroll();
    // The bar's readout follows the drag live, before the width is committed on release.
    this.dispatchEvent(
      new CustomEvent<{ width: number }>("canvas-sheet-resize", { detail: { width: next }, bubbles: true, composed: true })
    );
  };

  /** Scrolls the page so the sheet sits centered — an over-wide one shows both overflows evenly. */
  /**
   * Opens or puts away the tools a narrow canvas folds behind one button: opening takes focus to
   * the first of them (the bar is one Tab stop, so the card is reached from its button).
   */
  private toggleCanvasMore(open: boolean, focusToggle = false): void {
    const more = this.root.querySelector<HTMLElement>("[data-canvas-more]");
    const bar = this.root.querySelector<HTMLElement>("[data-canvas-bar]");
    more?.setAttribute("aria-expanded", String(open));
    bar?.toggleAttribute("data-more-open", open);
    if (open) {
      [...this.root.querySelectorAll<HTMLButtonElement>("[data-canvas-more-pop] button")].find((tool) => !tool.disabled && !tool.closest("[hidden]"))?.focus();
    }
    if (focusToggle) {
      more?.focus();
    }
    // A card put away from outside holds the bar's stop on a tool no longer drawn: the stop comes back to the bar.
    this.syncCanvasTools?.();
  }

  /**
   * The active mode's worded actions in the bar, from the shell: the primary one
   * (`data-builder-primary`, Preview PDF) an accent pill before Try it, the others worded tools
   * before the zoom, which a narrow canvas folds behind its one button. The elements are the
   * mode's own, moved here, never copied; `modeLabel` names the folded card.
   */
  public setModeActions(controls: readonly HTMLElement[], modeLabel?: string): void {
    for (const old of this.modeActionsValue) {
      if (!controls.includes(old) && old.getRootNode() === this.root) {
        old.remove();
      }
    }
    this.modeActionsValue = [...controls];
    this.modeActionsLabel = modeLabel;
    // A mode shows and hides its actions as its document allows: the fold's button and the bar follow.
    this.modeActionsObserver?.disconnect();
    if (controls.length > 0 && typeof MutationObserver === "function") {
      this.modeActionsObserver ??= new MutationObserver(() => this.applyZoom());
      for (const control of controls) {
        this.modeActionsObserver.observe(control, { attributes: true, attributeFilter: ["hidden"] });
      }
    }
    this.placeModeActions();
  }

  private placeModeActions(): void {
    const tools = this.root.querySelector<HTMLElement>("[data-canvas-actions]");
    const tryIt = this.root.querySelector<HTMLElement>("[data-try-it]");
    if (!tools || !tryIt) {
      return;
    }
    for (const control of this.modeActionsValue) {
      const primary = control.hasAttribute("data-builder-primary");
      control.classList.add(...(primary ? ["canvas-try"] : ["canvas-tool", "canvas-word"]));
      // Moves only what is not already home: re-inserting a focused button would blur it.
      if (primary && control.nextElementSibling !== tryIt) {
        tryIt.before(control);
      } else if (!primary && control.parentElement !== tools) {
        tools.append(control);
      }
    }
    this.applyZoom();
  }

  /** The canvas's zoom, 1 at the form's own size. */
  public get zoom(): number {
    return this.zoomValue;
  }

  /**
   * Zooms the sheet: a scale (held between a quarter and double), or "fit" for the whole sheet
   * in the page, never above its own size. CSS zoom, so the page scrolls the scaled sheet and
   * every click, drop and scroll into view lands where it is drawn. Fit is the one place the
   * canvas measures, when asked.
   */
  public zoomTo(value: number | "fit" | "fit-width"): void {
    // Every call here is the author's (the bar, the keys, a pinch, the phone drawer): it ends the
    // auto-fit, a Fit included, so a resize does not undo what was asked for.
    if (value === "fit-width") {
      this.zoomWith("fit", true, true);
      return;
    }
    this.zoomWith(value, false, true);
  }

  /** The sheet and the page's room as they are drawn: the one place the canvas measures. */
  private measureLayout(): { sheetWidth: number; sheetHeight: number; roomWidth: number; roomHeight: number } {
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    const page = this.root.querySelector<HTMLElement>(".canvas-page");
    if (!surface || !page) {
      return { sheetWidth: 0, sheetHeight: 0, roomWidth: 0, roomHeight: 0 };
    }
    // Measured at its own size: the zoom comes off for the reading and goes back with the caller.
    const zoom = surface.style.zoom;
    surface.style.zoom = "";
    const sheet = surface.getBoundingClientRect();
    surface.style.zoom = zoom;
    const style = getComputedStyle(page);
    const room = (size: number, start: string, end: string): number => size - (parseFloat(start) || 0) - (parseFloat(end) || 0);
    return {
      sheetWidth: sheet.width,
      sheetHeight: sheet.height,
      roomWidth: room(page.clientWidth, style.paddingLeft, style.paddingRight),
      roomHeight: room(page.clientHeight, style.paddingTop, style.paddingBottom)
    };
  }

  /**
   * A fixed sheet wider than the canvas is zoomed to fit its width, on first show and after each
   * resize, until the author chooses a zoom. A zoom the auto-fit set comes off again
   * when the room allows. A surface (the PDF's pages, the journey map) fits itself.
   */
  public fitIfOverflowing(): void {
    if (this.zoomChosen || this.shownSurface()) {
      return;
    }
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    if (!surface?.hasAttribute("data-sheet-fixed")) {
      return;
    }
    const target = this.fitFactor(true);
    // Unchanged is left alone: a padding change (a selection) or Try it opening must not
    // scroll the page back to the top.
    if (target !== undefined && target !== this.zoomValue) {
      this.zoomWith("fit", true, false);
    }
  }

  /** The zoom that fits the sheet (its width, or the whole page) in the room, as {@link zoomWith} settles it; undefined unmeasured. */
  private fitFactor(widthOnly: boolean): number | undefined {
    const { sheetWidth, sheetHeight, roomWidth, roomHeight } = this.measureFit();
    if (!(sheetWidth > 0 && roomWidth > 0 && (widthOnly || (sheetHeight > 0 && roomHeight > 0)))) {
      return undefined;
    }
    const raw = widthOnly ? Math.min(1, roomWidth / sheetWidth) : Math.min(1, roomWidth / sheetWidth, roomHeight / sheetHeight);
    return this.settleZoom(raw);
  }

  /** Steps land on 100% again (1.25 times 0.8 is a hair off 1 in floating point), held between the ends. */
  private settleZoom(next: number): number {
    return Math.abs(next - 1) < 0.01 ? 1 : Math.min(this.zoomMax(), Math.max(CANVAS_ZOOM_MIN, next));
  }

  /** A surface that zooms itself has its own largest factor; the sheet's stops at double. */
  private zoomMax(): number {
    return this.shownSurface()?.zoom ? SURFACE_ZOOM_MAX : CANVAS_ZOOM_MAX;
  }

  /** Observes the page so a resize fits a fixed sheet again; jsdom has no ResizeObserver. */
  private observeFit(): void {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const page = this.root.querySelector(".canvas-page") ?? undefined;
    if (page === this.fitObserved) {
      return;
    }
    this.fitObserver ??= new ResizeObserver(() => this.fitIfOverflowing());
    this.fitObserver.disconnect();
    this.fitObserved = page;
    if (page) {
      // The border box, as the journey map's observer does: the scrollbar's width must not move the reading.
      this.fitObserver.observe(page, { box: "border-box" });
      // The notice's slot spans the page's room, so a drawer opening (which moves only the page's padding) fits again too.
      const room = page.querySelector("[data-drop-error]");
      if (room) {
        this.fitObserver.observe(room);
      }
    }
  }

  private zoomWith(value: number | "fit", widthOnly: boolean, chosen: boolean): void {
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    const page = this.root.querySelector<HTMLElement>(".canvas-page");
    if (chosen) {
      this.zoomChosen = true;
    }
    let next = value === "fit" ? 1 : value;
    // A whole-page Fit shows the form where it belongs: centred, from the top. A width fit
    // (the auto-fit, the drawer's) leaves the page where the author scrolled it.
    if (value === "fit" && !widthOnly) {
      this.panX = 0;
      this.panY = 0;
    }
    if (value === "fit" && surface && page && !this.shownSurface()?.zoom) {
      next = this.fitFactor(widthOnly) ?? 1;
    }
    next = this.settleZoom(next);
    const changed = next !== this.zoomValue;
    this.zoomValue = next;
    this.applyZoom();
    // A surface that zooms itself (the PDF's pages) is told; the readout above stays the canvas's.
    this.shownSurface()?.zoom?.(value === "fit" ? "fit" : next);
    if (value === "fit" && !widthOnly && page) {
      page.scrollTop = 0;
    }
    this.centerSheetScroll();
    if (changed) {
      const said = next >= this.zoomMax() ? "canvas.zoomMax" : next <= CANVAS_ZOOM_MIN ? "canvas.zoomMin" : "canvas.zoomSaid";
      this.announce(this.words.text(said, { percent: Math.round(next * 100) }));
    }
  }

  /**
   * Makes the Try it controller once the chunk is in: the first Try it loads it, a
   * failed load is reported in the panel with Try again. Resolves to `undefined` when the load failed.
   */
  private startTry(): Promise<TryItController | undefined> {
    if (this.tryIt) {
      return Promise.resolve(this.tryIt);
    }
    if (!this.tryLoading) {
      const loading: Promise<TryItController | undefined> = loadTryIt().then(
        (module) => {
          if (this.tryLoading === loading) {
            this.tryLoading = undefined;
          }
          this.tryLoadFailed = false;
          try {
            this.tryIt ??= module.createTryIt({
              canvas: this,
              root: () => this.root,
              // The canvas's own, whose locale the bar and the chrome's switcher drive.
              controller: () => this.ctrl,
              preview: () => this.preview,
              builderMode: () => this.tryingForm()?.mode,
              workspace: () => this.tryingForm()?.workspace ?? "form",
              session: () => this.trySession,
              words: () => this.words,
              pdfMode: () => this.tryPdfModeValue?.(),
              renderer: () => this.rendererEl,
              trySettings: () => this.trySettingsSource(),
              serverChecks: () => this.serverChecksValue,
              pdf: () => this.tryPdfValue,
              mode: () => this.tryMode,
              showing: () => this.showingValue,
              stopShowing: () => this.endShowing(),
              showingUnapplied: () => this.showingGivens?.unapplied,
              recording: () => this.recordingListener,
              stopRecording: () => this.endRecording(),
              setMode: (mode) => {
                this.tryMode = mode;
                if (this.ctrl) {
                  this.syncCanvasChrome(this.ctrl);
                }
              }
            });
            this.tryCss = module.TRY_PANEL_STYLES;
            this.renderTryPanel();
            if (this.tryRetried) {
              this.tryRetried = false;
              this.focusTryPanel();
            }
            return this.tryIt;
          } catch (cause) {
            this.tryIt = undefined;
            return this.tryLoadFailedWith(loading, cause);
          }
        },
        (cause: unknown) => this.tryLoadFailedWith(loading, cause)
      );
      this.tryLoading = loading;
    }
    return this.tryLoading;
  }

  /** The Try it chunk did not load (or could not be made): the panel says so with Try again, and the host hears it. */
  private tryLoadFailedWith(loading: Promise<TryItController | undefined>, cause: unknown): undefined {
    if (this.tryLoading === loading) {
      this.tryLoading = undefined;
    }
    this.tryLoadFailed = true;
    this.renderTryPanel();
    this.dispatchEvent(new CustomEvent("datum-error", { bubbles: true, composed: true, detail: { code: "file.unavailable", message: this.words.text("canvas.tryLoadFailed"), cause } }));
    return undefined;
  }

  /** The results sheet's grabber in step with the shell: its height and words ride on attributes of this element. */
  private syncTryGrab(panel: HTMLElement): void {
    const grab = panel.querySelector<HTMLElement>("[data-try-grab]");
    if (!grab) {
      return;
    }
    const tall = this.hasAttribute("data-results-tall");
    grab.setAttribute("aria-expanded", String(tall));
    const label = this.getAttribute(tall ? "data-grab-label-tall" : "data-grab-label");
    if (label) {
      grab.setAttribute("aria-label", label);
    }
  }

  /** The chunk's styles, appended to the shadow root once (the canvas's own sheet carries only the panel's place). */
  private ensureTryStyles(): void {
    if (this.tryCss !== undefined && !this.root.querySelector("style[data-try-styles]")) {
      const style = document.createElement("style");
      style.setAttribute("data-try-styles", "");
      style.textContent = this.tryCss;
      this.root.append(style);
    }
  }

  /** After Try again, focus follows the panel: the sheet's title on a phone, else the first control. */
  private focusTryPanel(): void {
    const panel = this.root.querySelector<HTMLElement>("[data-try-panel]");
    if (!panel || panel.hidden) {
      return;
    }
    const target = this.hasAttribute("data-phone")
      ? panel.querySelector<HTMLElement>("[data-try-sheet-title]")
      : panel.querySelector<HTMLElement>("[data-try-mode], [data-try-print]");
    target?.focus();
  }

  /**
   * Draws the Try it panel: the chunk's cards once it is in; until then a note ("Starting Try
   * it…", the journey map's shape), or after a failed load the failure with Try again.
   */
  private renderTryPanel(): void {
    const panel = this.root?.querySelector<HTMLElement>("[data-try-panel]");
    if (!panel || panel.hidden) {
      return;
    }
    if (this.tryIt) {
      this.ensureTryStyles();
      this.tryIt.render();
      return;
    }
    // A phone's Results sheet has its head (title, close) from the first draw, as the chunk draws it.
    const head = `<div class="try-sheet-head"><h2 class="try-sheet-title" tabindex="-1" data-try-sheet-title>${esc(this.words.text("canvas.tryIt"))}</h2><button type="button" class="try-grab" data-try-grab aria-expanded="false" aria-label="${esc(this.words.text("shell.sheet.grab"))}"></button><button type="button" class="try-close" data-try-close aria-label="${esc(this.words.text("canvas.tryClose"))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>`;
    if (this.tryLoadFailed) {
      panel.innerHTML = `${head}<div class="try-load" data-try-load="failed" role="alert"><p class="try-load-text">${esc(this.words.text("canvas.tryLoadFailed"))}</p><button type="button" class="btn" data-try-load-retry>${esc(this.words.text("canvas.tryAgain"))}</button></div>`;
      this.syncTryGrab(panel);
      return;
    }
    if (!panel.querySelector("[data-try-load=\"loading\"]")) {
      panel.innerHTML = `${head}<p class="try-load" data-try-load="loading" role="status" tabindex="-1">${esc(this.words.text("canvas.tryStarting"))}</p>`;
      this.syncTryGrab(panel);
    }
    void this.startTry();
  }

  /** The controller whose Submitting in Try it settings apply: the form's, else the canvas's own. */
  private trySettingsSource(): BuilderController | undefined {
    return this.trySettingsControllerValue ?? this.ctrl;
  }

  private onTryClick(path: HTMLElement[]): void {
    if (path.some((el) => el?.dataset?.tryLoadRetry !== undefined)) {
      this.tryLoadFailed = false;
      this.tryRetried = true;
      this.renderTryPanel();
      this.root.querySelector<HTMLElement>('[data-try-load="loading"]')?.focus();
      return;
    }
    this.tryIt?.click(path);
  }

  /** Says a change in the canvas's live region (the zoom's level, where the selection landed). */
  private announce(text: string): void {
    const region = this.root.querySelector<HTMLElement>("[data-canvas-announce]");
    if (region) {
      region.textContent = text;
    }
  }

  /**
   * The sheet's width as drawn, on the page for the room it keeps beside an open drawer
   * (CANVAS_PANEL_STYLES): the applied width or the default, a fixed sheet's padding and border
   * around it, times the zoom. Nothing is measured.
   */
  private syncSheetRoom(surface: HTMLElement): void {
    const width = this.appliedSheetWidth ? `${this.appliedSheetWidth}px` : "var(--db-sheet-w, 860px)";
    const frame = surface.hasAttribute("data-sheet-fixed") ? " + 2 * var(--db-space-6) + 2 * var(--db-border-w)" : "";
    surface.parentElement?.style.setProperty("--page-sheet", `calc((${width}${frame}) * ${this.zoomValue})`);
  }

  /** The zoom on the sheet and the bar: the level's readout, and the ends' buttons off. */
  private applyZoom(): void {
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    if (surface) {
      surface.style.zoom = this.zoomValue === 1 ? "" : String(this.zoomValue);
      this.syncSheetRoom(surface);
    }
    this.applyPan();
    // A mode's own surface in the sheet's place may have nothing here to zoom (the journey map has its own).
    const group = this.root.querySelector<HTMLElement>("[data-canvas-zoom]");
    if (group) {
      const shown = this.shownSurface();
      group.hidden = shown !== undefined && !shown.zoomable;
    }
    // The narrow bar's folded tools button has nothing to open when no group and no worded action of the mode shows; named for what it holds.
    const more = this.root.querySelector<HTMLElement>("[data-canvas-more]");
    const devicesGroup = this.root.querySelector<HTMLElement>("[data-canvas-devices]");
    const folded = this.modeActionsValue.filter((control) => !control.hasAttribute("data-builder-primary") && !control.hidden);
    if (more && group && devicesGroup) {
      more.hidden = group.hidden && devicesGroup.hidden && folded.length === 0;
      const label =
        this.modeActionsLabel !== undefined && folded.length > 0 ? this.words.text("shell.doc.moreTools", { mode: this.modeActionsLabel }) : this.words.text("canvas.widthZoom");
      more.setAttribute("aria-label", label);
      more.setAttribute("data-tip", label);
    }
    this.syncCanvasBarShown();
    const percent = `${Math.round(this.zoomValue * 100)}%`;
    const level = this.root.querySelector<HTMLElement>("[data-canvas-zoom-level]");
    if (level) {
      writeText(level, percent);
      level.setAttribute("aria-label", this.words.text("canvas.zoomBack", { percent }));
    }
    const out = this.root.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="out"]');
    const into = this.root.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="in"]');
    if (out) {
      out.disabled = this.zoomValue <= CANVAS_ZOOM_MIN;
    }
    if (into) {
      into.disabled = this.zoomValue >= this.zoomMax();
    }
  }

  private centerSheetScroll(): void {
    const page = this.root.querySelector<HTMLElement>(".canvas-page");
    if (page) {
      page.scrollLeft = Math.max(0, (page.scrollWidth - page.clientWidth) / 2);
    }
  }

  private readonly onSheetDragEnd = (): void => {
    const drag = this.sheetDrag;
    this.sheetDrag = undefined;
    window.removeEventListener("mousemove", this.onSheetDrag);
    window.removeEventListener("mouseup", this.onSheetDragEnd);
    // Committed only if the pointer actually moved: a stray mousedown on the grip must not
    // freeze the sheet at whatever width it happened to have. The width goes to the controller
    // whose tree the sheet draws: the tried form's while it is tried over a mode's tree.
    if (drag?.lastW !== undefined) {
      this.sheetController()?.setPreviewWidth(drag.lastW);
    }
  };

  private ensureMarker(): HTMLElement {
    if (!this.marker || !this.marker.isConnected) {
      this.marker = document.createElement("div");
      this.marker.className = "db-marker";
    }
    return this.marker;
  }

  private clearDropIndicator(): void {
    this.marker?.remove();
    this.activeZone?.removeAttribute("data-db-drag-over");
    this.activeZone = undefined;
    this.dragPlaces = undefined;
    this.dropTarget = undefined;
  }

  /**
   * The shadow root the previewed form lives in. The canvas mounts a real
   * `<datum-form-renderer>`, so the rendered fields sit one boundary deeper than the panel's
   * own root — this is the supported way in for a host that needs to inspect or measure them.
   */
  public previewRoot(): ShadowRoot | undefined {
    return this.rendererEl?.shadowRoot ?? undefined;
  }

  /** The design-time runtime backing the preview, once the canvas has a controller. */
  public previewRuntime(): BuilderPreviewRuntime | undefined {
    return this.preview;
  }

  /**
   * Whether the canvas previews the form ("Try it"): its fields take input and
   * its rules run, nothing is selected, and the builder's chrome — outlines, grips, the selection
   * bar — is put away. Off (edit, the default), a field is one click target and the canvas is one
   * Tab stop, its fields out of the Tab order.
   */
  public get previewing(): boolean {
    return this.previewingValue;
  }

  public set previewing(value: boolean) {
    if (value === this.previewingValue) {
      return;
    }
    this.previewingValue = value;
    if (!value) {
      // Back to editing ends a recording, what it held back sent first.
      this.endRecording();
      this.tryIt?.clearSubmit();
      // Back to editing ends a test's step on show, the panel told once.
      this.endShowing();
    }
    this.dispatchEvent(new CustomEvent<{ previewing: boolean }>("canvas-preview-change", { detail: { previewing: value }, bubbles: true, composed: true }));
    this.paint();
  }

  /**
   * The optional parts of the canvas that exist (the builder's `features`): the Try it
   * panel (the answers, the checks, Submit, Preview PDF — and its chunk) and the selection bar's
   * Add logic. All of them unless the shell says otherwise. The bar's Edit / Preview toggle is
   * the canvas's own and stays: without `tryIt` it shows the form live, with its rules running,
   * and no panel beside it. Turning the panel off with one up takes it down.
   */
  public get canvasFeatures(): { readonly tryIt: boolean; readonly logic: boolean } {
    return this.canvasFeaturesValue;
  }

  public set canvasFeatures(value: { tryIt?: boolean | undefined; logic?: boolean | undefined }) {
    const next = { tryIt: value.tryIt !== false, logic: value.logic !== false };
    if (next.tryIt === this.canvasFeaturesValue.tryIt && next.logic === this.canvasFeaturesValue.logic) {
      return;
    }
    this.canvasFeaturesValue = next;
    this.paint();
  }

  /**
   * The server's checks the Try it panel can run (a host's WebAssembly sandbox): in
   * hand, or a loader called the first time the author turns the validator on. Unset,
   * the panel says the page provides none and checks in the browser alone.
   */
  public get serverChecks(): TryItServerChecksSource | undefined {
    return this.serverChecksValue;
  }

  public set serverChecks(value: TryItServerChecksSource | undefined) {
    if (value === this.serverChecksValue) {
      return;
    }
    this.serverChecksValue = value;
    // The validator's state is the chunk's: a controller already made starts over, one not yet made reads the value when it is.
    if (this.tryIt) {
      this.tryIt.serverChecksChanged();
    } else {
      this.renderTryPanel();
    }
  }

  /**
   * The controller whose Submitting in Try it settings the form's Submit follows (the shell sets
   * the form's own); unset, the canvas's.
   */
  public get trySettingsController(): BuilderController | undefined {
    return this.trySettingsControllerValue;
  }

  public set trySettingsController(value: BuilderController | undefined) {
    this.trySettingsControllerValue = value;
  }

  /**
   * What Try it tries while a mode's tree is on the canvas: the shell sets it as Try
   * it starts there (inside `canvas-preview-change`, which the `previewing` setter dispatches
   * before it paints) and clears it as Try it ends. No paint of its own: the `previewing`
   * setter's paint draws the form in the mode's tree's place, and the mode's tree again after.
   */
  public get tryForm(): CanvasTryForm | undefined {
    return this.tryFormValue;
  }

  public set tryForm(value: CanvasTryForm | undefined) {
    this.tryFormValue = value;
  }

  /**
   * The definition's `pdf` block for Try it's fallback Preview PDF, through the canvas's own
   * renderer: the preview hands it to the PDF it renders, which prints the layout the answers
   * choose. The shell sets one only on a page with no PDF mode, whose
   * `tryIt.pdf` otherwise prints (it alone resolves a layout's templates and images).
   */
  public set pdfConfigurationSource(value: (() => PdfConfiguration | undefined) | undefined) {
    this.pdfConfigurationValue = value;
  }

  public get pdfConfigurationSource(): (() => PdfConfiguration | undefined) | undefined {
    return this.pdfConfigurationValue;
  }

  /** The mode lending `tryIt.pdf` (the PDF designer), read on every Preview PDF: it prints from every workspace. Set by the shell. */
  public set tryPdfMode(value: (() => BuilderMode | undefined) | undefined) {
    this.tryPdfModeValue = value;
  }

  public get tryPdfMode(): (() => BuilderMode | undefined) | undefined {
    return this.tryPdfModeValue;
  }

  /**
   * A mode's session changed what it shows (a journey moved on, restarted, was edited live): the
   * Try panel is drawn again, and the renderer takes the session's runtime when it is a new one.
   */
  public tryRefresh(): void {
    const session = this.trySession;
    if (session && this.rendererEl && this.tryingForm() && this.rendererEl.runtime !== session.runtime) {
      this.rendererEl.runtime = session.runtime;
    }
    if (session) {
      this.watchSession(session);
    }
    // A recording follows the runtime tried (a journey's arriving over the preview), whether or not the panel is on show.
    if (this.recordingListener) {
      this.tryIt?.recordingChanged();
    }
    this.renderTryPanel();
  }

  /**
   * Clear answers from outside the Try panel (the PDF preview dialog's Clear): the
   * panel's own when its chunk is in, else the shared store emptied and a session started over.
   */
  public clearTriedAnswers(): void {
    if (this.tryIt) {
      this.tryIt.clearAnswers();
      return;
    }
    this.endRecording();
    this.preview?.clearValues();
    this.trySession?.restart();
  }

  // --- An agent's way into Try it ------------------------------------------
  // Each is what the person's own control does or reads, with the outcome handed back; none is
  // called on a page without the agent tools, and none changes what the person's controls do.

  /**
   * The runtime Try it tries now: a mode's session's (a journey's, page by page) while one runs,
   * else the canvas's preview; `undefined` while the canvas edits rather than tries.
   *
   * @internal
   */
  public triedRuntime(): RenderHostRuntime | undefined {
    return this.previewingValue ? (this.trySession?.runtime ?? this.preview) : undefined;
  }

  /**
   * Resolves once what Try it shows is drawn: a mode's session started (a journey's preview, its
   * chunk in, `BuilderTrySession.ready`), then the renderer's paint of it.
   *
   * @internal
   */
  public async tryReady(): Promise<void> {
    await this.trySession?.ready?.();
    await this.rendererEl?.painted();
  }

  /**
   * The journey page id of the node a page runs under in the session tried; `undefined` with no
   * session (the preview runs pages under their own ids) or no such page node.
   *
   * @internal
   */
  public tryPageIdOf(nodeId: string): string | undefined {
    return this.trySession?.pageIdOf?.(nodeId);
  }

  /**
   * The node a journey page runs under in the session tried, from its page id; `undefined` with
   * no session or no such page.
   *
   * @internal
   */
  public tryNodeIdOf(pageId: string): string | undefined {
    return this.trySession?.nodeIdOf?.(pageId);
  }

  /**
   * Check now, as the panel's button does (loading the chunk first), with what it found. Rejects
   * with the `try-it` feature off (no chunk is asked for), when the chunk cannot be loaded (the
   * panel then says so with Try again), and when Try it is not on, or ended while the chunk came.
   *
   * @internal
   */
  public async agentTryCheck(): Promise<TryCheckOutcome> {
    const tryIt = await this.agentTryIt("check");
    return tryIt.check();
  }

  /**
   * The form's Submit in Try it (loading the chunk first), quiet while the person's focus is
   * outside the canvas; see `TryItController.submitForAgent`. Rejects as
   * {@link agentTryCheck} does: the feature off, the chunk not loaded, Try it not on or ended
   * while the chunk came (as the person's own Submit queued on the load is dropped then).
   *
   * @internal
   */
  public async agentTrySubmit(): Promise<TrySubmitOutcome | { state: "busy" }> {
    const tryIt = await this.agentTryIt("Submit");
    return tryIt.submitForAgent();
  }

  /**
   * The Try it controller for an agent's check or Submit: never with the `try-it` feature off (the
   * host left the chunk out), and only while the Try panel is on show once the chunk is
   * in, the rule the person's Submit queued on the load follows (`datum-form-action`): the person
   * may press Back to editing while it comes, and nothing then runs against the editing canvas.
   *
   * @internal
   */
  private async agentTryIt(what: "check" | "Submit"): Promise<TryItController> {
    if (!this.canvasFeaturesValue.tryIt) {
      throw new Error("Try it is off on this builder.");
    }
    const tryIt = await this.startTry();
    if (!tryIt) {
      throw new Error("The Try it panel could not be loaded.");
    }
    const panel = this.root?.querySelector<HTMLElement>("[data-try-panel]");
    if (!this.previewingValue || !panel || panel.hidden) {
      throw new Error(`Try it is not on, or ended before the ${what} ran.`);
    }
    return tryIt;
  }

  /**
   * The next page change of the form tried takes no focus while the person's focus is outside
   * it (the renderer's `quietNextPageFocus`); the returned release ends the quiet once the move
   * settles. A no-op release while there is no renderer.
   *
   * @internal
   */
  public quietTriedPageFocus(): () => void {
    return this.rendererEl?.quietNextPageFocus() ?? (() => undefined);
  }

  /**
   * The value path of the box the person is typing in on the form tried (a text box, a text
   * area: `isCaretControl`), while the document has focus and Try it is on; `undefined` otherwise.
   * A select, a checkbox or a button that has focus is not typing.
   *
   * @internal
   */
  public focusedTriedPath(): string | undefined {
    if (!this.previewingValue || typeof document === "undefined" || !document.hasFocus()) {
      return undefined;
    }
    const field = this.rendererEl?.shadowRoot?.activeElement ?? null;
    if (field === null) {
      return undefined;
    }
    let deepest: Element = field;
    while (deepest.shadowRoot?.activeElement) {
      deepest = deepest.shadowRoot.activeElement;
    }
    if (!(deepest instanceof HTMLElement) || !isCaretControl(deepest)) {
      return undefined;
    }
    // From the box in the renderer's tree: closest() from inside a theme control's own shadow root would never reach it.
    return field.closest<HTMLElement>("[data-value-path]")?.dataset.valuePath ?? field.closest<HTMLElement>("[data-component-id]")?.dataset.componentId;
  }

  /**
   * Whether the canvas records Try it for the Tests panel (Record).
   *
   * @internal
   */
  public tryRecording(): boolean {
    return this.recordingListener !== undefined;
  }

  /**
   * Whether a test's step is on show (Show me).
   *
   * @internal
   */
  public tryShowing(): boolean {
    return this.showingValue !== undefined;
  }

  /**
   * Whether the person turned Try it's server checks on in the panel; `"off"` before the chunk is in.
   *
   * @internal
   */
  public tryServerChecks(): "off" | "on" {
    return this.tryIt?.serverChecksOn() === true ? "on" : "off";
  }

  /**
   * Hears every Submit in Try it, the person's and an agent's (`builder-try-submit`), until the
   * returned function is called.
   *
   * @internal
   */
  public onTrySubmit(listener: (outcome: TrySubmitOutcome) => void): () => void {
    const heard = (event: Event): void => {
      listener((event as CustomEvent<TrySubmitOutcome>).detail);
    };
    this.addEventListener("builder-try-submit", heard);
    return () => this.removeEventListener("builder-try-submit", heard);
  }

  /**
   * Where the Try it chunk stands for this canvas: `"off"` with the `try-it` feature off,
   * `"loading"` while a load is in flight, `"failed"` after the last load failed (until a Try
   * again or an agent's call loads it), `"ready"` once its controller is made, or before any
   * load: the first Try it, or an agent's check or Submit, loads it.
   *
   * @internal
   */
  public tryChunkState(): "ready" | "loading" | "failed" | "off" {
    if (!this.canvasFeaturesValue.tryIt) {
      return "off";
    }
    if (this.tryIt) {
      return "ready";
    }
    if (this.tryLoading) {
      return "loading";
    }
    return this.tryLoadFailed ? "failed" : "ready";
  }

  // --- Show me ----------------------------------------------------------

  /** The test's step on show, handed by the Tests panel; see {@link showScenario}. */
  private showingValue: CanvasScenarioShowing | undefined;
  /** The tree the showing was set on: an edit replaces it, and the state shown is then not what the test saw. */
  private showingRoot: ComponentNode | undefined;

  /** The test's step on show on the canvas, if any (Show me). */
  public get scenarioShowing(): CanvasScenarioShowing | undefined {
    return this.showingValue;
  }

  /**
   * Shows a test's step on the canvas (Show me): Try it on, the tried
   * answers replaced by the step's `values` (by component id, as the preview's `setValue` takes
   * them), and the Try bar naming the step with Step back, Step forward and Stop showing. The
   * panel owns the replay and calls again with the next step. `undefined` forgets the showing and
   * leaves the answers and Try it as they are. The showing also ends, the panel told once through
   * its `onStop`, on Back to editing and on an edit of the form under it.
   */
  public showScenario(showing: CanvasScenarioShowing | undefined): void {
    if (showing === undefined) {
      this.showingValue = undefined;
      this.showingRoot = undefined;
      this.restoreShowingGivens();
      this.tryIt?.showingChanged();
      return;
    }
    // Held before Try it starts, so the shell's canvas-preview-change handler can read why it starts.
    this.showingValue = showing;
    this.showingRoot = undefined;
    if (!this.previewingValue) {
      this.previewing = true;
    }
    if (this.showingValue !== showing) {
      // Ended while Try it started (a listener of canvas-preview-change stopped it): nothing to show.
      return;
    }
    // Clear answers' own seam, so the checks, the last submit and a session go as they do there.
    this.clearTriedAnswers();
    // The scenario's givens the canvas has a seam for, for as long as it is shown.
    this.applyShowingGivens(showing.givens);
    const preview = this.preview;
    if (preview) {
      // A mode's session (a journey) runs the form its own way: the answers go where it reads them.
      const target = this.trySession?.runtime ?? preview;
      this.seedShowingRows(target, showing.rows);
      const settable = this.showingKeys(target.formRoot());
      for (const [key, value] of Object.entries(showing.values)) {
        if (!settable(key)) {
          continue;
        }
        try {
          target.setValue(key, value);
        } catch {
          // A key the path grammar refuses is nothing the canvas can show.
        }
      }
      this.showingRoot = preview.formRoot();
      // The journeys canvas goes to the page the step is on; the Form canvas names it in the bar.
      const pageId = (showing as CanvasScenarioShowing & { pageId?: unknown }).pageId;
      const page = typeof pageId === "string" && pageId !== "" ? pageId : showing.page;
      if (page !== undefined && this.trySession?.showPage) {
        try {
          this.trySession.showPage(page);
        } catch (error) {
          console.warn("datum-builder: the journey could not go to the page shown.", error);
        }
      }
    }
    this.tryIt?.answersChanged();
    this.tryRefresh();
    // The bar follows even where the panel is not on show (renderTryPanel draws nothing then).
    this.tryIt?.showingChanged();
  }

  /**
   * Gives each collection as many rows as the scenario had at the step, before the answers go in:
   * a row added with nothing typed has no key in the values, and would not be drawn otherwise
   *. Rows past the count (the form's starting rows) are left; a collection the preview
   * cannot add to (no Add, at its maximum, not a collection here) keeps what it has.
   */
  private seedShowingRows(preview: BuilderPreviewRuntime | BuilderTrySession["runtime"], rows: Record<string, number> | undefined): void {
    const add = (preview as { addRow?: (path: string) => number }).addRow;
    const remove = (preview as { removeRow?: (path: string, index: number) => void }).removeRow;
    if (rows === undefined || typeof add !== "function") {
      return;
    }
    for (const [path, count] of Object.entries(rows)) {
      for (let guard = 0; guard < count; guard += 1) {
        let index: number;
        try {
          index = add.call(preview, path);
        } catch {
          break;
        }
        if (index + 1 > count) {
          // The starting rows were already enough: the one just added goes again.
          try {
            remove?.call(preview, path, index);
          } catch {
            /* nothing more to undo */
          }
          break;
        }
        if (index + 1 === count) {
          break;
        }
      }
    }
  }

  /**
   * Which of a replay's keys the canvas sets: those whose last segment names a component of the
   * tree, by id or data key, and not a calculation's (the rules work its value out
   * from the others, and a value written to it would count as a typed answer). The runtime's own
   * "@" keys are a journey's, not answers.
   */
  private showingKeys(root: ComponentNode): (key: string) => boolean {
    const known = new Map<string, boolean>();
    const visit = (node: ComponentNode): void => {
      const calculated = node.rules?.value !== undefined;
      known.set(node.id, calculated);
      const dataKey = (node.configuration as { dataKey?: unknown } | undefined)?.dataKey;
      if (typeof dataKey === "string" && dataKey !== "") {
        known.set(dataKey, calculated);
      }
      for (const children of Object.values(node.children ?? {})) {
        for (const child of children) {
          visit(child);
        }
      }
    };
    visit(root);
    return (key) => {
      if (key.startsWith("@")) {
        return false;
      }
      const leaf = key.slice(key.lastIndexOf(".") + 1).replace(/\[\d+\]$/, "");
      return known.get(leaf) === false;
    };
  }

  /** Ends the showing and tells the panel once; a re-entrant `showScenario(undefined)` from its `onStop` finds nothing left to end. */
  private endShowing(): void {
    const showing = this.showingValue;
    if (!showing) {
      return;
    }
    this.showingValue = undefined;
    this.showingRoot = undefined;
    this.restoreShowingGivens();
    this.tryIt?.showingChanged();
    try {
      showing.onStop();
    } catch (error) {
      // The panel's to fix; the canvas's paint must not stop for it.
      console.warn("datum-builder: the Tests panel's onStop failed.", error);
    }
  }

  /**
   * After the preview took the tree a paint draws: an edit of the form ends the showing,
   * a tree swapped in whole (Try it over a designer's tree) is where the showing now sits.
   */
  private followShowingRoot(otherTree: boolean): void {
    const preview = this.preview;
    if (!this.showingValue || !preview) {
      return;
    }
    const root = preview.formRoot();
    if (this.showingRoot === undefined || otherTree) {
      this.showingRoot = root;
      return;
    }
    if (root !== this.showingRoot) {
      // Inside a paint: the givens go back once it is done, since putting a list back paints again.
      this.givensLater = true;
      try {
        this.endShowing();
      } finally {
        this.givensLater = false;
      }
    }
  }

  /**
   * Gives the runtimes drawn the host values of Try it's Settings: the canvas's preview, and a
   * mode's session runtime when it takes them (`FormRuntime.setHostContext`; one that does not is
   * left as it is). Each only when its own values differ, so a paint that moved nothing computes
   * nothing again.
   */
  private applyTryHostContext(preview: BuilderPreviewRuntime): void {
    // A showing's own `given host` stands in for Try it's values while it is shown.
    const context = this.showingGivens?.hostContext ?? this.trySettingsSource()?.tryHostContext();
    preview.setHostContext(context);
    const runtime = this.trySession?.runtime as { setHostContext?(context: Record<string, unknown> | undefined): void; hostContext?(): Record<string, unknown> | undefined } | undefined;
    if (runtime?.setHostContext && JSON.stringify(runtime.hostContext?.() ?? null) !== JSON.stringify(context ?? null)) {
      runtime.setHostContext(context);
    }
  }

  /** Set while a paint ends a showing, so {@link restoreShowingGivens} waits for the paint to finish. */
  private givensLater = false;

  /**
   * The givens of the showing on the canvas, as applied: what put them there is undone in
   * reverse when the showing goes, and what the canvas has no seam for is named in the bar.
   */
  private showingGivens: { key: string; unapplied: TryShowingGiven[]; locale?: string | undefined; hostContext?: Record<string, unknown> | undefined; restores: Array<() => void> } | undefined;

  /**
   * Applies a showing's givens where the canvas has a seam: `given options
   * for` as the controller's simulated list for the field's data source, `given locale` as the
   * preview's language, `given today` as the preview's day, `given host` as the host values the
   * rules read (the preview's and a mode's session runtime's, in place of Try it's Settings'
   * while it is shown); each put back when the showing goes. A day or a language has no seam in a
   * mode's session, which runs its own runtime (named in the bar). A step of the same scenario
   * keeps them as applied.
   */
  private applyShowingGivens(givens: TestsShowingGivens | undefined): void {
    const key = JSON.stringify(givens ?? null);
    if (this.showingGivens?.key === key) {
      return;
    }
    this.restoreShowingGivens();
    if (givens === undefined) {
      return;
    }
    const applied: NonNullable<typeof this.showingGivens> = { key, unapplied: [], restores: [] };
    // Held first: a list's change paints at once, and that paint reads the language to show.
    this.showingGivens = applied;
    const preview = this.preview;
    const session = this.trySession;
    if (givens.host !== undefined && Object.keys(givens.host).length > 0) {
      // Dotted names nest, as the test runner's drivers give them: `host.org.unit` reads `{ org: { unit } }`.
      const context: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(givens.host)) {
        const parts = name.split(".");
        let cursor = context;
        for (const part of parts.slice(0, -1)) {
          const next = Object.prototype.hasOwnProperty.call(cursor, part) ? cursor[part] : undefined;
          if (next === null || typeof next !== "object" || Array.isArray(next)) {
            cursor[part] = Object.create(null) as Record<string, unknown>;
          }
          cursor = cursor[part] as Record<string, unknown>;
        }
        cursor[parts[parts.length - 1] as string] = value;
      }
      applied.hostContext = context;
      if (preview) {
        this.applyTryHostContext(preview);
      }
      // Put back by the same seam once the showing is no longer held: Try it's own values return.
      applied.restores.push(() => {
        const current = this.preview;
        if (current) {
          this.applyTryHostContext(current);
        }
      });
    }
    const lists = Object.entries(givens.options ?? {});
    if (lists.length > 0) {
      const controller = this.sheetController();
      const sources = controller ? showingSourceIds(controller.snapshot()) : new Map<string, string>();
      let missed = false;
      for (const [path, items] of lists) {
        const sourceId = sources.get(path);
        if (!controller || sourceId === undefined) {
          missed = true;
          continue;
        }
        const prior = controller.simulatedDataSources().get(sourceId);
        applied.restores.push(() => controller.setSimulatedDataSource(sourceId, prior ? prior.map((item) => ({ ...item })) : undefined));
        // Each value its own label, as the test runner gives them (`given options for`).
        controller.setSimulatedDataSource(
          sourceId,
          items.map((item) => {
            const value = typeof item === "string" ? item : JSON.stringify(item);
            return { value, label: value };
          })
        );
      }
      if (missed) {
        applied.unapplied.push("options");
      }
    }
    if (givens.locale !== undefined) {
      if (session || !preview) {
        applied.unapplied.push("locale");
      } else {
        applied.locale = givens.locale;
        preview.setLocale(givens.locale);
        applied.restores.push(() => this.preview?.setLocale(this.ctrl?.currentLocale() ?? givens.locale!));
      }
    }
    if (givens.today !== undefined) {
      if (session || !preview) {
        applied.unapplied.push("today");
      } else {
        const prior = preview.today();
        preview.setToday(givens.today);
        applied.restores.push(() => preview.setToday(prior === "" ? undefined : prior));
      }
    }
  }

  /** Puts back what a showing's givens changed, last first. */
  private restoreShowingGivens(): void {
    const applied = this.showingGivens;
    if (!applied) {
      return;
    }
    this.showingGivens = undefined;
    const restore = (): void => {
      for (const undo of applied.restores.reverse()) {
        try {
          undo();
        } catch (error) {
          console.warn("datum-builder: a scenario's given could not be put back.", error);
        }
      }
    };
    if (this.givensLater) {
      queueMicrotask(restore);
    } else {
      restore();
    }
  }

  // --- Record -----------------------------------------------------------

  /** The Tests panel's listener while the canvas records what is done in Try it. */
  private recordingListener: TestsRecordListener | undefined;

  /** Whether the canvas records for the Tests panel (Record). */
  public get recording(): boolean {
    return this.recordingListener !== undefined;
  }

  /**
   * Record: turns Try it on if it is off and reports what the author does
   * in it to `listener` (the Try it chunk turns the tried runtime's settled events into
   * `TestsRecordEvent`s), the Try bar reading "Recording" with Stop recording, until the returned
   * function is called. Stop recording in the bar, Clear answers and Back to editing end it from
   * this side; `canvas-record-change` (bubbling, composed) says so, as it says a start. A second
   * recording replaces the first.
   */
  public recordTry(listener: TestsRecordListener): () => void {
    this.endRecording();
    this.recordingListener = listener;
    if (!this.previewingValue) {
      this.previewing = true;
    }
    if (this.recordingListener !== listener) {
      // Ended while Try it started.
      return () => undefined;
    }
    // Lent before the runtime is listened to, so the rules worked out again on that day are not recorded.
    this.lendRecordingDay();
    if (this.tryIt) {
      this.tryIt.recordingChanged();
    } else if (this.canvasFeaturesValue.tryIt) {
      // The chunk turns events into lines: it is fetched now even where the panel is not on show.
      // Its arrival is said (`ready`), so the panel takes the form as it was before the first
      // step, and Assert this can tell what that step moved.
      void this.startTry().then((tryIt) => {
        tryIt?.recordingChanged();
        if (tryIt && this.recordingListener === listener) {
          this.dispatchEvent(new CustomEvent<{ recording: boolean; ready: boolean }>("canvas-record-change", { detail: { recording: true, ready: true }, bubbles: true, composed: true }));
        }
      });
    }
    this.dispatchEvent(new CustomEvent<{ recording: boolean }>("canvas-record-change", { detail: { recording: true }, bubbles: true, composed: true }));
    return () => {
      if (this.recordingListener === listener) {
        this.endRecording();
      }
    };
  }

  /** Assert this: the tried runtime's fields, page and last Submit now; `undefined` while Try it is off. */
  public assertSnapshot(): TestsAssertSnapshot | undefined {
    return this.previewingValue ? this.tryIt?.assertSnapshot() : undefined;
  }

  /**
   * Whether {@link assertSnapshot} would give a form now, without building one: the Tests panel
   * asks on every paint whether to offer Assert this, and a snapshot is every field's state.
   */
  public get assertReady(): boolean {
    return this.previewingValue && this.tryIt !== undefined && (this.trySession?.runtime ?? this.preview) !== undefined;
  }

  /** Ends the recording, what the chunk held back sent to its listener first, and says so. */
  private endRecording(): void {
    if (!this.recordingListener) {
      return;
    }
    this.recordingListener = undefined;
    this.tryIt?.recordingChanged();
    // After what was held back went out: those lines were recorded on the lent day.
    const giveBack = this.recordingDayUndo;
    this.recordingDayUndo = undefined;
    giveBack?.();
    this.dispatchEvent(new CustomEvent<{ recording: boolean }>("canvas-record-change", { detail: { recording: false }, bubbles: true, composed: true }));
  }

  /** Puts back the preview's day after a recording that lent it one; see {@link lendRecordingDay}. */
  private recordingDayUndo: (() => void) | undefined;

  /**
   * A recording on a preview with no day runs on the author's calendar day, put back when it ends
   *: the canvas's preview has no day of its own, so a form
   * that reads the clock would be tried with none, and the test written from it could only end
   * `scenario.clockUnset`. With the day lent, the rules on screen read the day the snapshot
   * carries, and the panel writes it as the test's `given today` line. A preview that already
   * has a day keeps it; a mode's session runs a runtime of its own and is left alone.
   */
  private lendRecordingDay(): void {
    const preview = this.preview;
    if (!preview || this.trySession || preview.today() !== "") {
      return;
    }
    const day = recordingCalendarDay(new Date());
    preview.setToday(day);
    // Only the day lent is taken back: a showing's day set since (it ends the recording first) is its own.
    this.recordingDayUndo = () => {
      if (preview.today() === day) {
        preview.setToday(undefined);
      }
    };
  }

  /** The Try panel follows the answers typed into a session's runtime, as it does the preview's. */
  private watchSession(session: BuilderTrySession): void {
    if (this.sessionWatch?.runtime === session.runtime) {
      return;
    }
    this.sessionWatch?.stop();
    const stop = session.runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, () => this.tryIt?.answersChanged());
    this.sessionWatch = { runtime: session.runtime, stop };
  }

  /**
   * Ends a mode's session: its form answers, raw as its store holds them
   * (the journey's own "@" keys aside), replace the canvas's, so Form and PDF see what was tried
   * and an answer cleared there stays cleared; then it is disposed.
   */
  private endTrySession(): void {
    const session = this.trySession;
    this.sessionWatch?.stop();
    this.sessionWatch = undefined;
    if (!session) {
      return;
    }
    this.trySession = undefined;
    const preview = this.preview;
    if (preview) {
      try {
        const state = session.runtime.state();
        // The JSON reading drops a key holding `undefined`, and an empty drawn grid row is
        // exactly such keys (`items[1].sku: undefined`). They go back in, so the grid reopens
        // with every row the person saw, a trailing empty one included.
        const raw = state.values as Record<string, unknown>;
        const answers = kernelJsonAnswers(raw);
        for (const key of Object.keys(raw)) {
          if (raw[key] === undefined && !key.startsWith("@")) {
            answers[key] = undefined;
          }
        }
        preview.replaceValues(answers, state.dirty);
      } catch (error) {
        console.warn("datum-builder: the answers tried could not be kept.", error);
      }
    }
    session.dispose();
  }

  /** What is tried while a mode's tree is on the canvas; `undefined` outside Try it or on the form's own canvas. */
  private tryingForm(): CanvasTryForm | undefined {
    return this.previewingValue ? this.tryFormValue : undefined;
  }

  /** The controller whose tree the sheet draws: the form's while a mode's workspace is tried, else the canvas's. */
  private sheetController(): BuilderController | undefined {
    return this.tryingForm()?.controller ?? this.ctrl;
  }

  /** The surface in the sheet's place, as the bar's tools see it: none while the form is tried over a mode's. */
  private shownSurface(): typeof this.surfaceShown {
    return this.tryingForm() ? undefined : this.surfaceShown;
  }

  /** What the Try it panel's Preview PDF renders with; unset, the panel offers no PDF. */
  public get tryPdf(): TryItPdfSource | undefined {
    return this.tryPdfValue;
  }

  /**
   * The plugin formula functions the host wired (`FormulaFunctionRegistry`, or anything shaped
   * like one): the canvas preview parses a rule calling one and, when the source carries the
   * evaluators (`functions()`), works it out as the form will. Set by the shell; a source set
   * after the preview was built reaches it too.
   */
  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    if (this.formulaFunctionsValue === value) {
      return;
    }
    this.formulaFunctionsValue = value;
    this.preview?.setFunctions(this.pluginFunctions(), formulaSignatures(value));
  }

  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.formulaFunctionsValue;
  }

  /** The wired functions' evaluators, when the source carries them; see {@link FormulaFunctionsSource.functions}. */
  private pluginFunctions(): Record<string, (args: unknown[]) => unknown> | undefined {
    const source = this.formulaFunctionsValue;
    return source !== undefined && typeof source.functions === "function" ? source.functions() : undefined;
  }

  /** The print theme Try it's Print draws with (the shell's `printTheme`). */
  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
    if (this.rendererEl) {
      this.rendererEl.printTheme = value;
    }
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  private printThemeValue: PrintTheme | undefined;

  /** Sets up a renderer of the Print workspace's as this canvas's is drawn: the binding and its files, never written into the form. */
  public configurePrintRenderer(renderer: DatumFormRendererElement): void {
    if (!this.ctrl) {
      return;
    }
    const binding = this.canvasBindingOf(this.ctrl);
    if (renderer.binding !== binding) {
      renderer.binding = binding;
    }
    const assets = this.ctrl.canvasAssets();
    if (renderer.assets !== assets) {
      renderer.assets = assets;
    }
  }

  public set tryPdf(value: TryItPdfSource | undefined) {
    this.tryPdfValue = value;
    if (this.rendererEl) {
      // Support in hand goes to the renderer now; a loader, on the first Preview PDF.
      this.rendererEl.pdfProvider = typeof value === "object" ? value.provider : undefined;
      this.rendererEl.pdfFonts = typeof value === "object" ? value.fonts : undefined;
    }
    this.renderTryPanel();
  }

  /** Component ids the preview is currently hiding, for the properties panel's Tree tab. */
  public hiddenComponentIds(): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const [id, state] of this.preview?.effectiveStatesMap() ?? []) {
      if (!state.visible) {
        hidden.add(id);
      }
    }
    return hidden;
  }

  protected render(): void {
    // A change from anywhere else (an edit, an undo, a click, Try it) ends a keyboard move.
    this.mover?.end(true);
    if (!this.ctrl) {
      this.root.innerHTML = `<style>${builderTokens()}</style><div class="panel"><p class="empty">${esc(this.words.text("shell.noController"))}</p></div>`;
      this.rendererEl = undefined;
      this.watchRenderer();
      this.preview = undefined;
      this.endTrySession();
      return;
    }
    /*
     * Try it in a mode's workspace draws the FORM: its tree, theme, renderers and
     * chrome in the mode's tree's place, by the form's controller. That controller differing
     * from the one painted last is what takes the renderer off its runtime below, so the form
     * arrives whole, and the mode's tree comes back whole after.
     */
    const trying = this.tryingForm();
    const controller = trying?.controller ?? this.ctrl;
    /*
     * Another kind of tree on the sheet — another mode's controller (the form's, a PDF
     * layout's, a journey's), or this one set up with other component definitions — comes with
     * renderers and a theme of its own. The renderer paints at once on every property it is
     * handed, over the model it built last, so handing them over one at a time drew the old
     * tree with the new renderers: a journey's nodes under the form's, each type reported on
     * the console as unknown on every switch. Taken off its runtime meanwhile, it builds once,
     * from the new tree, with everything new. An edit on the same tree keeps the runtime, and
     * with it the tab or step the author had open.
     */
    const otherTree = controller !== this.paintedController;
    const swapping = this.rendererEl !== undefined && otherTree;
    /*
     * The same controller drawing its tree as another sheet (a journey step in its cards' place:
     * `canvasRoot`, `canvasView` or `canvasJourneyView` swapped) is drawn in one go too, the
     * renderer off its runtime meanwhile. It is the same author's sheet, though: the pan, the
     * zoom and the fitted width stay as they were, and so does a test being shown.
     */
    const canvasRevision = controller.canvasRevision();
    const detaching = swapping || (this.rendererEl !== undefined && !otherTree && canvasRevision !== this.paintedCanvasRevision);
    this.paintedCanvasRevision = canvasRevision;
    this.paintedController = controller;
    if (detaching && !swapping) {
      this.rendererEl!.runtime = undefined;
    }
    if (swapping) {
      this.rendererEl!.runtime = undefined;
      // Another tree is drawn where the sheet sits centred.
      this.panX = 0;
      this.panY = 0;
      if (otherTree) {
        // Another tree is the author's to zoom afresh; a fixed sheet is fitted again below.
        this.zoomChosen = false;
        this.appliedFixedWidth = undefined;
      }
      const ownZoom = this.surfaceShown?.zoom;
      if (otherTree && !trying && !ownZoom) {
        // Try it ended with no such viewer left to give its zoom back to.
        this.trySurfaceZoom = undefined;
      }
      if (otherTree && trying && ownZoom && this.trySurfaceZoom === undefined) {
        // Try it over a page viewer that zooms itself: its zoom is kept for after, and
        // the form drawn at as near it as the sheet's own zoom goes.
        this.trySurfaceZoom = this.zoomValue;
        this.zoomValue = Math.min(this.zoomValue, CANVAS_ZOOM_MAX);
        this.applyZoom();
      } else if (otherTree && !trying && ownZoom && this.trySurfaceZoom !== undefined) {
        // Back to editing: the viewer and the readout agree on the zoom it had.
        this.zoomValue = this.trySurfaceZoom;
        this.trySurfaceZoom = undefined;
        this.applyZoom();
        ownZoom(this.zoomValue);
      } else if (otherTree && this.zoomValue !== 1) {
        // At its own size too: a PDF page's zoom (a phone's Fit) never carries into the form,
        // whose phone canvas has no zoom to take it back with. A designer fits its
        // own page again once drawn.
        this.zoomValue = 1;
        this.applyZoom();
      } else {
        this.applyPan();
      }
    }

    // The panel shell is built once; thereafter only the preview repaints, so the renderer
    // element (and the caret inside whatever field is focused) survives every edit.
    if (!this.rendererEl) {
      const icons = this.iconSet();
      const t = (key: BuilderTextKey, params?: Record<string, string | number>): string => esc(this.words.text(key, params));
      this.root.innerHTML = `
        <style>${builderTokens()}${CANVAS_PANEL_STYLES}${TRY_PANEL_PLACE_STYLES}</style>
        <style data-icon-css>${icons.css ?? ""}</style>
        <div class="panel panel--canvas">
          <p id="canvas-keys" class="sr-only">${t("canvas.keys")}</p>
          <p class="sr-only" aria-live="polite" data-canvas-announce></p>
          <div class="canvas-bar-zone" data-canvas-bar-zone>
            <div class="canvas-bar" data-canvas-bar role="toolbar" aria-label="${t("canvas.bar")}">
              <span class="canvas-stepper" data-canvas-stepper hidden>
                <button type="button" class="canvas-tool" data-stepper-go="-1" aria-label="${t("canvas.stepPrev")}" data-tip="${t("canvas.stepPrev")}">${strokeIcon("M15 18l-6-6 6-6")}</button>
                <span class="canvas-stepper-text" data-stepper-text aria-live="polite"></span>
                <button type="button" class="canvas-tool" data-stepper-go="1" aria-label="${t("canvas.stepNext")}" data-tip="${t("canvas.stepNext")}">${strokeIcon("M9 18l6-6-6-6")}</button>
              </span>
              <span class="canvas-previewing" data-previewing-note hidden>${t("canvas.previewing")}</span>
              <button type="button" class="canvas-tool canvas-more" data-canvas-more aria-expanded="false" aria-controls="canvas-more-pop" aria-label="${t("canvas.widthZoom")}" data-tip="${t("canvas.widthZoom")}">${strokeIcon("M5 12h.01M12 12h.01M19 12h.01")}</button>
              <span class="canvas-more-pop" id="canvas-more-pop" data-canvas-more-pop>
              <span class="canvas-actions" data-canvas-actions></span>
              <span class="canvas-devices" data-canvas-devices role="group" aria-label="${t("canvas.previewWidth")}">${DEVICE_WIDTHS.map(
                (device) => `<button type="button" class="canvas-tool" data-device-width="${device.width}" aria-label="${t(device.label)}" data-tip="${t(device.label)}" aria-pressed="false">${strokeIcon(device.glyph)}</button>`
              ).join("")}</span>
              <span class="canvas-zoom" data-canvas-zoom role="group" aria-label="${t("canvas.zoom")}">
                <button type="button" class="canvas-tool" data-canvas-zoom-go="out" aria-label="${t("canvas.zoomOut")}" data-tip="${t("canvas.zoomOutTip")}">${strokeIcon("M5 12h14")}</button>
                <button type="button" class="canvas-tool" data-canvas-zoom-go="in" aria-label="${t("canvas.zoomIn")}" data-tip="${t("canvas.zoomInTip")}">${strokeIcon("M12 5v14M5 12h14")}</button>
                <button type="button" class="canvas-tool canvas-zoom-word" data-canvas-zoom-go="fit" aria-label="${t("canvas.fitLabel")}" data-tip="${t("canvas.fitTip")}">${t("canvas.fit")}</button>
                <button type="button" class="canvas-tool canvas-zoom-word" data-canvas-zoom-go="actual" data-canvas-zoom-level aria-label="${t("canvas.actualLabel")}" data-tip="${t("canvas.actualTip")}">100%</button>
              </span>
              </span>
              <button type="button" class="canvas-try" data-try-it aria-pressed="false">${t("canvas.tryIt")}</button>
            </div>
          </div>
          <div class="canvas-page" tabindex="0" role="group" aria-label="${t("canvas.page")}"
            aria-describedby="canvas-keys" aria-roledescription="canvas">
            <div data-drop-error></div>
            <div class="canvas-surface">
              <div class="sheet-grip" data-sheet-grip="left" title="${t("canvas.gripTitle")}"></div>
              <div class="sheet-grip" data-sheet-grip="right" title="${t("canvas.gripTitle")}"></div>
              <${DATUM_FORM_RENDERER_TAG} data-preview></${DATUM_FORM_RENDERER_TAG}>
              <p class="canvas-empty-root" data-canvas-empty-root hidden></p>
            </div>
            <div class="canvas-mode-surface" data-canvas-surface hidden></div>
          </div>
          <div class="selection-zone" data-selection-zone hidden>
            <div class="selection-bar" role="toolbar" data-selection-bar>
              <button type="button" class="selection-btn selection-edit" data-selection-edit aria-label="${t("canvas.edit")}" data-tip="${t("canvas.editTip")}" hidden>${strokeIcon("M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z")}</button>
              <span class="selection-name" data-selection-name></span>
              ${SELECTION_ACTIONS.map(
                (action) =>
                  `<button type="button" class="selection-btn" data-selection-action="${action.id}" aria-label="${t(action.label)}" data-tip="${t(action.tip ?? action.label)}">${strokeIcon(action.glyph)}</button>`
              ).join("")}
            </div>
          </div>
          <aside class="try-panel" data-try-panel aria-label="${t("canvas.tryIt")}" hidden></aside>
          <div data-canvas-prompt></div>
        </div>`;
      this.rendererEl = this.root.querySelector(`[data-preview]`) as DatumFormRendererElement;
      // Each bar is one Tab stop, arrows between its tools.
      this.syncCanvasTools = rovingToolbar(this.root.querySelector<HTMLElement>("[data-canvas-bar]")!, "button", true);
      this.syncSelectionTools = rovingToolbar(this.root.querySelector<HTMLElement>("[data-selection-bar]")!);
      // A mode's actions handed over before the bar was drawn.
      this.placeModeActions();
      this.rendererEl.printTheme = this.printThemeValue;
      // The drag grips are drawn inside the renderer's shadow root, so the set's CSS goes there too.
      this.rendererEl.extraStyles = CANVAS_CHROME_STYLES + CANVAS_HOOK_STYLES + (icons.css ?? "");
      const functions = this.pluginFunctions();
      this.preview = new BuilderPreviewRuntime(controller.snapshot(), {
        ...(controller.dataSourceResolver() ? { dataSourceResolver: controller.dataSourceResolver() } : {}),
        ...(controller.dataSources() ? { dataSources: controller.dataSources() } : {}),
        // The plugin formula functions the host wired, so a rule calling one works on the canvas.
        ...(functions !== undefined ? { functions } : {}),
        signatures: formulaSignatures(this.formulaFunctionsValue),
        locale: controller.currentLocale(),
        // The form's translations and the host's catalog, so the canvas words every text in the
        // preview language; refreshed below as the controller's map changes.
        ...(controller.translations() !== undefined ? { translations: controller.translations() } : {}),
        ...(controller.translationCatalog() !== undefined ? { translationCatalog: controller.translationCatalog() } : {}),
        // The form's locales, for a switcher the author placed in the form's chrome.
        localization: () => controller.localization(),
        // The PDF designer's layouts, so Try it's Preview PDF prints the one the answers choose.
        pdfConfiguration: () => this.pdfConfigurationValue?.()
      });
      this.rendererEl.runtime = this.preview;
      // Try it's Preview PDF renders through the host's provider.
      if (typeof this.tryPdfValue === "object") {
        this.rendererEl.pdfProvider = this.tryPdfValue.provider;
        this.rendererEl.pdfFonts = this.tryPdfValue.fonts;
      }
      // The Try it panel follows the answers as they are typed.
      this.preview.events().subscribe(FormEventType.COMPONENT_CHANGED, () => this.tryIt?.answersChanged());
      this.bind();
    }
    this.watchRenderer();
    this.syncSurface();

    // `previewSnapshot` is the committed tree with any uncommitted properties-panel draft laid
    // over it, so typing a label is visible here before Save writes it. Taken once: the sheet's
    // width may be read off the same tree below.
    // A tree owner may hand the canvas a copy of its own (`canvasSnapshot`).
    const previewRoot = controller.canvasSnapshot();
    // The journey page the tree is drawn as (`undefined`: the whole form), from the controller drawn.
    const journeyView = controller.canvasJourneyView();
    const preview = this.preview;
    // A mode's session runs the form its own way while it is tried, ended as Try it
    // ends: its answers land while the store still holds the form's tree, before the designer's.
    if (!trying) {
      this.endTrySession();
      this.sessionFailedFor = undefined;
    }
    if (preview) {
      // Keeps the design-time values the author typed; only the tree and locale change. The
      // locale is the canvas's own (the bar's language, the chrome's switcher), whichever tree.
      // The journey page the tree is drawn as, from the controller drawn (never a tried form's
      // mode's): taken with the tree, so a change of either is drawn once.
      preview.setFormRoot(previewRoot, { journeyView });
      this.followShowingRoot(otherTree);
      // A test shown with its own `given locale` keeps that language while it is shown.
      preview.setLocale(this.showingGivens?.locale ?? this.ctrl.currentLocale());
      preview.setDataSourceResolver(controller.dataSourceResolver());
      preview.setDataSources(controller.dataSources());
      // A Languages Apply or a wording edit replaces the map: the canvas follows without a tree reset.
      preview.setTranslations(controller.translations());
      preview.setTranslationCatalog(controller.translationCatalog());
      // The host values Try it's Settings gave (preview state, never in the form): what `host.` rules read.
      this.applyTryHostContext(preview);
    }
    // Made as Try it starts, seeded from the one set of answers. One that will not start is said
    // once, and the shared preview is tried instead.
    if (trying && !this.trySession && preview && this.sessionFailedFor !== trying.mode && trying.mode.tryIt?.session) {
      try {
        const seed = preview.state();
        this.trySession = trying.mode.tryIt.session(kernelJsonAnswers(seed.values as Record<string, unknown>), seed.dirty);
        this.watchSession(this.trySession);
        this.applyTryHostContext(preview);
      } catch (error) {
        this.sessionFailedFor = trying.mode;
        console.warn(`datum-builder: the "${trying.mode.id}" mode's Try it did not start; the form is tried on the canvas's preview.`, error);
      }
    }
    // Each of the renderer's inputs only when it changed: every assignment draws again (a binding
    // or its files mount the form again), and a commit whose draft the canvas already previewed
    // changes none of them but the hooks. Preview shows exactly what a person would see: nothing
    // a rule hides.
    const renderer = this.rendererEl;
    // The binding the form's element would draw with, as the host and the picker set it, under
    // the builder's scheme; a designer's own types laid over it. Never written into the form.
    const binding = this.canvasBindingOf(controller);
    if (renderer.binding !== binding) {
      renderer.binding = binding;
    }
    // The inspector reads how the form is drawn through the controller it edits with.
    controller.setDrawingSource(this.drawingSource);
    if (this.ctrl !== controller) {
      this.ctrl.setDrawingSource(this.drawingSource);
    }
    // A design system's files: a stylesheet that cannot be fetched draws the form element's
    // alert in the canvas's place, as it does in the live form.
    const assets = controller.canvasAssets();
    if (renderer.assets !== assets) {
      renderer.assets = assets;
    }
    const scheme = controller.canvasColorScheme();
    if (renderer.colorScheme !== scheme) {
      renderer.colorScheme = scheme;
    }
    // The canvas's chrome while editing; none while previewing or trying, where the form is a person's.
    const hooks = this.previewingValue ? undefined : this.buildHooks(controller);
    if (renderer.canvasHooks !== hooks) {
      renderer.canvasHooks = hooks;
    }
    // The root has no node of its own: its selection outline hangs on its drop zone.
    renderer.toggleAttribute("data-db-root-selected", hooks !== undefined && controller.selectedComponentId() === controller.canvasRootId());
    const showHidden = this.previewingValue ? false : controller.showHiddenComponents();
    if (renderer.showHiddenComponents !== showHidden) {
      renderer.showHiddenComponents = showHidden;
    }
    // A data grid is its header and one template row of drop zones while the form is built
    //: the children stay addressable by their own
    // ids, so selection and drops work. Preview and Try it draw the real rows.
    const gridRows: "entries" | "template" = this.previewingValue ? "entries" : "template";
    if (renderer.dataGridRows !== gridRows) {
      renderer.dataGridRows = gridRows;
    }
    renderer.toggleAttribute("data-previewing", this.previewingValue);
    // The host chrome the View panel previews under: a frame, the form's parts kept or left out.
    const chrome = controller.previewChrome();
    if (chrome !== this.appliedChrome) {
      this.appliedChrome = chrome;
      renderer.chrome = chrome;
    }
    // A session's runtime knows no data sources of the builder's: the form's go on the renderer
    // (as the journey preview's did), and come off again with the session.
    const sessionSources = this.trySession !== undefined ? controller.dataSources() : undefined;
    if (this.trySession !== undefined || this.sessionSources) {
      if (renderer.dataSources !== sessionSources) {
        renderer.dataSources = sessionSources;
      }
      this.sessionSources = this.trySession !== undefined;
    }
    const runtime = this.trySession?.runtime ?? preview;
    if (runtime && (detaching || renderer.runtime !== runtime)) {
      this.rendererEl.runtime = runtime;
    }

    // A component the author has just selected — by a click, a drop, the palette, the tree
    // dropdown — is shown: the tab or step it sits on opens once the repaint that draws it
    // lands. A step dropped into a `steps` container is the case that made this necessary:
    // never the container's first, it arrived hidden, its drop zone nowhere to be seen. Only
    // a *change* of selection does this — editing the selected component's properties
    // repaints too, and must not pull the canvas back from a step the author opened to look at
    // (the renderer keeps that step across the repaint on its own).
    const selectedId = controller.selectedComponentId();
    // Not while the form is tried over a mode's tree: the selection is the mode's, kept for after.
    if (!trying && selectedId !== this.revealedSelectionId) {
      this.revealedSelectionId = selectedId;
      if (selectedId !== undefined) {
        this.rendererEl.revealComponent(selectedId);
        if (this.addedSincePaint) {
          this.scrollToAdded(selectedId);
        }
      }
    }
    this.addedSincePaint = false;

    this.syncCanvasChrome(controller);
    // Once this change is drawn: the drop zones, the leaves out of the Tab order and the sheet's
    // colour follow it, even when the draw changed no element (a selection moving, a hook set).
    const drawn = this.rendererEl;
    void drawn.painted().then(
      () => {
        if (this.rendererEl === drawn) {
          this.queueEditInertness();
        }
      },
      () => undefined
    );

    const errorSlot = this.root.querySelector("[data-drop-error]");
    if (errorSlot) {
      errorSlot.innerHTML = controller.dropError
        ? `<p class="note drop-error" data-tone="error" role="alert">${esc(controller.dropError)}</p>`
        : "";
    }

    // A tree that fixes its own sheet width (BuilderControllerOptions.sheetWidth — the PDF
    // designer's page) takes the sheet away from the author: the width follows the tree, and
    // the picker, readout and drag grips are put away rather than shown disabled.
    const fixedWidth = controller.sheetWidth(previewRoot);
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    if (surface) {
      const width = fixedWidth ?? (controller.previewWidths() ? controller.previewWidth() : undefined);
      // The chosen width is the sheet's real width, not a cap — picking a device wider than
      // the pane must still change the preview (the page scrolls sideways to show it), and
      // the form inside resizes with the sheet either way. A fixed width is the *form's*:
      // the attribute switches the sheet to content-box so its padding wraps that width.
      surface.toggleAttribute("data-sheet-fixed", fixedWidth !== undefined);
      // A different fixed width (another layout's paper) lets the auto-fit act afresh.
      // Not while a surface is shown: the sheet is not drawn, and leaving the surface fits it.
      const refit = this.surfaceEl === undefined && fixedWidth !== this.appliedFixedWidth;
      if (refit) {
        this.appliedFixedWidth = fixedWidth;
        this.zoomChosen = false;
      }
      surface.style.width = width === undefined ? "" : `${width}px`;
      surface.style.maxWidth = width === undefined ? "" : "none";
      if (width !== this.appliedSheetWidth) {
        this.appliedSheetWidth = width;
        this.syncSheetRoom(surface);
        this.centerSheetScroll();
      }
      for (const grip of surface.querySelectorAll<HTMLElement>("[data-sheet-grip]")) {
        grip.hidden = fixedWidth !== undefined || !controller.previewWidths();
      }
      // The chrome drawn on the sheet (selection ring, drop line, hover outline) is judged against
      // the sheet, not the builder's page: the sheet's scheme is the one the form is drawn in
      // (canvasColorScheme), and syncSheetScheme() sets it on the renderer when it differs from
      // the builder's own. The sheet's colour is read off the drawn form after each draw.
      this.sheetScheme = scheme;
      this.syncSheetScheme();
      // A form that draws its own frame previews it on a flush sheet — the sheet's
      // border and shadow go, its fill stays — so the author sees one frame, the form's. A
      // journey step is drawn on a root carrying the form's configuration (the controller's own
      // root is the journey's), so its frame is read from what is drawn.
      const frame = resolveFrame(
        controller.previewChrome(),
        readFormChromeConfiguration((journeyView !== undefined ? previewRoot : controller.snapshot()).configuration)
      );
      surface.classList.toggle("canvas-surface--flush", frame !== SEAMLESS_FRAME_ID);
      this.observeFit();
      if (refit) {
        this.fitIfOverflowing();
      }
    }
  }

  /**
   * Puts `data-sheet-scheme` on the renderer when the sheet's scheme differs from the builder's,
   * so CANVAS_CHROME_STYLES re-pins the on-sheet tokens only where the builder's own
   * palette would sit on the wrong paper: a dark builder over a light sheet, or the reverse. The
   * builder's scheme is the inline `--db-color-scheme` the shell writes on this host (absent is
   * light); the sheet's is the scheme the form is drawn in (`canvasColorScheme()`) as the last
   * paint read it. The same scheme leaves the attribute off and the chrome keeps the builder's
   * palette. The shell calls it after it writes the builder's theme, because the builder's scheme can
   * change with no repaint of the canvas.
   */
  public syncSheetScheme(): void {
    const renderer = this.rendererEl;
    if (!renderer) {
      return;
    }
    const sheet = this.sheetScheme;
    const builder = this.style.getPropertyValue("--db-color-scheme").trim().toLowerCase() === "dark" ? "dark" : "light";
    if (sheet !== builder) {
      renderer.setAttribute("data-sheet-scheme", sheet);
    } else {
      renderer.removeAttribute("data-sheet-scheme");
    }
  }

  /** The scheme the form was drawn in as the last paint read it (`canvasColorScheme()`). */
  private sheetScheme: "light" | "dark" = "light";

  /**
   * The canvas bar (device widths, Try it) and the selection bar, drawn from
   * the controller: in one fixed place each, never attached to a field, so no geometry is measured.
   */
  private syncCanvasChrome(controller: BuilderController): void {
    const previewing = this.previewingValue;
    // The bar stays for every tree and surface: a fixed sheet gives up only the device
    // widths, and a surface says for itself whether zoom and Try it apply.
    const fixedSheet = controller.sheetWidth() !== undefined;
    const surface = this.shownSurface();
    const tryable = surface ? surface.tryable : true;
    const zone = this.root.querySelector<HTMLElement>("[data-canvas-bar-zone]");
    if (zone) {
      zone.hidden = false;
    }
    const canvasPane = this.root.querySelector<HTMLElement>(".panel--canvas");
    canvasPane?.toggleAttribute("data-canvas-bar-shown", zone !== null && !zone.hidden);
    const width = controller.previewWidth();
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-device-width]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.deviceWidth) === width));
    }
    const devices = this.root.querySelector<HTMLElement>("[data-canvas-devices]");
    if (devices) {
      // A fixed page (a PDF layout) has no devices to try it on, nor has a surface in the sheet's place.
      devices.hidden = previewing || fixedSheet || surface !== undefined || !controller.previewWidths();
    }
    this.applyZoom();
    // Try it's panel: shown while trying, unless the surface in the sheet's place has no Try it,
    // or the `try-it` feature is left out: the form is then previewed with no panel, and no chunk asked for.
    const showTry = previewing && tryable && this.canvasFeaturesValue.tryIt;
    const tryPanel = this.root.querySelector<HTMLElement>("[data-try-panel]");
    if (tryPanel && tryPanel.hidden === showTry) {
      tryPanel.hidden = !showTry;
      canvasPane?.toggleAttribute("data-try-shown", showTry);
      if (!showTry) {
        this.tryIt?.clearSubmit();
      }
      this.renderTryPanel();
    }
    // The column's width follows the workspace tried (the Journeys one draws the map in its card).
    canvasPane?.toggleAttribute("data-try-journeys", showTry && this.tryingForm()?.workspace === "journeys");
    const mode = showTry ? this.tryMode : "interactive";
    if (this.rendererEl && this.rendererEl.mode !== mode) {
      this.rendererEl.mode = mode;
    }
    const tryIt = this.root.querySelector<HTMLElement>("[data-try-it]");
    if (tryIt) {
      // Back to editing is never put away while trying (a surface that cannot be tried ends it first).
      tryIt.hidden = !tryable && !previewing;
      tryIt.setAttribute("aria-pressed", String(previewing));
      // Without the Try it panel the toggle only shows the form live: it says Preview, not Try it.
      writeText(tryIt, this.words.text(previewing ? "canvas.backToEditing" : this.canvasFeaturesValue.tryIt ? "canvas.tryIt" : "canvas.preview"));
    }
    const note = this.root.querySelector<HTMLElement>("[data-previewing-note]");
    if (note) {
      note.hidden = !previewing;
    }
    this.root.querySelector(".panel--canvas")?.toggleAttribute("data-previewing", previewing);
    // The stepper walks the tree drawn: the form's while it is tried over a mode's.
    this.syncStepper(this.sheetController() ?? controller);

    // The phone tier: the renderer hides the drag grips, the selection bar gains Edit.
    const phone = this.hasAttribute("data-phone");
    this.rendererEl?.toggleAttribute("data-phone", phone);
    const edit = this.root.querySelector<HTMLElement>("[data-selection-edit]");
    if (edit) {
      edit.hidden = !phone;
    }
    const selected = controller.selectedComponentId();
    const selectionZone = this.root.querySelector<HTMLElement>("[data-selection-zone]");
    if (!selectionZone) {
      return;
    }
    // A surface with a selection bar of its own (the journey map's selected step) has the canvas's left off.
    const showBar = !previewing && selected !== undefined && selected !== controller.canvasRootId() && surface?.selectionBar !== false;
    selectionZone.hidden = !showBar;
    canvasPane?.toggleAttribute("data-selection-shown", showBar);
    if (!showBar || selected === undefined) {
      return;
    }
    const node = readingOrder(controller.canvasTreeView()).find((entry) => entry.id === selected);
    const name = node?.label || selected;
    const bar = this.root.querySelector<HTMLElement>("[data-selection-bar]")!;
    bar.setAttribute("aria-label", this.words.text("canvas.selected", { name }));
    writeText(this.root.querySelector<HTMLElement>("[data-selection-name]")!, name);
    edit?.setAttribute("aria-label", this.words.text("canvas.editName", { name }));
    const place = controller.parentOf(selected);
    const count = place ? controller.slotChildCount(place.parentId, place.slotId) : 0;
    const fixedNode = controller.isFixedNode(selected);
    const disable = (id: string, off: boolean): void => {
      const button = bar.querySelector<HTMLButtonElement>(`[data-selection-action="${id}"]`);
      if (button) {
        button.disabled = off;
      }
    };
    // Add logic is Logic's (the `logic` feature): without it the bar has no such button.
    const logicButton = bar.querySelector<HTMLButtonElement>('[data-selection-action="logic"]');
    if (logicButton) {
      logicButton.hidden = !this.canvasFeaturesValue.logic;
    }
    disable("up", fixedNode || !place || place.index === 0);
    disable("down", fixedNode || !place || place.index >= count - 1);
    // Where it may go is worked out when asked: the dialog says so when it is nowhere.
    disable("move", fixedNode || !place);
    disable("duplicate", fixedNode);
    disable("delete", fixedNode);
    // A mode's action standing in for Delete words the button ("Take off this step").
    this.syncDeleteLabel();
    // Keep the bar's one Tab stop on an enabled button, the one last used where it still is.
    this.syncSelectionTools?.();
  }

  /**
   * The steps container the stepper walks ("Step 2 of 4 · Business details"): the one
   * around the selection, else the form's first. Its steps are its children.
   */
  private stepperSubject(controller: BuilderController): { id: string; steps: NestedTreeNodeView[] } | undefined {
    const order = readingOrder(controller.canvasTreeView());
    const byId = new Map(order.map((entry) => [entry.id, entry]));
    let at = controller.selectedComponentId();
    while (at !== undefined) {
      const node = byId.get(at);
      if (node?.type === "steps") {
        break;
      }
      at = controller.parentOf(at)?.parentId;
    }
    const container = (at !== undefined ? byId.get(at) : undefined) ?? order.find((entry) => entry.type === "steps");
    if (!container) {
      return undefined;
    }
    const steps = container.slots.flatMap((slot) => slot.children);
    return steps.length > 0 ? { id: container.id, steps } : undefined;
  }

  /** The step the preview shows for a container: the step drawn (the renderer draws the shown one), else the one last chosen here. */
  private stepperIndex(subject: { id: string; steps: NestedTreeNodeView[] }): number {
    const root = this.rendererEl?.shadowRoot;
    const drawn = new Set(
      [...(root?.querySelectorAll<HTMLElement>('.datum-live-container[data-kind="step"][data-container-id]') ?? [])]
        .filter((panel) => !panel.hidden && panel.closest("[hidden]") === null)
        .map((panel) => panel.dataset.containerId)
    );
    const fromMarkup = subject.steps.findIndex((step) => drawn.has(step.id));
    const index = fromMarkup >= 0 ? fromMarkup : (this.stepperAt.get(subject.id) ?? 0);
    return Math.min(Math.max(index, 0), subject.steps.length - 1);
  }

  /**
   * The canvas bar is put away while nothing in it shows (the journey map's surface has its own
   * zoom, no Try it and no steps to walk), so no empty pill is left at the canvas's top corner.
   * The room kept above the page for it goes with it.
   */
  private syncCanvasBarShown(): void {
    const bar = this.root.querySelector<HTMLElement>("[data-canvas-bar]");
    if (!bar) {
      return;
    }
    const shown =
      this.modeActionsValue.some((control) => !control.hidden) ||
      ["[data-canvas-stepper]", "[data-previewing-note]", "[data-canvas-devices]", "[data-canvas-zoom]", "[data-try-it]"].some((selector) => {
        const part = bar.querySelector<HTMLElement>(selector);
        return part !== null && !part.hidden;
      });
    if (bar.hidden === shown) {
      bar.hidden = !shown;
    }
    // No bar, no row kept for it above the page: the surface (the journey map) starts at the top.
    this.root.querySelector<HTMLElement>(".panel--canvas")?.toggleAttribute("data-canvas-bar-shown", shown);
  }

  private syncStepper(controller: BuilderController, index?: number): void {
    const stepper = this.root.querySelector<HTMLElement>("[data-canvas-stepper]");
    if (!stepper) {
      return;
    }
    // A canvas that walks steps of its own (a journey's, one at a time) says where it is.
    const own = controller.canvasStepper();
    if (own) {
      stepper.hidden = false;
      this.syncCanvasBarShown();
      writeText(this.root.querySelector<HTMLElement>("[data-stepper-text]")!, this.words.text("canvas.stepper", { n: own.index + 1, total: own.total, label: own.label }));
      stepper.querySelector<HTMLButtonElement>('[data-stepper-go="-1"]')!.disabled = own.index <= 0;
      stepper.querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!.disabled = own.index >= own.total - 1;
      return;
    }
    const subject = this.stepperSubject(controller);
    stepper.hidden = subject === undefined;
    this.syncCanvasBarShown();
    if (!subject) {
      return;
    }
    const at = index ?? this.stepperIndex(subject);
    const step = subject.steps[at]!;
    writeText(this.root.querySelector<HTMLElement>("[data-stepper-text]")!, this.words.text("canvas.stepper", { n: at + 1, total: subject.steps.length, label: step.label || step.id }));
    stepper.querySelector<HTMLButtonElement>('[data-stepper-go="-1"]')!.disabled = at === 0;
    stepper.querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!.disabled = at >= subject.steps.length - 1;
  }

  /** Previous or next: the preview opens that step (as its indicator would), the selection stays. */
  private goStep(delta: number): void {
    const controller = this.sheetController();
    const own = controller?.canvasStepper();
    if (own) {
      own.go(delta < 0 ? -1 : 1);
      return;
    }
    const subject = controller ? this.stepperSubject(controller) : undefined;
    if (!controller || !subject) {
      return;
    }
    const next = Math.min(Math.max(this.stepperIndex(subject) + delta, 0), subject.steps.length - 1);
    this.stepperAt.set(subject.id, next);
    this.rendererEl?.revealComponent(subject.steps[next]!.id);
    this.syncStepper(controller, next);
  }

  /**
   * Edit mode: every focusable thing in the fields' own markup leaves the Tab
   * order, so the canvas is one Tab stop and the arrow keys walk the components; the pointer is
   * kept off the controls by CSS. Preview puts them all back. Run after every repaint of the preview.
   */
  private applyEditInertness(): void {
    const root = this.rendererEl?.shadowRoot;
    if (!root) {
      return;
    }
    if (this.previewingValue) {
      for (const element of root.querySelectorAll<HTMLElement>("[data-db-inert]")) {
        const before = element.dataset.dbInert;
        if (before === "") {
          element.removeAttribute("tabindex");
        } else if (before !== undefined) {
          element.setAttribute("tabindex", before);
        }
        element.removeAttribute("data-db-inert");
      }
      return;
    }
    // A journey step's heading and buttons are in a box of the step's own (REGION_BOX), not a
    // component's: taken out of the Tab order the same way.
    for (const element of root.querySelectorAll<HTMLElement>(`.db-node, ${REGION_BOX}`)) {
      for (const focusable of element.querySelectorAll<HTMLElement>(FIELD_FOCUSABLES)) {
        if (focusable.closest(".db-handle")) {
          continue;
        }
        // A binding that binds `tabindex` (a tab list's roving stop) writes it again on a
        // redraw: what it wrote is the value preview restores, and it leaves the Tab order
        // again. An element already out of it is left as it is.
        const current = focusable.getAttribute("tabindex");
        if (focusable.hasAttribute("data-db-inert") && current === "-1") {
          continue;
        }
        focusable.setAttribute("data-db-inert", current ?? "");
        focusable.setAttribute("tabindex", "-1");
      }
    }
  }

  /**
   * Marks the drop zones on what was just drawn: where the binding drew each slot's
   * components, an empty slot's own zone, the root's. Only while editing: the form previewed or
   * tried is a person's, and takes no drops.
   */
  private markZones(): void {
    const root = this.rendererEl?.shadowRoot;
    const controller = this.sheetController();
    if (!root || !controller) {
      return;
    }
    const prompt = this.root.querySelector<HTMLElement>("[data-canvas-empty-root]");
    if (this.previewingValue || this.rendererEl?.canvasHooks === undefined) {
      for (const element of root.querySelectorAll<HTMLElement>("[data-db-zone]")) {
        for (const name of ["data-dropzone", "data-parent-id", "data-slot-id", "data-axis", "data-db-zone", "data-db-root"]) {
          element.removeAttribute(name);
        }
      }
      if (prompt) {
        prompt.hidden = true;
      }
      return;
    }
    const view = controller.canvasTreeView();
    markDropZones(root, view);
    // A form with nothing in it draws nothing: the canvas says where the first component goes,
    // in the root's own words for its slot (a journey's, a PDF document's) when it has some.
    // A drop anywhere on the sheet lands in the root's zone. A form holding only the Submit button
    // a new form starts with is as good as empty: the prompt stays until something else is placed.
    if (prompt) {
      const primary = view.slots[0]?.slotId;
      const children = view.slots.flatMap((slot) => slot.children);
      const startingOnly = view.type === "form" && children.length === 1 && isStarterSubmitButton(children[0]!.node);
      const empty = (children.length === 0 || startingOnly) && root.querySelector(`[data-dropzone]:not([data-db-zone])[data-parent-id="${view.id.replace(/["\\]/g, "\\$&")}"]`) === null;
      // A blank hint says nothing (a journey's Check answers or exit step, which asks no field): no prompt.
      const text = empty ? ((primary !== undefined ? slotEmptyHintsByComponent(view).get(view.id)?.get(primary) : undefined) ?? this.words.text("canvas.dropRoot")) : "";
      prompt.hidden = !empty || text === "";
      if (empty && text !== "") {
        writeText(prompt, text);
      }
    }
  }

  /**
   * The sheet in the form's own page colour (see .canvas-surface): the binding's surface lands
   * on the drawn form inside the renderer's shadow root, so it is read off there after a draw.
   * A transparent form (Datum's light look) leaves the sheet its own white.
   */
  private syncSheetColour(): void {
    const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
    const form = this.rendererEl?.shadowRoot?.querySelector("form");
    if (!surface) {
      return;
    }
    const colour = form && typeof getComputedStyle === "function" ? getComputedStyle(form).backgroundColor.trim() : "";
    const painted = colour !== "" && !colour.includes("var(") && colour !== "transparent" && !/^rgba\([^)]*,\s*0\)$/.test(colour);
    if (painted) {
      surface.style.setProperty("--db-sheet-bg", colour);
    } else {
      surface.style.removeProperty("--db-sheet-bg");
    }
  }

  /**
   * Wakes the inspector when the draw that just landed moved how the selection is drawn: its
   * adapter (the first draw of a component just added, a binding picked) or what the binding
   * answers for its type. Said once per change, so a draw that moved nothing repaints nothing.
   */
  private syncDrawing(controller: BuilderController): void {
    const id = controller.selectedComponentId();
    const drawn = controller.drawingOf(id);
    const signal = JSON.stringify([controller.drawnByLine(id) ?? null, drawn?.answers ?? null]);
    if (signal !== this.drawingSignal) {
      this.drawingSignal = signal;
      controller.drawingChanged();
    }
  }

  private queueEditInertness(): void {
    if (this.inertQueued) {
      return;
    }
    this.inertQueued = true;
    queueMicrotask(() => {
      this.inertQueued = false;
      this.applyEditInertness();
      this.markZones();
      this.syncSheetColour();
      const controller = this.sheetController();
      if (controller) {
        this.syncStepper(controller);
        this.syncDrawing(controller);
      }
    });
  }

  /** The selection bar's and the keyboard's actions on the selected component. */
  /**
   * The selection bar's actions by name (`up`, `down`, `duplicate`, `logic`, `delete`), for the
   * command palette: the same guarded paths, Delete's confirmation included.
   */
  public runAction(action: "up" | "down" | "move" | "duplicate" | "logic" | "delete"): void {
    this.runSelectionAction(action);
  }

  /** See {@link selectionGuard}. */
  private selectionGuardValue: ((run: () => void) => boolean) | undefined;

  /**
   * What the canvas asks before a request that takes the selection out of the inspector's sight
   *: another selection (a click, a region's click, the keyboard walk, Escape, a click on
   * empty canvas), a removal, Move to.... The shell sets it while the mode on the page inspects
   * on another controller than the canvas's (a form field placed on a journey step, edited on the
   * form's controller): `run` then waits for that component's unsaved edits to be answered in the
   * inspector, which the canvas's own controller knows nothing of. Answers whether `run` ran now.
   * Unset (the Form canvas, a canvas used on its own): every request runs at once, as always.
   * Setting it paints nothing.
   */
  public get selectionGuard(): ((run: () => void) => boolean) | undefined {
    return this.selectionGuardValue;
  }

  public set selectionGuard(value: ((run: () => void) => boolean) | undefined) {
    this.selectionGuardValue = value;
  }

  /** Runs `run` through {@link selectionGuard}, or at once without one. */
  private guarded(run: () => void): boolean {
    const guard = this.selectionGuardValue;
    if (!guard) {
      run();
      return true;
    }
    return guard(run);
  }

  /** See {@link deleteAction}. */
  private deleteActionValue: { componentId: string; label: string; run(): void } | undefined;
  /** Whether the bar's Delete button carries {@link deleteAction}'s words, to be put back when it goes. */
  private deleteRelabelled = false;

  /**
   * What the selection bar's Delete (and the Delete key) does for the selection named, when a
   * mode says so (`BuilderInspectorAction.deleteLabel`): "Take off this step" for a form
   * field placed on a journey step, run with no delete confirmation (it takes away a placement,
   * one undo step, nothing of the form). The shell sets it for the selection as it moves, `run`
   * already behind its guard. For any other selection, or unset, Delete is as always. Setting it
   * paints nothing: the bar's button is reworded in place.
   */
  public get deleteAction(): { componentId: string; label: string; run(): void } | undefined {
    return this.deleteActionValue;
  }

  public set deleteAction(value: { componentId: string; label: string; run(): void } | undefined) {
    this.deleteActionValue = value;
    this.syncDeleteLabel();
  }

  /** The Delete action for the selection now: the mode's (see {@link deleteAction}) when it names it. */
  private deleteActionFor(componentId: string | undefined): { label: string; run(): void } | undefined {
    const action = this.deleteActionValue;
    return action && componentId !== undefined && action.componentId === componentId ? action : undefined;
  }

  /** Words the bar's Delete as the mode's action for the selection, or puts its own words back. */
  private syncDeleteLabel(): void {
    const action = this.deleteActionFor(this.ctrl?.selectedComponentId());
    if (!action && !this.deleteRelabelled) {
      return;
    }
    const entry = SELECTION_ACTIONS.find((candidate) => candidate.id === "delete")!;
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-selection-action="delete"]')) {
      const label = action ? action.label : this.words.text(entry.label);
      button.setAttribute("aria-label", label);
      button.setAttribute("data-tip", action ? action.label : this.words.text(entry.tip ?? entry.label));
    }
    this.deleteRelabelled = action !== undefined;
  }

  private runSelectionAction(action: string): void {
    const controller = this.ctrl;
    const selected = controller?.selectedComponentId();
    if (!controller || selected === undefined || selected === controller.canvasRootId()) {
      return;
    }
    switch (action) {
      case "up":
        controller.requestMoveBy(selected, -1);
        return;
      case "down":
        controller.requestMoveBy(selected, 1);
        return;
      case "move":
        // Another place may be another container out of sight (another journey step): asked first.
        this.guarded(() => this.withMover((mover) => mover.openDialog(selected)));
        return;
      case "duplicate":
        controller.requestDuplicate(selected);
        return;
      case "logic":
        if (this.canvasFeaturesValue.logic) {
          this.dispatchEvent(new CustomEvent<{ componentId: string }>("canvas-add-logic", { detail: { componentId: selected }, bubbles: true, composed: true }));
        }
        return;
      case "delete": {
        // A mode's action standing in for Delete (a placement taken off its step) asks nothing more.
        const replaced = this.deleteActionFor(selected);
        if (replaced) {
          if (!controller.isFixedNode(selected)) {
            replaced.run();
          }
          return;
        }
        this.openDeleteConfirm(selected);
        return;
      }
    }
  }

  /** Delete asks first, with the inspector's own prompt (it names the subtree that goes with it). */
  private openDeleteConfirm(componentId: string): void {
    const controller = this.ctrl;
    const host = this.root.querySelector<HTMLElement>("[data-canvas-prompt]");
    const pending = controller && !controller.isFixedNode(componentId) ? describeDelete(controller, componentId, this.wordsFor(undefined)) : undefined;
    if (!host || !pending) {
      return;
    }
    host.innerHTML = deleteConfirmHtml(pending, this.wordsFor(undefined));
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    if (typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>("[data-confirm-cancel]")?.focus();
  }

  private closeDeleteConfirm(): void {
    const host = this.root.querySelector<HTMLElement>("[data-canvas-prompt]");
    const dialog = host?.querySelector<HTMLDialogElement>("dialog");
    if (!host || !dialog) {
      return;
    }
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    }
    host.innerHTML = "";
    this.root.querySelector<HTMLElement>(".canvas-page")?.focus();
  }

  /**
   * A choice field's "No options yet": the field is selected through the unsaved-edits
   * guard, the inspector opened as Enter opens it, and its options editor put up. A selection
   * the guard holds (its prompt is up) goes no further.
   */
  private editOptionsOf(componentId: string): void {
    const controller = this.ctrl;
    this.pendingEditOptions = undefined;
    if (!controller?.requestSelect(componentId)) {
      // Held by the unsaved prompt: once Apply or Discard lets the selection land on this
      // component, the options editor follows, so the author clicks the hint once.
      this.pendingEditOptions = componentId;
      return;
    }
    this.openOptionsEditorOn(componentId);
  }

  /** The component whose "No options yet" was clicked while the unsaved prompt held the selection. */
  private pendingEditOptions: string | undefined;

  protected override onSelectionChange(): void {
    super.onSelectionChange();
    const pending = this.pendingEditOptions;
    if (pending === undefined) {
      return;
    }
    this.pendingEditOptions = undefined;
    // Only the selection the click asked for; any other (Keep editing, another click) drops it.
    // A microtask on: the inspector hears the same selection and takes its subject first.
    if (this.ctrl?.selectedComponentId() === pending) {
      queueMicrotask(() => this.openOptionsEditorOn(pending));
    }
  }

  private openOptionsEditorOn(componentId: string): void {
    this.dispatchEvent(new CustomEvent("canvas-edit-selection", { bubbles: true, composed: true }));
    const scope = this.getRootNode() as ParentNode;
    (scope.querySelector?.(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement | null | undefined)?.editOptions(componentId);
  }

  // --- Move to... and the keyboard move mode ----------------------------------------

  /**
   * The mover, once its chunk is in: `run` gets it then. A load that fails is forgotten (the
   * module's memo retries), and the canvas is as it was; nothing is said for a key press.
   */
  private withMover(run: (mover: CanvasMoveType) => void): void {
    if (this.mover) {
      run(this.mover);
      return;
    }
    void loadMoveUi().then(
      (module) => {
        this.mover ??= new module.CanvasMove(this.moverHost());
        run(this.mover);
      },
      (error: unknown) => console.warn("datum-builder: the Move to… chunk did not load.", error)
    );
  }

  /** What the mover borrows from the canvas: its controller, roots, words and the drag's marker. */
  private moverHost(): CanvasMoveHost {
    return {
      controller: () => this.ctrl,
      root: this.root,
      previewRoot: () => this.previewRoot(),
      words: () => this.words,
      announce: (text) => this.announce(text),
      revealComponent: (componentId) => this.rendererEl?.revealComponent(componentId),
      showMarker: (zone, before) => {
        if (this.activeZone && this.activeZone !== zone) {
          this.activeZone.removeAttribute("data-db-drag-over");
        }
        this.activeZone = zone;
        zone.setAttribute("data-db-drag-over", "");
        const marker = this.ensureMarker();
        placeMarker(marker, zone, before, undefined, zone.dataset.axis === "horizontal" ? "horizontal" : "vertical");
        return marker;
      },
      clearMarker: () => this.clearDropIndicator(),
      focusCanvas: () => this.root.querySelector<HTMLElement>(".canvas-page")?.focus(),
      rtl: () => getComputedStyle(this).direction === "rtl"
    };
  }

  /** Arrow keys walk the components in reading order; the selection says where it landed. */
  private stepSelection(to: "next" | "previous" | "first" | "last" | "in" | "out"): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const view = controller.canvasTreeView();
    // A root whose own chrome is drawn (a journey step's heading and buttons) is a stop too, the
    // first: where its heading sits. Every other root is reached from the strip, not the walk.
    const owner = controller.canvasRegionOwner();
    const ownsChrome = owner !== undefined && owner.id === view.id;
    const order = ownsChrome ? [view, ...readingOrder(view)] : readingOrder(view);
    if (order.length === 0) {
      return;
    }
    const at = order.findIndex((entry) => entry.id === controller.selectedComponentId());
    let index: number;
    if (to === "in" || to === "out") {
      const current = order[at];
      if (!current) {
        index = 0;
      } else if (to === "in") {
        const first = current.slots.find((slot) => slot.children.length > 0)?.children[0];
        index = first ? order.findIndex((entry) => entry.id === first.id) : -1;
      } else {
        const parent = controller.parentOf(current.id)?.parentId;
        index = parent === undefined ? -1 : order.findIndex((entry) => entry.id === parent);
      }
      if (index < 0) {
        return;
      }
    } else {
      index =
        to === "first" ? 0 : to === "last" ? order.length - 1 : at < 0 ? 0 : Math.min(order.length - 1, Math.max(0, at + (to === "next" ? 1 : -1)));
    }
    const target = order[index]!;
    const go = (): void => {
      if (controller.requestSelect(target.id)) {
        const announce = this.root.querySelector<HTMLElement>("[data-canvas-announce]");
        if (announce) {
          // The root that owns its chrome is said as its chrome is named.
          const label = ownsChrome && target === view ? owner.label : target.label || target.id;
          announce.textContent = this.words.text("canvas.position", { label, type: target.type, n: index + 1, total: order.length });
        }
      }
    };
    // Through the inspector's guard when it edits on another controller.
    if (target.id === controller.selectedComponentId()) {
      go();
    } else {
      this.guarded(go);
    }
  }

  /**
   * Selects `componentId` from a click: through the controller's own guard, and first through
   * {@link selectionGuard} when the selection moves. The component already selected is
   * selected again at once, as the controller does.
   */
  private selectAway(componentId: string | undefined, before?: () => void): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (componentId === controller.selectedComponentId()) {
      before?.();
      controller.requestSelect(componentId);
      return;
    }
    this.guarded(() => {
      before?.();
      controller.requestSelect(componentId);
    });
  }

  /**
   * Shows a mode's surface in the sheet's place — a populated PDF's pages — or,
   * with `undefined`, the sheet again. The page around it keeps scrolling; the panels beside
   * the canvas stay where they are.
   */
  /**
   * Puts a mode's surface (a PDF's pages) in place of the sheet, with the mode's
   * stylesheet beside it: the surface lands inside this panel's shadow root, which the
   * shell's own copy of that stylesheet does not reach.
   */
  public showSurface(surface: HTMLElement | undefined, styles?: string, options?: CanvasSurfaceOptions): void {
    const changed = surface !== this.surfaceEl;
    const left = changed && surface === undefined;
    this.surfaceEl = surface;
    this.surfaceStyles = surface ? styles : undefined;
    // A surface is neither zoomable by the bar's tools nor tryable unless it says so.
    this.surfaceShown = surface ? { zoom: options?.zoom, zoomable: options?.zoomable ?? false, tryable: options?.tryable ?? false, selectionBar: options?.selectionBar ?? true } : undefined;
    if (this.previewingValue && this.surfaceShown && !this.surfaceShown.tryable) {
      // Nothing to try on this surface: trying ends first, so Back to editing never hides.
      this.previewing = false;
    }
    if (changed) {
      // Another surface starts at its own size, and its viewer is told so: each keeps a factor of its own.
      this.zoomValue = 1;
      if (left) {
        this.zoomChosen = false;
      }
      this.surfaceShown?.zoom?.("fit");
    }
    this.syncSurface();
    if (this.ctrl) {
      this.syncCanvasChrome(this.ctrl);
    }
    // The sheet again: a paper wider than the canvas opens fitted.
    if (left) {
      this.fitIfOverflowing();
    }
  }

  /** The surface on the canvas right now, if a mode put one there. */
  public surface(): HTMLElement | undefined {
    return this.surfaceEl;
  }

  private syncSurface(): void {
    const page = this.root.querySelector<HTMLElement>(".canvas-page");
    const host = this.root.querySelector<HTMLElement>("[data-canvas-surface]");
    if (!page || !host) {
      return;
    }
    const surface = this.surfaceEl;
    if (surface && this.tryingForm()) {
      // The form is tried in the surface's place: the surface stays put, out of sight, to come back as it was.
      host.hidden = true;
      page.toggleAttribute("data-surface", false);
      this.applyZoom();
      return;
    }
    if (surface) {
      let style = host.querySelector<HTMLStyleElement>("style[data-surface-styles]");
      if (this.surfaceStyles === undefined) {
        style?.remove();
        style = null;
      } else {
        if (!style) {
          style = document.createElement("style");
          style.setAttribute("data-surface-styles", "");
        }
        if (style.textContent !== this.surfaceStyles) {
          style.textContent = this.surfaceStyles;
        }
      }
      if (surface.parentElement !== host || (style && style.parentElement !== host)) {
        host.replaceChildren(...(style ? [style] : []), surface);
      }
      host.hidden = false;
      page.toggleAttribute("data-surface", true);
      this.applyZoom();
      return;
    }
    host.replaceChildren();
    host.hidden = true;
    page.toggleAttribute("data-surface", false);
    this.applyZoom();
  }

  /**
   * The hooks last built and what they were built from: the selection, the slots each
   * component declares, the empty slots' hints and the icon set. A change that leaves all four
   * as they were (a commit of a label the canvas already previewed) reuses them, so the preview
   * is not repainted for decoration that did not move.
   */
  private hooksMemo: { key: string; icons: unknown; hooks: ReturnType<typeof buildCanvasHooks> } | undefined;

  /** The page chrome's owner as the last hooks build read it (`canvasRegionOwner`): the name its boxes are drawn with. */
  private regionOwnerNow: CanvasRegionOwner | undefined;

  /** The binding last laid over with a tree's own types, and what it was made from: a new one would mount the form again. */
  private extendedBinding: { base: LiveBinding; components: object | undefined; drawing: ComponentDrawing | undefined; binding: LiveBinding } | undefined;

  /**
   * What the canvas's form element draws with: the controller's binding under the builder's
   * scheme (a binding, a registered id, or `undefined` for Datum's), with the component
   * definitions' own types laid over it (`ComponentDefinition.adapter`, `componentDrawing`) and
   * the tree's own types (`canvasComponents`, a designer's) over those. The same object while
   * none of that changes, since the element mounts the form again for a new one.
   */
  private canvasBindingOf(controller: BuilderController): LiveBinding | string | undefined {
    const chosen = controller.canvasBinding();
    const components = controller.canvasComponents();
    const drawing = controller.componentDrawing({ lit, datum: canvasDatumBinding() });
    if (!components && !drawing) {
      return chosen;
    }
    const base = chosen === undefined ? canvasDatumBinding() : typeof chosen === "string" ? (bindingById(chosen) ?? canvasDatumBinding()) : chosen;
    const memo = this.extendedBinding;
    if (memo && memo.base === base && memo.components === components && memo.drawing === drawing) {
      return memo.binding;
    }
    const laid = withComponentDrawing(base, drawing);
    const binding = components ? extendBinding(laid, { components }) : laid;
    this.extendedBinding = { base, components, drawing, binding };
    return binding;
  }

  /** The builder's words (the text catalog) for this panel's own chrome. */
  private readonly words = new BuilderWords();

  /** The builder's own language for its words (the text catalog's locale), not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.onWordsChanged();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.onWordsChanged();
    }
  }

  /** The words options: the builder's own locale and catalog when the host set them, else the form's locale. */
  private wordsFor(fallbackLocale: string | undefined): BuilderTextOptions {
    const locale = this.words.locale ?? fallbackLocale;
    return {
      ...(locale !== undefined ? { locale } : {}),
      ...(this.words.catalog ? { catalog: this.words.catalog } : {})
    };
  }

  /**
   * The shell is built once, so a change of the builder's words relabels its static controls in
   * place (the dynamic ones, such as the zoom readout and the selection bar, are written again
   * by the next sync) and repaints the preview for the words the chrome draws inside it.
   */
  private onWordsChanged(): void {
    this.hooksMemo = undefined;
    if (this.rendererEl) {
      this.relabelShell();
    }
    this.paint();
  }

  private relabelShell(): void {
    const set = (selector: string, labels: { text?: BuilderTextKey; aria?: BuilderTextKey; tip?: BuilderTextKey; title?: BuilderTextKey }): void => {
      for (const element of this.root.querySelectorAll<HTMLElement>(selector)) {
        if (labels.text) {
          element.textContent = this.words.text(labels.text);
        }
        if (labels.aria) {
          element.setAttribute("aria-label", this.words.text(labels.aria));
        }
        if (labels.tip) {
          element.setAttribute("data-tip", this.words.text(labels.tip));
        }
        if (labels.title) {
          element.setAttribute("title", this.words.text(labels.title));
        }
      }
    };
    set("#canvas-keys", { text: "canvas.keys" });
    set("[data-canvas-bar]", { aria: "canvas.bar" });
    set('[data-stepper-go="-1"]', { aria: "canvas.stepPrev", tip: "canvas.stepPrev" });
    set('[data-stepper-go="1"]', { aria: "canvas.stepNext", tip: "canvas.stepNext" });
    set("[data-previewing-note]", { text: "canvas.previewing" });
    set("[data-canvas-devices]", { aria: "canvas.previewWidth" });
    for (const device of DEVICE_WIDTHS) {
      set(`[data-device-width="${device.width}"]`, { aria: device.label, tip: device.label });
    }
    set("[data-canvas-zoom]", { aria: "canvas.zoom" });
    set('[data-canvas-zoom-go="out"]', { aria: "canvas.zoomOut", tip: "canvas.zoomOutTip" });
    set('[data-canvas-zoom-go="in"]', { aria: "canvas.zoomIn", tip: "canvas.zoomInTip" });
    set('[data-canvas-zoom-go="fit"]', { text: "canvas.fit", aria: "canvas.fitLabel", tip: "canvas.fitTip" });
    set('[data-canvas-zoom-go="actual"]', { tip: "canvas.actualTip" });
    set(".canvas-page", { aria: "canvas.page" });
    set("[data-sheet-grip]", { title: "canvas.gripTitle" });
    set("[data-selection-edit]", { aria: "canvas.edit", tip: "canvas.editTip" });
    for (const action of SELECTION_ACTIONS) {
      for (const button of this.root.querySelectorAll<HTMLElement>(`[data-selection-action="${action.id}"]`)) {
        button.setAttribute("aria-label", this.words.text(action.label));
        button.setAttribute("data-tip", this.words.text(action.tip ?? action.label));
      }
    }
    set("[data-try-panel]", { aria: "canvas.tryIt" });
  }

  private buildHooks(controller: BuilderController | undefined = this.ctrl): ReturnType<typeof buildCanvasHooks> {
    const view = controller?.canvasTreeView();
    const selectedId = controller?.selectedComponentId();
    const icons = this.iconSet();
    const declaredSlots = view ? declaredSlotsByComponent(view) : new Map<string, string[]>();
    const emptyHints = view ? slotEmptyHintsByComponent(view) : undefined;
    const rootId = controller?.canvasRootId();
    // A designer's own types draw live leaves (their fix-its answer a click).
    const liveTypes = Object.keys(controller?.canvasComponents() ?? {}).sort();
    // A step's decoration (canvas-hooks.ts): absent on every other canvas, whose key is as it was.
    const tags = controller?.canvasTags();
    const regionOwner = controller?.canvasRegionOwner();
    const partOf = controller?.canvasSelectTargets();
    const parts: unknown[] = [
      selectedId ?? null,
      rootId ?? null,
      [...declaredSlots],
      emptyHints ? [...emptyHints].map(([id, hints]) => [id, [...hints]]) : null,
      this.words.locale ?? null,
      liveTypes
    ];
    // The owner's name is read at each draw, not keyed: a step's title edit redraws its page
    // anyway, and a new hooks object on top of that would draw it twice.
    this.regionOwnerNow = regionOwner;
    if (tags || regionOwner || partOf) {
      parts.push(tags ? [...tags] : null, regionOwner?.id ?? null, partOf ? [...partOf] : null);
    }
    const key = JSON.stringify(parts);
    const memo = this.hooksMemo;
    if (memo && memo.key === key && memo.icons === icons) {
      return memo.hooks;
    }
    const hooks = buildCanvasHooks({
      selectedId,
      rootId,
      declaredSlots,
      ...(emptyHints ? { emptyHints } : {}),
      icons,
      words: this.wordsFor(undefined),
      ...(liveTypes.length > 0 ? { liveTypes: new Set(liveTypes) } : {}),
      ...(tags ? { tags } : {}),
      ...(regionOwner ? { regionOwner: { id: regionOwner.id, label: () => this.regionOwnerNow?.label ?? regionOwner.label } } : {}),
      ...(partOf ? { partOf } : {})
    });
    this.hooksMemo = { key, icons, hooks };
    return hooks;
  }



  /**
   * The shell is built once, so a new icon set repaints the toolbar's glyph slots in place
   * (the show-hidden toggle's with the state it shows), refreshes the set's CSS here and in the
   * renderer, and repaints the preview for the drag grips it draws.
   */
  protected override onIconsChange(): void {
    if (!this.rendererEl) {
      this.paint();
      return;
    }
    const icons = this.iconSet();
    const style = this.root.querySelector<HTMLStyleElement>("style[data-icon-css]");
    if (style) {
      style.textContent = icons.css ?? "";
    }
    this.rendererEl.extraStyles = CANVAS_CHROME_STYLES + CANVAS_HOOK_STYLES + (icons.css ?? "");
    this.paint();
  }

  /**
   * Whether a drag carries a builder payload. `dataTransfer.getData` is empty until `drop`
   * (the browser withholds a drag's data while it is in flight), but `types` is readable — so
   * this is the only way to tell one of our drags from a file or a text selection during
   * `dragover`, and it keeps the canvas from swallowing drags that are not ours.
   */
  private isBuilderDrag(transfer: DataTransfer | null): boolean {
    if (!transfer) {
      return false;
    }
    const types = transfer.types;
    return types ? Array.from(types).includes(BUILDER_DRAG_MIME_TYPE) : false;
  }

  /**
   * The root's own drop zone, used when a drag is over the canvas but no closer zone: the
   * first slot the root declares — a form's `content`, a PDF document's `body` — so a drop on
   * blank paper appends to the document. Taking the root's first zone in document order
   * instead put every such drop on the PDF sheet into the header band, which the page draws
   * first. That first zone remains the answer for a root whose slots the tree does not list.
   */
  private rootDropZone(): HTMLElement | undefined {
    const rootId = this.ctrl?.canvasRootId();
    if (!rootId) {
      return undefined;
    }
    const zones = [
      ...(this.rendererEl?.shadowRoot?.querySelectorAll<HTMLElement>("[data-dropzone]") ?? [])
    ].filter((zone) => zone.dataset.parentId === rootId);
    const primary = this.ctrl?.canvasTreeView().slots[0]?.slotId;
    return zones.find((zone) => zone.dataset.slotId === primary) ?? zones[0];
  }

  /**
   * Watches the renderer element's shadow root: edit-mode inertness and the remote-picture guard.
   * Runs for every renderer element the canvas creates (a no-controller render drops it and a
   * later render builds another), and again if the root was not there yet; the previous watchers go.
   */
  private watchRenderer(): void {
    const root = this.rendererEl?.shadowRoot ?? undefined;
    if (root === this.watchedRoot) {
      return;
    }
    this.inertWatch?.disconnect();
    this.inertWatch = undefined;
    this.remoteImageGuard?.();
    this.remoteImageGuard = undefined;
    this.watchedRoot = root;
    if (!root) {
      return;
    }
    // Edit mode keeps the fields out of the Tab order across every repaint of the preview.
    if (typeof MutationObserver === "function") {
      this.inertWatch = new MutationObserver(() => this.queueEditInertness());
      // `hidden` too: a step the form's own buttons open moves the stepper with it.
      this.inertWatch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    }
    this.queueEditInertness();
    // Pictures (and stylesheet urls) from another origin wait for one confirmation per load of
    // a document. The key is a token made when a document is
    // loaded, never the definition's own id, which its author chooses.
    this.remoteImageGuard = guardRemoteImages(root, {
      documentId: () => this.loadToken,
      words: () => ({ load: this.words.text("canvas.remoteLoad"), confirm: this.words.text("canvas.remoteConfirm") })
    });
  }

  /**
   * The listeners on the renderer element itself. Its own, unlike those on the shadow root: run
   * for every renderer the canvas creates, so a renderer built after a no-controller render has them too.
   */
  private bindRenderer(): void {
    const renderer = this.rendererEl;
    if (!renderer || renderer === this.boundRenderer) {
      return;
    }
    this.boundRenderer = renderer;
    // A previewed button reports intent like any other; on the canvas it does nothing, but for
    // Submit in Try it (a journey's own Submit included), which the stand-in server answers.
    renderer.addEventListener("datum-form-action", (event) => {
      event.stopPropagation();
      const detail = (event as CustomEvent<DatumFormActionDetail>).detail;
      const panel = this.root.querySelector<HTMLElement>("[data-try-panel]");
      if (this.previewingValue && detail?.action === "submit" && panel && !panel.hidden) {
        // Pressed before the chunk is in (a click straight after Try it): it runs once it is.
        // Not if the author left Try it meanwhile: a Submit queued on the load dies with the panel.
        void this.startTry().then((tryIt) => {
          const shown = this.root.querySelector<HTMLElement>("[data-try-panel]");
          if (tryIt && this.previewingValue && shown && !shown.hidden) {
            void tryIt.submit();
          }
        });
      }
    });
    // A language switcher the author placed in the form's own chrome previews on
    // the canvas like the rest of it; a pick there is the same choice as the toolbar's locale
    // select, so it goes the same way and the toolbar, inspector and canvas stay in step.
    renderer.addEventListener("datum-locale-applied", (event) => {
      event.stopPropagation();
      const locale = (event as CustomEvent<{ locale: string }>).detail?.locale;
      // Not while the form is tried over a designer: the switch is the tried form's own.
      if (locale && !this.tryingForm() && locale !== this.ctrl?.currentLocale()) {
        this.ctrl?.setOptions({ locale });
      }
    });
  }

  private bind(): void {
    this.watchRenderer();
    this.bindRenderer();
    if (this.bound) {
      return;
    }
    this.bound = true;

    this.root.addEventListener("click", (event) => {
      const path = event.composedPath() as HTMLElement[];
      // The click a pan ends on (the same press) moved the sheet; it is not a click on the canvas.
      if (this.panEndedAt >= 0 && event.timeStamp - this.panEndedAt < 400) {
        this.panEndedAt = -1;
        return;
      }
      // A narrow canvas folds the width and zoom buttons behind one; a click
      // anywhere else puts them away again.
      const more = this.root.querySelector<HTMLElement>("[data-canvas-more]");
      if (path.some((el) => el?.dataset?.canvasMore !== undefined)) {
        this.toggleCanvasMore(more?.getAttribute("aria-expanded") !== "true");
        return;
      }
      if (more?.getAttribute("aria-expanded") === "true") {
        // A click outside the card puts it away; a mode's action run from it too, focus back on the button.
        const action = path.some((el) => el?.dataset?.canvasActions !== undefined);
        if (action || !path.some((el) => el?.dataset?.canvasMorePop !== undefined)) {
          this.toggleCanvasMore(false, action);
        }
      }
      // The canvas bar and the selection bar.
      const device = path.find((el) => el?.dataset?.deviceWidth !== undefined);
      if (device) {
        const width = Number(device.dataset.deviceWidth);
        this.ctrl?.setPreviewWidth(this.ctrl.previewWidth() === width ? undefined : width);
        return;
      }
      if (path.some((el) => el?.dataset?.tryPanel !== undefined)) {
        this.onTryClick(path);
        return;
      }
      const zoomGo = path.find((el) => el?.dataset?.canvasZoomGo !== undefined);
      if (zoomGo) {
        const go = zoomGo.dataset.canvasZoomGo;
        this.zoomTo(go === "in" ? this.zoomValue * CANVAS_ZOOM_STEP : go === "out" ? this.zoomValue / CANVAS_ZOOM_STEP : go === "fit" ? "fit" : 1);
        return;
      }
      const stepperGo = path.find((el) => el?.dataset?.stepperGo !== undefined);
      if (stepperGo) {
        this.goStep(Number(stepperGo.dataset.stepperGo));
        return;
      }
      if (path.some((el) => el?.dataset?.tryIt !== undefined)) {
        // Try it's panel takes the inspector's place, so edits not applied there are asked about
        // first: a prompt in a drawer put away would go unseen. Back to editing asks nothing.
        if (this.previewingValue || !this.ctrl) {
          this.previewing = !this.previewingValue;
        } else {
          this.ctrl.requestLeave(() => {
            this.previewing = true;
          });
        }
        return;
      }
      const action = path.find((el) => el?.dataset?.selectionAction !== undefined);
      if (action) {
        this.runSelectionAction(action.dataset.selectionAction!);
        return;
      }
      // A phone's Edit: the inspector's sheet, on the selection.
      if (path.some((el) => el?.dataset?.selectionEdit !== undefined)) {
        this.dispatchEvent(new CustomEvent("canvas-edit-selection", { bubbles: true, composed: true }));
        return;
      }
      if (path.some((el) => el?.dataset?.confirmCancel !== undefined)) {
        this.closeDeleteConfirm();
        return;
      }
      const confirmDelete = path.find((el) => el?.dataset?.confirmDelete !== undefined);
      if (confirmDelete) {
        const id = confirmDelete.dataset.confirmDelete!;
        const cascade = removesReferences(confirmDelete.closest("dialog"));
        this.closeDeleteConfirm();
        const controller = this.ctrl;
        // Through the unsaved-edits guard, with the references when ticked as one
        // step. A draft of the component going (the selection deleted from its own bar) goes
        // with it, unasked; only a draft of something that stays holds the removal. The
        // inspector's guard first when it edits on another controller.
        this.guarded(() => {
          controller?.requestRemoveComponents([id], cascade ? { removeReferences: true } : {});
        });
        return;
      }
      // The Move to... dialog.
      if (path.some((el) => el?.dataset?.moveCancel !== undefined)) {
        this.mover?.closeDialog();
        return;
      }
      if (path.some((el) => el?.dataset?.moveConfirm !== undefined)) {
        this.mover?.confirmDialog();
        return;
      }
      if (path.some((el) => el?.dataset?.selectionBar !== undefined || el?.dataset?.canvasBar !== undefined || el?.tagName === "DIALOG")) {
        return;
      }
      // Preview: the form is the person's, clicks are theirs; nothing is selected.
      if (this.previewingValue) {
        if (path.some((el) => el?.tagName === "A")) {
          event.preventDefault();
        }
        return;
      }

      // The click a sheet-edge drag ends on is part of the resize, not a canvas click — it
      // must not clear the selection.
      if (path.some((el) => el?.dataset?.sheetGrip !== undefined)) {
        return;
      }
      // A mode's surface (a PDF's pages) selects for itself on pointer events; the
      // click that follows a drag on it is not a click on empty canvas, and must not put down
      // the area that drag just drew.
      if (path.some((el) => el?.dataset?.canvasSurface !== undefined)) {
        return;
      }
      // A journey step's heading, counter or buttons (the hooks' box around those regions,
      // whatever binding drew them): the step is selected, never the button pressed.
      const region = path.find((el) => el?.dataset?.dbRegionOwner !== undefined);
      if (region) {
        event.preventDefault();
        const owner = region.dataset.dbRegionOwner!;
        if (this.hasAttribute("data-phone") && owner === this.ctrl?.selectedComponentId()) {
          this.dispatchEvent(new CustomEvent("canvas-edit-selection", { bubbles: true, composed: true }));
          return;
        }
        // A press on the page's buttons says so first, so the inspector the selection brings up is
        // drawn open on their words: the actions region (the canvas's own mark, whatever binding
        // drew it), or a region holding a journey button (a binding that puts Back in the header).
        const buttons = region.dataset.dbRegion === "page-actions" || region.querySelector("[data-journey-continue], [data-journey-back]") !== null;
        const pressed = this.ctrl?.canvasRegionOwner();
        // A row of a Check answers step's list is in the heading's region: which row says what the step's Wording opens on.
        const row = buttons ? undefined : pressedReviewRow(region, path, event as MouseEvent);
        // Through the inspector's guard when it edits on another controller: Keep editing opens nothing.
        this.selectAway(owner, () => pressed?.onPress?.(buttons ? "buttons" : "heading", row));
        return;
      }

      // A container's own control — a tab, a step indicator entry, Continue or Back
      // — does what it does on the canvas: it shows that tab or step (the renderer has already
      // switched it), which is how an author reaches the drop zones of one not showing. Never a
      // selection. A field's controls are in its leaf (inert, or a designer's live face) and are
      // not the container's; nor is the canvas's own chrome (a grip, "No options yet").
      const containerControl = path.find(
        (el) =>
          el?.matches?.("button, a[href], summary, [role='tab']") === true &&
          el.closest?.(".db-node") !== null &&
          el.closest?.(".db-leaf, .db-handle") === null &&
          el.dataset?.noOptions === undefined
      );
      if (containerControl) {
        return;
      }

      // A previewed link must not navigate the host page; clicking it falls through to
      // select its component instead — the anchor analogue of swallowing
      // `datum-form-action` below.
      if (path.some((el) => el?.tagName === "A")) {
        event.preventDefault();
      }

      // Preview: the form is the person's, clicks are theirs; nothing is selected. In edit
      // anywhere on a field selects it, its own controls included: a field
      // is one click target, and Try it is where the author exercises their rules. The CSS
      // keeps the pointer off the controls; a click that reaches one anyway (a script's, a
      // label's forwarded click) does not tick, open or submit it.
      if (this.previewingValue) {
        return;
      }
      const control = event.composedPath()[0] as HTMLElement | undefined;
      if (control?.closest?.(".db-node") && control.matches?.(EDIT_INERT_CONTROLS)) {
        event.preventDefault();
      }
      /*
       * The nearest component box, walking out from the click. Clicking inside a container
       * still selects the container: its own box is on the path, since a container's children
       * render inside it.
       *
       * A click that lands on none — the form's own background, the canvas around the sheet —
       * puts everything down: the selection, and with it the inspector, and the open side
       * panel (canvas-background, which the shell answers). Unsaved edits are asked about
       * first, the root's too, since the panel going away may be the Form panel.
       */
      // A choice field's "No options yet": its options editor, on it.
      const noOptions = path.find((el) => el?.dataset?.noOptions !== undefined);
      if (noOptions) {
        this.editOptionsOf(noOptions.dataset.noOptions!);
        return;
      }
      const node = path.find((el) => el?.classList?.contains?.("db-node"));
      if (node) {
        // A part of another's box (a field inside a placed form container) has no box of its
        // own, so the box found is the one around it; an id drawn as a part is still read as the
        // box it is part of.
        const drawnId = node.dataset.componentId;
        const id = drawnId !== undefined ? (this.ctrl?.canvasSelectTargets()?.get(drawnId) ?? drawnId) : undefined;
        // A phone: a tap on the component already selected opens its settings.
        if (this.hasAttribute("data-phone") && id !== undefined && id === this.ctrl?.selectedComponentId()) {
          this.dispatchEvent(new CustomEvent("canvas-edit-selection", { bubbles: true, composed: true }));
          return;
        }
        // Asks first when the selection has unsaved edits — the prompt shows in the
        // properties panel, where Apply and Discard live; so does the inspector's guard when it
        // edits on another controller.
        this.selectAway(id);
        return;
      }
      const controller = this.ctrl;
      if (!controller) {
        return;
      }
      controller.requestLeave(() => {
        controller.select(undefined);
        this.dispatchEvent(new CustomEvent("canvas-background", { bubbles: true, composed: true }));
      });
    });

    // Moving the sheet (the hand): a drag that starts on empty canvas, or any middle-button
    // drag. On the sheet, only where nothing is: a component's press is its own (select, drag
    // to move), a grip's is a resize, a mode's surface draws, and in Try it the form is the
    // person's. Window-level listeners for the drag's duration, as the grips do.
    this.root.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      const page = this.root.querySelector<HTMLElement>(".canvas-page");
      const path = pointer.composedPath() as HTMLElement[];
      if (!page || !path.includes(page) || page.hasAttribute("data-surface") || this.panDrag) {
        return;
      }
      // On a phone a finger scrolls the page: the hand is the mouse's alone.
      if (this.hasAttribute("data-phone") && pointer.pointerType !== "mouse") {
        return;
      }
      if (pointer.button === 0) {
        const busy = path.some(
          (el) =>
            el?.classList?.contains?.("db-node") ||
            el?.dataset?.dbRegionOwner !== undefined ||
            el?.dataset?.sheetGrip !== undefined ||
            el?.dataset?.canvasSurface !== undefined ||
            el?.dataset?.dropError !== undefined ||
            (this.previewingValue && el?.classList?.contains?.("canvas-surface"))
        );
        if (busy) {
          return;
        }
      } else if (pointer.button === 1) {
        // The browser's own middle-button scrolling would fight the pan.
        pointer.preventDefault();
      } else {
        return;
      }
      this.panDrag = { pointerId: pointer.pointerId, startX: pointer.clientX, startY: pointer.clientY, originX: this.panX, originY: this.panY, moved: false, range: undefined };
      window.addEventListener("pointermove", this.onPanMove);
      window.addEventListener("pointerup", this.onPanEnd);
      window.addEventListener("pointercancel", this.onPanEnd);
    });

    // A phone's pinch: two fingers zoom a page that fixes its own width (a PDF
    // layout's); the form's own canvas is the phone's width and scrolls, so it has none.
    let pinch: { distance: number; zoom: number } | undefined;
    const spread = (touches: TouchList): number => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    this.root.addEventListener(
      "touchstart",
      (event) => {
        const touch = event as TouchEvent;
        if (touch.touches.length === 2 && this.hasAttribute("data-phone") && this.sheetController()?.sheetWidth() !== undefined) {
          pinch = { distance: spread(touch.touches), zoom: this.zoomValue };
        }
      },
      { passive: true }
    );
    this.root.addEventListener(
      "touchmove",
      (event) => {
        const touch = event as TouchEvent;
        if (!pinch || touch.touches.length !== 2) {
          return;
        }
        touch.preventDefault();
        const distance = spread(touch.touches);
        if (pinch.distance > 0) {
          this.zoomTo(pinch.zoom * (distance / pinch.distance));
        }
      },
      { passive: false }
    );
    const endPinch = (event: Event): void => {
      if ((event as TouchEvent).touches.length < 2) {
        pinch = undefined;
      }
    };
    this.root.addEventListener("touchend", endPinch);
    this.root.addEventListener("touchcancel", endPinch);

    // Custom preview width: drag either edge of the sheet. Window-level move/up listeners
    // are attached only for the drag's duration.
    this.root.addEventListener("mousedown", (event) => {
      const grip = (event.target as HTMLElement)?.dataset?.sheetGrip;
      if (grip !== "left" && grip !== "right") {
        return;
      }
      const surface = this.root.querySelector<HTMLElement>(".canvas-surface");
      // The grips are hidden while the tree fixes the width; a stray hit on one must not
      // start a drag the sheet would not honour. The tree is the sheet's: the tried form's over a mode's.
      if (!surface || this.sheetController()?.sheetWidth() !== undefined) {
        return;
      }
      this.sheetDrag = {
        edge: grip,
        startX: (event as MouseEvent).clientX,
        startW: surface.getBoundingClientRect().width / this.zoomValue
      };
      event.preventDefault();
      window.addEventListener("mousemove", this.onSheetDrag);
      window.addEventListener("mouseup", this.onSheetDragEnd);
    });

    this.root.addEventListener("dragstart", (event) => {
      const dragEvent = event as DragEvent;
      const path = dragEvent.composedPath() as HTMLElement[];
      const handle = path.find((el) => el?.dataset?.dbHandle !== undefined);
      const componentId = handle?.dataset.dbHandle;
      const node = path.find((el) => el?.classList?.contains?.("db-node"));
      if (!dragEvent.dataTransfer || !componentId) {
        return;
      }
      writeDragPayload(dragEvent.dataTransfer, { kind: "existing-component", componentId });
      dragEvent.dataTransfer.effectAllowed = "move";
      // Drag the whole field, not the grip that started it.
      if (node && typeof dragEvent.dataTransfer.setDragImage === "function") {
        dragEvent.dataTransfer.setDragImage(node, 12, 12);
      }
      /*
       * Deferred: `.db-dragging` hides the grip (the drag *source*), and Chromium aborts a
       * drag whose source leaves the render tree while `dragstart` is still dispatching —
       * the class must land only after the browser has actually begun the drag.
       */
      this.dragSourceNode = node;
      setTimeout(() => this.dragSourceNode?.classList.add("db-dragging"), 0);
    });

    this.root.addEventListener("dragover", (event) => {
      const dragEvent = event as DragEvent;
      const transfer = dragEvent.dataTransfer;
      const path = dragEvent.composedPath() as HTMLElement[];
      if (!this.isBuilderDrag(transfer)) {
        return;
      }

      /*
       * Accept the drag across the whole canvas, not only over a drop zone.
       *
       * A `dragover` that does not `preventDefault()` means "cannot drop here", and the
       * browser answers by swapping the copy badge for the no-entry cursor. The gaps between
       * fields, the form's own padding and the panel's margin are all outside any zone, so a
       * palette drag would lose its "+" the instant it entered the canvas. Falling back to
       * the form's own drop zone keeps the badge for the whole drag and makes a drop onto the
       * canvas background append to the form, which is what the gesture looks like it does.
       *
       * Where it lands is `dropZoneOnPath`'s answer — the nearest zone on the path, else the
       * one zone a container's own chrome wraps (a PDF band's label, a tab panel's padding, a
       * group's legend) — and, over the canvas background, the root's primary slot.
       */
      const overSurface = path.some(
        (el) =>
          el?.classList?.contains?.("canvas-surface") === true ||
          // The page around the sheet counts too: a drop aimed just below the last field
          // lands on the page, and it plainly means "put it at the end of the form".
          el?.classList?.contains?.("canvas-page") === true
      );
      const zone = dropZoneOnPath(path) ?? (overSurface ? this.rootDropZone() : undefined);
      if (!zone) {
        // Over the panel's own chrome. The wrapper keeps the drag alive (and the badge with
        // it); there is just nowhere here to show an insertion point.
        this.clearDropIndicator();
        return;
      }
      dragEvent.preventDefault();
      if (transfer) {
        // Echo back what the source declared: "copy" for a palette template (so the green "+"
        // shows), "move" for a component already on the canvas.
        transfer.dropEffect = transfer.effectAllowed === "copy" ? "copy" : "move";
      }

      // The components drawn in the zone, wherever the binding put them (a list item, a table
      // cell): the pointer's place among them, counted in the slot as the tree has it.
      // Read off the tree once per zone the drag is over, not on every dragover.
      const view = this.dragPlaces === undefined ? this.ctrl?.canvasTreeView() : undefined;
      const places = (this.dragPlaces ??= view ? slotPlaces(view) : new Map<string, number>());
      const { index, before, after, axis } = zoneInsertion(zone, { x: dragEvent.clientX, y: dragEvent.clientY }, (id) => places.get(id));

      if (this.activeZone && this.activeZone !== zone) {
        this.activeZone.removeAttribute("data-db-drag-over");
      }
      this.activeZone = zone;
      zone.setAttribute("data-db-drag-over", "");

      placeMarker(this.ensureMarker(), zone, before, after, axis);

      this.dropTarget = {
        parentId: zone.dataset.parentId || "root",
        slotId: zone.dataset.slotId || "content",
        index
      };
    });

    this.root.addEventListener("dragleave", (event) => {
      // Only clear when the pointer actually left the panel, not on inner boundaries.
      const related = (event as DragEvent).relatedTarget as Node | null;
      if (!related || !this.root.contains(related)) {
        this.clearDropIndicator();
      }
    });

    this.root.addEventListener("dragend", () => {
      this.clearDragging();
      this.clearDropIndicator();
    });

    this.root.addEventListener("drop", (event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      const target = this.dropTarget;
      this.clearDragging();
      this.clearDropIndicator();
      if (!dragEvent.dataTransfer || !this.ctrl || !target) {
        return;
      }
      this.ctrl.applyDrop(dragEvent.dataTransfer, target.parentId, target.slotId, target.index);
    });

    this.root.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      // The keyboard move mode has every key while it is on.
      if (this.mover?.active) {
        this.mover.key(keyEvent);
        return;
      }
      const undoKey = (keyEvent.metaKey || keyEvent.ctrlKey) && (keyEvent.key.toLowerCase() === "z" || keyEvent.key.toLowerCase() === "y");
      // In a field of the form being tried, undo is the field's own, never the builder's.
      if (undoKey && this.previewingValue && this.rendererEl && keyEvent.composedPath().includes(this.rendererEl)) {
        keyEvent.stopPropagation();
        return;
      }
      if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key.toLowerCase() === "z") {
        keyEvent.preventDefault();
        this.stepHistory(keyEvent.shiftKey ? "redo" : "undo");
        return;
      }
      // Escape puts the folded width and zoom buttons away, focus back on the button that opened them.
      if (keyEvent.key === "Escape" && this.root.querySelector("[data-canvas-more]")?.getAttribute("aria-expanded") === "true") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        this.toggleCanvasMore(false, true);
        return;
      }
      // The selection bar is one Tab stop, its arrows roved by rovingToolbar; Escape goes back to the canvas.
      const inBar = (keyEvent.composedPath() as HTMLElement[]).some((el) => el?.dataset?.selectionBar !== undefined);
      if (inBar && keyEvent.key === "Escape") {
        this.root.querySelector<HTMLElement>(".canvas-page")?.focus();
        return;
      }
      // The canvas's own keys, on the canvas itself, in edit mode.
      // The canvas's Tab stop is its scrolling page, so Page Up, Page Down and Space scroll it.
      const onCanvas = (keyEvent.composedPath()[0] as HTMLElement | undefined)?.classList?.contains("canvas-page");
      if (!onCanvas || this.previewingValue) {
        return;
      }
      const key = keyEvent.key;
      // Zoom, as on the journey map: + and - step, 0 fits the whole form.
      if (!keyEvent.altKey && !keyEvent.metaKey && !keyEvent.ctrlKey && ["+", "=", "-", "_", "0"].includes(key)) {
        keyEvent.preventDefault();
        this.zoomTo(key === "0" ? "fit" : key === "-" || key === "_" ? this.zoomValue / CANVAS_ZOOM_STEP : this.zoomValue * CANVAS_ZOOM_STEP);
        return;
      }
      // Shift with an arrow moves the sheet, as a drag on empty canvas does; 0 (Fit) centres it again.
      if (keyEvent.shiftKey && !keyEvent.altKey && !keyEvent.metaKey && !keyEvent.ctrlKey && key.startsWith("Arrow")) {
        keyEvent.preventDefault();
        const step = (axis: "x" | "y", sign: number) => (axis === "x" ? this.panTo(this.panX + sign * PAN_STEP, this.panY) : this.panTo(this.panX, this.panY + sign * PAN_STEP));
        if (key === "ArrowLeft" || key === "ArrowRight") {
          step("x", key === "ArrowRight" ? 1 : -1);
        } else if (key === "ArrowUp" || key === "ArrowDown") {
          step("y", key === "ArrowDown" ? 1 : -1);
        }
        return;
      }
      if (keyEvent.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
        keyEvent.preventDefault();
        this.runSelectionAction(key === "ArrowUp" ? "up" : "down");
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        keyEvent.preventDefault();
        this.stepSelection(key === "ArrowDown" ? "next" : "previous");
      } else if (key === "ArrowRight" || key === "ArrowLeft") {
        // Into a container's first component, or out to the container; the
        // inline direction flips them in a right-to-left page.
        keyEvent.preventDefault();
        const rtl = getComputedStyle(this).direction === "rtl";
        this.stepSelection((key === "ArrowRight") !== rtl ? "in" : "out");
      } else if (key === "Home" || key === "End") {
        keyEvent.preventDefault();
        this.stepSelection(key === "Home" ? "first" : "last");
      } else if ((key === "m" || key === "M") && !keyEvent.altKey && !keyEvent.metaKey && !keyEvent.ctrlKey) {
        // Move mode: the arrows choose any place it may go, Enter moves it there.
        keyEvent.preventDefault();
        this.guarded(() => this.withMover((mover) => mover.start()));
      } else if (key === "Delete" || key === "Backspace") {
        keyEvent.preventDefault();
        this.runSelectionAction("delete");
      } else if (key === "Escape") {
        this.selectAway(undefined);
      } else if (key === "Enter" && this.ctrl?.selectedComponentId() !== undefined) {
        keyEvent.preventDefault();
        this.dispatchEvent(new CustomEvent("canvas-edit-selection", { bubbles: true, composed: true }));
      }
    });
    this.root.addEventListener("cancel", (event) => {
      // Escape in the delete prompt: the browser closes the dialog; the canvas takes focus back.
      if ((event.target as HTMLElement | null)?.dataset?.deletePrompt !== undefined) {
        event.preventDefault();
        this.closeDeleteConfirm();
      }
      // Escape in the Move to... dialog: nothing moves, the canvas takes focus back.
      if ((event.target as HTMLElement | null)?.dataset?.movePrompt !== undefined) {
        event.preventDefault();
        this.mover?.closeDialog();
      }
    }, true);
    // The Move to... dialog's selects: another place lists its positions; a position turns Move on or off.
    this.root.addEventListener("change", (event) => this.mover?.changed(event.target as HTMLElement | null));
  }

  private clearDragging(): void {
    this.dragSourceNode = undefined;
    this.rendererEl?.shadowRoot
      ?.querySelector(".db-node.db-dragging")
      ?.classList.remove("db-dragging");
  }
}
// --- Properties -------------------------------------------------------

/**
 * Addresses the focused control across a panel repaint (see `captureFocus`). Every property
 * and rule edit repaints the whole panel, which would otherwise drop focus after a single
 * character and make a text box impossible to type into.
 */
interface FocusedControl {
  key: string;
  start: number | null;
  end: number | null;
  /**
   * The live control itself, kept when it cannot report its caret — a `type="number"` box has
   * no selection API — so the repaint can put it back in place of its fresh copy instead of
   * focusing that copy with the caret at the start. Its `value` is also the text as typed:
   * a `1.` or a cleared box, which the number in the draft would have redrawn as `1` or `0`.
   */
  live?: HTMLInputElement;
}

/**
 * The dataset attributes that together address one control. Matching walks the rendered
 * elements and compares these rather than building an attribute selector: property paths and
 * locale codes would need escaping, and `CSS.escape` is not available in every DOM
 * implementation the panels run under (jsdom, notably).
 */
const FOCUS_KEY_ATTRIBUTES = [
  "prop",
  "rule",
  // A mode's root choice: it commits and the panel repaints under it.
  "modeChoice",
  // The Logic tab's controls: the formula box (while it is the plain textarea), the Off /
  // Formula pills, the Runs options, the "Try one" chips and the editor's Retry.
  "ruleFormula",
  "ruleMode",
  "ruleRun",
  "ruleTry",
  "ruleEditorRetry",
  "propertyFilter",
  // The Values section's row selects and its Match by order button.
  "valueMapRow",
  "valueMapOrder",
  "valueMapStale",
  // The options editor's cells and add-row inputs.
  "optionRow",
  "optionPart",
  "optionsNew",
  "optionsMove",
  "optionsRemove",
  // The form-level Identity section's boxes (form id, version, schema version).
  "identityField",
  // The Formulas section's policy select.
  "formulaErrors",
  // The Browser assistants section's select.
  "agentTools",
  // Another mode's row on the Form panel ("Opens as"), whose choice can repaint the panel at once.
  "rootSetting",
  // The Style tab's choices: a look's radio keeps focus when a change repaints the tab, so the arrow keys carry on.
  "styleOption",
  "styleGroupClear",
  // The footer's problem count and the list it opens, so a repaint keeps focus on them.
  "inspectorProblems",
  "problemGo",
  "inspectorSave",
  // The JSON view's box while it is the plain textarea (before the editor loads, or if it never does).
  "jsonEdit"
] as const;

function focusKeyFor(element: HTMLElement): string | undefined {
  // `name=value` pairs for the attributes that are present, rather than a fixed-width row with
  // a filler for the absent ones: an absent attribute and an empty one then stay distinct
  // without needing a sentinel value no attribute may hold.
  const parts = FOCUS_KEY_ATTRIBUTES.filter((name) => element.dataset[name] !== undefined).map(
    (name) => `${name}=${element.dataset[name]}`
  );
  return parts.length > 0 ? parts.join("|") : undefined;
}

/**
 * The panel's own tabs: Field — what the component is, says and stores; Style — how
 * it looks; Logic — its rules. The ids are the ones hosts and tests already use. The JSON is
 * not a tab: it sits behind the tabs' ⋯, since it is about the component rather than a setting
 * of it. The component tree is not here either: it is form-wide, the outline's.
 */
const MORE_GLYPH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>';

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: BuilderTextKey }> = [
  { id: "properties", label: "inspector.tab.properties" },
  { id: "style", label: "inspector.tab.style" },
  { id: "rules", label: "inspector.tab.rules" }
];

/** What a {@link DatumBuilderPropertiesElement} edits; see its `subject`. */
export type InspectorSubject = "selection" | "root";

const EMPTY_TREE_VIEW: NestedTreeNodeView = {
  node: { id: "root", type: "form", configuration: {} },
  id: "root",
  type: "form",
  label: "Form",
  depth: 0,
  slots: []
};

/**
 * Panel-local working state for `expression` property controls, kept per selected component.
 *
 * The parsed expression lives in the controller's draft; JSON mid-keystroke does not parse and
 * so has nowhere to go but here. `texts` is what the box shows while the author types, `errors`
 * why the last keystroke did not reach the draft. Both are dropped when the selection moves
 * on, like the Rules tab's working state below, and with the draft on Discard or Escape, and
 * when an Undo or a Redo changes the component: the box then shows the value as it stands.
 */
interface ExpressionWorkingState {
  nodeId: string;
  texts: Map<string, string>;
  errors: Map<string, string>;
}

function emptyExpressionState(nodeId: string): ExpressionWorkingState {
  return { nodeId, texts: new Map(), errors: new Map() };
}

/**
 * Panel-local working state for the Logic tab, kept for one component. The draft holds every
 * rule's text as typed, parseable or not (the draft equals the box, and the
 * controller's `problemsOf` says when it does not parse); what the draft cannot hold stays here
 * (the author's Formula choice over a rule not yet written, a run scope chosen before there is a
 * formula to carry it) and is dropped when the selection moves on.
 */
interface RulesWorkingState {
  nodeId: string;
  /** Keyed by rule: a `RuleKey`, or a builder mode's own descriptor key. */
  modes: Map<string, RuleEditorMode>;
  /** A run scope chosen while the box is empty, carried into the formula once there is one. */
  runs: Map<string, RunScope>;
  open: Set<string>;
}

/** A `formula` control's rule key is this plus its property path, so it never collides with a rule's name. */
const FIELD_FORMULA_PREFIX = "field:";

/** The formula editor over one rule's box, with the node it edits (see `mountFormulaEditors`). */
interface MountedFormulaEditor {
  editor: CodeMirrorFormulaEditor;
  host: HTMLElement;
  nodeId: string | undefined;
  key: string;
}

/** A formula editor lifted out of the markup a paint is about to replace. */
interface LiftedFormulaEditor extends MountedFormulaEditor {
  hadFocus: boolean;
}

/** What a formula on the node being edited may read and call: the editor's lists, the parser's signatures. */
interface FormulaContext {
  fields: FormulaField[];
  /** The scope prefixes a formula may read besides fields; absent: all of them (a mode's rules read none). */
  scopes?: string[];
  functions: FormulaFunctionRow[];
  signatures: FormulaFunctionSignature[];
  locale: string;
}

/** Where the plugin functions a host wired come from: its `FormulaFunctionRegistry`, or anything shaped like one. */
export interface FormulaFunctionsSource {
  table(): readonly FormulaFunctionTableRow[];
  signatures(): FormulaFunctionSignature[];
  /**
   * The functions' evaluators by name (a `FormulaFunctionRegistry` has them): what the canvas
   * preview and Logic's Try it evaluate a call to a plugin function with. A source without them
   * lists and parses the names only, and a call to one works out to nothing while authoring.
   */
  functions?(): Record<string, (args: unknown[]) => unknown>;
}

/**
 * Panel-local working state for the JSON view, kept for one component. The draft
 * holds the last text that applied; `text` is what the box holds — the same JSON as the author
 * wrote it, or text that does not apply yet, with `problem` saying why. `drafted` is the JSON
 * the draft gave the last time the box and the draft agreed: a draft that no longer gives it
 * was changed somewhere else (the canvas, Undo, another tab, Discard), and the box shows it.
 */
interface JsonWorkingState {
  nodeId: string;
  text: string;
  drafted: string;
  problem: ComponentJsonProblem | undefined;
}

/** The JSON view's editor lifted out of the markup a paint is about to replace (see `liftJsonViewer`). */
interface LiftedJsonViewer {
  viewer: JsonViewer;
  nodeId: string | undefined;
  host: HTMLElement;
  scrollTop: number;
  hadFocus: boolean;
}

/** One mode's rows on the Form panel, as the shell hands them over. */
export interface FormPanelModeSettings {
  mode: string;
  title: string;
  rows: readonly BuilderFormSettingRow[];
  /** Rows that only say something, after the choices: nothing drafted, nothing saved. */
  readOnlyRows?: readonly BuilderFormSettingReadOnlyRow[] | undefined;
}

function emptyRulesState(nodeId: string): RulesWorkingState {
  return {
    nodeId,
    modes: new Map(),
    runs: new Map(),
    open: new Set()
  };
}

/** The Logic workspace's model, which words a condition as a sentence; see {@link loadLogicModel}. */
type LogicModelModule = typeof import("../logic/logic-model.js");

let logicModelLoad: Promise<LogicModelModule> | undefined;

/**
 * The "Reads as" sentence comes from the Logic workspace's model (`logic-model.ts`), which
 * carries the rule catalog and the diagnostics: it is loaded with the workspace, not with the
 * builder (check-bundles budgets datum-builder.js without it). The inspector asks for it the
 * first time it draws a rule and words the rule as the printed formula until it lands; a
 * rejected load is forgotten so the next rule drawn asks again.
 */
function loadLogicModel(): Promise<LogicModelModule> {
  if (!logicModelLoad) {
    const next = import("../logic/logic-model.js");
    next.catch(() => {
      if (logicModelLoad === next) {
        logicModelLoad = undefined;
      }
    });
    logicModelLoad = next;
  }
  return logicModelLoad;
}

/** The committed node `id` under `root`, walking every slot. */
function findComponentNode(root: ComponentNode, id: string): ComponentNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const slot of Object.values(root.children ?? {})) {
    for (const child of slot) {
      const found = findComponentNode(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** A token of a rule's sentence or printed formula as the "Reads as" line draws it. */
function readsToken(kind: string, text: string): RuleReadsToken {
  return { kind: kind === "field" ? "field" : kind === "value" ? "value" : "word", text };
}

/**
 * The body of a Logic rule sentence for the inspector's "Reads as" line: what follows the
 * lead's target and the word after it ("Calculate [Fee] as …", "Start [Fee] at …"). The
 * sentence's lead is its template's text before the first slot, the target, and the text
 * between the target and the body; `undefined` when the sentence has no such shape.
 */
function valueSentenceBody(sentence: ReadonlyArray<{ kind: string; text: string; componentId?: string | undefined }>, nodeId: string): typeof sentence | undefined {
  const target = sentence.findIndex((token) => token.kind === "field" && token.componentId === nodeId);
  if (target < 0) {
    return undefined;
  }
  const connective = sentence.findIndex((token, index) => index > target && token.kind === "word");
  if (connective < 0 || connective === sentence.length - 1) {
    return undefined;
  }
  return sentence.slice(connective + 1);
}

/** A component's label as the panel names it: the string it stores, "" when it is not text. */
function labelText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A `messages` map as the panel reads it: only the entries whose text is a string, by code. */
function authoredMessages(value: unknown): Record<string, string> {
  const messages: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [code, text] of Object.entries(value)) {
      if (code.trim().length > 0 && typeof text === "string") {
        // Defined, not assigned: a code named `__proto__` is an entry, not a prototype.
        Object.defineProperty(messages, code, { value: text, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return messages;
}

/** A value as JSON with object keys sorted and `undefined` members left out: equal configurations compare equal. */
function sameConfigurationValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value ?? null, (_key, entry: unknown) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .filter((key) => (entry as Record<string, unknown>)[key] !== undefined)
              .map((key) => [key, (entry as Record<string, unknown>)[key]])
          )
        : entry
    );
  return canonical(left) === canonical(right);
}

/**
 * A stored key for a pasted option: its label in lower case, letters and digits
 * with `_` between them, accents dropped; `option` when nothing is left. Unique against
 * `taken`, which it joins.
 */
function optionKeyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)
      .replace(/_+$/, "") || "option";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    key = `${base}_${n}`;
  }
  taken.add(key);
  return key;
}

/**
 * How many changes the options dialog holds since it opened: rows whose text
 * changed, plus rows added or removed (a key renamed counts once), plus a half-typed add row;
 * a list only reordered is one change.
 */
function optionsDialogChangeCount(editor: OptionsEditorView & { opened: readonly OptionsEditorRow[] }): number {
  const print = (row: OptionsEditorRow): string => JSON.stringify([row.label, row.description ?? ""]);
  const before = new Map(editor.opened.map((row) => [row.value.trim(), print(row)]));
  const after = new Map(editor.rows.map((row) => [row.value.trim(), print(row)]));
  let changed = 0;
  let added = 0;
  for (const [key, text] of after) {
    const was = before.get(key);
    if (was === undefined) {
      added += 1;
    } else if (was !== text) {
      changed += 1;
    }
  }
  const removed = [...before.keys()].filter((key) => !after.has(key)).length;
  let count = changed + Math.max(added, removed);
  if (
    count === 0 &&
    (editor.rows.length !== editor.opened.length || editor.rows.some((row, index) => row.value.trim() !== editor.opened[index]?.value.trim()))
  ) {
    count = 1;
  }
  return count + (editor.newValue.trim().length > 0 || editor.newLabel.trim().length > 0 ? 1 : 0);
}

/**
 * The row of a mode's buttons at the end of the inspector's about card: only in the
 * stylesheet while there are some, so an inspector with none draws what it always drew.
 */
const INSPECTOR_MODE_ACTION_STYLES = `
  .inspector-mode-actions { display: flex; flex-wrap: wrap; gap: var(--db-space-2); margin-top: var(--db-space-2); }
`;

/**
 * The mode's findings card: what a document needs put right, at the top
 * of the root panel, errors then warnings, a fix's button under the finding it mends.
 */
const MODE_CHOICE_STYLES = `
  .mode-choice { display: grid; gap: var(--db-space-1); margin: 0 0 var(--db-space-3); }
  .mode-choice-label { font-size: var(--db-text-md); font-weight: 500; color: var(--db-ink); }
  .mode-choice select { width: 100%; }
  .mode-choice-help { margin: 0; font-size: var(--db-text-sm); color: var(--db-ink-muted); }
`;

const MODE_FINDINGS_STYLES = `
  .mode-findings { margin: 0 0 var(--db-space-3); padding: 0; list-style: none; }
  .mode-finding { padding: var(--db-space-3) 0; border-block-start: var(--db-border-w) solid var(--db-line-divider); }
  .mode-finding:first-child { border-block-start: 0; padding-block-start: 0; }
  .mode-finding-text { display: block; margin: 0; padding: 0; border: 0; background: transparent; font: inherit; font-size: var(--db-text-md); line-height: 1.4; text-align: start; color: var(--db-ink); }
  button.mode-finding-text { cursor: pointer; }
  button.mode-finding-text:hover { text-decoration: underline; }
  .mode-finding[data-severity="error"] .mode-finding-text { color: var(--db-danger); }
  .mode-finding[data-severity="warning"] .mode-finding-text { color: var(--db-warn); }
  .mode-finding[data-severity="warning"] .mode-finding-text::before { content: "▲ "; }
  .mode-finding-fixes { display: flex; flex-wrap: wrap; gap: var(--db-space-2); margin-top: var(--db-space-2); }
`;

/** How long a findings-card fix's focus is followed through the paints after it (see `findingFixFocus`). */
const FINDING_FOCUS_LIFE_MS = 3000;

export class DatumBuilderPropertiesElement extends BuilderPanelElement {
  private bound = false;
  private tab: InspectorTab = "properties";

  /**
   * The inspector's tab: Properties, Rules, and the rest the inspector offers (the Logic
   * workspace opens Rules). A tab the inspector does not offer for the current
   * subject is ignored.
   */
  public get inspectorTab(): InspectorTab {
    return this.tab;
  }

  public set inspectorTab(value: InspectorTab) {
    if (!this.tabShown(value)) {
      return;
    }
    // Asked for this subject (the Logic workspace's Rules on each selection): kept for it.
    this.noteTabSubject();
    if (this.tab === value) {
      return;
    }
    this.tab = value;
    this.paint();
  }

  /**
   * The subject the open tab was chosen for: another component opens on the Field
   * tab, so a tab picked for one (the JSON view, Style) is not where the next one opens. The
   * same component, re-selected or repainted, keeps its tab.
   */
  private tabSubject: { controller: BuilderController | undefined; id: string | undefined } | undefined;

  private noteTabSubject(): void {
    this.tabSubject = { controller: this.ctrl, id: this.subjectId() };
  }
  /** Focus the first control of the open tab (Enter on the canvas). Whether one took it. */
  public focusFirstField(): boolean {
    // The JSON view's editor stands in for the textarea it hides.
    if (this.tab === "json" && this.jsonViewer) {
      this.jsonViewer.viewer.focus();
      return true;
    }
    const target = this.root
      .querySelector(".inspector-body")
      ?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]'
      );
    target?.focus();
    return target !== undefined && target !== null;
  }

  /**
   * Opens the options editor for `path` on `componentId` when that is what this panel inspects
   * (the canvas's "No options yet"), as the row's Edit options button does. Whether it opened.
   */
  public editOptions(componentId: string, path: string = INLINE_OPTIONS_PROPERTY): boolean {
    if (this.subjectId() !== componentId || this.optionsEditor) {
      return false;
    }
    const offered = this.ctrl?.inspectorModel(componentId)?.sections.some((section) => section.fields.some((field) => field.propertyPath === path && field.control === "options"));
    if (!offered) {
      return false;
    }
    this.startOptionsEditor(path);
    return this.optionsEditor !== undefined;
  }

  /**
   * Focus the control after the Label box: the next box, select or button in the
   * body as drawn now, past the "?" toggles and the section headings, and past what a folded
   * section or the filter hides. Nothing after it: focus stays on the box.
   */
  private focusAfterLabel(): void {
    const body = this.root.querySelector<HTMLElement>(".inspector-body");
    const label = body?.querySelector<HTMLElement>('[data-prop="label"]');
    if (!body || !label) {
      return;
    }
    const controls = [...body.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, button')];
    const next = controls.slice(controls.indexOf(label) + 1).find((control) => {
      if ((control as HTMLInputElement).disabled || control.classList.contains("property-help-toggle") || control.closest("[hidden]")) {
        return false;
      }
      const section = control.closest("details");
      return !section || section.open;
    });
    (next ?? label).focus();
  }

  /** Whether the Rules tab is offered; see {@link showRulesTab}. */
  private showRulesTabValue = true;
  /** What the panel edits; see {@link subject}. */
  protected subjectValue: InspectorSubject = "selection";
  /** What the root panel's heading says it is editing; see {@link settingsLabel}. */
  private settingsLabelValue: string | undefined;
  /** The subject's own state as of the last paint; see {@link onControllerChange}. */
  private subjectKey: string | undefined;
  /** Whose properties, on which tab, the last paint drew: a repaint of the same keeps the body's scroll. */
  private paintedView: string | undefined;
  /** Component awaiting delete confirmation, from the footer or a Tree-tab row. */
  private pendingDeleteId: string | undefined;
  /** Whether the tabs' ⋯ menu is open. */
  private inspectorMenuOpen = false;
  private promptsElsewhereValue = false;

  /**
   * Whether another surface draws the unsaved-edits prompt for this panel's subject: the shell
   * sets it while the inspector steps aside for Logic or Data, whose own
   * surfaces answer it. A modal opened inside a hidden panel would leave the page inert.
   */
  public get promptsElsewhere(): boolean {
    return this.promptsElsewhereValue;
  }

  public set promptsElsewhere(value: boolean) {
    if (value === this.promptsElsewhereValue) {
      return;
    }
    this.promptsElsewhereValue = value;
    this.paint();
  }

  /** The mode's buttons for what this panel edits; see {@link modeActions}. */
  private modeActionsValue: readonly BuilderInspectorAction[] = [];

  /**
   * A mode's buttons for what is selected on its canvas (`BuilderMode.inspectorActions`):
   * drawn at the end of the about card (the ID and "Saves to"), or as the card when it shows
   * neither, on the Field tab. The shell sets them, each `run` already behind the guard of the
   * component this panel edits. One with a `deleteLabel` stands in for Delete, so the footer
   * offers no Delete beside it. Assigning the same buttons (ids and words) again paints nothing.
   * Empty on a panel used on its own.
   */
  public get modeActions(): readonly BuilderInspectorAction[] {
    return this.modeActionsValue;
  }

  public set modeActions(value: readonly BuilderInspectorAction[]) {
    const next = [...(value ?? [])];
    const key = (actions: readonly BuilderInspectorAction[]): string => JSON.stringify(actions.map((action) => [action.id, action.label, action.deleteLabel ?? null]));
    const same = key(next) === key(this.modeActionsValue);
    // The runs are taken whatever the words: they close over the selection they were made for.
    this.modeActionsValue = next;
    if (!same) {
      this.paint();
    }
  }

  /** What the mode says needs putting right; see {@link modeFindings}. */
  private modeFindingsValue: readonly BuilderModeFinding[] = [];

  /**
   * A findings-card fix just pressed (WCAG 2.4.3): the card repaints without the finding it
   * fixed, the pressed button goes with the old markup, and focus would fall to the page. Once it
   * has, it goes to the same finding's button while that finding stands (a fix that is still
   * running), else to the finding now in its place, else to the panel's tab. Dropped once placed,
   * once the author moves focus elsewhere, or after {@link FINDING_FOCUS_LIFE_MS}.
   */
  private findingFixFocus: { id: string; fixId: string; index: number; until: number } | undefined;

  /**
   * The mode's findings card (`BuilderMode.findings`): drawn at the top of
   * a root panel's Properties tab, errors then warnings. Selecting one runs its `select`, a fix
   * its `run`. Assigning the same findings (ids, words, fixes) again paints nothing, so a draft
   * keystroke elsewhere never repaints the panel. Empty on a panel used on its own.
   */
  public get modeFindings(): readonly BuilderModeFinding[] {
    return this.modeFindingsValue;
  }

  public set modeFindings(value: readonly BuilderModeFinding[]) {
    const next = [...(value ?? [])];
    const key = (list: readonly BuilderModeFinding[]): string =>
      JSON.stringify(list.map((found) => [found.id, found.severity, found.message, found.select !== undefined, found.fixes.map((fix) => [fix.id, fix.label])]));
    const same = key(next) === key(this.modeFindingsValue);
    // The runs are taken whatever the words: they close over the journey they were made for.
    this.modeFindingsValue = next;
    if (!same && this.subjectValue === "root") {
      this.paint();
    }
  }

  /** What the mode lets the root panel choose at once; see {@link modeChoices}. */
  private modeChoicesValue: readonly BuilderModeChoice[] = [];

  /**
   * The mode's root choices (`BuilderMode.rootChoices`): drawn under the
   * findings card on a root panel's Properties tab, each a select that commits on change, not on
   * Apply. Assigning the same choices (ids, words, values) again paints nothing.
   */
  public get modeChoices(): readonly BuilderModeChoice[] {
    return this.modeChoicesValue;
  }

  public set modeChoices(value: readonly BuilderModeChoice[]) {
    const next = [...(value ?? [])];
    const key = (list: readonly BuilderModeChoice[]): string =>
      JSON.stringify(list.map((choice) => [choice.id, choice.label, choice.description ?? null, choice.choices, choice.value()]));
    const same = key(next) === key(this.modeChoicesValue);
    this.modeChoicesValue = next;
    if (!same && this.subjectValue === "root") {
      this.paint();
    }
  }

  /** The root choices' markup, or nothing: only on the root panel's Properties tab. */
  private choicesHtml(): string {
    if (this.subjectValue !== "root" || this.tab !== "properties" || this.modeChoicesValue.length === 0) {
      return "";
    }
    return this.modeChoicesValue
      .map((choice) => {
        const id = `mode-choice-${choice.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        const value = choice.value();
        const options = choice.choices.map((entry) => `<option value="${esc(entry.value)}"${entry.value === value ? " selected" : ""}>${esc(entry.label)}</option>`).join("");
        const help = choice.description ? `<p class="mode-choice-help" id="${id}-help">${esc(choice.description)}</p>` : "";
        return `<div class="mode-choice"><label class="mode-choice-label" for="${id}">${esc(choice.label)}</label><select id="${id}" data-mode-choice="${esc(choice.id)}"${
          choice.description ? ` aria-describedby="${id}-help"` : ""
        }>${options}</select>${help}</div>`;
      })
      .join("");
  }

  /** Focus after a findings-card fix, once it has fallen to the page; see {@link findingFixFocus}. */
  private placeFindingFocus(): void {
    const pending = this.findingFixFocus;
    if (!pending) {
      return;
    }
    if (Date.now() > pending.until) {
      this.findingFixFocus = undefined;
      return;
    }
    const inPanel = this.root.activeElement;
    if (inPanel) {
      // Still on a button of the card (the fix has not repainted it yet), or moved on by the author.
      if (!inPanel.closest("[data-mode-findings]")) {
        this.findingFixFocus = undefined;
      }
      return;
    }
    if (typeof document !== "undefined") {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      // Focus is somewhere else on the page (a canvas the fix selected on, a box it opened): left there.
      if (active && active !== document.body && active.isConnected) {
        this.findingFixFocus = undefined;
        return;
      }
    }
    const card = this.root.querySelector<HTMLElement>("[data-mode-findings]");
    const items = [...(card?.querySelectorAll<HTMLElement>("[data-finding]") ?? [])];
    const same = items.find((item) => item.dataset.finding === pending.id);
    const button = (item: HTMLElement | undefined): HTMLElement | null | undefined =>
      item?.querySelector<HTMLElement>("[data-finding-select]") ?? item?.querySelector<HTMLElement>("[data-finding-fix]");
    const target =
      (same
        ? ([...same.querySelectorAll<HTMLElement>("[data-finding-fix]")].find((entry) => entry.dataset.fixId === pending.fixId) ?? button(same))
        : button(items[Math.min(Math.max(pending.index, 0), items.length - 1)])) ??
      this.root.querySelector<HTMLElement>(".inspector-tab.active") ??
      this.root.querySelector<HTMLElement>("button, [href], input, select, textarea");
    if (!target) {
      return;
    }
    // The fix still running keeps its pending focus: the next repaint (without the finding) moves it on.
    if (!same) {
      this.findingFixFocus = undefined;
    }
    target.focus();
  }

  /** The findings card's markup, or nothing: only on the root panel's Properties tab, while the mode has findings. */
  private findingsCardHtml(): string {
    if (this.subjectValue !== "root" || this.tab !== "properties" || this.modeFindingsValue.length === 0) {
      return "";
    }
    const items = this.modeFindingsValue
      .map((found) => {
        const text = found.select
          ? `<button type="button" class="mode-finding-text" data-finding-select="${esc(found.id)}">${esc(found.message)}</button>`
          : `<p class="mode-finding-text">${esc(found.message)}</p>`;
        const fixes =
          found.fixes.length > 0
            ? `<div class="mode-finding-fixes">${found.fixes.map((fix) => `<button type="button" class="btn sm" data-finding-fix="${esc(found.id)}" data-fix-id="${esc(fix.id)}">${esc(fix.label)}</button>`).join("")}</div>`
            : "";
        return `<li class="mode-finding" data-finding="${esc(found.id)}" data-severity="${found.severity}">${text}${fixes}</li>`;
      })
      .join("");
    return `<ul class="mode-findings" data-mode-findings aria-label="${esc(this.words.text("inspector.findings.label"))}">${items}</ul>`;
  }

  /** The about card with the mode's buttons at its end (see {@link modeActions}); `body` as it is without any. */
  private withModeActions(body: string): string {
    if (this.modeActionsValue.length === 0 || this.tab !== "properties") {
      return body;
    }
    const buttons = `<div class="inspector-mode-actions" data-inspector-mode-actions>${this.modeActionsValue
      .map((action) => `<button type="button" class="btn" data-inspector-mode-action="${esc(action.id)}">${esc(action.label)}</button>`)
      .join("")}</div>`;
    const open = '<div class="inspector-about" data-inspector-about>';
    const at = body.indexOf(open);
    if (at < 0) {
      return `<div class="inspector-about" data-inspector-about>${buttons}</div>${body}`;
    }
    // The card's own closing tag: the first `</div>` that brings the depth back to the card's.
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = at + open.length;
    let depth = 1;
    for (let match = tags.exec(body); match; match = tags.exec(body)) {
      depth += match[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        return `${body.slice(0, match.index)}${buttons}${body.slice(match.index)}`;
      }
    }
    return body;
  }

  /** Whether one of the mode's buttons stands in for Delete (its `deleteLabel`): the footer then has none. */
  private modeActionReplacesDelete(): boolean {
    return this.modeActionsValue.some((action) => action.deleteLabel !== undefined);
  }

  /** Whether the shell offers the Languages workspace: the pointer line under a component's texts then offers Open in Languages. */
  public get languagesWorkspace(): boolean {
    return this.languagesWorkspaceValue;
  }

  public set languagesWorkspace(value: boolean) {
    if (value === this.languagesWorkspaceValue) {
      return;
    }
    this.languagesWorkspaceValue = value;
    this.paint();
  }

  private languagesWorkspaceValue = false;

  /** Which optional parts of the inspector exist (the builder's `features`); all of them unless the shell says otherwise. */
  private inspectorFeaturesValue = { json: true, translations: true, advancedFields: true, headerFooter: true, pdf: true, print: true, logic: true };

  /**
   * The optional parts of the inspector that exist (the builder's `features`): the JSON
   * view and editor (so its editor chunk is never fetched), the pointer line under each
   * component's texts, and the component id with the data key and Saved as lines. All of them unless
   * the shell says otherwise. Leaving the JSON view out moves a panel left on it to Properties.
   * `pdf`, `print` and `logic` gate the parts those workspaces own (see
   * {@link inspectorParts}): the component's On paper group, the Form panel's Formulas
   * section and the Button's Download as PDF action. The Languages workspace owns no inspector part (its pointer
   * line is the `translations` feature's), so it has no key here.
   */
  public get inspectorFeatures(): {
    readonly json: boolean;
    readonly translations: boolean;
    readonly advancedFields: boolean;
    readonly headerFooter: boolean;
    readonly pdf: boolean;
    readonly print: boolean;
    readonly logic: boolean;
  } {
    return this.inspectorFeaturesValue;
  }

  public set inspectorFeatures(value: {
    json?: boolean | undefined;
    translations?: boolean | undefined;
    advancedFields?: boolean | undefined;
    headerFooter?: boolean | undefined;
    pdf?: boolean | undefined;
    print?: boolean | undefined;
    logic?: boolean | undefined;
  }) {
    const next = {
      json: value.json !== false,
      translations: value.translations !== false,
      advancedFields: value.advancedFields !== false,
      headerFooter: value.headerFooter !== false,
      pdf: value.pdf !== false,
      print: value.print !== false,
      logic: value.logic !== false
    };
    const now = this.inspectorFeaturesValue;
    if ((Object.keys(next) as Array<keyof typeof next>).every((key) => next[key] === now[key])) {
      return;
    }
    this.inspectorFeaturesValue = next;
    if (!next.json && this.tab === "json") {
      this.tab = "properties";
    }
    if (!next.json) {
      this.inspectorMenuOpen = false;
    }
    this.paint();
  }

  /** Property paths the host manages (`managed-settings`): drawn as a "managed by the site" note, not a box. */
  private managedSettingsValue: readonly string[] = [];

  public get managedSettings(): readonly string[] {
    return this.managedSettingsValue;
  }

  public set managedSettings(value: readonly string[]) {
    const next = [...(value ?? [])];
    if (next.length === this.managedSettingsValue.length && next.every((path, i) => path === this.managedSettingsValue[i])) {
      return;
    }
    this.managedSettingsValue = next;
    this.paint();
  }

  /**
   * The inspector parts the builder's features own (`PropertiesPanelOptions.parts`): the
   * Button's Download as PDF goes with `pdf`, the On paper group with `print`, Formulas with `logic`. The passkey
   * signature choice is no builder feature's and stays. Every part on draws what
   * the panel drew before it was gated.
   */
  private inspectorParts(): { print: boolean; formulas: boolean; pdfAction: boolean } {
    const { pdf, print, logic } = this.inspectorFeaturesValue;
    return { print, formulas: logic, pdfAction: pdf };
  }

  /** Properties whose "?" description the author expanded, by property path. */
  private openHelp = new Set<string>();
  /** Property sections the author collapsed, by section id; new sections default open. */
  private collapsedSections = new Set<string>();
  /** Sections that start folded (a journey's Wording) which the author opened, by section id. */
  private openedSections = new Set<string>();
  /** Live text of the panel's filter box; rows not matching it are hidden, not removed. */
  private propertyFilter = "";
  /** Whether the footer's list of problems is open (the count opens it when there are several). */
  private problemListOpen = false;
  private rulesState: RulesWorkingState = emptyRulesState("");
  /** Where the Rules tab's rules come from; see {@link ruleSource}. */
  private ruleSourceValue: BuilderModeRules | undefined;
  /**
   * The formula editors over the Logic tab's boxes while they are on screen, by rule key. Every
   * paint replaces the panel's markup, so they are lifted out before a paint and put back after
   * it (see {@link mountFormulaEditors}), the way the JSON view's editor is: the same editor,
   * so the caret, the undo and the suggestions stay while the same node stays in view.
   */
  private formulaEditors = new Map<string, MountedFormulaEditor>();
  /** The formula editor's chunk: fetched on the first box drawn, kept once it lands, retried on request. */
  private formulaEditorLoad: "idle" | "loading" | "ready" | "failed" = "idle";
  private formulaModule: FormulaEditorModule | undefined;
  /** The plugin functions a host wired, for the editor's lists and the parser; see {@link formulaFunctions}. */
  private formulaFunctionsValue: FormulaFunctionsSource | undefined;
  /** What a formula on the subject may read, computed once per paint (see {@link formulaContext}). */
  private formulaContextMemo: { nodeId: string | undefined; context: FormulaContext } | undefined;
  /**
   * The rule this panel is writing to the draft from a keystroke in its box, for the length of
   * that write: its own `change` arrives while it is set, and is refreshed in place rather than
   * painted (see {@link applyFormulaEdit} and {@link onControllerChange}).
   */
  private liveRuleWrite: { nodeId: string; key: string } | undefined;
  /** The subject whose plain box is being typed in: its keystrokes are live writes (see applyPropertyEdit). */
  private liveBoxWrite: { nodeId: string } | undefined;
  /** Set while a live keystroke is waiting for its plain change on focusout. */
  private liveBoxPending: { nodeId: string; path: string } | undefined;
  /** {@link subjectKey} without the dirty parts: a live write may move only those. */
  private subjectKeyClean: string | undefined;
  /** A rule written live whose plain `edit` the canvas is still owed; sent when the author leaves the box (see {@link commitFormulaEdit}). */
  private liveRulePending: { nodeId: string; key: string } | undefined;
  /**
   * A press anywhere on the page not yet released, and what waits for its end (see
   * {@link afterPress}). `dragging` once it became a drag, which ends on the drop instead.
   */
  private press: { dragging: boolean; queued: Array<() => void> } | undefined;
  /** The box the author last left in this panel, and whose it was: Keep editing goes back to it. */
  private leftBox: { nodeId: string; focus: FocusedControl } | undefined;
  /** The Logic workspace's model once its chunk has landed (see {@link loadLogicModel}); the printed formula stands in until then. */
  private logicModel: LogicModelModule | undefined;
  private logicModelAsked = false;
  /** When, and for which selection, the Logic model last failed to load: no refetch per keystroke. */
  private logicModelFailed: { at: number; subject: string | undefined } | undefined;
  /** Whether the host has heard of the failure since the last success (one datum-error per burst). */
  private logicModelReported = false;
  /** Rows other modes add to the Form panel; see {@link modeSettings}. */
  private modeSettingsValue: readonly FormPanelModeSettings[] = [];
  private expressionState: ExpressionWorkingState = emptyExpressionState("");
  /** Why a `file` control refused the last pick, by property path, for the node it belongs to. */
  private fileState: { nodeId: string; errors: Map<string, string> } = { nodeId: "", errors: new Map() };
  /**
   * The controller the working copies above were made against. A node id alone does not tell
   * one tree from the next: every PDF layout's root is `document`, every populated form's
   * `template`, so a panel pointed at another layout would carry the last one's
   * half-written rule over — shown as this layout's, written into it on the next keystroke,
   * and a JSON box that did not parse holding its Save back.
   */
  private workingController: BuilderController | undefined;
  /**
   * The inline-options editor while it is open: the working copy of the selected component's
   * options (see `optionsEditorHtml`). Nothing reaches the form until Apply, which commits it
   *. `opened` is the rows as the dialog opened on them, what Escape counts changes
   * against.
   */
  private optionsEditor: (OptionsEditorView & { nodeId: string; opened: readonly OptionsEditorRow[] }) | undefined;
  /**
   * The question Escape puts over the options dialog when it holds changes: how
   * many, and the control the author was on, which Keep editing gives focus back to.
   */
  private optionsDiscard: { count: number; focus: FocusedControl | undefined } | undefined;
  /**
   * The JSON view's editor while one is on screen, with the node it shows. Every paint
   * replaces the panel's markup, so the editor is lifted out before a paint and put back in
   * the new markup after it (see {@link mountJsonViewer}) — the same editor, so the caret, the
   * undo and the scroll offset stay while the same node stays in view.
   */
  private jsonViewer: { viewer: JsonViewer; nodeId: string | undefined; host: HTMLElement } | undefined;
  /** What the JSON view's box holds; see {@link JsonWorkingState}. */
  private jsonState: JsonWorkingState | undefined;

  /** The builder's words (the text catalog) for this panel's own chrome. */
  private readonly words = new BuilderWords();

  /**
   * What the whole definition would weigh with `extraBytes` more in it, against the most a load
   * accepts (see `DefinitionBudget`). A file picked into a `file` control is embedded in the
   * definition as base64, so one that would tip the form past the limit is refused with the
   * numbers, and the draft is left alone. Absent: nothing is asked.
   */
  public embedBudget: ((extraBytes: number) => DefinitionBudget | undefined) | undefined;

  /**
   * Where the formula editors' "Formula reference" link goes (the host's `formulaReferenceHref`).
   * Unset, the editors draw no link: the builder has no documentation page of its own to point at.
   */
  public formulaReferenceHref: string | undefined;

  /** The builder's own language for its words (the text catalog's locale), not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.paint();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.paint();
    }
  }

  /** The words options: the builder's own locale and catalog when the host set them, else the form's locale. */
  private wordsFor(fallbackLocale: string | undefined): BuilderTextOptions {
    const locale = this.words.locale ?? fallbackLocale;
    return {
      ...(locale !== undefined ? { locale } : {}),
      ...(this.words.catalog ? { catalog: this.words.catalog } : {})
    };
  }

  /**
   * The plugin functions the host wired (`FormulaFunctionRegistry`, or anything with its
   * `table()` and `signatures()`): listed with the built-ins in the editor's Function menu and
   * suggestions, and known to the parser so a call to one is no problem. Absent: built-ins only.
   */
  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.formulaFunctionsValue;
  }


  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    if (this.formulaFunctionsValue === value) {
      return;
    }
    this.formulaFunctionsValue = value;
    this.formulaContextMemo = undefined;
    this.paint();
  }

  /**
   * Whether the Rules tab is offered. The shell clears it for a mode whose tree carries no
   * rules anything reads (a PDF layout); a panel left on that tab falls back to
   * Properties. A panel used on its own offers it.
   */
  public set showRulesTab(value: boolean) {
    if (this.showRulesTabValue === value) {
      return;
    }
    this.showRulesTabValue = value;
    if (!value && this.tab === "rules") {
      this.tab = "properties";
    }
    this.paint();
  }

  public get showRulesTab(): boolean {
    return this.showRulesTabValue;
  }

  /**
   * Where the Rules tab's rules come from (`BuilderMode.inspector.rules`): which
   * rules each node type offers, where each is stored, what a condition's field box suggests
   * and the tab's opening line. Unset: the rules the engine evaluates, in `rules`, as for the
   * form. A node offered none has no Rules tab, and a panel on it moves to Properties.
   */
  public set ruleSource(value: BuilderModeRules | undefined) {
    if (this.ruleSourceValue === value) {
      return;
    }
    this.ruleSourceValue = value;
    // Working copies were made against the other source's rules.
    this.rulesState = emptyRulesState("");
    this.paint();
  }

  public get ruleSource(): BuilderModeRules | undefined {
    return this.ruleSourceValue;
  }

  /**
   * Rows other builder modes add to the form's settings (`BuilderMode.formSettings`),
   * drawn by a `"root"` panel on the form's own tree, a section per mode after the form's own.
   * Their values are drafted on the root, so Save, Cancel and "Unsaved" cover them.
   */
  public set modeSettings(value: readonly FormPanelModeSettings[]) {
    this.modeSettingsValue = value;
    if (this.subjectValue === "root") {
      this.paint();
    }
  }

  public get modeSettings(): readonly FormPanelModeSettings[] {
    return this.modeSettingsValue;
  }

  /**
   * The rules a node of `nodeType` offers on the Rules tab, from the source or the engine's
   * own. Given the node, "Required when" is offered only where the fold reads it
   * ({@link requiredWhenGap}) — unless the node already carries one, which stays on the tab
   * under a note saying it is never enforced, so the author can see it and take it off.
   */
  private ruleDescriptorsFor(nodeType: string, nodeId?: string): readonly RuleDescriptor[] {
    if (this.ruleSourceValue) {
      return this.ruleSourceValue.descriptors(nodeType);
    }
    const controller = this.ctrl;
    const node = controller && nodeId !== undefined ? controller.editedNode(nodeId) : undefined;
    if (!controller || !node || nodeId === undefined) {
      return applicableRuleDescriptors(nodeType);
    }
    const rules = controller.draftRules(nodeId);
    const read = requiredWhenGap(controller, node, nodeId, this.wordsFor(undefined)) === undefined;
    const offersRequired = read || Boolean(rules?.requiredWhen);
    // A calculation or a default only on a node that holds data — or one it already
    // carries, which stays under a note saying it is never worked out, so it can be taken off.
    const offersValue = holdsData(node) || Boolean(rules?.value) || Boolean(rules?.defaultValue);
    // "Valid when" where the fold reads it, as for "Required when"; or one the node carries.
    const offersValid = read || Boolean(rules?.validWhen);
    return applicableRuleDescriptors(nodeType, { offersRequired, holdsData: offersValue, offersValid });
  }

  /** The descriptor behind a rule key on `nodeId`'s tab, wherever it came from. */
  private ruleDescriptorFor(nodeId: string, key: string): RuleDescriptor | undefined {
    if (key.startsWith(FIELD_FORMULA_PREFIX)) {
      return this.fieldFormulaDescriptors(nodeId).find((entry) => entry.key === key);
    }
    const type = this.ctrl?.editedNode(nodeId)?.type;
    return (type !== undefined ? this.ruleDescriptorsFor(type, nodeId).find((entry) => entry.key === key) : undefined) ?? RULE_DESCRIPTOR_BY_KEY.get(key);
  }

  /**
   * The formula boxes the Field tab itself draws (`formula` controls, such as a PDF area's
   * "Filled from" formula), each as a rule descriptor addressed by `field:<propertyPath>` and
   * written to that property: the Rules tab's editor, feedback and live draft seam serve them
   * unchanged. Empty for a node whose model has none.
   */
  private fieldFormulaDescriptors(nodeId: string): readonly RuleDescriptor[] {
    const model = this.ctrl?.inspectorModel(nodeId);
    const out: RuleDescriptor[] = [];
    for (const section of model?.sections ?? []) {
      for (const field of section.fields) {
        if (field.control === "formula") {
          out.push({
            key: `${FIELD_FORMULA_PREFIX}${field.propertyPath}`,
            label: field.label,
            description: field.description ?? "",
            kind: "value",
            target: { propertyPath: field.propertyPath }
          });
        }
      }
    }
    return out;
  }

  /** The `formula` controls of the Field tab as the markup draws them: the draft's rule under a forced formula mode. */
  private fieldFormulaViews(controller: BuilderController, nodeId: string): Map<string, FormulaFieldView> {
    const out = new Map<string, FormulaFieldView>();
    const descriptors = this.fieldFormulaDescriptors(nodeId);
    if (descriptors.length === 0) {
      return out;
    }
    const working = this.rules(nodeId);
    const context = this.formulaContext(nodeId);
    for (const descriptor of descriptors) {
      working.modes.set(descriptor.key, "formula");
      const view = this.ruleView(controller, nodeId, descriptor, working, context);
      const path = descriptor.target!.propertyPath;
      out.set(path, { key: descriptor.key, view, options: this.fieldFormulaOptions(controller, nodeId, descriptor, view, context) });
    }
    return out;
  }

  /** What a field formula's feedback is drawn with: its problem, the tree owner's notes for the property, the editor's state. */
  private fieldFormulaOptions(controller: BuilderController, nodeId: string, descriptor: RuleDescriptor, view: RuleView, context: FormulaContext): RuleHtmlOptions {
    const path = descriptor.target!.propertyPath;
    const notes = controller
      .notesOf(nodeId)
      .filter((note) => note.target === path)
      .map((note) => ({ message: note.message, ...(note.severity !== undefined ? { severity: note.severity } : {}) }));
    return {
      error: this.ruleSaveProblems(controller, nodeId).get(descriptor.key) ?? view.problem,
      notes: notes.length > 0 ? notes : undefined,
      openInLogic: false,
      editorFailed: this.formulaEditorLoad === "failed",
      words: this.wordsFor(context.locale)
    };
  }

  /** Whether this panel's subject has any rule to offer: the Rules tab is left out otherwise. */
  private subjectHasRules(): boolean {
    if (!this.showRulesTabValue) {
      return false;
    }
    const subjectId = this.subjectId();
    const type = this.ctrl?.editedNode(subjectId)?.type;
    return type === undefined || this.ruleDescriptorsFor(type, subjectId).length > 0 || this.waysOf(subjectId) !== undefined;
  }

  /** The mode's ways out of `nodeId` (a journey's step), which its Logic tab lists. */
  private waysOf(nodeId: string | undefined): BuilderModeWays | undefined {
    return nodeId !== undefined ? this.ruleSourceValue?.ways?.(nodeId) : undefined;
  }

  /**
   * The inspector's model less the fields a left-out feature owns: without
   * `advanced-fields` the data key's box is not drawn, and without `header-footer` the root's
   * Header and Footer rows (their button opens a panel that is not there) are not. The model
   * itself, untouched, otherwise.
   */
  private shownModel(model: InspectorModel | undefined): InspectorModel | undefined {
    const { advancedFields, headerFooter } = this.inspectorFeaturesValue;
    if (!model) {
      return model;
    }
    // The model is built without the builder's words (the controller hands it none), so the Format
    // box is drawn afresh in them; a model that has no such box passes through as it was.
    const subject = this.ctrl?.editedNode(this.subjectId());
    const hasFormat = subject !== undefined && model.sections.some((section) => section.fields.some((field) => field.propertyPath === PATTERN_PRESET_PATH));
    if (hasFormat) {
      model = rewordPatternPreset(model, subject, this.wordsFor(undefined));
    }
    if (advancedFields && headerFooter) {
      return model;
    }
    return {
      ...model,
      sections: model.sections.map((section) => ({
        ...section,
        fields: section.fields.filter(
          (field) => (advancedFields || field.propertyPath !== DATA_KEY_PROPERTY) && (headerFooter || field.control !== "chrome")
        )
      }))
    };
  }

  /**
   * The suggestion "Suggest: validate as email" is a hint line like the others, drawn
   * by the shared markup as text; here its words become a button that applies the preset to the
   * draft, so the one click is also reachable from the keyboard. The line is found by its message,
   * which the markup escapes the way `esc` does; a panel with no such line returns the html as it was.
   */
  private presetSuggestionButton(node: ComponentNode | undefined, html: string): string {
    const preset = node ? suggestedPatternPreset(node) : undefined;
    if (!preset) {
      return html;
    }
    const message = esc(this.words.text(preset.suggestKey));
    const line = `data-inspector-hint>${message}</p>`;
    const at = html.indexOf(line);
    if (at < 0) {
      return html;
    }
    return `${html.slice(0, at)}data-inspector-hint><button type="button" class="btn" data-preset-apply="${esc(preset.id)}">${message}</button></p>${html.slice(at + line.length)}`;
  }

  /** The rows of every mode that adds to the form's settings, for a root panel on the form. */
  private shownModeSettings(): readonly FormPanelModeSettings[] {
    return this.subjectValue === "root" && this.primaryValue
      ? this.modeSettingsValue.filter((group) => group.rows.length > 0 || (group.readOnlyRows?.length ?? 0) > 0)
      : [];
  }

  /**
   * What the panel edits. `"selection"` — the default, and the shell's right-hand
   * inspector — edits the selected component and draws nothing at all while there is none,
   * so the shell can take the column away. `"root"` — the shell's Form panel, opened from the
   * activity strip — edits the controller's root: the form's own settings, or, on another
   * mode's tab, that document's. It offers the same three tabs, since the root carries rules
   * that gate every field under it and its JSON is the whole tree's; what it does not carry
   * is a collapse chevron (the strip item is the toggle) or Delete (the root cannot be
   * removed). A head names what it edits, which the inspector leaves to its tabs.
   */
  public set subject(value: InspectorSubject) {
    if (this.subjectValue === value) {
      return;
    }
    this.subjectValue = value;
    this.paint();
  }

  public get subject(): InspectorSubject {
    return this.subjectValue;
  }

  /**
   * What a `"root"` panel's heading calls what it edits — "Form" on the builder's own tree,
   * the document's word ("Layout") on another mode's. Ignored by a `"selection"` panel.
   */
  public set settingsLabel(value: string) {
    if (this.settingsLabelValue === value) {
      return;
    }
    this.settingsLabelValue = value;
    if (this.subjectValue === "root") {
      this.paint();
    }
  }

  public get settingsLabel(): string {
    return this.settingsLabelValue ?? this.words.text("shell.panel.form.short");
  }

  /**
   * The component this panel is editing: the controller's root, or the selection — which is
   * `undefined` while nothing is selected, and the panel then has nothing to draw.
   */
  private subjectId(): string | undefined {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    if (this.subjectValue === "root") {
      return controller.rootId();
    }
    // The root is never the inspector's: selecting it outright (the outline's first row, a
    // host) outlines it on the canvas and opens the Form panel, which is where it is edited.
    const selected = controller.selectedComponentId();
    return selected === controller.rootId() ? undefined : selected;
  }

  /** The tabs on the strip: every one, or all but Rules — for a mode that keeps none, or a subject offered none. */
  private inspectorTabs(): ReadonlyArray<{ id: InspectorTab; label: string }> {
    const subjectId = this.subjectId();
    const controller = this.ctrl;
    // Style only for a component with style sections; the root's settings stay on one tab.
    const style =
      !!controller && subjectId !== undefined && subjectId !== controller.rootId() && hasStyleSections(drawnModel(controller.inspectorModel(subjectId)));
    const rules = this.subjectHasRules();
    // The form root's settings are not a field's: its first tab says Settings. A type may name
    // what it is instead of a field (a journey's step: Step).
    const isRoot = !!controller && subjectId !== undefined && subjectId === controller.rootId();
    const type = !isRoot && controller && subjectId !== undefined ? controller.editedNode(subjectId)?.type : undefined;
    const kind = type !== undefined ? controller?.componentTypes().find((entry) => entry.type === type)?.inspectorTab : undefined;
    const first: BuilderTextKey = isRoot ? "inspector.tab.settings" : kind === "step" ? "inspector.tab.step" : "inspector.tab.properties";
    return INSPECTOR_TABS.filter((tab) => (tab.id !== "rules" || rules) && (tab.id !== "style" || style)).map((tab) => ({
      id: tab.id,
      label: this.words.text(tab.id === "properties" ? first : tab.label)
    }));
  }

  /** A tab the panel may show: one of its tabs, or the JSON behind the ⋯. */
  private tabShown(tab: InspectorTab): boolean {
    return tab === "json" ? this.inspectorFeaturesValue.json : this.inspectorTabs().some((entry) => entry.id === tab);
  }

  /** The component's name as the outline shows it, for the head over the tabs. */
  private nodeLabel(node: ComponentNode): string {
    return findTreeNode(this.ctrl?.treeView() ?? EMPTY_TREE_VIEW, node.id)?.label || node.id;
  }

  /** The type's palette name ("Short text"), else the type itself. */
  private typeLabel(type: string): string {
    return this.ctrl?.componentTypes().find((entry) => entry.type === type)?.label ?? type;
  }

  private toggleInspectorMenu(): void {
    this.inspectorMenuOpen = !this.inspectorMenuOpen;
    this.syncInspectorMenu();
    if (this.inspectorMenuOpen) {
      this.root.querySelector<HTMLElement>("[data-inspector-menu] [role=menuitem]")?.focus();
    }
  }

  private syncInspectorMenu(): void {
    this.root.querySelector<HTMLElement>("[data-inspector-menu]")?.toggleAttribute("hidden", !this.inspectorMenuOpen);
    this.root.querySelector<HTMLElement>("[data-inspector-more]")?.setAttribute("aria-expanded", String(this.inspectorMenuOpen));
  }

  /** How many rules the component carries, for the Logic tab's count. */
  private ruleCount(node: ComponentNode | undefined): number {
    const rules = (node as { rules?: Record<string, unknown> } | undefined)?.rules;
    return rules ? Object.values(rules).filter((value) => value !== undefined && value !== null).length : 0;
  }

  private captureFocus(): FocusedControl | undefined {
    const active = this.root.activeElement as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    if (!active) {
      return undefined;
    }
    const key = focusKeyFor(active);
    if (key === undefined) {
      return undefined;
    }
    const hasSelection =
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && (active.type === "text" || active.type === ""));
    return {
      key,
      start: hasSelection ? active.selectionStart : null,
      end: hasSelection ? active.selectionEnd : null,
      ...(active instanceof HTMLInputElement && active.type === "number" ? { live: active } : {})
    };
  }

  /** Where `element` is, to be found again after a repaint: its key and caret, never the element itself. */
  private focusOf(element: HTMLElement): FocusedControl | undefined {
    const key = focusKeyFor(element);
    if (key === undefined) {
      return undefined;
    }
    const hasSelection =
      element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && (element.type === "text" || element.type === ""));
    return {
      key,
      start: hasSelection ? (element as HTMLInputElement | HTMLTextAreaElement).selectionStart : null,
      end: hasSelection ? (element as HTMLInputElement | HTMLTextAreaElement).selectionEnd : null
    };
  }

  /**
   * Puts the live number box back where the repaint drew its copy, so the caret stays where
   * the author left it (see {@link FocusedControl.live}). Only while the draft still says what
   * the box says: after Escape reverts the draft, the fresh copy's value is the one to show.
   * The copy's attributes come across — bounds, help ids, anything the repaint recomputed.
   */
  private keepLiveControl(live: HTMLInputElement, fresh: HTMLElement): HTMLElement {
    if (!(fresh instanceof HTMLInputElement) || fresh.type !== live.type) {
      return fresh;
    }
    // Text the draft cannot hold (a cleared box, "0.", "1e": numberBoxValue drafts nothing) is the
    // author mid-typing, so the live box stays; otherwise it stays only while the draft agrees.
    if (numberBoxValue(live.value) !== undefined && Number(fresh.value) !== Number(live.value)) {
      return fresh;
    }
    for (const { name } of [...live.attributes]) {
      if (!fresh.hasAttribute(name)) {
        live.removeAttribute(name);
      }
    }
    for (const { name, value } of [...fresh.attributes]) {
      live.setAttribute(name, value);
    }
    fresh.replaceWith(live);
    return live;
  }

  /**
   * After a discard, writes the painted value into any kept live text or number box that still
   * shows typed text. A keystroke paints nothing (liveBoxWrite), so the revert repaints markup
   * equal to the current markup, writeMarkup skips the DOM, and the box would keep lying. The
   * node is never replaced; the markup's value attribute is the painted value.
   */
  private syncBoxesToPainted(): void {
    for (const box of this.root.querySelectorAll<HTMLInputElement>("input[data-prop]")) {
      if (box.type !== "number" && box.type !== "text" && box.type !== "") {
        continue;
      }
      const painted = box.getAttribute("value") ?? "";
      if (box.value !== painted) {
        box.value = painted;
      }
    }
  }

  private restoreFocus(snapshot: FocusedControl | undefined): void {
    if (!snapshot) {
      return;
    }
    let next: HTMLElement | undefined;
    for (const candidate of this.root.querySelectorAll<HTMLElement>(
      "input, select, textarea, button"
    )) {
      if (focusKeyFor(candidate) === snapshot.key) {
        next = candidate;
        break;
      }
    }
    // "Remove stale entries" is drawn only while there are stale entries: pressed, it is gone, and
    // focus goes to the Values section's next control rather than to nothing.
    if (!next && snapshot.key.startsWith("valueMapStale=")) {
      const path = snapshot.key.slice("valueMapStale=".length);
      const section = [...this.root.querySelectorAll<HTMLElement>("[data-value-map]")].find((element) => element.dataset.valueMap === path);
      next = section?.querySelector<HTMLElement>("[data-value-map-order], [data-value-map-row]") ?? undefined;
    }
    if (!next) {
      return;
    }
    if (snapshot.live) {
      next = this.keepLiveControl(snapshot.live, next);
    }
    next.focus();
    if (
      snapshot.start !== null &&
      (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)
    ) {
      try {
        next.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
      } catch {
        // Not every input type supports a selection range.
      }
    }
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    if (typeof window !== "undefined") {
      for (const [type, listener] of this.pressListeners) {
        window.addEventListener(type, listener, true);
      }
    }
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unmountJsonViewer();
    this.unmountFormulaEditors();
    if (typeof window !== "undefined") {
      for (const [type, listener] of this.pressListeners) {
        window.removeEventListener(type, listener, true);
      }
    }
  }

  // --- a press elsewhere on the page ---------------------------------------------

  /*
   * Leaving a box typed in live sends its plain change (see commitBoxEdit), and that change
   * repaints the canvas and the outline. Left by a press on one of them, the box blurs on the
   * press, and the repaint replaced the very component or row being pressed before the button
   * came up: the browser then sends no click, and selecting another component did nothing at
   * all, with the unapplied draft sitting there unexplained. So a box left by a press sends its
   * change once the press is over, after the click it ends in has run: the selection is asked
   * for first, and the prompt about the draft comes up.
   */
  private readonly pressListeners: Array<[string, (event: Event) => void]> = [
    ["pointerdown", () => {
      this.press = { dragging: false, queued: this.press?.queued ?? [] };
    }],
    ["dragstart", () => {
      if (this.press) {
        this.press.dragging = true;
      }
    }],
    ["pointerup", () => this.endPress()],
    // A drag cancels its pointer: it ends where it drops.
    ["pointercancel", () => {
      if (!this.press?.dragging) {
        this.endPress();
      }
    }],
    ["drop", () => this.endPress()],
    ["dragend", () => this.endPress()],
    // The window losing focus mid-press (another app) may never send the release. An element's
    // blur passes the window's capture too, and is no end of anything.
    ["blur", (event) => {
      if (event.target === window) {
        this.endPress();
      }
    }]
  ];

  private endPress(): void {
    const press = this.press;
    this.press = undefined;
    if (!press || press.queued.length === 0) {
      return;
    }
    // The click a release ends in is dispatched with it: a task later it has run.
    setTimeout(() => {
      for (const run of press.queued) {
        run();
      }
    }, 0);
  }

  /** Runs `run` now, or once the press under way anywhere on the page is over. */
  private afterPress(run: () => void): void {
    if (this.press) {
      this.press.queued.push(run);
    } else {
      run();
    }
  }

  /**
   * Keep editing on the prompt about this panel's draft: the selection stays, and the
   * author goes back to what holds the Apply back, else to the box they left.
   */
  private keepEditing(): void {
    const controller = this.ctrl;
    const nodeId = this.subjectId();
    if (!controller || nodeId === undefined) {
      return;
    }
    if (this.panelProblems(controller, nodeId, controller.inspectorModel(nodeId)).length > 0) {
      this.showProblem();
      return;
    }
    const left = this.leftBox;
    if (left && left.nodeId === nodeId) {
      this.restoreFocus(left.focus);
    }
  }

  // --- the Logic tab's formula editors -----------------------------------------------------

  /** Takes down every formula editor: the panel draws no body, or has left the page. */
  private unmountFormulaEditors(): void {
    const current = [...this.formulaEditors.values()];
    this.formulaEditors.clear();
    for (const entry of current) {
      entry.editor.destroy();
    }
  }

  /**
   * Lifts the formula editors out ahead of a repaint, without taking them down, with whether
   * each had focus and the node it edited, so the paint can put the same editors back (see
   * {@link mountFormulaEditors}).
   */
  private liftFormulaEditors(): Map<string, LiftedFormulaEditor> {
    const lifted = new Map<string, LiftedFormulaEditor>();
    const active = this.root.activeElement;
    for (const [key, entry] of this.formulaEditors) {
      lifted.set(key, { ...entry, hadFocus: entry.editor.hasFocus || (active !== null && entry.host.contains(active)) });
    }
    this.formulaEditors.clear();
    return lifted;
  }

  /**
   * Puts a formula editor over every formula box the paint produced (`textarea[data-rule-formula]`).
   * The textarea stays in the DOM, hidden, so the text is still there for anything that reads
   * it from the markup and for a repaint to hand back; the editor takes its place on screen.
   * `lifted` are the editors the paint lifted out: on the same node and rule each goes back in,
   * its text set to what the box holds (a no-op when the author's typing is what repainted the
   * panel), with its focus. The rest are taken down, and fresh editors mount once the chunk is
   * loaded; before it lands, or if it never does, the textarea is the box.
   */
  private mountFormulaEditors(nodeId: string | undefined, lifted: Map<string, LiftedFormulaEditor>): void {
    const boxes = [...this.root.querySelectorAll<HTMLTextAreaElement>("textarea[data-rule-formula]")];
    const context = boxes.length > 0 ? this.formulaContext(nodeId) : undefined;
    for (const box of boxes) {
      const key = box.dataset.rule ?? "";
      const previous = lifted.get(key);
      lifted.delete(key);
      if (!previous && this.formulaEditors.has(key)) {
        // Mounted already (the chunk landed between paints): nothing to do.
        continue;
      }
      if (previous && previous.nodeId === nodeId && context) {
        box.insertAdjacentElement("afterend", previous.host);
        box.hidden = true;
        previous.editor.setText(box.value);
        previous.editor.setFields(context.fields);
        this.describeFormulaEditor(box, previous.editor);
        this.formulaEditors.set(key, { editor: previous.editor, host: previous.host, nodeId, key });
        if (previous.hadFocus) {
          previous.editor.focus();
        }
        continue;
      }
      previous?.editor.destroy();
      if (context) {
        this.mountFormulaEditor(box, nodeId, key, context);
      }
    }
    for (const stale of lifted.values()) {
      stale.editor.destroy();
    }
  }

  /** A fresh editor over `box`, when the chunk is loaded; else the chunk is asked for, and the box stays the textarea meanwhile. */
  private mountFormulaEditor(box: HTMLTextAreaElement, nodeId: string | undefined, key: string, context: FormulaContext): void {
    if (this.formulaEditorLoad !== "ready" || !this.formulaModule) {
      this.ensureFormulaEditorModule();
      return;
    }
    const host = box.ownerDocument.createElement("div");
    host.className = "rule-formula-editor";
    host.dataset.ruleFormulaEditor = key;
    box.insertAdjacentElement("afterend", host);
    const hadFocus = this.root.activeElement === box;
    const caret = box.selectionStart;
    const functions = context.functions;
    const editor = this.formulaModule.mountFormulaEditor(host, {
      text: box.value,
      label: box.getAttribute("aria-label") ?? key,
      fields: context.fields,
      ...(context.scopes !== undefined ? { scopes: context.scopes } : {}),
      functions,
      signatures: context.signatures,
      // A value rule's box is multiline; every other box holds a condition, which the editor warns about when it is provably no yes-or-no.
      ...(box.dataset.ruleMultiline !== undefined ? { multiline: true } : { condition: true }),
      locale: context.locale,
      ...(this.formulaReferenceHref !== undefined ? { referenceHref: this.formulaReferenceHref } : {}),
      snippets: [...FORMULA_SNIPPETS, ...pluginSnippets(functions)],
      // Every edit goes to the draft (or the working copy), never through a paint of this
      // panel's own: the draft's change repaints it, and the editor is lifted across.
      onChange: (text) => {
        box.value = text;
        if (nodeId !== undefined) {
          this.applyFormulaEdit(nodeId, key, text);
        }
      },
      // Leaving the box (blur, Enter on a single line): the canvas and the rest catch up.
      onCommit: () => {
        if (nodeId !== undefined) {
          // Left by a press: once it is over, as a plain box (see pressListeners).
          this.afterPress(() => this.commitFormulaEdit(nodeId, key));
        }
      }
    });
    box.hidden = true;
    this.describeFormulaEditor(box, editor);
    this.formulaEditors.set(key, { editor, host, nodeId, key });
    if (hadFocus) {
      editor.focus(caret);
    }
  }

  /** The editor says what its textarea says: whether the text parses, and the notes and problem that describe it. */
  private describeFormulaEditor(box: HTMLTextAreaElement, editor: CodeMirrorFormulaEditor): void {
    for (const name of ["aria-invalid", "aria-describedby"]) {
      const value = box.getAttribute(name);
      if (value === null) {
        editor.contentDom.removeAttribute(name);
      } else {
        editor.contentDom.setAttribute(name, value);
      }
    }
  }

  /**
   * Fetches the editor's chunk once; when it lands, the boxes on screen get their editors
   * (a paint is not needed: the textareas are where they were). A failed fetch is said under
   * each box with a Retry, which asks again (the loader forgets a rejected load).
   */
  private ensureFormulaEditorModule(): void {
    if (this.formulaEditorLoad !== "idle") {
      return;
    }
    this.formulaEditorLoad = "loading";
    loadFormulaEditor().then(
      (module) => {
        this.formulaModule = module;
        this.formulaEditorLoad = "ready";
        try {
          if (this.isConnected) {
            this.mountFormulaEditors(this.subjectId(), new Map());
          }
        } catch (cause) {
          this.formulaEditorFailed(cause);
        }
      },
      (cause: unknown) => this.formulaEditorFailed(cause)
    );
  }

  /** The editor's chunk did not load (or would not mount): the textareas stay, each with Retry, and the host hears it. */
  private formulaEditorFailed(cause: unknown): void {
    this.formulaEditorLoad = "failed";
    this.paint();
    this.dispatchEvent(new CustomEvent("datum-error", { bubbles: true, composed: true, detail: { code: "file.unavailable", message: this.words.text("shell.load.failed.formula"), cause } }));
  }

  /**
   * What a formula on `nodeId` may read and call: the fields the mode names
   * (`BuilderModeRules.formulaFields`, else its `fieldOptions` as fields of no particular
   * kind), or every data-holding leaf of the form but the node itself, labelled as the outline
   * labels them; the built-ins and the plugin functions the host wired; the parser's
   * signatures for them. Computed once per paint.
   */
  private formulaContext(nodeId: string | undefined): FormulaContext {
    const memo = this.formulaContextMemo;
    if (memo && memo.nodeId === nodeId) {
      return memo.context;
    }
    const controller = this.ctrl;
    const registry = this.formulaFunctionsValue;
    const functions = formulaFunctionRows(registry);
    const signatures = formulaSignatures(registry);
    const locale = controller?.currentLocale() ?? "en";
    let fields: FormulaField[] = [];
    const source = this.ruleSourceValue;
    if (controller && nodeId !== undefined) {
      if (source?.formulaFields) {
        fields = source.formulaFields(nodeId);
      } else if (source?.fieldOptions) {
        fields = source.fieldOptions(nodeId).map((choice) => ({ path: choice.value, label: choice.label, kind: "other", options: [] }));
      } else {
        const labels = new Map<string, string>();
        const walk = (entry: NestedTreeNodeView): void => {
          labels.set(entry.id, entry.label);
          for (const slot of entry.slots) {
            for (const child of slot.children) {
              walk(child);
            }
          }
        };
        walk(controller.treeView());
        fields = formulaFieldsOf(controller.snapshot(), { exclude: [nodeId], labelOf: (componentId) => labels.get(componentId), locale });
      }
    }
    const context: FormulaContext = { fields, functions, signatures, locale, ...(source ? { scopes: [] } : {}) };
    this.formulaContextMemo = { nodeId, context };
    return context;
  }

  /** The parse and the problems of `text` for a rule on `nodeId`, as the editor's lint words them. */
  private analyseFormula(nodeId: string, text: string): FormulaEditorState {
    const context = this.formulaContext(nodeId);
    return formulaEditorState(text, {
      fields: context.fields,
      signatures: context.signatures,
      scopes: context.scopes,
      locale: context.locale
    });
  }

  /** Takes down the JSON view's editor: the panel draws no body, or has left the page. */
  private unmountJsonViewer(): void {
    const current = this.jsonViewer;
    this.jsonViewer = undefined;
    current?.viewer.destroy();
  }

  /**
   * Lifts the JSON view's editor out ahead of a repaint, without taking it down, with where it
   * was scrolled to, whether it had focus and the node it showed — so the paint can put the
   * same editor back (see {@link mountJsonViewer}). While the editor's chunk loads, or if it
   * never does, the box is the plain textarea: its scroll offset is handed back the same way.
   */
  private liftJsonViewer(): LiftedJsonViewer | { nodeId: string | undefined; scrollTop: number } | undefined {
    const current = this.jsonViewer;
    if (!current) {
      const box = this.root.querySelector<HTMLTextAreaElement>("textarea[data-json-edit]:not([hidden])");
      return box ? { nodeId: this.jsonState?.nodeId, scrollTop: box.scrollTop } : undefined;
    }
    this.jsonViewer = undefined;
    const active = this.root.activeElement;
    return {
      viewer: current.viewer,
      nodeId: current.nodeId,
      host: current.host,
      scrollTop: current.viewer.scrollTop,
      hadFocus: current.viewer.hasFocus || (active !== null && current.host.contains(active))
    };
  }

  /**
   * Puts the JSON view's editor over the `<pre>` (read-only) or `<textarea>` (editable) the markup carries, when the paint produced one. The source stays in the DOM,
   * hidden, so the JSON is still there for anything that reads it from the markup; the
   * editor takes its place on screen. `previous` is the editor the paint lifted out: on the
   * same node it goes back in — its text set to what the box should hold, which is a no-op
   * when the author's typing is what repainted the panel — with its scroll offset and focus.
   * Otherwise it is taken down, and a fresh editor mounts once the chunk is loaded.
   */
  private mountJsonViewer(
    nodeId: string | undefined,
    previous: LiftedJsonViewer | { nodeId: string | undefined; scrollTop: number } | undefined
  ): void {
    const source = this.root.querySelector<HTMLElement>("[data-json-view]");
    const editable = source?.dataset.jsonEdit !== undefined;
    const lifted = previous && "viewer" in previous ? previous : undefined;
    if (lifted && source && lifted.nodeId === nodeId && lifted.viewer.editable === editable) {
      source.insertAdjacentElement("afterend", lifted.host);
      source.hidden = true;
      lifted.viewer.setText(editable ? (source as HTMLTextAreaElement).value : (source.textContent ?? ""));
      lifted.viewer.scrollTop = lifted.scrollTop;
      this.describeJsonViewer(source, lifted.viewer);
      this.jsonViewer = { viewer: lifted.viewer, nodeId, host: lifted.host };
      if (lifted.hadFocus) {
        lifted.viewer.focus();
      }
      return;
    }
    lifted?.viewer.destroy();
    if (!source) {
      return;
    }
    if (editable && previous && !lifted && previous.nodeId === nodeId) {
      source.scrollTop = previous.scrollTop;
    }
    const options: JsonViewerOptions = editable
      ? {
          label: source.getAttribute("aria-label") ?? this.words.text("inspector.jsonOf"),
          editable: true,
          onChange: (text) => {
            if (nodeId !== undefined) {
              this.applyJsonEdit(nodeId, text);
            }
          }
        }
      : { label: this.words.text("inspector.jsonReadOnly") };
    mountJsonViewerAfter(source, options, (viewer) => {
      if (previous && previous.nodeId === nodeId) {
        viewer.scrollTop = previous.scrollTop;
      }
      const host = viewer.dom.parentElement ?? viewer.dom;
      this.jsonViewer = { viewer, nodeId, host };
      this.describeJsonViewer(source, viewer);
    });
  }

  /** The editor says what its textarea says: whether the text applies, and the message that says why not. */
  private describeJsonViewer(source: HTMLElement, viewer: JsonViewer): void {
    for (const name of ["aria-invalid", "aria-describedby"]) {
      const value = source.getAttribute(name);
      if (value === null) {
        viewer.contentDom.removeAttribute(name);
      } else {
        viewer.contentDom.setAttribute(name, value);
      }
    }
  }

  /**
   * The JSON view's working state for `nodeId`, whose drafted node is `node`: kept while the
   * draft still gives what the box last agreed with, else started again from the draft — the
   * first look, another component, or a draft changed somewhere else.
   */
  private jsonWorking(nodeId: string, node: ComponentNode): JsonWorkingState {
    this.followController();
    const shown = componentJsonText(node);
    const state = this.jsonState;
    if (state && state.nodeId === nodeId && state.drafted === shown) {
      return state;
    }
    this.jsonState = { nodeId, text: shown, drafted: shown, problem: undefined };
    return this.jsonState;
  }

  /** Why the JSON view's text does not apply to `nodeId`, if the box holds text for it that does not. */
  private jsonProblem(nodeId: string): ComponentJsonProblem | undefined {
    const state = this.jsonState;
    const node = state && state.nodeId === nodeId && this.workingController === this.ctrl ? this.ctrl?.editedNode(nodeId) : undefined;
    return state && node && state.drafted === componentJsonText(node) ? state.problem : undefined;
  }

  /** Whether the JSON view may change `nodeId`'s id: as the Field tab's ID row may. */
  private jsonIdEditable(controller: BuilderController, nodeId: string): boolean {
    return nodeId !== controller.rootId() && (controller.idRow(nodeId)?.mode ?? "edit") === "edit";
  }

  /**
   * An edit in the JSON view: the text is kept as typed, and what it changes goes to
   * the draft — configuration keys set and removed one by one, then the rules, then the id —
   * so Apply, Discard and "Unsaved" cover it like any other edit. Text that does not parse, or
   * is not this component's JSON, writes nothing: the draft keeps the last text that applied,
   * and the problem is said under the box. The other tabs' working copies for the component
   * were made against the old values, so they go.
   */
  private applyJsonEdit(nodeId: string, text: string): void {
    const controller = this.ctrl;
    const node = controller && this.subjectId() === nodeId ? controller.editedNode(nodeId) : undefined;
    if (!controller || !node) {
      return;
    }
    const state = this.jsonWorking(nodeId, node);
    state.text = text;
    const read = readComponentJson(text, node, {
      idEditable: this.jsonIdEditable(controller, nodeId),
      knownFunctions: this.formulaContext(nodeId).functions.map((row) => row.name),
      // A setting the site manages is a note in the inspector, never a box: nor is it the text's to change.
      managed: this.managedSettingsValue
    });
    if (!read.ok) {
      state.problem = read.problem;
      this.paint();
      return;
    }
    state.problem = undefined;
    const changes = componentJsonChanges(node, read.value);
    if (!hasComponentJsonChanges(changes)) {
      this.paint();
      return;
    }
    // One paint for the lot, once the box's state says the draft is its own.
    this.suspendPaints();
    try {
      for (const { key, value } of changes.set) {
        controller.setDraftProperty(nodeId, key, value);
      }
      for (const key of changes.remove) {
        controller.setDraftProperty(nodeId, key, undefined);
      }
      if (changes.rules) {
        controller.setDraftRules(nodeId, changes.rules.value);
      }
      if (changes.id !== undefined) {
        controller.setDraftId(nodeId, changes.id);
      }
      // The other tabs' working copies of what changed were made against the old values.
      if (changes.rules) {
        this.rulesState = emptyRulesState("");
      }
      if (changes.set.length > 0 || changes.remove.length > 0) {
        this.expressionState = emptyExpressionState("");
      }
      const drafted = controller.editedNode(nodeId);
      state.drafted = drafted ? componentJsonText(drafted) : state.drafted;
    } finally {
      this.resumePaints();
    }
  }

  /** What the JSON view draws for `nodeId`: the box's text, its name, and why the text does not apply. */
  private jsonEditView(nodeId: string, node: ComponentNode, isRoot: boolean): JsonEditView {
    const state = this.jsonWorking(nodeId, node);
    return {
      text: state.text,
      label: isRoot ? this.words.text("inspector.jsonOfRoot", { name: this.settingsLabel.toLowerCase() }) : this.words.text("inspector.jsonOf"),
      problem: state.problem,
      hasChildren: Object.values(node.children ?? {}).some((slot) => slot.length > 0)
    };
  }

  /** Drops every working copy once the panel edits another controller's tree (see {@link workingController}). */
  private followController(): void {
    if (this.workingController === this.ctrl) {
      return;
    }
    this.workingController = this.ctrl;
    this.rulesState = emptyRulesState("");
    this.expressionState = emptyExpressionState("");
    this.jsonState = undefined;
    this.fileState = { nodeId: "", errors: new Map() };
  }

  /** The rules working state for the current selection, reset when the selection or the controller moves. */
  private rules(nodeId: string): RulesWorkingState {
    this.followController();
    if (this.rulesState.nodeId !== nodeId) {
      this.rulesState = emptyRulesState(nodeId);
    }
    return this.rulesState;
  }

  /** The expression-control working state for the current selection, reset when it or the controller moves (and see ExpressionWorkingState). */
  private expressions(nodeId: string): ExpressionWorkingState {
    this.followController();
    if (this.expressionState.nodeId !== nodeId) {
      this.expressionState = emptyExpressionState(nodeId);
    }
    return this.expressionState;
  }

  private fileErrors(nodeId: string): Map<string, string> {
    this.followController();
    if (this.fileState.nodeId !== nodeId) {
      this.fileState = { nodeId, errors: new Map() };
    }
    return this.fileState.errors;
  }

  /**
   * A `file` control's pick: the file becomes the attachment envelope embedded files use
   * (`{ storage: "base64", name, type, size, data }`) and lands on the draft, unless it is not
   * what the field accepts — then the row says so and the draft is left alone. An ICC profile
   * field checks the bytes themselves (the `acsp` signature), since a `.icc` extension proves
   * nothing. The input is reset so the same file can be picked again after a fix.
   */
  private async applyFileEdit(nodeId: string, path: string, input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }
    const errors = this.fileErrors(nodeId);
    const accept = readAcceptTokens(input.getAttribute("accept"));
    const refuse = (message: string): void => {
      errors.set(path, message);
      this.paint();
    };
    if (accept.length > 0 && !matchesAccept(file, accept)) {
      refuse(`"${file.name}" is not a file this property takes (${accept.join(", ")}).`);
      return;
    }
    let data: string;
    try {
      data = await encodeBase64(file);
    } catch (error) {
      refuse(`"${file.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (accept.some((token) => /icc/i.test(token)) && readIccColorSpace(base64ToBytes(data)) === undefined) {
      refuse(`"${file.name}" is not an ICC profile (no profile signature, or a colour space other than Gray, RGB or CMYK).`);
      return;
    }
    const envelope: Base64FileAttachment = { storage: "base64", name: file.name, type: file.type, size: file.size, data };
    // The file is embedded in the definition as base64: the one it replaces is counted out, and a
    // form that would pass the load limit with this one in is left as it is (it would never reopen).
    const bytesOf = (value: unknown): number => (value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length);
    const replaced = this.ctrl?.draftProperty(nodeId, path) as { storage?: unknown } | undefined;
    const heavy = embeddedBytesProblem(
      "file.embed.heavy",
      file.name,
      file.size,
      this.embedBudget?.(bytesOf(envelope) - (replaced?.storage === "base64" ? bytesOf(replaced) : 0)),
      this.wordsFor(undefined)
    );
    if (heavy !== undefined) {
      refuse(heavy);
      return;
    }
    errors.delete(path);
    this.ctrl?.setDraftProperty(nodeId, path, envelope);
  }

  /**
   * A `file` control's select: a ready-made value is written as its envelope, "None" clears
   * the property, and "Upload a file…" opens the row's picker (the select goes back to what is
   * set; the pick, if one comes, lands through `applyFileEdit`).
   */
  /**
   * A row of a value map changed: the object at `path` gets the row's entry set, or
   * removed on "Same value", and goes to the draft whole — and is removed when it becomes empty,
   * so a layout never carries `values: {}`. Save lands it as one undo step with the rest of the draft.
   */
  private applyValueMapEdit(nodeId: string, path: string, key: string, target: string): void {
    this.ctrl?.setDraftProperty(nodeId, path, valueMapWith(this.ctrl.draftProperty(nodeId, path), key, target));
  }

  /** "Match by order": the map the field offers (answer i to target i) replaces the draft's, in the one edit. */
  private applyValueMapOrder(nodeId: string, path: string): void {
    const field = this.ctrl
      ?.inspectorModel(nodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((entry) => entry.propertyPath === path && entry.control === "value-map");
    const byOrder = field?.valueMap?.byOrder;
    if (byOrder) {
      this.ctrl?.setDraftProperty(nodeId, path, Object.keys(byOrder).length > 0 ? { ...byOrder } : undefined);
    }
  }

  /**
   * A choice in the Format box, or a click on its suggestion: the preset's pattern, and
   * a default message where the component has none, go to the draft; "Any text" takes them away.
   * Save lands the pair as one undo step with the rest of the draft, and nothing is written until
   * the author chooses: the Email keyboard alone only makes the suggestion appear.
   */
  private applyPatternPreset(nodeId: string, choice: string): void {
    const node = this.ctrl?.editedNode(nodeId);
    if (!this.ctrl || !node) {
      return;
    }
    for (const write of patternPresetWrites(node, choice)) {
      this.ctrl.setDraftProperty(nodeId, write.path, write.value);
    }
  }

  /**
   * "Remove stale entries": the entries the field names as matching nothing now leave the draft's
   * map in the one edit (the others stay; the map goes when none is left). Nothing else prunes
   * them, and nothing here is deleted without the author pressing it.
   */
  private applyValueMapStale(nodeId: string, path: string): void {
    const field = this.ctrl
      ?.inspectorModel(nodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((entry) => entry.propertyPath === path && entry.control === "value-map");
    const stale = field?.valueMap?.stale;
    if (stale && stale.length > 0) {
      this.ctrl?.setDraftProperty(nodeId, path, valueMapWithout(this.ctrl.draftProperty(nodeId, path), stale));
    }
  }

  private applyFileChoice(nodeId: string, path: string, select: HTMLSelectElement): void {
    const value = select.value;
    if (value === FILE_CHOICE_UPLOAD) {
      // No repaint here: the picker's `change` must reach the input that opened the dialog,
      // which a repaint would replace. The select goes back to what is set by itself.
      select.value = [...select.options].find((option) => option.defaultSelected)?.value ?? FILE_CHOICE_NONE;
      select.closest("[data-file-row]")?.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      return;
    }
    this.fileErrors(nodeId).delete(path);
    if (value === FILE_CHOICE_NONE) {
      this.ctrl?.setDraftProperty(nodeId, path, undefined);
      return;
    }
    const field = this.ctrl
      ?.inspectorModel(nodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((entry) => entry.propertyPath === path);
    const choice = field?.assetChoices?.find((entry) => entry.id === value);
    if (choice) {
      this.ctrl?.setDraftProperty(nodeId, path, { ...choice.source });
    }
  }

  /**
   * Everything this panel draws about its subject, cheap enough to compute per change: the
   * edited node, the errors hanging off it and, on the root, the definition-level blocks that
   * ride its draft. An `edit` that leaves all of it alone was an edit to some *other*
   * component — the Form panel sits on the root while a field's label is typed — and this
   * panel need not compose an inspector model to discover that.
   */
  private subjectStateKeys(): { full: string; clean: string } | undefined {
    const controller = this.ctrl;
    const id = this.subjectId();
    if (!controller || id === undefined) {
      return undefined;
    }
    const isRoot = id === controller.rootId();
    // The parts a live text write moves: the node as drafted (the box holds it already), whether
    // anything is waiting to be applied (the footer is refreshed in place instead) and the
    // leave prompt.
    const dirty = JSON.stringify([controller.editedNode(id), controller.hasPendingChanges(id), controller.unsavedChangesPrompt()]);
    const clean = JSON.stringify([
      id,
      // This panel's own component's problems — another's never repaint it (nor hold its Save).
      controller.problemsOf(id),
      this.riskyPatternOf(id) ?? null,
      // What holds Apply back and the advice under Label: a keystroke that
      // makes or mends one repaints this panel, so the message under the box comes and goes.
      this.applyBlockersOf(id),
      this.warningsOf(id),
      controller.cssClassWarningOf(id),
      isRoot ? controller.draftIdentity() : null,
      // The pointer line under the texts: the languages the form declares and which
      // map the coverage was read from (an identity, so no walk of the map per keystroke).
      this.translationCoverageKey(controller),
      // Another mode's rows ride the root's draft too.
      isRoot
        ? this.shownModeSettings().map((group) => group.rows.map((row) => [row.id, controller.draftRootSetting(row)]))
        : null,
      // Where the answer is stored moves with a data key, its own or a container's above it.
      isRoot ? null : controller.dataPathOf(id)
    ]);
    return { full: `${clean}\n${dirty}`, clean };
  }

  /**
   * What this panel draws of how its subject is drawn on the canvas (the adapter line, the
   * settings the binding does not draw): compared against what the last paint drew, so a canvas
   * that drew again with the same answers repaints nothing.
   */
  private drawingKey(): string {
    const controller = this.ctrl;
    const id = this.subjectId();
    return JSON.stringify([controller?.drawnByLine(id) ?? null, controller !== undefined && id !== undefined ? (controller.drawingOf(id)?.answers ?? null) : null]);
  }

  /** What {@link drawingKey} said when the panel was last painted. */
  private paintedDrawingKey: string | undefined;

  protected override onDrawingChange(): void {
    if (this.drawingKey() !== this.paintedDrawingKey) {
      this.paint();
    }
  }

  protected override onControllerChange(reason: BuilderChangeReason, event?: BuilderChangeEvent): void {
    if (reason === "edit") {
      const keys = this.subjectStateKeys();
      const key = keys?.full;
      if (key !== undefined && key === this.subjectKey) {
        return;
      }
      // An Undo or a Redo that changed the subject put back values the text typed in its
      // expression boxes was not made against: the boxes show what the step left.
      if (event?.historyStep) {
        this.expressionState = emptyExpressionState("");
      }
      const typing = this.liveBoxWrite;
      if (event?.live && typing && typing.nodeId === this.subjectId() && key !== undefined && this.subjectKey !== undefined && keys?.clean === this.subjectKeyClean) {
        // This panel's own keystroke in a plain box: only whether something is waiting to be
        // applied moved. The footer (Apply, Discard, Not applied) is refreshed in place; the
        // typed box is never replaced and nothing is painted.
        this.subjectKey = key;
        // The footer reads only the pending flag (the problems are in the key): redrawn when
        // the flag moved, not on every keystroke.
        if (!!this.ctrl?.hasPendingChanges(typing.nodeId) !== this.footerDirty) {
          this.refreshFooterLive(typing.nodeId);
        }
        return;
      }
      const live = this.liveRuleWrite;
      if (event?.live && live && live.nodeId === this.subjectId()) {
        // This panel's own keystroke in a formula box (see applyFormulaEdit): the draft now
        // holds the text. What the rule says about it and the footer are refreshed in place;
        // the box and the editor over it are not touched, and nothing is painted. The next
        // change is compared against the state this one left.
        this.subjectKey = key;
        this.refreshRuleLive(live.nodeId, live.key);
        return;
      }
    }
    this.paint();
  }

  protected render(): void {
    const isRootPanel = this.subjectValue === "root";
    this.paintedDrawingKey = this.drawingKey();
    const subjectKeys = this.subjectStateKeys();
    this.subjectKey = subjectKeys?.full;
    this.subjectKeyClean = subjectKeys?.clean;
    // What a formula may read is computed once per paint, over the tree as it now stands.
    this.formulaContextMemo = undefined;
    if (
      !isRootPanel &&
      this.collapsed &&
      !this.promptsElsewhereValue &&
      this.ctrl?.unsavedChangesPrompt() &&
      !this.ctrl.unsavedChangesPrompt()?.external
    ) {
      // The prompt has to be seen to be answered, so a rail the author folded away comes
      // back. Toggling re-renders (and tells the wrapper), so this paint is done.
      this.toggleCollapsed();
      return;
    }
    // A root panel is shown and hidden by its strip item, so it never folds to the stub.
    if (this.collapsed && !isRootPanel) {
      this.unmountJsonViewer();
      this.unmountFormulaEditors();
      if (
        this.writeMarkup(`<style>${builderTokens()}${INSPECTOR_STUB_STYLES}</style>
        <div class="panel panel--stub" style="width:44px;display:grid;justify-items:center">
          <button class="icon-btn" data-panel-toggle data-tip-side="start" data-tip="${esc(this.words.text("inspector.showProperties"))}" aria-label="${esc(this.words.text("inspector.showProperties"))}">${renderIcon(this.iconSet(), "properties-panel")}</button>
        </div>`)
      ) {
        this.bind();
      }
      return;
    }
    const controller = this.ctrl;
    const committedId = this.subjectId();
    // Nothing for this panel to inspect — no selection, or the root, which is the Form
    // panel's. The inspector draws nothing and the shell takes its column away.
    if (!isRootPanel && committedId === undefined) {
      // Nothing to draw. The delegated listeners stay on the shadow root — `bound` must not
      // be cleared, or the next paint would attach a second set of them.
      this.unmountJsonViewer();
      this.unmountFormulaEditors();
      this.writeMarkup("");
      // The component the tab was chosen for was deleted: whatever is selected next is another.
      const chosenFor = this.tabSubject;
      if (chosenFor?.id !== undefined && chosenFor.controller === controller && controller?.editedNode(chosenFor.id) === undefined) {
        this.tab = "properties";
        this.tabSubject = undefined;
      }
      return;
    }
    // Another component opens on the Field tab (see tabSubject). One renamed by its
    // own Save is no longer in the tree under its old id, and keeps the tab it was saved from.
    const chosenFor = this.tabSubject;
    if (!isRootPanel && (chosenFor === undefined || chosenFor.id !== committedId || chosenFor.controller !== controller)) {
      const renamed = chosenFor !== undefined && chosenFor.id !== undefined && chosenFor.controller === controller && controller?.editedNode(chosenFor.id) === undefined;
      if (chosenFor !== undefined && !renamed) {
        this.tab = "properties";
      }
      this.tabSubject = { controller, id: committedId };
    }
    // The boxes the panel draws: the model without the settings the canvas's binding does not
    // draw. The complete model is what the checks read, as the agent does.
    const completeModel = controller?.inspectorModel(committedId);
    const model = drawnModel(completeModel);
    // The edited node — this panel's subject with its uncommitted draft applied: what Save
    // would write, and therefore what the panel must show. `selectedNode()` stays the
    // committed selection.
    const node = controller?.editedNode(committedId);
    const isRoot = !!controller && committedId === controller.rootId();
    const focusSnapshot = this.captureFocus();
    // A subject offered no rules (a mode's rules are per node type) has no Rules
    // tab; a panel left on it moves to Properties, as it does for a mode that keeps none.
    const hasRules = this.subjectHasRules();
    if (!this.tabShown(this.tab)) {
      this.tab = "properties";
    }

    // The controller holds a click-away while a component's edits are unsaved; the panel
    // showing that component is where the author answers it — with two panels open, each
    // draws only the prompt that names its own subject. One overlay at a time: an author who
    // clicked away has moved past the delete question, so a pending delete yields to the
    // prompt. A hold for a leave guard's edits (a mode's own editor, see `LeaveGuard`) is
    // that editor's to draw.
    const held = controller?.unsavedChangesPrompt();
    // What holds this component's Save back: the controller's reading of the draft, and what
    // this panel could not read (an expression or a rule that does not parse).
    const problems = controller && committedId !== undefined ? this.panelProblems(controller, committedId, completeModel) : [];
    if (problems.length < 2) {
      this.problemListOpen = false;
    }
    const prompt =
      held && controller && !held.external && held.componentId === committedId && !this.promptsElsewhereValue
        ? describeUnsavedChanges(controller, held, this.localProblems(committedId, completeModel).map((problem) => problem.message))
        : undefined;
    if (prompt) {
      this.pendingDeleteId = undefined;
    }
    const pending = this.pendingDeleteId
      ? describeDelete(controller, this.pendingDeleteId, this.wordsFor(undefined))
      : undefined;
    if (this.pendingDeleteId && !pending) {
      this.pendingDeleteId = undefined;
    }

    // No heading on the inspector: the tabs — Properties / Rules / JSON — already say what
    // the panel is, and the word repeated above them only cost a row. No collapse control
    // either: a drawer that comes and goes with the selection needs no fold of
    // its own; the stub below stays for the narrow layout and for a host that folds it. The
    // Form panel has no tabs, so it gets a head naming what it edits, like the palette's.
    // A structural change to the options editor (a row added, removed or moved) repaints the
    // dialog; its geometry is read back first so a moved or resized window stays where it is.
    this.captureOptionsFrame();

    // The definition's identity rides the root's draft — but only when the host handed the
    // builder one to edit; otherwise the identity is the host's alone.
    const draftIdentity =
      controller && isRoot && this.primaryValue ? controller.draftIdentity() : undefined;

    const markup = `
      <style>${builderTokens()}${PROPERTIES_STYLES}${OPTIONS_EDITOR_STYLES}${PANEL_TITLE_STYLES}${this.modeActionsValue.length > 0 ? INSPECTOR_MODE_ACTION_STYLES : ""}${this.modeFindingsValue.length > 0 ? MODE_FINDINGS_STYLES : ""}${this.modeChoicesValue.length > 0 ? MODE_CHOICE_STYLES : ""}</style>
      <div class="panel">
        <div class="inspector-top">
        ${
          isRootPanel
            ? `<div class="panel-head inspector-head"><h2 class="panel-title"><strong>${esc(this.settingsLabel)}</strong></h2></div>`
            : node
              ? `<div class="inspector-title" data-inspector-title><strong>${esc(this.nodeLabel(node))}</strong><span>${esc(this.typeLabel(node.type))}</span></div>`
              : ""
        }
        <div class="inspector-tabs">
          <div class="inspector-tablist" role="tablist" aria-label="${esc(this.words.text("inspector.tabs"))}">
          ${this.inspectorTabs().map((tab) => {
            const count = tab.id === "rules" ? (this.waysOf(committedId)?.rows.filter((way) => way.open).length ?? this.ruleCount(node)) : 0;
            // The visible "Rules 2" (the space keeps the label and the badge two words, WCAG 2.5.3 Label in
            // Name; the tab is an inline-flex box, so it draws nothing) sits in order inside "Rules, 2 rules".
            const name = count > 0 ? this.words.plural("inspector.tabRules", count, { label: tab.label }) : tab.label;
            return `<button type="button" role="tab" class="inspector-tab ${this.tab === tab.id ? "active" : ""}" data-inspector-tab="${tab.id}" aria-selected="${this.tab === tab.id}"${
              name !== tab.label ? ` aria-label="${esc(name)}"` : ""
            }>${esc(tab.label)}${count > 0 ? ` <span class="inspector-tab-count" aria-hidden="true">${count}</span>` : ""}</button>`;
          }).join("")}
          </div>
          ${
            // The ⋯ menu holds the JSON view alone: without the `json` feature there is no menu.
            this.inspectorFeaturesValue.json
              ? `<button type="button" class="inspector-tab inspector-more${this.tab === "json" ? " active" : ""}" data-inspector-more aria-haspopup="menu"
            aria-expanded="${this.inspectorMenuOpen}" aria-controls="inspector-menu" aria-label="${esc(this.words.text("inspector.more"))}" data-tip="${esc(this.words.text("inspector.more"))}">${MORE_GLYPH}</button>
          <div class="menu inspector-menu" id="inspector-menu" role="menu" data-inspector-menu${this.inspectorMenuOpen ? "" : " hidden"}>
            <button type="button" class="menu-item" role="menuitem" data-inspector-tab="json">${esc(this.words.text("inspector.editJson"))}</button>
          </div>`
              : ""
          }
        </div>
        <div class="inspector-filter">
          <input type="search" data-property-filter placeholder="${esc(this.words.text("inspector.filter.placeholder"))}"
            aria-label="${esc(this.words.text("inspector.filter.label"))}" value="${esc(this.propertyFilter)}" />
        </div>
        </div>
        <div class="inspector-body">
          ${this.findingsCardHtml()}${this.choicesHtml()}
          ${this.withModeActions(this.presetSuggestionButton(node, propertiesPanelHtml(this.shownModel(model), node, {
            ...(controller && committedId !== undefined ? { translationCoverage: this.translationCoverage(controller, committedId) } : {}),
            openInLanguages: this.languagesWorkspaceValue,
            parts: this.inspectorParts(),
            managedSettings: this.managedSettingsValue,
            tab: this.tab,
            words: this.wordsFor(undefined),
            splitStyle: this.inspectorTabs().some((entry) => entry.id === "style"),
            treeView: controller?.treeView() ?? EMPTY_TREE_VIEW,
            hiddenIds: new Set<string>(),
            problems,
            idEditable: !!controller && !isRoot,
            // The component id is an advanced field: without that feature the row is not drawn.
            idRow: this.inspectorFeaturesValue.advancedFields ? controller?.idRow(committedId) : { ...controller?.idRow(committedId), mode: "hidden" as const },
            isRoot,
            openHelp: this.openHelp,
            collapsedSections: this.collapsedSections,
            openedSections: this.openedSections,
            // What the tree's owner notes about the component: advisory, beside the problems;
            // then the advice under Label, read with the box and never counted.
            notes: [
              ...(controller?.notesOf(committedId) ?? []),
              ...(committedId !== undefined ? this.warningsOf(committedId).map((warning) => ({ target: warning.fieldId, message: warning.message, severity: "warning" as const })) : [])
            ],
            // A line above the sections when a rule calculates the answer.
            ...(node ? { hints: inspectorHints(node, this.wordsFor(undefined)).map((hint) => hint.message) } : {}),
            // Which adapter the canvas drew it with: the binding's, its base's, Datum's behind it.
            ...(controller?.drawnByLine(committedId) !== undefined ? { drawnBy: controller.drawnByLine(committedId) } : {}),
            cssClassWarning: controller?.cssClassWarningOf(committedId),
            ...(this.tab === "style" && controller && node
              ? {
                  styleOptions: {
                    choices: controller.styleOptions(committedId),
                    active: cssClassTokens((node.configuration as Record<string, unknown> | undefined)?.cssClass)
                  }
                }
              : {}),
            // A PDF layout's components store no answers: no Saved as line, and ID help that says so.
            formTree: this.primaryValue,
            ...(!isRootPanel && controller && committedId && this.primaryValue && this.inspectorFeaturesValue.advancedFields
              ? { dataPath: controller.dataPathOf(committedId) }
              : {}),
            ...(committedId
              ? {
                  expressionDrafts: this.expressions(committedId).texts,
                  expressionErrors: this.expressions(committedId).errors,
                  fileErrors: this.fileErrors(committedId)
                }
              : {}),
            ...(committedId && controller && node && hasRules
              ? { rules: this.rulesTabOptions(controller, committedId, node.type) }
              : {}),
            // The Field tab's own formula boxes (a `formula` control), drawn with the Rules tab's feedback.
            ...(committedId && controller && node && this.tab !== "rules" ? { formulas: this.fieldFormulaViews(controller, committedId) } : {}),
            // The JSON view edits what the draft holds.
            ...(this.tab === "json" && committedId !== undefined && controller && node
              ? { jsonEdit: this.jsonEditView(committedId, node, isRoot) }
              : {}),
            ...(draftIdentity ? { identity: { value: draftIdentity, problems: controller?.identityProblems() ?? {} } } : {}),
            // What the form does with a formula it cannot read (Formulas), drafted on the root.
            ...(controller && isRoot && this.primaryValue
              ? {
                  formulaSettings: {
                    value: formulaErrorsOf(controller.draftProperty(controller.rootId(), "formulaErrors")),
                    texts: this.wordsFor(undefined)
                  }
                }
              : {}),
            // Whether assistants in the browser may fill the form (Browser assistants), drafted on the root.
            ...(controller && isRoot && this.primaryValue
              ? {
                  assistantsSettings: {
                    value: assistantsChoiceOf(controller.draftProperty(controller.rootId(), "agentTools")),
                    managed: this.managedSettingsValue.includes("agentTools"),
                    texts: this.wordsFor(undefined)
                  }
                }
              : {}),
            // Other modes' rows on the form's settings, drafted on the root.
            ...(controller && isRoot && this.shownModeSettings().length > 0
              ? {
                  modeSettings: this.shownModeSettings().map((group) => ({
                    mode: group.mode,
                    title: group.title,
                    rows: group.rows.map((row) => ({
                      id: row.id,
                      label: row.label,
                      description: row.description,
                      choices: row.choices,
                      value: controller.draftRootSetting(row),
                      note: row.note,
                      open: row.open
                    })),
                    // Said, not chosen: read afresh on every paint, never drafted.
                    ...(group.readOnlyRows && group.readOnlyRows.length > 0
                      ? { readOnlyRows: group.readOnlyRows.map((row) => ({ id: row.id, label: row.label, note: row.note, open: row.open })) }
                      : {})
                  }))
                }
              : {})
          })))}
        </div>
        ${this.footerHtml(controller, committedId, node, isRoot, problems)}
        <div class="sr-status" role="status" aria-live="polite" data-inspector-status></div>
        ${prompt ? unsavedChangesPromptHtml(prompt, this.wordsFor(undefined)) : deleteConfirmHtml(pending, this.wordsFor(undefined))}
        ${this.optionsEditor ? optionsEditorHtml({ ...this.optionsEditor, words: this.wordsFor(undefined) }) + this.optionsDiscardHtml() : ""}
      </div>`;
    if (markup === this.shownMarkup()) {
      // Nothing this panel draws moved. The Form panel sits on the root while an author
      // types into a field's inspector, and every one of those keystrokes reaches it.
      // A live write may have redrawn the footer in place since this markup went in
      // (refreshFooterLive): an Escape or a Discard that takes the draft back to what was
      // painted puts the footer back too, rather than leaving "Not applied" and a live Apply
      // over a box that has nothing to apply.
      if (this.footerRedrawn && committedId !== undefined) {
        this.refreshFooterLive(committedId);
        this.footerRedrawn = false;
      }
      return;
    }
    this.footerRedrawn = false;
    // The markup is about to be replaced; the JSON editor living in it is lifted out first,
    // to go back into the new markup's place for it.
    const jsonLifted = this.liftJsonViewer();
    // The Logic tab's formula editors the same way (the textareas under them are fresh after the write).
    const formulaLifted = this.liftFormulaEditors();
    // The body is a fresh element after the write: on the same subject and tab it is put back
    // where the author had scrolled it — a choice that commits at once (Opens as)
    // repaints the panel under the control still in their hand. Before focus is put back, so
    // focusing the control scrolls nothing.
    const view = JSON.stringify([committedId ?? null, this.tab]);
    const scrollTop = view === this.paintedView ? this.root.querySelector<HTMLElement>(".inspector-body")?.scrollTop : undefined;
    this.paintedView = view;
    this.writeMarkup(markup);
    if (scrollTop) {
      const body = this.root.querySelector<HTMLElement>(".inspector-body");
      if (body) {
        body.scrollTop = scrollTop;
      }
    }
    this.bind();
    this.restoreFocus(focusSnapshot);
    this.placeFindingFocus();
    this.applyPropertyFilter();
    this.mountJsonViewer(node?.id, jsonLifted);
    this.mountFormulaEditors(node?.id, formulaLifted);
    this.openPrompt();
    this.openOptionsEditor();
  }

  // --- inline options editor ------------------------------------------------

  /**
   * Shows the keyed-text dialog that is up — the options editor —
   * modally, like the prompts (see {@link openPrompt}): the dialog is a fresh element after
   * every repaint, so this runs after each one. Escape — the browser's close request — is
   * Cancel.
   */
  private openOptionsEditor(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-options-dialog]");
    if (!dialog) {
      return;
    }
    // Focus goes to the key box.
    openDialogModally(
      dialog,
      this.root,
      "[data-options-new='value']",
      () => this.escapeActiveDialog()
    );
    // The discard question, over the options dialog (shown after it, so it is the top one).
    const discard = this.root.querySelector<HTMLDialogElement>("dialog[data-options-discard-prompt]");
    if (!discard) {
      return;
    }
    if (typeof discard.showModal === "function") {
      if (!discard.open) {
        showBuilderModal(discard);
      }
    } else {
      discard.setAttribute("open", "");
    }
    // Escape here is Keep editing: a second Escape never discards.
    discard.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.keepEditingOptions();
    });
    if (!discard.contains(this.root.activeElement)) {
      discard.querySelector<HTMLElement>("[autofocus]")?.focus();
    }
  }

  /**
   * The options dialog's discard question, in the same modal `<dialog>` as the
   * panel's other confirmations; `""` when it is not asked. Focus lands on Keep editing.
   */
  private optionsDiscardHtml(): string {
    const pending = this.optionsDiscard;
    if (!pending || !this.optionsEditor) {
      return "";
    }
    return `<dialog class="db-confirm" role="alertdialog" aria-labelledby="options-discard-title" aria-describedby="options-discard-body" data-options-discard-prompt>
        <h4 id="options-discard-title">${esc(this.words.plural("optionsEditor.discard.title", pending.count))}</h4>
        <p id="options-discard-body">${esc(this.words.text("optionsEditor.discard.body"))}</p>
        <div class="db-confirm-actions">
          <button type="button" class="btn" data-options-discard-keep autofocus>${esc(this.words.text("optionsEditor.discard.keep"))}</button>
          <button type="button" class="btn danger" data-options-discard-confirm>${esc(this.words.text("common.discard"))}</button>
        </div>
      </dialog>`;
  }

  /**
   * Escape on a keyed-text dialog. The options dialog with changes asks first:
   * Escape is the easiest key to press by accident, and it took every typed row with it.
   * Nothing changed: it closes, as Cancel does.
   */
  private escapeActiveDialog(): void {
    const editor = this.optionsEditor;
    if (!editor) {
      this.closeActiveDialog();
      return;
    }
    if (this.optionsDiscard) {
      this.keepEditingOptions();
      return;
    }
    const count = optionsDialogChangeCount(editor);
    if (count === 0) {
      this.closeOptionsEditor();
      return;
    }
    this.captureOptionsFrame();
    this.optionsDiscard = { count, focus: this.captureFocus() };
    this.paint();
  }

  /** Keep editing: the question goes, and focus goes back to the control the author was on. */
  private keepEditingOptions(): void {
    const pending = this.optionsDiscard;
    if (!pending) {
      return;
    }
    this.optionsDiscard = undefined;
    this.paint();
    this.restoreFocus(pending.focus);
  }

  /** The keyed-text dialog that is up, for its frame (drag, resize, maximize). */
  private activeDialog(): { maximized: boolean; frame?: OptionsEditorFrame | undefined } | undefined {
    return this.optionsEditor;
  }

  private closeActiveDialog(): void {
    if (this.optionsEditor) {
      this.closeOptionsEditor();
    }
  }

  // --- pointer to Languages ---------------------------------------------------

  /**
   * The identity numbers of the translation maps (and catalogs) already seen, so the panel's change
   * key can say "the map is another one" without walking it (the controller replaces the map on
   * every write).
   */
  private static readonly mapIds = new WeakMap<object, number>();
  private static nextMapId = 0;

  /**
   * What the pointer line under the texts is drawn from, as a cheap key:
   * the languages the form declares and which map and catalog the coverage reads. Empty for a tree that is
   * not the form's own, and when the `translations` feature is off.
   */
  private identityOf(value: object | undefined): number {
    if (!value) {
      return 0;
    }
    const known = DatumBuilderPropertiesElement.mapIds.get(value);
    const id = known ?? (DatumBuilderPropertiesElement.nextMapId += 1);
    DatumBuilderPropertiesElement.mapIds.set(value, id);
    return id;
  }

  private translationCoverageKey(controller: BuilderController): string {
    if (!this.primaryValue || !this.inspectorFeaturesValue.translations) {
      return "";
    }
    return JSON.stringify([
      supportedLocaleCodes(controller.localization()),
      this.identityOf(controller.translations()),
      // The page's catalog counts in the figures too: another one is another line.
      this.identityOf(controller.translationCatalog()),
      this.languagesWorkspaceValue
    ]);
  }

  /**
   * How well the component's texts are translated, one entry per language besides the default
   * (the pointer line). The counts are the Languages workspace's own
   * (`translationCoverageOf`), so a text the host's catalog words counts as translated here
   * as it does in the grid. Empty when the form declares one language, for a tree that is not
   * the form's own, when the `translations` feature is off, or when the component has no text to
   * translate. Read from the committed form, as the Languages workspace reads it.
   */
  private translationCoverage(controller: BuilderController, nodeId: string): TranslationCoverageEntry[] {
    if (!this.primaryValue || !this.inspectorFeaturesValue.translations) {
      return [];
    }
    return translationCoverageOf(controller, (row) => row.componentId === nodeId);
  }

  /** Opens the editor on the inspected component's drafted options for `path`. */
  private startOptionsEditor(path: string): void {
    const controller = this.ctrl;
    const nodeId = this.subjectId();
    if (!controller || !nodeId) {
      return;
    }
    const field = controller
      .inspectorModel(nodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((candidate) => candidate.propertyPath === path);
    const options = parseInlineOptions(controller.draftProperty(nodeId, path));
    const label = labelText(controller.draftProperty(nodeId, "label"));
    const rows = options.map(DatumBuilderPropertiesElement.optionRow);
    this.optionsDiscard = undefined;
    this.optionsEditor = {
      nodeId,
      path,
      title: this.words.text("optionsEditor.titleOptions", { name: label && label.length > 0 ? label : nodeId }),
      rows,
      opened: structuredClone(rows),
      newValue: "",
      newLabel: "",
      error: undefined,
      sourceId: field?.optionsEditor?.sourceId,
      // The Description columns open by themselves when an option already has one.
      showDescriptions: options.some((option) => option.description !== undefined),
      maximized: false
    };
    this.paint();
  }

  /** One inline option as the editor works on it: its label and description, in the default language. */
  private static optionRow(option: InlineOption): OptionsEditorRow {
    const row: OptionsEditorRow = { value: option.value, label: option.label };
    if (option.description !== undefined) {
      row.description = option.description;
    }
    return row;
  }

  /**
   * Opens the same editor on the inspected component's drafted validation messages for
   * `path`: one row per code, the message as its text. On the form root the
   * messages are the form's defaults; on a field, that field's own wording.
   */
  private startMessagesEditor(path: string): void {
    const controller = this.ctrl;
    const nodeId = this.subjectId();
    if (!controller || !nodeId) {
      return;
    }
    const field = controller
      .inspectorModel(nodeId)
      ?.sections.flatMap((section) => section.fields)
      .find((candidate) => candidate.propertyPath === path);
    const catalog = authoredMessages(controller.draftProperty(nodeId, path));
    const isRoot = nodeId === controller.rootId();
    const label = isRoot ? undefined : labelText(controller.draftProperty(nodeId, "label"));
    // Every code the component's checks raise is a row (the whole form's on the root), in
    // the order the constraints declare them, whether or not it has wording yet; what the
    // author added beyond those follows. A known code carries its meaning beside it.
    const editorModel = field?.messagesEditor;
    const meanings = new Map(
      [...(editorModel?.usedCodes ?? []), ...(editorModel?.engineCodes ?? []), ...(editorModel?.hostCodes ?? [])].map((entry) => [entry.code, entry.label])
    );
    const rowFor = (code: string, seeded: boolean): OptionsEditorRow => {
      const row: OptionsEditorRow = { value: code, label: catalog[code] ?? "" };
      const meaning = meanings.get(code);
      if (meaning !== undefined) {
        row.meaning = meaning;
      }
      if (seeded) {
        row.seeded = true;
      }
      // The page's own wording, if it words this code: the cells' placeholders, and what
      // "Use default" copies in.
      const pageText = editorModel?.defaults[code];
      if (pageText !== undefined) {
        // The page's catalog is host data: its wording in the form's language is the fallback shown.
        row.fallback = { default: resolveLocalizedText(pageText, controller.currentLocale()) ?? "" };
      }
      return row;
    };
    const seededCodes = (editorModel?.usedCodes ?? []).map((entry) => entry.code);
    const rows = [
      ...seededCodes.map((code) => rowFor(code, true)),
      ...Object.keys(catalog)
        .filter((code) => !seededCodes.includes(code))
        .map((code) => rowFor(code, false))
    ];
    this.optionsDiscard = undefined;
    this.optionsEditor = {
      nodeId,
      kind: "messages",
      path,
      title: this.words.text("optionsEditor.titleMessages", {
        name: isRoot ? this.words.text("shell.panel.form.short") : label && label.length > 0 ? label : nodeId
      }),
      rows,
      opened: structuredClone(rows),
      newValue: "",
      newLabel: "",
      error: undefined,
      sourceId: undefined,
      suggestions: DatumBuilderPropertiesElement.messageCodeGroups(field?.messagesEditor, this.wordsFor(undefined)),
      maximized: false
    };
    this.paint();
  }

  /**
   * The code chips the messages editor offers: the codes beyond what the
   * component's own checks raise — those are rows already. On the form, the engine's other
   * codes and the page's, in view; on a field, all of them behind a "more" disclosure.
   */
  private static messageCodeGroups(
    editor: InspectorField["messagesEditor"] | undefined,
    words?: BuilderTextOptions
  ): OptionsEditorSuggestionGroup[] {
    if (!editor) {
      return [];
    }
    const chips = (codes: ReadonlyArray<{ code: string; label: string; parameters: readonly string[] }>) =>
      codes.map((entry) => ({ value: entry.code, label: entry.label, parameters: entry.parameters }));
    if (editor.scope === "form") {
      return [
        { title: builderText("optionsEditor.group.engine", undefined, words), suggestions: chips(editor.engineCodes) },
        { title: builderText("optionsEditor.group.page", undefined, words), suggestions: chips(editor.hostCodes) }
      ];
    }
    return [{ title: builderText("optionsEditor.group.other", undefined, words), suggestions: chips([...editor.engineCodes, ...editor.hostCodes]), collapsed: true }];
  }

  /** Which button opened an options or messages editor. */
  private static optionsOpener(editor: { kind?: string | undefined; path: string }): { attribute: "data-options-edit" | "data-messages-edit"; path: string } {
    return { attribute: editor.kind === "messages" ? "data-messages-edit" : "data-options-edit", path: editor.path };
  }

  /**
   * Focus back on the button that opened the editor, so a keyboard user is not dropped at the
   * top of the panel. That very button (its own attribute and path), not the first opener in
   * the panel.
   * The panel keeps its scroll across the repaint; focus must not move it either.
   */
  private focusEditorOpener(opener: { attribute: "data-options-edit" | "data-messages-edit"; path?: string | undefined }): void {
    const target = [...this.root.querySelectorAll<HTMLElement>(`[${opener.attribute}]`)].find(
      (button) => opener.path === undefined || button.getAttribute(opener.attribute) === opener.path
    );
    target?.focus({ preventScroll: true });
  }

  private closeOptionsEditor(): void {
    const editor = this.optionsEditor;
    if (!editor) {
      return;
    }
    this.optionsEditor = undefined;
    this.optionsDiscard = undefined;
    this.paint();
    this.focusEditorOpener(DatumBuilderPropertiesElement.optionsOpener(editor));
  }

  /**
   * Rows as the schema stores validation messages: a map from code to its default-language
   * text. `undefined` for no rows, so an emptied editor leaves no `messages: {}` behind.
   */
  private static messagesToSchema(rows: readonly OptionsEditorRow[]): Record<string, string> | undefined {
    // A raised code listed without wording is not an entry: the page's or engine's text applies.
    const worded = rows.filter((row) => optionsRowHasText(row));
    if (worded.length === 0) {
      return undefined;
    }
    const catalog: Record<string, string> = {};
    for (const row of worded) {
      // Defined, not assigned: a code named `__proto__` is an entry, not a prototype.
      Object.defineProperty(catalog, row.value.trim(), { value: row.label.trim(), enumerable: true, writable: true, configurable: true });
    }
    return catalog;
  }

  /** Why the message rows cannot be applied as they stand, or `undefined` when they can. */
  private static messagesProblem(rows: readonly OptionsEditorRow[], words?: BuilderTextOptions): string | undefined {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const code = row.value.trim();
      if (code.length === 0) {
        return builderText("optionsEditor.err.messageNoCode", { n: index + 1 }, words);
      }
      if (seen.has(code)) {
        return builderText("optionsEditor.err.codeDup", { code }, words);
      }
      // A raised code may sit blank (the default wording applies); a code the author added must say something.
      if (row.label.trim().length === 0 && !row.seeded) {
        return builderText("optionsEditor.err.messageEmpty", { code }, words);
      }
      seen.add(code);
    }
    return undefined;
  }

  /**
   * Rows as the schema stores them: strings in the default language; a description
   * is written only where the row has one.
   */
  private static optionsToSchema(rows: readonly OptionsEditorRow[]): InlineOption[] {
    return rows.map((row) => {
      const description = row.description?.trim() ?? "";
      return { value: row.value.trim(), label: row.label.trim() || row.value.trim(), ...(description.length > 0 ? { description } : {}) };
    });
  }

  /** Why the rows cannot be applied as they stand, or `undefined` when they can. */
  private static optionsProblem(rows: readonly OptionsEditorRow[], words?: BuilderTextOptions): string | undefined {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const key = row.value.trim();
      if (key.length === 0) {
        return builderText("optionsEditor.err.optionNoKey", { n: index + 1 }, words);
      }
      if (seen.has(key)) {
        return builderText("optionsEditor.err.keyDup", { key }, words);
      }
      seen.add(key);
    }
    return undefined;
  }

  private addOptionRow(): void {
    const editor = this.optionsEditor;
    if (!editor) {
      return;
    }
    const messages = editor.kind === "messages";
    const key = editor.newValue.trim();
    if (key.length === 0) {
      editor.error = this.words.text(messages ? "optionsEditor.err.enterCode" : "optionsEditor.err.enterKey");
      this.paint();
      return;
    }
    if (editor.rows.some((row) => row.value.trim() === key)) {
      editor.error = messages ? this.words.text("optionsEditor.err.codeHasMessage", { code: key }) : this.words.text("optionsEditor.err.keyExists", { key });
      this.paint();
      return;
    }
    editor.rows.push({ value: key, label: editor.newLabel.trim() });
    editor.newValue = "";
    editor.newLabel = "";
    editor.error = undefined;
    this.paint();
    // The next option is usually typed straight after this one.
    this.root.querySelector<HTMLElement>("[data-options-new='value']")?.focus();
  }

  private applyOptionsEditor(): void {
    const editor = this.optionsEditor;
    const controller = this.ctrl;
    if (!editor || !controller) {
      return;
    }
    const messages = editor.kind === "messages";
    // A half-typed add row is not dropped without a word.
    const unfinished = messages ? undefined : this.takePendingOptionRow(editor);
    if (unfinished) {
      editor.error = unfinished.message;
      this.captureOptionsFrame();
      this.paint();
      // Focus the box the problem is in: a clashing key is in the key box, the rest in the label box.
      this.root.querySelector<HTMLElement>(`[data-options-new='${unfinished.box}']`)?.focus();
      return;
    }
    const problem = messages
      ? DatumBuilderPropertiesElement.messagesProblem(editor.rows, this.wordsFor(undefined))
      : DatumBuilderPropertiesElement.optionsProblem(editor.rows, this.wordsFor(undefined));
    if (problem) {
      editor.error = problem;
      this.paint();
      return;
    }
    const { nodeId, path, rows } = editor;
    this.optionsEditor = undefined;
    this.optionsDiscard = undefined;
    // Straight into the form, one undo step: the dialog's Apply is the commit, not
    // a second draft the panel's Apply must then save.
    this.commitDialogEdits(controller, nodeId, [
      {
        path,
        value: messages ? DatumBuilderPropertiesElement.messagesToSchema(rows) : DatumBuilderPropertiesElement.optionsToSchema(rows)
      }
    ]);
    this.paint();
    this.focusEditorOpener(DatumBuilderPropertiesElement.optionsOpener(editor));
  }

  /**
   * The add row as Apply finds it: nothing typed, nothing to do; a label, a row
   * (under its key, or one made from the label); a key with no label, the reason it is not
   * applied. A key some row already has is refused as Add refuses it.
   */
  private takePendingOptionRow(editor: OptionsEditorView): { message: string; box: "value" | "label" } | undefined {
    const key = editor.newValue.trim();
    const label = editor.newLabel.trim();
    if (key.length === 0 && label.length === 0) {
      return undefined;
    }
    if (label.length === 0) {
      return { message: this.words.text("optionsEditor.err.rowUnfinished", { n: editor.rows.length + 1 }), box: "label" };
    }
    const taken = new Set(editor.rows.map((row) => row.value.trim()));
    if (key.length > 0 && taken.has(key)) {
      return { message: this.words.text("optionsEditor.err.keyExists", { key }), box: "value" };
    }
    editor.rows.push({ value: key.length > 0 ? key : optionKeyFromLabel(label, taken), label });
    editor.newValue = "";
    editor.newLabel = "";
    return undefined;
  }

  /**
   * One option per line of a pasted list, each under a key made from its label,
   * after the row it was pasted into, or at the end from the add row. The dialog's working
   * copy only: Apply is still what writes them.
   */
  private pasteOptionList(lines: readonly string[], after: number | undefined): void {
    const editor = this.optionsEditor;
    if (!editor) {
      return;
    }
    if (after === undefined) {
      // The pasted lines are the add row's content now; a key typed there would be left with no label.
      editor.newValue = "";
      editor.newLabel = "";
    }
    if (editor.rows.length + lines.length > MAX_IMPORTED_OPTIONS) {
      editor.error = this.words.text("optionsEditor.err.tooMany", { max: MAX_IMPORTED_OPTIONS });
      this.paint();
      return;
    }
    const taken = new Set([...editor.rows.map((row) => row.value.trim()), editor.newValue.trim()].filter((key) => key.length > 0));
    const pasted: OptionsEditorRow[] = lines.map((label) => ({ value: optionKeyFromLabel(label, taken), label }));
    const at = after === undefined ? editor.rows.length : Math.min(after + 1, editor.rows.length);
    editor.rows.splice(at, 0, ...pasted);
    editor.error = undefined;
    this.captureOptionsFrame();
    this.paint();
    this.root.querySelector<HTMLElement>(`[data-option-row="${at + pasted.length - 1}"][data-option-part="label"]`)?.focus();
  }

  /**
   * A keyed-text dialog's Apply: every value straight to the tree as one undo step,
   * the open draft kept in step by `setProperties`, so the panel shows no "Not applied" for it
   * and a later Apply of the panel cannot write the old value back. A value the tree already
   * holds is only set in the draft (no empty undo step). A text inside a list (a header or
   * footer part, `chrome.header.0.text`) is committed only while that part is the same in the
   * draft and the form; a part the draft added or moved stays a draft edit, applied with it.
   */
  private commitDialogEdits(controller: BuilderController, nodeId: string, edits: ReadonlyArray<{ path: string; value: unknown }>): void {
    const commits: Array<{ componentId: string; propertyPath: string; value: unknown }> = [];
    const drafted: Array<{ path: string; value: unknown }> = [];
    for (const edit of edits) {
      if (!DatumBuilderPropertiesElement.commitsStraight(controller, nodeId, edit.path)) {
        drafted.push(edit);
      } else if (!sameConfigurationValue(edit.value, controller.getProperty(nodeId, edit.path))) {
        commits.push({ componentId: nodeId, propertyPath: edit.path, value: edit.value });
      } else if (!sameConfigurationValue(edit.value, controller.draftProperty(nodeId, edit.path))) {
        drafted.push(edit);
      }
    }
    controller.setProperties(commits);
    for (const edit of drafted) {
      controller.setDraftProperty(nodeId, edit.path, edit.value);
    }
  }

  /** Whether a dialog's value at `path` can go to the tree on its own (see {@link commitDialogEdits}). */
  private static commitsStraight(controller: BuilderController, nodeId: string, path: string): boolean {
    const segments = path.split(".");
    if (!segments.some((segment) => /^\d+$/.test(segment))) {
      return true;
    }
    // The part the text belongs to, whole (its text included): the same in the form and in the
    // draft, the write lands on what the author sees whatever the list's order; else not.
    const parent = segments.slice(0, -1).join(".");
    const committed = controller.getProperty(nodeId, parent);
    const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    return isObject(committed) && sameConfigurationValue(committed, controller.draftProperty(nodeId, parent));
  }

  /** The working copy in the schema's own shape, whichever list the dialog is editing. */
  private editorToSchema(editor: OptionsEditorView): unknown {
    return editor.kind === "messages"
      ? (DatumBuilderPropertiesElement.messagesToSchema(editor.rows) ?? {})
      : DatumBuilderPropertiesElement.optionsToSchema(editor.rows);
  }

  /** Hands the working copy to the browser as an options.json download — the schema's own shape. */
  private exportOptions(): void {
    const editor = this.optionsEditor;
    if (!editor) {
      return;
    }
    if (typeof URL.createObjectURL !== "function") {
      editor.error = this.words.text("optionsEditor.err.downloads");
      this.paint();
      return;
    }
    const json = JSON.stringify(this.editorToSchema(editor), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = editor.kind === "messages" ? "messages.json" : "options.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Replaces the working copy with an uploaded options document (nothing is applied until Apply). */
  private importOptions(files: FileList | null): void {
    const editor = this.optionsEditor;
    const file = files?.[0];
    if (!editor || !file) {
      return;
    }
    const tooLarge = (): void => {
      const current = this.optionsEditor;
      if (current) {
        current.error = this.words.text("optionsEditor.err.tooLarge", { file: file.name, max: MAX_IMPORTED_OPTIONS });
        this.paint();
      }
    };
    // Refused by size before it is read: nothing is parsed or drawn for a file past the cap.
    if (file.size > MAX_IMPORTED_OPTIONS_BYTES) {
      tooLarge();
      return;
    }
    // FileReader rather than Blob.text(): same result, but also works under jsdom.
    const reader = new FileReader();
    reader.onload = () => {
      const current = this.optionsEditor;
      if (!current) {
        return;
      }
      if (String(reader.result).length > MAX_IMPORTED_OPTIONS_BYTES) {
        tooLarge();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        current.error = this.words.text("optionsEditor.err.notJson", { file: file.name });
        this.paint();
        return;
      }
      const count = Array.isArray(parsed) ? parsed.length : parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0;
      if (count > MAX_IMPORTED_OPTIONS) {
        tooLarge();
        return;
      }
      if (current.kind === "messages") {
        // The schema's own shape: a map from code to text. An empty map clears the list.
        const catalog = authoredMessages(parsed);
        const isMap = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
        if (!isMap || (Object.keys(parsed as object).length > 0 && Object.keys(catalog).length === 0)) {
          current.error = this.words.text("optionsEditor.err.notMessages", { file: file.name });
          this.paint();
          return;
        }
        current.rows = Object.entries(catalog).map(([code, text]) => ({ value: code, label: text }));
        current.error = undefined;
        this.paint();
        return;
      }
      const options = parseInlineOptions(parsed);
      if (!Array.isArray(parsed) || (parsed.length > 0 && options.length === 0)) {
        current.error = this.words.text("optionsEditor.err.notOptions", { file: file.name });
        this.paint();
        return;
      }
      current.rows = options.map(DatumBuilderPropertiesElement.optionRow);
      current.showDescriptions = current.showDescriptions || options.some((option) => option.description !== undefined);
      current.error = undefined;
      this.paint();
    };
    reader.onerror = () => {
      const current = this.optionsEditor;
      if (current) {
        current.error = this.words.text("optionsEditor.err.unreadable", { file: file.name });
        this.paint();
      }
    };
    reader.readAsText(file);
  }

  /**
   * Remembers where the dialog is and how big it is — once the author has moved it (inline
   * `left`/`top`) or resized it from the corner (the browser writes inline `width`/`height`) —
   * so the repaint that follows a row edit draws it back in the same place.
   */
  private captureOptionsFrame(): void {
    captureDialogFrame(this.root.querySelector<HTMLDialogElement>("dialog[data-options-dialog]"), this.activeDialog());
  }

  /** Dragging the title bar moves the dialog; its buttons keep their own click behaviour. */
  private beginOptionsDrag(event: PointerEvent, handle: HTMLElement): void {
    beginDialogDrag(event, handle, handle.closest<HTMLDialogElement>("dialog[data-options-dialog]"), this.activeDialog(), () =>
      this.captureOptionsFrame()
    );
  }

  /** Full viewport, and back to wherever (and however large) the dialog was before. */
  private toggleOptionsMaximized(): void {
    const editor = this.activeDialog();
    if (!editor) {
      return;
    }
    if (!editor.maximized) {
      this.captureOptionsFrame();
    }
    editor.maximized = !editor.maximized;
    this.paint();
  }

  /** Routes a click inside the options editor; `true` when it was one. */
  private handleOptionsClick(target: Element): boolean {
    if (!this.optionsEditor) {
      return false;
    }
    // The discard question is modal over the dialog: its two answers are the only clicks.
    if (this.optionsDiscard) {
      if (target.closest?.("[data-options-discard-confirm]")) {
        this.closeOptionsEditor();
      } else if (target.closest?.("[data-options-discard-keep]")) {
        this.keepEditingOptions();
      }
      return true;
    }
    if (target.closest?.("[data-options-close]") || target.closest?.("[data-options-cancel]")) {
      this.closeOptionsEditor();
      return true;
    }
    if (target.closest?.("[data-options-apply]")) {
      this.applyOptionsEditor();
      return true;
    }
    if (target.closest?.("[data-options-add]")) {
      this.addOptionRow();
      return true;
    }
    const suggested = target.closest<HTMLButtonElement>("[data-options-suggest]");
    if (suggested) {
      if (!suggested.disabled) {
        // The key goes into the add row; the text is still the author's to write.
        this.optionsEditor.newValue = suggested.dataset.optionsSuggest ?? "";
        this.optionsEditor.error = undefined;
        this.paint();
        this.root.querySelector<HTMLElement>("[data-options-new='label']")?.focus();
      }
      return true;
    }
    if (target.closest?.("[data-options-export]")) {
      this.exportOptions();
      return true;
    }
    if (target.closest?.("[data-options-import]")) {
      this.root.querySelector<HTMLInputElement>("[data-options-file]")?.click();
      return true;
    }
    if (target.closest?.("[data-options-maximize]")) {
      this.toggleOptionsMaximized();
      return true;
    }
    if (target.closest?.("[data-options-descriptions]")) {
      // The columns come and go; what was typed in them stays on the rows either way.
      this.captureOptionsFrame();
      this.optionsEditor.showDescriptions = !this.optionsEditor.showDescriptions;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-options-descriptions]")?.focus();
      return true;
    }
    const remove = target.closest<HTMLElement>("[data-options-remove]")?.dataset.optionsRemove;
    if (remove !== undefined) {
      this.optionsEditor.rows.splice(Number(remove), 1);
      this.optionsEditor.error = undefined;
      this.paint();
      return true;
    }
    // The page's wording copied into the row, to edit from rather than retype.
    const useDefault = target.closest<HTMLElement>("[data-options-default]")?.dataset.optionsDefault;
    if (useDefault !== undefined) {
      const row = this.optionsEditor.rows[Number(useDefault)];
      if (row?.fallback) {
        row.label = row.fallback.default;
      }
      this.optionsEditor.error = undefined;
      this.paint();
      this.root.querySelector<HTMLElement>(`[data-option-row="${useDefault}"][data-option-part="label"]`)?.focus();
      return true;
    }
    // A raised code's row stays; only its wording goes.
    const clear = target.closest<HTMLElement>("[data-options-clear]")?.dataset.optionsClear;
    if (clear !== undefined) {
      const row = this.optionsEditor.rows[Number(clear)];
      if (row) {
        row.label = "";
      }
      this.optionsEditor.error = undefined;
      this.paint();
      this.root.querySelector<HTMLElement>(`[data-option-row="${clear}"][data-option-part="label"]`)?.focus();
      return true;
    }
    const move = target.closest<HTMLElement>("[data-options-move]")?.dataset.optionsMove;
    if (move !== undefined) {
      const [from, delta] = move.split(":").map(Number);
      const to = (from ?? 0) + (delta ?? 0);
      const rows = this.optionsEditor.rows;
      if (from !== undefined && to >= 0 && to < rows.length) {
        const [row] = rows.splice(from, 1);
        if (row) {
          rows.splice(to, 0, row);
        }
        this.paint();
        // Focus follows the row: the same control at its new index — or, at the end of the
        // list where that one is disabled, the row's other move button.
        (
          this.root.querySelector<HTMLElement>(`[data-options-move="${to}:${delta}"]:not([disabled])`) ??
          this.root.querySelector<HTMLElement>(`[data-options-move="${to}:${-(delta ?? 0)}"]:not([disabled])`) ??
          this.root.querySelector<HTMLElement>(`[data-options-remove="${to}"]`)
        )?.focus();
      }
      return true;
    }
    // Any other click inside the dialog (a cell, the hint) is the dialog's own.
    return !!target.closest?.("dialog[data-options-dialog]");
  }

  /** Typing in the options editor edits the working copy in place — no repaint, so the caret stays. */
  private handleOptionsInput(target: HTMLInputElement): boolean {
    const editor = this.optionsEditor;
    if (!editor) {
      return false;
    }
    const newPart = target.dataset.optionsNew;
    if (newPart === "value" || newPart === "label") {
      editor[newPart === "value" ? "newValue" : "newLabel"] = target.value;
      return true;
    }
    const index = target.dataset.optionRow;
    const part = target.dataset.optionPart;
    const row = index !== undefined ? editor.rows[Number(index)] : undefined;
    if (!row || !part) {
      return false;
    }
    if (part === "value") {
      row.value = target.value;
    } else if (part === "label") {
      row.label = target.value;
    } else if (part === "description") {
      row.description = target.value;
    }
    return true;
  }

  /**
   * Shows the prompt this paint carries (unsaved edits, or a delete) as a modal: `showModal()`
   * lifts the `<dialog>` into the browser's top layer, above every stacking context on the
   * page, and makes everything outside it inert — the canvas, the palette, the host's own
   * chrome — until it is answered. That is what makes it a prompt rather than a notice
   * something else can be clicked past. A repaint replaces the element, so this runs after
   * every paint; a DOM without `showModal` (jsdom, a non-browser DOM) still shows the prompt,
   * just not modally.
   */
  private openPrompt(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (!dialog) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
    } else {
      dialog.setAttribute("open", "");
    }
    // Escape — or any other close request the browser makes — is "not now", never an answer.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.dismissPrompt();
    });
    // `showModal` moves focus to the `autofocus` control; the click that raised the prompt
    // landed on the canvas, so without that step focus would still be out there.
    if (!dialog.contains(this.root.activeElement)) {
      (
        dialog.querySelector<HTMLElement>("[autofocus]:not([disabled])") ??
        dialog.querySelector<HTMLElement>("button:not([disabled])")
      )?.focus();
    }
  }

  /** Closes whichever prompt is up without acting on it: Escape, or a browser close request. */
  private dismissPrompt(): void {
    if (this.ctrl?.unsavedChangesPrompt()) {
      this.ctrl.answerUnsavedChangesPrompt("stay");
      // Escape is Keep editing: back to the box, not to nowhere.
      this.keepEditing();
    } else if (this.pendingDeleteId) {
      this.pendingDeleteId = undefined;
      this.paint();
    }
  }

  /**
   * Save. Every Save the panel itself raises (the footer, Enter) comes through here, so a
   * problem in the draft takes the author to its box instead of saving.
   */
  private saveDraft(): void {
    if (!this.ctrl) {
      return;
    }
    // A Save with a problem saves nothing: it takes the author to the first problem instead,
    // as an invalid submit takes a person to the first invalid field.
    const nodeId = this.subjectId();
    const problems = nodeId !== undefined ? this.panelProblems(this.ctrl, nodeId, this.ctrl.inspectorModel(nodeId)) : [];
    const first = problems[0];
    if (first) {
      const words = this.wordsFor(undefined);
      this.goToProblem(first.target, this.words.text("panel.notSaved", { count: problemCountText(problems.length, words), problem: problemText(first, words) }));
      return;
    }
    this.ctrl.commitDraft(this.subjectId());
  }

  /**
   * What holds a Save of `nodeId`'s draft back, in the order the panel shows the boxes — the
   * id, then the fields section by section, then the rules — each named for the footer's list:
   * the controller's problems for that component (never another's), and what this panel
   * itself could not read (an expression or a rule whose JSON does not parse, so Save would
   * quietly keep the last one that did).
   */
  private panelProblems(
    controller: BuilderController,
    nodeId: string,
    model: InspectorModel | undefined
  ): Array<{ target: string; label: string; message: string }> {
    const order = new Map<string, number>();
    for (const section of model?.sections ?? []) {
      for (const field of section.fields) {
        order.set(field.propertyPath, order.size);
      }
    }
    const own = controller.problemsOf(nodeId).map((problem) => ({ target: problem.target as string, message: problem.message }));
    const local = this.localProblems(nodeId, model).filter((problem) => !own.some((entry) => entry.target === problem.target));
    const rank = (target: string): number =>
      target === "id" ? -1 : target === "json" ? 2e6 : target.startsWith("rules:") ? 1e6 : (order.get(target) ?? 1e5);
    return [...own, ...local]
      .sort((a, b) => rank(a.target) - rank(b.target))
      .map((problem) => ({ ...problem, label: this.problemLabel(problem.target, model) }));
  }

  /** What keeps Apply from taking `nodeId`'s draft (`applyBlockers`), in the builder's words; empty when Apply is free. */
  private applyBlockersOf(nodeId: string): InspectorNotice[] {
    const node = this.ctrl?.editedNode(nodeId);
    return node ? applyBlockers(node, this.wordsFor(undefined)) : [];
  }

  /** The advice under Label for `nodeId` as drafted (`inspectorWarnings`): never blocking, never counted. */
  private warningsOf(nodeId: string): InspectorNotice[] {
    const node = this.ctrl?.editedNode(nodeId);
    return node ? inspectorWarnings(node, this.wordsFor(undefined)) : [];
  }

  /** The Pattern the draft of `nodeId` holds when it is of a catastrophic shape (`kernelRegexRisky`), else `undefined`. */
  private riskyPatternOf(nodeId: string): string | undefined {
    const pattern = (this.ctrl?.editedNode(nodeId)?.configuration as { pattern?: unknown } | undefined)?.pattern;
    return typeof pattern === "string" && pattern !== "" && kernelRegexRisky(pattern) ? pattern : undefined;
  }

  /** What this panel could not read for `nodeId`: expression boxes and rule JSON that do not parse. */
  private localProblems(nodeId: string, model: InspectorModel | undefined): Array<{ target: string; message: string }> {
    const out: Array<{ target: string; message: string }> = [];
    for (const [path, message] of this.expressions(nodeId).errors) {
      out.push({ target: path, message });
    }
    if (model && (this.subjectHasRules() || this.fieldFormulaDescriptors(nodeId).length > 0)) {
      // A rule the draft changed whose formula does not parse, read with the functions
      // the host wired; the controller reports the same for `rules[key]`, and wins on a shared target.
      for (const [key, message] of this.ruleParseProblems(nodeId)) {
        // A Field tab formula is addressed by its property, as the tree owner's problems about it are.
        out.push({ target: key.startsWith(FIELD_FORMULA_PREFIX) ? key.slice(FIELD_FORMULA_PREFIX.length) : `rules:${key}`, message });
      }
    }
    // What Apply cannot take: a Pattern that is no regular expression, a minimum above
    // its maximum. Each sits under its box like any problem; these alone also disable Apply.
    const blockers = model !== undefined ? this.applyBlockersOf(nodeId) : [];
    for (const blocker of blockers) {
      out.push({ target: blocker.fieldId, message: blocker.message });
    }
    // A Pattern box whose text repeats a repeat (or a back-reference) can take very long on some answers; the
    // runtime and the sandbox do not run it unless the host allows risky patterns (`kernelRegexRisky`).
    // A Pattern that does not compile at all says that alone.
    const risky = model !== undefined && !blockers.some((blocker) => blocker.fieldId === "pattern") ? this.riskyPatternOf(nodeId) : undefined;
    if (risky !== undefined) {
      out.push({ target: "pattern", message: builderText("field.pattern.risky", { pattern: risky }, this.wordsFor(undefined)) });
    }
    // JSON typed in the JSON view that does not apply: the draft holds the last that did.
    const json = this.jsonProblem(nodeId);
    if (json) {
      out.push({ target: "json", message: json.line !== undefined ? this.words.text("panel.json.problem", { line: json.line, column: json.column ?? 0, message: json.message }) : json.message });
    }
    return out;
  }

  /** What the footer's list calls the box a problem sits under: "ID", the field's label, "Rules · Visible when". */
  private problemLabel(target: string, model: InspectorModel | undefined): string {
    if (target === "id") {
      return this.words.text("inspector.id");
    }
    if (target === "json") {
      return this.words.text("panel.problem.json");
    }
    if (target === "identity.id") {
      return this.words.text("identity.formId");
    }
    if (target === "identity.version") {
      return this.words.text("identity.version");
    }
    if (target.startsWith("rules:")) {
      const key = target.slice("rules:".length);
      if (key.startsWith(FIELD_FORMULA_PREFIX)) {
        const path = key.slice(FIELD_FORMULA_PREFIX.length);
        return model?.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === path)?.label ?? path;
      }
      const descriptor = model ? this.ruleDescriptorsFor(model.nodeType).find((entry) => entry.key === key) : undefined;
      return this.words.text("panel.problem.rules", { label: descriptor?.label ?? key });
    }
    for (const section of model?.sections ?? []) {
      const field = section.fields.find((entry) => entry.propertyPath === target);
      if (field) {
        return field.label;
      }
    }
    return target;
  }

  /** The box a problem is about, in the markup as it stands. */
  private problemElement(target: string): HTMLElement | null {
    const quote = (value: string): string => value.replace(/["\\]/g, "\\$&");
    if (target === "id") {
      return this.root.querySelector<HTMLElement>('input[data-prop="id"]');
    }
    if (target === "json") {
      return this.jsonViewer?.viewer.contentDom ?? this.root.querySelector<HTMLElement>("textarea[data-json-edit]");
    }
    if (target === "identity.id" || target === "identity.version") {
      return this.root.querySelector<HTMLElement>(`input[data-identity-field="${target.slice("identity.".length)}"]`);
    }
    if (target.startsWith("rules:")) {
      const rule = target.slice("rules:".length);
      const key = quote(rule);
      // The box first (the editor over it, else the textarea); a rule that is off has only its pills.
      return (
        this.formulaEditors.get(rule)?.editor.contentDom ??
        this.root.querySelector<HTMLElement>(`textarea[data-rule-formula][data-rule="${key}"]`) ??
        this.root.querySelector<HTMLElement>(`details[data-rule-section="${key}"] button[data-rule-mode]`)
      );
    }
    const path = quote(target);
    // A formula drawn in the Field tab is addressed by its property: the editor over it, else its textarea.
    const formula = this.formulaEditors.get(`${FIELD_FORMULA_PREFIX}${target}`)?.editor.contentDom ?? this.root.querySelector<HTMLElement>(`textarea[data-rule-formula][data-rule="${quote(`${FIELD_FORMULA_PREFIX}${target}`)}"]`);
    if (formula) {
      return formula;
    }
    return this.root.querySelector<HTMLElement>(`input[data-prop="${path}"]:not([type="file"]), select[data-prop="${path}"], textarea[data-prop="${path}"]`);
  }

  /**
   * Takes the author to a problem: its tab, its section opened, the filter cleared if it hides
   * the box, the box scrolled into view and focused — so the message under it is read with it —
   * and what happened said once more in the live region.
   */
  private goToProblem(target: string, announcement?: string): void {
    const controller = this.ctrl;
    const nodeId = this.subjectId();
    if (!controller || nodeId === undefined) {
      return;
    }
    this.problemListOpen = false;
    const rule = target.startsWith("rules:") ? target.slice("rules:".length) : undefined;
    const tab: InspectorTab = target === "json" ? "json" : rule !== undefined ? "rules" : "properties";
    const model = controller.inspectorModel(nodeId);
    // A box on the Style tab is found there.
    const onStyle =
      rule === undefined &&
      model?.sections.some((section) => STYLE_SECTION_IDS.has(section.id) && section.fields.some((field) => field.propertyPath === target)) === true;
    const shownTab: InspectorTab = onStyle && this.inspectorTabs().some((entry) => entry.id === "style") ? "style" : tab;
    if (this.tab !== shownTab && this.tabShown(shownTab)) {
      this.tab = shownTab;
    }
    if (rule !== undefined) {
      this.rules(nodeId).open.add(rule);
    } else if (target.startsWith("identity.")) {
      this.collapsedSections.delete("identity");
      this.openedSections.add("identity");
    } else if (target !== "id") {
      const section = model?.sections.find((entry) => entry.fields.some((field) => field.propertyPath === target));
      if (section) {
        this.collapsedSections.delete(section.id);
        this.openedSections.add(section.id);
      }
    }
    this.paint();
    const element = this.problemElement(target);
    if (element && (element.closest<HTMLElement>(".property-row")?.hidden || element.closest<HTMLElement>("details.inspector-section")?.hidden)) {
      // A filter that hides the box would hide the problem too.
      this.propertyFilter = "";
      const box = this.root.querySelector<HTMLInputElement>("[data-property-filter]");
      if (box) {
        box.value = "";
      }
      this.applyPropertyFilter();
    }
    if (element) {
      element.scrollIntoView?.({ block: "center" });
      // The JSON view's caret goes where the text goes wrong.
      const offset = target === "json" ? this.jsonProblem(nodeId)?.offset : undefined;
      const formulaEditor = rule !== undefined ? this.formulaEditors.get(rule) : undefined;
      if (target === "json" && this.jsonViewer) {
        this.jsonViewer.viewer.focus(offset);
      } else if (formulaEditor) {
        formulaEditor.editor.focus();
      } else {
        element.focus();
        if (offset !== undefined && element instanceof HTMLTextAreaElement) {
          element.setSelectionRange(offset, offset);
        }
      }
    }
    const status = this.root.querySelector<HTMLElement>("[data-inspector-status]");
    if (status) {
      const problem = this.panelProblems(controller, nodeId, model).find((entry) => entry.target === target);
      status.textContent = announcement ?? (problem ? problemText(problem, this.wordsFor(undefined)) : "");
    }
  }

  /**
   * Goes to a problem of the component this panel edits — the one `target` names, else the
   * first — as the Save and the footer's count do. The shell calls it on the Form panel for the
   * Header & footer panel, whose Save shares the root's draft but not these boxes.
   */
  public showProblem(target?: string): void {
    const controller = this.ctrl;
    const nodeId = this.subjectId();
    if (!controller || nodeId === undefined) {
      return;
    }
    const problems = this.panelProblems(controller, nodeId, controller.inspectorModel(nodeId));
    const problem = problems.find((entry) => entry.target === target) ?? problems[0];
    if (problem) {
      this.goToProblem(problem.target, problemText(problem, this.wordsFor(undefined)));
    }
  }

  /**
   * Hides the rows the filter box rules out — hiding rather than re-rendering, so applying
   * it costs no focus and no state. Matching is by the row's label. A section with no
   * matching rows disappears with them; one the author collapsed that matches stays visible
   * (collapsed) rather than being forced open, so the author's own open/closed memory is
   * never rewritten by a search. A section the tree's owner folds (a journey's Wording)
   * is not the author's choice: it opens while a search matches inside it, marked
   * `data-filter-opened` so the open is not remembered, and folds again when the search stops
   * matching there.
   */
  private applyPropertyFilter(): void {
    const body = this.root.querySelector<HTMLElement>(".inspector-body");
    if (!body) {
      return;
    }
    const filter = this.propertyFilter.trim().toLowerCase();
    for (const row of body.querySelectorAll<HTMLElement>(".property-row")) {
      const label = row.querySelector("strong")?.textContent ?? row.textContent ?? "";
      row.hidden = filter !== "" && !label.toLowerCase().includes(filter);
    }
    for (const section of body.querySelectorAll<HTMLElement>("details.inspector-section")) {
      const rows = section.querySelectorAll<HTMLElement>(".property-row");
      const anyVisible = Array.from(rows).some((row) => !row.hidden);
      const summaryMatch = (section.querySelector("summary")?.textContent ?? "")
        .toLowerCase()
        .includes(filter);
      section.hidden = filter !== "" && rows.length > 0 && !anyVisible && !summaryMatch;
      const details = section as HTMLDetailsElement;
      const matched = filter !== "" && rows.length > 0 && anyVisible;
      if (matched && !details.open && details.dataset.folded !== undefined) {
        details.dataset.filterOpened = "";
        details.open = true;
      } else if (!matched && details.dataset.filterOpened !== undefined) {
        delete details.dataset.filterOpened;
        details.open = false;
      }
    }
  }

  /** The tab's view of every rule: the draft's rule with the working copy laid over it, its problems, its words. */
  private rulesTabOptions(controller: BuilderController, nodeId: string, componentType: string) {
    const working = this.rules(nodeId);
    const context = this.formulaContext(nodeId);
    const words = this.wordsFor(context.locale);
    // Only the rules that can take effect on this component (the form root gets the three
    // that cascade; a mode's node the ones its source offers); a rule authored under any
    // other key is left exactly as it is.
    const states: RuleView[] = this.ruleDescriptorsFor(componentType, nodeId).map((descriptor) => this.ruleView(controller, nodeId, descriptor, working, context));
    const source = this.ruleSourceValue;
    // Asked on every paint when the mode words it per node (a layout's place in the order).
    const note = typeof source?.note === "function" ? source.note(nodeId) : source?.note;
    const notes = this.ruleNotes(controller, nodeId);
    const ways = this.waysOf(nodeId);
    return {
      ...(ways ? { ways } : {}),
      states,
      openRules: working.open,
      errors: this.ruleSaveProblems(controller, nodeId),
      ...(notes.size > 0 ? { notes } : {}),
      ...(note !== undefined ? { note } : {}),
      // The Logic workspace lists the form's own rules; a mode's live on its documents.
      openInLogic: source === undefined && this.primaryValue,
      editorFailed: this.formulaEditorLoad === "failed",
      words
    };
  }

  /** One rule as the tab draws it: the draft's rule under the working copy, its problem, its warnings, its words, its examples. */
  private ruleView(controller: BuilderController, nodeId: string, descriptor: RuleDescriptor, working: RulesWorkingState, context: FormulaContext): RuleView {
    const key = descriptor.key;
    const source = this.ruleSourceOf(nodeId, descriptor);
    const built = buildRuleEditorState(descriptor, source, { mode: working.modes.get(key) });
    const state = built;
    const run = working.runs.get(key) ?? state.run;
    if (state.mode !== "formula") {
      return { ...state, run, runControl: ruleRunControl(descriptor) };
    }
    // Said under the box whenever the text does not parse, the author's own typing (a Save
    // problem, see ruleSaveProblems) and a formula stored unparseable elsewhere alike.
    const analysis = this.analyseFormula(nodeId, state.text);
    const parseProblem = analysis.problems.find((problem) => problem.kind === "parse");
    const expression = analysis.parsed.ok ? analysis.parsed.expression : undefined;
    return {
      ...state,
      run,
      problem: state.text.trim() !== "" ? parseProblem?.message : undefined,
      runControl: ruleRunControl(descriptor),
      warnings: analysis.problems.filter((problem) => problem.kind !== "parse").map((problem) => problem.message),
      ...(expression ? { reads: this.ruleReads(controller, nodeId, descriptor, expression, context) } : {}),
      examples: this.ruleExamples(descriptor, context.fields)
    };
  }

  /**
   * The rules of `nodeId` whose draft differs from what the form holds and whose formula does
   * not parse, by rule key: what holds Save back. Read with the functions the host
   * wired, so a call to a plugin function is no problem here; the controller's own reading
   * (`problemsOf`, which knows the built-ins only) is laid over it, since it is what refuses
   * `commitDraft` and the leave guard's Save. Blank text is no rule, not a problem.
   */
  private ruleParseProblems(nodeId: string): Map<string, string> {
    const controller = this.ctrl;
    const out = new Map<string, string>();
    const type = controller?.editedNode(nodeId)?.type;
    if (!controller || type === undefined) {
      return out;
    }
    for (const descriptor of [...this.ruleDescriptorsFor(type, nodeId), ...this.fieldFormulaDescriptors(nodeId)]) {
      const drafted = this.ruleSourceOf(nodeId, descriptor);
      if (JSON.stringify(drafted ?? null) === JSON.stringify(this.committedRuleSourceOf(nodeId, descriptor) ?? null)) {
        continue;
      }
      const text = ruleText(drafted);
      if (text === undefined || text.trim() === "") {
        continue;
      }
      const problem = this.analyseFormula(nodeId, text).problems.find((entry) => entry.kind === "parse");
      if (problem) {
        out.set(descriptor.key, problem.message);
      }
    }
    return out;
  }

  /** {@link ruleParseProblems} with the controller's reading of `rules:<key>` laid over it: the tab's `errors`. */
  private ruleSaveProblems(controller: BuilderController, nodeId: string): Map<string, string> {
    const errors = this.ruleParseProblems(nodeId);
    const fieldKeys = new Map(this.fieldFormulaDescriptors(nodeId).map((descriptor) => [descriptor.target!.propertyPath, descriptor.key]));
    for (const problem of controller.problemsOf(nodeId)) {
      if (problem.target.startsWith("rules:")) {
        errors.set(problem.target.slice("rules:".length), problem.message);
      } else if (fieldKeys.has(problem.target)) {
        errors.set(fieldKeys.get(problem.target)!, problem.message);
      }
    }
    return errors;
  }

  /** The notes under each rule: the tree owner's (a journey route's condition) and the engine's own. */
  private ruleNotes(controller: BuilderController, nodeId: string): Map<string, InspectorNoteView[]> {
    const source = this.ruleSourceValue;
    const notes = new Map<string, InspectorNoteView[]>();
    for (const note of controller.notesOf(nodeId)) {
      if (note.target?.startsWith("rules:")) {
        const key = note.target.slice("rules:".length);
        notes.set(key, [...(notes.get(key) ?? []), { message: note.message, ...(note.severity !== undefined ? { severity: note.severity } : {}) }]);
      }
    }
    // The engine's own notes under "Required when", so the tab never promises a
    // check that is not made: a rule the fold never reads, and one a server cannot read (it
    // has no host context; the browser holds the field to it). A form with a journey gets the
    // second from the journey diagnostics too (`rule.reads-host`); this note covers every form.
    const requiredWhen = source === undefined ? this.ruleExpression(nodeId, "requiredWhen") : undefined;
    if (requiredWhen) {
      const node = controller.editedNode(nodeId);
      const gap = node ? requiredWhenGap(controller, node, nodeId) : undefined;
      const hostPath = isEvaluableExpression(requiredWhen) ? [...extractDependencies(requiredWhen)].find((path) => path.startsWith("host.")) : undefined;
      const own: InspectorNoteView[] = [];
      if (gap !== undefined) {
        own.push({ message: gap, severity: "warning" });
      } else if (hostPath !== undefined) {
        own.push({
          message: this.words.text("rules.note.browserOnly", { path: hostPath }),
          severity: "warning"
        });
      }
      if (own.length > 0) {
        notes.set("requiredWhen", [...(notes.get("requiredWhen") ?? []), ...own]);
      }
    }
    // "Valid when" is read where "Required when" is: one the fold never reads says so.
    if (source === undefined && this.ruleExpression(nodeId, "validWhen")) {
      const node = controller.editedNode(nodeId);
      const gap = node ? requiredWhenGap(controller, node, nodeId) : undefined;
      if (gap !== undefined) {
        notes.set("validWhen", [...(notes.get("validWhen") ?? []), { message: gap, severity: "warning" }]);
      }
    }
    // The same for a calculation or a default on a node that holds no data: it has no
    // key of its own, so neither the browser nor a server works it out.
    const edited = source === undefined ? controller.editedNode(nodeId) : undefined;
    if (edited !== undefined && !holdsData(edited)) {
      for (const key of ["value", "defaultValue"] as const) {
        if (this.ruleExpression(nodeId, key)) {
          notes.set(key, [
            ...(notes.get(key) ?? []),
            { message: this.words.text("rules.note.neverWorked"), severity: "warning" }
          ]);
        }
      }
    }
    return notes;
  }

  /**
   * Refreshes what one rule says about its text, in place, after a keystroke wrote the draft
   * (see {@link applyFormulaEdit}): the block under the box (problem line, warnings, "Reads
   * as", the chips over an empty box), how the box describes itself, and the footer (the
   * summary above Save, and whether there is anything to apply). The box and the
   * editor over it are left exactly where they are; nothing else in the panel moved.
   */
  private refreshRuleLive(nodeId: string, key: string): void {
    const controller = this.ctrl;
    const descriptor = this.ruleDescriptorFor(nodeId, key);
    if (!controller || !descriptor || this.subjectId() !== nodeId) {
      return;
    }
    const quoted = key.replace(/["\\]/g, "\\$&");
    const context = this.formulaContext(nodeId);
    const view = this.ruleView(controller, nodeId, descriptor, this.rules(nodeId), context);
    const options: RuleHtmlOptions = key.startsWith(FIELD_FORMULA_PREFIX)
      ? this.fieldFormulaOptions(controller, nodeId, descriptor, view, context)
      : {
          error: this.ruleSaveProblems(controller, nodeId).get(key) ?? view.problem,
          notes: this.ruleNotes(controller, nodeId).get(key),
          openInLogic: this.ruleSourceValue === undefined && this.primaryValue,
          editorFailed: this.formulaEditorLoad === "failed",
          words: this.wordsFor(context.locale)
        };
    const feedback = this.root.querySelector<HTMLElement>(`[data-rule-feedback="${quoted}"]`);
    if (feedback) {
      feedback.innerHTML = ruleFeedbackHtml(view, options);
    }
    const box = this.root.querySelector<HTMLTextAreaElement>(`textarea[data-rule-formula][data-rule="${quoted}"]`);
    if (box) {
      const description = ruleBoxDescription(key, options);
      if (description.invalid) {
        box.setAttribute("aria-invalid", "true");
      } else {
        box.removeAttribute("aria-invalid");
      }
      if (description.describedBy) {
        box.setAttribute("aria-describedby", description.describedBy);
      } else {
        box.removeAttribute("aria-describedby");
      }
      const mounted = this.formulaEditors.get(key);
      if (mounted) {
        this.describeFormulaEditor(box, mounted.editor);
      }
    }
    this.refreshFooterLive(nodeId);
  }

  /** Whether the footer as last drawn showed the draft as waiting to be applied. */
  private footerDirty: boolean | undefined;
  /** Whether the footer was redrawn in place since the panel's markup was last written (see {@link render}). */
  private footerRedrawn = false;

  /** Redraws the footer alone (Apply, Discard, Not applied, the problem summary) after a live write. */
  private refreshFooterLive(nodeId: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const footer = this.root.querySelector<HTMLElement>(".inspector-footer");
    if (footer) {
      const node = controller.editedNode(nodeId);
      const problems = this.panelProblems(controller, nodeId, controller.inspectorModel(nodeId));
      if (problems.length < 2) {
        this.problemListOpen = false;
      }
      footer.outerHTML = this.footerHtml(controller, nodeId, node, nodeId === controller.rootId(), problems);
      this.footerRedrawn = true;
    }
  }

  /** The footer under the panel: Discard / Apply with the summary of what holds Apply back. */
  private footerHtml(
    controller: BuilderController | undefined,
    committedId: string | undefined,
    node: ComponentNode | undefined,
    isRoot: boolean,
    problems: Array<{ target: string; label: string; message: string }>
  ): string {
    const dirty = !!controller?.hasPendingChanges(committedId);
    this.footerDirty = dirty;
    return inspectorFooterHtml({
      hasSelection: !!node,
      dirty,
      // A mode's button that stands in for Delete ("Take it off this step") is the
      // selection's Delete: the footer offers none beside it.
      deletable: !!controller && !isRoot && !!node && !controller.isFixedNode(node.id) && !this.modeActionReplacesDelete(),
      problems,
      problemsOpen: this.problemListOpen,
      // The one exception to "never disable Save for a problem": Apply is disabled while a value it cannot take is in a box.
      applyBlocked: committedId !== undefined && this.applyBlockersOf(committedId).length > 0,
      words: this.wordsFor(undefined)
    });
  }

  /**
   * The rule in words for the "Reads as" line, worded as the Logic workspace words the same
   * rule, without its lead ("Show Email when", "Calculate Fee as"): a condition as the Logic
   * list's sentence (fields as chips, option labels as pills); a value rule as the Logic list's
   * body, so an `if` reads as its cases ("250 when Employees is more than 10, otherwise 120")
   * and a literal as its value. A shape the list has no words for (a bare expression such as
   * `employees * 2`, or a case whose result is one) is the printed formula with labels, as is
   * every rule until the list's chunk has landed.
   */
  private ruleReads(controller: BuilderController, nodeId: string, descriptor: RuleDescriptor, expression: Expression, context: FormulaContext): RuleReadsToken[] {
    const fieldOf = (path: string): FormulaField | undefined => context.fields.find((field) => field.path === path);
    const labelOf = (path: string): string | undefined => fieldOf(path)?.label;
    const optionLabelOf = (path: string, value: string): string | undefined => fieldOf(path)?.options.find((option) => option.value === value)?.label;
    const logic = descriptor.key.startsWith(FIELD_FORMULA_PREFIX) ? undefined : this.logicModelNow();
    if (logic) {
      const sentence =
        descriptor.kind === "condition"
          ? logic.conditionSentence(expression, { root: controller.snapshot(), locale: context.locale, labelOf })
          : valueSentenceBody(logic.formRuleSentence(controller.snapshot(), { componentId: nodeId, ruleKey: descriptor.key, expression }, { locale: context.locale, labelOf }), nodeId);
      if (sentence && !sentence.some((token) => token.kind === "expression")) {
        return sentence.map((token) => readsToken(token.kind, token.text.trim())).filter((token) => token.text !== "");
      }
    }
    return printFormulaTokens(expression, { labelOf, optionLabelOf })
      .map((token) => readsToken(token.kind, token.kind === "value" ? (token.value ?? token.text) : token.text.trim()))
      .filter((token) => token.text !== "");
  }

  /**
   * The Logic workspace's model when its chunk has landed; otherwise asks for it (once per
   * attempt) and answers nothing, so the caller words the rule as the printed formula. When it
   * lands, the rules on screen are re-worded in place (no paint: the author may be typing).
   */
  private logicModelNow(): LogicModelModule | undefined {
    if (this.logicModel) {
      return this.logicModel;
    }
    const failed = this.logicModelFailed;
    // A load that failed is not asked for again on every rule draw or live refresh (each
    // keystroke in a rule): only when another selection is opened, or after a 30 s back-off.
    if (failed && failed.subject === this.subjectId() && Date.now() - failed.at < LOGIC_MODEL_RETRY_MS) {
      return undefined;
    }
    if (!this.logicModelAsked) {
      this.logicModelAsked = true;
      loadLogicModel().then(
        (module) => {
          this.logicModel = module;
          this.logicModelFailed = undefined;
          this.logicModelReported = false;
          const nodeId = this.subjectId();
          if (!this.isConnected || nodeId === undefined) {
            return;
          }
          for (const feedback of this.root.querySelectorAll<HTMLElement>("[data-rule-feedback]")) {
            this.refreshRuleLive(nodeId, feedback.dataset.ruleFeedback ?? "");
          }
        },
        (cause: unknown) => {
          this.logicModelAsked = false;
          this.logicModelFailed = { at: Date.now(), subject: this.subjectId() };
          // The rules stay worded as printed formulas; the host hears once per burst.
          if (!this.logicModelReported) {
            this.logicModelReported = true;
            this.dispatchEvent(new CustomEvent("datum-error", { bubbles: true, composed: true, detail: { code: "file.unavailable", message: this.words.text("shell.load.failed.reads"), cause } }));
          }
        }
      );
    }
    return undefined;
  }

  /** Three formulas to try over the form's own fields, for an empty box (drawn as "Try one" chips). */
  private ruleExamples(descriptor: RuleDescriptor, fields: readonly FormulaField[]): string[] {
    const choice = fields.find((field) => (field.kind === "choice" || field.kind === "flags" || field.kind === "list") && field.options.length > 0);
    const text = fields.find((field) => field.kind === "text" || field.kind === "other");
    const number = fields.find((field) => field.kind === "number");
    const date = fields.find((field) => field.kind === "date");
    const boolean = fields.find((field) => field.kind === "boolean");
    const examples: string[] = [];
    if (descriptor.kind === "condition") {
      if (choice) {
        examples.push(`${feelName(choice.path)} = ${JSON.stringify(choice.options[0]?.value ?? "")}`);
      }
      if (text) {
        examples.push(`not(empty(${feelName(text.path)}))`);
      }
      if (number) {
        examples.push(`${feelName(number.path)} > 10`);
      }
      if (boolean && examples.length < 3) {
        examples.push(`${feelName(boolean.path)} = true`);
      }
      if (date && examples.length < 3) {
        examples.push(`${feelName(date.path)} < today()`);
      }
    } else {
      const numbers = fields.filter((field) => field.kind === "number");
      if (numbers.length >= 2) {
        examples.push(`${feelName(numbers[0]!.path)} + ${feelName(numbers[1]!.path)}`);
      } else if (number) {
        examples.push(`${feelName(number.path)} * 1.13`);
      }
      if (text) {
        examples.push(`coalesce(${feelName(text.path)}, "")`);
      }
      if (choice) {
        examples.push(`if ${feelName(choice.path)} = ${JSON.stringify(choice.options[0]?.value ?? "")} then 1 else 0`);
      } else if (boolean) {
        examples.push(`if ${feelName(boolean.path)} then "yes" else "no"`);
      }
      if (examples.length < 3) {
        examples.push("today()");
      }
    }
    return examples.slice(0, 3);
  }

  // --- form-level formula policy -------------------------------------------

  /**
   * Drafts `configuration.formulaErrors` on the root. The default (`fail`) over a form that sets
   * nothing drafts nothing, so choosing it leaves the definition as it was.
   */
  private setFormulaErrors(word: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const rootId = controller.rootId();
    const choice = formulaErrorsOf(word);
    const committed = controller.getProperty(rootId, "formulaErrors");
    controller.setDraftProperty(rootId, "formulaErrors", choice === DEFAULT_FORMULA_ERRORS && committed === undefined ? undefined : choice);
    // The line under the select says what the new choice does, whether or not the panel repaints.
    const hint = this.root.querySelector<HTMLElement>("[data-formula-errors-hint]");
    if (hint) {
      hint.textContent = formulaErrorsHint(choice);
    }
  }

  /**
   * Drafts `configuration.agentTools` on the root. Not set drafts `""`, which the controller
   * removes (UNSET_WHEN_EMPTY), so it also clears a committed `off` on Save.
   */
  private setAgentTools(word: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const choice = assistantsChoiceOf(word === "" ? undefined : word);
    controller.setDraftProperty(controller.rootId(), "agentTools", assistantsDraftValue(choice));
    // The line under the select says what the new choice means, whether or not the panel repaints.
    const hint = this.root.querySelector<HTMLElement>("[data-agent-tools-hint]");
    if (hint) {
      hint.textContent = assistantsHint(choice, this.wordsFor(undefined));
    }
  }

  // --- form-level identity editing ---------------------------------------

  /** Rewrites one field of the drafted {@link FormIdentity}; the other two stay as drafted. */
  private setIdentityField(field: string, value: string): void {
    const controller = this.ctrl;
    const current = controller?.draftIdentity();
    if (!controller || !current || !(field === "id" || field === "version" || field === "schemaVersion")) {
      return;
    }
    controller.setDraftIdentity({ ...current, [field]: value });
  }

  // --- rules editing ----------------------------------------------------

  /**
   * The expression a rule holds in the draft: `rules[key]`, or, for a mode's descriptor with a
   * target, that property of the configuration — never `rules`, which the canvas
   * would evaluate against the node itself.
   */
  private ruleExpression(nodeId: string, rule: string | RuleDescriptor): Expression | undefined {
    const controller = this.ctrl;
    const descriptor = typeof rule === "string" ? this.ruleDescriptorFor(nodeId, rule) : rule;
    if (!controller || !descriptor) {
      return undefined;
    }
    if (descriptor.target) {
      return ruleExpressionOf((controller.draftProperty(nodeId, descriptor.target.propertyPath) ?? undefined));
    }
    return ruleExpressionOf(controller.draftRules(nodeId)?.[descriptor.key as RuleKey]);
  }

  /** A rule as the draft stores it (a formula string, a tree, or the object form), or `undefined` for none. */
  private ruleSourceOf(nodeId: string, descriptor: RuleDescriptor): unknown {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    if (descriptor.target) {
      return controller.draftProperty(nodeId, descriptor.target.propertyPath) ?? undefined;
    }
    return controller.draftRules(nodeId)?.[descriptor.key as RuleKey];
  }

  /**
   * A rule as the form holds it, the draft set aside: what `composeRuleSource` compares the
   * box's text against, so a stored tree typed into and typed back is the tree again, and a run
   * scope chosen over an untouched tree writes `{ expression, run }` rather than a string.
   */
  private committedRuleSourceOf(nodeId: string, descriptor: RuleDescriptor): unknown {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    if (descriptor.target) {
      return controller.getProperty(nodeId, descriptor.target.propertyPath) ?? undefined;
    }
    return findComponentNode(controller.snapshot(), nodeId)?.rules?.[descriptor.key as RuleKey];
  }

  /**
   * Writes one rule into the draft, leaving every other rule on the node untouched: into
   * `rules`, or its target property. `live` marks a keystroke's write (see {@link applyFormulaEdit}).
   */
  private writeRule(nodeId: string, key: string, source: RuleSource | undefined, meta: { live?: boolean } = {}): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const target = this.ruleDescriptorFor(nodeId, key)?.target;
    if (target) {
      controller.setDraftProperty(nodeId, target.propertyPath, source, meta);
      return;
    }
    controller.setDraftRules(nodeId, withRule(controller.draftRules(nodeId), key as RuleKey, source), meta);
  }

  /** Where the rule runs as the author has it: the choice made over an empty box, else what the draft says. */
  private runFor(nodeId: string, key: string): RunScope {
    const chosen = this.rules(nodeId).runs.get(key);
    if (chosen !== undefined) {
      return chosen;
    }
    const descriptor = this.ruleDescriptorFor(nodeId, key);
    return descriptor ? ruleRun(this.ruleSourceOf(nodeId, descriptor)) : "both";
  }

  /**
   * A keystroke in a rule's box. The text goes to the draft as typed, parseable or not: as the
   * formula string (or the object form, for a run scope other than both), or as the stored tree
   * again when the text is that tree printed (`composeRuleSource` against what the form holds).
   * The draft therefore always equals the box, and a text that does not parse is a problem the
   * controller reports (`problemsOf`) to Save, the leave guard and any `commitDraft`.
   * The write is `live`: this panel refreshes the rule's feedback and the footer in place when
   * its own change comes back ({@link onControllerChange}), the canvas waits, and nothing is
   * painted; {@link commitFormulaEdit} sends the plain change when the author leaves the box.
   */
  private applyFormulaEdit(nodeId: string, key: string, text: string): void {
    const working = this.rules(nodeId);
    const descriptor = this.ruleDescriptorFor(nodeId, key);
    if (!descriptor) {
      return;
    }
    working.modes.set(key, "formula");
    const next = composeRuleSource(this.committedRuleSourceOf(nodeId, descriptor), text, this.runFor(nodeId, key));
    if (next !== undefined) {
      working.runs.delete(key);
    }
    const existing = this.ruleSourceOf(nodeId, descriptor);
    if (JSON.stringify(next ?? null) === JSON.stringify(existing ?? null)) {
      // The draft already says this (the box was set to what it held): nothing to write.
      return;
    }
    this.liveRuleWrite = { nodeId, key };
    this.liveRulePending = { nodeId, key };
    try {
      this.writeRule(nodeId, key, next, { live: true });
    } finally {
      this.liveRuleWrite = undefined;
    }
  }

  /**
   * A keystroke in a plain box of the panel: the draft takes the text as a live write, so
   * nothing is painted and the box keeps its focus and caret; {@link commitBoxEdit} sends the
   * plain change when the author leaves the box.
   */
  private writeBoxLive(nodeId: string, path: string, value: unknown): void {
    if (!this.ctrl) {
      return;
    }
    this.liveBoxWrite = { nodeId };
    this.liveBoxPending = { nodeId, path };
    try {
      this.ctrl.setDraftProperty(nodeId, path, value, { live: true });
    } finally {
      this.liveBoxWrite = undefined;
    }
  }

  /**
   * A choice on the Style tab: the draft takes the new class list as a live write, so nothing is
   * painted and the radio or box keeps its focus. The CSS classes box beside it is set to the list
   * in place and the footer follows through {@link onControllerChange}; the draft is then written
   * once more, plainly, so the canvas and every other listener catch up (this panel's own state
   * already says so, so it does not paint for it).
   */
  private writeStyleLive(nodeId: string, write: (meta: { live: true }) => void): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    this.liveBoxWrite = { nodeId };
    try {
      write({ live: true });
    } finally {
      this.liveBoxWrite = undefined;
    }
    const value = controller.draftProperty(nodeId, "cssClass");
    const box = this.root.querySelector<HTMLInputElement>('[data-prop="cssClass"]');
    if (box && this.root.activeElement !== box) {
      box.value = typeof value === "string" ? value : "";
    }
    controller.setDraftProperty(nodeId, "cssClass", value);
  }

  /** The author left a plain box typed in live: the draft is written once more, plainly, so every listener catches up. */
  private commitBoxEdit(): void {
    const pending = this.liveBoxPending;
    this.liveBoxPending = undefined;
    if (!pending || !this.ctrl || this.subjectId() !== pending.nodeId) {
      return;
    }
    // Saved, discarded or typed back to what the form holds since: the canvas never drew the
    // live text, so there is nothing for it to catch up with (and a plain write now would only
    // repaint it a second time).
    if (!this.ctrl.hasPendingChanges(pending.nodeId)) {
      return;
    }
    this.ctrl.setDraftProperty(pending.nodeId, pending.path, this.ctrl.draftProperty(pending.nodeId, pending.path));
  }

  /**
   * The author left a rule's box (blur, Enter on a single line, a "Try one" chip): the draft
   * written live is written once more, plainly, so the canvas and every other listener catch
   * up with one change. Nothing to do when no live write is outstanding for that rule.
   */
  private commitFormulaEdit(nodeId: string, key: string): void {
    const pending = this.liveRulePending;
    if (!pending || pending.nodeId !== nodeId || pending.key !== key) {
      return;
    }
    this.liveRulePending = undefined;
    const descriptor = this.ruleDescriptorFor(nodeId, key);
    if (!descriptor || !this.ctrl) {
      return;
    }
    this.writeRule(nodeId, key, this.ruleSourceOf(nodeId, descriptor) as RuleSource | undefined);
  }

  /** The text a rule's box holds now: the draft's rule as the tab opens it. */
  private formulaTextOf(nodeId: string, key: string): string {
    const descriptor = this.ruleDescriptorFor(nodeId, key);
    return descriptor ? buildRuleEditorState(descriptor, this.ruleSourceOf(nodeId, descriptor)).text : "";
  }

  /** Handles a click inside the Logic tab. Returns false when the click was not ours. */
  private handleRulesClick(target: Element, nodeId: string): boolean {
    const modeButton = target.closest<HTMLElement>("[data-rule-mode]");
    if (modeButton) {
      const key = modeButton.dataset.rule ?? "";
      const mode = modeButton.dataset.ruleMode as RuleEditorMode;
      const working = this.rules(nodeId);
      working.modes.set(key, mode);
      working.open.add(key);
      if (mode === "off") {
        // Switching a rule off clears it, run scope and all.
        working.runs.delete(key);
        this.writeRule(nodeId, key, undefined);
      }
      this.paint();
      return true;
    }

    const runButton = target.closest<HTMLElement>("[data-rule-run]");
    if (runButton) {
      const key = runButton.dataset.rule ?? "";
      const run = runButton.dataset.ruleRun as RunScope;
      const working = this.rules(nodeId);
      const descriptor = this.ruleDescriptorFor(nodeId, key);
      // Against what the form holds: an untouched tree carries its scope as { expression, run }.
      const next = descriptor ? composeRuleSource(this.committedRuleSourceOf(nodeId, descriptor), this.formulaTextOf(nodeId, key), run) : undefined;
      this.liveRulePending = undefined;
      if (next !== undefined) {
        // The formula carries its scope: a rule that runs on both sides stays as it was written.
        working.runs.delete(key);
        this.writeRule(nodeId, key, next);
      } else {
        working.runs.set(key, run);
      }
      this.paint();
      return true;
    }

    const tryButton = target.closest<HTMLElement>("[data-rule-try]");
    if (tryButton) {
      const key = tryButton.dataset.rule ?? "";
      this.applyFormulaEdit(nodeId, key, tryButton.dataset.ruleTry ?? "");
      // A click, not a keystroke: the canvas catches up now.
      this.commitFormulaEdit(nodeId, key);
      const editor = this.formulaEditors.get(key);
      if (editor) {
        editor.editor.focus();
      } else {
        this.root.querySelector<HTMLTextAreaElement>(`textarea[data-rule-formula][data-rule="${key.replace(/["\\]/g, "\\$&")}"]`)?.focus();
      }
      return true;
    }

    const retryButton = target.closest<HTMLElement>("[data-rule-editor-retry]");
    if (retryButton) {
      this.formulaEditorLoad = "idle";
      this.ensureFormulaEditorModule();
      this.paint();
      return true;
    }
    return false;
  }

  /** Handles input inside the Logic tab. Returns false when the event was not ours. */
  private handleRulesEdit(target: HTMLElement, nodeId: string): boolean {
    const key = target.dataset.rule;
    if (!key || target.dataset.ruleFormula === undefined) {
      return false;
    }
    this.applyFormulaEdit(nodeId, key, (target as HTMLTextAreaElement).value);
    return true;
  }

  // --- wiring -----------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;

    // The filter hides rows in place rather than re-rendering, so the box keeps its focus
    // and caret through every keystroke.
    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target?.dataset?.propertyFilter === undefined) {
        return;
      }
      this.propertyFilter = target.value;
      this.applyPropertyFilter();
    });

    // The options editor: typing edits its working copy in place; choosing a file imports one;
    // dragging its title bar moves it.
    this.root.addEventListener("input", (event) => {
      const target = event.target as Element;
      if (this.optionsEditor && target instanceof HTMLInputElement) {
        this.handleOptionsInput(target);
      }
    });
    // A list pasted into an option's key or label box, or into the add row, is one option per
    // non-empty line; a single line pastes as text does.
    this.root.addEventListener("paste", (event) => {
      const target = event.target;
      const editor = this.optionsEditor;
      if (!editor || editor.kind === "messages" || this.optionsDiscard || !(target instanceof HTMLInputElement)) {
        return;
      }
      const part = target.dataset.optionPart;
      const row = target.dataset.optionRow;
      const inAddRow = target.dataset.optionsNew !== undefined;
      if (!inAddRow && !(row !== undefined && (part === "label" || part === "value"))) {
        return;
      }
      const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
      const lines = text
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length < 2) {
        return;
      }
      event.preventDefault();
      this.pasteOptionList(lines, inAddRow ? undefined : Number(row));
    });
    this.root.addEventListener("change", (event) => {
      const target = event.target as Element;
      // A mode's root choice commits as it is made: the mode reports it, and the panel repaints.
      if (target instanceof HTMLSelectElement && target.dataset.modeChoice !== undefined) {
        this.modeChoicesValue.find((choice) => choice.id === target.dataset.modeChoice)?.choose(target.value);
        return;
      }
      if (this.optionsEditor && target instanceof HTMLInputElement && target.dataset.optionsFile !== undefined) {
        this.importOptions(target.files);
        // Reset so choosing the same file again still fires a change event.
        target.value = "";
      }
    });
    this.root.addEventListener("pointerdown", (event) => {
      const handle = (event.target as Element | null)?.closest?.<HTMLElement>("[data-options-drag]");
      if (handle) {
        this.beginOptionsDrag(event as PointerEvent, handle);
      }
    });

    this.root.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest?.("[data-panel-toggle]")) {
        this.toggleCollapsed();
        return;
      }

      // The options editor is modal while it is up, so its controls are the only clicks
      // that can arrive; the row that opens it is the one click that can arrive before.
      if (this.handleOptionsClick(target)) {
        return;
      }
      // The pointer line under a component's texts: the shell opens the
      // Languages workspace on this component, through the leave guard. The event is the one the
      // workspace raises for the other way round; the shell tells them apart by where it came from.
      if (target.closest?.("[data-open-in-languages]")) {
        const componentId = this.subjectId();
        if (componentId !== undefined) {
          this.dispatchEvent(new CustomEvent<{ componentId: string }>("builder-languages-goto", { detail: { componentId }, bubbles: true, composed: true }));
        }
        return;
      }
      // The header and footer are edited in the Header & footer panel; the row's
      // button asks the shell — or whatever hosts this panel on its own — to open it there.
      const openChrome = target.closest<HTMLElement>("[data-chrome-open]")?.dataset.chromeOpen;
      if (openChrome) {
        this.dispatchEvent(
          new CustomEvent<BuilderOpenPanelDetail>("builder-open-panel", {
            detail: { panel: "chrome", region: openChrome === "footer" ? "footer" : "header" },
            bubbles: true,
            composed: true
          })
        );
        return;
      }
      // A mode's row on the form's settings opens the mode that owns it.
      const openMode = target.closest<HTMLElement>("[data-root-setting-open]");
      if (openMode) {
        const documentId = openMode.dataset.rootSettingDocument;
        this.dispatchEvent(
          new CustomEvent<BuilderOpenModeDetail>("builder-open-mode", {
            detail: { mode: openMode.dataset.rootSettingOpen ?? "", ...(documentId !== undefined ? { document: documentId } : {}) },
            bubbles: true,
            composed: true
          })
        );
        return;
      }
      const matchByOrder = target.closest<HTMLElement>("[data-value-map-order]")?.dataset.valueMapOrder;
      const orderNode = this.subjectId();
      if (matchByOrder !== undefined && orderNode) {
        this.applyValueMapOrder(orderNode, matchByOrder);
        return;
      }
      // "Suggest: validate as email": the preset goes into the draft, as the Format box would.
      const presetApply = target.closest<HTMLElement>("[data-preset-apply]")?.dataset.presetApply;
      if (presetApply !== undefined && orderNode) {
        this.applyPatternPreset(orderNode, presetApply);
        return;
      }
      const removeStale = target.closest<HTMLElement>("[data-value-map-stale]")?.dataset.valueMapStale;
      if (removeStale !== undefined && orderNode) {
        this.applyValueMapStale(orderNode, removeStale);
        return;
      }
      const editOptions = target.closest<HTMLElement>("[data-options-edit]")?.dataset.optionsEdit;
      if (editOptions) {
        this.startOptionsEditor(editOptions);
        return;
      }
      const editMessages = target.closest<HTMLElement>("[data-messages-edit]")?.dataset.messagesEdit;
      if (editMessages) {
        this.startMessagesEditor(editMessages);
        return;
      }
      // A `file` control: Choose… opens the row's hidden picker; Remove clears the property.
      const pickFile = target.closest<HTMLElement>("[data-file-pick]");
      if (pickFile) {
        pickFile.closest("[data-file-row]")?.querySelector<HTMLInputElement>('input[type="file"]')?.click();
        return;
      }
      const clearFile = target.closest<HTMLElement>("[data-file-clear]")?.dataset.fileClear;
      const clearNode = this.subjectId();
      if (clearFile !== undefined && clearNode) {
        this.fileErrors(clearNode).delete(clearFile);
        this.ctrl?.setDraftProperty(clearNode, clearFile, undefined);
        return;
      }
      // A property's "?" shows or hides its description in place — no repaint for a click
      // that changes no state of the form; the set keeps it open across the next one.
      const helpToggle = target.closest<HTMLButtonElement>("[data-help-toggle]");
      if (helpToggle) {
        const path = helpToggle.dataset.helpToggle ?? "";
        const controls = helpToggle.getAttribute("aria-controls");
        // The id is propertyDomId's own output, letters, digits, - and _ only, so an attribute
        // selector needs no escaping (and CSS.escape is not in every DOM, jsdom included).
        const help = controls ? this.root.querySelector<HTMLElement>(`[id="${controls}"]`) : null;
        const open = helpToggle.getAttribute("aria-expanded") !== "true";
        helpToggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (help) {
          help.hidden = !open;
        }
        if (open) {
          this.openHelp.add(path);
        } else {
          this.openHelp.delete(path);
        }
        return;
      }

      // A prompt is modal (see openPrompt), so while one is up its buttons are the only
      // clicks that can arrive. The unsaved-changes prompt first.
      if (target.closest?.("[data-unsaved-save]")) {
        this.ctrl?.answerUnsavedChangesPrompt("save");
        return;
      }
      if (target.closest?.("[data-unsaved-discard]")) {
        // Working rule state is derived from the draft, so it goes with it (as on Cancel), and
        // so does the text typed in an expression box.
        this.rulesState = emptyRulesState("");
        this.expressionState = emptyExpressionState("");
        this.ctrl?.answerUnsavedChangesPrompt("discard");
        return;
      }
      if (target.closest?.("[data-unsaved-stay]")) {
        this.ctrl?.answerUnsavedChangesPrompt("stay");
        // Keeping on editing a draft Save could not take goes to what held it back; any other
        // goes back to the box the author left.
        this.keepEditing();
        return;
      }

      // Then the delete confirmation.
      const confirmId = target.closest<HTMLElement>("[data-confirm-delete]")?.dataset.confirmDelete;
      if (confirmId) {
        this.pendingDeleteId = undefined;
        // With "Also remove references" ticked, what names it goes in the same undo step.
        if (removesReferences(target.closest("dialog"))) {
          this.ctrl?.remove(confirmId, { removeReferences: true });
        } else {
          this.ctrl?.remove(confirmId);
        }
        return;
      }
      if (target.closest?.("[data-confirm-cancel]")) {
        this.pendingDeleteId = undefined;
        this.paint();
        return;
      }

      // The tabs' ⋯ opens its menu; a click anywhere else in the panel closes it.
      if (target.closest?.("[data-inspector-more]")) {
        this.toggleInspectorMenu();
        return;
      }
      const menuWasOpen = this.inspectorMenuOpen;
      this.inspectorMenuOpen = false;
      const tab = target.closest<HTMLElement>("[data-inspector-tab]")?.dataset
        .inspectorTab as InspectorTab | undefined;
      if (tab && this.tabShown(tab)) {
        this.tab = tab;
        this.noteTabSubject();
        this.paint();
        return;
      }
      if (menuWasOpen) {
        this.syncInspectorMenu();
      }

      // The footer's count: straight to a lone problem, or the list of several.
      if (target.closest?.("[data-inspector-problems]")) {
        const controller = this.ctrl;
        const nodeId = this.subjectId();
        const problems = controller && nodeId !== undefined ? this.panelProblems(controller, nodeId, controller.inspectorModel(nodeId)) : [];
        if (problems.length === 1) {
          this.showProblem(problems[0]!.target);
        } else if (problems.length > 1) {
          this.problemListOpen = !this.problemListOpen;
          this.paint();
          this.root.querySelector<HTMLElement>(this.problemListOpen ? "[data-problem-go]" : "[data-inspector-problems]")?.focus();
        }
        return;
      }
      const problemTarget = target.closest<HTMLElement>("[data-problem-go]")?.dataset.problemGo;
      if (problemTarget !== undefined) {
        this.showProblem(problemTarget);
        return;
      }

      if (target.closest?.("[data-inspector-save]")) {
        this.saveDraft();
        return;
      }
      if (target.closest?.("[data-inspector-cancel]")) {
        // Working rule state is derived from the draft, so it goes with it — and the JSON
        // view's text and the expression boxes' text, which may hold what never reached the draft.
        this.rulesState = emptyRulesState("");
        this.jsonState = undefined;
        this.expressionState = emptyExpressionState("");
        this.ctrl?.discardDraft(this.subjectId());
        this.paint();
        this.syncBoxesToPainted();
        return;
      }
      if (target.closest?.("[data-inspector-delete]")) {
        this.pendingDeleteId = this.subjectId();
        this.paint();
        return;
      }
      // A mode's button in the about card ("Take it off this step"): the shell's run,
      // which goes through the unsaved-edits guard of what this panel edits.
      const modeAction = target.closest?.<HTMLElement>("[data-inspector-mode-action]")?.dataset.inspectorModeAction;
      if (modeAction !== undefined) {
        this.modeActionsValue.find((action) => action.id === modeAction)?.run();
        return;
      }
      // The mode's findings card: a fix runs, a finding selects what it is about on the mode's canvas.
      const fixButton = target.closest?.<HTMLElement>("[data-finding-fix]");
      if (fixButton) {
        const index = this.modeFindingsValue.findIndex((found) => found.id === fixButton.dataset.findingFix);
        const fix = this.modeFindingsValue[index]?.fixes.find((entry) => entry.id === fixButton.dataset.fixId);
        if (fix) {
          this.findingFixFocus = { id: fixButton.dataset.findingFix ?? "", fixId: fixButton.dataset.fixId ?? "", index, until: Date.now() + FINDING_FOCUS_LIFE_MS };
          fix.run();
          // A fix that repainted the card as it ran: focus has fallen already.
          this.placeFindingFocus();
        }
        return;
      }
      const selectButton = target.closest?.<HTMLElement>("[data-finding-select]");
      if (selectButton) {
        this.modeFindingsValue.find((found) => found.id === selectButton.dataset.findingSelect)?.select?.();
        return;
      }

      const nodeId = this.subjectId();

      // A step's Go to rule opens in the Logic editor; New rule makes one there.
      const way = target.closest?.<HTMLElement>("[data-rule-way]")?.dataset.ruleWay;
      if (this.tab === "rules" && way !== undefined) {
        const ways = this.waysOf(nodeId);
        if (way === "new") {
          ways?.newRule?.run();
        } else {
          ways?.rows[Number(way)]?.open?.();
        }
        return;
      }

      if (this.tab === "rules" && nodeId && this.handleRulesClick(target, nodeId)) {
        return;
      }

    });

    // `<details>` toggles itself; the panel only has to remember which ones are open so the
    // next repaint does not snap them shut. `toggle` does not bubble, so this listens on the
    // capture phase — non-bubbling events still travel down to their target.
    this.root.addEventListener(
      "toggle",
      (event) => {
        const target = event.target as HTMLDetailsElement;
        // Property sections remember the collapsed ones, so a new section defaults open, and
        // the opened ones of those that start folded, so they stay open.
        const inspectorSection = target.dataset?.inspectorSection;
        if (inspectorSection !== undefined && target.dataset.filterOpened !== undefined) {
          // Opened by the filter, not the author (the toggle arrives after the open, queued):
          // not remembered. The author folding it again while it is marked is remembered.
          if (target.open) {
            return;
          }
          delete target.dataset.filterOpened;
        }
        if (inspectorSection !== undefined) {
          if (target.open) {
            this.collapsedSections.delete(inspectorSection);
            this.openedSections.add(inspectorSection);
          } else {
            this.collapsedSections.add(inspectorSection);
            this.openedSections.delete(inspectorSection);
          }
          return;
        }
        const ruleSection = target.dataset?.ruleSection;
        const nodeId = this.subjectId();
        if (ruleSection !== undefined && nodeId) {
          const working = this.rules(nodeId);
          if (target.open) {
            working.open.add(ruleSection);
          } else {
            working.open.delete(ruleSection);
          }
        }
      },
      true
    );

    /**
     * A `<select>` commits on `change`; text/number/checkbox stream on `input`. Routing each
     * control to only its own event keeps one write per interaction even though browsers fire
     * both for a select.
     *
     * Everything here writes to the controller's *draft*, never the tree — Save is what makes
     * an edit real, and it lands as a single undo entry rather than one per keystroke.
     */
    const applyPropertyEdit = (target: HTMLElement, eventType: "input" | "change"): void => {
      const path = target.dataset.prop;
      const nodeId = this.subjectId();
      if (!nodeId || !path) {
        return;
      }
      if (path === "id") {
        if (eventType === "input") {
          this.ctrl?.setDraftId(nodeId, (target as HTMLInputElement).value);
        }
        return;
      }
      const control = target.dataset.control ?? "text";
      // A file input fires `change` alone, like a select.
      if (eventType !== (control === "select" || control === "file" ? "change" : "input")) {
        return;
      }
      const input = target as HTMLInputElement;
      // The Format box is no property: its choice becomes a pattern and a message in the draft.
      if (path === PATTERN_PRESET_PATH) {
        this.applyPatternPreset(nodeId, input.value);
        return;
      }
      if (control === "file") {
        void this.applyFileEdit(nodeId, path, input);
        return;
      }
      if (control === "expression") {
        // Streams like a text box, but only JSON that parses reaches the draft: the text as
        // typed and the parse failure stay in the panel (see ExpressionWorkingState), so a
        // half-written expression neither clobbers the last good one nor vanishes on repaint.
        // Blank parses to `undefined`, which clears the property.
        const working = this.expressions(nodeId);
        const text = (target as HTMLTextAreaElement).value;
        working.texts.set(path, text);
        const parsed = parseExpressionJson(text);
        if (parsed.ok) {
          working.errors.delete(path);
          this.ctrl?.setDraftProperty(nodeId, path, parsed.expression);
        } else {
          working.errors.set(path, parsed.error);
          this.paint();
        }
        return;
      }
      const value =
        control === "checkbox"
          ? input.checked
          : control === "number"
            ? numberBoxValue(input.value)
            : input.value;
      if (control === "checkbox" || (control === "select" && this.ctrl?.inspectorModel(nodeId)?.shapeDependsOn?.includes(path))) {
        // A choice that decides which fields are drawn (a source's kind) is a plain write: the panel paints the fields that appear.
        this.ctrl?.setDraftProperty(nodeId, path, value);
      } else {
        this.writeBoxLive(nodeId, path, value);
      }
    };

    const routeEdit = (event: Event, eventType: "input" | "change"): void => {
      const target = event.target as HTMLElement;
      const nodeId = this.subjectId();
      // A binding's named style option (the Style tab) sets its class in the draft's cssClass in one write; a class of a
      // group takes the group's others with it, and the group's "Default" choice takes them all away. The inputs keep their
      // own checked state (a radio group unchecks its rivals itself) and the write is live, so the tab is not repainted:
      // the radio the author is arrowing through stays the one with focus.
      const styleOption = target.dataset?.styleOption;
      const styleGroupClear = target.dataset?.styleGroupClear;
      if (styleOption !== undefined || styleGroupClear !== undefined) {
        if (eventType === "change" && nodeId !== undefined && this.ctrl) {
          const controller = this.ctrl;
          if (styleOption !== undefined) {
            this.writeStyleLive(nodeId, (meta) => controller.setStyleClass(nodeId, styleOption, (target as HTMLInputElement).checked, meta));
          } else if (styleGroupClear !== undefined && (target as HTMLInputElement).checked) {
            this.writeStyleLive(nodeId, (meta) => controller.clearStyleGroup(nodeId, styleGroupClear, meta));
          }
        }
        return;
      }
      // Identity boxes edit FormDefinition.id / version / schemaVersion through the root's
      // draft: streamed per keystroke, committed on Save.
      const identityField = target.dataset?.identityField;
      if (identityField !== undefined) {
        if (eventType === "input") {
          this.setIdentityField(identityField, (target as HTMLInputElement).value);
        }
        return;
      }
      // The Formulas section's policy: a property of the form root, drafted with the others.
      if (target.dataset?.formulaErrors !== undefined) {
        if (eventType === "change" && this.ctrl) {
          this.setFormulaErrors((target as HTMLSelectElement).value);
        }
        return;
      }
      // The Browser assistants section's select: a property of the form root, drafted with the others.
      if (target.dataset?.agentTools !== undefined) {
        if (eventType === "change" && this.ctrl) {
          this.setAgentTools((target as HTMLSelectElement).value);
        }
        return;
      }
      // Another mode's row on the form's settings: drafted on the root, like the identity.
      const rootSetting = target.dataset?.rootSetting;
      if (rootSetting !== undefined) {
        const row = this.shownModeSettings()
          .flatMap((group) => group.rows)
          .find((entry) => entry.id === rootSetting);
        if (eventType === "change" && row) {
          const value = (target as HTMLSelectElement).value;
          // A choice that settles something at once (which journey is the default)
          // is committed by the mode before the value is drafted.
          row.choose?.(value);
          this.ctrl?.setDraftRootSetting(row, value);
        }
        return;
      }
      // The JSON view's plain box (before the editor loads, or if it never does) edits as the editor does.
      if (target.dataset?.jsonEdit !== undefined) {
        if (eventType === "input" && nodeId !== undefined) {
          this.applyJsonEdit(nodeId, (target as HTMLTextAreaElement).value);
        }
        return;
      }
      const valueMapRow = target.dataset?.valueMapRow;
      if (valueMapRow !== undefined) {
        if (eventType === "change" && nodeId) {
          this.applyValueMapEdit(nodeId, target.dataset.valueMapProp ?? "values", valueMapRow, (target as HTMLSelectElement).value);
        }
        return;
      }
      const fileChoice = target.dataset?.fileChoice;
      if (fileChoice !== undefined) {
        if (eventType === "change" && nodeId) {
          this.applyFileChoice(nodeId, fileChoice, target as HTMLSelectElement);
        }
        return;
      }
      if (nodeId && target.dataset?.rule !== undefined) {
        const isSelect = target instanceof HTMLSelectElement;
        // Same rule as above: a select commits on `change`, everything else streams on `input`.
        if (eventType === (isSelect ? "change" : "input")) {
          this.handleRulesEdit(target, nodeId);
        }
        return;
      }
      applyPropertyEdit(target, eventType);
    };

    this.root.addEventListener("input", (event) => routeEdit(event, "input"));
    this.root.addEventListener("change", (event) => routeEdit(event, "change"));
    // Leaving a rule's plain box (the editor over it reports its own blur through onCommit).
    this.root.addEventListener("focusout", (event) => {
      const target = event.target as HTMLElement | null;
      const key = target?.dataset?.rule;
      const nodeId = this.subjectId();
      // Where Keep editing goes back to: a box of the body, not a dialog's.
      const left = target && nodeId !== undefined && target.matches?.("input, select, textarea") && target.closest(".inspector-body") && !target.closest("dialog")
        ? this.focusOf(target)
        : undefined;
      if (left && nodeId !== undefined) {
        this.leftBox = { nodeId, focus: left };
      }
      // Left by a press: the canvas catches up once the press is over (see pressListeners).
      if (key && target?.dataset?.ruleFormula !== undefined && nodeId !== undefined) {
        this.afterPress(() => this.commitFormulaEdit(nodeId, key));
      }
      if (this.liveBoxPending && target?.dataset?.prop !== undefined) {
        this.afterPress(() => this.commitBoxEdit());
      }
    });

    // Enter applies, Escape discards — the panel is a form, and reaching for the mouse to commit
    // a one-word label edit is the kind of friction that makes an editor tiring to use.
    this.root.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      // The ⋯ menu takes Escape first: it closes, focus back on its button, the draft untouched.
      if (this.inspectorMenuOpen && keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        this.inspectorMenuOpen = false;
        this.syncInspectorMenu();
        this.root.querySelector<HTMLElement>("[data-inspector-more]")?.focus();
        return;
      }
      // Enter in a box of several lines is a new line, and Escape there is not Discard — the
      // JSON view's editor included, which is no textarea.
      if (keyEvent.target instanceof HTMLTextAreaElement || (keyEvent.target as HTMLElement | null)?.closest?.(".json-editor")) {
        return;
      }
      // While the options editor is up, Enter in its add row adds the option, Escape closes
      // it, and nothing reaches the panel's own Save/Cancel shortcuts behind it.
      if (this.optionsEditor) {
        const inAddRow = (keyEvent.target as HTMLElement | null)?.dataset?.optionsNew !== undefined;
        if (keyEvent.key === "Enter" && inAddRow && !this.optionsDiscard) {
          keyEvent.preventDefault();
          this.addOptionRow();
        } else if (keyEvent.key === "Escape") {
          // With changes, Escape asks before it discards them; over that question, it keeps editing.
          keyEvent.preventDefault();
          this.escapeActiveDialog();
        }
        return;
      }
      // While a prompt is up, Enter belongs to whichever of its buttons has focus and Escape
      // dismisses it; the shortcuts below would otherwise save or discard behind the
      // prompt's back, leaving it asking about a draft that no longer exists.
      if (this.ctrl?.unsavedChangesPrompt() || this.pendingDeleteId) {
        if (keyEvent.key === "Escape") {
          keyEvent.preventDefault();
          this.dismissPrompt();
        }
        return;
      }
      // Enter on a section heading toggles that section; committing the draft instead would
      // make the panel's own furniture save an edit the author was only navigating past.
      if (keyEvent.target instanceof HTMLElement && keyEvent.target.closest("summary")) {
        return;
      }
      // Enter and Escape act on this panel's own subject, not on whatever else is drafted.
      const subject = this.subjectId();
      if (subject === undefined) {
        return;
      }
      // Enter in the Label box applies and goes on to the next control, as a
      // form's own Enter would, rather than leaving the author on the box (or its "?").
      const inLabel = keyEvent.key === "Enter" && (keyEvent.target as HTMLElement | null)?.dataset?.prop === "label";
      if (keyEvent.key === "Enter" && this.ctrl?.hasPendingChanges(subject)) {
        keyEvent.preventDefault();
        this.saveDraft();
        // Not when the Save was held (a problem it went to, a confirmation it raised).
        if (inLabel && !this.ctrl.hasPendingChanges(subject)) {
          this.focusAfterLabel();
        }
      } else if (inLabel) {
        keyEvent.preventDefault();
        this.focusAfterLabel();
      } else if (keyEvent.key === "Escape" && this.ctrl?.hasPendingChanges(subject)) {
        // What goes with the draft on Cancel goes with it here.
        this.rulesState = emptyRulesState("");
        this.jsonState = undefined;
        this.expressionState = emptyExpressionState("");
        this.ctrl.discardDraft(subject);
        this.syncBoxesToPainted();
      }
    });
  }
}

/**
 * The activity strip's Form panel: the inspector, fixed to the controller's root.
 *
 * A tag of its own rather than a `subject` attribute on the inspector, because the two are
 * different panels in different columns — a page (or a test) reaching for
 * `datum-builder-properties` means the inspector, and would otherwise find whichever of the
 * two came first in the shell's markup.
 */
export class DatumBuilderFormPanelElement extends DatumBuilderPropertiesElement {
  constructor() {
    super();
    // The field, not the setter: a custom element's constructor paints nothing, and the
    // first paint comes with `connectedCallback`.
    this.subjectValue = "root";
  }
}

export function defineBuilderPanels(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  defineDatumLocaleSelectElement();
  if (!customElements.get(DATUM_BUILDER_TOOLBAR_TAG)) {
    customElements.define(DATUM_BUILDER_TOOLBAR_TAG, DatumBuilderToolbarElement);
  }
  if (!customElements.get(DATUM_BUILDER_CANVAS_TAG)) {
    customElements.define(DATUM_BUILDER_CANVAS_TAG, DatumBuilderCanvasElement);
  }
  if (!customElements.get(DATUM_BUILDER_PROPERTIES_TAG)) {
    customElements.define(DATUM_BUILDER_PROPERTIES_TAG, DatumBuilderPropertiesElement);
  }
  if (!customElements.get(DATUM_BUILDER_FORM_PANEL_TAG)) {
    customElements.define(DATUM_BUILDER_FORM_PANEL_TAG, DatumBuilderFormPanelElement);
  }
}
