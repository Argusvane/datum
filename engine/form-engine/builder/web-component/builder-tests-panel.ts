/**
 * The Tests panel: the form's scenarios in the side drawer, run on the
 * browser's reading as the author edits, with the editor for one scenario and what a failure
 * says. Lazy: the shell loads this module (`tests-panel-loader.ts`) the first time Tests is
 * opened or a rename has scenarios to follow, so the builder's entry carries none of it.
 *
 * Two views in one drawer. The list: Run all, the "Run as I edit" switch, the summary line, a
 * filter and one row per scenario with its status dot. The editor: one scenario's text (the
 * plain textarea at once, the CodeMirror editor swapped in when its chunk lands), the problems
 * under the box by line, and the failure card with Show me, Open rule and Accept new behaviour.
 * Editing is local until Apply, which writes the whole `tests` block through the controller in
 * one undo step; an unapplied edit holds the shell's leave prompt
 * through the controller's leave guard, as the Logic surface's open rule does.
 *
 * A third view sits in the list's place, the rules and the tests that pin them (with
 * Write a test per rule), and, in the editor, Record (what the author does in Try it becomes
 * lines of the open test) and Assert this (what the tried form shows becomes expectations). The
 * canvas is reached only through the two callbacks the shell lends (`recordOnCanvas`,
 * `assertSnapshot`); the pure halves are `tests-record.ts`.
 *
 * Paint contract (the builder panel memory): every change asks `paint()`, never `render()`; the
 * list view is written whole through `writeMarkup`, while the editor view is written once per
 * scenario and then updated region by region, so the editor box, its caret and its focus never
 * go through a repaint. Runs never start while the panel is hidden; one missed is made up when
 * it is shown again.
 */
import type { DataSourceSet } from "../../core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { FormTestConfiguration, FormTestGiven, FormTestProblem, FormTestScenario, FormTestScenarioResult, FormTestStepResult } from "../../core/form-tests/form-test-types.js";
import type { BuilderTextCatalog, BuilderTextKey, BuilderTextOptions } from "../logic/builder-texts.js";
import type { BuilderChangeEvent, BuilderChangeReason, BuilderController, LeaveGuard, UnsavedChangesDecision } from "../controller/builder-controller.js";
import type {
  BuilderTestsOpenRuleDetail,
  BuilderTestsStatusDetail,
  CanvasScenarioShowing,
  TestsEditor,
  TestsEditorMark,
  TestsEditorOptions,
  TestsEditorProblem,
  TestsAssertSnapshot,
  TestsEntryModel,
  TestsEntryStatus,
  TestsNaming,
  TestsRecordEvent,
  TestsRecordListener,
  TestsRunner,
  TestsRunSummary,
  TestsShowingGivens,
  TestsWords
} from "../form-tests/tests-model.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { createTestsRunner } from "../form-tests/tests-runner.js";
import { formTestLints, type FormTestLint } from "../../core/form-tests/form-test-lint.js";
import { createTestsNaming, createTestsWords } from "../form-tests/tests-words.js";
import { acceptNewBehaviour, testsLiteral, testsStringLiteral } from "../form-tests/tests-accept.js";
import { kernelExprReadsClock } from "../../rules/evaluator/evaluator.js";
import { decidingRuleOf } from "../form-tests/tests-rules.js";
import { createTestsCompletions } from "../form-tests/tests-completions.js";
import { lastFilledLine, lineEndOffset, mountTestsTextarea, statementInsertion, TESTS_EDITOR_STYLES, TESTS_TEXTAREA_STYLES, type TestsInsertLineOptions } from "../form-tests/tests-textarea.js";
import { assertLines, changedFields, recordStep, type TestsRecordRefusal } from "../form-tests/tests-record.js";
import { untestedRules, type TestsUntestedView } from "../form-tests/tests-coverage.js";
import { scaffoldableKinds, scaffoldTestsForRule } from "../form-tests/tests-scaffold.js";
import { buildLogicModel } from "../logic/logic-model.js";
import { loadTestsEditor, type TestsEditorModule } from "../form-tests/tests-editor-loader.js";
import { addStepChoices, addStepFields } from "../form-tests/tests-add-step.js";
import { TESTS_PANEL_STYLES } from "../form-tests/tests-panel-styles.js";
import { builderPlural, builderText } from "../form-tests/tests-panel-texts-en.js";
import { BuilderPanelElement, type FormulaFunctionsSource } from "./builder-panels.js";
import { builderTokens, esc, unsavedChangesPromptHtml } from "./builder-shared.js";
import { showBuilderModal } from "./modal-place.js";

// The rename seam: the shell loads this chunk and calls it when a component is renamed,
// and when an edit moves where answers are stored (a data key).
export { moveValuePathsInTests, renameInTests, renameLocaleInTests, testsNamingLocale } from "../form-tests/tests-rename.js";
// The Logic editor's "Pinned by" line: the shell loads this chunk and asks it,
// parsing the block with the runner's pure `parse` (the chunk's one parser).
export { testsPinsOf, untestedRules } from "../form-tests/tests-coverage.js";
export { createTestsRunner } from "../form-tests/tests-runner.js";
// The builder agent's run_tests words its steps with the panel's own sentences, read
// through this chunk's loader, so the tests.* keys stay in one table and the runner in one chunk.
export { createTestsNaming, createTestsWords } from "../form-tests/tests-words.js";

export const DATUM_BUILDER_TESTS_PANEL_TAG = "datum-builder-tests-panel";

/** Where "Run as I edit" is remembered. */
export const TESTS_RUN_AS_I_EDIT_KEY = "datum-builder:tests:runAsIEdit";

/** The leave guard's subject id, so the panel knows a held prompt is its own. */
const GUARD_ID = "tests-panel";

/** How long the form must be still before Run as I edit reruns the suite. */
const RUN_DEBOUNCE_MS = 400;
/** How long the editor must be still before its text is parsed for problems. */
const PARSE_DEBOUNCE_MS = 150;

/** The text a New test starts from: a header and an indented line for the caret. */
function seedSource(name: string): string {
  return `test ${JSON.stringify(name)}\n  `;
}

const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg>`;
const REC_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>`;
const STOP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>`;

/** A coverable rule's kind in words (the Untested view's lead word). */
const KIND_KEYS: Readonly<Record<string, BuilderTextKey>> = {
  show: "tests.panel.kind.show",
  hide: "tests.panel.kind.hide",
  require: "tests.panel.kind.require",
  enable: "tests.panel.kind.enable",
  readonly: "tests.panel.kind.readonly",
  validate: "tests.panel.kind.validate",
  calculate: "tests.panel.kind.calculate",
  "min-rows": "tests.panel.kind.minRows",
  "max-rows": "tests.panel.kind.maxRows",
  "show-step": "tests.panel.kind.showStep",
  "hide-step": "tests.panel.kind.hideStep",
  route: "tests.panel.kind.route",
  "pdf-layout": "tests.panel.kind.pdfLayout"
};

/** Why a recorded event wrote no line, in words (the row removal has its own one-off note). */
const REFUSED_KEYS: Readonly<Record<Exclude<TestsRecordRefusal, "removeRow">, BuilderTextKey>> = {
  value: "tests.panel.record.refused.value",
  path: "tests.panel.record.refused.path",
  page: "tests.panel.record.refused.page"
};

/** The editors take an optional second argument to `insertLine` (tests-textarea.ts); the contract's type has one. */
type LineInserter = TestsEditor & { insertLine(text: string, options?: TestsInsertLineOptions): void };

/** A recording in progress: the canvas's stop, and what it has written so far. */
interface Recording {
  stop: () => void;
  lines: number;
  /** A row removal was met and said once: the canvas cannot say which row went. */
  removeNoted: boolean;
  /** The working copy the lines go into; another one opened ends the recording. */
  working: Working;
  /** Set while the canvas is told to stop: its stop sends what it held back, and its `canvas-record-change` echoes back through the shell. */
  ending: boolean;
  /**
   * Whether the recording has had its first snapshot of the tried form: the `given today` lead
   * line and the before-state wait for it. The canvas has none until the Try it chunk arrives,
   * which may be after Record started.
   */
  started: boolean;
  /** The day was needed (the form reads the clock, the test names none) but the canvas did not say it: said once, shown meanwhile. */
  noDay: boolean;
}

/** The Assert this popover's state: the snapshot it lists and what the author ticked, by value path. */
interface AssertState {
  snapshot: TestsAssertSnapshot;
  previous: TestsAssertSnapshot | undefined;
  changed: Set<string>;
  picked: Set<string>;
  extras: Set<"page" | "errors" | "verdict">;
  search: string;
}
const WARN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`;

/** A dot's tone: passed is ready, failures are danger, a skip is a warning, the rest are muted. */
function toneOf(status: TestsEntryStatus): "ok" | "bad" | "warn" | "off" | "run" {
  switch (status) {
    case "passed":
      return "ok";
    case "failed":
    case "error":
    case "invalid":
      return "bad";
    case "skipped":
      return "warn";
    case "running":
      return "run";
    default:
      return "off";
  }
}

/** Gives `el` the attributes of `fresh` (the element itself, not its children), touching only those that differ. */
function patchElement(el: HTMLElement, fresh: HTMLElement): void {
  for (const name of el.getAttributeNames()) {
    if (!fresh.hasAttribute(name)) {
      el.removeAttribute(name);
    }
  }
  for (const name of fresh.getAttributeNames()) {
    const value = fresh.getAttribute(name) ?? "";
    if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }
}

/** The same, and the text, for an element that holds text only. */
function patchText(el: HTMLElement, fresh: HTMLElement): void {
  patchElement(el, fresh);
  if (el.textContent !== fresh.textContent) {
    el.textContent = fresh.textContent;
  }
}

/**
 * What a scenario fixed before its steps, as the canvas's Show me can apply it.
 * `given journey` is the runner's own and has no seam on the canvas.
 * The first `given` of a kind wins, as the runner's start reads them in source order.
 */
function showingGivensOf(givens: readonly FormTestGiven[]): TestsShowingGivens | undefined {
  const out: TestsShowingGivens = {};
  for (const given of givens) {
    if (given.key === "today" && out.today === undefined) {
      out.today = given.value;
    } else if (given.key === "locale" && out.locale === undefined) {
      out.locale = given.value;
    } else if (given.key === "host") {
      out.host = { ...(out.host ?? {}), [given.name]: given.value };
    } else if (given.key === "options" && (out.options === undefined || !Object.prototype.hasOwnProperty.call(out.options, given.path))) {
      out.options = { ...(out.options ?? {}), [given.path]: [...given.values] };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A calendar day as `given today` takes it. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Fitting an open popover to the panel's scroller: the room under which the panel scrolls once to
 * make more, the floor the popover never shrinks below, the gap kept
 * under the scroller's edge (the --db-space-2 step), and the style sheet's own caps, which an inline
 * max-block-size would otherwise lift on a tall panel.
 */
const POPOVER_MIN_HEIGHT = 200;
const POPOVER_FLOOR_HEIGHT = 120;
const POPOVER_GAP = 8;
const POPOVER_CAP = { add: 360, assert: 420 } as const;

/** Two things said in the live region at once: a sentence that ends is followed by a space, else the separator. */
function joinStatus(first: string, second: string, separator: string): string {
  if (first === "") {
    return second;
  }
  return /[.!?。]$/.test(first) ? `${first} ${second}` : `${first}${separator}${second}`;
}

/** The 1-based line of the scenario's `test "…"` header, or `undefined` for a text without one. */
function headerLineOf(text: string): number | undefined {
  const at = text.split(/\r\n|\n|\r/).findIndex((line) => /^\s*test\s/i.test(line));
  return at < 0 ? undefined : at + 1;
}

/** The smallest `test-<n>` not among `ids` (no randomness, no clock). */
function nextIdOf(ids: readonly string[]): string {
  const taken = new Set(ids);
  let n = 1;
  while (taken.has(`test-${n}`)) {
    n += 1;
  }
  return `test-${n}`;
}

/** The scenario's `test "<from>"` header renamed to `to`; a header written otherwise is left as it is. */
function renameHeader(source: string, from: string, to: string): string {
  const header = `test ${testsStringLiteral(from)}`;
  const at = source.indexOf(header);
  return at < 0 ? source : `${source.slice(0, at)}test ${testsStringLiteral(to)}${source.slice(at + header.length)}`;
}

function readRunAsIEdit(): boolean {
  try {
    return globalThis.localStorage?.getItem(TESTS_RUN_AS_I_EDIT_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeRunAsIEdit(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(TESTS_RUN_AS_I_EDIT_KEY, on ? "true" : "false");
  } catch {
    /* no storage: the switch holds for this page only */
  }
}


/** The editor view's working copy: the entry it edits (none for a New test not yet applied) and the text in the box. */
interface Working {
  /** The entry's id; `undefined` for a New test until Apply gives it one. */
  id: string | undefined;
  /** The text a New test was seeded with: unchanged, closing it asks nothing. */
  seed?: string;
  text: string;
  /** The text's own parse: its problems (words come later) and its scenario, for the name and the step count. */
  problems: FormTestProblem[];
  scenario: FormTestScenario | undefined;
  removeAsked: boolean;
}

interface Showing {
  entryId: string;
  scenario: FormTestScenario;
  index: number;
}

export class DatumBuilderTestsPanelElement extends BuilderPanelElement {
  private textLocaleValue: string | undefined;
  private textCatalogValue: BuilderTextCatalog | undefined;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private functionsSource: FormulaFunctionsSource | undefined;
  private dataSourcesSource: (() => DataSourceSet | undefined) | undefined;
  private showOnCanvasValue: ((showing: CanvasScenarioShowing | undefined) => void) | undefined;
  private referenceHrefValue = "docs/form-tests.md";

  /** How the CodeMirror editor is loaded; a test swaps in a rejecting loader to keep the textarea. */
  public testsEditorLoader: () => Promise<TestsEditorModule> = loadTestsEditor;

  private runner: TestsRunner | undefined;
  private entries: TestsEntryModel[] = [];
  /** The stored block as last parsed, to tell a change of `tests` from any other edit. */
  private testsKey = "";
  private results = new Map<string, FormTestScenarioResult>();
  private resultAt = new Map<string, number>();
  /** Results from before the last change of the form, shown dimmed until a run replaces them. */
  private stale = new Set<string>();
  private runningId: string | undefined;
  private lastSummary: TestsRunSummary | undefined;
  /** What the form was when the results were made, so a change that moved nothing reruns nothing. */
  private resultsKey: string | undefined;
  private runToken = 0;
  private inflight: Promise<void> | undefined;
  private runsStartedValue = 0;
  private runTimer: ReturnType<typeof setTimeout> | undefined;
  /** A run was due while the panel was hidden: it starts when the panel is shown. */
  private missedRun = false;
  private runAsIEdit = readRunAsIEdit();

  private filter = "";
  private working: Working | undefined;
  private editor: TestsEditor | undefined;
  private editorFailed = false;
  private parseTimer: ReturnType<typeof setTimeout> | undefined;
  /** The region markup the editor view last wrote, so an unchanged region is left alone (and keeps focus). */
  private regions = new Map<string, string>();
  /** The problems and marks the box was last given; a new box starts with none. */
  private boxKey: string | undefined;
  private addOpen = false;
  /**
   * The popovers already fitted since they opened (a fit may scroll the panel once, on opening, never
   * while the owner scrolls), and whether the scroll and resize listeners that keep them fitted are on.
   */
  private fitted = new Set<"add" | "assert">();
  private fitListening = false;
  /** Watches the scroller's own size (a dragged drawer, the Try it fold, a phone keyboard) where the window's resize does not fire. */
  private fitObserver: ResizeObserver | undefined;
  private fitObserved: Element | undefined;
  /**
   * A scroll of the popover itself or of the editor's CodeMirror scroller moves neither the popover's top nor the scroller's
   * bottom, so it is not worth four forced layouts per event; the panel's own scroller (and the page) is what matters.
   */
  private readonly onFitEvent = (event?: Event): void => {
    const target = event?.target as Element | null | undefined;
    if (target?.closest?.(".tests-add-pop, .tests-assert-pop, .tests-editor-slot")) {
      return;
    }
    this.fitOpenPopovers();
  };
  private readonly onFitResize = (): void => this.fitOpenPopovers();
  private addField: string | undefined;
  private closeAsked = false;
  private showing: Showing | undefined;
  /** What the canvas was last handed, so a step that cannot be replayed says so over the state still shown. */
  private lastShown: CanvasScenarioShowing | undefined;
  /** Moved by every Show me request and by anything that ends a showing: a replay that lands after either is dropped. */
  private showToken = 0;
  /** The step a replay in flight is for, so a second Step forward builds on it rather than on the step still shown. */
  private stepTarget: number | undefined;
  private statusText = "";
  /** The status line a showing put up, so ending the showing takes back that line only. */
  private showingStatus: string | undefined;
  /** What the form was when the run in flight started: a still moment on the same form does not restart it. */
  private runningKey: string | undefined;
  /** The form's names for the words, built once per change of the form rather than once per keystroke. */
  private wordsCache: TestsWords | undefined;
  /** The box's scenario's lints, kept while the scenario and the words (made again on each change of the form) are the same. */
  private lintsCache: { scenario: FormTestScenario; words: TestsWords; lints: FormTestLint[] } | undefined;
  private openRuleAvailableValue = true;

  /** Takes the panel's leave guard off the controller's stack (stacked, so Logic's slot is left alone). */
  private releaseGuard: (() => void) | undefined;
  private bound = false;

  // Record, Assert this, the Untested view, Write a test.
  private recordOnCanvasValue: ((listener: TestsRecordListener) => () => void) | undefined;
  private assertSnapshotValue: (() => TestsAssertSnapshot | undefined) | undefined;
  private assertReadyValue: (() => boolean) | undefined;
  private recordingState: Recording | undefined;
  /** The tried form before and after the last recorded event, so Assert this knows what that event changed. */
  private snapshotBefore: TestsAssertSnapshot | undefined;
  private snapshotAfter: TestsAssertSnapshot | undefined;
  /**
   * The path the last recorded event named, when its before-state could not be had (the first
   * event of a recording whose canvas had no snapshot at the start): Assert this ticks it, since
   * the two snapshots cannot say what that event moved.
   */
  private unseenPath: string | undefined;
  private assertState: AssertState | undefined;
  /** Which view the list's place shows: the scenarios, or the rules and the tests that pin them. */
  private listView: "list" | "untested" = "list";
  /** The rules and their pins, worked out once per change of the block or the tree (as the words are). */
  private coverageCache: TestsUntestedView | undefined;
  private namingCache: TestsNaming | undefined;
  /** An entry asked for while the open one held an unapplied edit: opened once the prompt is answered. */
  private pendingOpen: string | undefined;
  /** A restored panel's first opening runs nothing (a page load never runs a suite by itself). */
  private skipOpeningRun = false;

  // --- properties the shell feeds ---------------------------------------------------------------

  public override set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.detachController();
    this.suspendPaints();
    try {
      super.controller = value;
      this.attachController();
    } finally {
      this.resumePaints();
    }
  }

  public override get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  /** The whole definition the shell lends (journeys, layouts, localization); the runner swaps in the committed tree. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
  }

  public get definition(): (() => FormDefinition | undefined) | undefined {
    return this.definitionSource;
  }

  /** The host's plugin functions: their signatures parse, their evaluators run. */
  public set formulaFunctions(value: FormulaFunctionsSource | undefined) {
    if (value === this.functionsSource) {
      return;
    }
    this.functionsSource = value;
    // The signatures decide what an `expect <formula>` may call, so the block reads anew.
    this.testsKey = "";
    this.reparse();
    this.paint();
  }

  public get formulaFunctions(): FormulaFunctionsSource | undefined {
    return this.functionsSource;
  }

  public set dataSources(value: (() => DataSourceSet | undefined) | undefined) {
    this.dataSourcesSource = value;
  }

  public get dataSources(): (() => DataSourceSet | undefined) | undefined {
    return this.dataSourcesSource;
  }

  /** Hands a step to the canvas (Show me); `undefined` ends the showing. */
  public set showOnCanvas(value: ((showing: CanvasScenarioShowing | undefined) => void) | undefined) {
    // The shell hands a fresh function on every re-wiring, so only gaining or losing one repaints; a
    // showing in progress is not ended by it (Show me itself turns Try it on, which re-wires).
    const had = this.showOnCanvasValue !== undefined;
    this.showOnCanvasValue = value;
    if (had !== (value !== undefined)) {
      // Show me is offered only while a canvas takes the step (a shell without Try it leaves this unset).
      this.regions.delete("failure");
      this.paint();
    }
  }

  public get showOnCanvas(): ((showing: CanvasScenarioShowing | undefined) => void) | undefined {
    return this.showOnCanvasValue;
  }

  /** Whether Open rule has a Logic workspace to go to; a shell with the `logic` feature off sets it false, so no dead button is drawn. */
  public set openRuleAvailable(value: boolean) {
    if (value === this.openRuleAvailableValue) {
      return;
    }
    this.openRuleAvailableValue = value;
    this.regions.delete("failure");
    this.paint();
  }

  public get openRuleAvailable(): boolean {
    return this.openRuleAvailableValue;
  }

  /**
   * The canvas's Record: the shell hands `canvas.recordTry` while the `try-it`
   * feature is on, else `undefined`, and Record is offered only while it is set. A fresh function
   * on a re-wiring changes nothing; losing it ends a recording in progress.
   */
  public set recordOnCanvas(value: ((listener: TestsRecordListener) => () => void) | undefined) {
    const had = this.recordOnCanvasValue !== undefined;
    this.recordOnCanvasValue = value;
    if (value === undefined) {
      this.endRecording(true);
    }
    if (had !== (value !== undefined)) {
      this.paint();
    }
  }

  public get recordOnCanvas(): ((listener: TestsRecordListener) => () => void) | undefined {
    return this.recordOnCanvasValue;
  }

  /** The tried form's state for Assert this (`canvas.assertSnapshot`); `undefined` returned while Try it is off. */
  public set assertSnapshot(value: (() => TestsAssertSnapshot | undefined) | undefined) {
    const had = this.assertSnapshotValue !== undefined;
    this.assertSnapshotValue = value;
    if (value === undefined) {
      this.assertState = undefined;
    }
    if (had !== (value !== undefined)) {
      this.paint();
    }
  }

  public get assertSnapshot(): (() => TestsAssertSnapshot | undefined) | undefined {
    return this.assertSnapshotValue;
  }

  /**
   * Whether {@link assertSnapshot} would give a form now (`canvas.assertReady`), lent by the shell
   * beside it: a paint asks whether to offer Assert this, and building a snapshot to find out is
   * every field's state each time. Absent, the panel asks the snapshot as before.
   */
  public set assertReady(value: (() => boolean) | undefined) {
    this.assertReadyValue = value;
  }

  public get assertReady(): (() => boolean) | undefined {
    return this.assertReadyValue;
  }

  /**
   * The canvas's Try it chunk arrived after Record started (`canvas-record-change` with `ready`):
   * nothing has been recorded yet, so the form now is the form before the first step, and that
   * step can be told apart from what it moved. Takes the recording's first
   * snapshot, and with it the `given today` lead line; a recording already started is left as it is.
   */
  public recordingReady(): void {
    const state = this.recordingState;
    if (!state || state.started || state.ending) {
      return;
    }
    const start = this.assertSnapshotValue?.();
    if (start === undefined) {
      return;
    }
    this.snapshotBefore = undefined;
    this.snapshotAfter = start;
    this.leadWithToday(state, start);
    this.paint();
  }

  /**
   * Set by the shell on a panel it puts back open at load (persist-panels): the first run that
   * opening would start is skipped, so a page load never runs a suite by itself; Run all or the
   * first edit runs it.
   */
  public set restored(value: boolean) {
    this.skipOpeningRun = value;
  }

  public get restored(): boolean {
    return this.skipOpeningRun;
  }

  /** Whether the panel is writing what the author does in Try it into the open test. */
  public get recording(): boolean {
    return this.recordingState !== undefined;
  }

  /**
   * Ends the recording, as the panel's own Stop does. For the shell when the canvas ended it
   * from its side (`canvas-record-change`: the bar's Stop recording, a Clear, Back to editing).
   * The panel does not probe the canvas on a paint: its snapshot sends what the canvas holds
   * back, so a paint while the author types would write a half-typed answer.
   */
  public stopRecording(): void {
    this.endRecording(true);
    this.paint();
  }

  /** Opens the editor on an entry (the Logic editor's "Pinned by" buttons); an unknown id does nothing. */
  public openEntry(id: string): void {
    this.reparse();
    if (!this.entries.some((entry) => entry.id === id)) {
      return;
    }
    this.listView = "list";
    if (this.working?.id === id) {
      this.paint();
      this.editor?.focus();
      return;
    }
    if (this.working && this.dirty) {
      // The open test's edit is not dropped: the panel's Close prompt asks first, then opens this one.
      this.pendingOpen = id;
      this.closeAsked = true;
      this.paint();
      return;
    }
    if (this.working) {
      this.endShowing();
      this.closeEditor();
      this.forgetMarkup();
    }
    this.open(id);
  }

  /**
   * Write a test: the scaffold for one Logic rule appended to the
   * block through one `setTests` (one undo step), the first opened in the editor. Run as I edit
   * runs it on the change that write announces; with the switch off it waits for Run all.
   */
  public writeTestFor(ruleId: string): void {
    const controller = this.ctrl;
    if (!controller || !this.runner) {
      return;
    }
    this.reparse();
    const root = controller.snapshot();
    const definition = this.wholeDefinition(root);
    const text = this.textOptions();
    const rule = buildLogicModel(root, { definition, ...(text.locale !== undefined ? { locale: text.locale } : {}), ...(text.catalog !== undefined ? { catalog: text.catalog } : {}) }).rules.find(
      (candidate) => candidate.id === ruleId
    );
    if (!rule) {
      return;
    }
    const scaffold = scaffoldTestsForRule(rule, root, definition, this.naming(), this.signatures(), text);
    if (scaffold.entries.length === 0) {
      this.statusText = scaffold.note ?? this.text("tests.panel.write.none");
      this.paint();
      return;
    }
    const scenarios = this.entries.map((entry) => ({ id: entry.id, source: entry.source }));
    const taken = new Set(this.entries.map((entry) => entry.name));
    const ids: string[] = [];
    for (const entry of scaffold.entries) {
      const name = this.freeName(entry.name, taken);
      taken.add(name);
      const source = name === entry.name ? entry.source : renameHeader(entry.source, entry.name, name);
      const id = nextIdOf(scenarios.map((scenario) => scenario.id));
      scenarios.push({ id, source });
      ids.push(id);
    }
    const said = scaffold.note ?? builderPlural("tests.panel.write.done", ids.length, undefined, text);
    controller.setTests({ scenarios });
    this.reparse();
    this.openEntry(ids[0]!);
    // Opening cleared the live region; what was written is said once it is open.
    this.statusText = said;
    this.paint();
  }

  /** Where "Reference" goes; absent, the repository's `docs/form-tests.md`. */
  public set referenceHref(value: string | undefined) {
    this.referenceHrefValue = value ?? "docs/form-tests.md";
    this.regions.clear();
    this.paint();
  }

  public get referenceHref(): string {
    return this.referenceHrefValue;
  }

  public set textLocale(value: string | undefined) {
    this.textLocaleValue = value;
    this.forgetWords();
    this.regions.clear();
    this.paint();
  }

  public get textLocale(): string | undefined {
    return this.textLocaleValue;
  }

  public set textCatalog(value: BuilderTextCatalog | undefined) {
    this.textCatalogValue = value;
    this.forgetWords();
    this.regions.clear();
    this.paint();
  }

  public get textCatalog(): BuilderTextCatalog | undefined {
    return this.textCatalogValue;
  }

  /** Reads the block again and repaints, for a host that changed something the panel cannot hear. */
  public refresh(): void {
    this.testsKey = "";
    this.forgetWords();
    this.reparseFollowing();
    this.regions.clear();
    this.forgetMarkup();
    // A host's own `tests` set is a change of the suite too: Run as I edit runs it.
    this.scheduleRun();
    this.paint();
  }

  /** Resolves once no run is in flight (for tests and hosts that wait on the suite). */
  public async whenIdle(): Promise<void> {
    while (this.inflight) {
      const current = this.inflight;
      await current;
      if (this.inflight === current) {
        this.inflight = undefined;
      }
    }
  }

  /** How many runs the panel has started, Run all and Run as I edit alike. */
  public get runsStarted(): number {
    return this.runsStartedValue;
  }

  /** The entries as the list shows them, each with its status, for a host or a test. */
  public get entriesShown(): TestsEntryModel[] {
    return this.entries.map((entry) => this.shown(entry));
  }

  /** Whether the editor holds text that Apply has not written. */
  public get dirty(): boolean {
    const working = this.working;
    if (!working) {
      return false;
    }
    if (working.id === undefined) {
      return working.text !== working.seed;
    }
    return working.text !== this.storedSource(working.id);
  }

  // --- the controller -----------------------------------------------------------------------------

  private attachController(): void {
    const controller = this.ctrl;
    this.entries = [];
    this.testsKey = "";
    this.results.clear();
    this.resultAt.clear();
    this.stale.clear();
    this.lastSummary = undefined;
    this.resultsKey = undefined;
    this.working = undefined;
    this.listView = "list";
    this.snapshotBefore = undefined;
    this.snapshotAfter = undefined;
    this.unseenPath = undefined;
    this.forgetWords();
    if (!controller) {
      this.runner = undefined;
      return;
    }
    this.runner = createTestsRunner({
      definition: () => this.definitionSource?.(),
      root: () => controller.snapshot(),
      functions: () => this.functionsSource?.functions?.(),
      signatures: () => this.functionsSource?.signatures(),
      dataSources: () => this.dataSourcesSource?.()
    });
    this.reparse();
    // The first run of a form is a run as I edit too: due now, made when the panel is shown.
    this.scheduleRun();
  }

  private detachController(): void {
    this.cancelTimers();
    this.cancelRun();
    this.endShowing();
    this.closeEditor();
  }

  /** Ends the run in flight: its progress and its outcome are a superseded run's from here. */
  private cancelRun(): void {
    this.runner?.cancel();
    this.runToken += 1;
    this.runningId = undefined;
    this.runningKey = undefined;
  }

  protected override onControllerChange(reason: BuilderChangeReason, event?: BuilderChangeEvent): void {
    if (reason === "preview") {
      return;
    }
    if (reason === "select") {
      // A prompt raised or answered (the controller announces both as a selection change).
      if (this.working) {
        // The prompt for this panel's edit is drawn here: a closed panel asks the shell to open it.
        if (this.hidden && this.ctrl?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
          this.dispatchEvent(new CustomEvent("builder-tests-reveal", { bubbles: true, composed: true }));
        }
        this.paint();
      }
      return;
    }
    if (event?.live) {
      return;
    }
    this.forgetWords();
    if (reason !== "init") {
      // An edit is what the restored panel waits for: from here the suite runs as it always does.
      this.skipOpeningRun = false;
    }
    if (reason === "init") {
      // A different form: what the last one's tests made of it is not this one's.
      this.results.clear();
      this.resultAt.clear();
      this.stale.clear();
      this.lastSummary = undefined;
      this.resultsKey = undefined;
      this.closeEditor();
    }
    this.endShowing();
    this.reparseFollowing();
    this.scheduleRun();
    this.paint();
  }

  protected override onSelectionChange(): void {}

  protected override onIconsChange(): void {}

  public override attributeChangedCallback(name: string): void {
    // Hiding is not ending a showing: Show me turns Try it on, which takes the side column away; the
    // shell ends the showing when the author closes the panel (its `setPanel`), and so does Close here.
    const shown = name === "hidden" && !this.hidden;
    if (shown && this.missedRun && this.runAsIEdit) {
      this.missedRun = false;
      if (this.skipOpeningRun) {
        // The panel put back open at load: its opening runs nothing; Run all or an edit does.
        this.skipOpeningRun = false;
      } else {
        this.startRun();
      }
    }
    super.attributeChangedCallback(name);
    if (shown) {
      // "Ran 2 min ago" is worked out at paint and nothing keeps it fresh while closed: opening says it as it is now.
      this.forgetWords();
      this.paint();
    }
  }

  public override connectedCallback(): void {
    this.bind();
    // A working copy kept across a move in the page holds the leave prompt again.
    if (this.working) {
      this.attachGuard();
    }
    super.connectedCallback();
    // What a run cut short at the disconnect would have found, the next still moment finds.
    if (this.ctrl) {
      this.scheduleRun();
    }
  }

  public override disconnectedCallback(): void {
    this.cancelTimers();
    // A detached panel neither runs nor paints: the run in flight is a superseded one.
    this.cancelRun();
    this.endShowing();
    this.endRecording(true);
    this.assertState = undefined;
    this.stopPopoverFit();
    this.dropGuard();
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  private cancelTimers(): void {
    if (this.runTimer !== undefined) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
    if (this.parseTimer !== undefined) {
      clearTimeout(this.parseTimer);
      this.parseTimer = undefined;
    }
  }

  // --- the block and its entries --------------------------------------------------------------------

  private tests(): FormTestConfiguration | undefined {
    return this.ctrl?.tests();
  }

  private storedSource(id: string): string | undefined {
    return this.entries.find((entry) => entry.id === id)?.source;
  }

  /** Parses the stored block when it changed; drops what belonged to entries that are gone; tells the strip. */
  private reparse(): void {
    const runner = this.runner;
    if (!runner) {
      return;
    }
    const tests = this.tests();
    const key = JSON.stringify(tests ?? null);
    if (key === this.testsKey) {
      return;
    }
    this.testsKey = key;
    const before = new Map(this.entries.map((entry) => [entry.id, entry.source]));
    this.entries = runner.parse(tests);
    // The pins are the entries': a different block pins differently.
    this.coverageCache = undefined;
    // A result is about the source it ran: an entry whose text changed keeps it, dimmed, until the next run.
    for (const entry of this.entries) {
      const was = before.get(entry.id);
      if (was !== undefined && was !== entry.source && this.results.has(entry.id)) {
        this.stale.add(entry.id);
      }
    }
    const ids = new Set(this.entries.map((entry) => entry.id));
    for (const id of [...this.results.keys()]) {
      const entry = this.entries.find((candidate) => candidate.id === id);
      // A result says nothing about a scenario whose source is gone or no longer parses.
      if (!ids.has(id) || entry?.scenario === undefined) {
        this.results.delete(id);
        this.resultAt.delete(id);
        this.stale.delete(id);
      }
    }
    this.dispatchStatus();
  }

  /** An entry with its status as the list shows it (invalid first, then running, stale, the result). */
  private shown(entry: TestsEntryModel): TestsEntryModel {
    const result = this.results.get(entry.id);
    let status: TestsEntryStatus;
    if (entry.status === "invalid") {
      status = "invalid";
    } else if (this.runningId === entry.id) {
      status = "running";
    } else if (result !== undefined) {
      status = this.stale.has(entry.id) ? "stale" : result.status;
    } else {
      status = "unrun";
    }
    return { ...entry, status, ...(result !== undefined ? { result } : {}) };
  }

  /** The counts the summary line and the strip's badge read; a stale result still counts as what it was. */
  private summary(): TestsRunSummary {
    const out: TestsRunSummary = { total: this.entries.length, passed: 0, failed: 0, skipped: 0, error: 0, invalid: 0 };
    for (const entry of this.entries) {
      if (entry.status === "invalid") {
        out.invalid += 1;
        continue;
      }
      const result = this.results.get(entry.id);
      if (result !== undefined) {
        out[result.status] += 1;
      }
    }
    if (this.lastSummary?.ranAt !== undefined) {
      out.ranAt = this.lastSummary.ranAt;
      if (this.lastSummary.durationMs !== undefined) {
        out.durationMs = this.lastSummary.durationMs;
      }
    }
    return out;
  }

  private dispatchStatus(): void {
    const summary = this.summary();
    this.dispatchEvent(
      new CustomEvent<BuilderTestsStatusDetail>("builder-tests-status", {
        detail: { summary, failed: summary.failed + summary.error + summary.invalid },
        bubbles: true,
        composed: true
      })
    );
  }

  // --- runs -----------------------------------------------------------------------------------------

  /** What the form is now, as a run reads it: the committed tree, the block, and the rest of the definition. */
  private formKey(): string {
    const whole = this.definitionSource?.();
    let rest: Record<string, unknown> | null = null;
    if (whole !== undefined) {
      const { root: _root, tests: _tests, ...others } = whole as FormDefinition & Record<string, unknown>;
      rest = others;
    }
    return JSON.stringify([this.ctrl?.snapshot() ?? null, this.tests() ?? null, rest]);
  }

  private scheduleRun(): void {
    if (this.runTimer !== undefined) {
      clearTimeout(this.runTimer);
    }
    this.runTimer = setTimeout(() => {
      this.runTimer = undefined;
      this.settled();
    }, RUN_DEBOUNCE_MS);
  }

  /** The form has been still for the debounce: results from another form go stale, and Run as I edit reruns. */
  private settled(): void {
    if (!this.ctrl) {
      return;
    }
    const key = this.formKey();
    if (key === this.resultsKey && this.runningId === undefined) {
      return;
    }
    // A draft's keystrokes announce edits that move nothing a run reads: the run already going on this form carries on.
    if (this.runningKey !== undefined && key === this.runningKey) {
      return;
    }
    for (const id of this.results.keys()) {
      this.stale.add(id);
    }
    if (!this.runAsIEdit) {
      this.paint();
      return;
    }
    if (this.hidden) {
      this.missedRun = true;
      return;
    }
    if (this.skipOpeningRun) {
      this.skipOpeningRun = false;
      return;
    }
    this.startRun();
  }

  /** Runs every entry that has a scenario, painting each dot as its result lands; a newer run cancels this one. */
  private startRun(): void {
    const runner = this.runner;
    if (!runner || !this.ctrl) {
      return;
    }
    if (this.runTimer !== undefined) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
    this.missedRun = false;
    this.skipOpeningRun = false;
    // A new run ends a showing: the canvas would show a state the new results may not hold.
    this.endShowing();
    // A recording carries on: the run replays the committed entries in
    // the runner's own runtimes and never touches the canvas, and the recorded lines sit in the
    // working copy. Ending it here cut every recording short at the form's opening run.
    this.runToken += 1;
    this.runsStartedValue += 1;
    const token = this.runToken;
    const entries = this.entries;
    const key = this.formKey();
    const runnable = entries.filter((entry) => entry.scenario !== undefined);
    this.runningId = runnable[0]?.id;
    this.runningKey = key;
    this.forgetWords();
    this.paint();
    const run = runner
      .run(entries, {
        onProgress: (entry, result) => {
          if (token !== this.runToken) {
            return;
          }
          this.results.set(entry.id, result);
          this.resultAt.set(entry.id, Date.now());
          this.stale.delete(entry.id);
          const at = runnable.findIndex((candidate) => candidate.id === entry.id);
          this.runningId = runnable[at + 1]?.id;
          this.paint();
        }
      })
      .then(
        (outcome) => {
          if (token !== this.runToken) {
            return;
          }
          this.runningId = undefined;
          this.runningKey = undefined;
          if (!outcome.cancelled) {
            this.lastSummary = outcome.summary;
            this.resultsKey = key;
            // The run's outcome is said in the live region, the summary line's own words.
            this.statusText = this.summaryLine();
          }
          this.dispatchStatus();
          this.paint();
        },
        () => {
          if (token === this.runToken) {
            this.runningId = undefined;
            this.runningKey = undefined;
            this.paint();
          }
        }
      );
    this.inflight = run;
  }

  private setRunAsIEdit(on: boolean): void {
    this.runAsIEdit = on;
    writeRunAsIEdit(on);
    if (!on) {
      if (this.runTimer !== undefined) {
        clearTimeout(this.runTimer);
        this.runTimer = undefined;
      }
      this.missedRun = false;
    }
    this.paint();
  }

  // --- words --------------------------------------------------------------------------------------

  private textOptions(): BuilderTextOptions {
    return { ...(this.textLocaleValue ? { locale: this.textLocaleValue } : {}), ...(this.textCatalogValue ? { catalog: this.textCatalogValue } : {}) };
  }

  private text(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return builderText(key, params, this.textOptions());
  }

  /**
   * The words, with the form's names. Naming clones the tree and composes the host's whole
   * definition, so it is built once per change of the form (and of the words, a run, an opening)
   * rather than on every keystroke's repaint.
   */
  private words(): TestsWords {
    if (this.wordsCache) {
      return this.wordsCache;
    }
    const words = createTestsWords({ naming: this.naming(), text: this.textOptions() });
    this.wordsCache = words;
    return words;
  }

  /** The form's names (labels, page titles), kept as long as the words are. */
  private naming(): TestsNaming {
    if (this.namingCache) {
      return this.namingCache;
    }
    const controller = this.ctrl;
    const naming = createTestsNaming(controller ? controller.snapshot() : { id: "root", type: "form", configuration: {} }, this.definitionSource?.());
    this.namingCache = naming;
    return naming;
  }

  /**
   * Forgets what was worked out from the form (the words and names, the rules and their pins):
   * the next paint works them out again from the form as it is.
   */
  private forgetWords(): void {
    this.namingCache = undefined;
    this.wordsCache = void 0;
    this.coverageCache = undefined;
  }

  /** The whole definition with the committed tree, as the runner reads it; a shell with no source lends the tree alone. */
  private wholeDefinition(root: ComponentNode): FormDefinition {
    const whole = this.definitionSource?.();
    return whole !== undefined ? { ...whole, root } : { id: "form", version: "1", schemaVersion: "1", root };
  }

  /** The built-in functions and the host's, as the runner parses with them. */
  private signatures(): FormulaFunctionSignature[] {
    return [...formulaFunctionSignatures(), ...(this.functionsSource?.signatures() ?? [])];
  }

  /** The rules and the tests that pin them (the Untested view and the list's foot line); `undefined` without a form. */
  private coverage(): TestsUntestedView | undefined {
    if (this.coverageCache) {
      return this.coverageCache;
    }
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    const root = controller.snapshot();
    try {
      // The rules' sentences in the builder's language, as the Logic workspace words them.
      this.coverageCache = untestedRules(root, this.wholeDefinition(root), this.entries, this.signatures(), this.textOptions());
    } catch {
      // A form the Logic model cannot read lists no rules rather than breaking the panel.
      this.coverageCache = { rules: [], pins: new Map(), tested: 0, untested: 0 };
    }
    return this.coverageCache;
  }

  /** "Ran 2 s ago" (or the editor's lower-case "ran 2 s ago"), worked out at paint: no timers keep it fresh. */
  private ranText(at: number, lower: boolean): string {
    const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (seconds < 5) {
      return this.text(lower ? "tests.panel.editor.ran.now" : "tests.panel.ran.now");
    }
    if (seconds < 60) {
      return this.text(lower ? "tests.panel.editor.ran.seconds" : "tests.panel.ran.seconds", { n: seconds });
    }
    if (seconds < 3600) {
      return this.text(lower ? "tests.panel.editor.ran.minutes" : "tests.panel.ran.minutes", { n: Math.floor(seconds / 60) });
    }
    return this.text(lower ? "tests.panel.editor.ran.hours" : "tests.panel.ran.hours", { n: Math.floor(seconds / 3600) });
  }

  private summaryLine(): string {
    if (this.runningId !== undefined) {
      return this.text("tests.panel.running");
    }
    const summary = this.summary();
    if (summary.ranAt === undefined) {
      return this.text("tests.panel.notRun");
    }
    const counts: string[] = [];
    if (summary.passed > 0) {
      counts.push(this.text("tests.panel.counts.passed", { n: summary.passed }));
    }
    if (summary.failed > 0) {
      counts.push(this.text("tests.panel.counts.failed", { n: summary.failed }));
    }
    if (summary.skipped > 0) {
      counts.push(this.text("tests.panel.counts.skipped", { n: summary.skipped }));
    }
    if (summary.error > 0) {
      counts.push(this.text("tests.panel.counts.error", { n: summary.error }));
    }
    if (summary.invalid > 0) {
      counts.push(builderPlural("tests.panel.counts.invalid", summary.invalid, undefined, this.textOptions()));
    }
    const list = counts.length > 0 ? counts.join(this.text("tests.panel.counts.sep")) : this.text("tests.panel.counts.none");
    return this.text("tests.panel.summary", { ran: this.ranText(summary.ranAt, false), counts: list });
  }

  // --- paint ----------------------------------------------------------------------------------------

  protected render(): void {
    if (!this.ctrl) {
      this.regions.clear();
      this.writeMarkup(`<style>${builderTokens()}</style><div class="panel card-stack"><div class="card empty-state"><p>${esc(this.text("shell.noController"))}</p></div></div>`);
      return;
    }
    const view = this.viewHost();
    if (this.working) {
      this.renderEditor(view, this.working);
    } else if (this.listView === "untested") {
      this.renderUntested(view);
    } else {
      this.renderList(view);
    }
    this.syncStatus();
  }

  /**
   * The panel's frame, written once: the view in it is rewritten when the list and the editor
   * take turns, while the live region beside it stays the same node. A status put into a region
   * that was inserted a moment before is not read out, so "Removed test X" and a run's outcome
   * need the region to outlive the view.
   */
  private viewHost(): HTMLElement {
    const existing = this.root.querySelector<HTMLElement>(".panel--tests > [data-tests-view]");
    if (existing) {
      return existing;
    }
    this.regions.clear();
    this.editor?.destroy();
    this.editor = undefined;
    this.writeMarkup(`${this.styles()}
      <div class="panel panel--tests card-stack">
        <div class="tests-view" data-tests-view=""></div>
        <div class="tests-status" role="status" aria-live="polite" data-tests-status></div>
      </div>`);
    // The frame moves on in place from here.
    this.forgetMarkup();
    return this.root.querySelector<HTMLElement>(".panel--tests > [data-tests-view]")!;
  }

  private syncStatus(): void {
    const status = this.root.querySelector<HTMLElement>("[data-tests-status]");
    if (status && status.textContent !== this.statusText) {
      status.textContent = this.statusText;
    }
  }

  private styles(): string {
    return `<style>${builderTokens()}${TESTS_PANEL_STYLES}${TESTS_TEXTAREA_STYLES}${TESTS_EDITOR_STYLES}${this.iconCss()}</style>`;
  }

  /** A stable handle on the focused control, so focus comes back to it after the markup is written again. */
  private focusKey(): string | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    for (const attribute of active.getAttributeNames()) {
      if (attribute.startsWith("data-tests-") || attribute.startsWith("data-unsaved-")) {
        const value = active.getAttribute(attribute) ?? "";
        return value === "" ? `[${attribute}]` : `[${attribute}="${value.replace(/["\\]/g, "\\$&")}"]`;
      }
    }
    return undefined;
  }

  private restoreFocus(key: string | undefined, caret?: [number | null, number | null]): void {
    if (key === undefined) {
      return;
    }
    const target = this.root.querySelector<HTMLElement>(key);
    if (!target || target === this.root.activeElement) {
      return;
    }
    target.focus();
    if (caret && target instanceof HTMLInputElement && caret[0] !== null && caret[1] !== null) {
      target.setSelectionRange(caret[0], caret[1]);
    }
  }

  /**
   * The list view, region by region: the head (Run all, the switch), the summary line, the
   * filter, the rows and the foot. A run's progress moves dots, so only the rows change then,
   * and a row whose id stays put is patched in place: a focused Run all or row button is never
   * replaced (and announced again) once per scenario.
   */
  private renderList(view: HTMLElement): void {
    if (view.getAttribute("data-tests-view") !== "list") {
      this.regions.clear();
      this.stopPopoverFit();
      this.editor?.destroy();
      this.editor = undefined;
      view.setAttribute("data-tests-view", "list");
      view.removeAttribute("data-tests-editing");
      view.innerHTML = `<div class="tests-in card-stack">
          <div class="card">
          <div data-tests-region="list-head"></div>
          <div data-tests-region="list-summary"></div>
          <div data-tests-region="list-filter"></div>
          </div>
          <div class="card" data-tests-region="list-rows"></div>
        </div>
        <div class="card" data-tests-region="list-foot"></div>`;
    }
    const words = this.words();
    const shown = this.entries.map((entry) => this.shown(entry));
    this.region(
      "list-head",
      `<h2 class="card-title tests-head">${esc(this.text("tests.panel.title"))}</h2>
          <div class="tests-row">
            <button type="button" class="btn small dark" data-tests-run-all>${PLAY_SVG}${esc(this.text("tests.panel.runAll"))}</button>
            <button type="button" class="tests-switch" role="switch" aria-checked="${this.runAsIEdit}" data-tests-run-as-i-edit><span class="track" aria-hidden="true"></span>${esc(this.text("tests.panel.runAsIEdit"))}</button>
          </div>`
    );
    this.region("list-summary", `<p class="tests-sub" data-tests-summary>${esc(this.summaryLine())}</p>`);
    // The filter's value is the box's own: it is not in the markup, so typing in it rewrites nothing.
    if (
      this.region(
        "list-filter",
        shown.length === 0
          ? ""
          : `<input class="tests-filter" type="search" data-tests-filter placeholder="${esc(this.text("tests.panel.filter.placeholder"))}" aria-label="${esc(this.text("tests.panel.filter.label"))}" />`
      )
    ) {
      const filter = this.root.querySelector<HTMLInputElement>("[data-tests-filter]");
      if (filter && filter.value !== this.filter) {
        filter.value = this.filter;
      }
    }
    this.listRows(shown, words);
    const recordNew = this.recordOnCanvasValue ? `<button type="button" class="btn small" data-tests-record-new>${REC_SVG}${esc(this.text("tests.panel.record.new"))}</button>` : "";
    this.region(
      "list-foot",
      `${this.untestedLineHtml()}<div class="tests-foot tests-foot--end">${recordNew}<button type="button" class="btn small primary" data-tests-new>${esc(this.text("tests.panel.new"))}</button></div>`
    );
    this.applyFilter();
  }

  private rowHtml(entry: TestsEntryModel, words: TestsWords): string {
    const tone = toneOf(entry.status);
    const summaryTone = entry.status === "failed" || entry.status === "error" || entry.status === "invalid" ? "bad" : entry.status === "skipped" ? "warn" : "";
    return `<li data-tests-row="${esc(entry.id)}"><button type="button" class="tests-entry" data-tests-entry="${esc(entry.id)}" data-status="${entry.status}"${entry.status === "stale" ? " data-stale" : ""}>
            <span class="d" data-tone="${tone}" role="img" aria-label="${esc(words.status(entry.status))}"></span>
            <span class="tests-entry-text"><span class="tests-entry-name">${esc(this.entryName(entry))}</span><span class="tests-entry-summary"${summaryTone ? ` data-tone="${summaryTone}"` : ""}>${esc(words.summary(entry))}</span></span>
          </button></li>`;
  }

  /** An entry's name as the list shows it: an entry nothing names is "Untitled" in the catalog's words. */
  private entryName(entry: TestsEntryModel): string {
    return entry.name !== "" ? entry.name : this.text("tests.panel.untitled");
  }

  /** The rows: patched in place while the same entries stand in the same order, written whole otherwise. */
  private listRows(shown: TestsEntryModel[], words: TestsWords): void {
    const markup =
      shown.length === 0
        ? `<div class="empty-state" data-tests-empty><p>${esc(this.text("tests.panel.empty"))}</p></div>`
        : `<ul class="tests-list" role="list" aria-label="${esc(this.text("tests.panel.list.label"))}" data-tests-list>${shown.map((entry) => this.rowHtml(entry, words)).join("")}</ul>
          <p class="tests-empty" data-tests-none hidden>${esc(this.text("tests.panel.filter.none"))}</p>`;
    if (this.regions.get("list-rows") === markup) {
      return;
    }
    const rows = [...this.root.querySelectorAll<HTMLLIElement>("[data-tests-row]")];
    const same = this.regions.has("list-rows") && shown.length > 0 && rows.length === shown.length && rows.every((row, index) => row.getAttribute("data-tests-row") === shown[index]!.id);
    if (!same) {
      this.region("list-rows", markup);
      return;
    }
    const scratch = (this.ownerDocument ?? document).createElement("template");
    for (const [index, entry] of shown.entries()) {
      scratch.innerHTML = this.rowHtml(entry, words);
      const fresh = scratch.content.querySelector<HTMLElement>("[data-tests-entry]")!;
      const button = rows[index]!.querySelector<HTMLElement>("[data-tests-entry]")!;
      patchElement(button, fresh);
      const parts: Array<[string, (el: HTMLElement) => void]> = [
        [".d", (el) => patchElement(el, fresh.querySelector<HTMLElement>(".d")!)],
        [".tests-entry-name", (el) => patchText(el, fresh.querySelector<HTMLElement>(".tests-entry-name")!)],
        [".tests-entry-summary", (el) => patchText(el, fresh.querySelector<HTMLElement>(".tests-entry-summary")!)]
      ];
      for (const [selector, patch] of parts) {
        const el = button.querySelector<HTMLElement>(selector);
        if (el) {
          patch(el);
        }
      }
    }
    this.regions.set("list-rows", markup);
  }

  /** Shows the rows whose name holds the filter's text, case aside. */
  private applyFilter(): void {
    const needle = this.filter.trim().toLowerCase();
    let shown = 0;
    for (const row of this.root.querySelectorAll<HTMLLIElement>("[data-tests-row]")) {
      const name = row.querySelector(".tests-entry-name")?.textContent ?? "";
      const match = needle === "" || name.toLowerCase().includes(needle);
      row.hidden = !match;
      shown += match ? 1 : 0;
    }
    const none = this.root.querySelector<HTMLElement>("[data-tests-none]");
    if (none) {
      none.hidden = !(needle !== "" && shown === 0);
    }
  }

  // --- the editor view ------------------------------------------------------------------------------

  /** The entry the editor shows, with its status, when it is a stored one. */
  private workingEntry(working: Working): TestsEntryModel | undefined {
    if (working.id === undefined) {
      return undefined;
    }
    const entry = this.entries.find((candidate) => candidate.id === working.id);
    return entry ? this.shown(entry) : undefined;
  }

  private workingName(working: Working): string {
    const name = working.scenario?.name;
    return name !== undefined && name !== "" ? name : this.text("tests.panel.untitled");
  }

  /** The first step that failed or could not run, the one the card speaks about. */
  private failingStep(result: FormTestScenarioResult | undefined): FormTestStepResult | undefined {
    return result?.steps.find((step) => step.status === "failed" || step.status === "error");
  }

  private renderEditor(view: HTMLElement, working: Working): void {
    const handle = working.id ?? "";
    if (view.getAttribute("data-tests-view") !== "editor" || view.getAttribute("data-tests-editing") !== handle || !this.editor || !view.contains(this.editor.element)) {
      this.regions.clear();
      this.editor?.destroy();
      this.editor = undefined;
      view.setAttribute("data-tests-view", "editor");
      view.setAttribute("data-tests-editing", handle);
      view.innerHTML = `<div class="tests-in card-stack">
            <div class="card">
            <div data-tests-region="head"></div>
            <div class="tests-row tests-actions">
              <div class="tests-row" data-tests-region="record"></div>
              <div class="tests-add" data-tests-region="add"></div>
              <span class="tests-spacer"></span>
              <a class="link-btn" data-tests-reference href="${esc(this.referenceHrefValue)}" target="_blank" rel="noopener" title="${esc(this.text("tests.panel.reference.title"))}">${esc(this.text("tests.panel.reference"))}</a>
            </div>
            <div class="tests-assert" data-tests-region="assert"></div>
            <div data-tests-region="recording"></div>
            </div>
            <div class="card">
            <div class="tests-editor-slot" data-tests-editor-slot></div>
            <div data-tests-region="problems"></div>
            <div data-tests-region="failure"></div>
            <div data-tests-region="note"></div>
            </div>
          </div>
          <div class="card" data-tests-region="foot"></div>
          <div data-tests-region="prompt"></div>`;
      this.mountEditor(working);
    }
    this.updateRegions(working);
  }

  /** Writes a region when its markup changed, focus (and a text box's caret) kept; returns whether it wrote. */
  private region(name: string, markup: string): boolean {
    if (this.regions.get(name) === markup) {
      return false;
    }
    const host = this.root.querySelector<HTMLElement>(`[data-tests-region="${name}"]`);
    if (!host) {
      return false;
    }
    const inside = host.contains(this.root.activeElement);
    const focus = inside ? this.focusKey() : undefined;
    const active = inside ? (this.root.activeElement as HTMLInputElement | null) : null;
    const caret: [number | null, number | null] | undefined = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : undefined;
    // A rewritten popover is a fresh node with the style sheet's cap and no scroll: carry the fitted height and the list's scroll
    // over before focus returns, or focus() would scroll the panel to show a box the cap pushed out of view.
    const popover = ".tests-add-pop, .tests-assert-pop";
    const before = host.querySelector<HTMLElement>(popover);
    const kept = before ? { maxBlockSize: before.style.maxBlockSize, scrollTop: before.scrollTop } : undefined;
    this.regions.set(name, markup);
    host.innerHTML = markup;
    const after = kept ? host.querySelector<HTMLElement>(popover) : null;
    if (kept && after) {
      after.style.maxBlockSize = kept.maxBlockSize;
      after.scrollTop = kept.scrollTop;
    }
    this.restoreFocus(focus, caret);
    return true;
  }

  private updateRegions(working: Working): void {
    const words = this.words();
    const entry = this.workingEntry(working);
    const clean = !this.dirty;
    // Marks and the card speak about the text as it ran: an unapplied edit or a stale result has moved its lines.
    const result = clean && entry?.status !== "stale" ? entry?.result : undefined;
    const stepCount = working.scenario?.steps.length ?? 0;
    const statusWord = entry ? words.status(entry.status) : words.status("unrun");
    // A scenario that never ran says so once: the status word already is "Not run yet", so the "ran" part is left out.
    const ranAt = entry?.result !== undefined ? this.resultAt.get(entry.id) : undefined;
    const steps = builderPlural("tests.panel.editor.steps", stepCount, undefined, this.textOptions());
    const status =
      ranAt === undefined
        ? this.text("tests.panel.editor.statusUnrun", { status: statusWord, steps })
        : this.text("tests.panel.editor.status", { status: statusWord, ran: this.ranText(ranAt, true), steps });
    this.region(
      "head",
      `<h2 class="card-title tests-head tests-head--editor" data-tests-name>${esc(this.workingName(working))}</h2>
       <p class="tests-sub" data-tests-editor-status>${esc(status)}</p>`
    );
    this.region("record", this.recordHtml());
    this.region("add", this.addStepHtml());
    this.region("recording", this.recordingHtml());
    // The popover is a region of its own: ticking a field rewrites it, never the box (its search text is in its markup).
    this.region("assert", this.assertHtml());
    this.applyAssertSearch();
    this.syncPopoverFit();
    const problems = working.problems.map((problem) => ({ problem, message: words.problem(problem) }));
    // A set on a path the form stores nothing at is advice under the problems: the scenario still runs as written.
    const lints = this.lintsOf(working, words).map((lint) => ({ lint, message: words.lint(lint) }));
    this.region(
      "problems",
      problems.length === 0 && lints.length === 0
        ? ""
        : `<ul class="tests-problems" role="list" aria-label="${esc(this.text("tests.panel.problems.label"))}" data-tests-problems>${problems
            .map(
              ({ problem, message }) =>
                `<li><button type="button" class="tests-problem" data-tests-problem="${problem.line}" data-severity="${problem.code === "duplicateName" ? "warning" : "error"}" title="${esc(this.text("tests.panel.problem.go", { line: problem.line }))}">${esc(message)}</button></li>`
            )
            .join("")}${lints
            .map(
              ({ lint, message }) =>
                `<li><button type="button" class="tests-problem" data-tests-problem="${lint.line}" data-tests-lint="${esc(lint.code)}" data-severity="warning" title="${esc(this.text("tests.panel.problem.go", { line: lint.line }))}">${esc(message)}</button></li>`
            )
            .join("")}</ul>`
    );
    this.region("failure", this.failureHtml(working, entry, result, words));
    this.region("note", this.dirty ? `<p class="tests-note" data-tests-unapplied>${esc(this.text("tests.panel.editor.unapplied"))}</p>` : "");
    this.region("foot", this.footHtml(working));
    this.region("prompt", this.promptHtml(working));
    this.syncStatus();
    // The box hears its problems and marks only when they changed: a keystroke repaints the regions, not the box.
    const boxProblems = [...this.editorProblems(problems), ...lints.map(({ lint, message }) => ({ line: lint.line, start: lint.start, end: lint.end, message, severity: "warning" as const }))];
    const runMarks = clean ? this.marksOf(entry?.scenario, result, words) : [];
    // The line Show me has on the canvas is marked as such besides its status, until the showing ends.
    const shownLine = this.showing !== undefined && this.showing.entryId === working.id ? this.lastShown?.line : undefined;
    const marks = shownLine === undefined ? runMarks : runMarks.map((mark) => (mark.line === shownLine ? { ...mark, shown: true } : mark));
    const boxKey = JSON.stringify([boxProblems, marks]);
    if (this.editor && boxKey !== this.boxKey) {
      this.boxKey = boxKey;
      this.editor.setProblems(boxProblems);
      this.editor.setMarks(marks);
    }
    this.openPrompt();
  }

  /**
   * The lints of the scenario in the box against the form as it stands: worked out once per parse
   * and per change of the form (the words are made again on each), not on every keystroke's repaint.
   */
  private lintsOf(working: Working, words: TestsWords): FormTestLint[] {
    const scenario = working.scenario;
    const controller = this.ctrl;
    if (!scenario || !controller) {
      return [];
    }
    const cached = this.lintsCache;
    if (cached && cached.scenario === scenario && cached.words === words) {
      return cached.lints;
    }
    const lints = formTestLints([scenario], controller.snapshot());
    this.lintsCache = { scenario, words, lints };
    return lints;
  }

  private editorProblems(problems: Array<{ problem: FormTestProblem; message: string }>): TestsEditorProblem[] {
    return problems.map(({ problem, message }) => ({
      line: problem.line,
      start: problem.start,
      end: problem.end,
      message,
      severity: problem.code === "duplicateName" ? "warning" : "error"
    }));
  }

  /** Each step's line with what it came to; the lines after the first failure are pending; the header has no mark. */
  private marksOf(scenario: FormTestScenario | undefined, result: FormTestScenarioResult | undefined, words: TestsWords): TestsEditorMark[] {
    if (!scenario || !result) {
      return [];
    }
    const marks: TestsEditorMark[] = [];
    const byLine = new Map(result.steps.map((step) => [step.line, step]));
    let failed = false;
    for (const statement of scenario.steps) {
      const step = byLine.get(statement.line);
      if (failed || step === undefined) {
        marks.push({ line: statement.line, status: "pending" });
        continue;
      }
      const message = words.step(step, scenario);
      marks.push({ line: statement.line, status: step.status, ...(message !== "" ? { message } : {}) });
      if (step.status === "failed" || step.status === "error") {
        failed = true;
      }
    }
    return marks;
  }

  private failureHtml(working: Working, entry: TestsEntryModel | undefined, result: FormTestScenarioResult | undefined, words: TestsWords): string {
    const scenario = entry?.scenario;
    if (!entry || !result || !scenario) {
      return "";
    }
    const step = this.failingStep(result);
    if (!step) {
      // A scenario that did not run its steps (a bad given, the clock unset, a skip) says why.
      if (result.status === "error" || (result.status === "skipped" && result.steps.length === 0)) {
        return `<section class="note why" data-tone="${result.status === "error" ? "error" : "warning"}" data-tests-failure aria-label="${esc(this.text("tests.panel.failure.label"))}">
            <p class="wt">${WARN_SVG}<span>${esc(words.reason(result))}</span></p></section>`;
      }
      return "";
    }
    const sides = words.stepSides(step, scenario);
    const controller = this.ctrl;
    const rule = controller ? decidingRuleOf(controller.snapshot(), step) : undefined;
    const accept = working.id !== undefined ? acceptNewBehaviour(entry.source, scenario, step) : { refused: "action" as const };
    const offerAccept = "source" in accept;
    return `<section class="note why" data-tone="error" data-tests-failure aria-label="${esc(this.text("tests.panel.failure.label"))}">
        <p class="wt">${WARN_SVG}<span>${esc(this.text("tests.panel.failure.line", { line: step.line }))} · ${esc(words.step(step, scenario))}</span></p>
        ${
          sides
            ? `<dl class="kv"><dt>${esc(this.text("tests.panel.failure.expected"))}</dt><dd data-tests-expected>${esc(sides.expected)}</dd><dt>${esc(
                this.text("tests.panel.failure.browser")
              )}</dt><dd data-tests-actual>${esc(sides.actual)}</dd></dl>`
            : ""
        }
        <div class="tests-row">
          ${this.showOnCanvasValue ? `<button type="button" class="btn" data-tests-show>${esc(this.text("tests.panel.show"))}</button>` : ""}
          ${rule && this.openRuleAvailableValue ? `<button type="button" class="btn" data-tests-open-rule="${esc(rule.componentId)}" data-tests-rule-kind="${esc(rule.kind)}">${esc(this.text("tests.panel.openRule"))}</button>` : ""}
          ${offerAccept ? `<button type="button" class="btn ghost" data-tests-accept>${esc(this.text("tests.panel.accept"))}</button>` : ""}
        </div>
      </section>`;
  }

  private footHtml(working: Working): string {
    const applyDisabled = working.id !== undefined && !this.dirty;
    // Undo brings a removed test back, so Remove asks in place, as every such confirmation does.
    const asked = working.id !== undefined && working.removeAsked;
    const note = asked
      ? `<div class="note confirm" data-tone="warning" role="group" aria-label="${esc(this.text("tests.panel.remove"))}"><p>${esc(this.text("tests.panel.remove.confirm"))}</p><div class="confirm-actions"><button type="button" class="btn small" data-tests-remove-cancel>${esc(
          this.text("tests.panel.remove.cancel")
        )}</button><button type="button" class="btn small danger" data-tests-remove-confirm>${esc(this.text("tests.panel.remove"))}</button></div></div>`
      : "";
    const remove = working.id === undefined || asked ? "<span></span>" : `<button type="button" class="btn small danger" data-tests-remove>${esc(this.text("tests.panel.remove"))}</button>`;
    return `${note}<div class="tests-foot">${remove}<span class="tests-row"><button type="button" class="btn small" data-tests-close>${esc(this.text("tests.panel.close"))}</button><button type="button" class="btn small primary" data-tests-apply${
      applyDisabled ? " disabled" : ""
    }>${esc(this.text("tests.panel.apply"))}</button></span></div>`;
  }

  private addStepHtml(): string {
    const button = `<button type="button" class="btn small" data-tests-add-step aria-haspopup="menu" aria-expanded="${this.addOpen}" aria-controls="tests-add-pop">${esc(this.text("tests.panel.addStep"))} <span aria-hidden="true">▾</span></button>`;
    if (!this.addOpen || !this.ctrl) {
      return `${button}<div class="menu tests-add-pop" id="tests-add-pop" hidden></div>`;
    }
    const root = this.ctrl.snapshot();
    const definition = this.definitionSource?.();
    const codes = this.hostCodes();
    const fields = addStepFields(root, definition, codes).filter((field) => !field.collection);
    const picked = fields.find((field) => field.path === this.addField) ?? fields[0];
    const groups = addStepChoices(root, definition, codes, { field: picked?.path, text: this.textOptions() });
    const picker =
      fields.length === 0
        ? `<p class="tests-note">${esc(this.text("tests.addStep.noFields"))}</p>`
        : `<label class="tests-add-field">${esc(this.text("tests.addStep.field"))}<select data-tests-add-field>${fields
            .map((field) => `<option value="${esc(field.path)}"${field.path === picked?.path ? " selected" : ""}>${esc(field.label)}</option>`)
            .join("")}</select></label>`;
    const menu = groups
      .map(
        (group) =>
          `<div class="tests-add-group" role="group" aria-labelledby="tests-add-${group.id}"><p class="tests-add-title" id="tests-add-${group.id}">${esc(group.title)}</p>${group.statements
            .map((statement) => `<button type="button" class="menu-item tests-add-item" role="menuitem" tabindex="-1" data-tests-add-line="${esc(statement.text)}"><span>${esc(statement.label)}</span><code>${esc(statement.text)}</code></button>`)
            .join("")}</div>`
      )
      .join("");
    return `${button}<div class="menu tests-add-pop" id="tests-add-pop" data-tests-add-pop>${picker}<div class="tests-add-menu" role="menu" aria-label="${esc(this.text("tests.addStep.menu"))}" data-tests-add-menu>${menu}</div></div>`;
  }

  private hostCodes(): string[] {
    try {
      return (this.ctrl?.validationCodes() ?? []).map((code) => (typeof code === "string" ? code : code.code));
    } catch {
      return [];
    }
  }

  /** The panel's own Close prompt, or the shell's leave prompt when the edits it holds for are this panel's. */
  private promptHtml(working: Working): string {
    const held = this.ctrl?.unsavedChangesPrompt();
    if (held?.external?.id === GUARD_ID) {
      return unsavedChangesPromptHtml({ componentId: working.id ?? GUARD_ID, label: this.workingName(working), action: held.action, blocked: false }, this.textOptions());
    }
    if (this.closeAsked) {
      return unsavedChangesPromptHtml({ componentId: working.id ?? GUARD_ID, label: this.workingName(working), action: "panel", blocked: false }, this.textOptions());
    }
    return "";
  }

  private openPrompt(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") {
      try {
        showBuilderModal(dialog);
      } catch {
        dialog.setAttribute("open", "");
      }
      dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
    }
  }

  // --- the editor box -------------------------------------------------------------------------------

  private editorOptions(working: Working): TestsEditorOptions {
    const controller = this.ctrl;
    return {
      text: working.text,
      completions: createTestsCompletions(
        () => controller?.snapshot() ?? ({ id: "root", type: "form", configuration: {} } as ComponentNode),
        () => this.definitionSource?.(),
        () => this.hostCodes()
      ),
      words: this.textOptions(),
      ariaLabel: this.text("tests.panel.editor.label"),
      onChange: (text) => this.onEditorChange(text),
      onSubmit: () => this.apply()
    };
  }

  /** The plain box at once, the CodeMirror editor when its chunk lands (keeping text, caret line and focus); a failed load keeps the box. */
  private mountEditor(working: Working): void {
    const slot = this.root.querySelector<HTMLElement>("[data-tests-editor-slot]");
    if (!slot) {
      return;
    }
    const textarea = mountTestsTextarea(slot, this.editorOptions(working));
    this.boxKey = undefined;
    this.editor = textarea;
    if (this.editorFailed) {
      return;
    }
    this.testsEditorLoader().then(
      (module) => {
        const current = this.working;
        if (this.editor !== textarea || !current || !textarea.element.isConnected) {
          return;
        }
        const focused = textarea.element.contains(this.root.activeElement);
        const line = textarea.caretLine();
        const editor = module.mountTestsEditor(slot, { ...this.editorOptions(current), text: textarea.getText() });
        textarea.destroy();
        this.editor = editor;
        this.boxKey = undefined;
        // The regions are as they were; the new box takes the marks and problems they stand for.
        this.regions.delete("problems");
        this.updateRegions(current);
        if (focused) {
          editor.focus(line);
        }
      },
      () => {
        if (this.editor === textarea) {
          this.editorFailed = true;
        }
      }
    );
  }

  private onEditorChange(text: string): void {
    const working = this.working;
    if (!working) {
      return;
    }
    working.text = text;
    if (this.parseTimer !== undefined) {
      clearTimeout(this.parseTimer);
    }
    this.parseTimer = setTimeout(() => {
      this.parseTimer = undefined;
      this.parseWorking();
      this.paint();
    }, PARSE_DEBOUNCE_MS);
    // Apply, the note and the marks follow at once; the problems wait for the parse.
    this.paint();
  }

  /** Parses the box's text as its entry would read in the block (a name another entry uses is flagged). */
  private parseWorking(): void {
    const working = this.working;
    const runner = this.runner;
    if (!working || !runner) {
      return;
    }
    const scenarios = this.entries.map((entry) => ({ id: entry.id, source: entry.id === working.id ? working.text : entry.source }));
    const id = working.id ?? this.nextId();
    if (working.id === undefined) {
      scenarios.push({ id, source: working.text });
    }
    const parsed = runner.parse({ scenarios }).find((entry) => entry.id === id);
    working.problems = parsed?.problems ?? [];
    working.scenario = parsed?.scenario;
  }

  // --- opening, applying, closing -------------------------------------------------------------------

  private open(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return;
    }
    this.working = { id, text: entry.source, problems: [...entry.problems], scenario: entry.scenario, removeAsked: false };
    this.enterEditor();
  }

  /** A New test's editor; `recorded` names it "Recorded <n>" for Record a test, which starts recording into it. */
  private openNew(recorded = false): void {
    const taken = new Set(this.entries.map((entry) => entry.name));
    let name = recorded ? this.text("tests.panel.record.newName", { n: 1 }) : this.text("tests.panel.newName");
    for (let n = 2; taken.has(name); n += 1) {
      name = this.text(recorded ? "tests.panel.record.newName" : "tests.panel.newName.numbered", { n });
    }
    const seed = seedSource(name);
    this.working = { id: undefined, seed, text: seed, problems: [], scenario: undefined, removeAsked: false };
    this.parseWorking();
    this.enterEditor();
  }

  private enterEditor(): void {
    this.addOpen = false;
    this.closeAsked = false;
    this.statusText = "";
    // A chunk that failed for the last scenario is tried again for this one (the loader forgets a failure).
    this.editorFailed = false;
    this.attachGuard();
    this.paint();
    // A New test's caret goes after its indented line, ready for the first step (`setText` leaves it at the end).
    if (this.working?.id === undefined) {
      this.editor?.setText(this.working?.text ?? "");
    }
    this.editor?.focus();
  }

  /** The smallest `test-<n>` not taken (no randomness, no clock). */
  private nextId(): string {
    return nextIdOf(this.entries.map((entry) => entry.id));
  }

  /** `name`, or "name (2)", "name (3)", … when a test already has it: two tests of one name are a problem in the block. */
  private freeName(name: string, taken: ReadonlySet<string>): string {
    let free = name;
    for (let n = 2; taken.has(free); n += 1) {
      free = this.text("tests.panel.write.numbered", { name, n });
    }
    return free;
  }

  /** Writes the box's text into the block: one `setTests`, one undo step. */
  private apply(): boolean {
    const working = this.working;
    const controller = this.ctrl;
    if (!working || !controller) {
      return false;
    }
    if (working.id !== undefined && !this.dirty) {
      return true;
    }
    if (this.parseTimer !== undefined) {
      clearTimeout(this.parseTimer);
      this.parseTimer = undefined;
      this.parseWorking();
    }
    const scenarios = this.entries.map((entry) => ({ id: entry.id, source: entry.source }));
    if (working.id === undefined) {
      const id = this.nextId();
      scenarios.push({ id, source: working.text });
      working.id = id;
      delete working.seed;
      // The view now edits the stored entry: the skeleton is retagged so the change the write
      // announces updates it in place instead of writing it, and the box, again.
      this.root.querySelector<HTMLElement>("[data-tests-view=\"editor\"]")?.setAttribute("data-tests-editing", id);
    } else {
      const at = scenarios.findIndex((entry) => entry.id === working.id);
      if (at < 0) {
        scenarios.push({ id: working.id, source: working.text });
      } else {
        scenarios[at] = { id: working.id, source: working.text };
      }
    }
    this.statusText = this.text("tests.panel.done.applied");
    controller.setTests({ scenarios });
    // The controller's change has reparsed the block; the editor view now edits the stored entry.
    this.reparse();
    this.paint();
    return true;
  }

  /** Puts the editor away, asking first while it holds an unapplied edit. */
  private requestClose(): void {
    if (!this.dirty) {
      this.showList();
      return;
    }
    this.closeAsked = true;
    this.paint();
  }

  private showList(): void {
    this.endShowing();
    this.closeEditor();
    this.forgetMarkup();
    this.paint();
    this.root.querySelector<HTMLElement>("[data-tests-new]")?.focus();
  }

  private closeEditor(): void {
    // The lines a recording writes go into this working copy: it ends with it (nothing said: the copy is gone).
    this.endRecording(true, false);
    this.assertState = undefined;
    if (this.parseTimer !== undefined) {
      clearTimeout(this.parseTimer);
      this.parseTimer = undefined;
    }
    this.editor?.destroy();
    this.editor = undefined;
    this.working = undefined;
    this.addOpen = false;
    this.closeAsked = false;
    this.regions.clear();
    this.dropGuard();
  }

  /**
   * Reads the block again, then has the editor follow it: a box that was clean before the change
   * (it held what was stored) takes the entry's new text, so an Undo, a rename follow or a host's
   * own `tests` set never leaves it holding the old text as an unapplied edit. A box with
   * an edit of the author's keeps it.
   */
  private reparseFollowing(): void {
    const working = this.working;
    const wasClean = working !== undefined && working.id !== undefined && working.text === this.storedSource(working.id);
    this.reparse();
    if (wasClean && working && working.id !== undefined && this.working === working) {
      const now = this.storedSource(working.id);
      if (now !== undefined && now !== working.text) {
        working.text = now;
        if (this.parseTimer !== undefined) {
          clearTimeout(this.parseTimer);
          this.parseTimer = undefined;
        }
        this.editor?.setText(now, { keepCaret: true });
      }
    }
    this.followStored();
  }

  /** A clean editor takes its entry's parse; a vanished entry closes it. */
  private followStored(): void {
    const working = this.working;
    if (!working || working.id === undefined) {
      return;
    }
    const entry = this.entries.find((candidate) => candidate.id === working.id);
    if (!entry) {
      if (!this.dirty) {
        this.closeEditor();
        this.forgetMarkup();
      }
      return;
    }
    if (working.text === entry.source) {
      working.problems = [...entry.problems];
      working.scenario = entry.scenario;
    }
  }

  private removeEntry(): void {
    const working = this.working;
    const controller = this.ctrl;
    if (!working || working.id === undefined || !controller) {
      return;
    }
    const name = this.workingName(working);
    const scenarios = this.entries.filter((entry) => entry.id !== working.id).map((entry) => ({ id: entry.id, source: entry.source }));
    this.closeEditor();
    this.statusText = this.text("tests.panel.done.removed", { name });
    controller.setTests(scenarios.length > 0 ? { scenarios } : undefined);
    this.showList();
  }

  // --- the leave guard ------------------------------------------------------------------------------

  /**
   * Holds the leave prompt while the editor has an unapplied edit. Stacked over the controller's
   * slot rather than put in it: the Logic surface sets and clears the slot whole when
   * it connects and goes, which would otherwise drop this guard, and a leave with both editors
   * holding edits saves both.
   */
  private attachGuard(): void {
    const controller = this.ctrl;
    if (!controller || this.releaseGuard) {
      return;
    }
    const mine: LeaveGuard = {
      pending: () => this.dirty,
      subject: () => ({ id: GUARD_ID, label: this.working ? this.workingName(this.working) : "", blocked: false }),
      save: () => {
        if (this.dirty) {
          this.apply();
          this.showList();
        }
        return true;
      },
      discard: () => {
        if (this.dirty) {
          this.showList();
        }
      }
    };
    this.releaseGuard = controller.pushLeaveGuard(mine);
  }

  private dropGuard(): void {
    this.releaseGuard?.();
    this.releaseGuard = undefined;
  }

  private answerPrompt(decision: UnsavedChangesDecision): void {
    const controller = this.ctrl;
    if (controller?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
      controller.answerUnsavedChangesPrompt(decision);
      return;
    }
    this.closeAsked = false;
    const next = this.pendingOpen;
    this.pendingOpen = undefined;
    if (decision === "stay") {
      this.paint();
      this.editor?.focus();
      return;
    }
    if (decision === "save") {
      this.apply();
    }
    this.showList();
    // The entry asked for while this one held an edit (openEntry) opens now the edit is settled.
    if (next !== undefined) {
      this.openEntry(next);
    }
  }

  // --- a failure ------------------------------------------------------------------------------------

  private failureOf(): { entry: TestsEntryModel; scenario: FormTestScenario; step: FormTestStepResult } | undefined {
    const working = this.working;
    if (!working || this.dirty) {
      return undefined;
    }
    const entry = this.workingEntry(working);
    const step = entry?.status === "stale" ? undefined : this.failingStep(entry?.result);
    if (!entry || !entry.scenario || !step) {
      return undefined;
    }
    return { entry, scenario: entry.scenario, step };
  }

  private accept(): void {
    const failure = this.failureOf();
    const controller = this.ctrl;
    const working = this.working;
    if (!failure || !controller || !working || working.id === undefined) {
      return;
    }
    const outcome = acceptNewBehaviour(failure.entry.source, failure.scenario, failure.step);
    if (!("source" in outcome)) {
      return;
    }
    const scenarios = this.entries.map((entry) => ({ id: entry.id, source: entry.id === working.id ? outcome.source : entry.source }));
    working.text = outcome.source;
    this.statusText = this.text("tests.panel.done.accepted", { line: outcome.line });
    controller.setTests({ scenarios });
    this.reparse();
    this.followStored();
    this.editor?.setText(outcome.source, { keepCaret: true });
    this.paint();
    this.editor?.focus(outcome.line);
  }

  private openRule(button: HTMLElement): void {
    const componentId = button.getAttribute("data-tests-open-rule") ?? "";
    const kind = button.getAttribute("data-tests-rule-kind") ?? undefined;
    if (componentId === "") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<BuilderTestsOpenRuleDetail>("builder-tests-open-rule", {
        detail: { componentId, ...(kind ? { kind } : {}) },
        bubbles: true,
        composed: true
      })
    );
  }

  // --- Show me --------------------------------------------------------------------------------------

  private showMe(): void {
    const failure = this.failureOf();
    if (!failure) {
      return;
    }
    const index = failure.scenario.steps.findIndex((statement) => statement.line === failure.step.line);
    void this.showStep(failure.entry.id, failure.scenario, Math.max(0, index), true);
  }

  /** Replays through step `index` and hands the state to the canvas; a replay that cannot start keeps what is shown and says so. */
  private async showStep(entryId: string, scenario: FormTestScenario, index: number, focusLine: boolean): Promise<void> {
    const runner = this.runner;
    const show = this.showOnCanvasValue;
    if (!runner || !show) {
      return;
    }
    // Show me replaces the tried answers: a recording of them cannot go on over it.
    this.endRecording(true);
    // A newer request, a close, a run, an edit or Stop showing while this replay runs wins.
    this.showToken += 1;
    const token = this.showToken;
    const steps = scenario.steps.length;
    const at = Math.min(Math.max(0, index), Math.max(0, steps - 1));
    this.stepTarget = at;
    const statement = scenario.steps[at];
    const line = statement?.line ?? scenario.line;
    const replay = await runner.replay(scenario, at);
    if (token !== this.showToken) {
      return;
    }
    this.stepTarget = undefined;
    if (replay.error) {
      const failed = this.text("tests.panel.showing.failed", {
        step: at + 1,
        reason: this.words().reason({ name: scenario.name, status: "error", reason: replay.error.reason, ...(replay.error.params !== undefined ? { params: replay.error.params } : {}), steps: [] })
      });
      this.statusText = failed;
      // The last state stays on the canvas, and the bar says this step could not be replayed.
      const last = this.lastShown;
      if (this.showing && this.showing.entryId === entryId && last) {
        this.lastShown = { ...last, note: failed };
        show(this.lastShown);
      }
      this.paint();
      return;
    }
    this.showing = { entryId, scenario, index: at };
    // The gutter's mark is visual only (its cells are hidden from assistive technology): the line
    // shown is said here, when a showing starts and each time it moves; the bar says the step.
    this.statusText = this.text("tests.panel.showing.line", { line });
    this.showingStatus = this.statusText;
    // The bar prints the page as given: its title reads better than the id (the journey's own name for it).
    const page = replay.page !== undefined ? (createTestsNaming(this.ctrl?.snapshot() ?? { id: "root", type: "form", configuration: {} }, this.definitionSource?.()).pageLabelOf(replay.page) ?? replay.page) : undefined;
    // The givens the canvas has a seam for (the lists, the language, the day) it applies for the showing and
    // puts back after; what it cannot apply (host values) it names in the bar itself.
    const givens = showingGivensOf(scenario.givens);
    const showing: CanvasScenarioShowing = {
      name: scenario.name,
      step: at + 1,
      steps,
      line,
      values: replay.values,
      ...(replay.rows !== undefined ? { rows: replay.rows } : {}),
      ...(page !== undefined ? { page } : {}),
      // The journey's own page id, so a journeys canvas can go to the page; `page` is the label the bar prints.
      ...(replay.page !== undefined ? { pageId: replay.page } : {}),
      ...(givens !== undefined ? { givens } : {}),
      onStep: (delta) => {
        const current = this.showing;
        if (current && current.entryId === entryId) {
          void this.showStep(entryId, scenario, (this.stepTarget ?? current.index) + delta, false);
        }
      },
      onStop: () => {
        this.showToken += 1;
        this.stepTarget = undefined;
        this.showing = undefined;
        this.lastShown = undefined;
        this.clearShowingStatus();
        show(undefined);
        this.paint();
      }
    };
    this.lastShown = showing;
    show(showing);
    this.paint();
    // Try it takes the side column away: the box is hidden then, and the canvas's step control has the focus.
    if (focusLine && !this.hidden) {
      this.editor?.focus(line);
    }
  }

  private endShowing(): void {
    // A replay in flight is ended too, though nothing is shown yet.
    this.showToken += 1;
    this.stepTarget = undefined;
    if (!this.showing) {
      return;
    }
    this.showing = undefined;
    this.lastShown = undefined;
    this.clearShowingStatus();
    this.showOnCanvasValue?.(undefined);
  }

  /** The live region said which step was shown; with nothing shown it says nothing, unless something else was said since. */
  private clearShowingStatus(): void {
    if (this.showingStatus !== undefined && this.statusText === this.showingStatus) {
      this.statusText = "";
    }
    this.showingStatus = undefined;
  }

  // --- Record and Assert this ------------------------------------------------------------

  /**
   * Starts writing what the author does in Try it into the open test
   * (Record). The canvas turns Try it on and reports settled events; each becomes a line after
   * the test's last line, so the box turns dirty and Apply saves it. A showing ends first: Show me
   * and Record would both drive the tried answers.
   */
  private startRecording(): void {
    const record = this.recordOnCanvasValue;
    const working = this.working;
    if (!record || !working || this.recordingState) {
      return;
    }
    this.endShowing();
    this.assertState = undefined;
    const state: Recording = { stop: () => undefined, lines: 0, removeNoted: false, working, ending: false, started: false, noDay: false };
    this.recordingState = state;
    this.snapshotBefore = undefined;
    this.snapshotAfter = undefined;
    this.unseenPath = undefined;
    this.statusText = this.text("tests.panel.record.started");
    let stop: () => void;
    try {
      stop = record((event) => this.onRecorded(state, event));
    } catch {
      if (this.recordingState === state) {
        this.recordingState = undefined;
      }
      this.statusText = "";
      this.paint();
      return;
    }
    if (this.recordingState !== state) {
      // Ended while the canvas was starting it (a run, a close): the canvas is told at once.
      stop();
      return;
    }
    state.stop = stop;
    // The Try it chunk may still be on its way (Try it was off): then the canvas has no snapshot
    // yet, and the first event takes the first one it gives.
    const start = this.assertSnapshotValue?.();
    this.snapshotAfter = start;
    if (start !== undefined) {
      this.leadWithToday(state, start);
    }
    this.paint();
  }

  /**
   * The recording's first snapshot: a test of a
   * form that reads the clock runs on no day of its own unless it names one, so the kernel would
   * refuse it (`scenario.clockUnset`) and the browser would follow the real day. The day Try it
   * runs on goes in as `given today` right under the header, before any recorded line; a test
   * that names a day keeps it. A canvas that cannot say its day (a mode's session keeps its own
   * clock) gets no line, and the recording says so once.
   */
  private leadWithToday(state: Recording, snapshot: TestsAssertSnapshot): void {
    if (state.started) {
      return;
    }
    state.started = true;
    if (/^\s*given\s+today\b/im.test(state.working.text) || !this.readsClock()) {
      return;
    }
    const day = snapshot.today;
    const literal = day !== undefined && ISO_DAY.test(day) ? testsLiteral(day) : undefined;
    if (literal === undefined) {
      state.noDay = true;
      this.statusText = joinStatus(this.statusText, this.text("tests.panel.record.noDay"), this.text("tests.panel.assert.sep"));
      return;
    }
    const header = headerLineOf(state.working.text);
    this.insertLines([`given today = ${literal}`], header);
    state.lines += 1;
  }

  /** Whether a rule of the committed tree (journeys and layouts included) reads the day, as the Logic model finds a clock read. */
  private readsClock(): boolean {
    const root = this.ctrl?.snapshot();
    if (!root) {
      return false;
    }
    try {
      return buildLogicModel(root, { definition: this.wholeDefinition(root) }).rules.some((rule) => rule.expression !== undefined && kernelExprReadsClock(rule.expression));
    } catch {
      return false;
    }
  }

  /**
   * Ends the recording. `callStop` tells the canvas (its Stop, Close, Show me); the canvas's own
   * ending (Back to editing) has nothing to tell. `say` puts how many lines went in into the live
   * region; a working copy that closes with it says nothing.
   */
  private endRecording(callStop: boolean, say = true): void {
    const state = this.recordingState;
    if (!state || state.ending) {
      return;
    }
    state.ending = true;
    // The canvas's stop sends the answer it was holding back (focus still in the field): the
    // state stays until then so that line goes in. A copy closing with it takes nothing more.
    if (!say) {
      this.recordingState = undefined;
    }
    if (callStop) {
      try {
        state.stop();
      } catch {
        /* the canvas has already let go */
      }
    }
    if (this.recordingState === state) {
      this.recordingState = undefined;
    }
    if (say) {
      this.statusText = builderPlural("tests.panel.record.stopped", state.lines, undefined, this.textOptions());
    }
  }

  /** One settled event from the canvas: a line after the test's last line, or a word on why none. */
  private onRecorded(state: Recording, event: TestsRecordEvent): void {
    if (this.recordingState !== state || this.working !== state.working) {
      return;
    }
    const dayKnown = !state.noDay;
    if (!state.started) {
      // No snapshot at the start: the first one the canvas can give is the before-state.
      // It already holds this event, so the two cannot say what the event moved: Assert this
      // ticks the field the event names instead.
      const first = this.assertSnapshotValue?.();
      this.snapshotBefore = first;
      this.snapshotAfter = first;
      this.unseenPath = event.kind === "set" || event.kind === "clear" ? event.path : undefined;
      if (first !== undefined) {
        this.leadWithToday(state, first);
      }
    } else {
      this.unseenPath = undefined;
      this.snapshotBefore = this.snapshotAfter;
      this.snapshotAfter = this.assertSnapshotValue?.();
    }
    const step = recordStep(event, this.naming());
    if ("line" in step) {
      this.insertLines([step.line]);
      state.lines += 1;
      this.statusText = builderPlural("tests.panel.record.status", state.lines, undefined, this.textOptions());
    } else if (step.refused === "removeRow") {
      // Said once a recording: every removal after the first would only repeat it.
      if (!state.removeNoted) {
        state.removeNoted = true;
        this.statusText = this.text("tests.panel.record.removeRow");
      }
    } else {
      this.statusText = this.text(REFUSED_KEYS[step.refused]);
    }
    if (dayKnown && state.noDay) {
      // Found out with this event: said once, after what the event did.
      this.statusText = joinStatus(this.statusText, this.text("tests.panel.record.noDay"), this.text("tests.panel.assert.sep"));
    }
    this.paint();
  }

  /**
   * Puts lines after the working text's last filled line (before the blanks a seeded test ends
   * with), or after line `after` when given (the `given today` lead line goes under the header),
   * through the box's own `insertLine` so the box reports the edit and keeps its history, without
   * taking the focus: the author may be typing on the canvas.
   */
  private insertLines(lines: readonly string[], after?: number): void {
    const working = this.working;
    if (!working || lines.length === 0) {
      return;
    }
    const editor = this.editor as LineInserter | undefined;
    if (editor) {
      let at = after;
      for (const line of lines) {
        editor.insertLine(line, { afterLine: at ?? lastFilledLine(editor.getText()), focus: false });
        at = at === undefined ? undefined : at + 1;
      }
      // CodeMirror hands its edit over a microtask later: the copy follows the box now, so the note and Apply do too.
      this.onEditorChange(editor.getText());
      return;
    }
    // No box yet (the panel was hidden when this copy opened): the copy takes the lines, the box will start from it.
    let text = working.text;
    let at = after;
    for (const line of lines) {
      const edit = statementInsertion(text, lineEndOffset(text, at ?? lastFilledLine(text)), line);
      text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
      at = at === undefined ? undefined : at + 1;
    }
    this.onEditorChange(text);
  }

  /** Whether a `requiredWhen` decides the component's required state, in the committed tree. */
  private decidesRequired(componentId: string): boolean {
    const walk = (node: ComponentNode): boolean | undefined => {
      if (node.id === componentId) {
        const rules = node.rules as Record<string, unknown> | undefined;
        return rules !== undefined && rules !== null && rules["requiredWhen"] !== undefined && rules["requiredWhen"] !== null;
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          const found = walk(child);
          if (found !== undefined) {
            return found;
          }
        }
      }
      return undefined;
    };
    const root = this.ctrl?.snapshot();
    return root !== undefined && walk(root) === true;
  }

  /** Opens Assert this over the tried form as it is now, the fields the last recorded event moved ticked. */
  private openAssert(): void {
    const snapshot = this.assertSnapshotValue?.();
    if (!snapshot) {
      this.statusText = this.text("tests.panel.assert.off");
      this.paint();
      return;
    }
    const previous = this.snapshotBefore;
    const changed = new Set(changedFields(snapshot, previous));
    const picked = new Set(changed);
    // The first event of a recording that started before the canvas could give a snapshot.
    if (this.unseenPath !== undefined && snapshot.fields.some((field) => field.path === this.unseenPath)) {
      picked.add(this.unseenPath);
    }
    this.assertState = { snapshot, previous, changed, picked, extras: new Set(), search: "" };
    this.addOpen = false;
    this.paint();
    const first = this.root.querySelector<HTMLElement>("[data-tests-assert] input[type=checkbox]:checked") ?? this.root.querySelector<HTMLElement>("[data-tests-assert-search]");
    first?.focus();
  }

  private closeAssert(returnFocus: boolean): void {
    if (!this.assertState) {
      return;
    }
    this.assertState = undefined;
    this.paint();
    if (returnFocus) {
      this.root.querySelector<HTMLElement>("[data-tests-assert-open]")?.focus();
    }
  }

  /** The lines the popover's picks write, as Insert would write them now. */
  private assertPicked(state: AssertState): string[] {
    return assertLines(
      state.snapshot,
      state.previous,
      { fields: [...state.picked], page: state.extras.has("page"), errors: state.extras.has("errors"), verdict: state.extras.has("verdict") },
      { decidesRequired: (componentId) => this.decidesRequired(componentId) }
    );
  }

  private insertAsserted(): void {
    const state = this.assertState;
    if (!state) {
      return;
    }
    const lines = this.assertPicked(state);
    this.assertState = undefined;
    this.insertLines(lines);
    if (lines.length > 0) {
      this.statusText = builderPlural("tests.panel.assert.inserted", lines.length, undefined, this.textOptions());
    }
    this.paint();
    this.root.querySelector<HTMLElement>("[data-tests-assert-open]")?.focus();
  }

  /** Record and Assert this, beside Add step: offered only while the shell lends the canvas's seams. */
  private recordHtml(): string {
    if (!this.recordOnCanvasValue && !this.assertSnapshotValue) {
      return "";
    }
    const recording = this.recordingState !== undefined;
    // One signal, not two: the label says Record or Stop recording, as the bar's control
    // does; a pressed state as well would read "Stop recording, pressed". `data-recording` is the look only.
    const record = this.recordOnCanvasValue
      ? `<button type="button" class="btn small${recording ? " dark" : ""}" data-tests-record${recording ? " data-recording" : ""} title="${esc(this.text("tests.panel.record.title"))}">${recording ? STOP_SVG : REC_SVG}${esc(
          this.text(recording ? "tests.panel.record.stop" : "tests.panel.record")
        )}</button>`
      : "";
    // Assert this reads the tried form: offered while Try it is on (a recording turns it on).
    const ready = this.assertReadyValue;
    const tried = this.assertSnapshotValue !== undefined && (recording || (ready ? ready() : this.assertSnapshotValue() !== undefined));
    const assert = tried
      ? `<button type="button" class="btn small" data-tests-assert-open aria-haspopup="dialog" aria-expanded="${this.assertState !== undefined}" aria-controls="tests-assert-pop">${esc(this.text("tests.panel.assert"))} <span aria-hidden="true">▾</span></button>`
      : "";
    return `${record}${assert}`;
  }

  /** The visible line under the row while recording; the live region says the same. */
  private recordingHtml(): string {
    const state = this.recordingState;
    if (!state) {
      return "";
    }
    const line = `<p class="tests-note tests-recording" data-tests-recording><span class="tests-rec-dot" aria-hidden="true"></span>${esc(builderPlural("tests.panel.record.status", state.lines, undefined, this.textOptions()))}</p>`;
    // The live region said it once; the line keeps it in view while the recording lasts.
    return state.noDay ? `${line}<p class="tests-note" data-tests-record-no-day>${esc(this.text("tests.panel.record.noDay"))}</p>` : line;
  }

  /** The Assert this popover: the fields (searchable), then the page, the errors on show and the verdict. */
  private assertHtml(): string {
    const state = this.assertState;
    if (!state) {
      return "";
    }
    const sep = this.text("tests.panel.assert.sep");
    const fields = state.snapshot.fields
      .map((field) => {
        const hint: string[] = [this.text(field.visible ? "tests.panel.assert.shown" : "tests.panel.assert.hidden")];
        if (field.visible && field.required) {
          hint.push(this.text("tests.panel.assert.required"));
        }
        if (field.visible && field.errors.length > 0) {
          hint.push(builderPlural("tests.panel.assert.errors", field.errors.length, undefined, this.textOptions()));
        }
        if (state.changed.has(field.path)) {
          hint.push(this.text("tests.panel.assert.changed"));
        }
        const label = field.label !== "" ? field.label : field.path;
        // Keyed by the value path: each row of a repeating field is a row of its own here,
        // and focus comes back to the box that had it after a tick rewrites the popover.
        return `<li data-tests-assert-row="${esc(field.path)}" data-tests-assert-name="${esc(`${label} ${field.path}`.toLowerCase())}"><label class="tests-assert-item"><input type="checkbox" data-tests-assert-field="${esc(field.path)}"${
          state.picked.has(field.path) ? " checked" : ""
        } /><span class="tests-assert-text"><span class="tests-assert-label">${esc(label)}</span><span class="tests-assert-hint">${esc(hint.join(sep))}</span></span></label></li>`;
      })
      .join("");
    const extra = (id: "page" | "errors" | "verdict", label: string): string =>
      `<li><label class="tests-assert-item"><input type="checkbox" data-tests-assert-extra="${id}"${state.extras.has(id) ? " checked" : ""} /><span class="tests-assert-text"><span class="tests-assert-label">${esc(label)}</span></span></label></li>`;
    const pageLabel = state.snapshot.page !== undefined ? (this.naming().pageLabelOf(state.snapshot.page) ?? state.snapshot.page) : undefined;
    const extras = [
      pageLabel !== undefined ? extra("page", this.text("tests.panel.assert.page", { page: pageLabel })) : "",
      extra("errors", this.text("tests.panel.assert.errorsOnShow")),
      state.snapshot.lastSubmit !== undefined
        ? extra("verdict", this.text("tests.panel.assert.verdict", { verdict: this.text(state.snapshot.lastSubmit === "accepted" ? "tests.panel.assert.verdict.accepted" : "tests.panel.assert.verdict.refused") }))
        : ""
    ].join("");
    const count = this.assertPicked(state).length;
    return `<div class="menu tests-assert-pop" id="tests-assert-pop" role="dialog" aria-modal="false" aria-labelledby="tests-assert-title" data-tests-assert>
        <p class="tests-add-title" id="tests-assert-title">${esc(this.text("tests.panel.assert.title"))}</p>
        <input class="tests-filter" type="search" data-tests-assert-search value="${esc(state.search)}" placeholder="${esc(this.text("tests.panel.assert.search"))}" aria-label="${esc(this.text("tests.panel.assert.search.label"))}" />
        <p class="tests-add-title">${esc(this.text("tests.panel.assert.fields"))}</p>
        <ul class="tests-assert-list" role="list" data-tests-assert-list>${fields}</ul>
        <p class="tests-note" data-tests-assert-none hidden>${esc(this.text("tests.panel.assert.fields.none"))}</p>
        <p class="tests-add-title">${esc(this.text("tests.panel.assert.form"))}</p>
        <ul class="tests-assert-list" role="list">${extras}</ul>
        <div class="tests-row tests-row--end"><button type="button" class="btn small" data-tests-assert-cancel>${esc(this.text("tests.panel.assert.cancel"))}</button><button type="button" class="btn small primary" data-tests-assert-insert${
          count === 0 ? " disabled" : ""
        }>${esc(builderPlural("tests.panel.assert.insert", count, undefined, this.textOptions()))}</button></div>
      </div>`;
  }

  /** Narrows the popover's fields to those whose label or path holds the search text, in place. */
  private applyAssertSearch(): void {
    const needle = (this.assertState?.search ?? "").trim().toLowerCase();
    let shown = 0;
    for (const row of this.root.querySelectorAll<HTMLLIElement>("[data-tests-assert-row]")) {
      const match = needle === "" || (row.getAttribute("data-tests-assert-name") ?? "").includes(needle);
      row.hidden = !match;
      shown += match ? 1 : 0;
    }
    const none = this.root.querySelector<HTMLElement>("[data-tests-assert-none]");
    if (none) {
      none.hidden = !(needle !== "" && shown === 0);
    }
  }

  // --- the Untested view ------------------------------------------------------------------

  /** The list's foot line: "2 of 9 rules untested · Show"; nothing for a form with no rule a test can pin. */
  private untestedLineHtml(): string {
    const coverage = this.coverage();
    if (!coverage || coverage.rules.length === 0) {
      return "";
    }
    const line = `${this.text("tests.panel.untested.line", { untested: coverage.untested, total: coverage.rules.length })} · ${this.text("tests.panel.untested.show")}`;
    return `<p class="tests-untested-line"><button type="button" class="link-btn" data-tests-untested>${esc(line)}</button></p>`;
  }

  private renderUntested(view: HTMLElement): void {
    if (view.getAttribute("data-tests-view") !== "untested") {
      this.regions.clear();
      this.editor?.destroy();
      this.editor = undefined;
      view.setAttribute("data-tests-view", "untested");
      view.removeAttribute("data-tests-editing");
      view.innerHTML = `<div class="tests-in card-stack">
          <div class="card" data-tests-region="untested-head"></div>
          <div class="card" data-tests-region="untested-rows"></div>
        </div>`;
    }
    const coverage: TestsUntestedView = this.coverage() ?? { rules: [], pins: new Map(), tested: 0, untested: 0 };
    this.region(
      "untested-head",
      `<button type="button" class="link-btn tests-back" data-tests-untested-back>${esc(this.text("tests.panel.untested.back"))}</button>
        <h2 class="card-title tests-head">${esc(this.text("tests.panel.untested.title"))}</h2>
        <p class="tests-sub" data-tests-untested-summary>${esc(this.text("tests.panel.untested.line", { untested: coverage.untested, total: coverage.rules.length }))}</p>`
    );
    const names = new Map(this.entries.map((entry) => [entry.id, this.entryName(entry)]));
    const rows = coverage.rules.map((rule) => {
      const pins = coverage.pins.get(rule.id) ?? [];
      const kind = this.text(KIND_KEYS[rule.kind] ?? "tests.panel.kind.other");
      const pinned =
        pins.length === 0
          ? `<span class="tests-rule-untested" data-tests-rule-untested>${esc(this.text("tests.panel.untested.none"))}</span>`
          : `<span class="tests-rule-by">${esc(this.text("tests.panel.untested.pinnedBy"))}</span> ${pins
              .map((pin) => `<button type="button" class="tests-pin" data-tests-open-entry="${esc(pin.id)}">${esc(names.get(pin.id) ?? pin.name)}</button>`)
              .join(" ")}`;
      const write = (scaffoldableKinds as readonly string[]).includes(rule.kind)
        ? `<button type="button" class="btn small" data-tests-write-test="${esc(rule.id)}" title="${esc(this.text("tests.panel.untested.write.title"))}">${esc(this.text("tests.panel.untested.write"))}</button>`
        : "";
      // A Logic sentence often opens with its kind's verb ("Show Newsletter email when..."): the kind
      // is not said twice then, only where the sentence does not already say it.
      const saysKind = rule.sentence.toLocaleLowerCase().startsWith(`${kind.toLocaleLowerCase()} `);
      return `<li class="tests-rule" data-tests-rule="${esc(rule.id)}" data-tested="${pins.length > 0}">
          <p class="tests-rule-text">${saysKind ? "" : `<span class="tests-rule-kind">${esc(kind)}</span> `}${esc(rule.sentence)}</p>
          <p class="tests-rule-pins">${pinned}</p>
          ${write}
        </li>`;
    });
    this.region(
      "untested-rows",
      rows.length === 0
        ? `<div class="empty-state" data-tests-untested-empty><p>${esc(this.text("tests.panel.untested.empty"))}</p></div>`
        : `<ul class="tests-rules" role="list" aria-label="${esc(this.text("tests.panel.untested.list.label"))}" data-tests-rules>${rows.join("")}</ul>`
    );
  }

  private showUntested(open: boolean): void {
    this.listView = open ? "untested" : "list";
    this.paint();
    this.root.querySelector<HTMLElement>(open ? "[data-tests-untested-back]" : "[data-tests-untested]")?.focus();
  }

  // --- events ---------------------------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement | null;
      if (target?.hasAttribute?.("data-tests-filter")) {
        this.filter = target.value;
        this.applyFilter();
      }
      if (target?.hasAttribute?.("data-tests-assert-search") && this.assertState) {
        // Typed into the box itself, as the list's filter: rows hide in place, nothing is rewritten.
        this.assertState.search = target.value;
        this.applyAssertSearch();
      }
    });
    this.root.addEventListener("change", (event) => {
      const target = event.target as HTMLSelectElement | null;
      if (target?.hasAttribute?.("data-tests-add-field")) {
        this.addField = target.value;
        this.paint();
      }
      const box = event.target as HTMLInputElement | null;
      const state = this.assertState;
      if (state && box?.type === "checkbox") {
        const field = box.getAttribute("data-tests-assert-field");
        const extra = box.getAttribute("data-tests-assert-extra") as "page" | "errors" | "verdict" | null;
        if (field !== null) {
          if (box.checked) {
            state.picked.add(field);
          } else {
            state.picked.delete(field);
          }
        } else if (extra !== null) {
          if (box.checked) {
            state.extras.add(extra);
          } else {
            state.extras.delete(extra);
          }
        }
        // Insert's count follows the ticks.
        this.paint();
      }
    });
    this.root.addEventListener("keydown", (event) => this.onKeydown(event as KeyboardEvent));
    // Tab out of the open Add step menu puts it away, as a click outside does. Only a move to
    // a known control counts: a region rewritten under the focus reports no related target.
    this.root.addEventListener("focusout", (event) => {
      const focus = event as FocusEvent;
      const add = this.root.querySelector<HTMLElement>('[data-tests-region="add"]');
      const next = focus.relatedTarget as Node | null;
      if (!this.addOpen || !add || !add.contains(focus.target as Node | null) || next === null || add.contains(next)) {
        return;
      }
      queueMicrotask(() => {
        if (this.addOpen) {
          this.setAddOpen(false, "none");
        }
      });
    });
    this.root.addEventListener(
      "cancel",
      (event) => {
        if ((event.target as HTMLElement | null)?.hasAttribute?.("data-prompt")) {
          event.preventDefault();
          this.answerPrompt("stay");
        }
      },
      true
    );
  }

  private onClick(event: Event): void {
    const target = event.target as Element | null;
    const hit = (selector: string): HTMLElement | null => target?.closest?.<HTMLElement>(selector) ?? null;
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
    if (hit("[data-tests-run-all]")) {
      this.startRun();
      return;
    }
    if (hit("[data-tests-run-as-i-edit]")) {
      this.setRunAsIEdit(!this.runAsIEdit);
      return;
    }
    // Record, Assert this, the Untested view, Write a test.
    if (hit("[data-tests-record]")) {
      if (this.recordingState) {
        this.endRecording(true);
        this.paint();
      } else {
        this.startRecording();
      }
      return;
    }
    if (hit("[data-tests-record-new]")) {
      this.openNew(true);
      this.startRecording();
      return;
    }
    if (hit("[data-tests-assert-open]")) {
      if (this.assertState) {
        this.closeAssert(true);
      } else {
        this.openAssert();
      }
      return;
    }
    if (hit("[data-tests-assert-cancel]")) {
      this.closeAssert(true);
      return;
    }
    if (hit("[data-tests-assert-insert]")) {
      this.insertAsserted();
      return;
    }
    if (this.assertState && !hit("[data-tests-assert]")) {
      // A click outside the popover puts it away, as the Add step menu goes.
      this.closeAssert(false);
    }
    if (hit("[data-tests-untested]")) {
      this.showUntested(true);
      return;
    }
    if (hit("[data-tests-untested-back]")) {
      this.showUntested(false);
      return;
    }
    const pin = hit("[data-tests-open-entry]");
    if (pin) {
      this.openEntry(pin.getAttribute("data-tests-open-entry") ?? "");
      return;
    }
    const write = hit("[data-tests-write-test]");
    if (write) {
      this.writeTestFor(write.getAttribute("data-tests-write-test") ?? "");
      return;
    }
    const entry = hit("[data-tests-entry]");
    if (entry) {
      this.open(entry.getAttribute("data-tests-entry") ?? "");
      return;
    }
    if (hit("[data-tests-new]")) {
      this.openNew();
      return;
    }
    if (hit("[data-tests-apply]")) {
      // Apply turns itself off once the edit is written, and a disabled button holds no focus: the box takes it back.
      if (this.apply()) {
        this.editor?.focus();
      }
      return;
    }
    if (hit("[data-tests-close]")) {
      this.requestClose();
      return;
    }
    if (hit("[data-tests-remove]")) {
      if (this.working) {
        this.working.removeAsked = true;
        this.paint();
        this.root.querySelector<HTMLElement>("[data-tests-remove-cancel]")?.focus();
      }
      return;
    }
    if (hit("[data-tests-remove-cancel]")) {
      if (this.working) {
        this.working.removeAsked = false;
        this.paint();
        this.root.querySelector<HTMLElement>("[data-tests-remove]")?.focus();
      }
      return;
    }
    if (hit("[data-tests-remove-confirm]")) {
      this.removeEntry();
      return;
    }
    const problem = hit("[data-tests-problem]");
    if (problem) {
      this.editor?.focus(Number(problem.getAttribute("data-tests-problem")));
      return;
    }
    if (hit("[data-tests-show]")) {
      this.showMe();
      return;
    }
    const rule = hit("[data-tests-open-rule]");
    if (rule) {
      this.openRule(rule);
      return;
    }
    if (hit("[data-tests-accept]")) {
      this.accept();
      return;
    }
    if (hit("[data-tests-add-step]")) {
      this.setAddOpen(!this.addOpen, "first");
      return;
    }
    const line = hit("[data-tests-add-line]");
    if (line) {
      this.insertStep(line.getAttribute("data-tests-add-line") ?? "");
      return;
    }
    // A click outside the open menu closes it.
    if (this.addOpen && !hit("[data-tests-add-pop]")) {
      this.setAddOpen(false, "none");
    }
  }

  private setAddOpen(open: boolean, focus: "first" | "last" | "button" | "none"): void {
    this.addOpen = open;
    // Only one popover is ever open: both hang under the same row and share a layer, so Assert this would hide the menu.
    if (open) {
      this.assertState = undefined;
    }
    this.paint();
    if (focus === "button") {
      this.root.querySelector<HTMLElement>("[data-tests-add-step]")?.focus();
    } else if (open && focus !== "none") {
      const items = this.menuItems();
      items[focus === "first" ? 0 : items.length - 1]?.focus();
    }
  }

  /**
   * Keeps the open popovers (Add step, Assert this) inside the panel's scroller. Their width is the
   * style sheet's job (they hang from the actions row and take its width at most); their height is
   * the room left under their top edge, which only a measurement knows, and this runs after every
   * write of the editor's regions because a rewrite builds a fresh popover node without it. The
   * scroll listener sits on the shadow root in the capture phase (scroll does not bubble), so it
   * does not matter that a view change builds a new scroller node; a ResizeObserver follows the
   * current scroller's size (the window's resize is the fallback where there is none); all come off when the last
   * popover closes, and with the panel.
   */
  private syncPopoverFit(): void {
    const open = new Set<"add" | "assert">();
    if (this.addOpen) {
      open.add("add");
    }
    if (this.assertState) {
      open.add("assert");
    }
    for (const kind of [...this.fitted]) {
      if (!open.has(kind)) {
        this.fitted.delete(kind);
      }
    }
    if (open.size === 0) {
      this.stopPopoverFit();
      return;
    }
    if (!this.fitListening) {
      this.fitListening = true;
      this.root.addEventListener("scroll", this.onFitEvent, true);
      if (typeof ResizeObserver === "function") {
        this.fitObserver = new ResizeObserver(this.onFitResize);
      } else {
        window.addEventListener("resize", this.onFitResize);
      }
    }
    // A view change builds a new scroller node, so the observer follows whichever one is current.
    const scroller = this.root.querySelector(".tests-in");
    if (this.fitObserver && scroller && scroller !== this.fitObserved) {
      this.fitObserver.disconnect();
      this.fitObserver.observe(scroller);
      this.fitObserved = scroller;
    }
    this.fitOpenPopovers();
  }

  private stopPopoverFit(): void {
    this.fitted.clear();
    for (const pop of this.root.querySelectorAll<HTMLElement>(".tests-add-pop, .tests-assert-pop")) {
      pop.style.maxBlockSize = "";
    }
    if (this.fitListening) {
      this.fitListening = false;
      this.root.removeEventListener("scroll", this.onFitEvent, true);
      window.removeEventListener("resize", this.onFitResize);
      this.fitObserver?.disconnect();
      this.fitObserver = undefined;
      this.fitObserved = undefined;
    }
  }

  private fitOpenPopovers(): void {
    for (const kind of ["add", "assert"] as const) {
      const pop = this.root.querySelector<HTMLElement>(kind === "add" ? ".tests-add-pop:not([hidden])" : ".tests-assert-pop");
      if (!pop) {
        continue;
      }
      // Only the opening may move the panel's scroll: a later fit (the owner scrolling, a tick) just resizes.
      const opening = !this.fitted.has(kind);
      this.fitted.add(kind);
      this.fitPopover(pop, kind, opening);
    }
  }

  /**
   * Sets the popover's max-block-size to the room between its top edge and the scroller's bottom
   * (less a gap), so its own scroll, and Assert this's sticky foot, stay in view. When the room is
   * short and the popover is opening, the scroller first brings the actions row to its top (set
   * directly: scrollIntoView would also move the page behind a contained builder) and the room is
   * measured again. A layout that reports no size (jsdom) is left alone.
   */
  private fitPopover(pop: HTMLElement, kind: "add" | "assert", opening: boolean): void {
    const scroller = pop.closest<HTMLElement>(".tests-in");
    if (!scroller) {
      return;
    }
    const measure = (): number | undefined => {
      const box = scroller.getBoundingClientRect();
      const own = pop.getBoundingClientRect();
      if (box.top === 0 && box.bottom === 0 && own.top === 0 && own.bottom === 0) {
        return undefined;
      }
      return box.bottom - own.top - POPOVER_GAP;
    };
    let room = measure();
    if (room === undefined) {
      return;
    }
    if (room < POPOVER_MIN_HEIGHT && opening) {
      const anchor = kind === "add" ? pop.closest(".tests-actions") : pop.closest(".tests-assert")?.previousElementSibling;
      const shift = anchor ? anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0;
      if (shift > 0) {
        scroller.scrollTop += shift;
        room = measure() ?? room;
      }
    }
    // Below the floor the popover overflows the scroller rather than shrinking past use; it scrolls inside.
    pop.style.maxBlockSize = `${Math.min(POPOVER_CAP[kind], Math.max(POPOVER_FLOOR_HEIGHT, Math.floor(room)))}px`;
  }

  private menuItems(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>("[data-tests-add-menu] [role=menuitem]"));
  }

  private insertStep(text: string): void {
    if (text === "") {
      return;
    }
    this.addOpen = false;
    this.paint();
    // The box takes the line after the caret's, indented like its neighbours, and reports the edit itself.
    this.editor?.insertLine(text);
  }

  /** The menu's keys, as the chrome panel's ⋯ menu has them: Escape closes, the arrows, Home and End walk the items. */
  private onKeydown(event: KeyboardEvent): void {
    const target = event.target as Element | null;
    if (this.assertState && event.key === "Escape" && target?.closest?.('[data-tests-region="assert"], [data-tests-assert-open]')) {
      // The popover is not modal, but Escape puts it away and the focus goes back to Assert this.
      event.preventDefault();
      event.stopPropagation();
      this.closeAssert(true);
      return;
    }
    if (!this.addOpen) {
      if (target?.closest?.("[data-tests-add-step]") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        this.setAddOpen(true, event.key === "ArrowDown" ? "first" : "last");
      }
      return;
    }
    if (!target?.closest?.("[data-tests-region=\"add\"]")) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.setAddOpen(false, "button");
      return;
    }
    if (target.closest("select")) {
      return;
    }
    const items = this.menuItems();
    const at = items.indexOf(target as HTMLElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") {
      next = at < 0 ? 0 : (at + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next === undefined || items.length === 0) {
      return;
    }
    event.preventDefault();
    items[next]?.focus();
  }
}

export function defineBuilderTestsPanel(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_TESTS_PANEL_TAG)) {
    customElements.define(DATUM_BUILDER_TESTS_PANEL_TAG, DatumBuilderTestsPanelElement);
  }
}
