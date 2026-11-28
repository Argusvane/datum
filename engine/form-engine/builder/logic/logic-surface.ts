/**
 * The Logic workspace's surface: every rule of the form
 * as a sentence, filtered by kind and grouped by step, with an editor for the one chosen. Loaded
 * in a chunk of its own the first time the author opens Logic (`logic-loader.ts`), and drawn
 * where the canvas is in Form.
 *
 * The editor is the formula builder: a
 * rule is one formula in a box that reads as a sentence, with Field and Runs in its head, a
 * helper row, a "Reads as" line, Try it and the foot. The box is the plain textarea first
 * (`formula/formula-textarea.ts`) and the CodeMirror editor once its chunk lands
 * (`formula/formula-editor-loader.ts`); on a failed load the textarea stays with a Retry. The
 * box's DOM is kept across repaints (moved into the fresh slot), as the JSON viewer's is.
 *
 * Paint contract: a keystroke in the box never repaints. The editor's `onChange` writes the
 * working copy and refreshes the live parts (the "Not applied" flag, the summary line, "Reads
 * as", Try it); `onCommit` does the same, since nothing structural changes on a blur and a
 * repaint under a mousedown would swallow the click on Apply. Structural changes (the field, the
 * run scope, the kind) repaint. `onCommit` is `onChange`, not a
 * repaint, because Apply's own mousedown blurs the box, and a repaint under the mousedown would
 * swallow the click.
 *
 * Every word the surface draws comes from the builder text catalog (`builder-texts.ts`) through
 * `text()`, with the surface's `locale` and `catalog`: the rule kinds (`logic.kind.*`), the
 * editor's rows and foot (`logic.editor.*`), Try it (`try.*`) and the findings (`logic.diag.*`).
 * No English is written into the markup, so a host's catalog reaches all of it.
 *
 * It edits the form's controller for the form's rules; a journey's Go to rule is
 * edited the same way, in a copy, but written through the Journeys mode's host
 * (`logic-journey-host.ts`) to that journey's own controller, never to the form's. A rule is worked on in a copy of its own and
 * written with Apply as one undo step (`setProperties`), always as text: a bare string, or the
 * object form `{ formula, run }` when it runs somewhere other than both sides. A rule stored as
 * a tree opens printed and is written back as text only when edited. Discard drops the copy.
 * While the copy differs from the tree the surface is the controller's leave guard, so a
 * workspace switch or the host's Save asks first, with the same prompt as the inspector's.
 */
import type { BuilderController, BuilderChangeReason } from "../controller/builder-controller.js";
import { BuilderPreviewRuntime, type BuilderPreviewRuntimeOptions } from "../preview/builder-preview-runtime.js";
import { builderTokens, esc, unsavedChangesPromptHtml } from "../web-component/builder-shared.js";
import { SURFACE_SHEET_STYLES, SurfaceSheet } from "../web-component/surface-sheet.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { isEmptyValue } from "../../validation/core/field-constraints.js";
import { kernelFoldHoldsOwnAnswer } from "../../core/state/submittable-fold.js";
import { ownValue } from "../../core/state/form-state.js";
import { defaultValidationMessage } from "../../core/localization/validation-messages.js";
import { kernelExprReadsClock } from "../../rules/evaluator/evaluator.js";
import type { Expression, RunScope } from "../../core/expressions/expression.js";
import { DEFAULT_HIDDEN_VALUE_BEHAVIOR, defaultHiddenValueBehaviorFor, type HiddenValueBehavior } from "../../core/state/effective-state.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import {
  FORMULA_SNIPPETS,
  feelName,
  formulaFunctionRows,
  formulaSignatures,
  pluginSnippets,
  type FormulaFunctionRow,
  type FormulaFunctionTableSource,
  type FormulaSnippet
} from "../formula/feel-functions.js";
import { printFormula } from "../formula/feel-print.js";
import { FORMULA_EDITOR_STYLES } from "../formula/formula-editor-styles.js";
import { loadFormulaEditor, type FormulaEditorModule } from "../formula/formula-editor-loader.js";
import { formulaFieldKind, formulaFieldsOf, type FormulaField } from "../formula/formula-fields.js";
import { baseTypeOf } from "../../registry/kinds.js";
import {
  formulaEditorState,
  mountFormulaTextarea,
  type FormulaEditor,
  type FormulaEditorOptions,
  type FormulaEditorState
} from "../formula/formula-textarea.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { BuilderTextCatalog, BuilderTextKey, BuilderTextOptions } from "./builder-texts.js";
import { LOGIC_EN, builderPlural, builderText } from "./logic-texts-en.js";
import { buildLogicModelAndWords, expressionReads, withNodeCopy, rulesForFilter, type LogicWords } from "./logic-model.js";
import { logicJourneyHostOf, watchLogicJourneyHost, type LogicJourneyHost, type LogicOpenRequest, type LogicRouteRef } from "./logic-journey-host.js";
import type { LogicFilterId, LogicJourneySummary, LogicModel, LogicRule, LogicRuleKind, LogicToken } from "./logic-types.js";
import { JOURNEY_END } from "../../core/schema/journey.js";
import type { BuilderLogicOpenTestDetail, BuilderLogicWriteTestDetail, TestsPinsOf } from "../form-tests/tests-model.js";
import { showBuilderModal } from "../web-component/modal-place.js";

export const DATUM_BUILDER_LOGIC_TAG = "datum-builder-logic";

/** Detail of `logic-open-document`: a read-only rule's "Open in designer". */
export interface LogicOpenDocumentDetail {
  mode: "journeys" | "pdf";
  documentId: string;
}

/** The leave guard's subject id: the prompt the surface draws is the one naming it. */
/** The id this surface's leave guard names itself by: the held prompt carries it as `external.id`. */
export const GUARD_ID = "logic-rule";

const FILTERS: readonly LogicFilterId[] = ["all", "show", "require", "calculate", "steps", "journeys", "pdf"];

/** The kinds the editor writes, each with the rule key it stores under. */
const EDITABLE_KINDS: Readonly<Partial<Record<LogicRuleKind, string>>> = {
  show: "visibleWhen",
  hide: "visibleWhen",
  require: "requiredWhen",
  validate: "validWhen",
  enable: "enabledWhen",
  readonly: "readonlyWhen",
  calculate: "value",
  default: "defaultValue",
  "min-rows": "minRows",
  "max-rows": "maxRows",
  filter: "filter",
  gate: "navigationGating",
  "show-step": "visibleWhen",
  "hide-step": "visibleWhen"
};

/**
 * The Logic kinds a rule key stands for when the Tests panel names the rule an expectation reads
 * (`expect x visible` reads `visibleWhen`, which a Show or a Hide rule stores).
 */
const RULE_KEY_KINDS: Readonly<Record<string, readonly LogicRuleKind[]>> = {
  visibleWhen: ["show", "hide"],
  requiredWhen: ["require"],
  enabledWhen: ["enable"],
  readonlyWhen: ["readonly"],
  validWhen: ["validate"],
  calculate: ["calculate"]
};

/** The kinds no test can pin yet (a test has no expectation for them): their editors draw no "Pinned by" line. */
const UNPINNABLE_KINDS: ReadonlySet<LogicRuleKind> = new Set(["default", "filter", "gate"]);

/** The rule keys that run in the browser by nature (defaults, option filters, step gates): their Runs control is fixed. */
const BROWSER_ONLY_KEYS: ReadonlySet<string> = new Set(["defaultValue", "filter", "navigationGating"]);

/** The kinds that store `not(…)` around what the box holds. */
const NEGATED_KINDS: ReadonlySet<LogicRuleKind> = new Set(["hide", "hide-step"]);

const VALUE_KINDS: ReadonlySet<LogicRuleKind> = new Set(["calculate", "default", "min-rows", "max-rows"]);

/** What "New rule" offers, in order (each kind's words are `logic.kind.<stem>` in the catalog). */
const NEW_RULE_KINDS: readonly LogicRuleKind[] = ["show", "hide", "require", "validate", "calculate", "default", "show-step", "route"];

/**
 * The catalog key stem of each kind's words: `logic.kind.<stem>` is the editor's head and the New
 * rule menu's label, `.hint` the one-line description, `.lead` the words above the box ("Show
 * {field} when", "{field} is"); a kind set elsewhere (a journey page, a PDF layout) has no lead.
 */
const KIND_KEY_STEMS: Readonly<Partial<Record<LogicRuleKind, string>>> = {
  show: "show",
  hide: "hide",
  require: "require",
  validate: "validate",
  enable: "enable",
  readonly: "readonly",
  calculate: "calculate",
  default: "default",
  "min-rows": "minRows",
  "max-rows": "maxRows",
  filter: "filter",
  gate: "gate",
  "show-step": "showStep",
  "hide-step": "hideStep",
  route: "route",
  "pdf-layout": "pdfLayout"
};

const HIDDEN_CHOICES: ReadonlyArray<{ value: HiddenValueBehavior; key: BuilderTextKey }> = [
  { value: "exclude-from-submission", key: "logic.hidden.exclude" },
  { value: "retain", key: "logic.hidden.retain" },
  { value: "clear", key: "logic.hidden.clear" }
];

/** The Runs menu's choices in order, each with its catalog label and one-line consequence. */
const RUN_CHOICES: ReadonlyArray<{ value: RunScope; label: BuilderTextKey; hint: BuilderTextKey }> = [
  { value: "both", label: "run.both", hint: "run.both.hint" },
  { value: "browser", label: "run.browser", hint: "run.browser.hint" },
  { value: "server", label: "run.server", hint: "run.server.hint" },
  { value: "server-secret", label: "run.secret", hint: "run.secret.hint" }
];

const RUN_LABELS: Record<RunScope, BuilderTextKey> = { both: "run.both", browser: "run.browser", server: "run.server", "server-secret": "run.secret" };

/** The mark before the problem under the box. */
const PROBLEM_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" class="problem-mark"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';

/** The component Try it adds to a copy of the tree to read a Go to rule's condition (see `tryRouteResultHtml`). */
const ROUTE_PROBE_ID = "datum-route-probe";

/** The lock glyph on a secret rule's chip. */
const LOCK_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 018 0v4"></path></svg>';
const CHEVRON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
const TICK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';

/**
 * A Go to rule's own parts (kind `route`): the journey and the step it leaves, by page id, and
 * where it goes (a page id of the journey, or `$end`). `openedTo` is where it went when opened;
 * `routeIndex` its written position once it is saved, which is how the host names it.
 */
interface WorkingRoute {
  journeyId: string;
  pageId: string;
  to: string;
  openedTo: string;
  routeIndex: number | undefined;
}

/** The rule the editor is working on: a copy, written by Apply. */
interface Working {
  /** The rule's id when it exists; a new rule has none until applied. */
  ruleId: string | undefined;
  kind: LogicRuleKind;
  componentId: string | undefined;
  ruleKey: string;
  /** The formula as typed. For a hide rule: the condition inside the `not(…)` the rule stores. */
  text: string;
  run: RunScope;
  /** The text and run scope as opened: a rule neither has changed is not written back (a tree stays a tree). */
  openedText: string;
  openedRun: RunScope;
  hidden: HiddenValueBehavior;
  /** For a show rule: printed from the live form with a note while hidden (`print.show: "always"`). */
  paper: boolean;
  /**
   * For a validate rule: the source text of the field's `messages.rule` as typed, and
   * as opened. Written only when it changed, into the stored text's `default`, its translations kept.
   */
  message: string;
  openedMessage: string;
  /** The copy as it was opened, for "Not applied". */
  baseline: string;
  /** For a Go to rule: where it leaves and goes (the journey's own controller is written, never the form's). */
  route?: WorkingRoute | undefined;
}

export class DatumBuilderLogicElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private ctrl: BuilderController | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Listening to the Journeys mode's host (a journey changed, the map asks for a rule), while the surface is on the page. */
  private hostOff: (() => void) | undefined;
  /** Listening for the Journeys mode to register (or leave) after the surface looked: it may arrive late. */
  private hostWatchOff: (() => void) | undefined;
  /** Set while the surface moves a Go to rule itself, so the change it raises does not repaint over the rule's old position. */
  private movingRoute = false;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private localeValue: string | undefined;
  private catalogValue: BuilderTextCatalog | undefined;
  private functionSource: FormulaFunctionTableSource | undefined;
  private referenceHrefValue: string | undefined;
  private filter: LogicFilterId = "all";
  /** "Show them" on a diagnostic: the rules it names, until the filter changes. */
  private spotlight: Set<string> | undefined;
  private working: Working | undefined;
  /** The answers typed into Try it, by component id; `$today` is the day the clock reads. */
  private tryValues = new Map<string, unknown>();
  /** The day Try it's clock reads, fixed when the rule opens, shown in a date box when the formula reads today(). */
  private tryToday = calendarDate(new Date());
  /** The Try it boxes as last drawn: the fields read, so a keystroke that changes none keeps the boxes. */
  private trySignature = "";
  private newMenuOpen = false;
  private runMenuOpen = false;
  /** A switch to another rule held behind the surface's own prompt while the copy is not applied. */
  private heldSwitch: (() => void) | undefined;
  /** Bumped by every controller change: the key the model, the words and the field list are memoised under. */
  private changeStamp = 0;
  /** The kind each rule was applied as this session; the model prefers it while the stored text is the one written. */
  private authoredStamp = 0;
  private readonly authoredKinds = new Map<string, { kind: LogicRuleKind; stored: string }>();
  private modelMemo: { hostStamp: string; stamp: number; ctrl: BuilderController; definition: unknown; notes: unknown; locale: unknown; catalog: unknown; authored: number; model: LogicModel; words: LogicWords } | undefined;
  private fieldsMemo: { stamp: number; ctrl: BuilderController; locale: string; fields: FormulaField[] } | undefined;
  private model: LogicModel | undefined;
  private words: LogicWords | undefined;
  private bound = false;
  /** The formula box, kept across repaints; `undefined` until an editable rule is open. */
  private editor: FormulaEditor | undefined;
  /** The box's parse state as of its last callback; computed from the text when the box has not spoken yet. */
  private editorState: FormulaEditorState | undefined;
  /** Whether the CodeMirror chunk failed to load for the open box: the textarea stays, with Retry. */
  private editorFailed = false;
  /** How the CodeMirror editor is loaded; a test swaps in a rejecting loader to see the fallback. */
  public formulaEditorLoader: () => Promise<FormulaEditorModule> = loadFormulaEditor;

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  public connectedCallback(): void {
    this.bind();
    if (this.unsubscribe === undefined && this.ctrl !== undefined) {
      // Back on the page: changes made while it was away are unseen, so cached reads are stale.
      this.changeStamp += 1;
    }
    this.subscribe();
    this.attachGuard();
    this.paint();
  }

  public disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.hostOff?.();
    this.hostOff = undefined;
    this.hostWatchOff?.();
    this.hostWatchOff = undefined;
    this.ctrl?.setLeaveGuard(undefined);
    this.sheet.dispose();
  }

  /**
   * Listens to the controller's changes while the surface is on the page. A surface the shell drops
   * (a reconnect replaces its markup) would otherwise stay in the controller's listener list for
   * the controller's life, so it lets go on disconnect and takes the listener again on connect.
   * The controller itself stays: the setter owns that, and clearing it would also clear the
   * controller's single leave-guard slot.
   */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.ctrl?.on("change", (event) => this.onChange(event.reason));
    this.hostWatchOff?.();
    this.hostWatchOff = undefined;
    const form = this.ctrl;
    if (form !== undefined) {
      // The Journeys mode registers when its chunk arrives, or when `features` turns it on: a surface that looked before then
      // would list the journeys read-only for good, so it looks again when told (a tick later: the mode is still being made).
      this.hostWatchOff = watchLogicJourneyHost(form, () => {
        queueMicrotask(() => {
          if (this.isConnected && this.ctrl === form) {
            this.subscribeHost();
            this.changeStamp += 1;
            this.paint();
          }
        });
      });
    }
    this.subscribeHost();
  }

  /** The Journeys mode's host for the form's controller, when the builder has that mode (see `logic-journey-host.ts`). */
  private journeyHost(): LogicJourneyHost | undefined {
    return logicJourneyHostOf(this.ctrl);
  }

  /**
   * Follows the journeys while the surface is on the page: a change of a journey repaints, a
   * request from the map opens its rule, and one the map made while this chunk was loading is
   * taken once the shell's own opening (the selected field's rule) is done. Asks the host to load
   * what its writes need (when the form has a journey), so the Go to rules are editable as soon as it is ready.
   */
  private subscribeHost(): void {
    this.hostOff?.();
    this.hostOff = undefined;
    const host = this.journeyHost();
    if (!host || !this.isConnected) {
      return;
    }
    // The designer's chunk is loaded only for a form that has a journey to edit: opening Logic on
    // a form with none never pays for it.
    const prepare = (): void => {
      if (!host.ready() && host.journeys().length > 0) {
        void host.prepare();
      }
    };
    const offChange = host.subscribe(() => {
      if (this.movingRoute) {
        return;
      }
      this.changeStamp += 1;
      prepare();
      this.paint();
    });
    const offOpen = host.onOpen((request) => this.openRequest(request));
    this.hostOff = () => {
      offChange();
      offOpen();
    };
    prepare();
    queueMicrotask(() => {
      if (this.journeyHost() === host && this.isConnected) {
        const pending = host.takePending();
        if (pending) {
          this.openRequest(pending);
        }
      }
    });
  }

  public static get observedAttributes(): string[] {
    return ["data-phone"];
  }

  /** The tier changed under an open editor: it becomes (or stops being) a dialog without a repaint. */
  public attributeChangedCallback(): void {
    if (this.isConnected && this.bound) {
      this.sheet.sync(this.working !== undefined);
    }
  }

  /** The rule whose row the sheet came from, so focus goes back to it on close. */
  private sheetRuleId: string | undefined;

  /** The phone sheet over the rule list: dialog semantics, scrim, Escape, grabber, focus. */
  private readonly sheet = new SurfaceSheet({
    host: this,
    sheet: () => this.root.querySelector<HTMLElement>("[data-logic-editor]"),
    dismiss: () => this.requestOpen(() => this.discard()),
    grabLabel: (tall) => this.text(tall ? "shell.sheet.grabTall" : "shell.sheet.grab"),
    opener: () => {
      const byRule = this.sheetRuleId ? this.root.querySelector<HTMLElement>(`[data-logic-rule="${quoteAttr(this.sheetRuleId)}"]`) : null;
      return byRule ?? this.root.querySelector<HTMLElement>("[data-logic-new]");
    },
    firstControl: (sheet) => sheet.querySelector<HTMLElement>("[data-logic-target], [data-logic-from], [data-logic-run-btn], [data-logic-close], [data-logic-discard]")
  });

  /** The form's controller: Logic reads and writes the form only. */
  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  public set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.hostOff?.();
    this.hostOff = undefined;
    this.hostWatchOff?.();
    this.hostWatchOff = undefined;
    this.ctrl?.setLeaveGuard(undefined);
    this.ctrl = value;
    this.working = undefined;
    // A switch held behind the old copy's question goes with the copy.
    this.heldSwitch = undefined;
    this.forgetAuthoredKinds();
    this.dropEditor();
    if (this.isConnected) {
      this.subscribe();
    }
    this.attachGuard();
    this.paint();
  }

  /** The whole definition, for the journeys' and PDF layouts' rules it lists read-only. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
    this.paint();
  }

  private openableValue: { readonly pdf: boolean; readonly journeys: boolean } = { pdf: true, journeys: true };

  /**
   * Which read-only rules offer "Open layout / journey / in designer" (the `pdf` and `journeys`
   * features): a side the builder has no designer for lists its rules as sentences with
   * no button that would do nothing. Both, unless the shell says otherwise; an unchanged value
   * costs no paint.
   */
  public get openableDocuments(): { readonly pdf: boolean; readonly journeys: boolean } {
    return this.openableValue;
  }

  public set openableDocuments(value: { pdf?: boolean | undefined; journeys?: boolean | undefined }) {
    const next = { pdf: value.pdf !== false, journeys: value.journeys !== false };
    if (next.pdf === this.openableValue.pdf && next.journeys === this.openableValue.journeys) {
      return;
    }
    this.openableValue = next;
    if ((this.filter === "pdf" && !next.pdf) || (this.filter === "journeys" && !next.journeys)) {
      this.filter = "all";
    }
    this.paint();
  }

  private canOpen(mode: "form" | "journeys" | "pdf"): boolean {
    return mode === "form" ? false : this.openableValue[mode];
  }

  /** The builder's own language for its words (the text catalog's locale), not the form's. */
  public set locale(value: string | undefined) {
    this.localeValue = value;
    this.paint();
  }

  public set catalog(value: BuilderTextCatalog | undefined) {
    this.catalogValue = value;
    this.paint();
  }

  /** The plugin functions the host wired (`platform.formulaFunctions`, or their table rows), listed with the built-ins. */
  public set formulaFunctions(value: FormulaFunctionTableSource | undefined) {
    this.functionSource = value;
    this.paint();
  }

  /** Where the "Formula reference" link goes; absent, the repository's `docs/formulas.md`. */
  public set referenceHref(value: string | undefined) {
    this.referenceHrefValue = value;
  }

  /** Whether the editor holds a copy that Apply has not written. */
  public get dirty(): boolean {
    const working = this.working;
    return working !== undefined && this.serialize(working) !== working.baseline;
  }

  /**
   * Opens the rule on `componentId` the way a click on its card would (the shell's selection).
   * `kind` is the rule key a test's expectation reads, as the Tests panel names it (`visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`, `validWhen`,
   * `calculate`); a field with several rules then opens the one the test is about. A Logic kind
   * (`show`, `validate`, ...) is taken as is, and a key the field has no rule for falls back to
   * its first rule, so Open rule never lands nowhere.
   */
  public openRuleFor(componentId: string, kind?: string): void {
    const own = this.model?.rules.filter((entry) => entry.source.mode === "form" && entry.target.id === componentId) ?? [];
    const wanted = kind === undefined ? undefined : Object.prototype.hasOwnProperty.call(RULE_KEY_KINDS, kind) ? RULE_KEY_KINDS[kind] : [kind as LogicRuleKind];
    const rule = (wanted ? own.find((entry) => wanted.includes(entry.kind)) : undefined) ?? own[0];
    if (rule) {
      this.requestOpen(() => this.open(rule));
    }
  }

  private pinsSource: TestsPinsOf | undefined;

  /**
   * The tests that pin each rule, fed by the shell once the Tests chunk has answered. `undefined` draws no "Pinned by" line at all: the surface never loads the
   * chunk itself, so a page without the Tests feature pays nothing and shows nothing.
   */
  public get testsPins(): TestsPinsOf | undefined {
    return this.pinsSource;
  }

  public set testsPins(value: TestsPinsOf | undefined) {
    if (value === this.pinsSource) {
      return;
    }
    this.pinsSource = value;
    // Only an open saved rule draws the line, so the list behind it needs no repaint.
    if (this.working?.ruleId !== undefined) {
      this.paint();
    }
  }

  // --- the controller and its leave guard ------------------------------------------

  private attachGuard(): void {
    if (!this.ctrl || !this.isConnected) {
      return;
    }
    this.ctrl.setLeaveGuard({
      pending: () => this.dirty,
      subject: () => ({ id: GUARD_ID, label: this.workingLabel(), blocked: this.workingProblem() !== undefined }),
      save: () => this.apply(),
      discard: () => this.discard()
    });
  }

  private onChange(reason: BuilderChangeReason): void {
    // A write of the surface's own is followed by this repaint; every other change (undo, an
    // edit in Form, a prompt raised or answered) repaints too, since any can move a rule.
    if (reason === "init") {
      // A different form was opened or created: the kinds noted for the last one are not its.
      this.forgetAuthoredKinds();
    }
    this.changeStamp += 1;
    this.paint();
  }

  /** Drops the session's notes of the kind each rule was authored as, and the model that carries them. */
  private forgetAuthoredKinds(): void {
    if (this.authoredKinds.size > 0) {
      this.authoredKinds.clear();
    }
    this.authoredStamp += 1;
  }

  private textOptions(): BuilderTextOptions {
    return { ...(this.localeValue ? { locale: this.localeValue } : {}), ...(this.catalogValue ? { catalog: this.catalogValue } : {}) };
  }

  private text(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return builderText(key, params, this.textOptions());
  }

  /** The count's words ("1 rule", "3 rules") in the surface's locale. */
  private plural(count: number): string {
    return builderPlural("logic.rules.count", count, undefined, this.textOptions());
  }

  /** A kind's words from the catalog: its label, its one-line hint and the lead above the box with `field` in it. */
  private kindWords(kind: LogicRuleKind, field?: string): { label: string; description: string; lead: string } {
    const stem = KIND_KEY_STEMS[kind];
    if (stem === undefined) {
      return { label: this.text("logic.kind.rule"), description: "", lead: "" };
    }
    const leadKey = `logic.kind.${stem}.lead`;
    return {
      label: this.text(`logic.kind.${stem}` as BuilderTextKey),
      description: this.text(`logic.kind.${stem}.hint` as BuilderTextKey),
      lead: Object.prototype.hasOwnProperty.call(LOGIC_EN, leadKey) ? this.text(leadKey as BuilderTextKey, { field: field ?? "…" }) : ""
    };
  }

  /** The model and its words, rebuilt only when the tree (a controller change), the definition, the rename notes, the locale or the catalog moved. */
  private buildModel(): { model: LogicModel; words: LogicWords } | undefined {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    const definition = this.definitionSource?.();
    const notes = controller.renameNotes();
    const memo = this.modelMemo;
    // The journeys are the Journeys mode's own where the builder has one (always current, and
    // editable once its writes can run); a version moves with either.
    const host = this.journeyHost();
    const hostStamp = host ? `${host.version()}:${host.ready()}` : "";
    if (
      memo !== undefined &&
      memo.hostStamp === hostStamp &&
      memo.stamp === this.changeStamp &&
      memo.ctrl === controller &&
      memo.definition === definition &&
      memo.notes === notes &&
      memo.locale === this.localeValue &&
      memo.catalog === this.catalogValue &&
      memo.authored === this.authoredStamp
    ) {
      return memo;
    }
    const built = buildLogicModelAndWords(controller.snapshot(), {
      ...(definition ? { definition } : {}),
      ...(host ? { journeys: host.journeys(), journeysEditable: host.ready() } : {}),
      ...(notes.length > 0 ? { renameNotes: notes } : {}),
      ...(this.localeValue ? { locale: this.localeValue } : {}),
      ...(this.catalogValue ? { catalog: this.catalogValue } : {}),
      // The form's translations name fields and options in the surface's language.
      translations: controller.translations(),
      translationCatalog: controller.translationCatalog(),
      ...(this.authoredKinds.size > 0 ? { authoredKinds: this.authoredKinds } : {})
    });
    this.modelMemo = { hostStamp, stamp: this.changeStamp, ctrl: controller, definition, notes, locale: this.localeValue, catalog: this.catalogValue, authored: this.authoredStamp, ...built };
    return this.modelMemo;
  }

  // --- painting ---------------------------------------------------------------------

  private paint(): void {
    if (!this.isConnected) {
      return;
    }
    const controller = this.ctrl;
    if (!controller) {
      this.root.innerHTML = `<style>${builderTokens()}${LOGIC_STYLES}${SURFACE_SHEET_STYLES}${FORMULA_EDITOR_STYLES}</style><div class="logic"><p class="empty">${esc(this.text("logic.noController"))}</p></div>`;
      return;
    }
    const built = this.buildModel()!;
    const model = built.model;
    this.model = model;
    this.words = built.words;
    // The rule being edited may have gone (an undo, a delete in Form): its copy goes with it.
    // A clean copy follows the stored rule (an undo after Apply puts the earlier text back).
    if (this.working?.ruleId !== undefined && !this.dirty) {
      const stored = model.rules.find((rule) => rule.id === this.working!.ruleId);
      if (!stored) {
        this.working = undefined;
        this.dropEditor();
      } else {
        this.followStored(this.working, stored);
      }
    }
    const focus = this.captureFocus();
    const boxHadFocus = this.editor?.hasFocus === true;
    const prompt = this.promptHtml(controller);
    this.root.innerHTML = `<style>${builderTokens()}${LOGIC_STYLES}${SURFACE_SHEET_STYLES}${FORMULA_EDITOR_STYLES}</style>
      <div class="logic" data-logic${this.working ? " data-editing" : ""}>
        ${this.filtersHtml(model)}
        <section class="logic-list" aria-labelledby="logic-list-title">
          <h2 class="sr-only" id="logic-list-title">${esc(this.text("logic.list.title"))}</h2>
          ${this.stepsHtml(model)}
          ${this.diagnosticsHtml(model)}
          ${this.listHtml(model)}
        </section>
        ${this.editorHtml(model)}
        ${prompt}
      </div>`;
    this.mountEditor();
    if (boxHadFocus) {
      this.editor?.focus();
    } else {
      this.restoreFocus(focus);
    }
    this.reportSheet(this.working !== undefined);
    if (this.working?.ruleId !== undefined) {
      this.sheetRuleId = this.working.ruleId;
    }
    this.sheet.sync(this.working !== undefined);
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
      dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
    }
  }

  /**
   * A clean copy takes the stored rule's text, run scope and kind, and its field's "When hidden",
   * "On paper" and check words, when they moved under it (an undo, an edit in Form). The kind is
   * compared on its own: a Show over `c` and a Hide over `not(c)` open with the same box text, and
   * Apply wraps the box by the copy's kind.
   */
  private followStored(working: Working, rule: LogicRule): void {
    if (working.route !== undefined) {
      this.followStoredRoute(working, working.route, rule);
      return;
    }
    // What a hidden answer does, whether it prints on paper and a check's words are the
    // component's keys, which the inspector writes too: a clean copy shows what is stored now.
    // Apply compares "On paper" with the live `print.show`, so a stale tick would write it again.
    const hidden = rule.hiddenValueBehavior ?? this.hiddenDefaultOf(working.componentId);
    if ((working.kind === "show" || working.kind === "hide") && hidden !== working.hidden) {
      working.hidden = hidden;
      working.baseline = this.serialize(working);
    }
    const paper = working.componentId !== undefined && this.printShowOf(working.componentId) === "always";
    const message = typeof rule.message === "string" ? rule.message : "";
    if (paper !== working.paper || message !== working.openedMessage) {
      working.paper = paper;
      working.message = message;
      working.openedMessage = message;
      working.baseline = this.serialize(working);
    }
    const text = openedTextOf(rule);
    if (text === working.openedText && rule.run === working.openedRun && rule.kind === working.kind) {
      return;
    }
    working.text = text;
    working.openedText = text;
    working.run = rule.run;
    working.openedRun = rule.run;
    working.kind = rule.kind;
    working.hidden = rule.hiddenValueBehavior ?? this.hiddenDefaultOf(working.componentId);
    working.baseline = this.serialize(working);
    this.editorState = undefined;
    this.editor?.setText(text);
  }

  /** A clean Go to rule takes the stored text and target when they moved under it (an undo on the journey, an edit on the map). */
  private followStoredRoute(working: Working, route: WorkingRoute, rule: LogicRule): void {
    const text = rule.formula;
    if (text === working.openedText && rule.target.id === route.openedTo) {
      return;
    }
    working.text = text;
    working.openedText = text;
    route.to = rule.target.id;
    route.openedTo = rule.target.id;
    working.baseline = this.serialize(working);
    this.editorState = undefined;
    this.editor?.setText(text);
  }

  /** Whether the editor is up, as last said: a phone draws it as a sheet over the shell's bars. */
  private sheetReported = false;

  private reportSheet(open: boolean): void {
    if (open === this.sheetReported) {
      return;
    }
    this.sheetReported = open;
    this.dispatchEvent(new CustomEvent<{ open: boolean }>("builder-sheet-change", { detail: { open }, bubbles: true, composed: true }));
  }

  private filtersHtml(model: LogicModel): string {
    const keyOf: Record<LogicFilterId, BuilderTextKey> = {
      all: "logic.filter.all",
      show: "logic.filter.show",
      require: "logic.filter.require",
      calculate: "logic.filter.calculate",
      steps: "logic.filter.steps",
      journeys: "logic.filter.journeys",
      pdf: "logic.filter.pdf"
    };
    // A side the builder has no designer for (the pdf / journeys features off) has no rules to filter by.
    const shown = FILTERS.filter((id) => (id === "pdf" || id === "journeys" ? this.openableValue[id] : true));
    const buttons = shown.map((id) => {
      const label = this.text(keyOf[id]);
      const count = model.counts[id] ?? 0;
      const pressed = this.filter === id && !this.spotlight;
      return `<button type="button" class="filter" data-logic-filter="${id}" aria-pressed="${pressed}"><span>${esc(label)}</span><span class="filter-count" aria-label="${esc(this.plural(count))}">${count}</span></button>`;
    }).join("");
    // A Go to rule is offered where a Journeys mode can write it and a journey has a step to leave.
    const routes = this.journeyHost()?.ready() === true && model.journeys.some((journey) => journey.pages.some((page) => page.firstOfId && !page.stops));
    const kinds = NEW_RULE_KINDS.filter((kind) => (kind === "show-step" ? model.steps.length > 0 : kind === "route" ? routes : true));
    return `<nav class="logic-filters card" aria-label="${esc(this.text("logic.filters.aria"))}">
        <div class="filter-list">${buttons}</div>
        <div class="new-rule">
          <button type="button" class="btn primary new-rule-btn" data-logic-new aria-haspopup="menu" aria-expanded="${this.newMenuOpen}">${esc(this.text("logic.newRule"))}</button>
          <div class="menu new-menu" role="menu" data-logic-new-menu${this.newMenuOpen ? "" : " hidden"}>
            ${kinds
              .map((kind) => {
                const words = this.kindWords(kind);
                return `<button type="button" class="menu-item" role="menuitem" data-logic-new-kind="${kind}"><strong>${esc(words.label)}</strong><span>${esc(words.description)}</span></button>`;
              })
              .join("")}
          </div>
        </div>
      </nav>`;
  }

  /** The page-flow strip: the form's steps in order, a dashed one shown only when its rule applies. */
  private stepsHtml(model: LogicModel): string {
    if (model.steps.length === 0) {
      return "";
    }
    return `<div class="flow card" aria-label="${esc(this.text("logic.steps.aria"))}">
        <p class="flow-title">${esc(this.text("logic.steps.title"))} <span class="muted">· ${esc(this.text("logic.steps.hint"))}</span></p>
        <ol class="flow-steps">${model.steps
          .map(
            (step, index) =>
              `<li class="flow-step${step.conditional ? " flow-step--conditional" : ""}"><span class="flow-index" aria-hidden="true">${index + 1}</span><span>${esc(step.label)}${
                step.ruleCount > 0 ? ` <span class="muted">· ${esc(this.plural(step.ruleCount))}</span>` : ""
              }${step.conditional ? `<span class="sr-only"> (${esc(this.text("logic.steps.conditional"))})</span>` : ""}</span></li>`
          )
          .join("")}</ol>
      </div>`;
  }

  private diagnosticsHtml(model: LogicModel): string {
    if (model.diagnostics.length === 0) {
      return "";
    }
    return model.diagnostics
      .map(
        (diagnostic, index) =>
          `<div class="note diagnostic" data-tone="${diagnostic.severity === "error" ? "error" : "warning"}" role="status" data-logic-diagnostic="${esc(diagnostic.code)}"><span class="diag-mark" aria-hidden="true">!</span><p>${esc(diagnostic.message)}</p><button type="button" class="btn small" data-logic-spotlight="${index}">${esc(this.text("logic.diag.showThem"))}</button></div>`
      )
      .join("");
  }

  private listHtml(model: LogicModel): string {
    const shown = this.spotlight
      ? model.rules.filter((rule) => this.spotlight!.has(rule.id))
      : rulesForFilter(model, this.filter);
    if (model.rules.length === 0) {
      return `<div class="empty-state card"><h3>${esc(this.text("logic.empty.title"))}</h3><p>${esc(this.text("logic.empty.hint"))}</p><button type="button" class="btn primary" data-logic-new-kind="show">${esc(this.text("logic.empty.add"))}</button></div>`;
    }
    const spot = this.spotlight
      ? `<p class="spot-note">${esc(this.text("logic.spot.note"))} <button type="button" class="link-btn" data-logic-filter="all">${esc(this.text("logic.spot.all"))}</button></p>`
      : "";
    if (shown.length === 0) {
      return `${spot}<p class="empty">${esc(this.text("logic.empty.filter"))}</p>`;
    }
    const groups = model.groups.filter((group) => shown.some((rule) => rule.group.id === group.id));
    return `${spot}${groups
      .map(
        (group) => `<section class="rule-group" aria-labelledby="group-${esc(group.id)}">
          <h3 id="group-${esc(group.id)}">${esc(group.label)}</h3>
          <ul class="rules">${shown
            .filter((rule) => rule.group.id === group.id)
            .map((rule) => this.ruleCardHtml(rule))
            .join("")}</ul>
        </section>`
      )
      .join("")}`;
  }

  private ruleCardHtml(rule: LogicRule): string {
    const selected = this.working?.ruleId === rule.id;
    const chips: string[] = [];
    const hiddenSent = rule.hiddenValueBehavior ?? (rule.source.mode === "form" ? this.hiddenDefaultOf(rule.target.id) : DEFAULT_HIDDEN_VALUE_BEHAVIOR);
    if ((rule.kind === "show" || rule.kind === "hide") && hiddenSent !== "exclude-from-submission") {
      chips.push(`<span class="chip">${esc(this.text(hiddenSent === "clear" ? "logic.hidden.chip.clear" : "logic.hidden.chip.retain"))}</span>`);
    }
    if (rule.run === "server") {
      chips.push(`<span class="chip chip--run" data-logic-run-chip="server">${esc(this.text("chip.serverOnly"))}</span>`);
    } else if (rule.run === "server-secret") {
      chips.push(`<span class="chip chip--secret" data-logic-run-chip="server-secret">${LOCK_SVG}${esc(this.text("chip.secret"))}</span>`);
    }
    // A Go to rule the Journeys mode writes opens in this editor, so it has no button to the designer.
    const open =
      rule.source.mode === "form" || rule.editable || !this.canOpen(rule.source.mode)
        ? ""
        : `<button type="button" class="btn small" data-logic-open-doc="${rule.source.mode}" data-doc-id="${esc(rule.source.mode === "pdf" ? rule.source.layoutId : rule.source.journeyId)}">${esc(this.text(rule.source.mode === "pdf" ? "logic.open.layout" : "logic.open.journey"))}</button>`;
    // The button's name is its own visible sentence (WCAG 2.5.3, Label in Name): no aria-label
    // paraphrasing it. The pieces are spaced in the markup (the card is a flex row, so the gap
    // comes from CSS and the spaces cost nothing) so the text reads as words, and the read-only
    // note is visually hidden text inside the button, after the sentence.
    const readonlyNote = rule.editable ? "" : `<span class="sr-only"> (${esc(this.text("logic.readonly.aria"))})</span>`;
    return `<li class="rule-row">
        <button type="button" class="rule${selected ? " rule--selected" : ""}${rule.editable ? "" : " rule--readonly"}${rule.run === "server-secret" ? " rule--secret" : ""}" data-logic-rule="${esc(rule.id)}" aria-pressed="${selected}">${sentenceHtml(rule.sentence, " ")}${readonlyNote}</button>
        ${chips.join("")}${open}
      </li>`;
  }

  // --- the editor -----------------------------------------------------------------

  private editorHtml(model: LogicModel): string {
    const working = this.working;
    if (!working) {
      return "";
    }
    const rule = working.ruleId ? model.rules.find((entry) => entry.id === working.ruleId) : undefined;
    const fieldLabel = working.componentId ? this.labelOf(working.componentId) : "";
    const head = this.kindWords(working.kind, fieldLabel || undefined);
    const editable = rule ? rule.editable : true;
    if (!editable && rule) {
      return `<section class="logic-editor card-stack" aria-labelledby="editor-title" data-logic-editor>
          <header class="card editor-section editor-head"><h2 class="card-title" id="editor-title">${esc(head.label)}</h2><p class="card-lead">${esc(head.description)}</p>
            <p class="sentence">${sentenceHtml(rule.sentence)}</p>
            <p class="card-lead">${esc(this.text("logic.readonly.note"))}</p></header>
          ${this.pinsLineHtml(rule.id, rule.kind)}
          <div class="card editor-foot">
            <button type="button" class="btn" data-logic-close>${esc(this.text("logic.editor.close"))}</button>
            ${
              this.canOpen(rule.source.mode)
                ? `<button type="button" class="btn primary" data-logic-open-doc="${rule.source.mode}" data-doc-id="${esc(rule.source.mode === "pdf" ? (rule.source as { layoutId: string }).layoutId : (rule.source as { journeyId: string }).journeyId)}">${esc(this.text("logic.open.designer"))}</button>`
                : ""
            }
          </div>
        </section>`;
    }
    if (working.route) {
      return this.routeEditorHtml(model, working, working.route);
    }
    const targets = this.targetChoices(working.kind);
    const isValue = VALUE_KINDS.has(working.kind);
    const isStep = working.kind === "show-step" || working.kind === "hide-step";
    const dirty = this.dirty;
    const targetWord = this.text(isStep ? "logic.editor.step" : "logic.editor.field");
    const targetControl =
      working.ruleId === undefined
        ? `<select data-logic-target aria-label="${esc(targetWord)}"><option value="">${esc(this.text("logic.editor.choose"))}</option>${targets
            .map((entry) => `<option value="${esc(entry.id)}"${entry.id === working.componentId ? " selected" : ""}>${esc(entry.label)}</option>`)
            .join("")}</select>`
        : `<span class="ref-chip token--field field-pick">${esc(fieldLabel)}</span>`;
    const lead = head.lead;
    const runsControl = BROWSER_ONLY_KEYS.has(working.ruleKey)
      ? `<span class="chip chip--fixed" data-logic-run-fixed title="${esc(this.text("run.fixedBrowser.hint"))}">${esc(this.text("run.fixedBrowser"))}</span>`
      : `<div class="run-pick">
            <button type="button" class="btn run-btn" data-logic-run-btn aria-haspopup="menu" aria-expanded="${this.runMenuOpen}"><span>${esc(this.text(RUN_LABELS[working.run]))}</span>${CHEVRON_SVG}</button>
            <div class="menu run-menu" role="menu" data-logic-run-menu${this.runMenuOpen ? "" : " hidden"}>${RUN_CHOICES.map(
              (choice) =>
                `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${choice.value === working.run}" data-logic-run="${choice.value}"><strong>${esc(this.text(choice.label))}</strong><span>${esc(this.text(choice.hint))}</span></button>`
            ).join("")}</div>
          </div>`;
    const secretNote = working.run === "server-secret" ? `<p class="note" data-tone="warning" data-logic-secret-note>${esc(this.text("run.secret.note"))}</p>` : "";
    const paper =
      working.kind === "show" || working.kind === "hide" || isStep
        ? `<label class="choice paper-choice"><input type="checkbox" data-logic-paper${working.paper ? " checked" : ""}> ${esc(this.text("logic.editor.paper"))}</label>`
        : "";
    const hidden =
      working.kind === "show" || working.kind === "hide"
        ? `<fieldset class="field hidden-choice"><legend class="field-label">${esc(this.text("logic.editor.hiddenAnswer"))}</legend>${HIDDEN_CHOICES.map(
            (choice) =>
              `<label class="choice"><input type="radio" name="logic-hidden" data-logic-hidden value="${choice.value}"${working.hidden === choice.value ? " checked" : ""}> ${esc(this.text(choice.key))}</label>`
          ).join("")}</fieldset>`
        : "";
    // The behaviour boxes (a check's message, what a hidden answer sends, the paper rule) share one card; none, no card.
    const options = [this.messageRowHtml(working), hidden, paper].filter((part) => part !== "").join("");
    return `<section class="logic-editor card-stack" aria-labelledby="editor-title" data-logic-editor data-logic-kind="${working.kind}">
        <div class="card editor-section editor-head">
          <header><h2 class="card-title" id="editor-title">${esc(head.label)}</h2><p class="card-lead">${esc(head.description)}</p>${this.savedAsHtml(working.kind)}</header>
          <div class="head-row">
            <div class="field"><span class="field-label">${esc(targetWord)}</span>${targetControl}</div>
            <div class="field"><span class="field-label">${esc(this.text("logic.editor.runs"))}</span>${runsControl}</div>
          </div>
          ${secretNote}
        </div>
        <div class="card editor-section formula-row">
          <div class="formula-lead"><h3 class="card-heading" id="logic-formula-lead">${esc(lead)}</h3><span class="card-lead">${esc(this.text("logic.editor.asFormula"))}</span></div>
          <div class="formula-slot" data-logic-formula-slot></div>
          ${this.problemLineHtml()}
          <div data-logic-try-one-row>${this.tryOneHtml(working)}</div>
        </div>
        <div class="card editor-section reads-row">
          <h3 class="card-heading">${esc(this.text("editor.readsAs"))}</h3>
          <p class="reads" data-logic-reads>${this.readsHtml()}</p>
        </div>
        ${options === "" ? "" : `<div class="card editor-section">${options}</div>`}
        <div class="card editor-section try-host" data-logic-try>${isValue && !working.componentId ? "" : this.tryItHtml(working)}</div>
        ${working.ruleId !== undefined ? this.pinsLineHtml(working.ruleId, working.kind) : ""}
        <div class="card editor-foot">
          ${working.ruleId !== undefined ? `<button type="button" class="btn danger" data-logic-remove>${esc(this.text("logic.editor.remove"))}</button>` : ""}
          <span class="spacer"></span>
          <span class="dirty-flag" data-logic-dirty${dirty ? "" : " hidden"}>${esc(this.text("logic.editor.notApplied"))}</span>
          <button type="button" class="btn" data-logic-discard>${esc(this.discardWord(dirty))}</button>
          <button type="button" class="btn primary" data-logic-apply${dirty ? "" : " disabled"} aria-describedby="logic-problem">${esc(this.text("logic.editor.apply"))}</button>
        </div>
      </section>`;
  }

  // --- a Go to rule's editor ---------------------------------

  private journeyOf(model: LogicModel, route: WorkingRoute): LogicJourneySummary | undefined {
    return model.journeys.find((journey) => journey.id === route.journeyId);
  }

  /** The name of the step the rule leaves, with its journey's when the form holds several. */
  private routeFromLabel(model: LogicModel, route: WorkingRoute): string {
    const journey = this.journeyOf(model, route);
    const page = journey?.pages.find((candidate) => candidate.id === route.pageId);
    if (!journey || !page) {
      return route.pageId;
    }
    return model.journeys.length > 1 ? `${journey.label} · ${page.label}` : page.label;
  }

  /** Where the rule goes, as the sentences name it; "…" before one is chosen. */
  private routeToLabel(model: LogicModel, route: WorkingRoute): string | undefined {
    if (route.to === "") {
      return undefined;
    }
    if (route.to === JOURNEY_END) {
      return this.text("logic.route.end");
    }
    return this.journeyOf(model, route)?.pages.find((page) => page.id === route.to)?.label ?? route.to;
  }

  /**
   * What the rule may go to, as the path accepts it: the steps after the one it leaves (the
   * first written under each id, since a route finds the first), then the end. A target the rule
   * already holds that the path would ignore stays listed, so the box says what is stored.
   */
  private routeTargets(model: LogicModel, route: WorkingRoute): Array<{ value: string; label: string }> {
    const journey = this.journeyOf(model, route);
    const from = journey ? journey.pages.findIndex((page) => page.id === route.pageId) : -1;
    const choices: Array<{ value: string; label: string }> = [];
    if (journey && from >= 0) {
      for (const page of journey.pages.slice(from + 1)) {
        if (page.firstOfId) {
          choices.push({ value: page.id, label: page.exit ? this.text("logic.editor.exitStep", { step: page.label }) : page.label });
        }
      }
    }
    choices.push({ value: JOURNEY_END, label: this.text("logic.route.end") });
    if (route.to !== "" && !choices.some((choice) => choice.value === route.to)) {
      choices.unshift({ value: route.to, label: this.routeToLabel(model, route) ?? route.to });
    }
    return choices;
  }

  /** The steps a new Go to rule may leave: every journey's, a step that stops the path (an exit or a review step) excepted, the first written under each id. */
  private routeFromChoices(model: LogicModel): string {
    const several = model.journeys.length > 1;
    const options = (journey: LogicJourneySummary): string =>
      journey.pages
        .filter((page) => page.firstOfId && !page.stops)
        .map((page) => {
          const value = routeKey(journey.id, page.id);
          const picked = this.working?.route?.journeyId === journey.id && this.working.route.pageId === page.id;
          return `<option value="${esc(value)}"${picked ? " selected" : ""}>${esc(page.label)}</option>`;
        })
        .join("");
    return model.journeys
      .map((journey) => (several ? `<optgroup label="${esc(journey.label)}">${options(journey)}</optgroup>` : options(journey)))
      .join("");
  }

  /** "Tried 1st of 2 from this step", with Move up and Move down: the order the step's rules are tried in (a saved rule's). */
  private routeOrderHtml(model: LogicModel, working: Working, route: WorkingRoute): string {
    const journey = this.journeyOf(model, route);
    const page = journey?.pages.find((candidate) => candidate.id === route.pageId);
    if (working.ruleId === undefined || route.routeIndex === undefined || !page || page.routes < 2) {
      return "";
    }
    const position = route.routeIndex + 1;
    const ordinal = this.ordinal(position);
    // A rule with no condition always applies, so the rules after it are never tried.
    const shadows = working.text.trim() === "" && route.routeIndex < page.routes - 1;
    // A rule after one with no condition is never tried, whatever its own condition says.
    const shadowed = page.unconditional.some((at) => at < (route.routeIndex as number));
    return `<div class="order-row" data-logic-order>
          <span class="order-text" id="logic-order-text">${esc(this.text("logic.editor.order", { position: ordinal, total: page.routes }))}</span>
          <button type="button" class="btn small" data-logic-move="-1"${route.routeIndex === 0 ? " disabled" : ""} aria-describedby="logic-order-text">${esc(this.text("logic.editor.order.up"))}</button>
          <button type="button" class="btn small" data-logic-move="1"${route.routeIndex >= page.routes - 1 ? " disabled" : ""} aria-describedby="logic-order-text">${esc(this.text("logic.editor.order.down"))}</button>
          ${shadows ? `<p class="muted small order-note">${esc(this.text("logic.editor.order.always"))}</p>` : ""}
          ${shadowed ? `<p class="muted small order-note" data-logic-shadowed>${esc(this.text("logic.editor.order.shadowed"))}</p>` : ""}
        </div>`;
  }

  /** 1 as "1st", 2 as "2nd", by the surface's own plural rules for ordinals; a language the catalog has no ordinals for reads the number alone. */
  private ordinal(n: number): string {
    let category = "other";
    try {
      category = new Intl.PluralRules(this.localeValue ?? "en", { type: "ordinal" }).select(n);
    } catch {
      category = "other";
    }
    const key = `logic.order.ordinal.${category}`;
    return this.text((Object.prototype.hasOwnProperty.call(LOGIC_EN, key) ? key : "logic.order.ordinal.other") as BuilderTextKey, { n });
  }

  private routeEditorHtml(model: LogicModel, working: Working, route: WorkingRoute): string {
    const head = this.kindWords("route", this.routeToLabel(model, route));
    const dirty = this.dirty;
    const fromWord = this.text("logic.editor.from");
    const toWord = this.text("logic.editor.goTo");
    const saved = working.ruleId !== undefined;
    const fromControl = saved
      ? `<span class="ref-chip token--field field-pick" data-logic-from-fixed>${esc(this.routeFromLabel(model, route))}</span>`
      : `<select data-logic-from aria-label="${esc(fromWord)}"><option value="">${esc(this.text("logic.editor.choose"))}</option>${this.routeFromChoices(model)}</select>`;
    const targets = route.pageId === "" ? [] : this.routeTargets(model, route);
    const toControl = `<select data-logic-to aria-label="${esc(toWord)}"${route.pageId === "" ? " disabled" : ""}><option value="">${esc(this.text("logic.editor.choose"))}</option>${targets
      .map((entry) => `<option value="${esc(entry.value)}"${entry.value === route.to ? " selected" : ""}>${esc(entry.label)}</option>`)
      .join("")}</select>`;
    return `<section class="logic-editor card-stack" aria-labelledby="editor-title" data-logic-editor data-logic-kind="route">
        <div class="card editor-section editor-head">
          <header><h2 class="card-title" id="editor-title">${esc(head.label)}</h2><p class="card-lead">${esc(head.description)}</p></header>
          <div class="head-row">
            <div class="field"><span class="field-label">${esc(fromWord)}</span>${fromControl}</div>
            <div class="field"><span class="field-label">${esc(toWord)}</span>${toControl}</div>
          </div>
          ${this.routeOrderHtml(model, working, route)}
        </div>
        <div class="card editor-section formula-row">
          <div class="formula-lead"><h3 class="card-heading" id="logic-formula-lead">${esc(head.lead)}</h3><span class="card-lead">${esc(this.text("logic.editor.asFormula"))}</span></div>
          <div class="formula-slot" data-logic-formula-slot></div>
          ${this.problemLineHtml()}
          <div data-logic-try-one-row>${this.tryOneHtml(working)}</div>
        </div>
        <div class="card editor-section reads-row">
          <h3 class="card-heading">${esc(this.text("editor.readsAs"))}</h3>
          <p class="reads" data-logic-reads>${this.readsHtml()}</p>
        </div>
        <div class="card editor-section try-host" data-logic-try>${this.tryItHtml(working)}</div>
        ${saved ? this.pinsLineHtml(working.ruleId!, "route") : ""}
        <div class="card editor-foot">
          ${saved ? `<button type="button" class="btn danger" data-logic-remove>${esc(this.text("logic.editor.remove"))}</button>` : ""}
          <span class="spacer"></span>
          <span class="dirty-flag" data-logic-dirty${dirty ? "" : " hidden"}>${esc(this.text("logic.editor.notApplied"))}</span>
          <button type="button" class="btn" data-logic-discard>${esc(this.discardWord(dirty))}</button>
          <button type="button" class="btn primary" data-logic-apply${dirty ? "" : " disabled"} aria-describedby="logic-problem">${esc(this.text("logic.editor.apply"))}</button>
        </div>
      </section>`;
  }

  /**
   * The editor's "Pinned by" line: the tests that read a saved rule, each
   * a button that opens it in the Tests panel, or "No test pins this rule." with Write a test.
   * Drawn only for a saved rule (a new one has nothing to pin yet), of a kind a test can name,
   * and only once the shell has fed {@link testsPins} and the Tests chunk has answered for it.
   */
  private pinsLineHtml(ruleId: string, kind: LogicRuleKind): string {
    const pins = UNPINNABLE_KINDS.has(kind) ? undefined : this.pinsSource?.(ruleId);
    if (pins === undefined) {
      return "";
    }
    if (pins.length === 0) {
      return `<p class="card pins-line" data-logic-pins>
          <span class="muted">${esc(this.text("logic.pins.none"))}</span>
          <button type="button" class="btn small" data-logic-write-test="${esc(ruleId)}" title="${esc(this.text("logic.pins.write.hint"))}">${esc(this.text("logic.pins.write"))}</button>
        </p>`;
    }
    return `<p class="card pins-line" data-logic-pins>
        <span class="row-label">${esc(this.text("logic.pins.label"))}</span>
        ${pins
          .map((pin) => `<button type="button" class="chip chip--pin" data-logic-open-test="${esc(pin.id)}" title="${esc(this.text("logic.pins.open", { name: pin.name }))}">${esc(pin.name)}</button>`)
          .join("")}
      </p>`;
  }

  /**
   * A validate rule's Message: the source text of the field's `messages.rule`, typed
   * without a repaint (`onEdit`), with the engine's wording named as what an empty box leaves.
   */
  private messageRowHtml(working: Working): string {
    if (working.kind !== "validate") {
      return "";
    }
    const fallback = defaultValidationMessage("rule", this.ctrl?.currentLocale() ?? "en", { translations: this.ctrl?.translations() }) ?? "";
    return `<div class="field message-row">
          <label for="logic-message">${esc(this.text("logic.editor.message"))}</label>
          <input type="text" id="logic-message" data-logic-message value="${esc(working.message)}" aria-describedby="logic-message-hint">
          <p class="muted small" id="logic-message-hint">${esc(this.text("logic.editor.message.hint", { fallback }))}</p>
        </div>`;
  }

  /**
   * Show over `not(…)` and Hide over a bare condition store the same JSON, so the editor says
   * which kind Apply will save; the other kinds are what their heading says.
   */
  private savedAsHtml(kind: LogicRuleKind): string {
    if (kind !== "show" && kind !== "hide" && kind !== "show-step" && kind !== "hide-step") {
      return "";
    }
    const key = kind === "show" || kind === "show-step" ? "logic.editor.savedAs.show" : "logic.editor.savedAs.hide";
    return `<p class="card-lead" data-logic-saved-as>${esc(this.text(key))}</p>`;
  }

  /**
   * The problem under the box: what holds Apply, else that Apply replaces the rule a new rule's
   * field already has, else the first unknown field, named with its span's words. This line is the one message: Apply describes itself by it
   * and it is the one announced.
   */
  private problemLineHtml(): string {
    const line = this.summaryLine();
    return `<p class="problem-line" data-logic-problem id="logic-problem"${line ? "" : " hidden"}${line?.severity === "error" ? ' role="alert"' : ""} data-severity="${line?.severity ?? ""}">${PROBLEM_SVG}<span data-logic-problem-text>${esc(line?.text ?? "")}</span></p>`;
  }

  /** The "Try one:" chips of an empty box: three formulas built from the form's own fields. */
  private tryOneHtml(working: Working): string {
    if (working.text.trim() !== "") {
      return "";
    }
    const fields = this.formulaFields().filter((field) => field.componentId !== working.componentId);
    const examples: string[] = [];
    // A Calculate or Start-at rule makes a value, not a yes/no: its chips are values.
    if (VALUE_KINDS.has(working.kind)) {
      const numeric = fields.find((field) => field.kind === "number");
      if (numeric) {
        examples.push(`${feelName(numeric.path)} * 2`);
      }
      const flag = fields.find((field) => field.kind === "boolean");
      if (flag) {
        examples.push(`if ${feelName(flag.path)} then "yes" else "no"`);
      }
      const text = fields.find((field) => field.kind === "text" || field.kind === "choice" || field.kind === "date");
      if (text) {
        examples.push(feelName(text.path));
      }
      return examples.length === 0 ? "" : this.tryOneRowHtml(examples);
    }
    const choice = fields.find((field) => (field.kind === "choice" || field.kind === "flags" || field.kind === "list") && field.options.length > 0);
    if (choice) {
      examples.push(`${feelName(choice.path)} = ${JSON.stringify(choice.options[0]!.value)}`);
    }
    const answered = fields.find((field) => field.kind === "text" || field.kind === "date" || field.kind === "other");
    if (answered) {
      examples.push(`not(empty(${feelName(answered.path)}))`);
    }
    const number = fields.find((field) => field.kind === "number");
    if (number) {
      examples.push(`${feelName(number.path)} > 10`);
    }
    const boolean = fields.find((field) => field.kind === "boolean");
    if (boolean && examples.length < 3) {
      examples.push(feelName(boolean.path));
    }
    return examples.length === 0 ? "" : this.tryOneRowHtml(examples);
  }

  private tryOneRowHtml(examples: string[]): string {
    return `<div class="try-one"><span class="muted small">${esc(this.text("editor.tryOne"))}</span>${examples
      .map((formula) => `<button type="button" class="try-chip" data-logic-try-one="${esc(formula)}">${esc(formula)}</button>`)
      .join("")}</div>`;
  }

  /** The "Reads as" line: the rule-list sentence the copy would have. */
  private readsHtml(): string {
    const working = this.working;
    const words = this.words;
    if (!working || !words) {
      return "";
    }
    const expression = this.workingExpression();
    if (working.route) {
      const destination = this.model ? this.routeToLabel(this.model, working.route) : undefined;
      return sentenceHtml(words.routeSentence(destination, expression.ok ? expression.expression : undefined, working.text));
    }
    const tokens = words.ruleSentence({
      componentId: working.componentId,
      ruleKey: working.ruleKey,
      expression: expression.ok ? expression.expression : undefined,
      text: this.storedText(working),
      run: working.run,
      kind: working.kind
    });
    return sentenceHtml(tokens);
  }

  /**
   * Try it, beside the rule: a box for each answer the formula
   * reads, the day its clock reads when it reads one, and what the rule makes of them, worked
   * out by the preview runtime (the same fold the form runs, never the evaluator on its own).
   */
  private trySignatureOf(working: Working): { signature: string; read: FormulaField[]; clock: boolean } | undefined {
    const expression = this.workingExpression();
    // A Go to rule reads the form's answers but is about no field of its own.
    if (!expression.ok || !expression.expression || (!working.componentId && !working.route)) {
      return undefined;
    }
    if (working.kind === "filter" || working.kind === "gate") {
      return undefined;
    }
    const read = this.tryFields(expression.expression);
    // A check is about its field's own answer, which `component` reads without naming it: its box comes first.
    if (working.kind === "validate") {
      const own = this.formulaFields().find((field) => field.componentId === working.componentId);
      if (own && !read.includes(own)) {
        read.unshift(own);
      }
    }
    const clock = kernelExprReadsClock(expression.expression);
    return { signature: `${read.map((field) => field.path).join("|")}|${clock}`, read, clock };
  }

  private tryItHtml(working: Working, known?: { signature: string; read: FormulaField[]; clock: boolean } | undefined): string {
    const computed = known ?? this.trySignatureOf(working);
    if (!computed) {
      this.trySignature = "";
      return "";
    }
    const { read, clock } = computed;
    this.trySignature = computed.signature;
    if (read.length === 0 && !clock) {
      return "";
    }
    const boxes = read
      .map((field) => {
        const id = field.componentId ?? field.path;
        const value = this.tryValues.get(id);
        if (field.kind === "boolean") {
          return `<label class="choice"><input type="checkbox" data-logic-try="${esc(id)}"${value === true ? " checked" : ""}> ${esc(field.label)}</label>`;
        }
        if (field.kind === "flags" && field.options.length > 0) {
          const flags = (value as Record<string, boolean> | undefined) ?? {};
          return `<fieldset class="field try-flags"><legend class="field-label">${esc(field.label)}</legend>${field.options
            .map(
              (option) =>
                `<label class="choice"><input type="checkbox" data-logic-try-flag="${esc(id)}" value="${esc(option.value)}"${flags[option.value] === true ? " checked" : ""}> ${esc(option.label)}</label>`
            )
            .join("")}</fieldset>`;
        }
        if (field.options.length > 0) {
          return `<label class="field"><span class="field-label">${esc(field.label)}</span><select data-logic-try="${esc(id)}"><option value=""></option>${field.options
            .map((option) => `<option value="${esc(option.value)}"${value === option.value ? " selected" : ""}>${esc(option.label)}</option>`)
            .join("")}</select></label>`;
        }
        const type = field.kind === "date" ? "date" : "text";
        return `<label class="field"><span class="field-label">${esc(field.label)}</span><input type="${type}" data-logic-try="${esc(id)}" value="${esc(value === undefined ? "" : String(value))}"></label>`;
      })
      .join("");
    const today = clock
      ? `<label class="field"><span class="field-label">${esc(this.text("try.today"))}</span><input type="date" data-logic-try-today value="${esc(this.tryToday)}"></label>`
      : "";
    // The label is a row label above the box (the "Try it" heading), never a legend
    // over the box's border, so it cannot straddle the edge of the sunken panel.
    return `<div class="try-row"><h3 class="card-heading" id="logic-try-title">${esc(this.text("try.title"))}</h3><div class="try card-inset" role="group" aria-labelledby="logic-try-title"><div class="try-boxes">${boxes}${today}</div><p class="try-result" role="status" data-logic-try-result>${this.tryResultHtml()}</p></div></div>`;
  }

  /**
   * A Try it answer as the form stores it: digits typed for a number field as a number; a
   * choice's value and a text field's digits (a postal code, an id) stay text, as the form keeps them.
   * A plugin's or a binding's type (`gcds-number`) is read as the base the form's `kinds` map gives it.
   */
  private tryAnswerOf(id: string, value: unknown): unknown {
    if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) {
      return value;
    }
    const field = this.formulaFields().find((entry) => (entry.componentId ?? entry.path) === id);
    let kind = field?.kind;
    const controller = this.ctrl;
    if (kind === "other" && field?.componentId !== undefined && controller) {
      const type = findNode(controller.snapshot(), field.componentId)?.type;
      if (type !== undefined) {
        kind = formulaFieldKind(baseTypeOf(type, controller.definitionKinds(controller.openedKinds?.())));
      }
    }
    return kind === "number" ? Number(value) : value;
  }

  /** The fields a formula reads, in reading order, each once; a path into a field's value names the field. */
  private tryFields(expression: Expression): FormulaField[] {
    const fields = this.formulaFields();
    const out: FormulaField[] = [];
    for (const path of expressionReads(expression)) {
      const field = fields.find(
        (entry) => entry.path === path || entry.componentId === path || path.startsWith(entry.path + ".") || (entry.componentId !== undefined && path.startsWith(entry.componentId + "."))
      );
      if (field && !out.includes(field)) {
        out.push(field);
      }
    }
    return out;
  }

  /** What the working rule makes of the Try it answers, in words, with the side it runs on. */
  private tryResultHtml(): string {
    const working = this.working;
    const controller = this.ctrl;
    const expression = this.workingExpression();
    if (working?.route && controller && expression.ok && expression.expression) {
      return this.tryRouteResultHtml(working.route, controller, expression.expression);
    }
    if (!working?.componentId || !controller || !expression.ok || !expression.expression) {
      return "";
    }
    const spine = withNodeCopy(controller.snapshot(), working.componentId);
    if (!spine) {
      return "";
    }
    const root = spine.root;
    const node = spine.node;
    // The tree itself, whatever its run scope: Try it shows the rule's result, which for a
    // server-only rule is the server's (the browser side would skip it). A default is tried as
    // a calculation: it seeds an empty answer once, so only the value it works out is of interest.
    const rules = { ...((node.rules as Record<string, unknown> | undefined) ?? {}) };
    if (working.kind === "default") {
      delete rules.defaultValue;
      rules.value = expression.expression;
    } else {
      rules[working.ruleKey] = expression.expression;
    }
    node.rules = rules as NonNullable<ComponentNode["rules"]>;
    const functions = this.pluginFunctions();
    const options: BuilderPreviewRuntimeOptions = {
      locale: controller.currentLocale(),
      ...(controller.translations() !== undefined ? { translations: controller.translations() } : {}),
      ...(controller.translationCatalog() !== undefined ? { translationCatalog: controller.translationCatalog() } : {}),
      today: this.tryToday,
      signatures: this.signatures(),
      ...(functions !== undefined ? { functions } : {})
    };
    let runtime: BuilderPreviewRuntime;
    try {
      runtime = new BuilderPreviewRuntime(root, options);
    } catch {
      return "";
    }
    for (const [id, value] of this.tryValues) {
      runtime.setValue(id, this.tryAnswerOf(id, value));
    }
    const label = this.labelOf(working.componentId);
    const state = runtime.effectiveStatesMap().get(working.componentId);
    let outcome: string;
    switch (working.kind) {
      case "show":
      case "hide":
      case "show-step":
      case "hide-step":
        outcome = this.text(state?.visible === false ? "try.hidden" : "try.shown", { field: label });
        break;
      case "require":
        outcome = this.text(runtime.requiredMap().get(working.componentId) ? "try.required" : "try.notRequired", { field: label });
        break;
      case "validate": {
        // As the form judges it: an empty answer is never checked; otherwise the fold's verdict.
        const value = ownValue(runtime.state().values, working.componentId);
        // The stage's own test, so a checkbox answered false is empty here as it is to the form.
        const empty = isEmptyValue(value, findNode(controller.snapshot(), working.componentId)?.type ?? "");
        if (empty) {
          outcome = this.text("try.unchecked", { field: label });
        } else if (runtime.invalidMap()[working.componentId] === true) {
          const message = working.message.trim() || defaultValidationMessage("rule", controller.currentLocale(), { translations: controller.translations() }) || "";
          outcome = this.text("try.refused", { field: label, message });
        } else {
          outcome = this.text("try.accepted", { field: label });
        }
        break;
      }
      case "enable":
        outcome = this.text(state?.disabled ? "try.disabled" : "try.enabled", { field: label });
        break;
      case "readonly":
        outcome = this.text(state?.readonly ? "try.readonly" : "try.editable", { field: label });
        break;
      case "calculate":
      case "default": {
        const value = ownValue(runtime.state().values, working.componentId);
        outcome =
          value === undefined || value === null || value === ""
            ? this.text("try.empty", { field: label })
            : this.text("try.value", { field: label, value: tryValueText(value, this.text("tryValue.sep")) });
        break;
      }
      default:
        return "";
    }
    const side =
      working.run === "server" || working.run === "server-secret"
        ? this.text("try.serverOnly")
        : working.run === "browser"
          ? this.text("try.browserOnly")
          : this.text("try.bothSides");
    return `${TICK_SVG}<span>${esc(outcome)}</span><span class="word side">${esc(side)}</span>`;
  }

  /**
   * What the condition of a Go to rule makes of the Try it answers: taken or not. Worked out by
   * the same fold the form runs, through a probe the preview runtime holds for the occasion (a
   * component whose visibility is the condition), so a clock and the plugin functions behave as
   * they do everywhere else. The probe is never in the form.
   */
  private tryRouteResultHtml(route: WorkingRoute, controller: BuilderController, expression: Expression): string {
    const root = withNodeCopy(controller.snapshot(), controller.rootId())?.root;
    if (!root) {
      return "";
    }
    const slot = Object.keys(root.children ?? {})[0] ?? "content";
    const probe: ComponentNode = { id: ROUTE_PROBE_ID, type: "text", rules: { visibleWhen: expression } } as unknown as ComponentNode;
    root.children = { ...(root.children ?? {}), [slot]: [...(root.children?.[slot] ?? []), probe] };
    const functions = this.pluginFunctions();
    let runtime: BuilderPreviewRuntime;
    try {
      runtime = new BuilderPreviewRuntime(root, {
        locale: controller.currentLocale(),
        ...(controller.translations() !== undefined ? { translations: controller.translations() } : {}),
        ...(controller.translationCatalog() !== undefined ? { translationCatalog: controller.translationCatalog() } : {}),
        today: this.tryToday,
        signatures: this.signatures(),
        ...(functions !== undefined ? { functions } : {})
      });
    } catch {
      return "";
    }
    // The path tries a step's rules over the answers of the steps it has reached, this one's among them: an
    // answer asked on a later step is not there yet, so Try it leaves it out as the path does.
    const asked = this.journeyHost()?.askedThrough(route.journeyId, route.pageId);
    const reads = (id: string): boolean => asked === undefined || asked.includes(id);
    for (const [id, value] of this.tryValues) {
      if (reads(id)) {
        runtime.setValue(id, this.tryAnswerOf(id, value));
      }
    }
    // Taken only when the condition holds: a probe the runtime gives no state is not a yes.
    const taken = runtime.effectiveStatesMap().get(ROUTE_PROBE_ID)?.visible === true;
    const target = (this.model ? this.routeToLabel(this.model, route) : undefined) ?? "…";
    const later = this.tryFields(expression).filter((field) => !reads(field.componentId ?? field.path));
    const note = later.length > 0 ? `<span class="muted small" data-logic-try-later>${esc(this.text("try.route.later", { fields: later.map((field) => field.label).join(", ") }))}</span>` : "";
    return `${TICK_SVG}<span>${esc(this.text(taken ? "try.route.taken" : "try.route.notTaken", { target }))}</span><span class="word side">${esc(this.text("try.bothSides"))}</span>${note}`;
  }

  private promptHtml(controller: BuilderController): string {
    const held = controller.unsavedChangesPrompt();
    if (held?.external?.id === GUARD_ID) {
      return unsavedChangesPromptHtml({
        componentId: held.external.id,
        label: held.external.label,
        action: held.action,
        blocked: held.external.blocked,
        ...(this.workingProblem() ? { problems: [this.workingProblem()!] } : {})
      }, this.textOptions());
    }
    if (this.heldSwitch) {
      return unsavedChangesPromptHtml({
        componentId: this.working?.componentId ?? GUARD_ID,
        label: this.workingLabel(),
        action: "select",
        blocked: this.workingProblem() !== undefined,
        ...(this.workingProblem() ? { problems: [this.workingProblem()!] } : {})
      }, this.textOptions());
    }
    return "";
  }

  // --- the formula box --------------------------------------------------------------

  /** The fields a formula may read: every component holding an answer, by id, with the labels the tree shows. */
  private formulaFields(): FormulaField[] {
    const controller = this.ctrl;
    if (!controller) {
      return [];
    }
    const locale = controller.currentLocale();
    const memo = this.fieldsMemo;
    if (memo !== undefined && memo.stamp === this.changeStamp && memo.ctrl === controller && memo.locale === locale) {
      return memo.fields;
    }
    const labels = this.treeLabels();
    const fields = formulaFieldsOf(controller.snapshot(), { labelOf: (id) => labels.get(id), locale, translations: controller.translations(), translationCatalog: controller.translationCatalog() });
    this.fieldsMemo = { stamp: this.changeStamp, ctrl: controller, locale, fields };
    return fields;
  }

  private functionRows(): FormulaFunctionRow[] {
    return formulaFunctionRows(this.functionSource);
  }

  /**
   * The plugin functions' evaluators, when the source is a registry (its `functions()`): what
   * Try it evaluates a call to a plugin function with. A table of rows alone lists and parses
   * the names, and Try it then reads a call to one as empty.
   */
  private pluginFunctions(): Record<string, (args: unknown[]) => unknown> | undefined {
    const source = this.functionSource;
    if (source === undefined || Array.isArray(source)) {
      return undefined;
    }
    const registry = source as { functions?: () => Record<string, (args: unknown[]) => unknown> };
    return typeof registry.functions === "function" ? registry.functions() : undefined;
  }

  private signatures(): FormulaFunctionSignature[] {
    const source = this.functionSource;
    return formulaSignatures(source !== undefined && !Array.isArray(source) && "signatures" in source ? (source as { signatures(): FormulaFunctionSignature[] }) : undefined);
  }

  private snippets(): FormulaSnippet[] {
    return [...FORMULA_SNIPPETS, ...pluginSnippets(this.functionRows())];
  }

  private editorOptions(working: Working): FormulaEditorOptions {
    const options: FormulaEditorOptions = {
      text: working.text,
      label: this.text("logic.editor.formula"),
      fields: this.formulaFields(),
      functions: this.functionRows(),
      signatures: this.signatures(),
      multiline: VALUE_KINDS.has(working.kind),
      snippets: this.snippets(),
      onChange: (text, state) => this.onFormulaEdit(text, state),
      onCommit: (text, state) => this.onFormulaEdit(text, state)
    };
    if (this.localeValue) {
      options.locale = this.localeValue;
    }
    if (this.catalogValue) {
      options.catalog = this.catalogValue;
    }
    return options;
  }

  /** The box's state for the text it holds, computed when the box has not reported yet. */
  private currentState(): FormulaEditorState | undefined {
    const working = this.working;
    if (!working) {
      return undefined;
    }
    if (this.editorState !== undefined) {
      return this.editorState;
    }
    this.editorState = formulaEditorState(working.text, {
      fields: this.formulaFields(),
      signatures: this.signatures(),
      ...(this.localeValue ? { locale: this.localeValue } : {}),
      ...(this.catalogValue ? { catalog: this.catalogValue } : {})
    });
    return this.editorState;
  }

  /** A keystroke in the box: the copy and the live parts follow; no repaint (the box keeps its caret). */
  private onFormulaEdit(text: string, state: FormulaEditorState): void {
    const working = this.working;
    if (!working) {
      return;
    }
    working.text = text;
    this.editorState = state;
    this.refreshLive();
  }

  /**
   * Puts the formula box into the slot the paint drew: the box kept from before, moved, or a
   * new one, the textarea first and the CodeMirror editor once its chunk lands.
   */
  private mountEditor(): void {
    const slot = this.root.querySelector<HTMLElement>("[data-logic-formula-slot]");
    const working = this.working;
    if (!slot || !working) {
      this.dropEditor();
      return;
    }
    if (this.editor) {
      slot.replaceChildren(this.editor.dom);
      this.editor.setFields(this.formulaFields());
      this.drawEditorFailed(slot);
      return;
    }
    const textarea = mountFormulaTextarea(slot, this.editorOptions(working));
    this.editor = textarea;
    this.editorFailed = false;
    this.loadEditor(textarea);
  }

  /** Swaps the CodeMirror editor in for `textarea` when its chunk lands, keeping text and focus; keeps the textarea on failure. */
  private loadEditor(textarea: FormulaEditor): void {
    this.formulaEditorLoader().then(
      (module) => {
        const working = this.working;
        const parent = textarea.dom.parentElement;
        if (this.editor !== textarea || !working || !parent || !textarea.dom.isConnected) {
          return;
        }
        const box = textarea.contentDom as HTMLTextAreaElement;
        const focused = textarea.hasFocus;
        const caret = box.selectionStart;
        const options = { ...this.editorOptions(working), text: textarea.getText(), condition: !VALUE_KINDS.has(working.kind) };
        if (this.referenceHrefValue !== undefined) {
          (options as { referenceHref?: string }).referenceHref = this.referenceHrefValue;
        }
        const editor = module.mountFormulaEditor(parent, options);
        textarea.destroy();
        this.editor = editor;
        if (focused) {
          editor.focus(caret);
        }
      },
      () => {
        if (this.editor !== textarea) {
          return;
        }
        this.editorFailed = true;
        const parent = textarea.dom.parentElement;
        if (parent) {
          this.drawEditorFailed(parent);
        }
      }
    );
  }

  /** The note under the textarea when the editor's chunk failed: the plain box still works, with Retry. */
  private drawEditorFailed(slot: HTMLElement): void {
    slot.querySelector("[data-logic-editor-failed]")?.remove();
    if (!this.editorFailed) {
      return;
    }
    const note = document.createElement("p");
    note.className = "note editor-failed";
    note.dataset.tone = "warning";
    note.dataset.logicEditorFailed = "";
    note.innerHTML = `${esc(this.text("editor.failed"))} <button type="button" class="link-btn" data-logic-editor-retry>${esc(this.text("editor.retry"))}</button>`;
    slot.append(note);
  }

  private dropEditor(): void {
    this.editor?.destroy();
    this.editor = undefined;
    this.editorState = undefined;
    this.editorFailed = false;
  }

  // --- the working copy -------------------------------------------------------------

  private open(rule: LogicRule): void {
    const target = rule.source.mode === "form" ? rule.target.id : undefined;
    // A Go to rule the Journeys mode writes: its own parts, and no field of the form.
    const route: WorkingRoute | undefined =
      rule.kind === "route" && rule.editable && rule.source.mode === "journeys"
        ? { journeyId: rule.source.journeyId, pageId: rule.source.pageId, to: rule.target.id, openedTo: rule.target.id, routeIndex: rule.source.routeIndex }
        : undefined;
    const working: Working = {
      ruleId: rule.id,
      kind: rule.kind,
      componentId: target,
      ruleKey: rule.ruleKey,
      text: openedTextOf(rule),
      run: rule.run,
      openedText: openedTextOf(rule),
      openedRun: rule.run,
      hidden: rule.hiddenValueBehavior ?? this.hiddenDefaultOf(target),
      paper: target !== undefined && this.printShowOf(target) === "always",
      message: typeof rule.message === "string" ? rule.message : "",
      openedMessage: typeof rule.message === "string" ? rule.message : "",
      baseline: "",
      ...(route ? { route } : {})
    };
    working.baseline = this.serialize(working);
    this.working = working;
    this.dropEditor();
    this.runMenuOpen = false;
    this.tryValues.clear();
    this.tryToday = calendarDate(new Date());
    // The selection follows the rule: Form opens on the same field; a Go to rule
    // selects its route on the journey, so the map marks the rule being edited.
    if (route && route.routeIndex !== undefined) {
      this.journeyHost()?.select({ journeyId: route.journeyId, pageId: route.pageId, routeIndex: route.routeIndex });
    } else if (target !== undefined && this.ctrl?.selectedComponentId() !== target) {
      this.ctrl?.select(target);
    }
    this.paint();
  }

  /** A request from the map: a rule to edit, or a new one from a step to the next. */
  private openRequest(request: LogicOpenRequest): void {
    if (request.kind === "rule") {
      const id = routeRuleId(request.ref);
      const rule = this.model?.rules.find((entry) => entry.id === id);
      if (rule) {
        this.requestOpen(() => this.open(rule));
      }
      return;
    }
    this.requestOpen(() => this.openNew("route", { journeyId: request.journeyId, pageId: request.pageId, to: request.to }));
  }

  private openNew(kind: LogicRuleKind, preset?: { journeyId: string; pageId: string; to: string }): void {
    const ruleKey = kind === "route" ? "when" : (EDITABLE_KINDS[kind] ?? "visibleWhen");
    // A Go to rule starts from the step it leaves: the one the map names, else the form's only journey leaves it to choose.
    const only = this.model?.journeys.length === 1 ? this.model.journeys[0]!.id : "";
    const route: WorkingRoute | undefined =
      kind === "route"
        ? { journeyId: preset?.journeyId ?? only, pageId: preset?.pageId ?? "", to: preset?.to ?? "", openedTo: "", routeIndex: undefined }
        : undefined;
    const working: Working = {
      ruleId: undefined,
      kind,
      componentId: undefined,
      ruleKey,
      text: "",
      run: "both",
      openedText: "",
      openedRun: "both",
      hidden: DEFAULT_HIDDEN_VALUE_BEHAVIOR,
      paper: false,
      message: "",
      openedMessage: "",
      baseline: "",
      ...(route ? { route } : {})
    };
    // A new Go to rule from the map arrives with its step and target chosen: that is unsaved work, so the baseline is the blank rule.
    working.baseline = this.serialize({ ...working, kind, componentId: undefined, ...(route ? { route: { ...route, journeyId: only, pageId: "", to: "" } } : {}) });
    this.working = working;
    this.dropEditor();
    this.runMenuOpen = false;
    this.tryValues.clear();
    this.tryToday = calendarDate(new Date());
    this.newMenuOpen = false;
    this.paint();
    this.root.querySelector<HTMLElement>("[data-logic-target], [data-logic-from]")?.focus();
  }

  /** Runs `next` now, or after the surface's prompt while the copy is not applied. */
  private requestOpen(next: () => void): void {
    if (!this.dirty) {
      next();
      return;
    }
    this.heldSwitch = next;
    this.paint();
  }

  private serialize(working: Working): string {
    return JSON.stringify([
      working.kind,
      working.componentId ?? null,
      working.text.trim(),
      working.run,
      working.hidden,
      working.paper,
      working.message.trim(),
      working.route ? [working.route.journeyId, working.route.pageId, working.route.to] : null
    ]);
  }

  /** What the rule stores for the text in the box: the text, inside `not(…)` for a hide rule. */
  private storedText(working: Working): string {
    const text = working.text.trim();
    if (text === "") {
      return "";
    }
    return NEGATED_KINDS.has(working.kind) ? `not(${text})` : text;
  }

  /** The tree the box's text stands for (inside `not(…)` for a hide rule), or the parse problem. */
  private workingExpression(): { ok: true; expression: Expression | undefined } | { ok: false; error: string } {
    const working = this.working;
    const state = this.currentState();
    if (!working || !state) {
      return { ok: true, expression: undefined };
    }
    if (!state.parsed.ok) {
      return { ok: false, error: state.problems.find((problem) => problem.kind === "parse")?.message ?? state.parsed.message };
    }
    const expression = state.parsed.expression;
    if (expression !== undefined && NEGATED_KINDS.has(working.kind)) {
      return { ok: true, expression: { kind: "unary", operator: "not", operand: expression } };
    }
    return { ok: true, expression };
  }

  /** What keeps Apply from writing the copy, in words; `undefined` when it can. */
  private workingProblem(): string | undefined {
    const working = this.working;
    if (!working) {
      return undefined;
    }
    if (working.route) {
      return this.routeProblem(working.route);
    }
    if (!working.componentId) {
      return this.text(working.kind === "show-step" || working.kind === "hide-step" ? "logic.problem.chooseStep" : "logic.problem.chooseField");
    }
    const expression = this.workingExpression();
    if (!expression.ok) {
      return expression.error;
    }
    if (!expression.expression && working.ruleId === undefined) {
      return this.text(VALUE_KINDS.has(working.kind) ? "logic.problem.writeFormula" : "logic.problem.writeCondition");
    }
    return undefined;
  }

  /** What keeps a Go to rule from being written: no step to leave, nowhere to go, a condition that does not parse. */
  private routeProblem(route: WorkingRoute): string | undefined {
    if (route.pageId === "") {
      return this.text("logic.problem.chooseFrom");
    }
    if (route.to === "") {
      return this.text("logic.problem.chooseTo");
    }
    const expression = this.workingExpression();
    return expression.ok ? undefined : expression.error;
  }

  /**
   * The line above Apply: the problem that holds Apply, else that Apply replaces the rule a new
   * rule's field already has, else the first warning under the box.
   */
  private summaryLine(): { severity: "error" | "warning"; text: string } | undefined {
    const problem = this.workingProblem();
    if (problem !== undefined) {
      return { severity: "error", text: problem };
    }
    const replaced = this.replacedRule();
    if (replaced !== undefined) {
      return { severity: "warning", text: this.text("logic.problem.replaces", { field: replaced.target.label, rule: sentenceText(replaced.sentence) }) };
    }
    const warning = this.currentState()?.problems.find((entry) => entry.kind === "unknownField");
    return warning ? { severity: "warning", text: warning.message } : undefined;
  }

  /**
   * The stored rule a new rule's Apply writes over: its field's rule under the same key. Choosing
   * such a field opens that rule instead while the copy has nothing else typed; once it has, the
   * target is kept and the summary line says what Apply replaces.
   */
  private replacedRule(): LogicRule | undefined {
    const working = this.working;
    if (!working || working.route || working.ruleId !== undefined || working.componentId === undefined) {
      return undefined;
    }
    return this.storedRuleOn(working.componentId, working.ruleKey);
  }

  private storedRuleOn(componentId: string, ruleKey: string): LogicRule | undefined {
    return this.model?.rules.find((rule) => rule.id === `form:${componentId}:${ruleKey}`);
  }

  private workingLabel(): string {
    const working = this.working;
    if (!working) {
      return this.text("logic.kind.rule");
    }
    const head = this.kindWords(working.kind).label;
    if (working.route) {
      return working.route.pageId !== "" && this.model ? `${head}: ${this.routeFromLabel(this.model, working.route)}` : head;
    }
    return working.componentId ? `${head}: ${this.labelOf(working.componentId)}` : head;
  }

  /** Writes the copy as one undo step, as text; `false` when a problem holds it back. */
  private apply(): boolean {
    const working = this.working;
    const controller = this.ctrl;
    if (!working || !controller) {
      return true;
    }
    if (working.route) {
      return this.applyRoute(working, working.route);
    }
    if (this.workingProblem() !== undefined || !working.componentId) {
      this.paint();
      this.root.querySelector<HTMLElement>("#logic-problem")?.focus();
      return false;
    }
    const expression = this.workingExpression();
    if (!expression.ok) {
      return false;
    }
    const stored = this.storedText(working);
    const value: unknown =
      stored === "" ? undefined : working.run === "both" || BROWSER_ONLY_KEYS.has(working.ruleKey) ? stored : { formula: stored, run: working.run };
    const edits: Array<{ componentId: string; propertyPath: string; value: unknown; target?: "rules" }> = [];
    // The rule itself is written only when its text or run scope changed (or it is new): an
    // untouched rule stays byte-for-byte, a tree a tree.
    if (working.ruleId === undefined || working.text.trim() !== working.openedText.trim() || working.run !== working.openedRun) {
      edits.push({ componentId: working.componentId, propertyPath: working.ruleKey, value, target: "rules" });
    }
    // A check's words: `messages.rule`, a string in the form's default language. Its
    // translations are the map's and stay as they are, flagged "Source changed" when
    // the words change; an emptied text removes the entry, and the controller prunes its translations
    // with it. Same undo step as the rule.
    if (working.kind === "validate" && value !== undefined && working.message.trim() !== working.openedMessage.trim()) {
      const words = working.message.trim();
      edits.push({ componentId: working.componentId, propertyPath: "messages.rule", value: words === "" ? undefined : words });
    }
    if (working.kind === "show" || working.kind === "hide") {
      const storedBehavior = (findNode(controller.snapshot(), working.componentId)?.configuration as Record<string, unknown> | undefined)?.hiddenValueBehavior;
      // The same key the inspector's "When hidden" writes, and like it only for a choice other than the default.
      const next = working.hidden === this.hiddenDefaultOf(working.componentId) ? undefined : working.hidden;
      if (storedBehavior !== next) {
        edits.push({ componentId: working.componentId, propertyPath: "hiddenValueBehavior", value: next });
      }
    }
    // On paper: printed always while the rule hides it, with the rule's own words as
    // its note the first time; a note the author has since reworded is kept.
    if (working.kind === "show" || working.kind === "hide" || working.kind === "show-step" || working.kind === "hide-step") {
      const wasPaper = this.printShowOf(working.componentId) === "always";
      if (working.paper && !wasPaper) {
        edits.push({ componentId: working.componentId, propertyPath: "print.show", value: "always" });
        const configuration = findNode(controller.snapshot(), working.componentId)?.configuration as Record<string, unknown> | undefined;
        const existing = (configuration?.print as Record<string, unknown> | undefined)?.note;
        if (existing === undefined && expression.expression && this.words) {
          const words = sentenceText(this.words.conditionSentence(expression.expression));
          edits.push({ componentId: working.componentId, propertyPath: "print.note", value: this.text("logic.paper.note", { condition: words }) });
        }
      } else if (!working.paper && wasPaper) {
        edits.push({ componentId: working.componentId, propertyPath: "print.show", value: undefined });
      }
    }
    const ruleId = value !== undefined ? `form:${working.componentId}:${working.ruleKey}` : undefined;
    // Re-based before the write: the change it raises repaints with this as the clean copy.
    if (ruleId) {
      working.ruleId = ruleId;
      working.openedText = working.text;
      working.openedRun = working.run;
      working.openedMessage = working.message;
      working.baseline = this.serialize(working);
      if (working.kind === "show" || working.kind === "hide" || working.kind === "show-step" || working.kind === "hide-step") {
        this.authoredKinds.set(ruleId, { kind: working.kind, stored });
        this.authoredStamp += 1;
      }
    } else {
      this.working = undefined;
      this.dropEditor();
    }
    controller.setProperties(edits);
    this.announce(this.text("logic.announce.applied"));
    return true;
  }

  /**
   * Writes a Go to rule through the Journeys mode's host, to the journey's own controller as one
   * undo step: a new rule is added to its step (before the step's first rule with no condition),
   * a saved one changes its target and condition together. The form's controller is not written.
   */
  private applyRoute(working: Working, route: WorkingRoute): boolean {
    const host = this.journeyHost();
    const refuse = (message?: string): boolean => this.refuseRoute(message);
    const problem = this.workingProblem();
    if (problem !== undefined) {
      return refuse();
    }
    if (!host?.ready()) {
      return refuse(this.text("logic.problem.notWritten"));
    }
    const stored = this.storedText(working);
    if (working.ruleId === undefined) {
      const ref = host.create({ journeyId: route.journeyId, pageId: route.pageId, to: route.to, ...(stored !== "" ? { when: stored } : {}) });
      if (!ref) {
        return refuse(this.text("logic.problem.notWritten"));
      }
      working.ruleId = routeRuleId(ref);
      route.routeIndex = ref.routeIndex;
      route.openedTo = route.to;
      working.openedText = working.text;
      working.baseline = this.serialize(working);
      this.announce(this.text("logic.announce.applied"));
      this.paint();
      return true;
    }
    if (route.routeIndex === undefined) {
      return refuse(this.text("logic.problem.routeGone"));
    }
    const change: { to?: string; when?: string } = {};
    if (route.to !== route.openedTo) {
      change.to = route.to;
    }
    if (working.text.trim() !== working.openedText.trim()) {
      change.when = stored;
    }
    if (change.to === undefined && change.when === undefined) {
      return true;
    }
    // Re-based before the write, as a form rule is: the repaint the journey's change brings sees a clean copy.
    const was = { to: route.openedTo, text: working.openedText, baseline: working.baseline };
    route.openedTo = route.to;
    working.openedText = working.text;
    working.baseline = this.serialize(working);
    if (!host.update({ journeyId: route.journeyId, pageId: route.pageId, routeIndex: route.routeIndex }, change)) {
      route.openedTo = was.to;
      working.openedText = was.text;
      working.baseline = was.baseline;
      return refuse(this.text("logic.problem.notWritten"));
    }
    this.announce(this.text("logic.announce.applied"));
    return true;
  }

  /** Puts a Go to rule's refusal on the editor's problem line and focuses it: the copy stays as it was. */
  private refuseRoute(message?: string): boolean {
    this.paint();
    if (message !== undefined) {
      const line = this.root.querySelector<HTMLElement>("[data-logic-problem]");
      if (line) {
        line.hidden = false;
        line.dataset.severity = "error";
        line.setAttribute("role", "alert");
        const text = line.querySelector<HTMLElement>("[data-logic-problem-text]");
        if (text) {
          text.textContent = message;
        }
      }
    }
    this.root.querySelector<HTMLElement>("#logic-problem")?.focus();
    return false;
  }

  /** Moves a saved Go to rule one place in the order its step tries them in: one undo step, applied at once (the copy beside it is kept). */
  private moveRoute(delta: -1 | 1): void {
    const working = this.working;
    const route = working?.route;
    const host = this.journeyHost();
    if (!working || !route || route.routeIndex === undefined || working.ruleId === undefined || !host) {
      return;
    }
    this.movingRoute = true;
    let moved: LogicRouteRef | undefined;
    try {
      moved = host.move({ journeyId: route.journeyId, pageId: route.pageId, routeIndex: route.routeIndex }, delta);
    } finally {
      this.movingRoute = false;
    }
    if (!moved) {
      return;
    }
    // The rule is the same one a place further on: it is named by its position.
    route.routeIndex = moved.routeIndex;
    working.ruleId = routeRuleId(moved);
    this.changeStamp += 1;
    this.announce(this.text("logic.announce.moved", { position: this.ordinal(moved.routeIndex + 1), total: this.model?.journeys.find((journey) => journey.id === route.journeyId)?.pages.find((page) => page.id === route.pageId)?.routes ?? 0 }));
    this.paint();
    this.root.querySelector<HTMLElement>(`[data-logic-move="${delta}"]:not([disabled])`)?.focus();
  }

  /**
   * Drops the open rule, its tried values and any switch held behind its question, without a
   * question: the shell's way out of a workspace the host removed.
   */
  public discardPending(): void {
    // The leave question the controller holds for the open rule goes with it (a Stay: only the held run is dropped).
    if (this.ctrl?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
      this.ctrl.answerUnsavedChangesPrompt("stay");
    }
    // So does the surface's own switch question: left up, it would stay a modal in the hidden host.
    this.heldSwitch = undefined;
    this.discard();
  }

  private discard(): void {
    this.working = undefined;
    this.dropEditor();
    this.tryValues.clear();
    this.paint();
  }

  private removeRule(): void {
    const working = this.working;
    if (working?.route) {
      const route = working.route;
      const host = this.journeyHost();
      if (route.routeIndex === undefined || working.ruleId === undefined || !host) {
        return;
      }
      // The editor closes before the write, so the repaint the journey's change brings draws the list; a rule that
      // was not removed (a stale position, a refusal) keeps its copy and says so rather than announcing a removal.
      this.working = undefined;
      this.dropEditor();
      if (!host.remove({ journeyId: route.journeyId, pageId: route.pageId, routeIndex: route.routeIndex })) {
        this.working = working;
        this.refuseRoute(this.text("logic.problem.notWritten"));
        return;
      }
      this.announce(this.text("logic.announce.removed"));
      return;
    }
    if (!working?.componentId || working.ruleId === undefined) {
      return;
    }
    const componentId = working.componentId;
    this.working = undefined;
    this.dropEditor();
    const edits: Array<{ componentId: string; propertyPath: string; value: unknown; target?: "rules" }> = [
      { componentId, propertyPath: working.ruleKey, value: undefined, target: "rules" }
    ];
    // A check's words go with it, in the same undo step.
    const messages = this.ctrl ? (findNode(this.ctrl.snapshot(), componentId)?.configuration as Record<string, unknown> | undefined)?.messages : undefined;
    if (working.kind === "validate" && messages && typeof messages === "object" && (messages as Record<string, unknown>).rule !== undefined) {
      edits.push({ componentId, propertyPath: "messages.rule", value: undefined });
    }
    this.ctrl?.setProperties(edits);
    this.announce(this.text("logic.announce.removed"));
  }

  /** The foot's second button: Discard while the copy differs from the stored rule, else Close. */
  private discardWord(dirty: boolean): string {
    return this.text(dirty ? "logic.editor.discard" : "logic.editor.close");
  }

  private announce(text: string): void {
    const live = this.root.querySelector<HTMLElement>("[data-logic-live]") ?? this.ownLiveRegion();
    live.textContent = text;
  }

  private ownLiveRegion(): HTMLElement {
    const region = document.createElement("p");
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    region.dataset.logicLive = "";
    this.root.append(region);
    return region;
  }

  // --- the form's fields ------------------------------------------------------------

  private labelOf(componentId: string | undefined): string {
    if (!componentId) {
      return "";
    }
    return this.treeLabels().get(componentId) ?? componentId;
  }

  /** Every component's label as the tree shows it (the controller's view, resolved for its locale). */
  private treeLabels(): Map<string, string> {
    const labels = new Map<string, string>();
    const controller = this.ctrl;
    if (!controller) {
      return labels;
    }
    const walkView = (view: ReturnType<BuilderController["treeView"]>): void => {
      labels.set(view.id, view.label || view.id);
      for (const slot of view.slots) {
        for (const child of slot.children) {
          walkView(child);
        }
      }
    };
    walkView(controller.treeView());
    return labels;
  }

  private allNodes(): Array<{ node: ComponentNode; label: string }> {
    const controller = this.ctrl;
    if (!controller) {
      return [];
    }
    const labels = this.treeLabels();
    const out: Array<{ node: ComponentNode; label: string }> = [];
    const walk = (node: ComponentNode): void => {
      out.push({ node, label: labels.get(node.id) ?? node.id });
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          walk(child);
        }
      }
    };
    walk(controller.snapshot());
    return out;
  }

  /** A component's `print.show` as stored. */
  /**
   * What `componentId`'s hidden answer does while its configuration names nothing: left out of the
   * submission, unless it asks to be required or validated while hidden (`defaultHiddenValueBehaviorFor`,
   * the rule the inspector's "When hidden" row and the runtime read too).
   */
  private hiddenDefaultOf(componentId: string | undefined): HiddenValueBehavior {
    const node = componentId !== undefined && this.ctrl ? findNode(this.ctrl.snapshot(), componentId) : undefined;
    return node ? defaultHiddenValueBehaviorFor(node.configuration) : DEFAULT_HIDDEN_VALUE_BEHAVIOR;
  }

    private printShowOf(componentId: string): string | undefined {
    const configuration = this.ctrl ? (findNode(this.ctrl.snapshot(), componentId)?.configuration as Record<string, unknown> | undefined) : undefined;
    const show = (configuration?.print as Record<string, unknown> | undefined)?.show;
    return typeof show === "string" ? show : undefined;
  }

  /** What a new rule of `kind` can be for. */
  private targetChoices(kind: LogicRuleKind): Array<{ id: string; label: string }> {
    const controller = this.ctrl;
    if (!controller) {
      return [];
    }
    const nodes = this.allNodes().filter(({ node }) => node.id !== controller.rootId());
    // A row-count bound is a grid's alone.
    if (kind === "min-rows" || kind === "max-rows") {
      return nodes.filter(({ node }) => node.type === DATA_GRID_COMPONENT_TYPE).map(({ node, label }) => ({ id: node.id, label }));
    }
    if (kind === "show-step" || kind === "hide-step") {
      return nodes.filter(({ node }) => node.type === "step").map(({ node, label }) => ({ id: node.id, label }));
    }
    if (kind === "show" || kind === "hide") {
      return nodes.filter(({ node }) => node.type !== "step").map(({ node, label }) => ({ id: node.id, label }));
    }
    // A field inside a repeating section is left out of Validate and Require: the fold never reads
    // those rules there, so a saved check would do nothing on either side.
    const inSection = kind === "validate" || kind === "require" ? this.sectionMembers() : new Set<string>();
    return nodes.filter(({ node }) => kernelFoldHoldsOwnAnswer(node) && !inSection.has(node.id)).map(({ node, label }) => ({ id: node.id, label }));
  }

  /** The ids of every component below a repeating section (an ancestor with a `collection`). */
  private sectionMembers(): Set<string> {
    const members = new Set<string>();
    const walk = (node: ComponentNode, inside: boolean): void => {
      if (inside) {
        members.add(node.id);
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          walk(child, inside || node.collection !== undefined);
        }
      }
    };
    if (this.ctrl) {
      walk(this.ctrl.snapshot(), false);
    }
    return members;
  }

  // --- events -----------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("change", (event) => this.onEdit(event, "change"));
    this.root.addEventListener("input", (event) => this.onEdit(event, "input"));
    this.root.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "Escape") {
        return;
      }
      if (this.newMenuOpen) {
        event.stopPropagation();
        this.newMenuOpen = false;
        this.paint();
        this.root.querySelector<HTMLElement>("[data-logic-new]")?.focus();
      } else if (this.runMenuOpen) {
        event.stopPropagation();
        this.runMenuOpen = false;
        this.paint();
        this.root.querySelector<HTMLElement>("[data-logic-run-btn]")?.focus();
      } else {
        this.sheet.onEscape(event as KeyboardEvent);
      }
    });
    // Escape on the prompt is Stay, as the inspector's is.
    this.root.addEventListener(
      "cancel",
      (event) => {
        if ((event.target as HTMLElement | null)?.dataset?.prompt !== undefined) {
          event.preventDefault();
          this.answerPrompt("stay");
        }
      },
      true
    );
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement;
    const hit = (selector: string): HTMLElement | null => target.closest<HTMLElement>(selector);
    if (hit("[data-unsaved-stay]")) {
      this.answerPrompt("stay");
      return;
    }
    if (hit("[data-unsaved-discard]")) {
      this.answerPrompt("discard");
      return;
    }
    if (hit("[data-unsaved-save]")) {
      this.answerPrompt("save");
      return;
    }
    const filter = hit("[data-logic-filter]");
    if (filter) {
      this.filter = filter.dataset.logicFilter as LogicFilterId;
      this.spotlight = undefined;
      this.paint();
      return;
    }
    const spotlight = hit("[data-logic-spotlight]");
    if (spotlight && this.model) {
      const diagnostic = this.model.diagnostics[Number(spotlight.dataset.logicSpotlight)];
      this.spotlight = new Set(diagnostic?.ruleIds ?? []);
      this.paint();
      return;
    }
    if (hit("[data-logic-new]")) {
      this.newMenuOpen = !this.newMenuOpen;
      this.paint();
      if (this.newMenuOpen) {
        this.root.querySelector<HTMLElement>("[data-logic-new-kind]")?.focus();
      }
      return;
    }
    const kind = hit("[data-logic-new-kind]");
    if (kind) {
      const next = kind.dataset.logicNewKind as LogicRuleKind;
      this.requestOpen(() => this.openNew(next));
      return;
    }
    const doc = hit("[data-logic-open-doc]");
    if (doc) {
      this.dispatchEvent(
        new CustomEvent<LogicOpenDocumentDetail>("logic-open-document", {
          detail: { mode: doc.dataset.logicOpenDoc as "journeys" | "pdf", documentId: doc.dataset.docId ?? "" },
          bubbles: true,
          composed: true
        })
      );
      return;
    }
    // The Pinned-by line asks the shell to open a test or scaffold one; the shell owns the Tests panel.
    const openTest = hit("[data-logic-open-test]");
    if (openTest) {
      this.dispatchEvent(
        new CustomEvent<BuilderLogicOpenTestDetail>("builder-logic-open-test", {
          detail: { entryId: openTest.dataset.logicOpenTest ?? "" },
          bubbles: true,
          composed: true
        })
      );
      return;
    }
    const writeTest = hit("[data-logic-write-test]");
    if (writeTest) {
      this.dispatchEvent(
        new CustomEvent<BuilderLogicWriteTestDetail>("builder-logic-write-test", {
          detail: { ruleId: writeTest.dataset.logicWriteTest ?? "" },
          bubbles: true,
          composed: true
        })
      );
      return;
    }
    const card = hit("[data-logic-rule]");
    if (card && this.model) {
      const rule = this.model.rules.find((entry) => entry.id === card.dataset.logicRule);
      if (rule && rule.id !== this.working?.ruleId) {
        this.requestOpen(() => this.open(rule));
      }
      return;
    }
    if (hit("[data-logic-apply]")) {
      this.apply();
      return;
    }
    if (hit("[data-logic-discard]") || hit("[data-logic-close]")) {
      this.discard();
      return;
    }
    if (hit("[data-logic-remove]")) {
      this.removeRule();
      return;
    }
    const move = hit("[data-logic-move]");
    if (move) {
      if (!(move as HTMLButtonElement).disabled) {
        this.moveRoute(move.dataset.logicMove === "-1" ? -1 : 1);
      }
      return;
    }
    const working = this.working;
    if (!working) {
      if (this.newMenuOpen && !hit(".new-rule")) {
        this.newMenuOpen = false;
        this.paint();
      }
      return;
    }
    if (hit("[data-logic-run-btn]")) {
      this.runMenuOpen = !this.runMenuOpen;
      this.paint();
      if (this.runMenuOpen) {
        this.root.querySelector<HTMLElement>(`[data-logic-run="${working.run}"]`)?.focus();
      }
      return;
    }
    const run = hit("[data-logic-run]");
    if (run) {
      working.run = run.dataset.logicRun as RunScope;
      this.runMenuOpen = false;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-logic-run-btn]")?.focus();
      return;
    }
    const tryOne = hit("[data-logic-try-one]");
    if (tryOne) {
      const formula = tryOne.dataset.logicTryOne ?? "";
      working.text = formula;
      this.editorState = undefined;
      this.editor?.setText(formula);
      this.editor?.focus();
      this.refreshLive();
      return;
    }
    if (hit("[data-logic-editor-retry]")) {
      const editor = this.editor;
      if (editor) {
        this.editorFailed = false;
        editor.dom.parentElement?.querySelector("[data-logic-editor-failed]")?.remove();
        this.loadEditor(editor);
      }
      return;
    }
    if (this.runMenuOpen && !hit(".run-pick")) {
      this.runMenuOpen = false;
      this.paint();
    }
  }

  private answerPrompt(decision: "save" | "discard" | "stay"): void {
    const controller = this.ctrl;
    if (controller?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
      controller.answerUnsavedChangesPrompt(decision);
      return;
    }
    const next = this.heldSwitch;
    this.heldSwitch = undefined;
    if (decision === "stay") {
      this.paint();
      return;
    }
    if (decision === "save" && !this.apply()) {
      return;
    }
    if (decision === "discard") {
      this.working = undefined;
      this.dropEditor();
    }
    next?.();
    if (!next) {
      this.paint();
    }
  }

  private onEdit(event: Event, type: "input" | "change"): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const data = target.dataset ?? {};
    const working = this.working;
    if (data.logicTry !== undefined) {
      const value = target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target.value;
      if (value === "" || value === false) {
        this.tryValues.delete(data.logicTry);
      } else {
        this.tryValues.set(data.logicTry, value);
      }
      this.refreshTryResult();
      return;
    }
    if (data.logicTryFlag !== undefined) {
      const flags = { ...((this.tryValues.get(data.logicTryFlag) as Record<string, boolean> | undefined) ?? {}) };
      if ((target as HTMLInputElement).checked) {
        flags[target.value] = true;
      } else {
        delete flags[target.value];
      }
      if (Object.keys(flags).length === 0) {
        this.tryValues.delete(data.logicTryFlag);
      } else {
        this.tryValues.set(data.logicTryFlag, flags);
      }
      this.refreshTryResult();
      return;
    }
    if (data.logicTryToday !== undefined) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(target.value)) {
        this.tryToday = target.value;
        this.refreshTryResult();
      }
      return;
    }
    if (!working) {
      return;
    }
    if (working.route && type === "change" && (data.logicFrom !== undefined || data.logicTo !== undefined) && this.model) {
      const route = working.route;
      if (data.logicFrom !== undefined) {
        const picked = parseRouteKey(target.value);
        route.journeyId = picked?.journeyId ?? "";
        route.pageId = picked?.pageId ?? "";
        // Where the step goes by default: the next step in order, else the end; a target the new step cannot name is dropped first.
        const targets = route.pageId === "" ? [] : this.routeTargets(this.model, { ...route, to: "" });
        if (!targets.some((choice) => choice.value === route.to)) {
          route.to = targets[0]?.value ?? "";
        }
      } else {
        route.to = target.value;
      }
      this.paint();
      return;
    }
    if (data.logicTarget !== undefined && type === "change") {
      const componentId = target.value || undefined;
      // A target that already has this rule opens it rather than writing over it; a copy with other
      // changes keeps them and the target, and the summary line says Apply replaces that rule.
      const existing = componentId ? this.storedRuleOn(componentId, working.ruleKey) : undefined;
      if (existing && !this.dirtyBeyondTarget()) {
        this.open(existing);
        return;
      }
      working.componentId = componentId;
      if (componentId) {
        const stored = (findNode(this.ctrl!.snapshot(), componentId)?.configuration as Record<string, unknown> | undefined)?.hiddenValueBehavior;
        working.hidden = (stored as HiddenValueBehavior | undefined) ?? this.hiddenDefaultOf(componentId);
        if (working.kind === "validate" && working.message.trim() === working.openedMessage.trim()) {
          // The field's stored words are what a save would replace, so the box starts from them.
          // Words the author already typed are theirs: only an untouched box is seeded.
          const cleanBefore = !this.dirtyBeyondTarget();
          const messages = (findNode(this.ctrl!.snapshot(), componentId)?.configuration as Record<string, unknown> | undefined)?.messages;
          const storedWords = messages && typeof messages === "object" && !Array.isArray(messages) ? (messages as Record<string, unknown>).rule : undefined;
          const words = typeof storedWords === "string" ? storedWords : "";
          working.message = words;
          working.openedMessage = words;
          if (cleanBefore) {
            // The seeded words are the copy's starting point, not an edit: the baseline moves with them,
            // so a later target switch still opens the other field's rule.
            working.baseline = this.serialize({ ...working, componentId: undefined });
          }
        }
      }
      this.paint();
      return;
    }
    if (data.logicPaper !== undefined) {
      working.paper = (target as HTMLInputElement).checked;
      this.refreshLive();
      return;
    }
    if (data.logicMessage !== undefined) {
      // A keystroke: the copy and the live parts follow, the box keeps its caret (no repaint).
      working.message = target.value;
      this.refreshLive();
      return;
    }
    if (data.logicHidden !== undefined) {
      working.hidden = target.value as HiddenValueBehavior;
      this.refreshLive();
    }
  }

  /** Whether the copy has changes besides its target (a target switch then keeps them). */
  private dirtyBeyondTarget(): boolean {
    const working = this.working;
    if (!working) {
      return false;
    }
    return this.serialize({ ...working, componentId: undefined }) !== working.baseline;
  }

  /**
   * After a keystroke: the parts that follow the copy ("Not applied", Apply, the summary line,
   * "Reads as", Try it) without a repaint, so the box being typed in keeps its caret. Try it's
   * boxes are redrawn only when the fields the formula reads change; otherwise its answer alone.
   */
  private refreshLive(): void {
    const working = this.working;
    const dirty = this.dirty;
    const flag = this.root.querySelector<HTMLElement>("[data-logic-dirty]");
    if (flag) {
      flag.hidden = !dirty;
    }
    const apply = this.root.querySelector<HTMLButtonElement>("[data-logic-apply]");
    if (apply) {
      apply.disabled = !dirty;
    }
    const discard = this.root.querySelector<HTMLButtonElement>("[data-logic-discard]");
    if (discard) {
      discard.textContent = this.discardWord(dirty);
    }
    const line = this.summaryLine();
    const problem = this.root.querySelector<HTMLElement>("[data-logic-problem]");
    if (problem) {
      problem.hidden = line === undefined;
      problem.dataset.severity = line?.severity ?? "";
      const text = problem.querySelector<HTMLElement>("[data-logic-problem-text]");
      if (text) {
        text.textContent = line?.text ?? "";
      }
      if (line?.severity === "error") {
        problem.setAttribute("role", "alert");
      } else {
        problem.removeAttribute("role");
      }
    }
    const reads = this.root.querySelector<HTMLElement>("[data-logic-reads]");
    if (reads) {
      reads.innerHTML = this.readsHtml();
    }
    const tryOne = this.root.querySelector<HTMLElement>("[data-logic-try-one-row]");
    if (tryOne && working) {
      tryOne.innerHTML = this.tryOneHtml(working);
    }
    const host = this.root.querySelector<HTMLElement>("[data-logic-try]");
    if (host && working) {
      // The boxes' html (which embeds the result) is built only when the fields read changed:
      // otherwise the result alone is refreshed, so one preview runtime runs per keystroke, not two.
      const next = this.trySignatureOf(working);
      if ((next?.signature ?? "") !== this.trySignature || host.innerHTML === "") {
        host.innerHTML = this.tryItHtml(working, next);
      } else {
        this.refreshTryResult();
      }
    }
  }

  private refreshTryResult(): void {
    const result = this.root.querySelector<HTMLElement>("[data-logic-try-result]");
    if (result) {
      result.innerHTML = this.tryResultHtml();
    }
  }

  // --- focus across repaints --------------------------------------------------------

  private captureFocus(): string | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    for (const attribute of active.getAttributeNames()) {
      if (attribute.startsWith("data-logic") || attribute === "data-unsaved-stay") {
        const value = active.getAttribute(attribute);
        return `[${attribute}${value ? `="${quoteAttr(value)}"` : ""}]${active instanceof HTMLInputElement && (active.type === "checkbox" || active.type === "radio") ? `[value="${quoteAttr(active.value)}"]` : ""}`;
      }
    }
    return undefined;
  }

  private restoreFocus(selector: string | undefined): void {
    if (!selector) {
      return;
    }
    try {
      this.root.querySelector<HTMLElement>(selector)?.focus();
    } catch {
      // A selector the repaint no longer matches: focus stays where the browser put it.
    }
  }
}

// --- helpers ----------------------------------------------------------------------

/** The id the Logic model gives a Go to rule (`logic-model.ts`), from the route as the host names it. */
function routeRuleId(ref: LogicRouteRef): string {
  return `journeys:${ref.journeyId}:${ref.pageId}:route:${ref.routeIndex}`;
}

/** A journey and a step as one option value, and back. */
function routeKey(journeyId: string, pageId: string): string {
  return `${encodeURIComponent(journeyId)}/${encodeURIComponent(pageId)}`;
}

function parseRouteKey(value: string): { journeyId: string; pageId: string } | undefined {
  const at = value.indexOf("/");
  if (at < 0) {
    return undefined;
  }
  try {
    return { journeyId: decodeURIComponent(value.slice(0, at)), pageId: decodeURIComponent(value.slice(at + 1)) };
  } catch {
    return undefined;
  }
}

/** A value inside a quoted attribute selector: its quotes and backslashes escaped. */
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function findNode(root: ComponentNode, id: string): ComponentNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      const hit = findNode(child, id);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** A worked-out value in Try it's words: a list or flags object as its items, text as is. */
function tryValueText(value: unknown, separator: string): string {
  if (Array.isArray(value)) {
    return value.map((item) => tryValueText(item, separator)).join(separator);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, flag]) => flag === true)
      .map(([key]) => key)
      .join(separator);
  }
  return String(value);
}

/** The calendar day of `date` where the author sits, as `YYYY-MM-DD`. */
function calendarDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The text the box opens for a rule: its formula, or for a hide rule the condition inside its `not(…)`. */
function openedTextOf(rule: LogicRule): string {
  return NEGATED_KINDS.has(rule.kind) ? innerOfNot(rule) : rule.formula;
}

/**
 * The condition inside a hide rule's `not(…)`: the stored text with its outer `not(` and `)`
 * taken off when the text is exactly that shape, else the inner tree printed with ids.
 */
function innerOfNot(rule: LogicRule): string {
  const text = rule.formula.trim();
  const match = /^not\s*\(([\s\S]*)\)$/.exec(text);
  if (match && balanced(match[1] as string)) {
    return (match[1] as string).trim();
  }
  const expression = rule.expression;
  if (expression !== undefined && expression.kind === "unary") {
    return printFormula(expression.operand);
  }
  return text;
}

/** Whether every parenthesis in `text` closes inside it (so `not(a) or not(b)` is not read as one `not(…)`). */
function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/** The sentence as one string: the tokens carry their own spaces (logic-model.ts). */
function sentenceText(tokens: readonly LogicToken[]): string {
  return tokens.map((token) => token.text).join("").replace(/\s+/g, " ").trim();
}

/**
 * Each token its own piece, trimmed: the card lays them out with a gap of its own. A comma or
 * semicolon that opens a token (the cases' ", otherwise" and "; ") attaches to the piece before
 * it, so the gap never comes before the mark: inside a word, or wrapped with a chip.
 */
function sentenceHtml(tokens: readonly LogicToken[], separator = ""): string {
  const pieces: string[] = [];
  for (const token of tokens) {
    const text = token.text.trim();
    if (text === "") {
      continue;
    }
    const mark = /^[,;]/.exec(text)?.[0];
    if (mark !== undefined && pieces.length > 0) {
      pieces[pieces.length - 1] = withMark(pieces[pieces.length - 1]!, mark);
      const rest = text.slice(mark.length).trim();
      if (rest !== "") {
        pieces.push(tokenHtml({ ...token, text: rest }));
      }
      continue;
    }
    pieces.push(tokenHtml({ ...token, text }));
  }
  return pieces.join(separator);
}

function tokenHtml(token: LogicToken): string {
  switch (token.kind) {
    case "verb":
      return `<span class="verb">${esc(token.text)}</span>`;
    case "word":
      return `<span class="word">${esc(token.text)}</span>`;
    case "expression":
      return `<code class="ref-chip token--expr">${esc(token.text)}</code>`;
    case "field":
      return `<span class="ref-chip token--field${token.unknown ? " token--unknown" : ""}"${token.unknown ? ` title="${esc(token.text)}"` : ""}>${esc(token.text)}</span>`;
    default:
      return `<span class="ref-chip token--${token.kind}">${esc(token.text)}</span>`;
  }
}

/** `piece` with a punctuation mark attached: inside a plain word, or wrapped with a chip. */
function withMark(piece: string, mark: string): string {
  if (piece.startsWith('<span class="word">') || piece.startsWith('<span class="verb">')) {
    return `${piece.slice(0, -"</span>".length)}${esc(mark)}</span>`;
  }
  return `<span class="with-mark">${piece}${esc(mark)}</span>`;
}

/**
 * The surface's look, on the studio tokens: the filters, the list and the editor as
 * three cards over the backdrop, the editor folding over the list under 900px of surface. The
 * formula box's own rules come from `formula-editor-styles.ts`, appended after these.
 */
const LOGIC_STYLES = `
  :host { display: block; height: 100%; min-height: 0; container-type: inline-size; }
  .logic {
    box-sizing: border-box; height: 100%; min-height: 0; padding: var(--db-gap, 12px);
    display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--db-gap, 12px);
    font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
  }
  .logic[data-editing] { grid-template-columns: 220px minmax(0, 1fr) minmax(var(--db-editor-min), var(--db-editor-max)); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .muted { color: var(--db-ink-muted); }
  .small { font-size: var(--db-text-sm); }
  .logic-filters { align-self: start; padding: var(--db-space-2); display: grid; gap: var(--db-space-2); }
  .filter-list { display: grid; gap: 2px; }
  .filter {
    display: flex; justify-content: space-between; align-items: center; gap: var(--db-space-2);
    min-block-size: 36px; padding: 0 var(--db-space-3); border: 0; border-radius: var(--db-radius-md);
    background: transparent; color: var(--db-ink); font: inherit; font-weight: 500; cursor: pointer; text-align: start;
  }
  .filter:hover { background: var(--db-surface-hover); }
  .filter[aria-pressed="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
  .filter-count { font-size: var(--db-text-sm); opacity: .85; font-variant-numeric: tabular-nums; }
  .filter:focus-visible, .rule:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .new-rule { position: relative; }
  .new-rule-btn { width: 100%; }
  /* The shared menu (.menu, .menu-item), dropped from its button; each item is a name over its hint. */
  .new-menu, .run-menu { position: absolute; inset-inline: 0; top: calc(100% + var(--db-space-1)); }
  .new-menu .menu-item, .run-menu .menu-item { display: grid; gap: 2px; justify-content: stretch; padding-block: var(--db-space-2); }
  .new-menu .menu-item span, .run-menu .menu-item span { color: var(--db-ink-muted); font-size: var(--db-text-sm); }
  .run-menu .menu-item[aria-checked="true"] { background: var(--db-surface-sunken); }
  .logic-list { min-height: 0; overflow: auto; display: grid; align-content: start; gap: var(--db-space-4); padding-inline-end: 2px; }
  .flow { padding: var(--db-space-3) var(--db-space-4); }
  .flow-title { margin: 0 0 var(--db-space-2); font-weight: 600; }
  .flow-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
  .flow-step {
    display: inline-flex; align-items: center; gap: var(--db-space-2); padding: var(--db-space-1) var(--db-space-3) var(--db-space-1) var(--db-space-1);
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-pill); background: var(--db-surface);
  }
  .flow-step--conditional { border-style: dashed; }
  .flow-index { display: grid; place-items: center; inline-size: 22px; block-size: 22px; border-radius: 50%; background: var(--db-surface-sunken); font-size: var(--db-text-sm); font-weight: 600; }
  /* A diagnostic is the shared note (.note, its tone) laid out as a row: a mark, the words, Show them. */
  .diagnostic { display: flex; align-items: center; gap: var(--db-space-3); padding: var(--db-space-3) var(--db-space-4); }
  .diagnostic p { margin: 0; flex: 1; }
  .diag-mark { display: grid; place-items: center; inline-size: 22px; block-size: 22px; border-radius: 50%; background: var(--db-warn); color: var(--db-surface); font-weight: 700; flex: none; }
  .diagnostic[data-tone="error"] .diag-mark { background: var(--db-danger); }
  .spot-note { margin: 0; }
  .rule-group h3 { margin: 0 0 var(--db-space-2); font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); }
  .rules { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); }
  .rule-row { display: flex; align-items: center; gap: var(--db-space-2); flex-wrap: wrap; }
  .rule {
    position: relative; flex: 1 1 320px; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; text-align: start;
    padding: var(--db-space-3) var(--db-space-4); border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg);
    background: var(--db-surface); color: var(--db-ink); font: inherit; cursor: pointer;
  }
  .rule:hover { border-color: var(--db-line-input); }
  .rule--selected { border-color: var(--db-selected); box-shadow: 0 0 0 1px var(--db-selected); }
  .rule--readonly { background: var(--db-surface-sunken); }
  .rule--secret .word:last-child { font-style: italic; }
  .verb { font-weight: 600; }
  .word { color: var(--db-ink-muted); }
  /* A field in a sentence is the shared .ref-chip; a value, a document and a formula are the same chip in another fill. */
  .token--value { background: var(--db-surface-sunken); color: var(--db-ink); }
  .token--unknown { background: var(--db-danger-soft); color: var(--db-danger); text-decoration: underline wavy; text-underline-offset: 3px; }
  .with-mark { display: inline-flex; align-items: center; }
  .token--document { background: var(--db-surface-sunken); color: var(--db-ink); border: var(--db-border-w) solid var(--db-line-input); }
  .token--expr { font-family: var(--db-font-mono); border-radius: var(--db-radius-sm); background: var(--db-surface-sunken); color: var(--db-ink); }
  .chip { display: inline-flex; align-items: center; gap: 6px; min-block-size: 24px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); font-size: var(--db-text-sm); white-space: nowrap; }
  .chip--secret { background: var(--db-ink); color: var(--db-surface); }
  .chip--fixed { justify-self: start; min-block-size: 36px; padding: 0 var(--db-space-3); }
  /* The Pinned-by line: the tests that read this rule as buttons, or a way to write one. */
  .pins-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); margin: 0; font-size: var(--db-text-sm); }
  .pins-line .row-label { font-weight: 500; }
  .chip--pin { min-block-size: 30px; border: var(--db-border-w) solid var(--db-line-card); background: var(--db-surface); font: inherit; font-size: var(--db-text-sm); cursor: pointer; color: var(--db-ink); }
  .chip--pin:hover { background: var(--db-surface-hover); }
  .chip--pin:focus-visible, .pins-line .btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  /*
   * The rule editor is a stack of cards (.card-stack scrolls, .card draws): the title and the
   * boxes that say what the rule is about, then a card for each part, then Apply and Discard,
   * pinned to the bottom of the stack so they stay in reach however far it is scrolled.
   */
  .logic-editor { gap: var(--db-space-2); }
  .logic-editor > .card { padding: var(--db-space-3) var(--db-space-4); }
  .logic-editor > .pins-line { padding-block: var(--db-space-2); }
  /* A field focused under the pinned buttons scrolls clear of them. */
  .logic-editor { scroll-padding-block-end: 80px; }
  .editor-section { display: grid; gap: var(--db-space-3); align-content: start; }
  .editor-head > header { display: grid; gap: var(--db-space-1); }
  .sentence { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .head-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--db-space-3); }
  /* A group of choices is a fieldset: no frame of its own, the shared field layout and label. */
  fieldset.field { border: 0; margin: 0; padding: 0; }
  .field-pick { justify-self: start; min-block-size: 36px; }
  /* A Go to rule's order: "Tried 1st of 2 from this step" with Move up and Move down beside it. */
  .order-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); }
  .order-text { font-size: var(--db-text-sm); color: var(--db-ink-muted); margin-inline-end: auto; }
  .order-note { flex: 1 0 100%; margin: 0; }
  .run-pick { position: relative; }
  .run-btn { width: 100%; justify-content: space-between; min-block-size: 36px; font-size: var(--db-text-sm); }
  .formula-lead { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  .formula-slot { display: grid; gap: var(--db-space-2); }
  .formula-slot .formula-fallback { display: grid; gap: var(--db-space-1); }
  .formula-slot .formula-textarea { min-block-size: 44px; padding: 8px 10px; font-family: var(--db-font); font-size: var(--db-text-md); line-height: 28px; }
  .formula-slot .formula-fallback .problem { margin: 0; font-size: var(--db-text-sm); }
  .formula-slot .formula-problems { display: none; }
  .problem-line { margin: 0; display: flex; align-items: flex-start; gap: var(--db-space-2); font-size: var(--db-text-sm); line-height: 1.4; }
  .problem-line .problem-mark { flex: none; margin-block-start: 1px; }
  .problem-line[data-severity="error"] { color: var(--db-danger); }
  .problem-line[data-severity="warning"] { color: var(--db-warn); }
  .problem-line[hidden] { display: none; }
  .editor-failed { margin: 0; }
  .try-one { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .try-one:empty { display: none; }
  .reads { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: var(--db-text-sm); color: var(--db-ink-muted); line-height: 26px; }
  .reads:empty::before { content: "…"; }
  /* The boxes are the shared ones; here they never outgrow their card, and a textarea reads in the code face. */
  select, input[type="text"], input[type="date"], textarea { max-width: 100%; }
  textarea { font-family: var(--db-font-mono); resize: vertical; width: 100%; }
  .choice { display: inline-flex; align-items: center; gap: var(--db-space-2); min-block-size: 24px; cursor: pointer; }
  .hidden-choice { gap: var(--db-space-1); }
  .try-host:empty { display: none; }
  .try-row { display: grid; gap: 6px; }
  .try { border-radius: var(--db-radius-lg); padding: var(--db-space-3); display: grid; gap: var(--db-space-2); margin: 0; background: var(--db-surface-sunken); }
  .try-boxes { display: flex; flex-wrap: wrap; gap: var(--db-space-2); }
  .try-boxes > .field, .try-boxes > .choice { flex: 1 1 140px; min-width: 0; }
  .try-flags { flex: 1 1 100%; display: flex; flex-wrap: wrap; gap: var(--db-space-1) var(--db-space-3); }
  .try-result { margin: 0; display: flex; align-items: center; gap: var(--db-space-2); font-weight: 500; color: var(--db-ok, var(--db-ink)); font-size: var(--db-text-sm); }
  .try-result:empty { display: none; }
  .try-result .side { margin-inline-start: auto; font-weight: 400; }
  /* Apply and Discard are the stack's last card, pinned to its bottom edge at every width, as the inspector's footer is. */
  .editor-foot { position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); padding: var(--db-space-3) var(--db-space-4); }
  .editor-foot .spacer { flex: 1; }
  /* Apply and Discard keep their words on one line and their width. */
  .editor-foot .btn { white-space: nowrap; flex: none; }
  .editor-foot .btn.primary { background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink); }
  .editor-foot .btn.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected) 84%, var(--db-surface)); border-color: var(--db-selected); }
  .dirty-flag { display: inline-flex; align-items: center; gap: var(--db-space-1); font-size: var(--db-text-sm); font-weight: 500; color: var(--db-warn); }
  .dirty-flag::before { content: ""; inline-size: 8px; block-size: 8px; border-radius: 50%; background: currentColor; }
  .dirty-flag[hidden] { display: none; }
  /* Under 900px of surface the editor folds over the list, and the filters become a row. */
  @container (max-width: 899px) {
    .logic, .logic[data-editing] { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .logic-filters { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .filter-list { display: flex; overflow-x: auto; gap: 2px; }
    .filter { white-space: nowrap; }
    .new-rule-btn { width: auto; }
    .new-menu { inset-inline: auto 0; min-inline-size: 240px; }
    .logic-editor {
      position: absolute; inset-block: var(--db-gap, 12px); inset-inline-end: var(--db-gap, 12px);
      inline-size: min(var(--db-editor-max), calc(100% - 2 * var(--db-gap, 12px))); z-index: var(--db-z-drawer);
      /* Over the list the gaps between the cards are filled, so no row shows through them. */
      background: var(--db-backdrop); border-radius: var(--db-radius-lg); box-shadow: var(--db-shadow-overlay);
    }
    .logic { position: relative; }
  }
  @media (pointer: coarse) {
    .filter, .rule { min-block-size: 44px; }
  }
  /*
   * The phone tier: the shell sets data-phone. The editor rises as a tall sheet over
   * a scrim of the surface's own (the shell dims its bars), its Apply and Discard pinned.
   */
  :host([data-phone]) .logic-editor {
    position: absolute; inset: max(var(--db-space-2), 10%) 0 0 0; inline-size: auto; z-index: 30;
    gap: var(--db-space-2); border-radius: 22px 22px 0 0; background: var(--db-surface-sunken); box-shadow: var(--db-shadow-drawer);
    overscroll-behavior: contain;
  }
  :host([data-phone]) .logic-editor > .card { margin-inline: var(--db-space-2); box-shadow: none; }
  :host([data-phone]) .logic-editor > .editor-foot { margin-block-end: 0; padding-bottom: calc(var(--db-space-3) + env(safe-area-inset-bottom, 0px)); }
  :host([data-phone]) :is(select, input[type="text"], input[type="date"], textarea) { min-block-size: 44px; font-size: var(--db-text-lg); }
  :host([data-phone]) .btn { min-block-size: 44px; }
  :host([data-phone]) .choice { min-block-size: 44px; align-items: center; }
  .sheet-close-btn { display: none; }
  @container (max-width: 899px) { .sheet-close-btn { display: inline-flex; } }
  :host([data-phone]) .sheet-close-btn { display: inline-flex; }
  /* Narrow surfaces: the chips wrap in their own row and New rule takes the row under them. */
  @container (max-width: 599px) {
    .logic-filters { grid-template-columns: minmax(0, 1fr); }
    .filter-list { flex-wrap: wrap; overflow-x: visible; }
    .new-rule-btn { width: 100%; }
  }
  :host([data-phone]) .logic-filters { grid-template-columns: minmax(0, 1fr); }
  :host([data-phone]) .filter-list { flex-wrap: wrap; overflow-x: visible; }
  :host([data-phone]) .new-rule-btn { width: 100%; }
  :host([data-phone]) .logic { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); padding: var(--db-gap, 8px); position: relative; }
  :host([data-phone]) .head-row { grid-template-columns: minmax(0, 1fr); }
  :host([data-phone]) :is(.filter, .rule) { min-block-size: 44px; }

  @media (forced-colors: active) {
    .filter[aria-pressed="true"], .rule--selected { outline: 2px solid Highlight; }
    .flow-step--conditional { border-color: CanvasText; }
  }
`;

export function defineBuilderLogic(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_LOGIC_TAG)) {
    customElements.define(DATUM_BUILDER_LOGIC_TAG, DatumBuilderLogicElement);
  }
}

defineBuilderLogic();
