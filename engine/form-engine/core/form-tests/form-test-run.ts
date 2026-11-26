import type {
  FormTestAction,
  FormTestDriver,
  FormTestEvaluate,
  FormTestExpectation,
  FormTestRefusal,
  FormTestScenario,
  FormTestScenarioResult,
  FormTestScenarioStatus,
  FormTestSnapshot,
  FormTestSnapshotError,
  FormTestStatement,
  FormTestStepResult
} from "./form-test-types.js";
import { FORM_TEST_MAX_STEPS } from "./form-test-types.js";
import { kernelJsonValue, kernelOwn, kernelRecord } from "../state/submittable-fold.js";
import { kernelIsEmptyValue } from "../schema/answer-kinds.js";
import { kernelExprAsBoolean, kernelExprReadPaths } from "../../rules/evaluator/evaluator.js";

/**
 * The judge and the runner of form tests.
 *
 * The judge, {@link kernelFormTestJudge}, decides one expectation against one snapshot. It is
 * kernel-shaped, like the path engine (`core/journey/journey-path.ts`) and the formula parser
 * (`core/expressions/formula.ts`): top-level `function` declarations named `kernel*`, no
 * classes, no clock, no locale, no `Math.random`, no thrown errors (a failure is a result
 * with a code), and records built without a prototype, because ids, paths and codes come from
 * an author and may spell `constructor` or `__proto__`. The point is that the one judge can
 * later run in the browser and inside the sandbox program, so a host re-running a form's
 * tests reaches the verdicts the builder showed. The judge is spliced into the
 * sandbox program for the `test` op through
 * {@link FORM_TEST_RUN_FUNCTIONS}, which lists its own functions; a change here changes what the
 * sandbox programs answer once they are rebuilt. Beside
 * those it calls kernel functions that already travel in the kernel's lists:
 * `kernelOwn` and `kernelJsonValue` (`submittable-fold.ts`), `kernelIsEmptyValue`
 * (`schema/answer-kinds.ts`, which the kernel re-exports) and `kernelExprAsBoolean` and
 * `kernelExprReadPaths` (`evaluator.ts`).
 *
 * The runner ({@link runFormTestScenario}) is ordinary engine code: it walks a scenario's
 * steps against a {@link FormTestDriver}, awaiting each call, and gathers what the judge says.
 * Codes, not sentences, cross every boundary here (`expect.visible`, `action.failed`, a skip
 * reason); the builder and the CLI word them from their own catalogs.
 */

/** The judge's view of the side it judges: the driver's lookups, nothing that acts. */
export interface FormTestJudgeContext {
  /** The component that owns a value path, or `undefined` when the form has none. */
  componentIdOf(path: string): string | undefined;
  /** The component's `type`, for emptiness; absent, emptiness is read by the value alone. */
  typeOf?(componentId: string): string | undefined;
  evaluate: FormTestEvaluate;
}

function kernelFormTestJudgeResult(line: number, status: "passed" | "failed" | "skipped", code: string | undefined): FormTestStepResult {
  const result = kernelRecord() as unknown as FormTestStepResult;
  result.line = line;
  result.status = status;
  if (code !== undefined) {
    result.code = code;
  }
  return result;
}

function kernelFormTestJudgePass(line: number): FormTestStepResult {
  return kernelFormTestJudgeResult(line, "passed", undefined);
}

function kernelFormTestJudgeSkip(line: number, reason: string): FormTestStepResult {
  return kernelFormTestJudgeResult(line, "skipped", reason);
}

/** A failure: `expected` and `actual` are data for the catalog to word, `params` names what the sentence needs. */
function kernelFormTestJudgeFail(
  line: number,
  code: string,
  expected: unknown,
  actual: unknown,
  params: Record<string, unknown> | undefined
): FormTestStepResult {
  const result = kernelFormTestJudgeResult(line, "failed", code);
  if (expected !== undefined) {
    result.expected = expected;
  }
  if (actual !== undefined) {
    result.actual = actual;
  }
  if (params !== undefined) {
    result.params = params;
  }
  return result;
}

/**
 * Two JSON values the way the envelope compares them, once both are normalised: `null` is
 * `undefined` is absent, numbers by value, strings exact, booleans, lists item by item in
 * order, records key by key.
 */
function kernelFormTestSame(left: unknown, right: unknown): boolean {
  if ((left === null || left === undefined) && (right === null || right === undefined)) {
    return true;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!kernelFormTestSame(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") {
      return false;
    }
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
      return false;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !kernelFormTestSame(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return left === right;
}

/** {@link kernelFormTestSame} after both sides are read as the envelope carries them (`kernelJsonValue`: `-0` is `0`, a non-finite number is `null`). */
function kernelFormTestEqual(left: unknown, right: unknown): boolean {
  return kernelFormTestSame(kernelJsonValue(left), kernelJsonValue(right));
}

/**
 * The keys a checkbox group's flags record holds `true` (`{ news: true, offers: false }` ->
 * `["news"]`), or `undefined` when the value is not such a record. A plain record only; with
 * the component's type known to be `checkboxes` any record reads (only a `true` ticks an
 * option), without a type every value must be a boolean, so a record of anything else is not
 * mistaken for a group. A group of a known `checkboxes` type with no value at all (never
 * touched) has no ticked option either, so it reads as no keys: `()` holds for it as it does
 * for a group that was ticked and cleared.
 */
function kernelFormTestFlagKeys(value: unknown, type: string | undefined): string[] | undefined {
  if (value === null || value === undefined) {
    return type === "checkboxes" ? [] : undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const key of Object.keys(record)) {
    const flag = record[key];
    if (type !== "checkboxes" && typeof flag !== "boolean") {
      return undefined;
    }
    if (flag === true) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Whether a list literal names exactly the given keys, order and repeats aside (a group holds
 * a set of ticked options). An item that is neither a string nor a number is no option.
 */
function kernelFormTestListIsSet(list: unknown[], keys: string[]): boolean {
  const wanted = kernelRecord() as Record<string, boolean>;
  for (const key of keys) {
    wanted[key] = true;
  }
  const seen = kernelRecord() as Record<string, boolean>;
  for (const item of list) {
    if (typeof item !== "string" && typeof item !== "number") {
      return false;
    }
    const key = "" + item;
    if (wanted[key] !== true) {
      return false;
    }
    seen[key] = true;
  }
  return Object.keys(seen).length === keys.length;
}

/**
 * {@link kernelFormTestEqual} for a value read at a component of `type`: a list literal and a
 * checkbox group's flags record are equal when the list names exactly the record's `true` keys,
 * in any order (the group holds a set; a side that stores the unpicked options as `false` and a
 * side that does not agree on what is ticked). Everything else is compared as the envelope does.
 */
function kernelFormTestEqualAs(actual: unknown, expected: unknown, type: string | undefined): boolean {
  const left = kernelJsonValue(actual);
  const right = kernelJsonValue(expected);
  if (Array.isArray(right)) {
    const keys = kernelFormTestFlagKeys(left, type);
    if (keys !== undefined) {
      return kernelFormTestListIsSet(right, keys);
    }
  } else if (Array.isArray(left) && right !== null && right !== undefined) {
    // A list actual against an expected record; `null` stays `null` (an empty list is not it).
    const keys = kernelFormTestFlagKeys(right, type);
    if (keys !== undefined) {
      return kernelFormTestListIsSet(left, keys);
    }
  }
  return kernelFormTestSame(left, right);
}

/** The component's `type` when the context can say, else `undefined`. */
function kernelFormTestTypeOf(context: FormTestJudgeContext, id: string | undefined): string | undefined {
  return context.typeOf === undefined || id === undefined ? undefined : context.typeOf(id);
}

/** A value as a result reports it: absent is `null`, so the data survives a JSON boundary as it was read. */
function kernelFormTestReported(value: unknown): unknown {
  const reported = kernelJsonValue(value);
  return reported === undefined ? null : reported;
}

/** The path an expectation names, when it names one (`expect no errors` names none). */
function kernelFormTestNamedPath(statement: FormTestExpectation): string | undefined {
  switch (statement.kind) {
    case "expectState":
    case "expectValue":
    case "expectError":
    case "expectMessage":
    case "expectNoError":
    case "expectSubmitted":
    case "expectWithheld":
    case "expectRows":
      return statement.path;
    default:
      return undefined;
  }
}

/** Whether an expectation reads the run's verdict as a whole: `expect accepted`, `expect no errors`, `expect submitted x` (which exists only once a submit was accepted). */
function kernelFormTestAboutVerdict(statement: FormTestExpectation): boolean {
  return statement.kind === "expectVerdict" || statement.kind === "expectSubmitted" || (statement.kind === "expectNoError" && statement.path === undefined);
}

/** Whether an expectation reads what the journey's path decides: the page, the path, a page on it, what was withheld or submitted. */
function kernelFormTestAboutTrace(statement: FormTestExpectation): boolean {
  return (
    statement.kind === "expectPage" ||
    statement.kind === "expectPath" ||
    statement.kind === "expectPathEnd" ||
    statement.kind === "expectOnPath" ||
    statement.kind === "expectWithheld" ||
    statement.kind === "expectSubmitted"
  );
}

/**
 * The skip reason of the first component an `expect <formula>` reads that the snapshot marks
 * unreplayable, else `undefined`. A formula names no path of its own, so the field skip cannot
 * reach it: without this a formula over a calculation this side did not work out would be judged
 * on the missing value. The names a formula reads are component ids (found as ids first, then
 * as value paths); a scope read (`host.`, `row.`, `ancestor.`) is no component.
 */
function kernelFormTestFormulaReason(
  statement: Extract<FormTestExpectation, { kind: "expectFormula" }>,
  snapshot: FormTestSnapshot,
  context: FormTestJudgeContext
): string | undefined {
  if (snapshot.unreplayable === undefined) {
    return undefined;
  }
  for (const path of kernelExprReadPaths(statement.expression)) {
    if (path.indexOf("host.") === 0 || path.indexOf("row.") === 0 || path.indexOf("ancestor.") === 0) {
      continue;
    }
    let reason = kernelOwn(snapshot.unreplayable, path);
    if (reason === undefined) {
      const id = context.componentIdOf(path);
      reason = id === undefined ? undefined : kernelOwn(snapshot.unreplayable, id);
    }
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

/**
 * The params of the first read of an `expect <formula>` that cannot be judged, else `undefined`.
 * A formula over a field the form does not have (a typo, a renamed field) must fail rather than
 * pass on the missing value: `expect t = nosuchfield` would otherwise compare nothing to nothing.
 * Formulas read component ids, as rules do, and the snapshot's `values` are keyed by id, so a
 * read is accepted only when the snapshot lists a component of that id; a value path that is
 * no id (a `dataKey`, say) reads nothing and fails too, with `id` naming the component the path
 * belongs to as a hint. A `row.` or `ancestor.` read fails with `reason: "noRowScope"`: a scenario
 * has no row in scope, so the read would come to null and pass vacuously. A `host.` read is
 * left to the evaluator.
 */
function kernelFormTestFormulaUnknown(
  statement: Extract<FormTestExpectation, { kind: "expectFormula" }>,
  snapshot: FormTestSnapshot,
  context: FormTestJudgeContext
): Record<string, unknown> | undefined {
  for (const path of kernelExprReadPaths(statement.expression)) {
    if (path.indexOf("host.") === 0) {
      continue;
    }
    const missing = kernelRecord() as Record<string, unknown>;
    missing.path = path;
    if (path.indexOf("row.") === 0 || path.indexOf("ancestor.") === 0) {
      missing.reason = "noRowScope";
      return missing;
    }
    if (kernelOwn(snapshot.effective, path) !== undefined) {
      continue;
    }
    const id = context.componentIdOf(path);
    if (id !== undefined) {
      missing.id = id;
    }
    return missing;
  }
  return undefined;
}

/**
 * Whether `path` names a row that is not there (`items[3].qty` over a snapshot that counts two
 * rows of `items`). Only a collection the snapshot lists is judged, so a path the snapshot
 * cannot count is left to the other checks.
 */
function kernelFormTestRowOutOfRange(path: string, snapshot: FormTestSnapshot): boolean {
  let from = 0;
  while (from < path.length) {
    const open = path.indexOf("[", from);
    if (open < 0) {
      return false;
    }
    const close = path.indexOf("]", open);
    if (close < 0) {
      return false;
    }
    const digits = path.slice(open + 1, close);
    if (digits.length > 0 && digits.length < 10 && /^\d+$/.test(digits)) {
      const count = kernelOwn(snapshot.rows, path.slice(0, open));
      if (count !== undefined && Number(digits) >= count) {
        return true;
      }
    }
    from = close + 1;
  }
  return false;
}

/** Whether the statement is one whose named path must be a row that exists: a state, a value, an error, a message, a submitted answer or a withheld one. */
function kernelFormTestNeedsRow(statement: FormTestExpectation): boolean {
  return (
    statement.kind === "expectState" ||
    statement.kind === "expectValue" ||
    statement.kind === "expectError" ||
    statement.kind === "expectMessage" ||
    statement.kind === "expectSubmitted" ||
    statement.kind === "expectWithheld" ||
    (statement.kind === "expectNoError" && statement.path !== undefined)
  );
}

/**
 * The errors on one field. An error that names its value path is on that path and no other: the
 * rows of a repeating section share one component id, so matching the id as well would make an
 * error on `items[1].qty` an error on `items[0].qty`. Only an error with no path (one on a
 * whole component) is matched by its component id.
 */
function kernelFormTestErrorsOn(snapshot: FormTestSnapshot, id: string, path: string): FormTestSnapshotError[] {
  const found: FormTestSnapshotError[] = [];
  for (const error of snapshot.errors) {
    if (error.path !== undefined ? error.path === path : error.componentId === id) {
      found.push(error);
    }
  }
  return found;
}

function kernelFormTestErrorReport(error: FormTestSnapshotError): Record<string, unknown> {
  const entry = kernelRecord() as Record<string, unknown>;
  if (error.path !== undefined) {
    entry.path = error.path;
  } else if (error.componentId !== undefined) {
    entry.componentId = error.componentId;
  }
  entry.code = error.code;
  return entry;
}

/** `expectState`: one boolean fact about a component, read from the snapshot's effective state, requiredness and answers. */
function kernelFormTestJudgeState(
  statement: Extract<FormTestExpectation, { kind: "expectState" }>,
  snapshot: FormTestSnapshot,
  id: string,
  context: FormTestJudgeContext
): FormTestStepResult {
  const line = statement.line;
  const params = kernelRecord() as Record<string, unknown>;
  params.path = statement.path;
  const effective = kernelOwn(snapshot.effective, id);
  if (effective === undefined) {
    return kernelFormTestJudgeFail(line, "expect.unknownField", undefined, undefined, params);
  }
  let holds = false;
  switch (statement.state) {
    case "visible":
      holds = effective.visible === true;
      break;
    case "hidden":
      holds = effective.visible !== true;
      break;
    case "required":
      holds = kernelOwn(snapshot.required, id) === true;
      break;
    case "optional":
      holds = kernelOwn(snapshot.required, id) !== true;
      break;
    case "enabled":
      holds = effective.disabled !== true;
      break;
    case "disabled":
      holds = effective.disabled === true;
      break;
    case "readonly":
      holds = effective.readonly === true;
      break;
    case "editable":
      holds = effective.readonly !== true;
      break;
    case "empty":
    case "notEmpty": {
      const type = context.typeOf === undefined ? undefined : context.typeOf(id);
      const empty = kernelIsEmptyValue(kernelOwn(snapshot.byPath, statement.path), type === undefined ? "" : type);
      holds = statement.state === "empty" ? empty : !empty;
      break;
    }
    default:
      return kernelFormTestJudgeFail(line, "expect.badState", undefined, undefined, params);
  }
  if (holds) {
    return kernelFormTestJudgePass(line);
  }
  return kernelFormTestJudgeFail(line, "expect." + statement.state, true, holds, params);
}

/** The journey expectations: they read the page and the trace, and say `expect.noJourney` when the run has none. */
function kernelFormTestJudgeJourney(statement: FormTestExpectation, snapshot: FormTestSnapshot): FormTestStepResult {
  const line = statement.line;
  if (statement.kind === "expectPage") {
    if (snapshot.page === undefined) {
      return kernelFormTestJudgeFail(line, "expect.noJourney", statement.page, undefined, undefined);
    }
    return snapshot.page === statement.page
      ? kernelFormTestJudgePass(line)
      : kernelFormTestJudgeFail(line, "expect.page", statement.page, snapshot.page, undefined);
  }
  const trace = snapshot.trace;
  if (trace === undefined) {
    const expected = statement.kind === "expectPath" ? statement.pages : undefined;
    return kernelFormTestJudgeFail(line, "expect.noJourney", expected, undefined, undefined);
  }
  if (statement.kind === "expectPath") {
    return kernelFormTestSame(statement.pages, trace.pages)
      ? kernelFormTestJudgePass(line)
      : kernelFormTestJudgeFail(line, "expect.path", statement.pages, trace.pages, undefined);
  }
  if (statement.kind === "expectPathEnd") {
    const last = trace.pages.length > 0 ? trace.pages[trace.pages.length - 1] : undefined;
    const expected = kernelRecord() as Record<string, unknown>;
    const actual = kernelRecord() as Record<string, unknown>;
    expected.end = statement.exit === undefined ? "end" : "exit";
    actual.end = trace.end;
    if (statement.exit !== undefined) {
      expected.last = statement.exit;
    }
    // The path's last page whenever it has one, so Accept can write `path ends
    // at <page>` for a scenario that expected a plain end; `null` only where an exit was expected.
    if (last !== undefined) {
      actual.last = last;
    } else if (statement.exit !== undefined) {
      actual.last = null;
    }
    const holds = statement.exit === undefined ? trace.end === "end" : trace.end === "exit" && last === statement.exit;
    return holds ? kernelFormTestJudgePass(line) : kernelFormTestJudgeFail(line, "expect.pathEnd", expected, actual, undefined);
  }
  if (statement.kind === "expectOnPath") {
    const on = trace.pages.indexOf(statement.page) !== -1;
    const params = kernelRecord() as Record<string, unknown>;
    params.page = statement.page;
    // A page the journey does not have is off every path, so `expect x off path` would pass on
    // a typo. The snapshot lists the journey's pages when the side can say (otherwise the path
    // alone decides, as before).
    if (snapshot.pages !== undefined && snapshot.pages.indexOf(statement.page) === -1 && !on) {
      return kernelFormTestJudgeFail(line, "expect.unknownPage", undefined, undefined, params);
    }
    return on === statement.on
      ? kernelFormTestJudgePass(line)
      : kernelFormTestJudgeFail(line, "expect.onPath", statement.on, on, params);
  }
  return kernelFormTestJudgeFail(line, "expect.badStatement", undefined, undefined, undefined);
}

/**
 * Judges one expectation against a snapshot. Order of checks: the field the expectation
 * names must exist (`expect.unknownField`), then a field whose rules this side could not
 * replay skips with the reason the snapshot gives (so does an expectation about the verdict as
 * a whole, when the snapshot says a rule it could not replay might have decided it), then the
 * expectation itself. Every result carries the statement's `line`.
 */
export function kernelFormTestJudge(
  statement: FormTestExpectation,
  snapshot: FormTestSnapshot,
  context: FormTestJudgeContext
): FormTestStepResult {
  const line = statement.line;
  const path = kernelFormTestNamedPath(statement);
  let id: string | undefined;
  if (path !== undefined) {
    id = context.componentIdOf(path);
    if (id === undefined) {
      const params = kernelRecord() as Record<string, unknown>;
      params.path = path;
      return kernelFormTestJudgeFail(line, "expect.unknownField", undefined, undefined, params);
    }
    // A row the form does not have holds no answer, state or error: naming one is a mistake in
    // the scenario, not a fact to read as empty (it would pass `expect no error` vacuously).
    if (kernelFormTestNeedsRow(statement) && kernelFormTestRowOutOfRange(path, snapshot)) {
      const params = kernelRecord() as Record<string, unknown>;
      params.path = path;
      params.reason = "rowOutOfRange";
      return kernelFormTestJudgeFail(line, "expect.unknownField", undefined, undefined, params);
    }
    const reason = snapshot.unreplayable === undefined ? undefined : kernelOwn(snapshot.unreplayable, id);
    if (reason !== undefined) {
      return kernelFormTestJudgeSkip(line, reason);
    }
  }
  // An expectation about the run as a whole has no field to skip on: when a rule this side
  // could not replay might have decided the verdict, it skips with the snapshot's reason.
  if (snapshot.verdictUnreplayable !== undefined && kernelFormTestAboutVerdict(statement)) {
    return kernelFormTestJudgeSkip(line, snapshot.verdictUnreplayable);
  }
  // Likewise for what the journey's path decides, when a route condition read something this
  // side could not replay: the path it drew is not the person's.
  if (snapshot.traceUnreplayable !== undefined && kernelFormTestAboutTrace(statement)) {
    return kernelFormTestJudgeSkip(line, snapshot.traceUnreplayable);
  }
  const named = kernelRecord() as Record<string, unknown>;
  if (path !== undefined) {
    named.path = path;
  }
  switch (statement.kind) {
    case "expectState":
      return kernelFormTestJudgeState(statement, snapshot, id as string, context);
    case "expectValue": {
      const actual = kernelOwn(snapshot.byPath, statement.path);
      const same = kernelFormTestEqualAs(actual, statement.value, kernelFormTestTypeOf(context, id));
      if (statement.op === "ne" ? !same : same) {
        return kernelFormTestJudgePass(line);
      }
      named.op = statement.op;
      return kernelFormTestJudgeFail(line, "expect.value", kernelFormTestReported(statement.value), kernelFormTestReported(actual), named);
    }
    case "expectFormula": {
      const unknown = kernelFormTestFormulaUnknown(statement, snapshot, context);
      if (unknown !== undefined) {
        return kernelFormTestJudgeFail(line, "expect.unknownField", undefined, undefined, unknown);
      }
      const unreplayable = kernelFormTestFormulaReason(statement, snapshot, context);
      if (unreplayable !== undefined) {
        return kernelFormTestJudgeSkip(line, unreplayable);
      }
      let result: unknown;
      let evaluated = true;
      try {
        result = context.evaluate(statement.expression, snapshot.values);
      } catch {
        evaluated = false;
      }
      // Read as every rule is read: only the boolean `true` holds.
      if (evaluated && kernelExprAsBoolean(result)) {
        return kernelFormTestJudgePass(line);
      }
      const params = kernelRecord() as Record<string, unknown>;
      params.formula = statement.formula;
      if (!evaluated) {
        params.evaluated = false;
      }
      return kernelFormTestJudgeFail(line, "expect.formula", true, kernelFormTestReported(result), params);
    }
    case "expectError": {
      const found = kernelFormTestErrorsOn(snapshot, id as string, statement.path);
      const codes: string[] = [];
      let matched = false;
      for (const error of found) {
        codes.push(error.code);
        if (statement.code === undefined || error.code === statement.code) {
          matched = true;
        }
      }
      return matched
        ? kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.error", statement.code === undefined ? null : statement.code, codes, named);
    }
    case "expectMessage": {
      const found = kernelFormTestErrorsOn(snapshot, id as string, statement.path);
      const messages: string[] = [];
      let matched = false;
      for (const error of found) {
        if (error.message !== undefined) {
          messages.push(error.message);
          if (error.message === statement.message) {
            matched = true;
          }
        }
      }
      return matched
        ? kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.message", statement.message, messages, named);
    }
    case "expectNoError": {
      const found = statement.path === undefined ? snapshot.errors : kernelFormTestErrorsOn(snapshot, id as string, statement.path);
      if (found.length === 0) {
        return kernelFormTestJudgePass(line);
      }
      const reports: Array<Record<string, unknown>> = [];
      for (const error of found) {
        reports.push(kernelFormTestErrorReport(error));
      }
      return kernelFormTestJudgeFail(line, "expect.noError", [], reports, path === undefined ? undefined : named);
    }
    case "expectVerdict":
      if (snapshot.verdict === undefined) {
        return kernelFormTestJudgeFail(line, "expect.noVerdict", statement.verdict, undefined, undefined);
      }
      return snapshot.verdict === statement.verdict
        ? kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.verdict", statement.verdict, snapshot.verdict, undefined);
    case "expectPage":
    case "expectPath":
    case "expectPathEnd":
    case "expectOnPath":
      return kernelFormTestJudgeJourney(statement, snapshot);
    case "expectSubmitted": {
      if (snapshot.submitted === undefined) {
        return kernelFormTestJudgeFail(line, "expect.notSubmitted", kernelFormTestReported(statement.value), undefined, named);
      }
      const actual = kernelOwn(snapshot.submitted, statement.path);
      return kernelFormTestEqualAs(actual, statement.value, kernelFormTestTypeOf(context, id))
        ?kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.submitted", kernelFormTestReported(statement.value), kernelFormTestReported(actual), named);
    }
    case "expectWithheld": {
      if (snapshot.withheld === undefined) {
        return kernelFormTestJudgeFail(line, "expect.notSubmitted", true, undefined, named);
      }
      const withheld = snapshot.withheld.indexOf(statement.path) !== -1;
      if (withheld) {
        return kernelFormTestJudgePass(line);
      }
      // What the submission carried for the path instead, so Accept can write
      // `expect submitted <path> = <value>`; only an accepted submit's envelope says it.
      if (snapshot.submitted !== undefined) {
        const sent = kernelOwn(snapshot.submitted, statement.path);
        if (sent !== undefined) {
          named.sent = kernelFormTestReported(sent);
        }
      }
      return kernelFormTestJudgeFail(line, "expect.withheld", true, false, named);
    }
    case "expectRows": {
      const found = kernelOwn(snapshot.rows, statement.path);
      if (found === undefined) {
        // Both drivers list every collection, a section with no row at `0`: a path they do not
        // list is no collection, and counting it `0` would pass `rows of name = 0` on a typo.
        return kernelFormTestJudgeFail(line, "expect.unknownField", undefined, undefined, named);
      }
      const count = found;
      return count === statement.count
        ? kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.rows", statement.count, count, named);
    }
    case "expectLayout":
      return snapshot.layout === statement.layout
        ? kernelFormTestJudgePass(line)
        : kernelFormTestJudgeFail(line, "expect.layout", statement.layout, snapshot.layout === undefined ? null : snapshot.layout, undefined);
    default:
      return kernelFormTestJudgeFail(line, "expect.badStatement", undefined, undefined, undefined);
  }
}

/** The judge's functions, for the sandbox program to splice in when hosts run form tests. */
export const FORM_TEST_RUN_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelFormTestJudgeResult,
  kernelFormTestJudgePass,
  kernelFormTestJudgeSkip,
  kernelFormTestJudgeFail,
  kernelFormTestSame,
  kernelFormTestEqual,
  kernelFormTestFlagKeys,
  kernelFormTestListIsSet,
  kernelFormTestEqualAs,
  kernelFormTestTypeOf,
  kernelFormTestReported,
  kernelFormTestNamedPath,
  kernelFormTestAboutVerdict,
  kernelFormTestAboutTrace,
  kernelFormTestFormulaReason,
  kernelFormTestFormulaUnknown,
  kernelFormTestRowOutOfRange,
  kernelFormTestNeedsRow,
  kernelFormTestErrorsOn,
  kernelFormTestErrorReport,
  kernelFormTestJudgeState,
  kernelFormTestJudgeJourney,
  kernelFormTestJudge
];

function isAction(statement: FormTestStatement): statement is FormTestAction {
  return statement.kind.indexOf("expect") !== 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function perform(driver: FormTestDriver, action: FormTestAction): Promise<void | FormTestRefusal> {
  switch (action.kind) {
    case "set":
      return driver.set(action.path, action.value);
    case "clear":
      return driver.clear(action.path);
    case "addRow":
      return driver.addRow(action.path, action.values);
    case "removeRow":
      return driver.removeRow(action.path, action.index);
    case "continue":
      return driver.continue();
    case "back":
      return driver.back();
    case "goTo":
      return driver.goTo(action.page);
    case "change":
      return driver.change(action.path);
    case "check":
      return driver.check();
    case "submit":
      return driver.submit();
  }
}

/** A scenario that never reaches a driver: `skip`, or too many statements. */
function settledBeforeStart(scenario: FormTestScenario): FormTestScenarioResult | undefined {
  if (scenario.skip !== undefined) {
    return { name: scenario.name, status: "skipped", reason: scenario.skip, steps: [] };
  }
  if (scenario.steps.length > FORM_TEST_MAX_STEPS) {
    return { name: scenario.name, status: "error", reason: "scenario.tooManySteps", steps: [] };
  }
  return undefined;
}

/**
 * Any failed step fails the scenario; else any error makes it an error; else a scenario whose
 * every expectation skipped is skipped, with the first skip's code as its reason; else it
 * passed (a scenario with no expectations passes: it only had to run).
 */
function scenarioOutcome(steps: FormTestStepResult[]): { status: FormTestScenarioStatus; reason?: string } {
  let error = false;
  let expectations = 0;
  let skippedCount = 0;
  let firstSkip: string | undefined;
  for (const step of steps) {
    if (step.status === "failed") {
      return { status: "failed" };
    }
    if (step.status === "error") {
      error = true;
    }
    if (step.status === "passed" || step.status === "skipped") {
      expectations += 1;
    }
    if (step.status === "skipped") {
      skippedCount += 1;
      firstSkip ??= step.code;
    }
  }
  if (error) {
    return { status: "error" };
  }
  if (expectations > 0 && skippedCount === expectations) {
    return firstSkip === undefined ? { status: "skipped" } : { status: "skipped", reason: firstSkip };
  }
  return { status: "passed" };
}

/**
 * Runs one scenario against a driver the caller made; the driver is disposed when the run
 * ends, even on an error. An action the driver refuses by throwing ends the walk as an
 * `action.failed` error; a row action the form turns down comes back as a coded refusal and
 * ends it as `action.refused` (`params.action`, `params.reason`); any other action the form
 * itself refuses is not a failure (the next snapshot says where the form kept the state). One snapshot serves a run of consecutive expectations
 * and is taken again after the next action.
 */
export async function runFormTestScenario(scenario: FormTestScenario, driver: FormTestDriver): Promise<FormTestScenarioResult> {
  try {
    const settled = settledBeforeStart(scenario);
    if (settled !== undefined) {
      return settled;
    }
    try {
      const started = await driver.start(scenario.givens);
      if (started !== undefined && started !== null && typeof started === "object") {
        if ("skip" in started) {
          // A scenario this side cannot replay at all: skipped, no step run.
          return { name: scenario.name, status: "skipped", reason: started.skip, steps: [] };
        }
        if ("error" in started) {
          const failed: FormTestScenarioResult = { name: scenario.name, status: "error", reason: started.error, steps: [] };
          if (started.params !== undefined) {
            // What the error is about (which given, which path), so a report can word it.
            failed.params = started.params;
          }
          return failed;
        }
      }
    } catch {
      return { name: scenario.name, status: "error", reason: "action.failed", steps: [] };
    }
    const steps: FormTestStepResult[] = [];
    let snapshot: FormTestSnapshot | undefined;
    for (const statement of scenario.steps) {
      try {
        if (isAction(statement)) {
          snapshot = undefined;
          const outcome = await perform(driver, statement);
          if (outcome !== undefined && outcome !== null && typeof outcome === "object" && typeof outcome.refused === "string") {
            // The form turned the action down (a row past the most it may hold, a row that is not
            // there): a coded refusal, which ends the walk as an error the scenario's author
            // reads, never a sentence the driver worded.
            const params: Record<string, unknown> = { action: statement.kind, reason: outcome.refused };
            if (outcome.params !== undefined) {
              for (const key of Object.keys(outcome.params)) {
                if (key !== "action" && key !== "reason") {
                  params[key] = outcome.params[key];
                }
              }
            }
            steps.push({ line: statement.line, status: "error", code: "action.refused", params });
            break;
          }
          steps.push({ line: statement.line, status: "ran" });
          continue;
        }
        snapshot ??= await driver.snapshot();
        steps.push(
          kernelFormTestJudge(statement, snapshot, {
            componentIdOf: (path) => driver.componentIdOf(path),
            typeOf: (id) => (driver.typeOf === undefined ? undefined : driver.typeOf(id)),
            evaluate: (expression, values) => driver.evaluate(expression, values)
          })
        );
      } catch (error) {
        // An expectation fails here only because the snapshot behind it could not be taken (the
        // judge itself returns codes, never throws): no action failed, so the code says what did.
        steps.push({
          line: statement.line,
          status: "error",
          code: isAction(statement) ? "action.failed" : "snapshot.failed",
          params: { message: messageOf(error) }
        });
        break;
      }
    }
    const outcome = scenarioOutcome(steps);
    return outcome.reason === undefined
      ? { name: scenario.name, status: outcome.status, steps }
      : { name: scenario.name, status: outcome.status, reason: outcome.reason, steps };
  } finally {
    // A driver that fails to let go must not hide what the scenario came to.
    try {
      await driver.dispose?.();
    } catch {
      /* nothing to add: the result stands */
    }
  }
}

/**
 * Runs scenarios in order, each with a driver of its own (a fresh form, so one scenario's
 * answers never reach the next). A skipped scenario, or one over the step bound, makes no
 * driver. The driver is disposed after its scenario.
 */
export async function runFormTestScenarios(
  scenarios: FormTestScenario[],
  makeDriver: () => FormTestDriver | Promise<FormTestDriver>
): Promise<FormTestScenarioResult[]> {
  const results: FormTestScenarioResult[] = [];
  for (const scenario of scenarios) {
    const settled = settledBeforeStart(scenario);
    if (settled !== undefined) {
      results.push(settled);
      continue;
    }
    let driver: FormTestDriver;
    try {
      driver = await makeDriver();
    } catch {
      results.push({ name: scenario.name, status: "error", reason: "scenario.driverFailed", steps: [] });
      continue;
    }
    results.push(await runFormTestScenario(scenario, driver));
  }
  return results;
}
