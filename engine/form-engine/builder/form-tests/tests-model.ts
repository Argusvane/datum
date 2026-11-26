/**
 * The Tests panel's shared contract: the types every module of the panel reads. A change adds
 * optional fields only, since a rename or a removal reaches every module that reads them.
 *
 * The pieces, each a module of the panel's lazy chunk (`datum-builder-tests-*.js`):
 * - the runner (`tests-runner.ts`) parses the definition's `tests` block into entries and runs
 *   them on the browser's runtime, one fresh headless `FormRuntime` per scenario, and replays a
 *   scenario up to a step for Show me;
 * - the words (`tests-words.ts`) turn the engine's codes and data into sentences from the
 *   catalog, with the form's own labels;
 * - the editor (`tests-textarea.ts` until the CodeMirror chunk has loaded, then `tests-editor.ts`)
 *   edits one scenario's source with completions, marks and problems;
 * - the panel (`builder-tests-panel.ts`) draws the list, the editor and a failure, runs as the
 *   author edits, and hands a step to the canvas to show.
 *
 * The builder's eager bundle sees only the types here (the canvas's `showScenario` takes a
 * {@link CanvasScenarioShowing}): a value import of anything under `builder/form-tests/` from
 * eager code would put the chunk back in the entry (the bundle check guards it).
 */
import type { FormDefinition } from "../../core/schema/types.js";
import type { DataSourceSet } from "../../core/schema/contracts.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { FormTestProblem, FormTestScenario, FormTestScenarioResult, FormTestStepResult, FormTestConfiguration } from "../../core/form-tests/form-test-types.js";
import type { FormTestLint } from "../../core/form-tests/form-test-lint.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";

// --- entries and runs --------------------------------------------------------------------------

/**
 * What an entry of the list is at: `invalid` when its source does not parse (the problems say
 * why), `unrun` before a run or after an edit that has not run yet, `running` while its scenario
 * runs, else the engine's scenario status. `stale` is a result from before the last change,
 * kept on show (dimmed) until the next run replaces it.
 */
export type TestsEntryStatus = "invalid" | "unrun" | "running" | "stale" | "passed" | "failed" | "skipped" | "error";

/** One entry of `FormDefinition.tests.scenarios` as the panel lists it. */
export interface TestsEntryModel {
  /** `FormTestScenarioEntry.id`: the handle, stable across renames of the scenario. */
  id: string;
  /** The block exactly as stored. */
  source: string;
  /** The parsed block when the source parses as exactly one scenario; absent with `problems`. */
  scenario?: FormTestScenario;
  /**
   * The entry's own parse problems, plus a `duplicateName` for a name an earlier entry already
   * uses (the later entry is the one reported, and it still runs) and a `tooMany` reading when
   * the source holds more than one `test` block (reported as `stepOutsideTest` on the second
   * header: an entry is one block).
   */
  problems: FormTestProblem[];
  /** The scenario's name; for a source that does not parse, its first non-blank line, cut. */
  name: string;
  status: TestsEntryStatus;
  /** The last result for this entry, when a run produced one. */
  result?: FormTestScenarioResult;
}

export interface TestsRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Scenarios that ended as `error` (a bad given, the clock unset, a refused row action). */
  error: number;
  /** Entries that did not run because their source does not parse. */
  invalid: number;
  /** `Date.now()` when the run ended; absent while no run has finished. */
  ranAt?: number;
  durationMs?: number;
}

export interface TestsRunOutcome {
  /** A newer run or `cancel()` ended this one before every entry ran; `results` holds what finished. */
  cancelled: boolean;
  /** By entry id. */
  results: ReadonlyMap<string, FormTestScenarioResult>;
  summary: TestsRunSummary;
}

/**
 * The state a scenario reaches after its first `through` statements, for the canvas to show
 * (Show me): the answers as the runtime holds them, keyed by component id (what
 * `BuilderPreviewRuntime.setValue` takes), and the page when the scenario runs a journey.
 */
export interface TestsReplay {
  values: Record<string, unknown>;
  page?: string;
  /** Row counts by collection path: an added row that holds no answer has no key in `values`. */
  rows?: Record<string, number>;
  /** The step results up to and including the statement at `through`, as a run reports them. */
  steps: FormTestStepResult[];
  /** The 0-based index of the last statement the replay ran (a refused action or an error ends it earlier). */
  reached: number;
  /** The scenario could not start (a bad given); nothing to show. */
  error?: { reason: string; params?: Record<string, unknown> };
}

export interface TestsRunnerOptions {
  /**
   * The whole definition with the committed tree (journeys, PDF layouts and localization with
   * the form), read at the start of every run and every replay: what the form is now. `undefined`
   * while the shell has no definition source; the runner then builds one from the controller's
   * tree alone (`root` only) through {@link TestsRunnerOptions.root}.
   */
  definition(): FormDefinition | undefined;
  /** The committed tree, for a shell with no whole-definition source. */
  root(): FormDefinition["root"];
  /** The plugin functions a host wired, as the canvas preview takes them; absent: the built-ins. */
  functions?(): Record<string, (args: unknown[]) => unknown> | undefined;
  /** The plugins' signatures, added to the built-ins for parsing; absent: the built-ins. */
  signatures?(): readonly FormulaFunctionSignature[] | undefined;
  /**
   * The builder's data sources (the controller's simulated lists under the host's set), so a
   * data-source-backed choice has options without a `given options for`; a given still wins.
   */
  dataSources?(): DataSourceSet | undefined;
}

export interface TestsRunner {
  /**
   * The entries of a `tests` block, each parsed alone with the signatures in force, names
   * checked across entries, in the block's order. Pure: no run, no state. An absent block is
   * an empty list.
   */
  parse(tests: FormTestConfiguration | undefined): TestsEntryModel[];
  /**
   * Runs the entries that have a scenario, in order, each on a fresh runtime, yielding to the
   * event loop between scenarios so the panel can paint progress (`onProgress` after each). A
   * second `run` while one is in flight cancels the first (its promise resolves `cancelled`
   * with what finished). Never throws: a runtime that cannot be built is that entry's `error`
   * result with reason `scenario.driverFailed`.
   */
  run(entries: readonly TestsEntryModel[], options?: { onProgress?(entry: TestsEntryModel, result: FormTestScenarioResult): void }): Promise<TestsRunOutcome>;
  /** The state after the first `through + 1` statements of the scenario (0-based index of the last one to run). */
  replay(scenario: FormTestScenario, through: number): Promise<TestsReplay>;
  /** Ends the run in flight, if any; its promise resolves `cancelled`. */
  cancel(): void;
}

// --- the canvas ------------------------------------------------------------------------------

/**
 * A scenario's step shown on the canvas (Show me): the canvas turns Try it on, replaces the
 * tried answers with `values`, and the Try bar says which step of which scenario is on show
 * with Step back / Step forward controls that call `onStep`, and Stop showing that calls `onStop`.
 * The panel owns the replay; the canvas owns the drawing. `undefined` ends the showing (the
 * panel's Stop, a new run, the panel closing) and leaves the answers as they are.
 */
export interface CanvasScenarioShowing {
  name: string;
  /** 1-based, for the words: "Showing step 6 of 8". */
  step: number;
  steps: number;
  /** The statement's source line, for the panel's mark. */
  line: number;
  values: Record<string, unknown>;
  /** The page the scenario is on, when it runs a journey, as the bar prints it (its label); the canvas names it in the bar when it cannot go there. */
  page?: string;
  /** The same page's id (the journey's own), so a journeys canvas can go to it. */
  pageId?: string;
  /** Row counts by collection path, so a row the scenario added empty is drawn too. */
  rows?: Record<string, number>;
  /** Said in the bar after the label: a step that could not be replayed, or givens the canvas does not apply. */
  note?: string;
  /**
   * The scenario's givens: the canvas applies what it has a seam for (the simulated
   * lists, the language, the day) for the showing's duration and names in `note` what it does not.
   */
  givens?: TestsShowingGivens;
  /** Step back (-1) or forward (+1); the panel replays and calls `showScenario` again. */
  onStep(delta: -1 | 1): void;
  onStop(): void;
}

// --- the words -------------------------------------------------------------------------------

/** The form's names for what a test names, so a sentence says "Registered agent", not `registered_agent`. */
export interface TestsNaming {
  /** A component's label by id or value path; `undefined` for a path the form lacks. */
  labelOf(path: string): string | undefined;
  /** A journey page's title by id. */
  pageLabelOf(pageId: string): string | undefined;
  /** A PDF layout's label by id. */
  layoutLabelOf(layoutId: string): string | undefined;
}

export interface TestsWords {
  /** A parse problem, worded ("Line 4: expected a value after =."), the line included. */
  problem(problem: FormTestProblem): string;
  /** A lint of a scenario that still runs, worded with its line ("Line 3: No field stores an answer at nmae, …"). */
  lint(lint: FormTestLint): string;
  /** A step's outcome: "Expected Registered agent to be shown; it is hidden." A passed step: "". */
  step(step: FormTestStepResult, scenario: FormTestScenario | undefined): string;
  /** What `expected` and `actual` were, each worded, for the failure card's two rows; absent when the step carries neither. */
  stepSides(step: FormTestStepResult, scenario: FormTestScenario | undefined): { expected: string; actual: string } | undefined;
  /** A scenario that did not run its steps: its skip reason or error, worded with its params. */
  reason(result: FormTestScenarioResult): string;
  /** One line under a list entry: the failing line and why, the skip reason, "Passes", "Not run yet". */
  summary(entry: TestsEntryModel): string;
  /** The status word for a dot's accessible name. */
  status(status: TestsEntryStatus): string;
}

export interface TestsWordsOptions {
  naming: TestsNaming;
  text: BuilderTextOptions | undefined;
}

// --- accepting the form's behaviour ----------------------------------------------------------

/**
 * Accept new behaviour: the failing expectation rewritten to what the form does
 * now, from the step's `actual`. `source` is the whole block with that one line replaced.
 * `refused` says why no rewrite is offered: a formula expectation (`formula`), a step whose
 * actual is not a thing the language can state (`noActual`), a line that is not an expectation
 * (`notExpectation`), or an action that failed (`action`).
 */
export type TestsAcceptOutcome = { source: string; line: number; text: string } | { refused: "formula" | "noActual" | "notExpectation" | "action" };

// --- the editor ------------------------------------------------------------------------------

/** A line's mark in the editor's gutter: the step's status, or `pending` for a line a run did not reach. */
export interface TestsEditorMark {
  line: number;
  status: "passed" | "failed" | "skipped" | "error" | "ran" | "pending";
  /** The failure's one-line wording, shown beside the mark (a title) and announced. */
  message?: string;
  /** The line Show me is on: drawn as such, besides its status. */
  shown?: boolean;
}

export interface TestsEditorProblem {
  line: number;
  /** UTF-16 offsets into the whole text, as the parser reports them. */
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning";
}

/** What the completions offer, read from the form when the list opens (the tree may have changed). */
export interface TestsCompletions {
  /** Every field a test may name: its value path (what the language reads), its label and type. */
  fields(): ReadonlyArray<{ path: string; label: string; type: string; /** a row field: the collection path it sits in */ collection?: string }>;
  pages(): ReadonlyArray<{ id: string; label: string; journey: string }>;
  journeys(): ReadonlyArray<{ id: string; label: string }>;
  layouts(): ReadonlyArray<{ id: string; label: string }>;
  /** The error codes a test may name: the built-in ones and the host's validation codes. */
  codes(): ReadonlyArray<{ code: string; label?: string }>;
}

export interface TestsEditorOptions {
  text: string;
  completions: TestsCompletions;
  /** The builder's words (the catalog in force), for the completions' labels and the gutter's names. */
  words: BuilderTextOptions | undefined;
  ariaLabel: string;
  /** Called with the whole text after every edit (debounce is the caller's). */
  onChange(text: string): void;
  /** Ctrl/Cmd+Enter: the caller's Apply. */
  onSubmit?(): void;
}

export interface TestsEditor {
  readonly element: HTMLElement;
  getText(): string;
  /** Replaces the text; the caret stays on its line when `keepCaret`, else goes to the end. */
  setText(text: string, options?: { keepCaret?: boolean }): void;
  /** Inserts a statement on its own line after the caret's line (or at the end), indented like its neighbours, and moves the caret to it. `afterLine` places it after that 1-based line instead; `focus: false` leaves the focus where it is (Record and Assert this write while the canvas holds it). */
  insertLine(text: string, options?: { afterLine?: number; focus?: boolean }): void;
  setMarks(marks: readonly TestsEditorMark[]): void;
  setProblems(problems: readonly TestsEditorProblem[]): void;
  /** Focuses the box; with `line`, puts the caret at that line's start and scrolls it into view. */
  focus(line?: number): void;
  /** The caret's 1-based line. */
  caretLine(): number;
  destroy(): void;
}

export type MountTestsEditor = (parent: HTMLElement, options: TestsEditorOptions) => TestsEditor;

// --- the panel's events ------------------------------------------------------------------------

/** Detail of `builder-tests-status`, raised by the panel after every run and parse: the strip's badge reads `failed`. */
export interface BuilderTestsStatusDetail {
  summary: TestsRunSummary;
  /** Entries that failed, errored or do not parse: what the badge counts. */
  failed: number;
}

/** Detail of `builder-tests-open-rule`: the shell opens the Logic workspace on this component's rule. */
export interface BuilderTestsOpenRuleDetail {
  componentId: string;
  /** The rule kind the expectation reads (`visibleWhen`, `requiredWhen`, `validWhen`, `calculate`, …), when known. */
  kind?: string;
}

// --- recording, asserting, pins, scaffolds ------------------------------------------

/** What a scenario fixed before its steps, as the canvas can apply it (Show me). */
export interface TestsShowingGivens {
  /** `given today = …`, `YYYY-MM-DD`. */
  today?: string;
  /** `given locale = …`. */
  locale?: string;
  /** `given host.<key> = …`, by key. */
  host?: Record<string, unknown>;
  /** `given options for <path> = (…)`, by value path: the items as the parser read them. */
  options?: Record<string, unknown[]>;
}

/**
 * One thing the author did in Try it while recording (Record), as the canvas
 * reports it from the runtime's settled events: an answer, a row, a move, a check, a submit.
 * Paths are value paths in the engine's form (`items[0].qty`), as `set` takes them.
 */
export type TestsRecordEvent =
  | { kind: "set"; componentId: string; path: string; value: unknown }
  | { kind: "clear"; componentId: string; path: string }
  | { kind: "addRow"; componentId: string; collection: string; count: number }
  /** `index` is the 0-based row that went, when exactly one did; without it the panel records nothing and says so. */
  | { kind: "removeRow"; componentId: string; collection: string; count: number; index?: number }
  | { kind: "continue" }
  | { kind: "back" }
  | { kind: "goTo"; page: string }
  /** A Change link pressed on a Check answers step: the answer's value path. */
  | { kind: "change"; path: string }
  | { kind: "check" }
  | { kind: "submit"; accepted: boolean };

export type TestsRecordListener = (event: TestsRecordEvent) => void;

/** A field's state as Assert this reads it from the tried runtime (Assert this). */
export interface TestsAssertField {
  componentId: string;
  path: string;
  label: string;
  visible: boolean;
  required: boolean;
  enabled: boolean;
  readonly: boolean;
  /** The error codes on show for the field, in the runtime's order. */
  errors: string[];
  value: unknown;
}

export interface TestsAssertSnapshot {
  fields: TestsAssertField[];
  /** The journey page on show, when a journey runs. */
  page?: string;
  /** The last Submit in this Try it, when there was one. */
  lastSubmit?: "accepted" | "refused";
  /**
   * The day the tried runtime runs on, as `given today` spells it (YYYY-MM-DD), when the canvas
   * knows it (the preview's clock); absent for a session that keeps a clock of its own. Record
   * leads a test of a form that reads the clock with it.
   */
  today?: string;
}

/**
 * What the canvas lends the panel for Record and Assert this; the shell hands the panel the two
 * callbacks. `recordTry` turns Try it on if it is off, reports every settled event to the
 * listener until the returned function is called, and draws "Recording" in the Try bar meanwhile.
 */
export interface TestsCanvasRecording {
  recordTry(listener: TestsRecordListener): () => void;
  readonly recording: boolean;
  /** The tried runtime's state now; `undefined` while Try it is off. */
  assertSnapshot(): TestsAssertSnapshot | undefined;
}

/** A test that reads what a rule decides (applied to one rule): the Logic editor's "Pinned by" line. */
export interface TestsPin {
  /** The entry's id. */
  id: string;
  name: string;
}

/** The Logic model's rule id to the tests that pin it; `undefined` while the Tests chunk has not answered. */
export type TestsPinsOf = (ruleId: string) => readonly TestsPin[] | undefined;

/** What "Write a test" writes for one rule (Scaffold from a rule). */
export interface TestsScaffold {
  /** One or two scenarios, each a whole `test "…"` block; `name` is its header's name. */
  entries: Array<{ name: string; source: string }>;
  /** Worded when a literal could not be chosen from the formula: the author fills the marked lines. */
  note?: string;
}

/** `builder-logic-open-test`: the Logic editor's Pinned-by line asks for a test to be opened. */
export interface BuilderLogicOpenTestDetail {
  entryId: string;
}

/** `builder-logic-write-test`: the Logic editor's "Write a test" asks the Tests panel to scaffold for a rule. */
export interface BuilderLogicWriteTestDetail {
  ruleId: string;
}
