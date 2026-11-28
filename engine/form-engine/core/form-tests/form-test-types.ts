import type { Expression } from "../expressions/expression.js";
import type { EffectiveNodeState } from "../state/effective-state.js";
import type { JourneyTrace } from "../journey/journey-types.js";

/**
 * Form tests: the contract between the parser (`form-test-parse.ts`), the judge and
 * runner (`form-test-run.ts`) and the drivers (the browser runtime's and the validation
 * kernel's). Types only: nothing here is spliced into the sandbox program. The shapes are
 * plain data with no prototype assumptions, as every kernel-shared record is, because ids,
 * paths and codes come from an author and may spell `constructor` or `__proto__`.
 */

/** A literal the language writes: a FEEL literal lowered to the JSON the answers hold. A date literal `@"2026-01-01"` is its string. */
export type FormTestValue = string | number | boolean | null | FormTestValue[];

/** Where a token sits: a 1-based line, and UTF-16 offsets into the whole source (`start` inclusive, `end` exclusive). */
export interface FormTestSpan {
  line: number;
  start: number;
  end: number;
}

/** Something a scenario names that the form must have, with its span for the builder's rename seam and diagnostics. */
export interface FormTestRef {
  /**
   * `rowKey` is a key `add row to items with qty = 2` names relative to the new row: `text` is
   * the key and `collection` the collection path it belongs to, so a rename of the field inside
   * the section reaches the key (a bare `path` ref `qty` would read as an unknown field).
   */
  kind: "path" | "page" | "journey" | "layout" | "code" | "host" | "collection" | "rowKey";
  text: string;
  /** The collection path of a `rowKey` ref; absent for every other kind. */
  collection?: string;
  span: FormTestSpan;
}

export type FormTestGiven =
  | { kind: "given"; key: "today"; value: string; line: number }
  | { kind: "given"; key: "locale"; value: string; line: number }
  /** `given journey = main`; `none` is the whole form on one page. */
  | { kind: "given"; key: "journey"; value: string; line: number }
  /** `given host.role = "admin"`: `name` is the part after `host.`. */
  | { kind: "given"; key: "host"; name: string; value: FormTestValue; line: number }
  /** `given options for province = ("ON", "QC")`: the options of a data-source-backed choice. */
  | { kind: "given"; key: "options"; path: string; values: FormTestValue[]; line: number };

export type FormTestState =
  | "visible" | "hidden" | "required" | "optional" | "enabled" | "disabled" | "readonly" | "editable" | "empty" | "notEmpty";

export type FormTestAction =
  | { kind: "set"; path: string; value: FormTestValue; line: number }
  | { kind: "clear"; path: string; line: number }
  | { kind: "addRow"; path: string; values?: Record<string, FormTestValue>; line: number }
  /** `remove row 0 of items`: the engine's 0-based index. */
  | { kind: "removeRow"; path: string; index: number; line: number }
  | { kind: "continue"; line: number }
  | { kind: "back"; line: number }
  | { kind: "goTo"; page: string; line: number }
  /** `change <path>`: a Check answers page's Change link on that answer (the step that asks it opens, the return target set). */
  | { kind: "change"; path: string; line: number }
  | { kind: "check"; line: number }
  | { kind: "submit"; line: number };

export type FormTestExpectation =
  | { kind: "expectState"; path: string; state: FormTestState; line: number }
  | { kind: "expectValue"; path: string; op: "eq" | "ne"; value: FormTestValue; line: number }
  /** `expect <formula>`: the formula's text and the tree `kernelParseFormula` gave it. */
  | { kind: "expectFormula"; formula: string; expression: Expression; line: number }
  /** `expect error on x` (any code) or `expect error on x: required`. */
  | { kind: "expectError"; path: string; code?: string; line: number }
  | { kind: "expectMessage"; path: string; message: string; line: number }
  /** `expect no error on x`, or `expect no errors` when `path` is absent. */
  | { kind: "expectNoError"; path?: string; line: number }
  | { kind: "expectVerdict"; verdict: "accepted" | "refused"; line: number }
  | { kind: "expectPage"; page: string; line: number }
  | { kind: "expectPath"; pages: string[]; line: number }
  /** `expect path ends` (runs off the end) or `expect path ends at stop` (an exit page). */
  | { kind: "expectPathEnd"; exit?: string; line: number }
  | { kind: "expectOnPath"; page: string; on: boolean; line: number }
  | { kind: "expectSubmitted"; path: string; value: FormTestValue; line: number }
  | { kind: "expectWithheld"; path: string; line: number }
  | { kind: "expectRows"; path: string; count: number; line: number }
  | { kind: "expectLayout"; layout: string; line: number };

export type FormTestStatement = FormTestAction | FormTestExpectation;

export interface FormTestScenario {
  name: string;
  nameSpan: FormTestSpan;
  /** `skip "reason"` under the header. */
  skip?: string;
  givens: FormTestGiven[];
  steps: FormTestStatement[];
  /** Every path, page, journey, layout, code and host key the scenario names, in source order. */
  refs: FormTestRef[];
  /** The header's line. */
  line: number;
  /** The span of the whole block in the source. */
  span: FormTestSpan;
}

/**
 * A parse problem: a code and parameters, never a sentence (the builder words it from its
 * catalog, the CLI from its own table).
 */
export interface FormTestProblem {
  code: FormTestProblemCode;
  line: number;
  start: number;
  end: number;
  params?: Record<string, string | number>;
}

export type FormTestProblemCode =
  | "unknownStatement"
  | "expectedName"
  /** Two `test` blocks of one source with one name: results are keyed by name, so they could not be told apart. */
  | "duplicateName"
  | "expectedPath"
  | "expectedValue"
  | "expectedPage"
  | "expectedNumber"
  | "expectedEquals"
  | "expectedKeyword"
  | "badState"
  | "badCode"
  | "badGiven"
  | "givenAfterStep"
  | "duplicateGiven"
  | "skipAfterStep"
  | "stepOutsideTest"
  | "unterminatedString"
  | "unclosedList"
  | "badFormula"
  | "trailingText"
  | "tooLong";

export interface FormTestParseResult {
  ok: boolean;
  scenarios: FormTestScenario[];
  problems: FormTestProblem[];
}

/** One error a snapshot carries, as `FormError` carries it. */
export interface FormTestSnapshotError {
  componentId?: string;
  path?: string;
  code: string;
  stage: string;
  message?: string;
}

/**
 * What a driver reports after each action: facts the fold, the pipeline and the path already
 * produce, nothing a driver works out on its own. Both drivers fill the same shape, so an
 * expectation never knows which side it judges.
 */
export interface FormTestSnapshot {
  /** Each component's effective state, by id (visibility, disabled, readonly, submitValue). */
  effective: Record<string, EffectiveNodeState>;
  /** Each component's requiredness after the hidden-required policy, by id. */
  required: Record<string, boolean>;
  /** The settled view the rules read, keyed by component id (`idValues`). */
  values: Record<string, unknown>;
  /** The answers keyed by value path, as the envelope carries them (`submittableValues`). */
  byPath: Record<string, unknown>;
  errors: FormTestSnapshotError[];
  /** The current page, with a journey. */
  page?: string;
  trace?: JourneyTrace;
  /** After `submit` or `check`. */
  verdict?: "accepted" | "refused";
  /** The envelope's values after an accepted `submit`, keyed by value path. */
  submitted?: Record<string, unknown>;
  /** The value paths the fold withheld (hidden and excluded, or off the path), after `submit` or `check`. */
  withheld?: string[];
  /** Row counts by collection path. */
  rows: Record<string, number>;
  /** The PDF layout the answers choose, when the form has layouts. */
  layout?: string;
  /** Component ids whose rules this side could not replay, with the reason: the expectation skips. */
  unreplayable?: Record<string, FormTestSkipReason>;
  /**
   * Set when a rule this side could not replay could decide the run's verdict (a `host.` or
   * browser-scoped requiredness, say): an expectation about the verdict as a whole (`expect
   * accepted`, `expect no errors`, `expect submitted x`) skips with this reason instead of
   * judging a verdict the other side's rule may have changed.
   */
  verdictUnreplayable?: FormTestSkipReason;
  /**
   * Set when the journey's path (a route's `when`) reads a component this side
   * could not replay: the path, the page, what was withheld and what was submitted all follow it,
   * so those expectations skip with this reason instead of judging a path drawn over absent data.
   */
  traceUnreplayable?: FormTestSkipReason;
  /**
   * The page ids of the journey the run follows, in the journey's order (not only those on the
   * path); empty without a journey. `expect <page> on path` and `off path` need them to tell a
   * page that is off the path from a page the journey does not have, which is `expect.unknownPage`.
   */
  pages: string[];
}

export type FormTestSkipReason =
  | "unreplayable.host"
  | "unreplayable.server"
  | "unreplayable.secret"
  | "unreplayable.clock"
  /** A rule the form runs only in the browser (`run: "browser"`): the kernel does not apply it. */
  | "unreplayable.browser"
  /** A calculation that reads an answer the kernel was not sent, so it keeps the value as sent. */
  | "unreplayable.clientDerived";

/** Evaluates an `expect <formula>` tree over id-keyed values (the engine's `evaluateExpression`, or the kernel's). */
export type FormTestEvaluate = (expression: Expression, values: Record<string, unknown>) => unknown;

export type FormTestDriverResult<T> = T | Promise<T>;

/**
 * A side the runner drives. Every method may answer synchronously or with a promise; the
 * runner awaits either. An action the form refuses (Continue off a page with errors) is not a
 * failure: the driver leaves the state where the form keeps it and the next snapshot says so.
 */
/** What `start` may refuse: the scenario then ends as `error` with this reason and no step runs. */
export type FormTestStartError =
  | "scenario.clockUnset"
  | "scenario.unknownJourney"
  | "scenario.badGiven"
  /** The definition's formulas do not compile under the policy in force (`fail`); `params.problems` lists the first five as `{ code, where }`. */
  | "scenario.formulaInvalid";

/**
 * An action the form refuses (more rows than `maxRows`, a remove below `minRows`, a row that
 * is not there, a list set on a field that holds one value or given to one in an added row's
 * cell, its `path` that cell's), reported as a coded refusal instead
 * of a thrown sentence: the runner records `action.refused` with `params: { action, reason,
 * ...params }` and ends the scenario as `error`. `reason` is one of `rows.max`, `rows.min`,
 * `operations.add`, `operations.remove`, `rowOutOfRange`, `unknownCollection`, `value.notScalar`; a `change` line's are `change.notReview`,
 * `change.off`, `change.notListed` and `change.unreachable`.
 */
export interface FormTestRefusal {
  refused: string;
  params?: Record<string, unknown>;
}

export interface FormTestDriver {
  /**
   * Called once with the scenario's givens before any step. A returned error ends the scenario
   * as `error`; a returned `skip` ends it as `skipped` with that reason and runs no step: the
   * scenario is not this side's to judge (a driver that cannot take the givens at all; the
   * engine's two drivers take every given, a `host.` one included).
   */
  start(
    givens: FormTestGiven[]
  ): FormTestDriverResult<void | { error: FormTestStartError; params?: Record<string, unknown> } | { skip: FormTestSkipReason }>;
  set(path: string, value: FormTestValue): FormTestDriverResult<void | FormTestRefusal>;
  clear(path: string): FormTestDriverResult<void>;
  addRow(path: string, values?: Record<string, FormTestValue>): FormTestDriverResult<void | FormTestRefusal>;
  removeRow(path: string, index: number): FormTestDriverResult<void | FormTestRefusal>;
  continue(): FormTestDriverResult<void>;
  back(): FormTestDriverResult<void>;
  goTo(page: string): FormTestDriverResult<void>;
  /**
   * A Change link on the Check answers page the scenario stands on: opens the step that asks the
   * answer at `path`, with the return target set. Refused (`change.notReview`, `change.off`,
   * `change.notListed`, `change.unreachable`) when the page has no such row to press.
   */
  change(path: string): FormTestDriverResult<void | FormTestRefusal>;
  check(): FormTestDriverResult<void>;
  submit(): FormTestDriverResult<void>;
  snapshot(): FormTestDriverResult<FormTestSnapshot>;
  evaluate: FormTestEvaluate;
  /** The component that owns a value path (rows included), for `expect items[0].qty required` and the like. */
  componentIdOf(path: string): string | undefined;
  /**
   * The component's `type`, so `expect x empty` reads emptiness as the validation does (a
   * checkbox group with nothing ticked is empty, an unchecked checkbox is empty). Optional:
   * absent, emptiness is read by the value alone.
   */
  typeOf?(componentId: string): string | undefined;
  dispose?(): FormTestDriverResult<void>;
}

export type FormTestStepStatus = "passed" | "failed" | "skipped" | "error" | "ran";

/** What a step came to. `expected` and `actual` are data for the catalog to word, never sentences. */
export interface FormTestStepResult {
  line: number;
  status: FormTestStepStatus;
  /** `expect.visible`, `expect.value`, `expect.path`, `action.failed`, `scenario.clockUnset`, a skip reason, … */
  code?: string;
  expected?: unknown;
  actual?: unknown;
  params?: Record<string, unknown>;
}

export type FormTestScenarioStatus = "passed" | "failed" | "skipped" | "error";

export interface FormTestScenarioResult {
  name: string;
  status: FormTestScenarioStatus;
  /** The skip reason, or the error code for `error`. */
  reason?: string;
  /** What the error code is about (which given, which path), as the driver reported it. */
  params?: Record<string, unknown>;
  steps: FormTestStepResult[];
}

/**
 * One scenario as the sandbox's `test` op reports it: the
 * runner's result, with the definition entry it came from (`id`, absent for sidecar text) and
 * the line of its `test` header.
 */
export interface FormTestOpScenarioReport extends FormTestScenarioResult {
  id?: string;
  line: number;
}

/** A parse problem as the `test` op reports it: the parser's, with the definition entry it is in (`id`, absent for sidecar text). */
export interface FormTestOpProblemReport extends FormTestProblem {
  id?: string;
}

/**
 * What the `test` op answers: every scenario that parsed, in source order, the
 * counts by status, and every parse problem. The kernel's reading only: a scenario the kernel
 * cannot judge skips as the kernel driver skips it.
 */
export interface FormTestOpReport {
  scenarios: FormTestOpScenarioReport[];
  summary: { total: number; passed: number; failed: number; skipped: number; error: number };
  problems: FormTestOpProblemReport[];
}

/** The runner's bounds: statements per scenario, so a runaway test ends. */
export const FORM_TEST_MAX_STEPS = 1000;

/** `FormDefinition.tests`: one `test` block per entry, name included. */
export interface FormTestConfiguration {
  scenarios: FormTestScenarioEntry[];
}

export interface FormTestScenarioEntry {
  /** The builder's handle; stable across renames of the scenario. */
  id: string;
  /** One `test "…"` block, exactly as the author wrote it. */
  source: string;
}
