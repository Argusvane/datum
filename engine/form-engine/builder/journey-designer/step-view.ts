/**
 * The Journeys mode's Step view: one step of the journey on the Form
 * canvas, edited as the person sees it. Everything the mode does to bring it up and put it away
 * is here, in the designer's chunk, so the builder's own bundle carries only the calls.
 *
 * The canvas keeps ONE controller, the journey's. Bringing the view up swaps what that
 * controller is drawn with, in ONE `setOptions`: the form's binding in place of the designer's
 * (followed while the view is up: a binding picked, the builder's scheme switched, `enter` again
 * re-applies it, and the colour scheme is the form's own, read at each draw),
 * no cards (`canvasComponents`), the step canvas's root, view, journey page and chrome
 * (`step-canvas-adapter.ts`), the step picker for the canvas bar, and a palette with the
 * designer's own Page, Form field and Route entries hidden. Putting it away puts back what the
 * controller was built with. Both are one draw: the canvas takes its renderer off the runtime
 * while the sheet changes kind (`BuilderController.canvasRevision`).
 *
 * The step shown is a page node (`pageNodeId`), kept here. It moves when the author steps with
 * the bar's picker, opens a step from the map, or selects a node that sits on another step. A
 * move through the picker or the map selects the step on the journey's controller, which is what
 * the inspector then shows; a selection that moves the view is already that selection.
 *
 * While it is up the inspector, the Undo and the palette follow it: what a form field placed on
 * the step is edited as (`inspection`), one Undo over the form and the journey (`history`).
 */
import type { PropertyEditorField } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderComponentType, BuilderControllerOptions, BuilderController, CanvasRegionOwner } from "../controller/builder-controller.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import type { BuilderInspectorAction, BuilderModeHistory, BuilderModeInspection } from "../web-component/builder-modes.js";
import { builderText } from "./journey-texts-en.js";
import { indexJourneyTree, type JourneyFinding, type JourneyPageEntry } from "./journey-checks.js";
import { JOURNEY_FIELD_TYPE, JOURNEY_PAGE_TYPE, JOURNEY_PAGES_SLOT, JOURNEY_ROUTE_TYPE } from "./journey-mode-model.js";
import { reviewRowField } from "./journey-components.js";
import { createStepCanvas, createStepInspection, type StepCanvas, type StepDrawnTwice, type StepInspection, type StepTagWords } from "./step-canvas-adapter.js";
import { CONTROLLER_MARKS, createStepHistory, type StepHistory } from "./step-history.js";

/** The designer's own entries the Step view's palette does not list: a step is filled with fields, and Form fields places the form's own. */
const HIDDEN_IN_STEP: ReadonlySet<string> = new Set([JOURNEY_PAGE_TYPE, JOURNEY_FIELD_TYPE, JOURNEY_ROUTE_TYPE]);

/**
 * `types` for the Step view's palette: the designer's Page, Form field and Route entries kept
 * (a drop of a form field from the Form fields panel is still one) but not listed.
 */
export function stepPaletteTypes(types: readonly BuilderComponentType[]): BuilderComponentType[] {
  return types.map((entry) => (HIDDEN_IN_STEP.has(entry.type) && entry.hidden !== true ? { ...entry, hidden: true } : entry));
}

/** `types` as the designer builds them: nothing hidden. */
function unhidden(types: readonly BuilderComponentType[]): BuilderComponentType[] {
  return types.map(({ hidden: _hidden, ...entry }) => entry);
}

export interface JourneyStepViewOptions {
  /** The form's controller: its binding draws the step, and a form field placed on the step is inspected on it. */
  form: BuilderController;
  /** The journey's controller (the canvas's), built with `base`. */
  journey: BuilderController;
  /** The catalog entry's id. */
  journeyId(): string;
  /** What the journey's controller was built with: the options leaving the view puts back. */
  base: BuilderControllerOptions;
  /** A step's name as the cards and the map say it. */
  pageName(page: JourneyPageEntry): string;
  /** A form field's label as the list of a Check answers step words its row. */
  fieldLabel(componentId: string): string;
  /** The builder's words (locale and catalog), read live. */
  text(): BuilderTextOptions;
  /** The words a journey-only field's box is tagged with (the authoring chunk's), once it is in. */
  tagWords(): StepTagWords;
  /**
   * Runs `run` once the form field the inspector edits has no unsaved edits (the shell's
   * `holdForInspector`): a move to another step takes that field out of sight.
   */
  hold(run: () => void): void;
  /** What the shell reads of the Step view moved (inspection, history, the shown step). */
  changed(): void;
}

export interface JourneyStepView {
  /** Whether the view is up on the journey's controller. */
  up(): boolean;
  /**
   * Brings the view up on `pageNodeId` (else the step last shown, else the first). Already up:
   * the form's binding and its files are taken again when they moved (a binding picked, the
   * builder's scheme switched).
   */
  enter(pageNodeId?: string): void;
  /** Puts the view away: the controller as it was built. */
  leave(): void;
  /** The step shown: a page node's id; `undefined` for a journey with no step. */
  shown(): string | undefined;
  /**
   * Shows the step `pageNodeId` and selects it (through the guards of the inspector's form field
   * and of the journey's own drafts). `select: false`: the view follows a selection already made.
   */
  show(pageNodeId: string, options?: { select?: boolean }): void;
  /** The journey's tree changed or its types were worded again: the palette's hidden entries are put back. */
  syncTypes(types: readonly BuilderComponentType[]): BuilderComponentType[];
  /** What the shell asks of a mode (`BuilderMode.inspection` and its kin), answering while the view is up. */
  inspection(): BuilderModeInspection | undefined;
  inspectorActions(): readonly BuilderInspectorAction[];
  history(): BuilderModeHistory | undefined;
  /** The history's own change notices, while the view is up. */
  subscribeHistory(listener: () => void): () => void;
  /**
   * Whether the view's Undo is taking back or making again an entry that holds a step on
   * `controller` (the form's): the mode writes no follow-up of its own for the journey's step
   * then, since that entry's form step is the follow-up (step-history.ts).
   */
  stepping(controller: BuilderController): boolean;
  /** What the step's drawing left out, as findings by journey node (`PlacedJourneyFindings.byNode`'s shape). */
  findings(tree: ComponentNode): Map<string, JourneyFinding[]>;
  dispose(): void;
}

export function createJourneyStepView(options: JourneyStepViewOptions): JourneyStepView {
  const { form, journey, base } = options;
  let isUp = false;
  let pageNode: string | undefined;
  /** The step whose Wording section is open (a press on its Continue, Submit or Back, or on a row of its list, opened it). */
  let wordingFor: string | undefined;
  /** The row of a Check answers step's list the author pressed: the Wording box that row has (`review.labels.<component>`). */
  let wordingRow: { pageNodeId: string; componentId: string } | undefined;
  let history: StepHistory | undefined;
  let unfollow: (() => void) | undefined;
  let unwatch: (() => void) | undefined;
  /** The form's binding and files as last laid on the journey's controller. */
  let drawn: { binding: BuilderControllerOptions["binding"]; assets: BuilderControllerOptions["assets"] } | undefined;
  const historyListeners = new Set<() => void>();

  const canvas: StepCanvas = createStepCanvas({
    formRoot: () => form.previewSnapshot(),
    pageNodeId: () => pageNode,
    journeyId: options.journeyId,
    formRevision: () => form.changeRevision(),
    journeyRevision: () => journey.changeRevision(),
    answerWord: () => builderText("journey.step.review.answer", undefined, options.text())
  });
  const inspection: StepInspection = createStepInspection({
    journey: () => journey,
    form,
    canvas,
    words: () => ({
      takeOff: builderText("journey.step.takeOff", undefined, options.text()),
      takeOffBar: builderText("journey.step.takeOffBar", undefined, options.text())
    }),
    active: () => isUp
  });

  const pagesOf = (tree: ComponentNode): ComponentNode[] => tree.children?.[JOURNEY_PAGES_SLOT] ?? [];

  /** The page node shown as the tree stands: the one asked for, else the first. */
  const resolve = (tree: ComponentNode, wanted: string | undefined): string | undefined => {
    const pages = pagesOf(tree);
    return (wanted !== undefined && pages.some((page) => page.id === wanted) ? wanted : undefined) ?? pages[0]?.id;
  };

  /** The step picker the canvas bar shows. */
  const stepper = (): { index: number; total: number; label: string; go(delta: -1 | 1): void } | undefined => {
    if (!isUp) {
      return undefined;
    }
    const tree = journey.previewSnapshot();
    const index = indexJourneyTree(tree);
    const shown = resolve(tree, pageNode);
    const at = index.pages.findIndex((page) => page.nodeId === shown);
    if (at < 0) {
      return undefined;
    }
    return {
      index: at,
      total: index.pages.length,
      label: options.pageName(index.pages[at]!),
      go: (delta) => {
        const target = index.pages[at + delta];
        if (target) {
          show(target.nodeId, { select: true });
        }
      }
    };
  };

  const regionOwner = (tree: ComponentNode): CanvasRegionOwner | undefined => {
    const owner = canvas.regionOwner(tree, {
      step: ({ number, name }) =>
        number === undefined ? builderText("journey.designer.page.refExit", { name }, options.text()) : builderText("journey.designer.page.ref", { number, name }, options.text())
    });
    // A press on the step's buttons opens its Wording, where their words are, and so does one on a row of a Check
    // answers step's list, on that row's box (the heading and counter only select the step).
    return owner && { ...owner, onPress: (part, element) => press(owner.id, part, element) };
  };

  const press = (pageId: string, part: "buttons" | "heading", element?: string): void => {
    const componentId = part === "heading" && element !== undefined ? canvas.reviewRow(journey.previewSnapshot(), element) : undefined;
    if (componentId !== undefined) {
      // A row of a Check answers step's list: its Wording box, in the step's Wording section.
      if (wordingFor === pageId && wordingRow?.pageNodeId === pageId && wordingRow.componentId === componentId) {
        return;
      }
      wordingRow = { pageNodeId: pageId, componentId };
      wordingFor = pageId;
    } else if (part === "buttons") {
      if (wordingFor === pageId && wordingRow === undefined) {
        return;
      }
      wordingRow = undefined;
      wordingFor = pageId;
    } else {
      // The heading and counter only select the step; a row's box open before goes.
      if (wordingRow === undefined) {
        return;
      }
      wordingRow = undefined;
    }
    // The step may be selected already: the inspector draws again with the section open.
    journey.repaintPreview();
  };

  /** The Wording box of the row pressed on a Check answers step (`BuilderControllerOptions.inspectorFields`). */
  const rowFields = (node: ComponentNode): ReadonlyArray<{ section: string; field: PropertyEditorField }> | undefined => {
    if (!wordingRow || node.type !== JOURNEY_PAGE_TYPE || node.id !== wordingRow.pageNodeId) {
      return undefined;
    }
    return [{ section: "wording", field: reviewRowField(wordingRow.componentId, options.fieldLabel(wordingRow.componentId), options.text()) }];
  };

  /**
   * What the step's drawing left out, worded ({@link JourneyStepView.findings}). The designer's
   * check carries the same findings for every step (`journey-designer.ts`), so the inspector's
   * notes, the findings card and the map's counts all say it.
   */
  const stepFindings = (tree: ComponentNode): Map<string, JourneyFinding[]> =>
    canvas.findings(tree, (left: StepDrawnTwice) =>
      builderText("journey.designer.step.drawnTwice", { ids: left.ids.join(", "), by: [...new Set(Object.values(left.drawnBy))].join(", ") }, options.text())
    );

  const chrome: Pick<BuilderControllerOptions, "canvasTags" | "canvasRegionOwner" | "canvasSelectTarget" | "canvasStepper" | "canvasScheme" | "foldedSections" | "inspectorFields"> = {
    canvasTags: (tree) => canvas.tags(tree, options.tagWords()),
    canvasRegionOwner: regionOwner,
    canvasSelectTarget: canvas.selectTargets,
    canvasStepper: stepper,
    // The form's colour scheme, as the shell gives it the builder's: the step is drawn as the Form canvas draws the form.
    canvasScheme: () => form.canvasColorScheme(),
    foldedSections: (node) => (node.type === JOURNEY_PAGE_TYPE && node.id === wordingFor ? [] : base.foldedSections?.(node)),
    inspectorFields: rowFields
  };

  /** The form's binding and files onto the journey's controller when they moved since last laid (none while the view is down). */
  const followDrawing = (): void => {
    const binding = form.canvasBinding();
    const assets = form.canvasAssets();
    if (drawn && drawn.binding === binding && drawn.assets === assets) {
      return;
    }
    drawn = { binding, assets };
    journey.setOptions({ binding, assets });
  };

  function show(pageNodeId: string, shown: { select?: boolean } = {}): void {
    if (!isUp) {
      return;
    }
    options.hold(() => {
      if (shown.select === false || pageNode === pageNodeId || journey.hasPendingChanges()) {
        if (shown.select !== false && !journey.requestSelect(pageNodeId)) {
          // Held (an unsaved edit on the journey): the author answers, the view stays.
          return;
        }
        setShown(pageNodeId);
        return;
      }
      // The step shown first, so the selection's paint draws it on the new step: one paint for
      // both, not the selection drawn on the old step and the new step over it.
      const was = { pageNode, wordingFor, wordingRow };
      pageNode = pageNodeId;
      wordingFor = undefined;
      wordingRow = undefined;
      if (!journey.requestSelect(pageNodeId)) {
        pageNode = was.pageNode;
        wordingFor = was.wordingFor;
        wordingRow = was.wordingRow;
        return;
      }
      inspection.notify();
      options.changed();
    });
  }

  /** The step drawn is `pageNodeId` from now on: drawn again over the same mount. */
  function setShown(pageNodeId: string): void {
    if (pageNode === pageNodeId) {
      return;
    }
    pageNode = pageNodeId;
    wordingFor = undefined;
    wordingRow = undefined;
    journey.repaintPreview();
    inspection.notify();
    options.changed();
  }

  /** A selection on the journey's controller that sits on another step moves the view there. */
  const followSelection = (): void => {
    const selected = journey.selectedComponentId();
    if (!isUp) {
      return;
    }
    if (wordingFor !== undefined && selected !== wordingFor) {
      wordingFor = undefined;
      wordingRow = undefined;
    }
    if (selected === undefined) {
      return;
    }
    const entry = indexJourneyTree(journey.previewSnapshot()).pageOf.get(selected);
    if (entry && entry.nodeId !== pageNode) {
      setShown(entry.nodeId);
    }
  };

  return {
    up: () => isUp,
    enter: (pageNodeId) => {
      if (isUp) {
        followDrawing();
        return;
      }
      const tree = journey.previewSnapshot();
      pageNode = resolve(tree, pageNodeId ?? pageNode);
      wordingFor = undefined;
      wordingRow = undefined;
      isUp = true;
      drawn = { binding: form.canvasBinding(), assets: form.canvasAssets() };
      // One setOptions: the sheet changes kind once, whole (`canvasRevision`).
      journey.setOptions({
        ...drawn,
        canvasComponents: undefined,
        canvasRoot: canvas.canvasRoot,
        canvasView: canvas.canvasView,
        canvasJourneyView: canvas.journeyView,
        componentTypes: stepPaletteTypes(journey.componentTypes()),
        ...chrome
      });
      // The journey's steps of an entry before the form's (step-history.ts): the form's may carry the journeys' block.
      history = createStepHistory([form, journey], CONTROLLER_MARKS, { first: journey });
      unwatch = history.subscribe(() => {
        for (const listener of [...historyListeners]) {
          listener();
        }
      });
      unfollow = journey.on("selection", followSelection);
      inspection.notify();
      options.changed();
    },
    leave: () => {
      if (!isUp) {
        return;
      }
      isUp = false;
      wordingFor = undefined;
      wordingRow = undefined;
      drawn = undefined;
      unfollow?.();
      unfollow = undefined;
      unwatch?.();
      unwatch = undefined;
      history?.dispose();
      history = undefined;
      journey.setOptions({
        binding: base.binding,
        assets: base.assets,
        canvasComponents: base.canvasComponents,
        canvasRoot: base.canvasRoot,
        canvasView: undefined,
        canvasJourneyView: undefined,
        canvasTags: undefined,
        canvasRegionOwner: undefined,
        canvasSelectTarget: undefined,
        canvasStepper: undefined,
        canvasScheme: undefined,
        foldedSections: base.foldedSections,
        inspectorFields: undefined,
        componentTypes: unhidden(journey.componentTypes())
      });
      inspection.notify();
      options.changed();
    },
    shown: () => (isUp ? resolve(journey.previewSnapshot(), pageNode) : undefined),
    show,
    syncTypes: (types) => (isUp ? stepPaletteTypes(types) : [...types]),
    inspection: () => (isUp ? inspection.inspection() : undefined),
    inspectorActions: () => (isUp ? inspection.inspectorActions() : []),
    history: () => history,
    stepping: (controller) => history?.stepping(controller) === true,
    subscribeHistory: (listener) => {
      historyListeners.add(listener);
      return () => {
        historyListeners.delete(listener);
      };
    },
    findings: stepFindings,
    dispose: () => {
      if (isUp) {
        unfollow?.();
        unwatch?.();
        history?.dispose();
        isUp = false;
        drawn = undefined;
      }
      historyListeners.clear();
    }
  };
}
