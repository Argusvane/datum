import type { Expression, FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { FormulaFunctionSignature, FormulaProblem } from "../../core/expressions/formula-types.js";
import {
  COMPILE_FUNCTIONS,
  kernelCompileDefinition,
  kernelFormulaPolicy,
  kernelRegexRisky,
  kernelProblemRunsOnServer,
  kernelComponentTooDeep,
  kernelComponentTreeFault,
  kernelIsPlainRecord,
  kernelMaxComponentDepth,
  kernelRuleExpression,
  kernelRuleRun,
  kernelRuleRunsOn,
  kernelTreeReadsRow
} from "../../core/expressions/compile.js";
import { FORMULA_FUNCTIONS, kernelBuiltInFunctionSignatures, kernelParseFormula } from "../../core/expressions/formula.js";
import {
  INSPECT_FUNCTIONS,
  kernelInspectDefinition,
  kernelInspectError,
  kernelRedactSecretProblems,
  kernelRulesInventory,
  type DefinitionInspectResponse,
  type InspectedPath
} from "../../core/expressions/inspect.js";
import { STRUCTURE_FUNCTIONS, kernelStructureLimits } from "../../core/expressions/definition-structure.js";
import { COMPONENT_KIND_FUNCTIONS, kernelKindBase } from "../../core/schema/component-kinds.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type {
  ValidationContext,
  ValidationLog,
  ValidationLogEntry,
  ValidationLogLevel,
  ValidationLogThreshold,
  ValidationResult
} from "../../core/schema/contracts.js";
import type { Journey } from "../../core/schema/journey.js";
import {
  ANSWER_KIND_FUNCTIONS,
  kernelAnswerBoundCode,
  kernelAnswerBounds,
  kernelAnswerIsWrongShape,
  kernelAnswerKindCode,
  kernelIsDateAnswer,
  kernelIsEmptyValue
} from "../../core/schema/answer-kinds.js";
import type { JourneyOwnership, JourneyTrace } from "../../core/journey/journey-types.js";
import type {
  FormTestAction,
  FormTestExpectation,
  FormTestGiven,
  FormTestOpReport,
  FormTestOpScenarioReport,
  FormTestProblem,
  FormTestRefusal,
  FormTestScenario,
  FormTestScenarioResult,
  FormTestScenarioStatus,
  FormTestSkipReason,
  FormTestSnapshot,
  FormTestSnapshotError,
  FormTestStartError,
  FormTestStatement,
  FormTestStepResult,
  FormTestValue
} from "../../core/form-tests/form-test-types.js";
import { FORM_TEST_PARSE_FUNCTIONS, kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import { FORM_TEST_RUN_FUNCTIONS, kernelFormTestJudge } from "../../core/form-tests/form-test-run.js";
// The path engine is read by the server's fold alone ({@link kernelFoldSubmission}, which hands
// the browser-free fold its path and placements) and by the splice list; what a form without a
// journey reads comes from the shared helpers.
import { JOURNEY_PATH_FUNCTIONS, journeyOwnership, journeyPath, journeyPlacements, journeyReachable, journeyRuleTree } from "../../core/journey/journey-path.js";
import {
  computeEffectiveNodeState,
  type EffectiveNodeState,
  type SemanticNodeState
} from "../../core/state/effective-state.js";
import { SEMANTIC_STATE_FUNCTIONS, kernelBaseSemanticState, kernelReadEnum, kernelReadFlag } from "../../core/state/semantic-state.js";
import {
  SUBMITTABLE_FOLD_FUNCTIONS,
  kernelCompiledRule,
  kernelFoldHoldsOwnAnswer,
  kernelFoldInSection,
  kernelFoldRelaxUnreplayable,
  kernelFoldSubmittable,
  kernelJsonAnswers,
  kernelJsonValue,
  kernelOwn,
  kernelRecord,
  kernelRekeyById,
  kernelRuleSkipped,
  type KernelFoldInput,
  type KernelFoldResult
} from "../../core/state/submittable-fold.js";
import {
  EXPRESSION_EVALUATOR_FUNCTIONS,
  kernelEvaluateExpression,
  kernelExprPluginProblem,
  kernelExprReadPaths,
  kernelExprReadScopedPath,
  kernelExprReadsClock,
  kernelExprReadsHost,
  type RuleEvaluationContext
} from "../../rules/evaluator/evaluator.js";
import {
  CALCULATION_CYCLE_FUNCTIONS,
  kernelCalculationInput,
  kernelFindCalculationCycle
} from "../../rules/dependencies/calculation-cycle.js";
import { TEXT_FUNCTIONS } from "../../rules/evaluator/functions-text.js";
import { NUMBER_FUNCTIONS } from "../../rules/evaluator/functions-number.js";
import { LIST_FUNCTIONS } from "../../rules/evaluator/functions-list.js";
import { DATE_FUNCTIONS } from "../../rules/evaluator/functions-date.js";
import {
  PORTABLE_OPTIONS_FUNCTIONS,
  kernelCheckOptions,
  kernelOptionQuestions,
  kernelOptionSourceFree,
  kernelOptionChoiceOf,
  kernelOptionSourceId,
  type KernelOptionSnapshot
} from "./portable-options.js";
import type { WasmSubmissionOutcome, WasmUnknownFieldsMode, WasmValidationError } from "./wasm-validation-host.js";

/**
 * The portable validation kernel — the "core WASM".
 *
 * Everything in this module runs in two places from the same source: directly in-process
 * (the reference `InProcessWasmHostAdapter`, `in-process-host.ts`) and inside a QuickJS/WASM
 * sandbox, where the QuickJS adapter splices these functions' `Function.prototype.toString()`
 * output into one evaluated program. That dual life imposes hard constraints on this file:
 *
 * - **Runtime imports only of spliced functions.** Type-only imports are erased and safe. A
 *   value import is allowed only for a function that is itself spliced into the program — the
 *   engine modules the kernel shares with the browser runtime: the expression
 *   evaluator (`rules/evaluator/evaluator.ts`), the semantic-state readers
 *   (`core/state/semantic-state.ts`), `computeEffectiveNodeState`, the submittable fold
 *   (`core/state/submittable-fold.ts`), the journey path engine
 *   (`core/journey/journey-path.ts`) and its shared helpers (`core/journey/journey-shared.ts`,
 *   spliced through the path engine's list), the number and date predicates
 *   (`core/schema/answer-kinds.ts`) and, for the `test` op, the form-test
 *   parser and judge (`core/form-tests/`). Each follows these same rules and lists its functions
 *   for {@link PORTABLE_KERNEL_FUNCTIONS}; anything else imported would leave a dangling
 *   reference inside the sandbox.
 * - **Top-level `function` declarations only** (no arrow consts, no classes) so hoisting makes
 *   composition order-irrelevant and every cross-reference resolves by declared name.
 * - **Kernel functions may reference only each other and standard globals** (`JSON`,
 *   `Object`, `Array`, `RegExp`) — no module constants. Every function any of them references
 *   must be listed in {@link PORTABLE_KERNEL_FUNCTIONS} or the sandbox program will not
 *   evaluate, and every name there is unique and prefixed (`kernel*`, `journey*`), so splicing
 *   several modules into one scope cannot shadow anything.
 * - **No locale-sensitive or nondeterministic APIs** — key ordering uses code-unit
 *   comparison, never `localeCompare` (ICU collation differs between QuickJS and V8, and the
 *   ABI requires byte-identical serialization from every host).
 * - **No inherited members read as data.** Records keyed by component ids or submitted keys
 *   are built without a prototype (`Object.create(null)`), and records handed in are read
 *   through `kernelOwn`, so a key such as `constructor`, `toString` or `__proto__` behaves like
 *   any other. What leaves the kernel — the values validators see, the outcome — is an
 *   ordinary object again, spread so that an own `__proto__` key stays a key.
 *
 * **Formulas, the clock and run scopes.** The definition a context carries
 * may write its rules as formulas; {@link runKernel} compiles it into a copy with every formula
 * a tree (`kernelCompileDefinition`, `core/expressions/compile.ts`, whose parser and readers are
 * spliced in through `FORMULA_FUNCTIONS` and `COMPILE_FUNCTIONS`) and reads the copy. The
 * context's objects are never changed: a server hands the kernel the definition it stores and
 * hashes. Every rule reader here reads a compiled rule through `kernelCompiledRule` and skips
 * what this side does not apply through `kernelRuleSkipped` (`core/state/submittable-fold.ts`):
 * a rule reading `host.`, one scoped to the browser, one reading the clock when the context
 * gave no `today`. The day, the plugins' formula functions and the parser's signatures reach
 * every rule context through a {@link KernelEvaluation}.
 *
 * The kernel deliberately re-implements the engine logic it must not import: the data-scope
 * value-path derivation, data keys included (`core/tree/data-scope.ts`), the
 * field-constraint semantics
 * (`validation/core/field-constraints.ts`), the file-field readings behind them
 * (`core/schema/file-upload.ts`), and the rules-driven semantic state the browser's
 * `RulesSemanticStateResolver` resolves (`runtime/browser/runtime-orchestrator.ts`).
 * `engine/tests/portable-kernel.test.ts` and `engine/tests/journey-kernel.test.ts` hold the
 * readings identical.
 */

/** One error in the ABI error contract: code + parameters + field mapping. Never prose. */
export type KernelValidationError = ValidationResult["errors"][number];

/**
 * What the kernel does with submitted keys the schema does not define — a per-run choice
 * carried in the serialized context (`WasmSubmissionContext.unknownFields`), so any host
 * can set it at submission time:
 * - `"strip"` (default): silently dropped; the returned `values` are schema-bounded.
 * - `"keep"`: passed through untouched; the caller accepts unknown keys in the submission.
 * - `"reject"`: each unknown key blocks the run with an `unknown_field` contract error
 *   (`parameters.field` names the key; no `componentId`/`path` — there is no component).
 */
export type KernelUnknownFieldsMode = "strip" | "keep" | "reject";

/** What a kernel validator is handed: the context, the schema, and the run log to write to. */
export type KernelValidatorContext = ValidationContext & { form?: ComponentNode; log: ValidationLog };

/** A deterministic validator run by the kernel: plain function, context in, errors out. */
export type KernelValidator = (context: KernelValidatorContext) => ValidationResult;

/** The run log as the kernel keeps it: the entries so far, and how many the cap dropped. */
export interface KernelLog extends ValidationLog {
  entries: ValidationLogEntry[];
  dropped: number;
  write(level: ValidationLogLevel, message: string, data?: unknown): void;
}

/** What the kernel hands back across the ABI: the error contract, plus the sanitized values
 * when nothing blocked, plus the run log when it kept anything. `values` is what the form
 * submitted **minus any key the schema does not define, minus the answers of hidden
 * components whose value behaviour excludes them** (a cleared one comes back `undefined`,
 * which serialization drops), **with each calculation it could reproduce as it worked it
 * out**, every answer as JSON carries it (a `NaN` as `null`) — the caller must treat it as
 * the submission, not the raw input. */
export interface KernelOutcome {
  errors: KernelValidationError[];
  /**
   * The delivered keys the form defines that the judged values leave out (hidden answers the
   * fold withheld), in the delivered order. Present, possibly empty, when the context set
   * `reportFold` and the fold ran; absent without the flag and from a refused definition.
   */
  withheld?: string[];
  /**
   * The components whose errors {@link kernelErrorPassesFold} can drop (not validated, or
   * requiredness not applying), by id; a component not listed passes every error. Present only when there is one and the fold ran.
   */
  effectiveState?: Record<string, EffectiveNodeState>;
  /** The judged values of a run that blocked, which carries no `values`. */
  submittable?: Record<string, unknown>;
  /** The journey's path, when the context carried a journey. */
  trace?: NonNullable<KernelFoldResult["trace"]>;
  values?: Record<string, unknown>;
  logs?: ValidationLogEntry[];
  /**
   * The value paths whose answers were worked out in the browser and are kept as sent:
   * held to the form's rules like any answer, but not reproduced here.
   * In document order; see {@link kernelClientDerived}. Present only when there is one, and
   * whether or not the run blocked — it describes the answers judged, which a host may keep
   * either way.
   */
  clientDerived?: string[];
  /**
   * The form components in scope for the journey page the context named (`context.page`), in
   * document order — what a host scopes a page's check by without working placement
   * out itself ({@link kernelPageComponentIds}). Present whenever the context names a page and
   * carries a usable journey, empty for a page that places nothing.
   */
  pageComponentIds?: string[];
  /**
   * The components whose server-side rules or calculation read the clock (`today()`, `age()`),
   * in document order: what the verdict turned on the day for, or was left
   * unevaluated for lack of one. Present only when there is one, blocked or not.
   */
  clockDependent?: string[];
  /**
   * The components whose `server` or `server-secret` rules this run applied, in document
   * order: rules the browser never ran. Present only when there is one, blocked or not.
   */
  serverRules?: string[];
  /**
   * The components whose own `visibleWhen` this run could not replay, in document order: it
   * reads `host.`, is scoped to the browser, or reads the clock when the context gave no day. Such a component, and everything under it, is treated as hidden for
   * requiredness ({@link kernelFoldRelaxUnreplayable}): the server never demands an answer the
   * browser may have hidden. Present only when there is one, blocked or not.
   */
  visibilitySkipped?: string[];
  /**
   * The flat value index of `values`: one row per answer, built from the same
   * sanitized object, so an answer stripped or withheld is not indexed
   * ({@link kernelValueIndex}). Present whenever `values` is.
   */
  index?: KernelIndexRow[];
  /**
   * The context's `document` as canonical text, every key sorted by code unit: the
   * document as sent, not the values the run returns. Present only when the context carried
   * one, blocked or not ({@link kernelDocumentDigest}).
   */
  canonical?: string;
  /** SHA-256, lowercase hex, of the UTF-8 bytes of `canonical`. Present exactly when `canonical` is. */
  digest?: string;
}

/**
 * One row of a run's value index: `path` is the submitted key with its entry
 * indexes taken out, `delta` those indexes joined with `.` (and, for an item of a list of
 * scalars, its position), `value` the answer as the values hold it.
 */
export interface KernelIndexRow {
  path: string;
  delta: string;
  value: unknown;
}

/**
 * What one run evaluates rules with beyond the answers: the host's calendar day
 * (`today()`, `age()`; absent, a clock-reading rule is skipped as a `host.` read is) and the
 * plugins' formula functions, on every rule context the kernel builds.
 */
export interface KernelEvaluation {
  today?: string;
  /**
   * The values `host.` reads, as the server supplied them (`context.hostContext`): a plain record.
   * Present, every rule reading `host.` is evaluated against it, a key it lacks reading as no
   * answer; absent, such a rule is skipped ({@link kernelRuleSkipped}).
   */
  hostContext?: Record<string, unknown>;
  /** The run's compiled `matches` patterns: one plain object every rule context shares. */
  regexCache?: Record<string, unknown>;
  functions?: Record<string, (args: unknown[]) => unknown>;
  /**
   * The rule being evaluated now, `rules:<componentId>:<key>` (`journey:<id>` for a journey
   * condition), set by the kernel before each evaluation ({@link kernelMarkRule}) so a plugin
   * function that throws can be named with its rule. Written only, never read by
   * a rule.
   */
  where?: string;
  /**
   * The ids of the components whose `rules.value` did not parse, so the compiled tree has no
   * rule for them. Their sent value is kept and taken on trust: listed in
   * `unreproduced`, hence in `clientDerived`.
   */
  unparsedCalculations?: string[];
  /**
   * Where a formula function says what it did not do (a size cap tripped, a plugin's result
   * dropped): the run's log, one line per message. Set by the run, passed on to every rule
   * context as `warn`.
   */
  warn?: (message: string) => void;
}

/**
 * A definition prepared for running: everything a run reads of it that does
 * not depend on the answers. The compile (`root`, `journey`, the problems and warnings it
 * found, the calculations whose formula did not parse) is worked out when the object is made
 * ({@link kernelPrepareDefinition}); the indexes the readers build over the tree (`derived`:
 * the tree index, value paths, ids by path, the allowlist of key shapes, row fields and lists,
 * collection owners) are worked out the first time a reader asks for one
 * ({@link kernelPreparedGet}), so a run that never reaches a reader never pays for it, and a
 * reader that throws does so at the point that reads it. Plain data the kernel built, no host
 * handle, no function: it lives as long as the host's {@link KernelPreparedCache}, which may
 * be the sandbox context itself, and no reader writes to it after it is made.
 */
export interface KernelPrepared {
  /** The compiled root: every formula a tree, the authored definition untouched. */
  root: ComponentNode;
  /** The journey as the run reads it: the compiled copy when one was given, else what was given. */
  journey: unknown;
  /** What the compile could not parse or resolve, in the compile's order (the run judges them by its policy). */
  problems: FormulaProblem[];
  /** Findings that never refuse a run (a condition that is no yes-or-no). */
  warnings: FormulaProblem[];
  /** The ids of the components whose `rules.value` did not parse. */
  unparsedCalculations: string[];
  /** The formula-error word the object was prepared under (part of its cache key). */
  policy: string;
  /** The risky-pattern word the object was prepared under (part of its cache key). */
  risky: unknown;
  /** The indexes over `root`, each filled by its first reader; prototype-free. */
  derived: Record<string, unknown>;
}

/** One prepared definition in a {@link KernelPreparedCache}, with the text it was keyed by. */
export interface KernelPreparedEntry {
  key: string;
  prepared: KernelPrepared;
  /** The cache's clock when the entry was last used: the smallest is the one dropped. */
  used: number;
}

/**
 * The prepared definitions a host remembers between runs, least recently used dropped first.
 * Plain data a host (or the sandbox program, on its global) creates once with
 * {@link kernelCreatePreparedCache}: the kernel keeps no state of its own between runs.
 * `hits` and `misses` count lookups, for the host's diagnostics and the parity tests.
 */
export interface KernelPreparedCache {
  entries: KernelPreparedEntry[];
  /** The most definitions kept. */
  capacity: number;
  /** The most key text kept, in characters, over every entry: a bound on the memory a cache holds. */
  maxChars: number;
  clock: number;
  hits: number;
  misses: number;
  /** The signature list the last key was built for, its length then, and its key part. */
  signatureList?: FormulaFunctionSignature[];
  signatureCount: number;
  signatureKey: string;
}

/** An empty {@link KernelPreparedCache}: `capacity` definitions at most, and at most `maxChars` characters of key text. */
export function kernelCreatePreparedCache(capacity: number, maxChars: number): KernelPreparedCache {
  return { entries: [], capacity, maxChars, clock: 0, hits: 0, misses: 0, signatureCount: -1, signatureKey: "" };
}

/**
 * The compile of a definition and what a run takes from it ({@link KernelPrepared}). The
 * journey is wrapped as the browser reads its journeys (`{ journeys: [journey] }`), so a page
 * or route `when` is compiled alike on both sides. Pure: the definition and the journey are
 * never changed, and the same inputs give the same object.
 */
export function kernelPrepareDefinition(
  form: ComponentNode,
  journey: unknown,
  pdf: unknown,
  policyWord: string,
  riskyWord: unknown,
  signatures: FormulaFunctionSignature[]
): KernelPrepared {
  const wrapped = journey !== undefined && journey !== null ? { journeys: [journey] } : undefined;
  const compiled = kernelCompileDefinition(form, wrapped, pdf, kernelParseFormula, signatures, riskyWord);
  const unparsedCalculations: string[] = [];
  for (const problem of compiled.problems) {
    const parts = problem.where.split(":");
    if (parts.length === 3 && parts[0] === "rules" && parts[2] === "value") {
      unparsedCalculations.push(parts[1] as string);
    }
  }
  return {
    root: compiled.definition.root,
    journey: wrapped !== undefined ? (compiled.definition.journey as { journeys: unknown[] }).journeys[0] : journey,
    problems: compiled.problems,
    warnings: compiled.warnings === undefined ? [] : compiled.warnings,
    unparsedCalculations,
    policy: policyWord,
    risky: riskyWord,
    derived: kernelRecord() as Record<string, unknown>
  };
}

/**
 * The key a prepared definition is remembered by: the formula-error word, the risky-pattern
 * word, the parser's signatures (name and argument counts, sorted by name) and the exact JSON
 * text of the form, the journey and the PDF layouts. Equal keys mean equal inputs to the
 * compile, so a hit is the object a miss would have built. The text is not re-sorted: the same
 * definition written with its members in another order is another entry (a miss, never a wrong
 * answer). Hosts hand the kernel data that came through JSON; a definition that cannot be
 * written as JSON text (a cycle, a BigInt) gets no key, and its run prepares its own.
 */
export function kernelPreparedKey(
  cache: KernelPreparedCache,
  form: unknown,
  journey: unknown,
  pdf: unknown,
  policyWord: string,
  riskyWord: unknown,
  signatures: FormulaFunctionSignature[]
): string | undefined {
  try {
    const formText: unknown = JSON.stringify(form);
    const journeyText: unknown = journey === undefined ? "" : JSON.stringify(journey);
    const pdfText: unknown = pdf === undefined ? "" : JSON.stringify(pdf);
    const riskyText: unknown = riskyWord === undefined ? "" : JSON.stringify(riskyWord);
    if (typeof formText !== "string" || typeof journeyText !== "string" || typeof pdfText !== "string" || typeof riskyText !== "string") {
      return undefined;
    }
    // A definition longer than the whole bound is never kept: no key is built for it.
    if (formText.length > cache.maxChars) {
      return undefined;
    }
    if (cache.signatureList !== signatures || cache.signatureCount !== signatures.length) {
      const rows: string[] = [];
      for (const signature of signatures) {
        rows.push(String(signature.name) + ":" + String(signature.min) + ":" + String(signature.max));
      }
      rows.sort();
      cache.signatureKey = rows.join(",");
      cache.signatureList = signatures;
      cache.signatureCount = signatures.length;
    }
    return policyWord + "\u0000" + riskyText + "\u0000" + cache.signatureKey + "\u0000" + journeyText + "\u0000" + pdfText + "\u0000" + formText;
  } catch {
    return undefined;
  }
}

/** The prepared definition a key names, marked as just used; `undefined` (and a miss counted) when the cache has none. */
export function kernelPreparedLookup(cache: KernelPreparedCache, key: string): KernelPrepared | undefined {
  const entries = cache.entries;
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] as KernelPreparedEntry;
    if (entry.key === key) {
      cache.clock += 1;
      entry.used = cache.clock;
      cache.hits += 1;
      return entry.prepared;
    }
  }
  cache.misses += 1;
  return undefined;
}

/**
 * Remembers a prepared definition under its key, dropping the least recently used until the
 * cache is within its capacity and its key-text bound. A key longer than the whole bound is not
 * kept. Written so that a run cut short in the middle (the sandbox's deadline) leaves a cache
 * that is merely smaller or larger than intended, never one that answers wrongly: the counts
 * are worked out from the entries each time, not kept.
 */
export function kernelPreparedStore(cache: KernelPreparedCache, key: string, prepared: KernelPrepared): void {
  if (cache.capacity < 1 || key.length > cache.maxChars) {
    return;
  }
  const entries = cache.entries;
  cache.clock += 1;
  entries.push({ key, prepared, used: cache.clock });
  for (;;) {
    let chars = 0;
    let oldest = 0;
    for (let at = 0; at < entries.length; at += 1) {
      const entry = entries[at] as KernelPreparedEntry;
      chars += entry.key.length;
      if (entry.used < (entries[oldest] as KernelPreparedEntry).used) {
        oldest = at;
      }
    }
    if (entries.length <= cache.capacity && chars <= cache.maxChars) {
      return;
    }
    entries.splice(oldest, 1);
  }
}

/**
 * Cuts a prepared definition loose from the objects it was compiled from. The compile shares
 * every node it does not rewrite with the definition the run was handed, and a plugin validator
 * is handed that definition (`context.form`): a validator that wrote to it would change what the
 * next run of the same definition reads. So the run that built a prepared object, when
 * validators are about to run, swaps in private copies first (frozen ones, as the values a
 * validator is handed are: no reader writes to the tree, so a write would be a bug, and it fails
 * rather than leaks). Every index built over the shared nodes is dropped with them (rebuilt on
 * demand over the copies). A later run is handed a new definition of its own, which shares
 * nothing with the cached one.
 */
export function kernelPreparedIsolate(prepared: KernelPrepared): void {
  const root = kernelFrozenCopy(prepared.root) as ComponentNode;
  const journey = kernelFrozenCopy(prepared.journey);
  prepared.derived = kernelRecord() as Record<string, unknown>;
  prepared.root = root;
  prepared.journey = journey;
}

/**
 * An index over a prepared definition's tree, worked out by `build` the first time any reader
 * asks for `slot` and read back after. With no prepared object, or one made for another root,
 * it is just `build()`: the readers give the same answer with or without one, which is why a
 * hit cannot change an outcome. The answer is shared, so a reader must not write to it (the
 * `riskyPatterns` slot is a memo of verdicts that fills as patterns are met, and is the one
 * exception).
 */
/**
 * The part of a prepared slot's name that tells one `kinds` map from another: `""` for no map,
 * else the map's JSON text, so an index read through the map is never shared with a run that
 * hands another (a map that cannot be written as JSON is its own text, `"\u0000?"`, and is read
 * per run as data the kernel ignores anyway).
 */
export function kernelKindsSlot(kinds: unknown): string {
  if (kinds === undefined || kinds === null) {
    return "";
  }
  try {
    const text: unknown = JSON.stringify(kinds);
    return typeof text === "string" ? "\u0000" + text : "\u0000?";
  } catch {
    return "\u0000?";
  }
}

export function kernelPreparedGet<T>(prepared: KernelPrepared | undefined, root: ComponentNode, slot: string, build: () => T): T {
  if (prepared === undefined || prepared.root !== root) {
    return build();
  }
  const derived = prepared.derived;
  const known = derived[slot];
  if (known !== undefined) {
    return known as T;
  }
  const built = build();
  derived[slot] = built;
  return built;
}

/**
 * The run log: what validators write to as `context.log`, and the kernel for its
 * own steps. Entries at or above the threshold are kept in order, up to a cap of 200, and
 * travel back in the outcome for the host to forward to a logger of its own; below the
 * threshold a call costs one comparison. The default threshold is `warn`, so a run that
 * behaves records nothing and the outcome carries no log. Plain data only — the
 * sandbox has no clock, so no timestamps; the host stamps the batch — and no stacks, so the
 * same run yields the same log on every engine.
 */
export function kernelCreateLog(threshold: unknown): KernelLog {
  const ranks: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
  const level: ValidationLogThreshold =
    typeof threshold === "string" && kernelOwn(ranks, threshold) !== undefined ? (threshold as ValidationLogThreshold) : "warn";
  const floor = ranks[level] as number;
  const log: KernelLog = {
    level,
    entries: [],
    dropped: 0,
    write(entryLevel, message, data) {
      if ((ranks[entryLevel] as number) < floor) {
        return;
      }
      if (log.entries.length >= 200) {
        log.dropped += 1;
        return;
      }
      // Each entry is capped, not only their number: a message over 8 KiB is cut with a marker,
      // data over 8 KiB serialised is replaced by a note of its size.
      let text = String(message);
      if (text.length > 8192) {
        const last = text.charCodeAt(8191);
        text = text.slice(0, last >= 0xd800 && last <= 0xdbff ? 8191 : 8192) + "... [truncated]";
      }
      let kept: unknown = data;
      if (data !== undefined) {
        let size = 0;
        try {
          const json = JSON.stringify(data);
          size = json === undefined ? 0 : json.length;
        } catch (failure) {
          size = Infinity;
        }
        if (size > 8192) {
          kept = { truncated: true, size: size === Infinity ? null : size };
        }
      }
      log.entries.push(kept === undefined ? { level: entryLevel, message: text } : { level: entryLevel, message: text, data: kept });
    },
    debug(message, data) {
      log.write("debug", message, data);
    },
    info(message, data) {
      log.write("info", message, data);
    },
    warn(message, data) {
      log.write("warn", message, data);
    },
    error(message, data) {
      log.write("error", message, data);
    }
  };
  return log;
}

/** The entries a run kept, with one closing warning when the cap dropped any. */
export function kernelFinishLog(log: KernelLog): ValidationLogEntry[] {
  if (log.dropped > 0) {
    return log.entries.concat([{ level: "warn", message: "run log truncated", data: { kept: log.entries.length, dropped: log.dropped } }]);
  }
  return log.entries;
}

/** Recursive code-unit key sort. The one canonical ordering for every ABI payload. */
export function kernelSortKeys(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(kernelSortKeys);
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, kernelSortKeys(value)])
    );
  }
  return input;
}

/** Byte-stable JSON: the sandbox serializes its own outcome with this, so the output is
 * ABI-canonical no matter which host ran it. One recursive writer: keys sorted by code unit,
 * leaves written by JSON.stringify, no intermediate copy; byte-identical to
 * `JSON.stringify(kernelSortKeys(input))`. */
export function kernelStableStringify(input: unknown): string {
  const text = kernelStableWrite(input);
  return text === undefined ? (undefined as unknown as string) : text;
}

function kernelIsArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
}

/**
 * The keys of a record in the canonical order: a plain object lists integer-like keys first,
 * ascending, whatever order they were added in; the bytes keep that order. The rest sorted by code unit.
 */
function kernelStableKeys(object: Record<string, unknown>): string[] {
  let keys = Object.keys(object).sort();
  let indexes: string[] | undefined;
  for (const key of keys) {
    const lead = key.charCodeAt(0);
    if (lead >= 48 && lead <= 57 && kernelIsArrayIndex(key)) {
      (indexes ??= []).push(key);
    }
  }
  if (indexes !== undefined) {
    indexes.sort((a, b) => Number(a) - Number(b));
    keys = indexes.concat(keys.filter((key) => indexes!.indexOf(key) < 0));
  }
  return keys;
}

/**
 * The recursive writer. Past 200 levels the rest of the value goes to {@link
 * kernelStableWriteDeep}, which keeps its own stack: a request nested thousands of levels deep
 * (an author's expression tree) is written whole, for the host's limits to refuse it typed,
 * never a stack overflow in the host before them.
 */
function kernelStableWrite(input: unknown, depth?: number): string | undefined {
  const level = depth === undefined ? 0 : depth;
  if (level > 200) {
    return kernelStableWriteDeep(input);
  }
  if (Array.isArray(input)) {
    let out = "[";
    for (let at = 0; at < input.length; at += 1) {
      const item = kernelStableWrite(input[at], level + 1);
      out += (at > 0 ? "," : "") + (item === undefined ? "null" : item);
    }
    return out + "]";
  }
  if (input && typeof input === "object") {
    const object = input as Record<string, unknown>;
    const keys = kernelStableKeys(object);
    let out = "{";
    let first = true;
    for (const key of keys) {
      const item = kernelStableWrite(object[key], level + 1);
      if (item !== undefined) {
        out += (first ? "" : ",") + JSON.stringify(key) + ":" + item;
        first = false;
      }
    }
    return out + "}";
  }
  return JSON.stringify(input);
}

/**
 * {@link kernelStableWrite} with an explicit stack, byte for byte the same text: one frame per
 * open list or record. A value that holds itself is refused as `JSON.stringify` refuses one (a
 * `TypeError`), where the walk would otherwise never end.
 */
function kernelStableWriteDeep(input: unknown): string | undefined {
  const frames: Array<{ list: unknown[] | undefined; object: Record<string, unknown> | undefined; keys: string[]; at: number; out: string; first: boolean }> = [];
  const open = new Set<unknown>();
  let value: unknown = input;
  for (;;) {
    let written: string | undefined;
    let leaf = false;
    if (open.has(value)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    if (Array.isArray(value)) {
      open.add(value);
      frames.push({ list: value, object: undefined, keys: [], at: 0, out: "[", first: true });
    } else if (value && typeof value === "object") {
      open.add(value);
      const object = value as Record<string, unknown>;
      frames.push({ list: undefined, object, keys: kernelStableKeys(object), at: 0, out: "{", first: true });
    } else {
      written = JSON.stringify(value);
      leaf = true;
    }
    // Hand what was written to the frame it belongs to, closing every frame it completes, until
    // a frame has another member to write.
    for (;;) {
      const top = frames[frames.length - 1];
      if (top === undefined) {
        return written;
      }
      if (leaf) {
        if (top.list !== undefined) {
          top.out += (top.at > 1 ? "," : "") + (written === undefined ? "null" : written);
        } else if (written !== undefined) {
          top.out += (top.first ? "" : ",") + JSON.stringify(top.keys[top.at - 1]) + ":" + written;
          top.first = false;
        }
        leaf = false;
      }
      if (top.list !== undefined && top.at < top.list.length) {
        value = top.list[top.at];
        top.at += 1;
        break;
      }
      if (top.object !== undefined && top.at < top.keys.length) {
        value = top.object[top.keys[top.at] as string];
        top.at += 1;
        break;
      }
      frames.pop();
      open.delete(top.list !== undefined ? top.list : top.object);
      written = top.out + (top.list !== undefined ? "]" : "}");
      leaf = true;
    }
  }
}

/**
 * The UTF-8 bytes of a string as a binary string, one character per byte (each code below 256),
 * as `TextEncoder` writes them: a surrogate pair as one four-byte sequence, a lone surrogate as
 * U+FFFD. The sandbox has no `TextEncoder`; `encodeURIComponent` is the specification's own
 * UTF-8 encoder, native on every engine, and `unescape` turns its `%XX` escapes back into
 * single characters, so a long document encodes at native speed. `encodeURIComponent` refuses a
 * lone surrogate, which a canonical string from `JSON.stringify` never holds (it escapes them):
 * such text has each one replaced with U+FFFD first, as `TextEncoder` does.
 */
export function kernelUtf8Binary(text: string): string {
  try {
    return unescape(encodeURIComponent(text));
  } catch (_error) {
    return unescape(encodeURIComponent(text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")));
  }
}

/**
 * SHA-256 (FIPS 180-4) of a binary string (one byte per character, `charCodeAt(i) & 0xff`), as
 * lowercase hex: the digest a run returns for the document it was sent. Plain 32-bit
 * integer arithmetic, so it reads the same on every engine; `core/crypto/sha256.ts` is the
 * engine's own, kept apart because its round constants are a module constant the sandbox
 * program could not carry. Here they are built inside the function. Whole blocks are read
 * from the input in place and only the padded tail is built; every intermediate stays a 32-bit
 * integer (`| 0`), which QuickJS keeps unboxed. Inside QuickJS it hashes about 1 MB a second,
 * which counts against a run's time budget: a document carrying a large attachment needs a
 * host budget to match.
 */
export function kernelSha256Hex(binary: string): string {
  const k = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  function compress(source: string, offset: number): void {
    for (let t = 0; t < 16; t += 1) {
      const at = offset + t * 4;
      w[t] =
        ((source.charCodeAt(at) & 0xff) << 24) |
        ((source.charCodeAt(at + 1) & 0xff) << 16) |
        ((source.charCodeAt(at + 2) & 0xff) << 8) |
        (source.charCodeAt(at + 3) & 0xff);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[t] = (((((w[t - 16] as number) + s0) | 0) + (((w[t - 7] as number) + s1) | 0)) | 0);
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((hh + s1) | 0) + ch) | 0) + (((k[t] as number) + (w[t] as number)) | 0)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + ((s0 + maj) | 0)) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
  const length = binary.length;
  const whole = length - (length % 64);
  for (let offset = 0; offset < whole; offset += 64) {
    compress(binary, offset);
  }
  // The tail: what is left, a 0x80 byte, zeros to 56 mod 64, the bit length as 64 bits big-endian.
  const high = (length - (length % 0x20000000)) / 0x20000000;
  const low = (length * 8) % 0x100000000;
  let tail = binary.slice(whole) + String.fromCharCode(0x80);
  while (tail.length % 64 !== 56) {
    tail += String.fromCharCode(0);
  }
  tail += String.fromCharCode((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  tail += String.fromCharCode((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);
  for (let offset = 0; offset < tail.length; offset += 64) {
    compress(tail, offset);
  }
  let hex = "";
  for (let index = 0; index < 8; index += 1) {
    const word = (h[index] as number) >>> 0;
    hex += ("0000000" + word.toString(16)).slice(-8);
  }
  return hex;
}

/**
 * What a run says of the document a host received: its canonical text, every key
 * sorted by code unit ({@link kernelStableStringify}), and the SHA-256 hex of that text's UTF-8
 * bytes. The host stores both and never serializes the document itself, so every host and the
 * browser name one record by one digest.
 */
export function kernelDocumentDigest(document: unknown): { canonical: string; digest: string } {
  const canonical = kernelStableStringify(document);
  return { canonical, digest: kernelSha256Hex(kernelUtf8Binary(canonical)) };
}

export function kernelConfigurationOf(node: ComponentNode): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

/** Mirrors `isDataScopeContainer` (core/tree/data-scope.ts). */
export function kernelIsDataScopeContainer(node: ComponentNode): boolean {
  if (node.type !== "container") {
    return false;
  }
  return kernelConfigurationOf(node).scopeData !== false;
}

/** Mirrors `isValidDataKey` (core/tree/data-scope.ts): the path-segment grammar, not digits alone. */
export function kernelIsValidDataKey(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && !/^\d+$/.test(value);
}

/** Mirrors `dataKeyOf`: a node's own segment in the data — its valid data key, else its id. */
export function kernelDataKeyOf(node: ComponentNode): string {
  const key = kernelConfigurationOf(node).dataKey;
  return kernelIsValidDataKey(key) ? (key as string) : node.id;
}

/** Mirrors `collectionPathOf`: where a repeating section's entries live, as written; else nothing. */
export function kernelCollectionPathOf(node: ComponentNode): string | undefined {
  const binding = node.collection;
  if (!binding) {
    return undefined;
  }
  const configured = binding.collectionPath;
  return typeof configured === "string" && configured.length > 0 ? configured : node.id;
}

/**
 * A node's own enumerable keys copied onto a new plain object, `skip` left out. Each key is
 * defined, not assigned, so an own `__proto__` key stays a key, as an object spread keeps it.
 */
export function kernelGridCopy(from: Record<string, unknown>, skip: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(from);
  for (let at = 0; at < keys.length; at += 1) {
    const key = keys[at] as string;
    if (skip.indexOf(key) < 0) {
      Object.defineProperty(out, key, { value: from[key], writable: true, enumerable: true, configurable: true });
    }
  }
  return out;
}

/**
 * Whether a node is a data grid {@link kernelNormalizeDataGrid} binds: one with no collection
 * binding. Mirrors `normalizeDataGrids` (core/schema/data-grid.ts), for a grid whose id is a
 * text: one with any other id (a definition `check` refuses) is left as it is, a group holding
 * no data, since a collection read off a non-text id is no key the run can walk.
 */
export function kernelDataGridNeedsNormal(node: unknown): boolean {
  return (
    node !== null &&
    typeof node === "object" &&
    (node as { type?: unknown }).type === "dataGrid" &&
    typeof (node as { id?: unknown }).id === "string" &&
    (node as ComponentNode).collection === undefined
  );
}

/**
 * The kernel's mirror of the binding `normalizeDataGrids` gives a grid (core/schema/data-grid.ts)
 * for a node {@link kernelDataGridNeedsNormal} names: its rows live at its id. A new
 * object; nothing handed in is changed.
 */
export function kernelNormalizeDataGrid(node: ComponentNode): ComponentNode {
  const bound = kernelGridCopy(node as unknown as Record<string, unknown>, []);
  bound.collection = { collectionPath: node.id };
  return bound as unknown as ComponentNode;
}

/**
 * Whether any data grid in the tree needs {@link kernelNormalizeDataGrid}: one pass with an
 * explicit stack, no deeper than one level past the depth the run accepts (a deeper tree is
 * refused before it is read, and a cycle a host's objects might hold ends there).
 */
export function kernelDataGridsPending(root: unknown): boolean {
  const limit = kernelMaxComponentDepth() + 1;
  const stack: Array<{ node: unknown; level: number }> = [{ node: root, level: 1 }];
  while (stack.length > 0) {
    const top = stack.pop() as { node: unknown; level: number };
    if (kernelDataGridNeedsNormal(top.node)) {
      return true;
    }
    const children: unknown = top.node !== null && typeof top.node === "object" ? (top.node as { children?: unknown }).children : undefined;
    if (top.level >= limit || children === null || typeof children !== "object" || Array.isArray(children)) {
      continue;
    }
    const slots = Object.keys(children as object);
    for (let s = 0; s < slots.length; s += 1) {
      const group: unknown = (children as Record<string, unknown>)[slots[s] as string];
      if (!Array.isArray(group)) {
        continue;
      }
      for (let at = 0; at < group.length; at += 1) {
        const child: unknown = group[at];
        if (child !== null && typeof child === "object") {
          stack.push({ node: child, level: top.level + 1 });
        }
      }
    }
  }
  return false;
}

/**
 * The kernel's mirror of `normalizeDataGrids` (core/schema/data-grid.ts): every data
 * grid in the tree bound to a collection. Applied to `context.form` at the top of
 * {@link runKernel}, before anything walks the definition, so the run reads a grid's rows where
 * the browser does, and by the `inspect` op's paths and the `check` op. Returns the root handed in when nothing needed rewriting;
 * otherwise a copy that shares every subtree it did not change, the definition handed in never
 * changed. Walked with an explicit stack (children before their parent), no deeper than one
 * level past the depth the run accepts, so a tree of any depth cannot exhaust the sandbox's stack.
 */
export function kernelNormalizeDataGrids(root: ComponentNode): ComponentNode {
  if (root === null || typeof root !== "object" || !kernelDataGridsPending(root)) {
    return root;
  }
  const limit = kernelMaxComponentDepth() + 1;
  const holder: unknown[] = [root];
  const stack: Array<{
    node: ComponentNode;
    next: ComponentNode;
    level: number;
    into: unknown[];
    at: number;
    open: boolean;
    slots: string[];
    lists: Array<unknown[] | undefined>;
  }> = [{ node: root, next: root, level: 1, into: holder, at: 0, open: false, slots: [], lists: [] }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as (typeof stack)[number];
    if (!frame.open) {
      frame.open = true;
      frame.next = kernelDataGridNeedsNormal(frame.node) ? kernelNormalizeDataGrid(frame.node) : frame.node;
      const children: unknown = frame.next.children;
      if (frame.level < limit && children !== null && typeof children === "object" && !Array.isArray(children)) {
        const slots = Object.keys(children as object);
        for (let s = 0; s < slots.length; s += 1) {
          const slot = slots[s] as string;
          const group: unknown = (children as Record<string, unknown>)[slot];
          frame.slots.push(slot);
          if (!Array.isArray(group)) {
            frame.lists.push(undefined);
            continue;
          }
          const walked = group.slice();
          frame.lists.push(walked);
          for (let at = walked.length - 1; at >= 0; at -= 1) {
            const child: unknown = walked[at];
            if (child !== null && typeof child === "object") {
              stack.push({ node: child as ComponentNode, next: child as ComponentNode, level: frame.level + 1, into: walked, at, open: false, slots: [], lists: [] });
            }
          }
        }
      }
      continue;
    }
    stack.pop();
    let next = frame.next;
    const children = next.children as Record<string, unknown> | undefined;
    let changed = false;
    for (let s = 0; s < frame.slots.length && !changed; s += 1) {
      const walked = frame.lists[s];
      const group = children !== undefined ? (children[frame.slots[s] as string] as unknown[]) : undefined;
      if (walked !== undefined && group !== undefined) {
        for (let at = 0; at < walked.length; at += 1) {
          if (walked[at] !== group[at]) {
            changed = true;
            break;
          }
        }
      }
    }
    if (changed && children !== undefined) {
      const groups: Record<string, unknown> = {};
      for (let s = 0; s < frame.slots.length; s += 1) {
        const slot = frame.slots[s] as string;
        const walked = frame.lists[s];
        Object.defineProperty(groups, slot, { value: walked !== undefined ? walked : children[slot], writable: true, enumerable: true, configurable: true });
      }
      const copy = next === frame.node ? (kernelGridCopy(next as unknown as Record<string, unknown>, []) as unknown as ComponentNode) : next;
      (copy as unknown as Record<string, unknown>).children = groups;
      next = copy;
    }
    frame.into[frame.at] = next;
  }
  return holder[0] as ComponentNode;
}

/** The most rows a grid's bounds may name: `DATA_GRID_ROWS_CAP` (core/schema/data-grid.ts), a function the program can splice. */
export function kernelDataGridRowsCap(): number {
  return 500;
}

/**
 * A data grid's row-count bounds as `dataGridSettingsOf` reads them (core/schema/data-grid.ts):
 * `minRows` a whole number from 0 (a fraction floored, past the cap read as the cap,
 * anything else 0); `maxRows` the same, absent (or unreadable) for no bound, and never below
 * `minRows`.
 */
export function kernelDataGridRowBounds(node: ComponentNode): { min: number; max: number | undefined } {
  const configuration = kernelConfigurationOf(node);
  const cap = kernelDataGridRowsCap();
  function whole(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !isFinite(value) || value < 0) {
      return fallback;
    }
    const floored = Math.floor(value);
    return floored > cap ? cap : floored;
  }
  const min = whole(configuration.minRows, 0);
  const configured = configuration.maxRows === undefined ? undefined : whole(configuration.maxRows, Number.NaN);
  const max = configured === undefined || isNaN(configured) ? undefined : Math.max(configured, min);
  return { min, max };
}

/**
 * A data grid's bounds once its formulas have spoken: `resolveDataGridRowBounds`
 * (core/schema/data-grid.ts) in the kernel's shape, over the fixed bounds
 * {@link kernelDataGridRowBounds} read. A formula's value that is a finite whole number from 0
 * wins (one past the cap read as the cap); anything else leaves the fixed bound in force. A
 * maximum below the resolved minimum reads as the minimum. A test holds the two equal.
 */
export function kernelResolveDataGridRowBounds(
  fixed: { min: number; max: number | undefined },
  formula: { min?: unknown; max?: unknown } | undefined
): { min: number; max: number | undefined } {
  const cap = kernelDataGridRowsCap();
  function read(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return undefined;
    }
    return value > cap ? cap : value === 0 ? 0 : value;
  }
  const fromMin = formula !== undefined ? read(formula.min) : undefined;
  const fromMax = formula !== undefined ? read(formula.max) : undefined;
  const min = fromMin !== undefined ? fromMin : fixed.min;
  const max = fromMax !== undefined ? fromMax : fixed.max;
  return { min, max: max === undefined ? undefined : Math.max(max, min) };
}

/**
 * Mirrors `buildValuePaths`: component id -> the path its own control reads and writes, each
 * data-scoping container above it adding its segment (its data key, else its id).
 */
export function kernelValuePaths(root: ComponentNode): Record<string, string> {
  const paths = kernelRecord() as Record<string, string>;
  function walk(node: ComponentNode, prefix: string): void {
    const path = prefix.length > 0 ? prefix + "." + kernelDataKeyOf(node) : kernelDataKeyOf(node);
    paths[node.id] = path;
    const childPrefix = kernelIsDataScopeContainer(node) ? path : prefix;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }
  paths[root.id] = root.id;
  return paths;
}

/**
 * Every key shape the schema defines — the sanitization allowlist — with `[]` where an entry
 * index goes. Mirrors `buildValuePaths` (root excluded: the form root holds no value) for the
 * nodes that claim a place in the data ({@link kernelClaimsData}): a field, a data-scoping
 * container, a repeating section. A node that holds no data — a button, static HTML, an image, a
 * signature, a fieldset or any other plain group — defines no key, so a submitted key spelled
 * like its id is not taken as known.
 * One addition: a repeating section's entries are known where they live — at its collection
 * path as written, whatever container sits above it, as the runtime and the PDF read them
 * — and only there. The section itself is `items` (its entries as one list); a
 * field of an entry is `items[].name`, keyed within the entry as `buildRowKeys` keys it, so a
 * section nested in another is `lines[].qty` at its own collection path, as the runtime keeps
 * it. A row field submitted as `items[0].name` has the shape `items[].name`
 * ({@link kernelKeyShape}).
 *
 * A data grid is a repeating section: its rows are entries at its collection path
 * and its children are the fields of one entry, read here as any section's are. A grid with no
 * binding is bound at its id before anything walks the definition
 * ({@link kernelNormalizeDataGrids}), so no case of its own is needed.
 */
export function kernelKnownKeyShapes(root: ComponentNode): Record<string, true> {
  const known = kernelRecord() as Record<string, true>;
  function walk(node: ComponentNode, prefix: string): void {
    const collection = kernelCollectionPathOf(node);
    let childPrefix: string;
    if (collection !== undefined) {
      // A collection path written with brackets would make forged index shapes known and the
      // runtime's own keys unknown: such a section has no known keys at all.
      if (collection.indexOf("[") >= 0 || collection.indexOf("]") >= 0) {
        return;
      }
      known[collection] = true;
      childPrefix = collection + "[]";
    } else {
      const path = prefix.length > 0 ? prefix + "." + kernelDataKeyOf(node) : kernelDataKeyOf(node);
      // Only a node with a place of its own in the data: the predicate the fold keys by.
      if (kernelClaimsData(node)) {
        known[path] = true;
      }
      childPrefix = kernelIsDataScopeContainer(node) ? path : prefix;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }
  return known;
}

/**
 * Every value path the schema defines, entry indexes left out: {@link kernelKnownKeyShapes}
 * with a row field's `items[].name` read as `items.name`. Not the allowlist, which holds
 * where an index goes.
 */
export function kernelKnownValuePaths(root: ComponentNode): Record<string, true> {
  const known = kernelRecord() as Record<string, true>;
  for (const shape of Object.keys(kernelKnownKeyShapes(root))) {
    known[shape.replace(/\[\]/g, "")] = true;
  }
  return known;
}

/**
 * A submitted key's shape as {@link kernelKnownKeyShapes} writes it: each entry index —
 * digits with no leading zero, as the runtime writes them (`[0]`, `[12]`) — as `[]`.
 * `undefined` for a key with any other bracket in it (`[01]`, `[-1]`, `[x]`, `[]`, a stray
 * `[` or `]`), which no schema defines. Where an index may stand is the allowlist's to say, so
 * `province[0]`, `items.name`, `items[0][1].name` and `items[0].name[2]` take shapes it does
 * not hold.
 */
export function kernelKeyShape(key: string): string | undefined {
  if (/[[\]]/.test(key.replace(/\[(?:0|[1-9][0-9]*)\]/g, ""))) {
    return undefined;
  }
  return key.replace(/\[(?:0|[1-9][0-9]*)\]/g, "[]");
}

/**
 * What one run remembers about the keys it is handed, shared by the row flattening, the
 * partition and the fold (all read the same keys): each key's shape ({@link kernelKeyShapeOnce})
 * and whether the schema defines it ({@link kernelDefinesKey}). Both records are prototype-free
 * and belong to the run: a key's answer never depends on anything else.
 */
export interface KernelKeyMemo {
  defined: Record<string, boolean>;
  shapes: Record<string, string | false>;
}

/**
 * {@link kernelKeyShape} asked once per key of a run: `shapes` (prototype-free, one per run)
 * remembers each answer, `false` for a key with no shape. The row flattening and the partition
 * read the same keys, so they share one.
 */
export function kernelKeyShapeOnce(shapes: Record<string, string | false>, key: string): string | undefined {
  const seen = shapes[key];
  if (seen !== undefined) {
    return seen === false ? undefined : seen;
  }
  const shape = kernelKeyShape(key);
  shapes[key] = shape === undefined ? false : shape;
  return shape;
}

/**
 * Whether the schema defines a submitted key: its shape ({@link kernelKeyShape}) is one the
 * allowlist ({@link kernelKnownKeyShapes}) holds. What {@link kernelPartitionValues} keeps, and
 * what the fold's rules, the journey and a PDF layout's `when` may read.
 * `memo` remembers the answer per key; `shapes` the key's shape ({@link kernelKeyShapeOnce}).
 */
export function kernelDefinesKey(
  knownShapes: Record<string, true>,
  key: string,
  memo?: Record<string, boolean>,
  shapes?: Record<string, string | false>
): boolean {
  if (memo !== undefined) {
    const seen = memo[key];
    if (seen !== undefined) {
      return seen;
    }
  }
  const shape = shapes !== undefined ? kernelKeyShapeOnce(shapes, key) : kernelKeyShape(key);
  const defined = shape !== undefined && kernelOwn(knownShapes, shape) === true;
  if (memo !== undefined) {
    memo[key] = defined;
  }
  return defined;
}

/**
 * Collapses collection indexes so `items[2].name` reads as `items.name` — for naming the
 * component an error's path belongs to. The allowlist reads a key's exact shape instead
 * ({@link kernelKeyShape}).
 */
export function kernelNormalizePath(key: string): string {
  return key.replace(/\[\d+\]/g, "");
}

/**
 * The keys whose answer is a list of rows: each repeating section's collection path,
 * a data grid's among them, as written, found by the walk
 * {@link kernelKnownKeyShapes} takes (a path written with brackets is none, and a section with
 * one hides its subtree). No prototype.
 */
export function kernelRowListPaths(root: ComponentNode): Record<string, true> {
  const lists = kernelRecord() as Record<string, true>;
  function walk(node: ComponentNode): void {
    const collection = kernelCollectionPathOf(node);
    if (collection !== undefined) {
      if (collection.indexOf("[") >= 0 || collection.indexOf("]") >= 0) {
        return;
      }
      lists[collection] = true;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child);
    }
  }
  return lists;
}

/**
 * The key shapes ({@link kernelKeyShape}) of the data-scoping containers that hold no answer of
 * their own: a container's key only leads on to the keys of what it holds, so nothing posted at
 * it is a value. The walk {@link kernelKnownKeyShapes} takes; a shape
 * some other node also claims (a field sharing the container's data key) is left out, as it may
 * hold an answer. No prototype.
 */
export function kernelContainerKeys(root: ComponentNode): Record<string, true> {
  const containers = kernelRecord() as Record<string, true>;
  const others = kernelRecord() as Record<string, true>;
  function walk(node: ComponentNode, prefix: string): void {
    const collection = kernelCollectionPathOf(node);
    let childPrefix: string;
    if (collection !== undefined) {
      if (collection.indexOf("[") >= 0 || collection.indexOf("]") >= 0) {
        return;
      }
      others[collection] = true;
      childPrefix = collection + "[]";
    } else {
      const path = prefix.length > 0 ? prefix + "." + kernelDataKeyOf(node) : kernelDataKeyOf(node);
      if (kernelIsDataScopeContainer(node)) {
        containers[path] = true;
      } else if (kernelClaimsData(node)) {
        others[path] = true;
      }
      childPrefix = kernelIsDataScopeContainer(node) ? path : prefix;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, childPrefix);
      }
    }
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, "");
    }
  }
  for (const shape of Object.keys(others)) {
    delete containers[shape];
  }
  return containers;
}

/**
 * Rows posted whole, read as the flat keys the runtime writes. A section's entries
 * (a data grid's rows among them) travel as `items[0].sku`, one key per answer; a
 * host or a hand-made submission may post them instead as one list at the collection path
 * (`items: [{ sku: "A-1" }]`), which the allowlist would keep as one answer, the PDF would
 * read as rows and the index would store as one row. So, before the allowlist reads anything,
 * a list of plain objects at such a key becomes the flat keys (`items[0].sku`), in place: each
 * row's key is appended to `items[i]`, and a plain object under a key that leads to known
 * keys (a data-scoping container in the entry, `addr: { city }`) is read the same way, a
 * level at a time, while one that does not (a checkboxes answer) is the answer. The same goes
 * for such an object posted at a container's key among the values themselves (`addr: { city }`
 * is read as `addr.city`); a key sent flat beside it wins (`superseded`), and an
 * object nested past 16 levels, which cannot be read as keys and is not an answer, is not
 * stored (`unreadable`, and in `unknownKeys`). Every reader then sees one shape. A key the rows spell that the schema does not define is left for
 * `unknownFields`, like any other. When flat keys for the same list are sent too
 * (`items[0].sku` beside `items`), they win and the list is dropped (`superseded`). A value
 * at such a key that is not a list of plain objects is not rows at all: it is listed in
 * `malformed`, kept in place, and its key is treated as one the schema does not define. An
 * empty list is no rows and becomes no key.
 */
export function kernelFlattenRows(
  values: Record<string, unknown>,
  root: ComponentNode,
  prepared?: KernelPrepared,
  shapes?: Record<string, string | false>
): { values: Record<string, unknown>; malformed: string[]; superseded: string[]; unreadable: string[]; emptyRows: string[]; filledRows: string[] } {
  const lists = kernelPreparedGet(prepared, root, "rowLists", () => kernelRowListPaths(root));
  const branches = kernelPreparedGet(prepared, root, "branches", () => {
    const known = kernelPreparedGet(prepared, root, "knownShapes", () => kernelKnownKeyShapes(root));
    const found = kernelRecord() as Record<string, true>;
    for (const shape of Object.keys(known)) {
      for (let at = shape.indexOf("."); at >= 0; at = shape.indexOf(".", at + 1)) {
        found[shape.slice(0, at)] = true;
      }
    }
    return found;
  });
  const keys = Object.keys(values);
  const flatFor = kernelRecord() as Record<string, true>;
  for (const key of keys) {
    const bracket = key.indexOf("[");
    if (bracket > 0 && kernelOwn(lists, key.slice(0, bracket)) === true) {
      flatFor[key.slice(0, bracket)] = true;
    }
  }
  const containers = kernelPreparedGet(prepared, root, "containerKeys", () => kernelContainerKeys(root));
  const out = kernelRecord() as Record<string, unknown>;
  const malformed: string[] = [];
  const superseded: string[] = [];
  const unreadable: string[] = [];
  // Rows posted as `{}`: present rows with no key to show for it; and,
  // since a data grid counts rows, a posted row that stores no key at all (`{ address: {} }`, every
  // key of it unreadable) is one too, so the count is the rows the person sent.
  const emptyRows: string[] = [];
  // The posted rows that did store a key: the partition records those whose every key the
  // schema does not define (`{ junk: 1 }`) as empty rows once it has stripped them.
  const filledRows: string[] = [];
  // How many keys the walk has stored so far: a row that adds none is an empty row.
  let stored = 0;
  function isRow(value: unknown): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function isRows(value: unknown): value is Record<string, unknown>[] {
    return Array.isArray(value) && (value as unknown[]).every(isRow);
  }
  // `top` is the key the walk started from when it is a key of the values themselves (not one
  // inside a row): a key the person sent flat beside the object that spells it wins
  function emit(prefix: string, row: Record<string, unknown>, depth: number, top: string | undefined): void {
    const names = Object.keys(row);
    if (names.length === 0 && prefix.charAt(prefix.length - 1) === "]") {
      emptyRows.push(prefix);
    }
    for (const name of names) {
      const key = prefix + "." + name;
      const value = row[name];
      const shape = shapes !== undefined ? kernelKeyShapeOnce(shapes, key) : kernelKeyShape(key);
      if (top !== undefined && Object.prototype.hasOwnProperty.call(values, key)) {
        if (superseded[superseded.length - 1] !== top) {
          superseded.push(top);
        }
      } else if (isRow(value) && shape !== undefined && kernelOwn(branches, shape) === true) {
        if (depth < 16) {
          emit(key, value as Record<string, unknown>, depth + 1, top);
        } else {
          // Too deep to read as keys, and an object here is not an answer: not stored.
          unreadable.push(key);
        }
      } else if (kernelOwn(lists, key) === true) {
        // A list path reached through a container is held to what the flat spelling is:
        // rows are read, anything else is a malformed list, and rows nested
        // too deep to read are not stored.
        if (!isRows(value)) {
          malformed.push(key);
          out[key] = value;
          stored += 1;
        } else if (depth < 16) {
          for (let index = 0; index < value.length; index += 1) {
            emitRow(key + "[" + index + "]", value[index] as Record<string, unknown>, depth + 1);
          }
        } else {
          unreadable.push(key);
        }
      } else if (shape !== undefined && kernelOwn(containers, shape) === true) {
        // A container holds no answer: a scalar, a list or null at its key is not stored.
        unreadable.push(key);
      } else {
        out[key] = value;
        stored += 1;
      }
    }
  }
  // One posted row (`items[2]`): read as keys, and listed as an empty row when it stored none,
  // else as a filled one for the partition to look at again.
  function emitRow(prefix: string, row: Record<string, unknown>, depth: number): void {
    const before = stored;
    emit(prefix, row, depth, undefined);
    if (stored > before) {
      filledRows.push(prefix);
    } else if (emptyRows[emptyRows.length - 1] !== prefix) {
      emptyRows.push(prefix);
    }
  }
  for (const key of keys) {
    const value = values[key];
    if (kernelOwn(lists, key) !== true || value === undefined) {
      const shape = shapes !== undefined ? kernelKeyShapeOnce(shapes, key) : kernelKeyShape(key);
      if (isRow(value) && shape !== undefined && kernelOwn(branches, shape) === true && !shape.endsWith("]")) {
        // An object posted whole at a data-scoping container's key (`addr: { pick }`) is read
        // as the flat keys the runtime stores (`addr.pick`), as one inside a row is, so the
        // allowlist, the option check and the constraints all see one shape
        // A key nothing leads on from (a checkboxes answer) is the answer itself, and an
        // entry's own key (`items[0]`, no schema key) stays the unknown key it is.
        emit(key, value as Record<string, unknown>, 0, key);
      } else if (shape !== undefined && kernelOwn(containers, shape) === true) {
        // Anything else posted at a container's own key (a scalar, a list, null, an object of an
        // empty container) is no answer and is not stored: unknown in
        // strip and keep, `unknown_field` in reject.
        unreadable.push(key);
      } else {
        out[key] = value;
      }
      continue;
    }
    if (isRows(value)) {
      if (kernelOwn(flatFor, key) === true) {
        superseded.push(key);
        continue;
      }
      for (let index = 0; index < value.length; index += 1) {
        emitRow(key + "[" + index + "]", value[index] as Record<string, unknown>, 0);
      }
      continue;
    }
    malformed.push(key);
    out[key] = value;
  }
  return { values: out, malformed, superseded, unreadable, emptyRows, filledRows };
}

/**
 * Splits submitted values into the keys the schema defines (in their original order) and
 * the keys it does not. What happens to the unknown keys is the caller's
 * {@link KernelUnknownFieldsMode} decision. A key is known only in a shape the schema
 * defines: an entry index straight after a repeating section's collection path, exactly one,
 * followed by a field of the entry, and nowhere else. `province[0]` beside a plain
 * `province`, `items.name` without its index, `items[0][1].name` and `items[0].name[2]` are
 * unknown like any other key, although taking their indexes out would leave a known path.
 * Rows posted whole are read as flat keys first ({@link kernelFlattenRows}): a list
 * of row objects at a collection path is split into `items[0].sku` keys
 * in its place, a list beside flat keys of its own is dropped (`superseded`), and a value
 * there that is not a list of row objects is unknown (`malformed`, and in `unknownKeys`).
 * A row posted as `{}` has no key but is a present row: its entry (`items[2]`) is listed in
 * `emptyRows` for the field constraints.
 */
export function kernelPartitionValues(
  values: Record<string, unknown>,
  root: ComponentNode,
  prepared?: KernelPrepared,
  keyMemo?: KernelKeyMemo
): { known: Record<string, unknown>; unknownKeys: string[]; superseded: string[]; emptyRows: string[] } {
  // One memo for the flattening and the partition (and, in a run, the fold): they read the same keys.
  const memo: KernelKeyMemo = keyMemo !== undefined ? keyMemo : { defined: kernelRecord() as Record<string, boolean>, shapes: kernelRecord() as Record<string, string | false> };
  const shapes = memo.shapes;
  const rows = kernelFlattenRows(values, root, prepared, shapes);
  const knownShapes = kernelPreparedGet(prepared, root, "knownShapes", () => kernelKnownKeyShapes(root));
  const known = kernelRecord() as Record<string, unknown>;
  const unknownKeys: string[] = [];
  const definedMemo = memo.defined;
  for (const key of Object.keys(rows.values)) {
    const value = rows.values[key];
    if (rows.malformed.indexOf(key) < 0 && kernelDefinesKey(knownShapes, key, definedMemo, shapes)) {
      known[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }
  for (const key of rows.unreadable) {
    unknownKeys.push(key);
  }
  // A posted row whose every key the schema does not define (`items: [{ junk: 1 }]`) is a row the
  // person sent all the same: once stripped it has no key left, so it is listed with the rows
  // posted as `{}`, and the row count (`rows.min` / `rows.max`) and its required cells
  // see it, as the browser's stage counts the list it was handed.
  const emptyRows = rows.emptyRows;
  if (rows.filledRows !== undefined && rows.filledRows.length > 0) {
    const kept = kernelRecord() as Record<string, true>;
    for (const key of Object.keys(known)) {
      for (let at = key.indexOf("]."); at >= 0; at = key.indexOf("].", at + 1)) {
        kept[key.slice(0, at + 1)] = true;
      }
    }
    for (let r = 0; r < rows.filledRows.length; r += 1) {
      const row = rows.filledRows[r] as string;
      if (kept[row] !== true) {
        emptyRows.push(row);
      }
    }
  }
  return { known, unknownKeys, superseded: rows.superseded, emptyRows };
}

/**
 * The validated-data guarantee in its default form: any submitted key the schema does not
 * define is silently dropped. Known keys pass through untouched, in their original order.
 */
export function kernelSanitizeValues(
  values: Record<string, unknown>,
  root: ComponentNode
): Record<string, unknown> {
  return kernelPartitionValues(values, root).known;
}

/**
 * The tree as the fold walks it: every node id root first in document (pre-)order, as the
 * browser orchestrator walks it, each node by id, and each child's parent. The records have
 * no prototype, so an id or a submitted key such as `constructor` never reads an inherited
 * member. A run refuses a tree whose parents would loop, or that holds a node of no shape,
 * before it gets here (`kernelComponentTreeFault`); for any other caller the index skips what is
 * not a node and never records a parent that would close a loop (the earlier parent stays), so
 * every walk up the parents ends.
 */
export function kernelTreeIndex(root: ComponentNode): {
  order: string[];
  nodeById: Record<string, ComponentNode>;
  parentOf: Record<string, string>;
} {
  const order: string[] = [];
  const nodeById = kernelRecord() as Record<string, ComponentNode>;
  const parentOf = kernelRecord() as Record<string, string>;
  function closesLoop(child: string, parent: string): boolean {
    let at: string | undefined = parent;
    for (let step = 0; at !== undefined && step <= order.length; step += 1) {
      if (at === child) {
        return true;
      }
      at = parentOf[at];
    }
    return at !== undefined;
  }
  function walk(node: ComponentNode): void {
    order.push(node.id);
    nodeById[node.id] = node;
    const children: unknown = node.children;
    if (children === null || typeof children !== "object") {
      return;
    }
    for (const group of Object.values(children as Record<string, unknown>)) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group as unknown[]) {
        if (child === null || typeof child !== "object" || Array.isArray(child)) {
          continue;
        }
        const one = child as ComponentNode;
        if (!closesLoop(one.id, node.id)) {
          parentOf[one.id] = node.id;
        }
        walk(one);
      }
    }
  }
  walk(root);
  return { order, nodeById, parentOf };
}

/**
 * Mirrors `holdsData` with its default reading of valueless types (core/tree/data-scope.ts):
 * a value-bearing field, a data-scoping container or a repeating section (a data grid is one)
 * claims a place in the data; a group (anything with a children map, or a grouping type) and a
 * component that carries no answer (a button, static HTML, an image, a signature) claim none.
 * The leaf reading — a component holding an answer of its own — is the fold's
 * `kernelFoldHoldsOwnAnswer`, which also gates `requiredWhen`, so the two cannot
 * drift.
 */
export function kernelClaimsData(node: ComponentNode): boolean {
  return (
    node.collection !== undefined ||
    kernelIsDataScopeContainer(node) ||
    kernelFoldHoldsOwnAnswer(node)
  );
}

/**
 * Mirrors `buildComponentIdsByPath`: value path -> the ids of the components whose answer is
 * stored there, in document order. What the fold re-keys values by, so a rule reads
 * `billing_street` wherever its answer is stored. No prototype, for the same reason as
 * {@link kernelTreeIndex}: the fold looks submitted keys up in it.
 */
export function kernelComponentIdsByPath(root: ComponentNode, valuePaths?: Record<string, string>): Record<string, string[]> {
  const paths = valuePaths !== undefined ? valuePaths : kernelValuePaths(root);
  const byPath = kernelRecord() as Record<string, string[]>;
  function visit(node: ComponentNode): void {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (kernelClaimsData(child)) {
          const path = kernelOwn(paths, child.id) ?? child.id;
          const owners = byPath[path];
          if (owners !== undefined) {
            owners.push(child.id);
          } else {
            byPath[path] = [child.id];
          }
        }
        visit(child);
      }
    }
  }
  visit(root);
  return byPath;
}

/**
 * The flat value index of a run's sanitized values: one row per answer, the shape a
 * host stores for search and views. `path` is the key with every entry index (`[0]`) taken
 * out, `delta` those indexes joined with `.` (empty for a key with none), `value` the answer
 * as the values hold it. A list whose items are all scalars or `null` gives one row per item,
 * the item's position appended to `delta` (`tags` at `["a","b"]` gives deltas `0` and `1`; an
 * empty list gives no row); any other object or list is one row, as is. A key holding
 * `undefined` is no answer (JSON drops it) and gives no row, and a list item holding
 * `undefined` reads as `null`, as JSON writes it. Rows follow the keys in the order the
 * serialized values list them ({@link kernelSortKeys}), so the index and `values` read alike.
 */
export function kernelValueIndex(values: Record<string, unknown>): KernelIndexRow[] {
  const rows: KernelIndexRow[] = [];
  const keys = Object.keys(kernelSortKeys(Object.fromEntries(Object.keys(values).map((key) => [key, 0]))) as Record<string, unknown>);
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) {
      continue;
    }
    const indexes: string[] = [];
    const path = key.replace(/\[(\d+)\]/g, function (_match: string, digits: string): string {
      indexes.push(digits);
      return "";
    });
    const delta = indexes.join(".");
    if (Array.isArray(value)) {
      let scalars = true;
      for (const item of value as unknown[]) {
        if (item !== null && item !== undefined && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
          scalars = false;
          break;
        }
      }
      if (scalars) {
        for (let position = 0; position < value.length; position += 1) {
          const item: unknown = value[position];
          rows.push({ path, delta: delta.length > 0 ? delta + "." + position : String(position), value: item === undefined ? null : item });
        }
        continue;
      }
    }
    rows.push({ path, delta, value });
  }
  return rows;
}

/**
 * Every value path the kernel reads for a definition (the `inspect` op's `paths`), one
 * entry per component in document order, the form root left out: the path the component's
 * data sits at with entry indexes left out (`items.sku`, as {@link kernelValueIndex} writes a
 * row's `path`), its id and type, and whether it holds data ({@link kernelClaimsData}, the
 * engine's `holdsData`: a button, static HTML, an image, a signature and a plain group hold
 * none, and are listed with the path they would have). Walked exactly as
 * {@link kernelKnownKeyShapes} walks the allowlist, with the same expressions, so the paths
 * that hold data are {@link kernelKnownValuePaths}, no more and no fewer: data keys,
 * data-scoping containers, and a repeating section's entries at its collection path as written
 * (`collection` names it, on the section and on every component inside one entry). A data grid
 * is listed as such a section: its children are the fields of one entry, and the
 * tree is read through {@link kernelNormalizeDataGrids} first, so a grid with no binding is
 * listed at its id, as the run reads it. A section whose
 * collection path is written with brackets has no known keys and is left out with its subtree. An id
 * that is not a string is read as the allowlist reads it (`String(id)`). A journey page's own
 * nodes hold no form value and are not listed; the form fields they place are, here.
 * Walked with an explicit stack, so a tree of any depth is read. The allowlist cannot read a
 * child that is not an object at all (it has no id), so that child is skipped here, and a slot
 * that is not a list too.
 */
export function kernelDefinitionPaths(authored: ComponentNode): InspectedPath[] {
  const root = kernelNormalizeDataGrids(authored);
  const out: InspectedPath[] = [];
  const stack: Array<{ node: ComponentNode; prefix: string; collection: string | undefined }> = [];
  function pushChildren(node: ComponentNode, prefix: string, collection: string | undefined): void {
    const children = node.children;
    if (children === null || typeof children !== "object") {
      return;
    }
    const pending: Array<{ node: ComponentNode; prefix: string; collection: string | undefined }> = [];
    for (const group of Object.values(children)) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group as unknown[]) {
        if (child !== null && typeof child === "object") {
          pending.push({ node: child as ComponentNode, prefix, collection });
        }
      }
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      stack.push(pending[index] as { node: ComponentNode; prefix: string; collection: string | undefined });
    }
  }
  pushChildren(root, "", undefined);
  while (stack.length > 0) {
    const frame = stack.pop() as { node: ComponentNode; prefix: string; collection: string | undefined };
    const node = frame.node;
    const componentId = String(node.id);
    const type = typeof node.type === "string" ? node.type : "";
    const collection = kernelCollectionPathOf(node);
    if (collection !== undefined) {
      if (collection.indexOf("[") >= 0 || collection.indexOf("]") >= 0) {
        continue;
      }
      out.push({ path: collection, componentId, type, holdsData: true, collection: { collectionPath: collection } });
      pushChildren(node, collection, collection);
      continue;
    }
    const path = frame.prefix.length > 0 ? frame.prefix + "." + kernelDataKeyOf(node) : String(kernelDataKeyOf(node));
    const configuration = kernelConfigurationOf(node);
    const entry: InspectedPath = { path, componentId, type, holdsData: kernelClaimsData(node) };
    // The data source a choice names, and whether its author declared the answers free.
    const sourceId = kernelOptionSourceId(configuration);
    if (sourceId !== undefined) {
      entry.source = { id: sourceId, free: kernelOptionSourceFree(configuration) };
    }
    if (frame.collection !== undefined) {
      entry.collection = { collectionPath: frame.collection };
    }
    out.push(entry);
    pushChildren(node, kernelIsDataScopeContainer(node) ? path : frame.prefix, frame.collection);
  }
  return out;
}

/**
 * Names the rule about to be evaluated on the run's evaluation: `rules:<id>:<key>`.
 * A plugin function that throws while it runs is recorded against this name, so a refusal
 * under `formulaErrors: "fail"` can say which rule it was. No evaluation, no name.
 */
export function kernelMarkRule(evaluation: KernelEvaluation | undefined, componentId: string, key: string): void {
  if (evaluation !== undefined) {
    evaluation.where = "rules:" + componentId + ":" + key;
  }
}

/**
 * The rule context the browser's orchestrator builds for a node (`contextOver` +
 * `ruleContext`, runtime/browser/runtime-orchestrator.ts), over one view of the answers keyed
 * both ways: form values keyed by component id, the node's own answer at its value path, and
 * each ancestor's answer keyed by the ancestor's id, nearest first. The host context only when
 * the server supplied one (`evaluation.hostContext`); without it, no rule reading `host.` gets
 * this far. One builder for every rule the kernel evaluates —
 * {@link kernelResolveSemanticState} and {@link kernelRuleRequired} — so their readings cannot
 * drift.
 */
export function kernelRuleContext(
  node: ComponentNode,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  pathOf: Record<string, string>,
  parentOf: Record<string, string>,
  evaluation?: KernelEvaluation
): RuleEvaluationContext {
  const ancestorValues = kernelRecord() as Record<string, unknown>;
  let parent = kernelOwn(parentOf, node.id);
  while (parent !== undefined) {
    ancestorValues[parent] = kernelOwn(pathValues, kernelOwn(pathOf, parent) ?? parent);
    parent = kernelOwn(parentOf, parent);
  }
  const context: RuleEvaluationContext = {
    values: idValues,
    componentValue: kernelOwn(pathValues, kernelOwn(pathOf, node.id) ?? node.id),
    ancestorValues
  };
  if (evaluation !== undefined && evaluation.today !== undefined) {
    context.today = evaluation.today;
  }
  if (evaluation !== undefined && evaluation.hostContext !== undefined) {
    context.hostContext = evaluation.hostContext;
  }
  if (evaluation !== undefined && evaluation.functions !== undefined) {
    context.functions = evaluation.functions;
  }
  if (evaluation !== undefined && evaluation.warn !== undefined) {
    context.warn = evaluation.warn;
  }
  if (evaluation !== undefined && evaluation.regexCache !== undefined) {
    context.regexCache = evaluation.regexCache;
  }
  return context;
}

/**
 * Mirrors `RulesSemanticStateResolver` (runtime/browser/runtime-orchestrator.ts): the node's
 * configuration flags, then its `visibleWhen` / `enabledWhen` / `readonlyWhen` over the same
 * rule context the browser builds ({@link kernelRuleContext}).
 *
 * One difference, by necessity: a rule that reads a `host.` path is left unevaluated, and the
 * node keeps its configured state for that rule, unless the server supplied a host context of its
 * own (`evaluation.hostContext`), which the rule then reads. Without one the server cannot
 * reproduce such a rule; the journey diagnostics warn about it
 * (`rule.reads-host`). The same skip (`kernelRuleSkipped`) covers a rule scoped to the
 * browser (`run: "browser"`), which the author asked the server not to replay, and one reading
 * the clock when the context gave no day; a rule scoped to the server is applied here and
 * nowhere else.
 */
export function kernelResolveSemanticState(
  node: ComponentNode,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  pathOf: Record<string, string>,
  parentOf: Record<string, string>,
  evaluation?: KernelEvaluation
): SemanticNodeState {
  const state = kernelBaseSemanticState(node);
  const rules = node.rules;
  if (!rules) {
    return state;
  }
  const today = evaluation !== undefined ? evaluation.today : undefined;
  const hostKnown = evaluation !== undefined && evaluation.hostContext !== undefined;
  const context = kernelRuleContext(node, idValues, pathValues, pathOf, parentOf, evaluation);
  const visibleWhen = kernelCompiledRule(rules.visibleWhen);
  if (visibleWhen !== undefined && !kernelRuleSkipped(rules.visibleWhen, visibleWhen, "visibleWhen", "server", today, hostKnown)) {
    kernelMarkRule(evaluation, node.id, "visibleWhen");
    state.visible = kernelEvaluateExpression(visibleWhen, context) === true;
  }
  const enabledWhen = kernelCompiledRule(rules.enabledWhen);
  if (enabledWhen !== undefined && !kernelRuleSkipped(rules.enabledWhen, enabledWhen, "enabledWhen", "server", today, hostKnown)) {
    kernelMarkRule(evaluation, node.id, "enabledWhen");
    state.disabled = kernelEvaluateExpression(enabledWhen, context) !== true;
  }
  const readonlyWhen = kernelCompiledRule(rules.readonlyWhen);
  if (readonlyWhen !== undefined && !kernelRuleSkipped(rules.readonlyWhen, readonlyWhen, "readonlyWhen", "server", today, hostKnown)) {
    kernelMarkRule(evaluation, node.id, "readonlyWhen");
    state.readonly = kernelEvaluateExpression(readonlyWhen, context) === true;
  }
  return state;
}

/**
 * Whether a node's `rules.requiredWhen` holds over the settled view: the fold's
 * `ruleRequired`, over the same context as the browser's (`kernelRuleContext`). A rule that
 * reads `host.` is `false` here: the server has no host context, and requiredness is `required`
 * OR the rule, so a server that cannot evaluate the rule is never stricter than the browser
 * that can. The builder says so under the rule (the Rules tab's note), and so do the journey
 * diagnostics (`rule.reads-host`) for a form that has a journey — a form without one gets no
 * diagnostic for it. Called only where the fold reads the rule at all (`kernelFoldRequired`).
 * A rule scoped to the browser, or reading the clock with no day given, is `false` here for
 * the same reason (`kernelRuleSkipped`); a rule scoped to the server is enforced here alone,
 * the author's opt-out of that reading for one rule.
 */
export function kernelRuleRequired(
  node: ComponentNode,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  pathOf: Record<string, string>,
  parentOf: Record<string, string>,
  evaluation?: KernelEvaluation
): boolean {
  // By truthiness, as every rule is read: a hand-written `rules: null` or `requiredWhen: null` is no rule.
  const source = node.rules ? node.rules.requiredWhen : undefined;
  const rule = source ? kernelCompiledRule(source) : undefined;
  if (rule === undefined || kernelRuleSkipped(source, rule, "requiredWhen", "server", evaluation !== undefined ? evaluation.today : undefined, evaluation !== undefined && evaluation.hostContext !== undefined)) {
    return false;
  }
  kernelMarkRule(evaluation, node.id, "requiredWhen");
  return kernelEvaluateExpression(rule, kernelRuleContext(node, idValues, pathValues, pathOf, parentOf, evaluation)) === true;
}

/**
 * Whether a node's `rules.validWhen` holds over the settled view: the fold's
 * `ruleValid`, over the same context as the browser's (`kernelRuleContext`). Holds only for a
 * yes-or-no `true`: `false`, no answer, and a rule whose plugin function threw (it reads
 * `undefined`) do not, so the answer is refused, the fail-closed reading. A rule this side skips
 * (`kernelRuleSkipped`: scoped to the browser, reading `host.`, reading the clock with no day
 * given) holds here, a lenient reading: a server that cannot evaluate a check is never
 * stricter than the browser that can. A rule scoped to the server is enforced here alone.
 */
export function kernelRuleValid(
  node: ComponentNode,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  pathOf: Record<string, string>,
  parentOf: Record<string, string>,
  evaluation?: KernelEvaluation
): boolean {
  const source = node.rules ? node.rules.validWhen : undefined;
  const rule = source ? kernelCompiledRule(source) : undefined;
  if (rule === undefined || kernelRuleSkipped(source, rule, "validWhen", "server", evaluation !== undefined ? evaluation.today : undefined, evaluation !== undefined && evaluation.hostContext !== undefined)) {
    return true;
  }
  kernelMarkRule(evaluation, node.id, "validWhen");
  return kernelEvaluateExpression(rule, kernelRuleContext(node, idValues, pathValues, pathOf, parentOf, evaluation)) === true;
}

/**
 * What a data grid's `rules.minRows` or `rules.maxRows` (`key`) comes to over the settled view:
 * the fold's `ruleRowBound`, evaluated form-scoped over the same context as every
 * rule of the node ({@link kernelRuleContext}). `undefined`, so the fixed bound stands, for a
 * rule this side skips ({@link kernelRuleSkipped}: scoped to the browser, reading `host.`,
 * reading the clock with no day given) and for one whose plugin function threw; a rule scoped
 * to the server is applied here alone. The fold never asks for a rule reading `row.`.
 */
export function kernelRuleRowBound(
  node: ComponentNode,
  key: "minRows" | "maxRows",
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  pathOf: Record<string, string>,
  parentOf: Record<string, string>,
  evaluation?: KernelEvaluation
): unknown {
  const source = node.rules ? node.rules[key] : undefined;
  const rule = source ? kernelCompiledRule(source) : undefined;
  if (rule === undefined || kernelRuleSkipped(source, rule, key, "server", evaluation !== undefined ? evaluation.today : undefined, evaluation !== undefined && evaluation.hostContext !== undefined)) {
    return undefined;
  }
  kernelMarkRule(evaluation, node.id, key);
  return kernelEvaluateExpression(rule, kernelRuleContext(node, idValues, pathValues, pathOf, parentOf, evaluation));
}

/**
 * Mirrors the collection owners the browser orchestrator builds: collection path -> the
 * repeating section whose entries live there (`collectionPathOf`; a data grid is one),
 * first in document order. What the fold judges a key no component owns by
 * (`KernelFoldInput.collectionOwners`): an entry's keys follow their section, so a
 * hidden-and-excluded or off-path one no longer submits them, and they steer no rule.
 */
export function kernelCollectionOwners(index: {
  order: string[];
  nodeById: Record<string, ComponentNode>;
}): Record<string, string> {
  const owners = kernelRecord() as Record<string, string>;
  for (let position = 1; position < index.order.length; position += 1) {
    const id = index.order[position] as string;
    const node = kernelOwn(index.nodeById, id);
    const collectionPath = node !== undefined ? kernelCollectionPathOf(node) : undefined;
    if (collectionPath !== undefined && kernelOwn(owners, collectionPath) === undefined) {
      owners[collectionPath] = id;
    }
  }
  return owners;
}

/**
 * Whether an unanswered read of a calculation might have been an answer the browser held and
 * the submission left out, so the server cannot tell "the person
 * left it empty" from "the browser read it and withheld it". Only then is the calculation taken
 * on trust. `read` names a component by id. It is a withheld read when it names no data-holding
 * component of this form (a `host.` path, a repeating section's collection, an entry's `row.`
 * field, a name nothing owns), when the component sits in a repeating section, when a journey
 * runs (a page the path skips drops its answers, by default excluded), or when the component can
 * be hidden (`hidden`, or a `visibleWhen`, on it or an ancestor) and does not say a hidden answer is
 * kept and sent (`hiddenValueBehavior: "retain"`; by default it is left out of the submission). A component the journey's path
 * is known to skip (`offPath`, the fold's own placement of it) is no
 * longer a maybe: withheld for certain, its read is the empty operand; one on the path is judged
 * as a form without a journey judges it. Any other component, optional
 * or required, never hidden or one whose hidden answer is retained, is an input the browser
 * would have sent had it held an answer: its absence is the person's, and the calculation is
 * worked out over the empty operand, as the browser worked it out.
 */
export function kernelReadMayBeWithheld(
  read: string,
  index: { order: string[]; nodeById: Record<string, ComponentNode>; parentOf: Record<string, string> },
  journeyed: boolean,
  offPath?: Record<string, true>
): boolean {
  const node = kernelOwn(index.nodeById, read);
  if (node === undefined || !kernelClaimsData(node) || kernelFoldInSection(read, index.nodeById, index.parentOf)) {
    return true;
  }
  if (journeyed) {
    // Before the fold has placed anything (`offPath` absent) any component under a journey might
    // have been left out. Once it has, a component only on pages the path skips is withheld for
    // certain: the calculation is worked out over the empty operand, as the
    // browser's is over the settled view. Any other component is the form's own kind of input:
    // on the path and never hidden, its absence is the person's, and the
    // calculation is worked out over it; only one that can be hidden and excluded stays a maybe.
    if (offPath === undefined) {
      return true;
    }
    if (kernelOwn(offPath, read) === true) {
      return false;
    }
  }
  // Only a component whose hidden answer is kept and sent cannot have been withheld: one that says
  // `retain`, or says nothing and asks to be required or validated while hidden (the default of
  // `computeEffectiveNodeState`). By default a hidden answer is left out of the submission.
  const behavior = kernelReadEnum(node.configuration, "hiddenValueBehavior", ["retain", "clear", "exclude-from-submission"]);
  if (
    behavior === "retain" ||
    (behavior === undefined &&
      (kernelReadEnum(node.configuration, "hiddenRequiredBehavior", ["required", "not-required"]) === "required" ||
        kernelReadEnum(node.configuration, "hiddenValidationBehavior", ["validate", "skip"]) === "validate"))
  ) {
    return false;
  }
  let current: string | undefined = read;
  while (current !== undefined) {
    const one = kernelOwn(index.nodeById, current);
    if (one !== undefined && (kernelReadFlag(one.configuration, "hidden") || (one.rules !== undefined && one.rules !== null && Boolean(one.rules.visibleWhen)))) {
      return true;
    }
    current = kernelOwn(index.parentOf, current);
  }
  return false;
}

/**
 * The calculations (`rules.value`) worked out again from what was submitted, before the fold
 * reads them: the browser's `RuntimeOrchestrator.runValueRules`, defaults aside. A
 * calculated answer is not one the person gave. Taken as sent, a forged one could hide a
 * required field or skip a page (`age` sent as 40 beside a `birth_year` of 2015). So each
 * calculation is evaluated in document order over the answers as they stand, to a bounded
 * fixpoint, and its result laid over the submitted one: the fold, the conditions, the checks
 * and the returned values all read the server's own result.
 *
 * A calculation keeps its submitted value where the server cannot reproduce the browser's:
 * - it reads `host.` and the server supplied no host context (with one, it is worked out against
 *   it, a key the context lacks reading as no answer); or its `run` is `browser` — the author
 *   asked the server not to replay it; or it reads the clock and the context gave no day
 *   (`kernelRuleSkipped`);
 * - one of its reads comes back `undefined` and the answer might have been withheld
 *   ({@link kernelReadMayBeWithheld}) — an answer the server was not sent, maybe one the browser
 *   read while it was hidden and excluded (calculations read the stored answers). A read that
 *   cannot have been withheld (an optional input never hidden, or one whose hidden answer is
 *   retained) is the person's own empty answer, and the calculation is worked out over it as
 *   the browser worked it out (omitting an optional input cannot turn a forged
 *   result into a trusted one). A read of another calculation this side works out is answered all the same: its answer is
 *   whatever this side worked out, no answer included (arithmetic over a missing operand or by
 *   zero is `undefined`, never `NaN`), so `coalesce(ratio, 0)` is reproduced over a `ratio` that
 *   came to nothing;
 * - it is, or sits inside, a repeating section — entries are not computed one by one here.
 *
 * A calculation on a node that holds no data (a button, static HTML, a plain group) is not
 * worked out at all: such a node defines no key ({@link kernelKnownKeyShapes}), so
 * there is nowhere in the returned values for its result.
 *
 * Defaults (`rules.defaultValue`) are the person's starting answers and are not recomputed. A
 * result that serializes as the submitted value does leaves the submitted one in place, so an
 * honest submission comes back exactly as it was sent. Every read is as the envelope carries it
 * (`kernelJsonValue`): a calculation that came to no answer is no key, and reads as `undefined`
 * in the next, here and in the browser alike (a `null` sent for it, JSON's spelling of `NaN`, is
 * worked out again to no key). `recalculated` lists the
 * value paths whose answer changed, in document order; the records are prototype-free.
 *
 * `unreproduced` lists the value paths of the calculations kept as sent while a value
 * was there — one that reads `host.`, one a read of which came back unanswered in the last
 * pass — in document order: answers worked out in the browser that this side took on trust
 * ({@link kernelClientDerived}). A kept `null` (JSON's spelling of a calculation that came to
 * nothing) is no value.
 *
 * A calculation on a field of a repeating section is worked out entry by entry:
 * for each entry the values carry (`items[0].sku`, {@link kernelRowIndexes}) its
 * rule is evaluated with `row.` reading that entry's answers (keyed as the entry keys them,
 * `address.city` under a container), `rowIndex()` the entry's 1-based position among those
 * submitted and `rowCount()` how many there are, and its result laid over the entry's own key,
 * so a forged `items[0].total` is replaced. A result in `recalculated`, an entry's calculation
 * taken on trust (it reads `host.`, runs in the browser, or reads an answer the entry lacks) in
 * `unreproduced`, both by the entry's key. An aggregate over the whole section
 * (`sum(items.total)`) names no answer here and is kept as sent. The entries are
 * read from the values as they came, so an entry a calculation alone would create does not
 * exist: an entry is one the person submitted a field of.
 */
export function kernelRecomputeCalculations(
  root: ComponentNode,
  values: Record<string, unknown>,
  index: { order: string[]; nodeById: Record<string, ComponentNode>; parentOf: Record<string, string> },
  pathOf: Record<string, string>,
  idsByPath: Record<string, string[]>,
  evaluation?: KernelEvaluation,
  journeyed?: boolean,
  prepared?: KernelPrepared,
  offPath?: Record<string, true>
): {
  values: Record<string, unknown>;
  recalculated: string[];
  unreproduced: string[];
  converged: boolean;
  cycle?: string[];
  /** Every path a worked-out calculation reads; absent when there is none. */
  reads?: Record<string, true>;
  /** True when the last pass kept a calculation as sent because a read came back unanswered. */
  deferred?: boolean;
  /** The value paths this side worked out (a calculation whose reads were all answered); absent when there is none. */
  workedOut?: Record<string, true>;
} {
  const today = evaluation !== undefined ? evaluation.today : undefined;
  // A host context the server supplied: a calculation reading `host.` is worked out against it,
  // and a `host.` read it does not hold is answered (no answer), never a maybe-withheld one.
  const hostContext = evaluation !== undefined ? evaluation.hostContext : undefined;
  const hostKnown = hostContext !== undefined;
  const unparsed = evaluation !== undefined ? evaluation.unparsedCalculations : undefined;
  const calculated: ComponentNode[] = [];
  /** The ids of `calculated`: a read of one is answered by this side's own working out. */
  const calculatedById = kernelRecord() as Record<string, true>;
  /** Each calculation's tree, by component id: a compiled rule, read once. */
  const expressions = kernelRecord() as Record<string, Expression>;
  /** Every calculation, in document order: `calculated`, and those this side skips. */
  const kept: ComponentNode[] = [];
  /** The fields of a repeating section among `kept`: where their entries keep them. */
  const rowOf = kernelRecord() as Record<string, { collection: string; suffix: string }>;
  /** `row.<key>` reads that name a calculation worked out in the entry: answered whatever the result. */
  const rowCalculated = kernelRecord() as Record<string, Record<string, true>>;
  const rowCollections = kernelRecord() as Record<string, true>;
  const rowFields = kernelPreparedGet(prepared, root, "rowFields", () => kernelRowFields(root));
  for (const id of index.order) {
    const node = kernelOwn(index.nodeById, id);
    if (node === undefined || id === root.id || !kernelClaimsData(node)) {
      continue;
    }
    const hasRule = !!node.rules && !!node.rules.value;
    if (!hasRule && (unparsed === undefined || unparsed.indexOf(id) < 0)) {
      continue;
    }
    const expression = hasRule ? kernelCompiledRule((node.rules as { value: unknown }).value) : undefined;
    let inCollection = node.collection !== undefined;
    let parent = kernelOwn(index.parentOf, id);
    while (!inCollection && parent !== undefined) {
      const ancestor = kernelOwn(index.nodeById, parent);
      inCollection = ancestor !== undefined && ancestor.collection !== undefined;
      parent = kernelOwn(index.parentOf, parent);
    }
    const rowField = inCollection ? kernelOwn(rowFields, id) : undefined;
    if (!inCollection || rowField !== undefined) {
      kept.push(node);
      if (rowField !== undefined) {
        rowOf[id] = rowField;
        rowCollections[rowField.collection] = true;
      }
      // A rule that does not parse is never worked out: the sent value stays and is
      // listed in `unreproduced`, a value taken on trust.
      if (expression === undefined) {
        continue;
      }
      expressions[id] = expression;
      if (!kernelRuleSkipped((node.rules as { value: unknown }).value, expression, "value", "server", today, hostKnown)) {
        calculated.push(node);
        if (rowField !== undefined) {
          const named = kernelOwn(rowCalculated, rowField.collection) ?? kernelRecord();
          named["row." + rowField.suffix.slice(1)] = true;
          rowCalculated[rowField.collection] = named;
        } else {
          calculatedById[id] = true;
        }
      }
    }
  }
  if (kept.length === 0) {
    return { values, recalculated: [], unreproduced: [], converged: true };
  }
  /** Every path a worked-out calculation reads: what {@link kernelFoldSubmission} asks before it settles the view again. */
  const reads = kernelRecord() as Record<string, true>;
  for (const id of Object.keys(expressions)) {
    for (const read of kernelExprReadPaths(expressions[id] as Expression)) {
      const input = kernelCalculationInput(read);
      reads[read] = true;
      if (input !== "") {
        reads[input] = true;
      }
    }
  }
  /** The calculations in document order: how a cycle is named, whatever order they run in. */
  const documented = calculated.slice();
  // Calculations run sources first, as the browser orders them (post-order over what each reads,
  // document order breaking ties, a cycle keeping the order it was entered), so a chain declared
  // sources-last settles in two passes, not one per link. The walk is iterative: a long chain
  // costs no call-stack depth.
  {
    const slot = kernelRecord() as Record<string, number>;
    for (let at = 0; at < calculated.length; at += 1) {
      slot[(calculated[at] as ComponentNode).id] = at;
    }
    const sourcesOf = (at: number): number[] => {
      const found: number[] = [];
      const node = calculated[at] as ComponentNode;
      for (const read of kernelExprReadPaths(expressions[node.id] as Expression)) {
        const input = kernelCalculationInput(read);
        const place = input !== "" ? kernelOwn(slot, input) : undefined;
        if (place !== undefined && place !== at && found.indexOf(place) < 0) {
          found.push(place);
        }
      }
      return found.sort((x: number, y: number) => x - y);
    };
    const finished: boolean[] = [];
    const sequence: ComponentNode[] = [];
    for (let start = 0; start < calculated.length; start += 1) {
      if (finished[start] === true) {
        continue;
      }
      finished[start] = true;
      const stack: Array<{ at: number; sources: number[]; next: number }> = [{ at: start, sources: sourcesOf(start), next: 0 }];
      for (let top = stack[stack.length - 1]; top !== undefined; top = stack[stack.length - 1]) {
        const source = top.sources[top.next];
        if (source !== undefined) {
          top.next += 1;
          if (finished[source] !== true) {
            finished[source] = true;
            stack.push({ at: source, sources: sourcesOf(source), next: 0 });
          }
        } else {
          sequence.push(calculated[top.at] as ComponentNode);
          stack.pop();
        }
      }
    }
    calculated.length = 0;
    for (const ordered of sequence) {
      calculated.push(ordered);
    }
  }

  /** The entries each section holds, from the values as they came; and each entry's 1-based position among them. */
  const entries = kernelRowIndexes(values, rowCollections);
  const positions = kernelRecord() as Record<string, Record<string, number>>;
  for (const name of Object.keys(entries)) {
    const place = kernelRecord() as Record<string, number>;
    const list = entries[name] as number[];
    for (let at = 0; at < list.length; at += 1) {
      place[String(list[at])] = at + 1;
    }
    positions[name] = place;
  }

  const working = kernelRecord() as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    working[key] = values[key];
  }
  // The calculations the last pass could not work out, by the value path of the answer: a read came back unanswered.
  let unanswered = kernelRecord() as Record<string, true>;
  let converged = calculated.length === 0;
  /** The calculations that changed in the last pass: what is named when no static cycle is. */
  let lastChanged: string[] = [];
  const hasRows = Object.keys(rowCollections).length > 0;
  // The browser's bound: a pass per calculation, and one to see nothing change.
  for (let pass = 0; pass <= calculated.length + 1 && !converged; pass += 1) {
    let changed = false;
    lastChanged = [];
    unanswered = kernelRecord() as Record<string, true>;
    // Rules read values by component id, as of the start of the pass; a node's own answer and
    // its ancestors' as they stand — the browser's contexts. Each as the envelope carries it:
    // a calculation reading another that came to nothing reads undefined, as the
    // browser's does.
    // A write is read by the calculations after it in the same pass (they run sources first), so
    // both are rebuilt, once, before the next evaluation after a write.
    let idValues = kernelRekeyById(kernelJsonAnswers(working), idsByPath);
    // Each entry's answers keyed as the entry keys them, as of the start of the pass too.
    let rowValues = hasRows ? kernelRowValues(working, rowCollections) : undefined;
    let stale = false;
    for (const node of calculated) {
      if (stale) {
        idValues = kernelRekeyById(kernelJsonAnswers(working), idsByPath);
        rowValues = hasRows ? kernelRowValues(working, rowCollections) : undefined;
        stale = false;
      }
      const expression = expressions[node.id] as Expression;
      const rowField = kernelOwn(rowOf, node.id);
      const at = rowField !== undefined ? (kernelOwn(entries, rowField.collection) ?? []) : [-1];
      for (const entry of at) {
        const path = rowField !== undefined ? rowField.collection + "[" + entry + "]" + rowField.suffix : (kernelOwn(pathOf, node.id) ?? node.id);
        const ancestorValues = kernelRecord() as Record<string, unknown>;
        let parent = kernelOwn(index.parentOf, node.id);
        while (parent !== undefined) {
          ancestorValues[parent] = kernelJsonValue(kernelOwn(working, kernelOwn(pathOf, parent) ?? parent));
          parent = kernelOwn(index.parentOf, parent);
        }
        const context: RuleEvaluationContext = { values: idValues, componentValue: kernelJsonValue(kernelOwn(working, path)), ancestorValues };
        if (rowField !== undefined) {
          const byEntry = rowValues !== undefined ? kernelOwn(rowValues, rowField.collection) : undefined;
          const own = byEntry !== undefined ? kernelOwn(byEntry, String(entry)) : undefined;
          context.rowValues = own ?? (kernelRecord() as Record<string, unknown>);
          context.rowIndex = (kernelOwn(positions, rowField.collection) as Record<string, number>)[String(entry)] as number;
          context.rowCount = (kernelOwn(entries, rowField.collection) as number[]).length;
        }
        if (today !== undefined) {
          context.today = today;
        }
        if (hostContext !== undefined) {
          context.hostContext = hostContext;
        }
        if (evaluation !== undefined && evaluation.functions !== undefined) {
          context.functions = evaluation.functions;
        }
        if (evaluation !== undefined && evaluation.warn !== undefined) {
          context.warn = evaluation.warn;
        }
        if (evaluation !== undefined && evaluation.regexCache !== undefined) {
          context.regexCache = evaluation.regexCache;
        }
        // Where reproducibility is decided: every path the calculation reads must come back
        // answered from the context, which holds the answers by component id and the node's own
        // and ancestors' values (and an entry's, under `row.`), or name another calculation
        // this side works out: that one's answer is known here whatever it is, no answer
        // included, so `coalesce(ratio, 0)` over a `ratio` divided by a missing or zero
        // household is worked out again, not taken on trust.
        // A read of a repeating section's collection path (`lines` in
        // `sum(pluck(lines, "price"))`, the section's entries sent as `lines[0].price`,
        // `lines[1].price`) names no component id and no stored answer, so it reads `undefined`
        // here: the calculation is kept as sent and listed in `clientDerived`, held to its
        // field's own checks but never worked out again on this side. Reproducing a section
        // total server-side would need the entries gathered back into a list for the read, on
        // both sides alike; that is a further ABI step, not done here.
        let reproducible = true;
        const named = rowField !== undefined ? kernelOwn(rowCalculated, rowField.collection) : undefined;
        for (const read of kernelExprReadPaths(expression)) {
          if (
            kernelExprReadScopedPath(read, context) === undefined &&
            !(hostKnown && read.indexOf("host.") === 0) &&
            kernelOwn(calculatedById, read) !== true &&
            (named === undefined || kernelOwn(named, read) !== true) &&
            kernelReadMayBeWithheld(read, index, journeyed === true, offPath)
          ) {
            reproducible = false;
            break;
          }
        }
        if (!reproducible) {
          unanswered[rowField !== undefined ? path : node.id] = true;
          continue;
        }
        kernelMarkRule(evaluation, node.id, "value");
        const next = kernelEvaluateExpression(expression, context);
        if (kernelStableStringify(next) === kernelStableStringify(kernelOwn(working, path))) {
          continue;
        }
        working[path] = next;
        changed = true;
        lastChanged.push(node.id);
        stale = true;
      }
    }
    converged = !changed;
  }
  // Calculations that never settle are refused by the run, naming what feeds what: the static
  // cycle among them (the check the browser makes before it opens the form), else the ones still
  // moving on the last pass (a guarded self-reference the static check also names, or a
  // calculation that flips with its own result).
  let cycle: string[] | undefined;
  if (!converged) {
    const ids: string[] = [];
    const inputs: string[][] = [];
    for (const node of documented) {
      const reads: string[] = [];
      for (const read of kernelExprReadPaths(expressions[node.id] as Expression)) {
        const input = kernelCalculationInput(read);
        if (input !== "" && kernelOwn(calculatedById, input) === true) {
          reads.push(input);
        }
      }
      ids.push(node.id);
      inputs.push(reads);
    }
    cycle = kernelFindCalculationCycle(ids, inputs);
    if (cycle === undefined) {
      cycle = lastChanged.filter((id: string, at: number) => lastChanged.indexOf(id) === at);
    }
  }

  const recalculated: string[] = [];
  const unreproduced: string[] = [];
  const recalculatedSeen = kernelRecord() as Record<string, true>;
  const unreproducedSeen = kernelRecord() as Record<string, true>;
  const workedOut = kernelRecord() as Record<string, true>;
  for (const node of calculated) {
    const rowField = kernelOwn(rowOf, node.id);
    const at = rowField !== undefined ? (kernelOwn(entries, rowField.collection) ?? []) : [-1];
    for (const entry of at) {
      const path = rowField !== undefined ? rowField.collection + "[" + entry + "]" + rowField.suffix : (kernelOwn(pathOf, node.id) ?? node.id);
      if (kernelOwn(unanswered, rowField !== undefined ? path : node.id) !== true) {
        workedOut[path] = true;
      }
      if (kernelOwn(recalculatedSeen, path) !== true && kernelStableStringify(kernelOwn(working, path)) !== kernelStableStringify(kernelOwn(values, path))) {
        recalculatedSeen[path] = true;
        recalculated.push(path);
      }
    }
  }
  for (const node of kept) {
    const rowField = kernelOwn(rowOf, node.id);
    const at = rowField !== undefined ? (kernelOwn(entries, rowField.collection) ?? []) : [-1];
    const expression = kernelOwn(expressions, node.id);
    const skipped = expression === undefined || kernelRuleSkipped((node.rules as { value: unknown }).value, expression, "value", "server", today, hostKnown);
    for (const entry of at) {
      const path = rowField !== undefined ? rowField.collection + "[" + entry + "]" + rowField.suffix : (kernelOwn(pathOf, node.id) ?? node.id);
      const value = kernelOwn(working, path);
      if (value === undefined || value === null || kernelOwn(unreproducedSeen, path) === true) {
        continue;
      }
      if (kernelOwn(unanswered, rowField !== undefined ? path : node.id) === true || skipped) {
        unreproducedSeen[path] = true;
        unreproduced.push(path);
      }
    }
  }
  const outcome: {
    values: Record<string, unknown>;
    recalculated: string[];
    unreproduced: string[];
    converged: boolean;
    cycle?: string[];
    reads: Record<string, true>;
    deferred: boolean;
    workedOut: Record<string, true>;
  } = {
    values: working,
    recalculated,
    unreproduced,
    converged,
    reads,
    deferred: Object.keys(unanswered).length > 0,
    workedOut
  };
  if (cycle !== undefined) {
    outcome.cycle = cycle;
  }
  return outcome;
}

/** The fold over a submission, with what the kernel worked out for itself before it. */
export interface KernelSubmissionFold extends KernelFoldResult {
  /** Value paths whose calculation came out other than submitted, in document order. */
  recalculated: string[];
  /** False when the calculations did not settle within their bound (a cycle among them). */
  calculationsConverged: boolean;
  /** When they did not settle, the calculations that feed one another (a cycle ends where it began) or are still moving. */
  calculationCycle?: string[];
  /** The components their `requiredWhen`, not their flag, made required, in document order. */
  requiredByRule: string[];
  /**
   * Value paths of the submitted answers that were worked out in the browser and are kept as
   * sent ({@link kernelClientDerived}), in document order; empty when there is none.
   */
  clientDerived: string[];
  /** The journey's ownership — what each page places — when there is a journey. */
  ownership?: JourneyOwnership;
  /**
   * The components whose server-side rules or calculation read the clock, in
   * document order: a rule the server applies (`run` both or server) that names `today()` or
   * `age()`, whether or not a day was given; empty when there is none.
   */
  clockDependent: string[];
  /**
   * The components whose `server` or `server-secret` rules this fold applied, in
   * document order: a state rule, a required rule read where the fold reads one, a calculation
   * worked out here; empty when there is none.
   */
  serverRules: string[];
  /**
   * The components whose own `visibleWhen` this side could not replay, in
   * document order: such a component and its descendants are treated as hidden for requiredness
   * ({@link kernelFoldRelaxUnreplayable}); empty when there is none.
   */
  visibilitySkipped: string[];
}

/**
 * The answers a submission carries that were worked out in the browser and that this side
 * kept as sent, as value paths in document order:
 *
 * 1. the target of each worked-out value in use (`ownership.workedOutOf`) whose answer is
 *    submitted — its page on the path, or its answer kept off it by `offPathValues: "retain"` —
 *    computed by the browser from a presentation's own fields, which are never sent, so no
 *    server can work it out again;
 * 2. each calculation kept unrecomputed while a value was there (`unreproduced`, from
 *    {@link kernelRecomputeCalculations}) and still submitted;
 * 3. each calculation that reads one of these, directly or through another calculation: its
 *    result is worked out here, but from an answer taken on trust.
 *
 * Only a submitted answer is listed — the list describes the judged values — but one the fold
 * withheld still counts as what a calculation read: a result worked out from an answer taken
 * on trust is listed whether or not that answer is itself submitted (a target on a page the
 * path skips, say, that a calculation on no page reads).
 *
 * Every one of them is still held to the form's own rules — required, format, plugin checks —
 * like any answer; the list says which of the judged values a host should not read as verified
 * arithmetic. An alias is never listed: its answer is the person's. A `null` or withheld
 * answer is not a value. A calculation inside a repeating section is listed by an entry's key
 * (`items[0].total`) when that entry's was kept as sent; one that reads
 * such an answer is not followed through. The kernel reads no own node's rule and no worked-out value's expression for this:
 * only which form fields a presentation says it works out.
 */
export function kernelClientDerived(
  ownership: JourneyOwnership | undefined,
  fold: { submittable: Record<string, unknown> },
  unreproduced: readonly string[],
  index: { order: string[]; nodeById: Record<string, ComponentNode>; parentOf: Record<string, string> },
  pathOf: Record<string, string>,
  idsByPath: Record<string, string[]>
): string[] {
  // The value paths taken on trust, submitted or not; and what a calculation's read names them
  // by: the ids of the components stored there.
  const trusted = kernelRecord() as Record<string, true>;
  const names = kernelRecord() as Record<string, true>;
  let found = false;
  function submitted(path: string): boolean {
    const value = kernelOwn(fold.submittable, path);
    return value !== undefined && value !== null;
  }
  function add(path: string): void {
    trusted[path] = true;
    found = true;
    const ids = kernelOwn(idsByPath, path);
    if (ids !== undefined && ids.length > 0) {
      for (const id of ids) {
        names[id] = true;
      }
    } else {
      names[path] = true;
    }
  }
  const workedOutOf = ownership !== undefined ? ownership.workedOutOf : undefined;
  if (workedOutOf !== undefined) {
    for (const nodeId of Object.keys(workedOutOf)) {
      const target = kernelOwn(workedOutOf, nodeId);
      if (typeof target === "string") {
        add(kernelOwn(pathOf, target) ?? target);
      }
    }
  }
  for (const path of unreproduced) {
    add(path);
  }
  if (!found) {
    return [];
  }

  // The calculations that read one of them, to a fixpoint: a pass per calculation at most.
  const calculations: ComponentNode[] = [];
  for (const id of index.order) {
    const node = kernelOwn(index.nodeById, id);
    if (
      node !== undefined &&
      id !== index.order[0] &&
      node.rules &&
      node.rules.value &&
      kernelCompiledRule(node.rules.value) !== undefined &&
      node.collection === undefined &&
      kernelClaimsData(node) &&
      !kernelFoldInSection(id, index.nodeById, index.parentOf)
    ) {
      calculations.push(node);
    }
  }
  let changed = calculations.length > 0;
  for (let pass = 0; pass <= calculations.length && changed; pass += 1) {
    changed = false;
    for (const node of calculations) {
      const path = kernelOwn(pathOf, node.id) ?? node.id;
      if (kernelOwn(trusted, path) === true) {
        continue;
      }
      let reads = false;
      for (const read of kernelExprReadPaths(kernelCompiledRule((node.rules as { value: unknown }).value) as Expression)) {
        let name = read;
        if (name.startsWith("ancestor.")) {
          name = name.slice("ancestor.".length);
        } else if (name === "component" || name.startsWith("component.") || name.startsWith("row.") || name.startsWith("host.")) {
          continue;
        }
        // The whole path as a key first, else its leading segment, as the evaluator reads it.
        const dot = name.indexOf(".");
        if (kernelOwn(names, name) === true || (dot > 0 && kernelOwn(names, name.slice(0, dot)) === true)) {
          reads = true;
          break;
        }
      }
      if (reads) {
        add(path);
        changed = true;
      }
    }
  }

  const out: string[] = [];
  for (const id of index.order) {
    const path = kernelOwn(pathOf, id) ?? id;
    if (kernelOwn(trusted, path) === true && submitted(path) && out.indexOf(path) < 0) {
      out.push(path);
    }
  }
  // An entry's calculation taken on trust is listed by its entry's key, after the
  // rest, in the order `unreproduced` has it. A data key holds no bracket, so a key with one is
  // an entry's.
  const entryKeys = kernelRecord() as Record<string, true>;
  for (const path of unreproduced) {
    if (path.indexOf("[") >= 0 && kernelOwn(entryKeys, path) !== true && submitted(path)) {
      entryKeys[path] = true;
      out.push(path);
    }
  }
  return out;
}

/**
 * The form components in scope for one page of a journey, in document order: those
 * the page lists, with their subtrees, and those its own nodes reference, fill or work out
 * — the same ownership the path is worked out with. What a page's check answers
 * for: a host keeps the errors on these components, and those on no component at all bar
 * `journey.exit`. The submissions service works the same list out in-process (`pageScope`);
 * a host with no engine of its own asks for it with `context.page`. Never an own node's id:
 * no error this side raises names one.
 */
export function kernelPageComponentIds(ownership: JourneyOwnership, pageId: string): string[] {
  const ids: string[] = [];
  for (const id of ownership.order) {
    const pages = kernelOwn(ownership.pagesOf, id);
    if (pages !== undefined && pages.indexOf(pageId) >= 0) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The ids of the pages any of whose routes' `when` reads the clock (`today()`, `age()`), in
 * page order. A day-less run refuses a journey with any (`journey.clockDependent`).
 */
export function kernelJourneyClockPages(journey: Journey): string[] {
  const ids: string[] = [];
  for (let at = 0; at < journey.pages.length; at += 1) {
    const page = journey.pages[at] as Journey["pages"][number];
    let reads = false;
    for (const route of page.routes ?? []) {
      if (reads) {
        break;
      }
      const routeTree = route.when === undefined ? undefined : journeyRuleTree(route.when);
      reads = routeTree !== undefined && kernelExprReadsClock(routeTree);
    }
    if (reads) {
      ids.push(page.id);
    }
  }
  return ids;
}

/**
 * The submittable fold (`core/state/submittable-fold.ts`) over what was submitted:
 * the calculations worked out again ({@link kernelRecomputeCalculations}), the tree indexed the
 * kernel's way, a repeating section's entries judged by the section
 * ({@link kernelCollectionOwners}), rules resolved by {@link kernelResolveSemanticState}, each
 * `requiredWhen` by {@link kernelRuleRequired}, and, with a journey, the path worked
 * out from the values — never taken from the client. The browser runs the same fold over the
 * same answers, so both land on the same states, the same requiredness and the same
 * submittable values. The answers are read as the envelope carries them (`kernelJsonAnswers`),
 * so values handed in-process — never through JSON — judge as the sandbox's would; the rules,
 * the journey and the calculations read only the keys the schema defines
 * ({@link kernelDefinesKey}), whatever the unknown-field mode kept. So under `keep` a key the
 * schema does not define — an own answer's `@` key, one spelled like a button's or a
 * fieldset's id — is stored as sent and read by nothing: the verdict is `strip`'s.
 */
export function kernelFoldSubmission(
  root: ComponentNode,
  values: Record<string, unknown>,
  journey: Journey | undefined,
  evaluation?: KernelEvaluation,
  prepared?: KernelPrepared,
  keyMemo?: KernelKeyMemo
): KernelSubmissionFold {
  const today = evaluation !== undefined ? evaluation.today : undefined;
  const functions = evaluation !== undefined ? evaluation.functions : undefined;
  // A route condition that reads the clock is listed under `clockDependent` by the id of the page
  // the route leaves, with or without a day. With no day given the run refuses the submission
  // (`journey.clockDependent`, {@link runKernel}): the server cannot replay
  // such a condition, and no path it guessed would be the person's.
  const clockPages = journey !== undefined ? kernelJourneyClockPages(journey) : [];
  const index = kernelPreparedGet(prepared, root, "tree", () => kernelTreeIndex(root));
  const pathOf = kernelPreparedGet(prepared, root, "pathOf", () => kernelValuePaths(root));
  const idsByPath = kernelPreparedGet(prepared, root, "idsByPath", () => kernelComponentIdsByPath(root, pathOf));
  const knownShapes = kernelPreparedGet(prepared, root, "knownShapes", () => kernelKnownKeyShapes(root));
  // The calculations work over the defined keys alone; a key kept unread goes back in its place
  // afterwards, for the fold to pass through as it stands.
  const answers = kernelJsonAnswers(values);
  const defined = kernelRecord() as Record<string, unknown>;
  const definedMemo = keyMemo !== undefined ? keyMemo.defined : (kernelRecord() as Record<string, boolean>);
  const shapesMemo = keyMemo !== undefined ? keyMemo.shapes : (kernelRecord() as Record<string, string | false>);
  let keptUnread = false;
  for (const key of Object.keys(answers)) {
    if (kernelDefinesKey(knownShapes, key, definedMemo, shapesMemo)) {
      defined[key] = answers[key];
    } else {
      keptUnread = true;
    }
  }
  /** `values` without the keys of `left`. */
  function without(values: Record<string, unknown>, left: Record<string, true>): Record<string, unknown> {
    const out = kernelRecord() as Record<string, unknown>;
    for (const key of Object.keys(values)) {
      if (kernelOwn(left, key) !== true) {
        out[key] = values[key];
      }
    }
    return out;
  }
  // The calculations worked out over the answers less `withheld` (the first round leaves none out),
  // with `offPath` the components the path skips, and the values the fold reads with them. A
  // withheld answer is no input to a calculation but stays in the fold's input:
  // the fold decides afresh each round whether the path still skips it, so a key withheld
  // once is not withheld for good. A calculation's own result is never put back as it was sent.
  function calculate(withheld: Record<string, true> | undefined, offPath: Record<string, true> | undefined) {
    const live = withheld === undefined ? answers : without(answers, withheld);
    const liveDefined = withheld === undefined ? defined : without(defined, withheld);
    const worked = kernelRecomputeCalculations(root, keptUnread ? liveDefined : live, index, pathOf, idsByPath, evaluation, journey !== undefined, prepared, offPath);
    let folded = worked.values;
    if (keptUnread) {
      folded = kernelRecord() as Record<string, unknown>;
      for (const key of Object.keys(live)) {
        folded[key] = kernelDefinesKey(knownShapes, key, definedMemo, shapesMemo) ? worked.values[key] : live[key];
      }
      for (const key of Object.keys(worked.values)) {
        if (!Object.prototype.hasOwnProperty.call(folded, key)) {
          folded[key] = worked.values[key];
        }
      }
    }
    if (withheld !== undefined && Object.keys(withheld).length > 0) {
      const back = kernelRecord() as Record<string, unknown>;
      for (const key of Object.keys(answers)) {
        if (kernelOwn(withheld, key) === true && answers[key] !== undefined && !Object.prototype.hasOwnProperty.call(folded, key) && kernelOwn(worked.workedOut ?? {}, key) !== true) {
          back[key] = answers[key];
        } else if (Object.prototype.hasOwnProperty.call(folded, key)) {
          back[key] = folded[key];
        }
      }
      for (const key of Object.keys(folded)) {
        if (!Object.prototype.hasOwnProperty.call(back, key)) {
          back[key] = folded[key];
        }
      }
      folded = back;
    }
    return { worked, folded };
  }
  const first = calculate(undefined, undefined);
  let calculations = first.worked;
  let foldValues = first.folded;
  // With a journey, what each page places: its components, and what its own nodes reference,
  // fill or work out — worked out once, for the fold, the list of client-derived
  // answers and a page's scope alike.
  const ownership = journey !== undefined ? journeyOwnership(root, journey) : undefined;
  const input: KernelFoldInput = {
    order: index.order,
    nodeById: index.nodeById,
    parentOf: index.parentOf,
    values: foldValues,
    pathOf,
    idsByPath,
    collectionOwners: kernelPreparedGet(prepared, root, "collectionOwners", () => kernelCollectionOwners(index)),
    resolve: function (node, idValues, pathValues) {
      return kernelResolveSemanticState(node, idValues, pathValues, pathOf, index.parentOf, evaluation);
    },
    ruleRequired: function (node, idValues, pathValues) {
      return kernelRuleRequired(node, idValues, pathValues, pathOf, index.parentOf, evaluation);
    },
    ruleValid: function (node, idValues, pathValues) {
      return kernelRuleValid(node, idValues, pathValues, pathOf, index.parentOf, evaluation);
    },
    ruleRowBound: function (node, key, idValues, pathValues) {
      return kernelRuleRowBound(node, key, idValues, pathValues, pathOf, index.parentOf, evaluation);
    },
    defines: function (key) {
      return kernelDefinesKey(knownShapes, key, definedMemo, shapesMemo);
    }
  };
  if (today !== undefined) {
    input.today = today;
  }
  if (journey !== undefined && ownership !== undefined) {
    input.journey = {
      journey,
      ownership,
      // The fold takes the path engine as input: this side hands it the spliced one.
      path: journeyPath,
      place: journeyPlacements,
      evaluate: function (expression, view, day) {
        if (evaluation !== undefined) {
          evaluation.where = "journey:" + journey.id;
        }
        const context: RuleEvaluationContext = { values: view };
        if (day !== undefined) {
          context.today = day;
        }
        if (functions !== undefined) {
          context.functions = functions;
        }
        if (evaluation !== undefined && evaluation.warn !== undefined) {
          context.warn = evaluation.warn;
        }
        if (evaluation !== undefined && evaluation.regexCache !== undefined) {
          context.regexCache = evaluation.regexCache;
        }
        return kernelEvaluateExpression(expression, context);
      }
    };
  }
  let fold = kernelFoldSubmittable(input);
  // With a journey, a calculation reads the settled view:
  // the answers the fold withheld, and the components on pages the path skips, are no input
  // to it, as in the browser, whose calculations run over the same view. So where a calculation
  // reads either, it is worked out again over the answers less those the last fold left out, and
  // the fold re-run over all of them, until the answers withheld and the pages skipped stop
  // changing. Also once where the first round kept a calculation as sent because a read was
  // unanswered: the fold's placement now says whether that was the
  // person's own empty answer. Never where no calculation reads either, which is every
  // submission to a form without such a calculation. A view that comes back to one already
  // tried (a calculation that moves the page that feeds it) or does not
  // settle within the bound is `fold.unsettled`, here and in the browser alike.
  if (journey !== undefined) {
    let withheld = kernelRecord() as Record<string, true>;
    let offPath = kernelRecord() as Record<string, true>;
    let settled = false;
    const readBy = calculations.reads ?? (kernelRecord() as Record<string, true>);
    /** The views tried, in order; the first is the one worked out before any placement was known. */
    const tried: string[] = ["?"];
    let triedRead = calculations.deferred === true;
    for (let again = 0; again <= 5 && !settled; again += 1) {
      const nextWithheld = kernelRecord() as Record<string, true>;
      const nextOff = kernelRecord() as Record<string, true>;
      let read = false;
      const submittable = fold.submittable;
      for (const key of Object.keys(answers)) {
        if (answers[key] !== undefined && submittable[key] === undefined && kernelDefinesKey(knownShapes, key, definedMemo, shapesMemo)) {
          nextWithheld[key] = true;
          const owners = kernelOwn(idsByPath, key);
          if (kernelOwn(readBy, key) === true || (owners !== undefined && owners.some((id: string) => kernelOwn(readBy, id) === true))) {
            read = true;
          }
        }
      }
      const placements = fold.placements;
      if (placements !== undefined) {
        for (const id of index.order) {
          if (kernelOwn(placements, id) === "off") {
            nextOff[id] = true;
            if (kernelOwn(readBy, id) === true) {
              read = true;
            }
          }
        }
      }
      const key = Object.keys(nextWithheld).sort().join("\n") + "\u0000" + Object.keys(nextOff).sort().join("\n");
      if (key === tried[tried.length - 1]) {
        settled = true;
      } else if (!read && !triedRead) {
        settled = true;
      } else if (tried.indexOf(key) >= 0) {
        break;
      } else if (again < 5) {
        tried.push(key);
        triedRead = read;
        withheld = nextWithheld;
        offPath = nextOff;
        const again2 = calculate(withheld, offPath);
        calculations = again2.worked;
        foldValues = again2.folded;
        input.values = foldValues;
        fold = kernelFoldSubmittable(input);
      }
    }
    if (!settled) {
      fold.converged = false;
    }
  }
  // A visibility this side cannot replay may be hiding the field in the browser: the server never
  // demands an answer the browser may have hidden. Edits `fold.required`.
  const visibilitySkipped = kernelFoldRelaxUnreplayable(index.order, index.nodeById, index.parentOf, fold.required, today, evaluation !== undefined && evaluation.hostContext !== undefined);
  const requiredByRule: string[] = [];
  for (const id of Object.keys(fold.required)) {
    const node = kernelOwn(index.nodeById, id);
    if (fold.required[id] === true && node !== undefined && kernelConfigurationOf(node).required !== true) {
      requiredByRule.push(id);
    }
  }
  // What the rules this side reads turned on: the clock, and the scopes the browser
  // never ran. A state rule counts where this side resolves it; a required rule where the fold
  // reads one (a component with an answer of its own, outside a section); a calculation where
  // it is worked out here (a node holding data, outside a section).
  const clockDependent: string[] = [];
  const serverRules: string[] = [];
  for (const id of index.order) {
    const node = kernelOwn(index.nodeById, id);
    if (node === undefined || id === root.id || !node.rules) {
      continue;
    }
    const inSection = node.collection !== undefined || kernelFoldInSection(id, index.nodeById, index.parentOf);
    let clock = false;
    let server = false;
    for (const key of ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen", "validWhen", "value", "minRows", "maxRows"]) {
      const source = kernelOwn(node.rules as Record<string, unknown>, key);
      const expression = source ? kernelCompiledRule(source) : undefined;
      if (expression === undefined || !kernelRuleRunsOn(source, key, "server")) {
        continue;
      }
      // A grid's bound is read where the fold reads it: on a grid, never one reading `row.`.
      if ((key === "minRows" || key === "maxRows") && (node.type !== "dataGrid" || kernelTreeReadsRow(expression))) {
        continue;
      }
      if ((key === "requiredWhen" || key === "validWhen") && (!kernelFoldHoldsOwnAnswer(node) || inSection)) {
        continue;
      }
      if (key === "value" && (!kernelClaimsData(node) || inSection)) {
        continue;
      }
      if (kernelExprReadsClock(expression)) {
        clock = true;
      }
      const run = kernelRuleRun(source);
      if ((run === "server" || run === "server-secret") && !kernelRuleSkipped(source, expression, key, "server", today, evaluation !== undefined && evaluation.hostContext !== undefined)) {
        server = true;
      }
    }
    if (clock) {
      clockDependent.push(id);
    }
    if (server) {
      serverRules.push(id);
    }
  }
  for (const pageId of clockPages) {
    if (clockDependent.indexOf(pageId) < 0) {
      clockDependent.push(pageId);
    }
  }
  const result: KernelSubmissionFold = {
    ...fold,
    recalculated: calculations.recalculated,
    calculationsConverged: calculations.converged,
    requiredByRule,
    clientDerived: kernelClientDerived(ownership, fold, calculations.unreproduced, index, pathOf, idsByPath),
    clockDependent,
    serverRules,
    visibilitySkipped
  };
  if (ownership !== undefined) {
    result.ownership = ownership;
  }
  if (calculations.cycle !== undefined) {
    result.calculationCycle = calculations.cycle;
  }
  return result;
}

/**
 * Whether an object entry of a journey page — a node the presentation owns, with everything
 * under it — has a usable shape: exactly what `validateJourneyShape`
 * (`core/schema/journey.ts`) finds nothing wrong with, so the browser drops a journey here
 * refused. Every node is a record with a non-empty string `type`. A reference
 * (`journey-field`) names its form component in `configuration.componentId` and holds no
 * children. Any other node has a non-empty string `id`; its `configuration` and `rules` are
 * absent or records; its `configuration.fills` is absent or a non-empty string; its `children`
 * are absent or a record of lists of nodes. A worked-out value (`journey-value`) names its
 * target in `configuration.to`, carries a rule source in `configuration.value` (a formula
 * string, a tree, or the object form: never evaluated here) and holds no children.
 *
 * The shape only. Whether an id clashes, a type is allowed or a target exists is for the
 * usability rules (`journeyOwnNodeUsable`, `journeyTargetUsable`), which ignore a node on both
 * sides rather than refuse the journey. Walked with a stack of its own, not recursion: a page
 * nested a thousand deep must not exhaust the sandbox's call stack.
 */
export function kernelIsPresentationNode(entry: unknown): boolean {
  function isRecord(candidate: unknown): candidate is Record<string, unknown> {
    return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  }
  const stack: unknown[] = [entry];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || typeof node.type !== "string" || node.type === "") {
      return false;
    }
    const configuration = node.configuration;
    if (node.type === "journey-field") {
      if (!isRecord(configuration) || typeof configuration.componentId !== "string" || configuration.componentId === "" || node.children !== undefined) {
        return false;
      }
      continue;
    }
    if (typeof node.id !== "string" || node.id === "") {
      return false;
    }
    if ((configuration !== undefined && !isRecord(configuration)) || (node.rules !== undefined && !isRecord(node.rules))) {
      return false;
    }
    if (isRecord(configuration) && configuration.fills !== undefined && (typeof configuration.fills !== "string" || configuration.fills === "")) {
      return false;
    }
    if (node.type === "journey-value") {
      if (!isRecord(configuration) || typeof configuration.to !== "string" || configuration.to === "") {
        return false;
      }
      // A formula, a tree, or the object form (`RuleSource`): the shape alone.
      const expression = configuration.value;
      const shaped =
        typeof expression === "string" ||
        (isRecord(expression) &&
          (typeof expression.kind === "string" ||
            typeof expression.formula === "string" ||
            (isRecord(expression.expression) && typeof expression.expression.kind === "string")));
      if (!shaped || node.children !== undefined) {
        return false;
      }
      continue;
    }
    const children = node.children;
    if (children === undefined) {
      continue;
    }
    if (!isRecord(children)) {
      return false;
    }
    for (const slot of Object.keys(children)) {
      const nodes = children[slot];
      if (!Array.isArray(nodes)) {
        return false;
      }
      for (const child of nodes) {
        stack.push(child);
      }
    }
  }
  return true;
}

/**
 * Whether `value` is usable as a journey: exactly the shape `validateJourneyShape`
 * (`core/schema/journey.ts`) accepts, which is what the browser's `readJourneys` keeps. A
 * host may build `context.journey` itself rather than read it from the definition, and a
 * journey the browser would drop must not run here either: a page whose `components` is not a
 * list of ids and nodes would otherwise be emptied and its required fields waved through, and a
 * page that carries a `when` of its own (pages have none) would walk a path its author did not
 * write. A page entry is a component id (a string) or a node the presentation owns
 * ({@link kernelIsPresentationNode}). {@link runKernel} reads it over the compiled copy, as the
 * browser's `readJourneys` does: a route `when` the compile could not read is gone from the copy
 * and reported as a formula problem, so this check never sees it, and `journey.invalid` is left
 * to the shapes the compile keeps as they are. Kernel-shaped: the literals are spelled inline.
 */
export function kernelIsJourney(value: unknown): value is Journey {
  function isRecord(entry: unknown): entry is Record<string, unknown> {
    return typeof entry === "object" && entry !== null && !Array.isArray(entry);
  }
  // A formula string, a tree, or the object form (`RuleSource`): the shape alone,
  // as `isExpressionLike` reads it; whether a formula parses is the compile step's to say.
  function isCondition(entry: unknown): boolean {
    if (typeof entry === "string") {
      return true;
    }
    if (!isRecord(entry)) {
      return false;
    }
    return typeof entry.kind === "string" || typeof entry.formula === "string" || (isRecord(entry.expression) && typeof entry.expression.kind === "string");
  }
  function validationHolds(entry: unknown, allowEnd: boolean): boolean {
    if (entry === undefined) {
      return true;
    }
    if (!isRecord(entry)) {
      return false;
    }
    if (entry.continue !== undefined && entry.continue !== "page" && entry.continue !== "defer") {
      return false;
    }
    if (entry.server !== undefined && typeof entry.server !== "boolean") {
      return false;
    }
    if (entry.onUnavailable !== undefined && entry.onUnavailable !== "block" && entry.onUnavailable !== "continue") {
      return false;
    }
    if (entry.end !== undefined && (!allowEnd || (entry.end !== "client" && entry.end !== "server"))) {
      return false;
    }
    return true;
  }
  // A page's `review` settings (read on any page, as `validateJourneyShape` reads them): row
  // wordings as text by component id, what a blank optional answer shows, and the Change links.
  function reviewHolds(entry: unknown): boolean {
    if (entry === undefined) {
      return true;
    }
    if (!isRecord(entry)) {
      return false;
    }
    const labels = entry.labels;
    if (labels !== undefined) {
      if (!isRecord(labels)) {
        return false;
      }
      for (const key of Object.keys(labels)) {
        if (typeof labels[key] !== "string") {
          return false;
        }
      }
    }
    if (entry.emptyOptional !== undefined && entry.emptyOptional !== "notProvided" && entry.emptyOptional !== "omit") {
      return false;
    }
    return entry.change === undefined || typeof entry.change === "boolean";
  }
  function pageHolds(page: unknown): boolean {
    if (!isRecord(page) || typeof page.id !== "string" || page.id === "") {
      return false;
    }
    if (page.kind !== undefined && page.kind !== "questions" && page.kind !== "exit" && page.kind !== "review") {
      return false;
    }
    if (!reviewHolds(page.review)) {
      return false;
    }
    if (page.components !== undefined) {
      if (!Array.isArray(page.components)) {
        return false;
      }
      for (const entry of page.components) {
        if (typeof entry !== "string" && !kernelIsPresentationNode(entry)) {
          return false;
        }
      }
    }
    // A page has no condition of its own (branching is a route on the page before it): one
    // that carries a `when` is refused, as `validateJourneyShape` refuses it.
    if (page.when !== undefined) {
      return false;
    }
    if (page.routes !== undefined) {
      if (!Array.isArray(page.routes)) {
        return false;
      }
      for (const route of page.routes) {
        if (!isRecord(route) || typeof route.to !== "string" || route.to === "") {
          return false;
        }
        if (route.when !== undefined && !isCondition(route.when)) {
          return false;
        }
      }
    }
    return validationHolds(page.validation, false);
  }

  if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || !Array.isArray(value.pages)) {
    return false;
  }
  // Page ids are unique: two pages sharing one make page scoping ambiguous.
  const seenPageIds = Object.create(null) as Record<string, true>;
  for (const page of value.pages) {
    if (!pageHolds(page)) {
      return false;
    }
    const pageId = (page as Record<string, unknown>).id as string;
    if (seenPageIds[pageId] === true) {
      return false;
    }
    seenPageIds[pageId] = true;
  }
  if (
    value.offPathValues !== undefined &&
    value.offPathValues !== "retain" &&
    value.offPathValues !== "clear" &&
    value.offPathValues !== "exclude-from-submission"
  ) {
    return false;
  }
  if (value.progress !== undefined && value.progress !== "none" && value.progress !== "count") {
    return false;
  }
  return validationHolds(value.validation, true);
}

/**
 * Mirrors `FormRuntime`'s `errorPassesHiddenPolicy`: an error on a component the fold says is
 * not validated is dropped, and so is a required-coded one where requiredness does not apply.
 * Errors naming no component, or one the form does not have, pass.
 *
 * One kind of error on an unvalidated component passes: a field-constraints check on
 * the shape of an answer — `minLength`, `maxLength`, `pattern`, `maxFileSize`, `fileType`, and
 * a number or date that is not one (`number`, `date`), a text that is not a string
 * (`text`), a file answer that is no attachment (`file`) and an attachment whose size is
 * unusable or contradicts its bytes (`fileSize`, `file.sizeMismatch`) — when the answer is still
 * submitted (`submitValue`, and not cleared). Hiding a component relaxes "required", not the
 * format of an answer the submission carries.
 */
export function kernelErrorPassesFold(
  error: KernelValidationError,
  effective: Record<string, EffectiveNodeState>
): boolean {
  if (!error.componentId) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(effective, error.componentId)) {
    return true;
  }
  const state = effective[error.componentId] as EffectiveNodeState;
  const code = typeof error.code === "string" ? error.code : "";
  if (!state.runValidation) {
    return (
      error.stage === "field-constraints" &&
      ["minLength", "maxLength", "pattern", "maxFileSize", "fileType", "number", "date", "text", "file", "fileSize", "file.sizeMismatch"].indexOf(
        code
      ) >= 0 &&
      state.submitValue &&
      !state.clearValue
    );
  }
  if ((code === "required" || code.endsWith(".required")) && !state.requiredApplies) {
    return false;
  }
  return true;
}

/**
 * Where a text lives in a definition's `translations`, as `TextAddress`
 * (core/localization/translations.ts) names it: a kind (`form`, `components`, `chrome`,
 * `journeys`, `pdf`, `texts`), the owner's id (none for `form`), then the property segments, never an index.
 */
export interface KernelTextAddress {
  kind: string;
  owner?: string | undefined;
  path: readonly string[];
}

/**
 * Mirrors `isSafeSegment` (core/localization/translations.ts): a key the
 * translations map may hold, a non-empty string that is not `__proto__`, `constructor` or
 * `prototype`. The kernel carries its own copy, as it carries every reading it shares with the
 * browser: the sandbox program splices the kernel's functions, not the localization modules.
 */
export function kernelIsSafeSegment(segment: unknown): boolean {
  return typeof segment === "string" && segment.length > 0 && segment !== "__proto__" && segment !== "constructor" && segment !== "prototype";
}

/**
 * Mirrors `matchLocaleKey` (core/localization/translations.ts): which of the map's locale keys
 * serves `locale`, the whole tag (`exact`) or its primary subtag (none when the tag is already
 * primary). Tags compare case-insensitively with `_` read as `-`; a key spelled exactly as asked
 * wins over another spelling of the same tag; an unsafe key is never one.
 */
export function kernelTranslationLocaleKey(map: Record<string, unknown>, locale: string, exact: boolean): string | undefined {
  const normalized = locale.replace(/_/g, "-").toLowerCase();
  let wanted = normalized;
  if (!exact) {
    const primary = normalized.split(/[-_]/)[0];
    wanted = primary !== undefined && primary.length > 0 ? primary : normalized;
    if (wanted === normalized) {
      return undefined;
    }
  }
  if (exact && Object.prototype.hasOwnProperty.call(map, locale) && kernelIsSafeSegment(locale)) {
    return locale;
  }
  const keys = Object.keys(map);
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k] as string;
    if (kernelIsSafeSegment(key) && key.replace(/_/g, "-").toLowerCase() === wanted) {
      return key;
    }
  }
  return undefined;
}

/**
 * Mirrors `mapText` (core/localization/translations.ts): the text of the entry `{ text, source }`
 * at `keys` under the map's locale `key`, read by own properties only (an option valued
 * `toString` is not the method); an empty text is no text.
 */
export function kernelTranslationText(map: Record<string, unknown>, key: string | undefined, keys: readonly string[]): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  let cursor: unknown = map[key];
  for (let k = 0; k < keys.length; k += 1) {
    if (!kernelIsPlainRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, keys[k] as string)) {
      return undefined;
    }
    cursor = cursor[keys[k] as string];
  }
  if (!kernelIsPlainRecord(cursor) || typeof cursor.text !== "string" || typeof cursor.source !== "string") {
    return undefined;
  }
  return cursor.text !== "" ? cursor.text : undefined;
}

/**
 * Mirrors `catalogText` (core/localization/translations.ts): the host catalog's string at `keys`
 * under its locale `key`, read by own properties only. A catalog leaf is a plain string (the map's
 * entries are `{ text, source }`); an empty string is no text.
 */
export function kernelCatalogText(catalog: Record<string, unknown>, key: string | undefined, keys: readonly string[]): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  let cursor: unknown = catalog[key];
  for (let k = 0; k < keys.length; k += 1) {
    if (!kernelIsPlainRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, keys[k] as string)) {
      return undefined;
    }
    cursor = cursor[keys[k] as string];
  }
  return typeof cursor === "string" && cursor !== "" ? cursor : undefined;
}

/**
 * Mirrors `resolveText` (core/localization/translations.ts) over the run
 * context's two sources, in the browser's order: the host `catalog`'s exact locale, the definition's
 * `translations` exact locale, the catalog's primary subtag, the map's primary subtag, then
 * `defaultText`. So `fr` serves `fr-CA`, but the map's own `fr-CA` beats a catalog's `fr`. The
 * catalog is the optional run-context key `catalog`, absent when the host
 * has none: the map alone. A source that is not a record
 * is skipped (its rungs read as no text), an address with an unknown kind, an unsafe owner or
 * segment, or no path, is read as no translation: the default, never a throw.
 */
export function kernelResolveText(defaultText: string, address: KernelTextAddress, locale: string, translations: unknown, catalog?: unknown): string {
  const map = kernelIsPlainRecord(translations) ? translations : undefined;
  const host = kernelIsPlainRecord(catalog) ? catalog : undefined;
  if ((map === undefined && host === undefined) || !kernelIsPlainRecord(address) || !Array.isArray(address.path) || address.path.length === 0) {
    return defaultText;
  }
  const kind = address.kind;
  if (kind !== "form" && kind !== "components" && kind !== "chrome" && kind !== "journeys" && kind !== "pdf" && kind !== "texts") {
    return defaultText;
  }
  if (kind === "form" ? address.owner !== undefined : !kernelIsSafeSegment(address.owner)) {
    return defaultText;
  }
  const keys: string[] = kind === "form" ? ["form"] : [kind, address.owner as string];
  for (let p = 0; p < address.path.length; p += 1) {
    if (!kernelIsSafeSegment(address.path[p])) {
      return defaultText;
    }
    keys.push(address.path[p] as string);
  }
  for (let rung = 0; rung < 2; rung += 1) {
    const exact = rung === 0;
    if (host !== undefined) {
      const text = kernelCatalogText(host, kernelTranslationLocaleKey(host, locale, exact), keys);
      if (text !== undefined) {
        return text;
      }
    }
    if (map !== undefined) {
      const text = kernelTranslationText(map, kernelTranslationLocaleKey(map, locale, exact), keys);
      if (text !== undefined) {
        return text;
      }
    }
  }
  return defaultText;
}

/** Mirrors `compilePattern`: anchored, unicode, `null` for an uncompilable source. The kernel
 * logs such a pattern as a definition problem where it checks the component and, under
 * `formulaErrors: "fail"`, fails the check closed ({@link kernelRunFieldConstraints}), as the
 * browser's stage does under the same word; `check` reports it (`component.pattern.invalid`). */
export function kernelCompilePattern(source: string): RegExp | null {
  try {
    // The pattern alone first: inside the anchors a stray `)` and `(` pair up (`)(a+)+(`), so a
    // source that is no pattern would run, unread by the risky check.
    new RegExp(source, "u");
    return new RegExp("^(?:" + source + ")$", "u");
  } catch {
    return null;
  }
}

/** Mirrors `readLengthLimits` (core/schema/length-limits.ts): floored, at least one, and
 * neither when the minimum exceeds the maximum. `null` stands in for "no limit" because the
 * value crosses no ABI and the kernel avoids `undefined` in object shapes. */
export function kernelReadLengthLimits(
  configuration: Record<string, unknown>
): { minLength: number | null; maxLength: number | null } {
  function limit(key: string): number | null {
    const raw = configuration[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return null;
    }
    const floored = Math.floor(raw);
    return floored >= 1 ? floored : null;
  }
  const minLength = limit("minLength");
  const maxLength = limit("maxLength");
  if (minLength !== null && maxLength !== null && minLength > maxLength) {
    return { minLength: null, maxLength: null };
  }
  return { minLength, maxLength };
}

/** Mirrors `countCharacters`: Unicode code points, untrimmed. */
export function kernelCountCharacters(value: string): number {
  return Array.from(value).length;
}

/** Mirrors `readAcceptTokens` (core/schema/file-upload.ts): lower-cased, de-duplicated,
 * extension or MIME tokens only. */
export function kernelReadAcceptTokens(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === "string")
        : [];
  const out: string[] = [];
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (token.length === 0 || out.indexOf(token) !== -1) {
      continue;
    }
    if (
      /^\.[a-z0-9][a-z0-9.+-]*$/.test(token) ||
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/.test(token)
    ) {
      out.push(token);
    }
  }
  return out;
}

/** Mirrors the limits `readFileUploadConfiguration` reads: `maxFileSizeMb` to bytes (`null`
 * for none, as the length limits do) and the accept tokens. And the count: a
 * single-file field (`multiple` not `true`) holds one file, a multi-file one `maxFiles` (a
 * whole number of 1 or more, floored) else 100, the cap a list is held to when the author
 * set none. */
export function kernelReadFileLimits(
  configuration: Record<string, unknown>
): { maxFileSize: number | null; accept: string[]; maxFiles: number } {
  const megabytes = configuration.maxFileSizeMb;
  const bytes =
    typeof megabytes === "number" && Number.isFinite(megabytes) && megabytes > 0
      ? Math.floor(megabytes * 1048576)
      : 0;
  const declared = configuration.maxFiles;
  const maxFiles =
    configuration.multiple !== true
      ? 1
      : typeof declared === "number" && Number.isFinite(declared) && declared >= 1
        ? Math.floor(declared)
        : 100;
  return { maxFileSize: bytes >= 1 ? bytes : null, accept: kernelReadAcceptTokens(configuration.accept), maxFiles };
}

/** Mirrors `readFileAttachments` / `isFileAttachment`: the attachment envelope every storage
 * kind records, from a single value or a list. */
export function kernelFileAttachments(
  value: unknown
): Array<{ storage: string; name: string; type: string; size: number }> {
  function isAttachment(entry: unknown): entry is { storage: string; name: string; type: string; size: number } {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return (
      typeof record.storage === "string" &&
      record.storage.length > 0 &&
      typeof record.name === "string" &&
      typeof record.type === "string" &&
      typeof record.size === "number" &&
      Number.isFinite(record.size)
    );
  }
  if (Array.isArray(value)) {
    return value.filter(isAttachment);
  }
  return isAttachment(value) ? [value] : [];
}

/** Mirrors `matchesAccept`: extension against the name's end, `type/*` against the MIME
 * type's start, a full MIME token exactly; no tokens admits everything. */
export function kernelMatchesAccept(file: { name: string; type: string }, accept: string[]): boolean {
  if (accept.length === 0) {
    return true;
  }
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  for (const token of accept) {
    if (token.charAt(0) === ".") {
      if (name.endsWith(token)) {
        return true;
      }
    } else if (token.endsWith("/*")) {
      if (type.startsWith(token.slice(0, -1))) {
        return true;
      }
    } else if (type === token) {
      return true;
    }
  }
  return false;
}

/**
 * The byte length base64 text decodes to, counted over the payload characters only: whitespace
 * (line wraps, CRLF) and `=` padding are not bytes, and a `data:...,` prefix is not payload
 * (wrapped base64 from an honest client is not a size lie).
 */
export function kernelBase64DecodedLength(data: string): number {
  let start = 0;
  if (data.length > 5 && data.charCodeAt(0) === 100 && data.slice(0, 5).toLowerCase() === "data:") {
    const comma = data.indexOf(",");
    start = comma < 0 ? 0 : comma + 1;
  }
  let payload = 0;
  for (let i = start; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 61 || code <= 32) {
      continue;
    }
    if (code >= 0x80 && /\s/.test(data.charAt(i))) {
      continue;
    }
    payload += 1;
  }
  return Math.floor((payload * 3) / 4);
}

/** The most errors one run reports; past it the list is cut and ends with `errors.truncated`. */
export function kernelErrorCap(): number {
  return 10000;
}

/** Mirrors `formatFileSize`: `512 B`, `12 KB`, `1.5 MB` — arithmetic only, no locale. */
export function kernelFormatFileSize(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  function trim(value: number): string {
    return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
  }
  if (size < 1024) {
    return Math.round(size) + " B";
  }
  if (size < 1048576) {
    return trim(size / 1024) + " KB";
  }
  if (size < 1073741824) {
    return trim(size / 1048576) + " MB";
  }
  return trim(size / 1073741824) + " GB";
}

/**
 * The fields inside a repeating section: component id -> `collection`, the
 * section's collection path as written, and `suffix`, where the field's answer sits within an
 * entry (`.name`, `.address.city` under a data-scoping container inside the entry), so row `n`
 * keeps it at `collection[n]` + `suffix`. Walked as {@link kernelKnownKeyShapes} walks the
 * allowlist: a section nested in another keeps its own collection path and starts its own
 * suffixes, a section whose path is written with brackets defines nothing, and only a node
 * holding an answer of its own is listed ({@link kernelFoldHoldsOwnAnswer}). No prototype.
 */
export function kernelRowFields(root: ComponentNode): Record<string, { collection: string; suffix: string }> {
  const fields = kernelRecord() as Record<string, { collection: string; suffix: string }>;
  function walk(node: ComponentNode, collection: string | undefined, prefix: string): void {
    const own = kernelCollectionPathOf(node);
    let inside = collection;
    let childPrefix = prefix;
    if (own !== undefined) {
      if (own.indexOf("[") >= 0 || own.indexOf("]") >= 0) {
        return;
      }
      inside = own;
      childPrefix = "";
    } else if (collection !== undefined) {
      const path = prefix.length > 0 ? prefix + "." + kernelDataKeyOf(node) : kernelDataKeyOf(node);
      if (kernelFoldHoldsOwnAnswer(node)) {
        fields[node.id] = { collection, suffix: "." + path };
      }
      childPrefix = kernelIsDataScopeContainer(node) ? path : prefix;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, inside, childPrefix);
      }
    }
  }
  for (const group of Object.values(root.children ?? {})) {
    for (const child of group) {
      walk(child, undefined, "");
    }
  }
  return fields;
}

/**
 * A key as an entry's answer: `collection[n].rest` for a collection in
 * `collections` (a record keyed by collection path), `n` digits with no leading zero as the
 * runtime writes them, `rest` the field's place within the entry (`name`, `address.city`). The
 * parts, else `undefined` for any other key: no listed collection, another bracket before the
 * index, no field after it.
 */
export function kernelRowKeyParts(
  key: string,
  collections: Record<string, true>
): { collection: string; digits: string; rest: string } | undefined {
  const open = key.indexOf("[");
  if (open < 1) {
    return undefined;
  }
  const collection = key.slice(0, open);
  if (kernelOwn(collections, collection) !== true) {
    return undefined;
  }
  const close = key.indexOf("]", open);
  if (close < 0 || key.charAt(close + 1) !== "." || close + 2 >= key.length) {
    return undefined;
  }
  const digits = key.slice(open + 1, close);
  if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
    return undefined;
  }
  return { collection, digits, rest: key.slice(close + 2) };
}

/**
 * The entries each repeating section holds in `values`: collection path -> the
 * entry indexes some key carries ({@link kernelRowKeyParts}), ascending and each once. An
 * entry exists as soon as one of its fields is submitted. One pass over the keys. No prototype.
 */
export function kernelRowIndexes(
  values: Record<string, unknown>,
  collections: Record<string, true>
): Record<string, number[]> {
  const seen = kernelRecord() as Record<string, Record<string, true>>;
  const lists = kernelRecord() as Record<string, number[]>;
  for (const key of Object.keys(values)) {
    const parts = kernelRowKeyParts(key, collections);
    if (parts === undefined) {
      continue;
    }
    let marks = seen[parts.collection];
    if (marks === undefined) {
      marks = kernelRecord() as Record<string, true>;
      seen[parts.collection] = marks;
      lists[parts.collection] = [];
    }
    if (marks[parts.digits] !== true) {
      marks[parts.digits] = true;
      (lists[parts.collection] as number[]).push(Number(parts.digits));
    }
  }
  for (const name of Object.keys(lists)) {
    (lists[name] as number[]).sort(function (a: number, b: number): number {
      return a - b;
    });
  }
  return lists;
}

/**
 * Each entry's answers as a rule's `row.` scope reads them: collection path ->
 * entry index (as text) -> the entry's answers keyed within the entry (`name`,
 * `address.city`), each as the envelope carries it ({@link kernelJsonValue}), an answer
 * holding `undefined` left out. One pass over the keys. No prototype at any level.
 */
export function kernelRowValues(
  values: Record<string, unknown>,
  collections: Record<string, true>
): Record<string, Record<string, Record<string, unknown>>> {
  const out = kernelRecord() as Record<string, Record<string, Record<string, unknown>>>;
  for (const key of Object.keys(values)) {
    const parts = kernelRowKeyParts(key, collections);
    const value = values[key];
    if (parts === undefined || value === undefined) {
      continue;
    }
    let entries = out[parts.collection];
    if (entries === undefined) {
      entries = kernelRecord() as Record<string, Record<string, unknown>>;
      out[parts.collection] = entries;
    }
    let entry = entries[parts.digits];
    if (entry === undefined) {
      entry = kernelRecord() as Record<string, unknown>;
      entries[parts.digits] = entry;
    }
    entry[parts.rest] = kernelJsonValue(value);
  }
  return out;
}

/**
 * The schema-declared constraints (`required` / `minLength` / `maxLength` / `pattern`),
 * enforced with the exact semantics of `createFieldConstraintsStage` — one error per field,
 * in that precedence — but reported as the sandbox's own stage (`stage: "field-constraints"`,
 * `source: "wasm"`). This is why a form with only standard constraints needs no wasm plugin:
 * the core kernel already validates it.
 *
 * A `number` or `date` component's non-empty answer that is not one raises `number` / `date`, before its length and pattern, through the browser's own predicate
 * (`kernelAnswerKindCode`). What only the browser's controls know — a date typed in part, a
 * number box the browser could not read — never reaches here: those answers arrive empty.
 * Beside them: a `text` or `textarea` answer that is not a string —
 * a number, a boolean, a list (an empty one included), an object — raises `text`, so a length
 * limit or a pattern cannot be dodged by another JSON type; a valid number or date answer
 * outside the component's declared `min` / `max` raises `number.min` / `number.max` /
 * `date.min` / `date.max` (bounds inclusive, `parameters.min` or `parameters.max` the bound),
 * before its length and pattern; and a `file` answer is held to its shape and count.
 *
 * A file answer holds attachments, each an object with a non-empty `storage`, a `name`, a
 * `type` and a finite `size`. One that is not (a bare string, an object missing a
 * key or with one of the wrong type, a list with such an item) raises `file`, and the limits
 * are not applied to it. More attachments than the field takes raises `fileCount`
 * (`parameters.count` and `parameters.maxFiles`): one for a field that is not `multiple`, else
 * `maxFiles`, else 100 ({@link kernelReadFileLimits}). Only then the size and type of each.
 *
 * The fields of a repeating section are held per entry: each entry the
 * values carry (`items[0].sku`, {@link kernelRowIndexes}) is checked at its own key, which the
 * error's `path` names, with the component's id. A `required` field is reported only for the
 * entries missing it, and a section with no entry reports nothing. The field's state in
 * `effective` is the component's, the same for every entry (the fold does not fold entry by
 * entry); `requiredWhen` is still not read inside a section.
 *
 * With `effective` (the fold's states), a required component where requiredness does not
 * apply is not reported empty, and a component whose state skips validation is held only to
 * the shape of an answer it still submits — length, pattern, file size and type, never
 * `required`: what the browser's `errorPassesHiddenPolicy` filter leaves of the same
 * stage's errors. A cleared or excluded answer is not in `values`, so it has no shape to check.
 * A node `effective` does not know is checked as usual.
 *
 * With `requiredBy` (the fold's `required`), a component is required when the record
 * says so (its `configuration.required` tick, or its `requiredWhen` held over the settled view,
 * which the fold has already joined; a component the fold set aside is not) — gated by
 * `requiredApplies` alike. A component the record lacks, or no record at all, keeps the flag
 * alone: what a caller holding no fold gets, as the browser's stage without `requiredComponents`.
 *
 * With `options.invalidBy` (the fold's `invalid`), a component it names is
 * refused with `rule` (no parameters) for a non-empty answer that nothing above refused, after
 * every other check of the field, and never for an answer held only to its shape. Without it, no
 * `rule` is raised, as the browser's stage without `invalidComponents`.
 *
 * Two readings the kernel makes beyond the browser's stage, both on this side only. An
 * attachment whose declared `size` is negative or not an integer is refused (`fileSize`,
 * `parameters.file` and `parameters.size`): no honest client declares one, and the envelope
 * guard alone would make the answer yield nothing, leaving the limits unchecked. A
 * `pattern` that does not compile is an authoring mistake, not the person's: it is written to
 * `options.log` at `warn` once per component checked (`pattern does not compile`, data
 * `componentId` and `pattern`), and the check is skipped as the browser skips it, except under
 * `options.formulaErrors: "fail"`, where a non-empty answer fails it closed (`pattern`, with
 * `parameters.invalid: true`). A pattern of a catastrophic shape (`kernelRegexRisky`: a repeat of a
 * repeat, a repeated back-reference) is that same kind of definition problem (log `pattern is risky`,
 * `parameters.risky: true` as well when failed closed) and is never run, unless `options.riskyPatterns`
 * is `"allow"`. Without `options` the kernel reads as the browser's stage.
 *
 * A failed pattern carries the field's own `patternMessage` as `parameters.message`, worded for
 * `locale` through `options.catalog` and `options.translations` at `components › <id> › patternMessage`
 * (catalog first, as in the browser);
 * a `patternMessage` that is not a string is no message.
 */
export function kernelRunFieldConstraints(
  root: ComponentNode,
  values: Record<string, unknown>,
  locale: string,
  effective?: Record<string, EffectiveNodeState>,
  requiredBy?: Record<string, boolean>,
  options?: {
    log?: KernelLog;
    formulaErrors?: FormulaErrorPolicy;
    riskyPatterns?: string | undefined;
    prepared?: KernelPrepared | undefined;
    invalidBy?: Record<string, boolean> | undefined;
    /** Rows posted as `{}` ({@link kernelFlattenRows}): present rows with no key. */
    emptyRows?: string[] | undefined;
    /** What each grid's bound formulas came to (the fold's `rowBounds`). */
    rowBoundsBy?: Record<string, { min?: unknown; max?: unknown }> | undefined;
    /** The definition's `translations`, which word a field's `patternMessage` for `locale`. */
    translations?: unknown;
    /** The host's translation catalog: read before the map under the same tag. */
    catalog?: unknown;
    /**
     * The definition's `kinds` map (type -> engine base type, `core/schema/component-kinds.ts`):
     * a component of a type it names is checked as its base. Read tolerantly.
     */
    kinds?: unknown;
  }
): KernelValidationError[] {
  const errors: KernelValidationError[] = [];
  const prepared = options !== undefined ? options.prepared : undefined;
  const kinds = options !== undefined ? options.kinds : undefined;
  // The components whose `validWhen` does not hold (the fold's `invalid`).
  const invalidBy = options !== undefined ? options.invalidBy : undefined;
  const paths = kernelPreparedGet(prepared, root, "pathOf", () => kernelValuePaths(root));
  const rowFields = kernelPreparedGet(prepared, root, "rowFields", () => kernelRowFields(root));
  /** The entries each section holds, worked out once and only when a row field is met. */
  let entries: Record<string, number[]> | undefined;
  const log = options !== undefined ? options.log : undefined;
  const failClosed = options !== undefined && options.formulaErrors === "fail";
  // A pattern of a catastrophic shape is a definition problem like an uncompilable one, unless the host allows it.
  const riskyAllowed = options !== undefined && options.riskyPatterns === "allow";
  // What words a failed pattern's own message in the run's locale.
  const translations = options !== undefined ? options.translations : undefined;
  const catalog = options !== undefined ? options.catalog : undefined;

  /**
   * Each data grid's most rows, by collection path, as {@link checkRows} resolves it (the row cap
   * for a grid with no maximum of its own, and for a grid held only to its shape); worked out
   * once, when a row field is met.
   */
  let rowMax: Record<string, number> | undefined;
  function rowMaxOf(collection: string): number | undefined {
    if (rowMax === undefined) {
      rowMax = kernelRecord() as Record<string, number>;
      const boundsBy = options !== undefined ? options.rowBoundsBy : undefined;
      const stack: ComponentNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop() as ComponentNode;
        // Only a grid whose row count is checked: a validated one by its bounds, one held to the
        // shape of what it still submits by the row cap alone.
        const state = effective !== undefined && Object.prototype.hasOwnProperty.call(effective, node.id) ? (effective[node.id] as EffectiveNodeState) : undefined;
        const shapeOnly = state !== undefined && !state.runValidation && state.submitValue && !state.clearValue;
        if (node.type === "dataGrid" && (state === undefined || state.runValidation || shapeOnly)) {
          const path = kernelCollectionPathOf(node);
          const max = shapeOnly
            ? undefined
            : kernelResolveDataGridRowBounds(kernelDataGridRowBounds(node), boundsBy !== undefined ? kernelOwn(boundsBy, node.id) : undefined).max;
          if (path !== undefined) {
            rowMax[path] = max !== undefined ? max : kernelDataGridRowsCap();
          }
        }
        for (const group of Object.values(node.children ?? {})) {
          for (const child of group) {
            stack.push(child);
          }
        }
      }
    }
    return kernelOwn(rowMax, collection);
  }
  function entriesOf(collection: string): number[] {
    if (entries === undefined) {
      const collections = kernelRecord() as Record<string, true>;
      for (const id of Object.keys(rowFields)) {
        collections[(rowFields[id] as { collection: string }).collection] = true;
      }
      // Every collection's entries, a data grid's among them, whether or not a field of it is
      // checked: a grid's rows are counted.
      const lists = kernelPreparedGet(prepared, root, "rowLists", () => kernelRowListPaths(root));
      for (const path of Object.keys(lists)) {
        collections[path] = true;
      }
      entries = kernelRowIndexes(values, collections);
      // A row posted as `{}` has no key but is a row all the same: its required cells apply.
      const empties = options !== undefined ? options.emptyRows : undefined;
      if (Array.isArray(empties)) {
        const touched = kernelRecord() as Record<string, true>;
        // What each collection holds already, by entry, so a long list of empty rows is one pass.
        const have = kernelRecord() as Record<string, true>;
        for (const name of Object.keys(entries)) {
          for (const index of entries[name] as number[]) {
            have[name + "[" + index + "]"] = true;
          }
        }
        for (let at = 0; at < empties.length; at += 1) {
          const parts = kernelRowKeyParts(String(empties[at]) + ".x", collections);
          if (parts === undefined) {
            continue;
          }
          const mark = parts.collection + "[" + Number(parts.digits) + "]";
          if (have[mark] === true) {
            continue;
          }
          have[mark] = true;
          const list = kernelOwn(entries, parts.collection) ?? [];
          list.push(Number(parts.digits));
          entries[parts.collection] = list;
          touched[parts.collection] = true;
        }
        for (const name of Object.keys(touched)) {
          (entries[name] as number[]).sort(function (a: number, b: number): number {
            return a - b;
          });
        }
      }
    }
    return kernelOwn(entries, collection) ?? [];
  }

  /**
   * One field's checks at every place its answer sits, reported against `componentId`. A field
   * of a data grid is a field of a repeating section: checked per entry, as
   * {@link kernelRowFields} places it.
   */
  function checkField(node: ComponentNode, componentId: string, state: EffectiveNodeState | undefined, shapeOnly: boolean): void {
    const requiredApplies = (state === undefined || state.requiredApplies) && !shapeOnly;
    const configuration = kernelConfigurationOf(node);
    // Required OR Required when: the rule adds to the flag, never removes it.
    // The fold's record already holds the tick (`kernelFoldRequired`) and is the last word: a
    // component whose visibility this side cannot replay is set aside there.
    // The tick is read from the configuration only when the record has no entry.
    const folded = requiredBy !== undefined ? kernelOwn(requiredBy, node.id) : undefined;
    const required = folded !== undefined ? folded === true : configuration.required === true;
    const patternSource =
      typeof configuration.pattern === "string" && configuration.pattern.length > 0
        ? configuration.pattern
        : undefined;
    // Compiled once per component checked, so an uncompilable pattern is logged whether or
    // not an answer reaches the check; the same message on every engine (no RegExp error
    // text, which differs between QuickJS and V8).
    let risky = false;
    if (patternSource !== undefined && !riskyAllowed) {
      // The verdict on a source is the same in every run of a prepared definition: asked once
      // (the analysis is not free in the sandbox).
      const verdicts = kernelPreparedGet(prepared, root, "riskyPatterns", () => kernelRecord() as Record<string, boolean>);
      const known = kernelOwn(verdicts, patternSource);
      risky = known !== undefined ? known : kernelRegexRisky(patternSource);
      if (known === undefined) {
        verdicts[patternSource] = risky;
      }
    }
    const pattern = patternSource !== undefined && !risky ? kernelCompilePattern(patternSource) : null;
    if (patternSource !== undefined && pattern === null && log !== undefined) {
      log.warn((risky ? "pattern is risky: " : "pattern does not compile: ") + componentId, { componentId: componentId, pattern: patternSource });
    }
    const limits = kernelReadLengthLimits(configuration);
    // The engine type the component is read as: its own, or its base in the definition's map.
    const type = kernelKindBase(node.type, kinds);
    const bounds = kernelAnswerBounds(type, configuration);
    // A field of a repeating section is checked at the key of each entry; any other at its path.
    const row = kernelOwn(rowFields, node.id);
    const where: string[] = [];
    if (row !== undefined) {
      // Rows past a grid's maximum are refused as a whole (`rows.max`, below): their cells are
      // not checked one by one, so a body of a thousand rows past the bound costs one error.
      const held = entriesOf(row.collection);
      const max = rowMaxOf(row.collection);
      const checked = max !== undefined && held.length > max ? max : held.length;
      for (let at = 0; at < checked; at += 1) {
        where.push(row.collection + "[" + held[at] + "]" + row.suffix);
      }
    } else {
      where.push(kernelOwn(paths, node.id) ?? componentId);
    }
    for (const path of where) {
      // Past the cap the rest is cut anyway: stop looking (a million empty rows would be a million errors).
      if (errors.length > kernelErrorCap()) {
        return;
      }
      const raised = errors.length;
      const value = kernelOwn(values, path);
      // An empty list for a text is no empty answer: it is the wrong shape and is refused.
      const empty = kernelIsEmptyValue(value, type) && !kernelAnswerIsWrongShape(type, value);
      const kind = empty ? null : kernelAnswerKindCode(type, value);
      // A bound is no format: a hidden answer held only to its shape is not held to
      // it, as the browser's hidden policy drops it (a server is never stricter).
      const bound = empty || kind !== null || shapeOnly ? null : kernelAnswerBoundCode(type, value, bounds.min, bounds.max);

      if (required && empty) {
        // Empty and required: nothing else applies to an empty answer, so where requiredness
        // does not apply there is nothing to report.
        if (requiredApplies) {
          errors.push({
            code: "required",
            componentId: componentId,
            path,
            stage: "field-constraints",
            source: "wasm"
          });
        }
      } else if (kind !== null) {
        // Not a number, not a real date, not text: a format check, so a
        // hidden answer still submitted is held to it too.
        errors.push({ code: kind, componentId: componentId, path, stage: "field-constraints", source: "wasm" });
      } else if (bound !== null) {
        // A number or a date outside its declared bounds, inclusive.
        errors.push({
          code: bound,
          componentId: componentId,
          path,
          stage: "field-constraints",
          source: "wasm",
          parameters: bound.endsWith(".min") ? { min: bounds.min } : { max: bounds.max }
        });
      } else if (!empty && type === "file") {
        // Shape, then count, then size before type, first offending attachment only — as
        // `firstFileFailure` does.
        const fileLimits = kernelReadFileLimits(configuration);
        const given = Array.isArray(value) ? (value as unknown[]).length : 1;
        const attachments = kernelFileAttachments(value);
        if (attachments.length !== given) {
          // Something in the answer is no attachment: nothing to read the limits against.
          errors.push({ code: "file", componentId: componentId, path, stage: "field-constraints", source: "wasm" });
        } else if (given > fileLimits.maxFiles && !shapeOnly) {
          // The count is no format either: a hidden answer's attachments are each still held
          // to their size and type below, its count is not (the browser drops `fileCount`).
          errors.push({
            code: "fileCount",
            componentId: componentId,
            path,
            stage: "field-constraints",
            source: "wasm",
            parameters: { count: given, maxFiles: fileLimits.maxFiles }
          });
        } else {
          for (const attachment of attachments) {
            // A declared size no file has: refused before the limits are read against it.
            if (!Number.isInteger(attachment.size) || attachment.size < 0) {
              errors.push({
                code: "fileSize",
                componentId: componentId,
                path,
                stage: "field-constraints",
                source: "wasm",
                parameters: { file: attachment.name, size: attachment.size }
              });
              break;
            }
            // The larger of the declared size and the inline bytes' decoded length.
            const inlineData = (attachment as { data?: unknown }).data;
            const decodedSize = typeof inlineData === "string" ? kernelBase64DecodedLength(inlineData) : 0;
            // Inline bytes well past the declared size are a lie, not rounding: refused.
            if (decodedSize > attachment.size * 1.01 + 1024) {
              errors.push({
                code: "file.sizeMismatch",
                componentId: componentId,
                path,
                stage: "field-constraints",
                source: "wasm",
                parameters: { file: attachment.name, size: attachment.size, actual: decodedSize }
              });
              break;
            }
            const heldSize = Math.max(attachment.size, decodedSize);
            if (fileLimits.maxFileSize !== null && heldSize > fileLimits.maxFileSize) {
              errors.push({
                code: "maxFileSize",
                componentId: componentId,
                path,
                stage: "field-constraints",
                source: "wasm",
                parameters: {
                  file: attachment.name,
                  size: heldSize,
                  maxFileSize: fileLimits.maxFileSize,
                  sizeLabel: kernelFormatFileSize(heldSize),
                  maxFileSizeLabel: kernelFormatFileSize(fileLimits.maxFileSize)
                }
              });
              break;
            }
            if (!kernelMatchesAccept(attachment, fileLimits.accept)) {
              errors.push({
                code: "fileType",
                componentId: componentId,
                path,
                stage: "field-constraints",
                source: "wasm",
                parameters: { file: attachment.name, type: attachment.type, accept: fileLimits.accept.join(", ") }
              });
              break;
            }
          }
        }
      } else if (!empty && typeof value === "string") {
        const length = kernelCountCharacters(value);
        if (limits.minLength !== null && length < limits.minLength) {
          errors.push({
            code: "minLength",
            componentId: componentId,
            path,
            stage: "field-constraints",
            source: "wasm",
            parameters: { minLength: limits.minLength, length }
          });
        } else if (limits.maxLength !== null && length > limits.maxLength) {
          errors.push({
            code: "maxLength",
            componentId: componentId,
            path,
            stage: "field-constraints",
            source: "wasm",
            parameters: { maxLength: limits.maxLength, length }
          });
        } else if (patternSource !== undefined) {
          // An uncompilable pattern is skipped (logged above) unless the run fails closed on
          // definition problems; then the answer cannot be shown to match and is refused.
          const unenforceable = pattern === null;
          if ((unenforceable && failClosed) || (pattern !== null && !pattern.test(value))) {
            const authoredMessage = configuration.patternMessage;
            const message =
              typeof authoredMessage === "string"
                ? kernelResolveText(authoredMessage, { kind: "components", owner: componentId, path: ["patternMessage"] }, locale, translations, catalog)
                : undefined;
            errors.push({
              code: "pattern",
              componentId: componentId,
              path,
              stage: "field-constraints",
              source: "wasm",
              parameters: {
                pattern: patternSource,
                ...(unenforceable ? { invalid: true } : {}),
                ...(risky ? { risky: true } : {}),
                ...(message !== undefined ? { message } : {})
              }
            });
          }
        }
      }
      // The field's own check across answers, last: a non-empty answer nothing above
      // refused, on a component the fold read the rule for (never a row field). A hidden answer
      // held only to its shape is not held to it: `rule` is no format check.
      if (!empty && !shapeOnly && row === undefined && errors.length === raised && invalidBy !== undefined && kernelOwn(invalidBy, componentId) === true) {
        errors.push({ code: "rule", componentId: componentId, path, stage: "field-constraints", source: "wasm" });
      }
    }
  }

  /**
   * A data grid's rows counted against its bounds: `rows.min` (`{ min, count }`) or
   * `rows.max` (`{ max, count }`) against the grid at its collection path; a grid with no
   * maximum, fixed or resolved, is held to the row cap, as adding a row is in the browser, so a
   * client cannot post more rows than a person could add. The count is the
   * grid's entries as {@link entriesOf} reads them, a row posted as `{}` included, so an empty
   * row the browser drew counts here as there. A grid whose path defines no key (written with
   * brackets, or inside a section that is) has no entries to count and is passed over.
   */
  function checkRows(node: ComponentNode, shapeOnly: boolean): void {
    const collection = kernelCollectionPathOf(node);
    if (collection === undefined || errors.length > kernelErrorCap()) {
      return;
    }
    const lists = kernelPreparedGet(prepared, root, "rowLists", () => kernelRowListPaths(root));
    if (kernelOwn(lists, collection) !== true) {
      return;
    }
    if (shapeOnly) {
      // Hidden, not validated, its rows still submitted: the author's bounds are not checked (the
      // browser drops the same errors), but no person could add rows past the cap, so a post that
      // has them is refused here as for a grid that is shown.
      const held = entriesOf(collection).length;
      if (held > kernelDataGridRowsCap()) {
        errors.push({
          code: "rows.max",
          componentId: node.id,
          path: collection,
          stage: "field-constraints",
          source: "wasm",
          parameters: { max: kernelDataGridRowsCap(), count: held }
        });
      }
      return;
    }
    // The fixed bounds, overruled by a formula that came to a usable number.
    const rowBoundsBy = options !== undefined ? options.rowBoundsBy : undefined;
    const bounds = kernelResolveDataGridRowBounds(
      kernelDataGridRowBounds(node),
      rowBoundsBy !== undefined ? kernelOwn(rowBoundsBy, node.id) : undefined
    );
    const count = entriesOf(collection).length;
    if (count < bounds.min) {
      errors.push({
        code: "rows.min",
        componentId: node.id,
        path: collection,
        stage: "field-constraints",
        source: "wasm",
        parameters: { min: bounds.min, count }
      });
    } else if (count > (bounds.max !== undefined ? bounds.max : kernelDataGridRowsCap())) {
      errors.push({
        code: "rows.max",
        componentId: node.id,
        path: collection,
        stage: "field-constraints",
        source: "wasm",
        parameters: { max: bounds.max !== undefined ? bounds.max : kernelDataGridRowsCap(), count }
      });
    }
  }

  function walk(node: ComponentNode): void {
    const state =
      effective !== undefined && Object.prototype.hasOwnProperty.call(effective, node.id)
        ? (effective[node.id] as EffectiveNodeState)
        : undefined;
    // Hidden, not validated, but its answer still submitted: its format still holds.
    const shapeOnly = state !== undefined && !state.runValidation && state.submitValue && !state.clearValue;
    if (node.type !== "form" && (state === undefined || state.runValidation || shapeOnly)) {
      checkField(node, node.id, state, shapeOnly);
      // A data grid's row count; a grid held only to the shape of what it
      // still submits is held to the row cap alone (see checkRows).
      if (node.type === "dataGrid") {
        checkRows(node, shapeOnly);
      }
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  }
  walk(root);
  return errors;
}

/**
 * A deep, frozen copy of `value`: what a plugin validator is handed as
 * `context.values`. A validator is a judge, not a writer: whatever it does to its copy (it may
 * try, and under strict mode a write to a frozen object throws, which fails the validator
 * closed) the answers the run stores are the fold's. Walked with an explicit stack, so a
 * deeply nested answer cannot exhaust the sandbox's call stack; keys are defined, not assigned,
 * so an own `__proto__` key stays a key. Only enumerable own properties are copied (what JSON
 * carries).
 */
export function kernelFrozenCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const top: object = Array.isArray(value) ? [] : {};
  const stack: Array<{ from: Record<string, unknown>; to: object }> = [{ from: value as Record<string, unknown>, to: top }];
  const copies: object[] = [];
  while (stack.length > 0) {
    const item = stack.pop() as { from: Record<string, unknown>; to: object };
    copies.push(item.to);
    for (const key of Object.keys(item.from)) {
      const child = item.from[key];
      let copy: unknown = child;
      if (child !== null && typeof child === "object") {
        copy = Array.isArray(child) ? [] : {};
        stack.push({ from: child as Record<string, unknown>, to: copy as object });
      }
      Object.defineProperty(item.to, key, { value: copy, enumerable: true, writable: true, configurable: true });
    }
  }
  for (let at = 0; at < copies.length; at += 1) {
    Object.freeze(copies[at]);
  }
  return top;
}

/**
 * A validator's `errors` list copied as plain data, every level, in one pass that reads each
 * member once: lists by index into fresh lists (never through the plugin's own `map`, which a
 * list subclass can turn into anything with `Symbol.species`), records by their own enumerable
 * keys into fresh records, anything else as it is. `undefined` when the list nests deeper than
 * 32 levels or holds more than 100,000 lists, records and members in all: such an answer (a
 * parameter that holds itself, a chain hundreds of levels deep) is no answer the run can write
 * out, and is read as unusable, failing closed, rather than overflow the stack writing it.
 * Explicit stack.
 */
export function kernelValidatorErrorsCopy(listed: unknown[]): unknown[] | undefined {
  const maxDepth = 32;
  let budget = 100000;
  const root: unknown[] = [];
  const stack: Array<{ from: unknown; into: unknown[] | Record<string, unknown>; key: string | number; depth: number }> = [];
  const length = listed.length;
  // Each list or record is weighed before any of its members is read or held, so an answer far
  // past the bound (a sparse list of millions of slots) costs nothing to refuse.
  budget -= length;
  if (budget < 0) {
    return undefined;
  }
  for (let at = 0; at < length; at += 1) {
    stack.push({ from: listed[at], into: root, key: at, depth: 1 });
  }
  while (stack.length > 0) {
    if (budget < 0) {
      return undefined;
    }
    const item = stack.pop() as { from: unknown; into: unknown[] | Record<string, unknown>; key: string | number; depth: number };
    const from = item.from;
    let copy: unknown = from;
    if (from !== null && typeof from === "object") {
      if (item.depth >= maxDepth) {
        return undefined;
      }
      if (Array.isArray(from)) {
        const list: unknown[] = [];
        const count = from.length;
        budget -= count + 1;
        if (budget < 0) {
          return undefined;
        }
        for (let at = 0; at < count; at += 1) {
          list.push(undefined);
          stack.push({ from: from[at], into: list, key: at, depth: item.depth + 1 });
        }
        copy = list;
      } else {
        const record: Record<string, unknown> = {};
        const keys = Object.keys(from);
        budget -= keys.length + 1;
        if (budget < 0) {
          return undefined;
        }
        for (let k = 0; k < keys.length; k += 1) {
          const key = keys[k] as string;
          Object.defineProperty(record, key, { value: undefined, writable: true, enumerable: true, configurable: true });
          stack.push({ from: (from as Record<string, unknown>)[key], into: record, key, depth: item.depth + 1 });
        }
        copy = record;
      }
    }
    if (Array.isArray(item.into)) {
      item.into[item.key as number] = copy;
    } else {
      Object.defineProperty(item.into, item.key as string, { value: copy, writable: true, enumerable: true, configurable: true });
    }
  }
  return root;
}

/**
 * What is wrong with a plugin validator's answer, or `undefined` when it is usable: an object, not a promise, whose `errors` is a list of records that each carry a
 * string `code`. A validator that cannot answer is no pass; the run fails as a validator that
 * will not run does (`validator_unavailable` in the service, `wasm.execution_error` in the
 * browser).
 */
export function kernelValidatorFault(result: unknown): string | undefined {
  if (result === null || result === undefined) {
    return "returned " + String(result);
  }
  if (typeof result !== "object") {
    return "returned " + typeof result;
  }
  if (typeof (result as { then?: unknown }).then === "function") {
    return "returned a promise (a validator must answer synchronously)";
  }
  const errors = (result as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return "returned no { errors } list";
  }
  for (let at = 0; at < errors.length; at += 1) {
    const entry: unknown = errors[at];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { code?: unknown }).code !== "string") {
      return "returned an error entry without a string code (entry " + at + ")";
    }
  }
  return undefined;
}

/**
 * The kernel entry point: partition unknown fields per `context.unknownFields` -> fold ->
 * schema constraints -> plugin validators -> outcome. `context.form` is the schema root.
 *
 * The fold ({@link kernelFoldSubmission}) resolves every component's rules over
 * the submittable view, as the browser runtime does, and with `context.journey` works out the
 * path from the values and folds everything off it to hidden. Before it, the calculations are
 * worked out again from what was sent, so a forged calculated answer steers nothing. Its states
 * decide what is checked: a hidden component is validated and required only as its
 * hidden-behaviour policy says — though an answer it still submits keeps its format checks —
 * a path that ends at an exit page is refused (`journey.exit`), and a fold that does not settle
 * is refused (`fold.unsettled`). Its `required` record decides which empty answers
 * are refused: a component's `required` flag OR its `requiredWhen` holding over the settled
 * view, a rule reading `host.` never counting here. Its submittable values are what validators
 * see and what comes back as `values`, only when no blocking error was found. This applies
 * to every form, not only journeys: a field hidden by its own rule (or by a
 * hidden ancestor) stops being required here, as in the browser, a field
 * whose `requiredWhen` holds is required here as in the browser, and a hidden answer its value
 * behaviour excludes is dropped.
 *
 * Validator-authored errors pass through untouched — the kernel adds, it does not rewrite —
 * except that one on a component the fold does not validate is dropped, as the browser drops
 * it (`errorPassesHiddenPolicy`). Each step writes to the run log (`context.logLevel` sets
 * what is kept), and so may the validators through `context.log`; what was kept
 * comes back as `logs`.
 *
 * **Presentations.** A journey's page may hold nodes the presentation owns.
 * The kernel places through them — a form field a page references, fills or works out counts
 * as asked on that page (`journeyOwnership`) — and otherwise knows nothing of them: it reads
 * none of their rules and no worked-out value's expression, and their answers are not form
 * values. A key an own field's answer would travel under (`@<presentation>.<id>`) is a key the
 * schema does not define, like any other: `unknownFields` decides it, and honest browsers
 * never send one. Two things come back beside the verdict. `clientDerived` lists the value
 * paths of the judged answers that were worked out in the browser and kept as sent
 * ({@link kernelClientDerived}); each is still held to the form's rules. With `context.page`
 * naming a page of the journey, `pageComponentIds` lists the form components in scope for it
 * ({@link kernelPageComponentIds}), so a host can keep a page's check to that page; the
 * verdict itself is the whole submission's either way.
 *
 * **Formulas.** Before anything reads a rule, the definition and the
 * journey are compiled into copies with every formula a tree (`kernelCompileDefinition`);
 * the context's own objects are never changed, since a server hands over the definition it
 * stores and hashes. `signatures` is what the parser checks a call against: the built-in
 * table's plus the wired plugins' (the kernel cannot read the table itself: it is data the
 * sandbox program is not spliced with); a caller that passes none parses against the built-ins
 * alone (`kernelBuiltInFunctionSignatures`), so a plugin's function is reported.
 * `context.formulaErrors`, else the form's own `root.configuration.formulaErrors`, else `fail`, says what a problem
 * costs: one `formula.invalid` error each and no judging at all (no fold, no constraints, no
 * validators), or, under the explicit opt-in `warn`, a log line each (`kernelFormulaPolicy`).
 * A clean compile logs nothing, so a run
 * over a form without formulas says what it always said. `context.today` is the day the
 * rules read (`today()`, `age()`), checked to be a real calendar date (else warned about and
 * treated as absent); `functions` are the plugins' formula functions, on every rule context.
 * Two more optional outcome keys, each only when non-empty: `clockDependent` and `serverRules`.
 * The journey's shape is checked after the compile, on the compiled copy, as the browser
 * checks its own: a page or route `when` of a shape no reader accepts is a formula problem
 * under the policy on both sides, and `journey.invalid` names only a shape the compile leaves
 * as it found it ({@link kernelIsJourney}).
 *
 * **The document and the index.** `context.document` is the delivered document as
 * the host received it (an envelope, or a signed wrapper), not rewritten: the outcome then
 * carries its canonical text and SHA-256 digest ({@link kernelDocumentDigest}), whatever the
 * verdict, so a host stores both and never serializes a document itself. Both are worked out
 * first, before the compile, the fold and the validators, and validators never see the
 * document (it is left out of their context), so nothing the run does can change what they
 * name. The verdict never reads it; the answers judged are `context.values`. A validator that
 * throws blocks the run with `validator.failed` (`parameters.validator`, its 1-based position;
 * the message goes to the log at `error`) instead of ending it, so the outcome still comes back. Whenever `values` comes back, `index`
 * comes with it: the same object as one row per answer ({@link kernelValueIndex}).
 *
 * **Choice answers.** Once the fold has settled the values that will be stored, every
 * choice answer among them is held to its options (`kernelCheckOptions`,
 * `portable-options.ts`): inline options from the definition, a data source's from
 * `context.optionSnapshot`, a source absent from the snapshot refused (`option.sourceUnavailable`), the answer's shape
 * always. A refusal is an `option.notAllowed` error and stands on a hidden component too.
 */
export function runKernel(
  context: ValidationContext & {
    form?: ComponentNode;
    unknownFields?: KernelUnknownFieldsMode;
    logLevel?: ValidationLogThreshold;
    journey?: Journey;
    page?: string;
    today?: string;
    /** The values `host.` reads, supplied by the server (never the browser's); see {@link KernelEvaluation.hostContext}. */
    hostContext?: unknown;
    formulaErrors?: FormulaErrorPolicy;
    riskyPatterns?: string;
    reportFold?: boolean;
    document?: unknown;
    optionSnapshot?: KernelOptionSnapshot;
    /** The definition's `translations`: read tolerantly, only to word messages. */
    translations?: unknown;
    /**
     * The host's translation catalog (shape: locale, kind, owner, property, string
     * leaves): read tolerantly, before the map under the same tag.
     * Absent when the host has none.
     */
    catalog?: unknown;
    /**
     * The definition's `kinds` map (type -> engine base type, `core/schema/component-kinds.ts`):
     * the field constraints and the option check read a type it names as its base. Read
     * tolerantly: anything that is not a record of strings naming engine types maps nothing.
     */
    kinds?: unknown;
  },
  validators: readonly KernelValidator[],
  functions?: Record<string, (args: unknown[]) => unknown>,
  signatures?: FormulaFunctionSignature[],
  cache?: KernelPreparedCache
): KernelOutcome {
  // Before anything walks the definition: components nested past the limit (root = level 1) are
  // refused with a typed error, not walked (the sandbox's own stack is what a deep tree would
  // exhaust). The run then judges as a run with no schema.
  // A data grid with no binding is bound at its id, as the browser compiles it
  // (`normalizeDataGrids`), before anything — the depth check included — walks the tree:
  // every reader below knows a grid only by its `collection`. The context's own objects are
  // never changed.
  const form = context.form !== undefined && context.form !== null ? kernelNormalizeDataGrids(context.form) : context.form;
  const tooDeepAt = form !== undefined && form !== null ? kernelComponentTooDeep(form, context.journey) : undefined;
  // Then what no walk survives: a node that is no record, a slot that is no list, ids whose
  // parents loop. `check` refuses each; a run not given that verdict refuses here, typed, rather
  // than throw a raw TypeError or walk an ancestor chain that never ends.
  const faultAt = tooDeepAt === undefined && form !== undefined && form !== null ? kernelComponentTreeFault(form) : undefined;
  const authored = tooDeepAt === undefined && faultAt === undefined ? form : undefined;
  const rawValues = context.values ?? {};
  const mode: KernelUnknownFieldsMode =
    context.unknownFields === "keep" || context.unknownFields === "reject"
      ? context.unknownFields
      : "strip";
  const errors: KernelValidationError[] = [];
  const log = kernelCreateLog(context.logLevel);
  if (tooDeepAt !== undefined) {
    errors.push({
      code: "definition.tooDeep",
      stage: "definition",
      source: "wasm",
      parameters: { where: tooDeepAt, limit: kernelMaxComponentDepth() }
    });
    log.error("the definition is refused: components nest more than " + kernelMaxComponentDepth() + " levels deep (at " + tooDeepAt + ")");
  }
  if (faultAt !== undefined) {
    errors.push({ code: faultAt.code, stage: "definition", source: "wasm", parameters: { where: faultAt.where } });
    log.error(
      "the definition is refused: " +
        (faultAt.code === "definition.idCycle" ? "a component shares an id with one of its own ancestors" : "a component or a children slot is not of the shape a form tree has") +
        " (at " + faultAt.where + ")"
    );
  }
  // The document as the host received it, named before anything else runs: no compile, fold or
  // validator can change the text the digest is over, and a validator that throws cannot lose it.
  const named = context.document !== undefined ? kernelDocumentDigest(context.document) : undefined;
  function brief(error: KernelValidationError): Record<string, unknown> {
    return error.componentId !== undefined ? { code: error.code, componentId: error.componentId } : { code: error.code };
  }
  // The locale picks a message text: a text of at most 35 characters (a BCP 47 tag fits), else
  // read as absent, so a host passing a request member through never gets a raw TypeError.
  let locale = "en";
  if (context.locale !== undefined && context.locale !== null) {
    if (typeof context.locale === "string" && context.locale.length <= 35) {
      locale = context.locale;
    } else {
      log.warn("context.locale is not a text of at most 35 characters; treated as absent");
    }
  }
  log.debug("run: " + (authored ? "schema " + authored.id : "no schema") + ", unknown fields " + mode, {
    formId: context.formId,
    locale,
    fields: Object.keys(rawValues).length
  });

  // The day the rules read: a real calendar date, or none.
  let today: string | undefined;
  if (context.today !== undefined && context.today !== null) {
    if (kernelIsDateAnswer(context.today)) {
      today = context.today;
    } else {
      log.warn("context.today is not a YYYY-MM-DD calendar date; treated as absent", { today: context.today });
    }
  }
  // `refuseRisky` makes `matches` refuse a pattern of a catastrophic shape built at run time, as
  // the compile refuses a literal one, unless the host allows risky patterns.
  const evaluation: KernelEvaluation = { regexCache: context.riskyPatterns === "allow" ? {} : { refuseRisky: true } };
  if (today !== undefined) {
    evaluation.today = today;
  }
  // The values `host.` reads: a record the server supplied, read as it is (a key it lacks is no
  // answer). Anything else is warned about and read as absent, so the run judges as one given
  // none: every rule reading `host.` skipped, the lenient reading.
  if (context.hostContext !== undefined && context.hostContext !== null) {
    if (typeof context.hostContext === "object" && !Array.isArray(context.hostContext)) {
      evaluation.hostContext = context.hostContext as Record<string, unknown>;
    } else {
      log.warn("context.hostContext is not an object; treated as absent");
    }
  }
  // A plugin function that throws answers `undefined` in the evaluator. The run
  // records each throw against the rule being evaluated (`evaluation.where`) so a
  // `fail` policy can refuse the submission naming the rule, and a `warn` one can say so; the
  // wrapper rethrows, so what the rule reads is unchanged.
  const thrown: Array<{ where: string; name: string; message: string }> = [];
  const thrownSeen = kernelRecord() as Record<string, true>;
  // What a formula function says it did not do (a size cap, a plugin result that is not data)
  // goes to the run's log once per message, and to no other record: the rule reads no answer.
  const warnedFormula = kernelRecord() as Record<string, true>;
  // Whether `where` (`rules:<id>:<key>`) is a rule the compile honours as `server-secret`: what
  // a run says of it carries no rule text, as `check` does.
  const secretWhere = kernelRecord() as Record<string, boolean>;
  function isSecretWhere(where: string): boolean {
    if (authored === undefined || authored === null || where.indexOf("rules:") !== 0) {
      return false;
    }
    if (secretWhere[where] === undefined) {
      const probe = kernelRedactSecretProblems([{ where, code: "invalidRule", message: "" }], authored)[0];
      secretWhere[where] = probe !== undefined && probe.message !== "";
    }
    return secretWhere[where] === true;
  }
  evaluation.warn = function (message: string): void {
    if (evaluation.where !== undefined && isSecretWhere(evaluation.where)) {
      message = "a function in a server-secret rule did not answer; the details are withheld";
    }
    if (kernelOwn(warnedFormula, message) !== true) {
      warnedFormula[message] = true;
      log.warn("formula function: " + message);
    }
  };
  if (functions !== undefined && functions !== null && typeof functions === "object") {
    const wrapped = kernelRecord() as Record<string, (args: unknown[]) => unknown>;
    for (const name of Object.keys(functions)) {
      const original = functions[name] as (args: unknown[]) => unknown;
      wrapped[name] =
        typeof original !== "function"
          ? original
          : function (args: unknown[]): unknown {
              try {
                const result = original(args);
                // A result that is not plain data (NaN, a promise, a function, a Date, a class
                // instance) is no answer: said once, named, and read as `undefined`.
                const problem = kernelExprPluginProblem(result);
                if (problem !== undefined) {
                  (evaluation.warn as (message: string) => void)('the function "' + name + '" returned ' + problem + "; read as no answer");
                  return undefined;
                }
                return result;
              } catch (failure) {
                const where = evaluation.where !== undefined ? evaluation.where : "";
                if (kernelOwn(thrownSeen, where + "\n" + name) !== true) {
                  thrownSeen[where + "\n" + name] = true;
                  thrown.push({ where, name, message: failure instanceof Error ? failure.message : String(failure) });
                }
                throw failure;
              }
            };
    }
    evaluation.functions = wrapped;
  }

  // The compile point: copies with every formula a tree, the context's objects untouched. A
  // problem is judged by the context's policy, else the form's own, else `warn`. The journey
  // is compiled before its shape is checked (`kernelIsJourney`, below), exactly as the browser
  // reads its journeys from the compiled copy: a page or route `when` that is not a formula, a
  // tree or the object form is the compile's problem (reported, and the condition dropped), so
  // both sides judge such a journey alike under the policy. `journey.invalid` is kept for what
  // the compile cannot repair: a journey that is not an object, has no id or pages, a page
  // whose components or routes are not lists, an unknown kind or end check.
  let root = authored;
  let journeySource: unknown = context.journey;
  let prepared: KernelPrepared | undefined;
  let sharesDefinition = false;
  // The keys' shapes and whether the schema defines them, asked once per key over the whole run.
  const keyMemo: KernelKeyMemo = { defined: kernelRecord() as Record<string, boolean>, shapes: kernelRecord() as Record<string, string | false> };
  let refused = false;
  // The run's policy for definition problems: the context's, else the form's own,
  // else `fail`. Read once; the compile's problems and the field constraints' uncompilable
  // pattern are judged by the same word.
  const formulaPolicy: FormulaErrorPolicy = kernelFormulaPolicy(authored ? authored.configuration : undefined, context.formulaErrors);
  if (authored) {
    // The prepared definition: the compile and what a run builds over its tree, worked
    // out once per definition when the host keeps a cache (the same definition, policy word,
    // risky-pattern word and signatures are the same object), else for this run alone. Either
    // way the run reads the same data, so a hit cannot change an outcome; what the compile
    // found is judged and logged below on every run.
    // A caller that hands no signatures (a direct call: every host passes its own list) parses
    // against the built-ins, as a host with no plugins does.
    const parserSignatures = Array.isArray(signatures) ? signatures : kernelBuiltInFunctionSignatures();
    const cacheKey =
      cache !== undefined ? kernelPreparedKey(cache, authored, context.journey, undefined, formulaPolicy, context.riskyPatterns, parserSignatures) : undefined;
    let remembered = cache !== undefined && cacheKey !== undefined ? kernelPreparedLookup(cache, cacheKey) : undefined;
    if (remembered === undefined) {
      remembered = kernelPrepareDefinition(authored, context.journey, undefined, formulaPolicy, context.riskyPatterns, parserSignatures);
      if (cache !== undefined && cacheKey !== undefined) {
        kernelPreparedStore(cache, cacheKey, remembered);
        // Shares nodes with the definition this run was handed, until a validator could see it.
        sharesDefinition = true;
      }
    }
    prepared = remembered;
    const compiled = remembered;
    root = compiled.root;
    // Findings that never refuse a run (a condition that is no yes-or-no): one warn line each,
    // whatever the policy, as the browser's console line says.
    // A problem on a server-secret rule says where and what kind, never the rule's text.
    for (const warning of compiled.warnings.length > 0 ? kernelRedactSecretProblems(compiled.warnings, authored) : compiled.warnings) {
      log.warn("formula warning: " + warning.where + ": " + warning.message);
    }
    if (compiled.unparsedCalculations.length > 0) {
      evaluation.unparsedCalculations = compiled.unparsedCalculations;
    }
    journeySource = compiled.journey;
    if (compiled.problems.length > 0) {
      const policy = formulaPolicy;
      // A rule the server runs that calls a function the server does not have is not a rule it
      // may drop: the browser, which has the function, enforces it, and a server that read the
      // rule as absent would accept what the browser refuses. Under
      // `fail` every problem refuses; under `warn` an `unknownFunction` problem on a rule that
      // runs on the server refuses too, naming the function. A browser-only rule keeps the
      // policy.
      let authoredIndex: ReturnType<typeof kernelTreeIndex> | undefined;
      let refusals = 0;
      const reported = kernelRedactSecretProblems(compiled.problems, authored);
      for (let at = 0; at < compiled.problems.length; at += 1) {
        const problem = compiled.problems[at] as FormulaProblem;
        const said = reported[at] as FormulaProblem;
        let refuses = policy === "fail";
        if (!refuses && policy === "warn" && problem.code === "unknownFunction") {
          if (authoredIndex === undefined) {
            authoredIndex = kernelTreeIndex(authored);
          }
          refuses = kernelProblemRunsOnServer(authoredIndex, problem.where);
        }
        if (refuses) {
          refusals += 1;
          const parameters: Record<string, unknown> = { where: problem.where, message: said.message };
          if (said === problem && problem.code === "unknownFunction" && problem.params !== undefined && problem.params.name !== undefined) {
            parameters.function = problem.params.name;
          }
          errors.push({ code: "formula.invalid", stage: "definition", source: "wasm", parameters });
          log.error("formula invalid: " + problem.where + ": " + said.message);
        } else if (policy === "warn") {
          log.warn("formula invalid: " + problem.where + ": " + said.message);
        }
      }
      if (refusals > 0) {
        refused = true;
        log.error("the definition is refused: " + refusals + " formula problem(s); nothing else is judged");
      }
    }
  }

  let values: Record<string, unknown>;
  // The delivered keys the form defines (what a withheld answer is told apart from): the
  // partition's known keys, or every delivered key when unknown fields are kept.
  let definedValues: Record<string, unknown> = rawValues;
  // Rows posted as `{}`.
  let emptyRows: string[] = [];
  if (!root) {
    values = { ...rawValues };
  } else if (mode === "keep") {
    // Rows posted whole are still read as flat keys, so every reader sees one shape;
    // anything else, a malformed list included, is kept as sent.
    const rows = kernelFlattenRows(rawValues, root, prepared, keyMemo.shapes);
    values = { ...rows.values };
    emptyRows = rows.emptyRows;
    if (rows.superseded.length > 0) {
      log.info("rows posted whole dropped: their entries were sent as keys", { fields: rows.superseded });
    }
    if (rows.unreadable.length > 0) {
      log.info("objects too deep to read as keys, and values at a container key, not stored", { fields: rows.unreadable });
    }
  } else {
    const partition = kernelPartitionValues(rawValues, root, prepared, keyMemo);
    values = partition.known;
    definedValues = partition.known;
    emptyRows = partition.emptyRows;
    if (partition.superseded.length > 0) {
      log.info("rows posted whole dropped: their entries were sent as keys", { fields: partition.superseded });
    }
    if (partition.unknownKeys.length > 0) {
      log.info(mode === "reject" ? "unknown fields rejected" : "unknown fields stripped", { fields: partition.unknownKeys });
    } else {
      log.debug("no unknown fields");
    }
    if (mode === "reject") {
      for (const key of partition.unknownKeys) {
        // No componentId/path: an unknown field has no component for the renderer to mark;
        // the key travels in parameters so hosts can report it.
        errors.push({
          code: "unknown_field",
          stage: "sanitization",
          source: "wasm",
          parameters: { field: key }
        });
      }
    }
  }

  let effective: Record<string, EffectiveNodeState> | undefined;
  // Calculations that do not settle: no one stored value to judge, refused below.
  let unsettledCalculations: string[] | undefined;
  let clientDerived: string[] = [];
  let clockDependent: string[] = [];
  let serverRules: string[] = [];
  let visibilitySkipped: string[] = [];
  let pageComponentIds: string[] | undefined;
  let foldTrace: KernelFoldResult["trace"];
  if (root && !refused) {
    let journey: Journey | undefined;
    if (journeySource !== undefined && journeySource !== null) {
      // The compiled copy's shape: what the browser's `validateJourneyShape` sees of the same
      // journey once compiled (`readJourneys` reads the compiled definition too).
      // The structure caps hold at run too: a host that takes the journey from
      // anywhere but a gated stored definition cannot hand the walk more than the definition may
      // hold. Read off the raw lists, before the shape check walks them.
      const caps = kernelStructureLimits();
      let tooMany: "journey.page.tooMany" | "journey.route.tooMany" | undefined;
      let cap = 0;
      const rawPages: unknown = typeof journeySource === "object" && journeySource !== null ? (journeySource as { pages?: unknown }).pages : undefined;
      if (Array.isArray(rawPages)) {
        if (rawPages.length > caps.pages) {
          tooMany = "journey.page.tooMany";
          cap = caps.pages;
        } else {
          for (const page of rawPages) {
            const routes: unknown = typeof page === "object" && page !== null ? (page as { routes?: unknown }).routes : undefined;
            if (Array.isArray(routes) && routes.length > caps.routesPerPage) {
              tooMany = "journey.route.tooMany";
              cap = caps.routesPerPage;
              break;
            }
          }
        }
      }
      if (tooMany !== undefined) {
        errors.push({ code: tooMany, stage: "journey", source: "wasm", parameters: { limit: cap } });
        log.error("the context's journey is over the structure caps (" + tooMany + ", at most " + cap + ")");
      } else if (kernelIsJourney(journeySource)) {
        journey = journeySource;
      } else {
        // A host bug, not the person's: fail closed rather than judge the answers as a whole
        // form, which would both require fields the person was never shown and submit answers
        // from branches they did not take.
        errors.push({ code: "journey.invalid", stage: "journey", source: "wasm" });
        log.error("the context's journey is not a usable journey (the shape validateJourneyShape checks)");
      }
    }
    // A route condition that reads the clock, with no day to read it by:
    // the path cannot be replayed, so the submission is refused, whether the
    // route leads to a page or past an exit page, rather than guess one the person did not take.
    // The walk still runs, so the errors of the path it fell through to follow the refusal. A
    // host that runs a journey passes `context.today`.
    if (journey !== undefined && today === undefined) {
      const clockPages = kernelJourneyClockPages(journey);
      if (clockPages.length > 0) {
        errors.push({ code: "journey.clockDependent", stage: "journey", source: "wasm", parameters: { journey: journey.id, page: clockPages[0] as string } });
        log.error("the journey reads the clock (page " + clockPages[0] + ") and the context gave no today");
      }
    }
    // The fold logs only what it changed — a journey's path, answers withheld, a fold that
    // would not settle — so a run over a form with neither says what it always said.
    const fold = kernelFoldSubmission(root, values, journey, evaluation, prepared, keyMemo);
    effective = fold.effective;
    foldTrace = fold.trace;
    clientDerived = fold.clientDerived;
    clockDependent = fold.clockDependent;
    serverRules = fold.serverRules;
    visibilitySkipped = fold.visibilitySkipped;
    if (fold.ownership !== undefined && typeof context.page === "string") {
      pageComponentIds = kernelPageComponentIds(fold.ownership, context.page);
    }
    if (fold.recalculated.length > 0) {
      log.info("calculations recomputed", { fields: fold.recalculated });
    }
    if (!fold.calculationsConverged) {
      // The browser refuses to open such a form; the server refuses the submission, naming
      // the calculations, rather than keep a value that is an artifact of the pass count.
      unsettledCalculations = fold.calculationCycle !== undefined ? fold.calculationCycle : [];
      const named = unsettledCalculations.join(" -> ");
      const message = "the calculations do not settle" + (named !== "" ? ": " + named : "");
      errors.push({
        code: "formula.invalid",
        stage: "definition",
        source: "wasm",
        parameters: { where: "rules:" + (unsettledCalculations[0] !== undefined ? unsettledCalculations[0] : "") + ":value", message }
      });
      log.error("formula invalid: " + message);
    }
    if (!fold.converged) {
      // Rules that keep flipping one another through the answers they hide: there is no one
      // submittable view to judge, so refuse, with the form-level error the browser raises for
      // the same fold. A browser's own submission seldom trips this — it sends its
      // last pass's view, which may settle at once here — so this is for a host that sends
      // the answers as stored.
      errors.push({ code: "fold.unsettled", stage: "state", source: "wasm" });
      log.error("fold did not settle after " + fold.passes + " passes; the submission is refused");
    }
    if (journey !== undefined && fold.trace !== undefined) {
      log.debug("journey " + journey.id + ": " + fold.trace.pages.length + " page(s) on the path, ends at " + fold.trace.end, {
        pages: fold.trace.pages
      });
      if (fold.trace.end === "exit") {
        const exitPage = fold.trace.pages[fold.trace.pages.length - 1];
        errors.push({
          code: "journey.exit",
          stage: "journey",
          source: "wasm",
          parameters: exitPage !== undefined ? { journey: journey.id, page: exitPage } : { journey: journey.id }
        });
        log.info("journey ended at an exit page", { page: exitPage });
      }
    }
    const withheld: string[] = [];
    for (const key of Object.keys(values)) {
      // An entry holding `undefined` is not an answer: JSON would not have carried it.
      if (values[key] !== undefined && !Object.prototype.hasOwnProperty.call(fold.submittable, key)) {
        withheld.push(key);
      }
    }
    if (withheld.length > 0) {
      log.info("hidden values withheld", { fields: withheld });
    }
    // An ordinary object again for validators and the outcome (a plugin may call a method on
    // it); spread, not assigned, so an own `__proto__` key is copied as a key.
    values = { ...fold.submittable };
    // Choice answers held to their options, over the values that will be stored: a
    // hidden answer the form retains is checked, a withheld one is not there. Not passed
    // through the fold's error filter: a refused option stands on a hidden component too,
    // since it is stored all the same.
    // The questions depend on the definition's `kinds` map as well as the tree, so a prepared
    // definition keeps them per map (the prepared key is the tree's text alone).
    const kinds = context.kinds;
    const baseOf = function (type: string): string {
      return kernelKindBase(type, kinds);
    };
    const optionErrors = kernelCheckOptions(
      root,
      values,
      context.optionSnapshot,
      log,
      kernelPreparedGet(prepared, root, "optionQuestions" + kernelKindsSlot(kinds), () => kernelOptionQuestions(root, baseOf)),
      baseOf
    );
    // A loop, not a spread: a call takes at most 65,535 arguments.
    for (const optionError of optionErrors) {
      errors.push(optionError);
    }
    if (optionErrors.length > 0) {
      log.info("choice answers refused", { errors: optionErrors.map(brief) });
    }

    const constraintErrors = kernelRunFieldConstraints(root, values, locale, effective, fold.required, {
      log,
      formulaErrors: formulaPolicy,
      riskyPatterns: context.riskyPatterns,
      prepared,
      invalidBy: fold.invalid,
      emptyRows,
      rowBoundsBy: fold.rowBounds,
      translations: context.translations,
      catalog: context.catalog,
      kinds
    });
    for (const constraintError of constraintErrors) {
      errors.push(constraintError);
    }
    const notValidated: string[] = [];
    for (const id of Object.keys(effective)) {
      if (id !== root.id && !(effective[id] as EffectiveNodeState).runValidation) {
        notValidated.push(id);
      }
    }
    const constraintData: Record<string, unknown> = {};
    if (constraintErrors.length > 0) {
      constraintData.errors = constraintErrors.map(brief);
    }
    if (notValidated.length > 0) {
      constraintData.notValidated = notValidated;
    }
    if (fold.requiredByRule.length > 0) {
      constraintData.requiredByRule = fold.requiredByRule;
    }
    log.debug(
      "field constraints: " + constraintErrors.length + " error(s)",
      Object.keys(constraintData).length > 0 ? constraintData : undefined
    );
  }

  // A plugin function that threw while a rule was evaluated: under `fail` a rule
  // that cannot run is no rule to drop, so the submission is refused naming it, as one whose
  // formula does not parse is; under `warn` the run says so. The rule read `undefined`
  // meanwhile. The validators are skipped for a refusal.
  let failedRules = false;
  for (const failure of thrown) {
    const secret = isSecretWhere(failure.where);
    const text = secret
      ? "The details of this problem are withheld."
      : 'function "' + failure.name + '" threw' + (failure.message !== "" ? ": " + failure.message : "");
    if (formulaPolicy === "fail") {
      failedRules = true;
      errors.push({
        code: "formula.invalid",
        stage: "definition",
        source: "wasm",
        parameters: secret ? { where: failure.where, message: text } : { where: failure.where, message: text, function: failure.name }
      });
      log.error("formula invalid: " + failure.where + ": " + text);
    } else if (formulaPolicy === "warn") {
      log.warn("formula function threw: " + failure.where + ": " + text);
    }
  }

  // A refused definition is judged by nothing else: the validators would read answers no
  // fold has settled.
  // Validators never see the delivered document: they judge `values`, and the document is the
  // host's record, named above. They are handed a deep-frozen copy of the values,
  // so a write to it changes nothing the run stores.
  // Built once, and only when a validator will run: a run without validators, or a refused one,
  // copies and freezes nothing.
  const validatorBound = refused || failedRules || tooDeepAt !== undefined || faultAt !== undefined || unsettledCalculations !== undefined ? 0 : validators.length;
  let validatorContext: (KernelValidatorContext & { document?: unknown }) | undefined;
  if (validatorBound > 0) {
    if (sharesDefinition && prepared !== undefined) {
      // The validators are handed `context.form`, which the prepared definition the cache holds
      // shares nodes with: cut it loose before they run, so nothing they do reaches a later run.
      kernelPreparedIsolate(prepared);
    }
    validatorContext = { ...context, values: kernelFrozenCopy(values), log } as KernelValidatorContext & { document?: unknown };
    delete validatorContext.document;
  }
  for (let index = 0; index < validatorBound; index += 1) {
    let result: ValidationResult;
    try {
      result = (validators[index] as KernelValidator)(validatorContext as KernelValidatorContext);
    } catch (thrownError) {
      // Fail closed: a validator that cannot answer blocks the submission, and the run still
      // says what it was sent (the digest, the log).
      errors.push({ code: "validator.failed", stage: "validation", source: "wasm", parameters: { validator: index + 1 } });
      log.error("validator " + (index + 1) + " threw: " + (thrownError instanceof Error ? thrownError.message : String(thrownError)));
      continue;
    }
    // A validator that answers nothing usable is no pass: the run
    // fails, as one that cannot run does, instead of ignoring the answer it never gave.
    // The answer is copied once and the copy is what is checked and used: a getter on `errors`
    // (or on an entry's `code`) answers once, so the list judged is the list that is kept.
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      // A promise is read as one whatever it answers on a second look.
      result = { then: function (): void {} } as unknown as ValidationResult;
    } else if (result !== null && typeof result === "object") {
      const listed = (result as { errors?: unknown }).errors;
      // Every level, by index and own key: a list subclass's `map` (`Symbol.species`) or a
      // parameter that holds itself never reaches what the run judges and writes.
      const copied = Array.isArray(listed) ? kernelValidatorErrorsCopy(listed) : listed;
      if (Array.isArray(listed) && copied === undefined) {
        throw new Error("validator " + (index + 1) + " returned errors nested past 32 levels, holding themselves or past 100,000 members");
      }
      result = { errors: copied } as ValidationResult;
    }
    const fault = kernelValidatorFault(result);
    if (fault !== undefined) {
      throw new Error("validator " + (index + 1) + " " + fault);
    }
    const folded = effective;
    const kept =
      folded !== undefined ? result.errors.filter((error) => kernelErrorPassesFold(error, folded)) : result.errors;
    // Only `warning` and `info` let a submission through; a severity nobody defined (a typo, a
    // number) is an error.
    for (const error of kept) {
      if (error.severity !== undefined && error.severity !== "error" && error.severity !== "warning" && error.severity !== "info") {
        errors.push({ ...error, severity: "error" });
      } else {
        errors.push(error);
      }
    }
    const dropped = result.errors.length - kept.length;
    log.debug(
      "validator " + (index + 1) + ": " + kept.length + " error(s)" + (dropped > 0 ? ", " + dropped + " on hidden components dropped" : ""),
      kept.length > 0 ? { errors: kept.map(brief) } : undefined
    );
  }

  const blocking = errors.some((error) => (error.severity ?? "error") === "error");
  const reported = errors.length;
  if (reported > kernelErrorCap()) {
    // Cut after the verdict: what was cut can have been the only blocking error, and the marker blocks as it did.
    errors.length = kernelErrorCap();
    errors.push({
      code: "errors.truncated",
      stage: "validation",
      source: "wasm",
      ...(blocking ? {} : { severity: "warning" as const }),
      parameters: { reported, shown: kernelErrorCap() }
    });
  }
  log.info(
    blocking
      ? "blocked: " + errors.length + " error(s)"
      : "accepted: " + errors.length + " error(s), " + Object.keys(values).length + " value(s)"
  );
  const logs = kernelFinishLog(log);
  const outcome: KernelOutcome = blocking ? { errors } : { errors, values };
  if (logs.length > 0) {
    outcome.logs = logs;
  }
  if (clientDerived.length > 0) {
    outcome.clientDerived = clientDerived;
  }
  if (pageComponentIds !== undefined) {
    outcome.pageComponentIds = pageComponentIds;
  }
  if (clockDependent.length > 0) {
    outcome.clockDependent = clockDependent;
  }
  if (serverRules.length > 0) {
    outcome.serverRules = serverRules;
  }
  if (visibilitySkipped.length > 0) {
    outcome.visibilitySkipped = visibilitySkipped;
  }
  if (outcome.values !== undefined) {
    outcome.index = kernelValueIndex(outcome.values);
  }
  // What a host would otherwise fold and partition again: present only when the context asks
  // (`reportFold`) and the fold ran. `withheld` is the
  // defined delivered keys the judged values leave out, in the delivered order; `effectiveState`
  // the components the error filter can act on; `submittable` the judged values of a run that
  // blocked (which carries no `values`); `trace` the journey's path.
  if (context.reportFold === true && effective !== undefined) {
    const judged = outcome.values !== undefined ? outcome.values : values;
    outcome.withheld = Object.keys(definedValues).filter(
      (key) => definedValues[key] !== undefined && !(Object.prototype.hasOwnProperty.call(judged, key) && judged[key] !== undefined)
    );
    const state: Record<string, EffectiveNodeState> = {};
    for (const id of Object.keys(effective)) {
      const node = effective[id] as EffectiveNodeState;
      if (!node.runValidation || !node.requiredApplies) {
        state[id] = node;
      }
    }
    if (Object.keys(state).length > 0) {
      outcome.effectiveState = state;
    }
    if (outcome.values === undefined) {
      outcome.submittable = { ...values };
    }
    if (foldTrace !== undefined) {
      outcome.trace = foldTrace;
    }
  }
  // The document as the host received it, judged or not: what it stores and signs receipts
  // over, named before the run began.
  if (named !== undefined) {
    outcome.canonical = named.canonical;
    outcome.digest = named.digest;
  }
  return outcome;
}

// --- Form tests: the server's reading ---------------------
//
// The kernel-shaped half of the form-test kernel driver (`form-test-kernel-driver.ts`), moved
// here so the sandbox's `test` op can run it: a module the kernel imports cannot import the
// kernel back, since the splice list below is built while this module loads.

/** The definition read once per driver: the compiled tree and the indexes every helper looks things up in. */
export interface FormTestServerIndex {
  order: string[];
  nodeById: Record<string, ComponentNode>;
  parentOf: Record<string, string>;
  /** Collection path -> `true`, for every repeating section (a data grid among them). */
  lists: Record<string, true>;
  /** Collection path -> the section's id. */
  collections: Record<string, string>;
  /** A row field's key shape (`items[].qty`) -> its id. */
  rowShapes: Record<string, string>;
  /** Value path -> the ids whose answer is stored there. */
  idsByPath: Record<string, string[]>;
  /** The ids of the row fields (the values of `rowShapes`), so a bare row key can be told from a field of the form. */
  entryFields: Record<string, true>;
}

/** The answers the driver holds: flat value-path keys, and each section's rows as row objects keyed within the row. */
export interface FormTestServerAnswers {
  flat: Record<string, unknown>;
  rows: Record<string, Array<Record<string, unknown>>>;
}

/** Where the scenario stands on its journey, as the runtime's journey state keeps it. */
export interface FormTestServerNavigation {
  page: string | undefined;
  completed: string[];
  /** The Check answers page a Change link left (`JourneyState.returnTo`), until it is reached or the person moves another way. */
  returnTo?: string | undefined;
}

/** The kernel's reading of the tree, built once: the compiled root's index, the row fields and the collections. */
export function kernelFormTestServerIndex(root: ComponentNode): FormTestServerIndex {
  const tree = kernelTreeIndex(root);
  const lists = kernelRowListPaths(root);
  const collections = kernelRecord() as Record<string, string>;
  for (const id of tree.order) {
    const node = kernelOwn(tree.nodeById, id);
    if (node === undefined || id === root.id) {
      continue;
    }
    const collection = kernelCollectionPathOf(node);
    if (collection !== undefined && kernelOwn(lists, collection) === true && kernelOwn(collections, collection) === undefined) {
      collections[collection] = id;
    }
  }
  const rowShapes = kernelRecord() as Record<string, string>;
  const entryFields = kernelRecord() as Record<string, true>;
  const rowFields = kernelRowFields(root);
  for (const id of Object.keys(rowFields)) {
    entryFields[id] = true;
    const field = rowFields[id] as { collection: string; suffix: string };
    const shape = field.collection + "[]" + field.suffix;
    if (kernelOwn(rowShapes, shape) === undefined) {
      rowShapes[shape] = id;
    }
  }
  return {
    order: tree.order,
    nodeById: tree.nodeById,
    parentOf: tree.parentOf,
    lists,
    collections,
    rowShapes,
    idsByPath: kernelComponentIdsByPath(root, kernelValuePaths(root)),
    entryFields
  };
}

/**
 * The component that owns a value path, as the kernel keys answers to components: a row
 * field's key by its shape (`items[0].qty` is `items[].qty`, the entry index taken out as
 * `kernelKeyShape` takes it), a collection path by its section, any other path by the first
 * component whose answer is stored there.
 */
export function kernelFormTestServerComponentIdOf(index: FormTestServerIndex, path: string): string | undefined {
  const shape = kernelKeyShape(path);
  if (shape !== undefined && shape !== path) {
    return kernelOwn(index.rowShapes, shape);
  }
  const section = kernelOwn(index.collections, path);
  if (section !== undefined) {
    return section;
  }
  const owners = kernelOwn(index.idsByPath, path);
  return owners !== undefined && owners.length > 0 ? owners[0] : undefined;
}

export function kernelFormTestServerAnswers(): FormTestServerAnswers {
  return { flat: kernelRecord() as Record<string, unknown>, rows: kernelRecord() as Record<string, Array<Record<string, unknown>>> };
}

/** A key written as an own data property, so a key spelled `__proto__` stays a key. */
export function kernelFormTestServerPut(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * A `given host.<name> = value` written into the host context the runs are given: a dotted name
 * nests (`host.org.unit` is `{ org: { unit } }`), a part that holds no record yet is made one,
 * as the browser's driver builds its runtime's context.
 */
export function kernelFormTestServerHostValue(into: Record<string, unknown>, name: string, value: FormTestValue): void {
  const parts = name.split(".");
  let cursor = into;
  for (let at = 0; at < parts.length - 1; at += 1) {
    const part = parts[at] as string;
    const next = kernelOwn(cursor, part);
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const made = kernelRecord() as Record<string, unknown>;
      kernelFormTestServerPut(cursor, part, made);
      cursor = made;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  kernelFormTestServerPut(cursor, parts[parts.length - 1] as string, value);
}

/**
 * An answer as the kernel reads a component of `type`: a list given to a `checkboxes` field is
 * the object of booleans that field stores, one per option as the renderer stores it
 * (`` over the options `a`, `b` is `{ a: true, b: false }`), since the kernel's shape check
 * refuses a list there; a picked value outside `offered` is ticked too. Everything
 * else as written, but for a lone checkbox's `"true"` and `"false"`, which are the booleans, as
 * the runtime's write stores them (`checkboxAnswer`, core/state/answer-shape.ts). `offered` is
 * the field's inline options, or what a `given options for` gave its source; absent, only the
 * picked values are stored.
 */
export function kernelFormTestServerAnswerFor(type: string | undefined, value: FormTestValue, offered?: string[]): unknown {
  if (type === "checkbox" && (value === "true" || value === "false")) {
    return value === "true";
  }
  if (type === "checkboxes" && Array.isArray(value)) {
    const picked = kernelRecord() as Record<string, unknown>;
    const chosen: string[] = [];
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number") {
        chosen.push(String(item));
      }
    }
    if (offered !== undefined) {
      for (const option of offered) {
        kernelFormTestServerPut(picked, option, chosen.indexOf(option) !== -1);
      }
    }
    for (const option of chosen) {
      kernelFormTestServerPut(picked, option, true);
    }
    // An ordinary object, as an answer arriving through JSON is.
    return Object.assign({}, picked);
  }
  return value;
}

/**
 * Whether a form test's `set` of `value` on a component of `type` is refused as `value.notScalar`:
 * a list written to a built-in type whose control holds one value (a text box, a text area, a
 * number or date control, a select, a radio group, a lone checkbox), which the runtime's write
 * refuses (`SCALAR_ANSWER_TYPES` in core/state/answer-shape.ts). A checkbox group, a file, a
 * plugin's type and an unknown path take the value as written.
 */
export function kernelFormTestServerNotScalar(type: string | undefined, value: FormTestValue): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  switch (type) {
    case "text":
    case "textarea":
    case "number":
    case "date":
    case "select":
    case "radio":
    case "checkbox":
      return true;
    default:
      return false;
  }
}

/**
 * The first cell of the row an `add row … with` would make (row `at` of `collection`) that
 * {@link kernelFormTestServerNotScalar} refuses, as its path (`items[2].sku`); `undefined` when
 * the row takes every cell. The runtime's add refuses such a cell as its write does, so the
 * drivers refuse the add before any row is made, as they refuse the `set`. `typeOf` is the type
 * of the component that owns a path, as each driver resolves it.
 */
export function kernelFormTestServerRowNotScalar(
  collection: string,
  at: number,
  values: Record<string, FormTestValue> | undefined,
  typeOf: (path: string) => string | undefined
): string | undefined {
  if (values === undefined) {
    return undefined;
  }
  const keys = Object.keys(values);
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k] as string;
    const path = collection + "[" + at + "]." + key;
    if (kernelFormTestServerNotScalar(typeOf(path), values[key] as FormTestValue)) {
      return path;
    }
  }
  return undefined;
}

/**
 * The options a `checkboxes` node offers a form test: the inline ones, or the ones a
 * `given options for` gave its source when `optionSnapshot` holds them; `undefined` for any other
 * node or a group with neither, so only the picked values are stored.
 */
export function kernelFormTestServerOffered(node: ComponentNode | undefined, optionSnapshot: unknown): string[] | undefined {
  if (node === undefined || node.type !== "checkboxes") {
    return undefined;
  }
  const choice = kernelOptionChoiceOf(node);
  const given =
    choice !== undefined && choice.sourceId !== undefined && optionSnapshot !== undefined && optionSnapshot !== null
      ? kernelOwn(optionSnapshot as Record<string, unknown>, choice.sourceId)
      : undefined;
  if (Array.isArray(given)) {
    const offered: string[] = [];
    for (let e = 0; e < given.length; e += 1) {
      offered.push(String((given[e] as { value?: unknown }).value));
    }
    return offered;
  }
  return choice !== undefined ? choice.options : undefined;
}

/**
 * The cells of the row an `add row … with` would make (row `at` of `collection`), each as the
 * control would store it: `answerFor` turns the cell at its path (`items[2].tags`) and the value
 * as written into the answer a `set` of that cell stores (a list on a checkbox group becomes the
 * group's record). The one place the add and the set agree on a cell, for every driver.
 */
export function kernelFormTestServerRowAnswers(
  collection: string,
  at: number,
  values: Record<string, FormTestValue> | undefined,
  answerFor: (path: string, value: FormTestValue) => unknown
): Record<string, unknown> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const answers = kernelRecord() as Record<string, unknown>;
  const keys = Object.keys(values);
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k] as string;
    const value = values[key] as FormTestValue;
    if (value !== undefined) {
      kernelFormTestServerPut(answers, key, answerFor(collection + "[" + at + "]." + key, value));
    }
  }
  return answers;
}

/** The rows of `collection`, made when it has none. */
export function kernelFormTestServerRowsOf(answers: FormTestServerAnswers, collection: string): Array<Record<string, unknown>> {
  const found = kernelOwn(answers.rows, collection);
  if (found !== undefined) {
    return found;
  }
  const made: Array<Record<string, unknown>> = [];
  answers.rows[collection] = made;
  return made;
}

/**
 * Writes an answer: a row field's into its row (rows up to the index made when absent, as the
 * runtime adds rows for a write past the last one), any other at its path. `undefined` clears.
 * False, with nothing written, for a row past those held at or past `limit` (the most rows the
 * collection takes, {@link kernelFormTestServerRowLimit}; absent, the cap every collection is
 * drawn to): a one-line step must not build more rows than a person could add, and never
 * hundreds of thousands. A caller that knows the grid's bound passes it and words the refusal.
 */
export function kernelFormTestServerWrite(answers: FormTestServerAnswers, lists: Record<string, true>, path: string, value: unknown, limit?: number): boolean {
  const parts = kernelRowKeyParts(path, lists);
  if (parts === undefined) {
    if (value === undefined) {
      delete answers.flat[path];
    } else {
      kernelFormTestServerPut(answers.flat, path, value);
    }
    return true;
  }
  const held = kernelOwn(answers.rows, parts.collection);
  const count = held === undefined ? 0 : held.length;
  const at = Number(parts.digits);
  if (value === undefined && at >= count) {
    return true;
  }
  if (at >= count && at >= (typeof limit === "number" ? limit : kernelDataGridRowsCap())) {
    return false;
  }
  const rows = kernelFormTestServerRowsOf(answers, parts.collection);
  while (rows.length <= at) {
    rows.push(kernelRecord() as Record<string, unknown>);
  }
  const row = rows[at] as Record<string, unknown>;
  if (value === undefined) {
    delete row[parts.rest];
  } else {
    kernelFormTestServerPut(row, parts.rest, value);
  }
  return true;
}

/** Adds a row at the end of `collection`, holding `values` keyed within the row. False when `collection` is no section's. */
export function kernelFormTestServerAddRow(
  answers: FormTestServerAnswers,
  lists: Record<string, true>,
  collection: string,
  values: Record<string, unknown> | undefined
): boolean {
  if (kernelOwn(lists, collection) !== true) {
    return false;
  }
  const row = kernelRecord() as Record<string, unknown>;
  if (values !== undefined) {
    for (const key of Object.keys(values)) {
      const value = values[key];
      if (value !== undefined) {
        kernelFormTestServerPut(row, key, value);
      }
    }
  }
  kernelFormTestServerRowsOf(answers, collection).push(row);
  return true;
}

/** Removes row `index` of `collection`, the later rows moving up as the runtime's do. False when there is no such row. */
export function kernelFormTestServerRemoveRow(answers: FormTestServerAnswers, lists: Record<string, true>, collection: string, index: number): boolean {
  if (kernelOwn(lists, collection) !== true) {
    return false;
  }
  const rows = kernelOwn(answers.rows, collection);
  if (rows === undefined || index < 0 || index >= rows.length) {
    return false;
  }
  rows.splice(index, 1);
  return true;
}

/**
 * The rows a data grid opens with, as `dataGridSettingsOf` reads them: `initialRows`
 * (one when absent or unusable) kept within the grid's bounds. Any other component opens with
 * none. The runtime seeds these before the first run, so a scenario's first row count is theirs.
 */
export function kernelFormTestServerInitialRows(node: ComponentNode): number {
  if (node.type !== "dataGrid") {
    return 0;
  }
  const bounds = kernelDataGridRowBounds(node);
  const configured = kernelOwn(kernelConfigurationOf(node), "initialRows");
  let initial = 1;
  if (typeof configured === "number" && isFinite(configured) && configured >= 0) {
    initial = Math.floor(configured);
    if (initial > kernelDataGridRowsCap()) {
      initial = kernelDataGridRowsCap();
    }
  }
  if (initial < bounds.min) {
    initial = bounds.min;
  }
  if (bounds.max !== undefined && initial > bounds.max) {
    initial = bounds.max;
  }
  return initial;
}

/** Gives every data grid its opening rows, each empty (posted as `{}`, which the kernel counts as a row). */
export function kernelFormTestServerSeedRows(answers: FormTestServerAnswers, index: FormTestServerIndex): void {
  for (const collection of Object.keys(index.collections)) {
    const id = kernelOwn(index.collections, collection);
    const node = id === undefined ? undefined : kernelOwn(index.nodeById, id);
    if (node === undefined || kernelOwn(answers.rows, collection) !== undefined) {
      continue;
    }
    const initial = kernelFormTestServerInitialRows(node);
    if (initial > 0) {
      const rows = kernelFormTestServerRowsOf(answers, collection);
      for (let at = 0; at < initial; at += 1) {
        rows.push(kernelRecord() as Record<string, unknown>);
      }
    }
  }
}

/**
 * The most rows a collection may hold: a data grid's maximum, else the cap every collection is
 * drawn to (as `assertRowRoom`). A grid's `rules.maxRows` formula, once evaluated over the
 * current answers (`rowBounds`, the fold's), overrules the fixed bound as `checkRows` has it
 * (`kernelResolveDataGridRowBounds`): the browser's add reads the resolved bound too.
 */
export function kernelFormTestServerRowLimit(
  index: FormTestServerIndex,
  collection: string,
  rowBounds?: Record<string, { min?: unknown; max?: unknown }>
): number {
  const id = kernelOwn(index.collections, collection);
  const node = id === undefined ? undefined : kernelOwn(index.nodeById, id);
  if (node !== undefined && node.type === "dataGrid") {
    const formula = rowBounds !== undefined && id !== undefined ? kernelOwn(rowBounds, id) : undefined;
    const max = kernelResolveDataGridRowBounds(kernelDataGridRowBounds(node), formula).max;
    if (max !== undefined) {
      return max;
    }
  }
  return kernelDataGridRowsCap();
}

/** Whether one more row fits in `collection`. A path that is no collection has room: the add itself refuses it. */
export function kernelFormTestServerRowRoom(
  answers: FormTestServerAnswers,
  index: FormTestServerIndex,
  collection: string,
  rowBounds?: Record<string, { min?: unknown; max?: unknown }>
): boolean {
  if (kernelOwn(index.lists, collection) !== true) {
    return true;
  }
  const held = kernelOwn(answers.rows, collection);
  return (held === undefined ? 0 : held.length) < kernelFormTestServerRowLimit(index, collection, rowBounds);
}

/**
 * Whether the section at `collection` lets a person add (or remove) rows, as the runtime reads
 * its row operations: a data grid's `canAdd` / `canRemove` (on unless `false`), any other
 * repeating section's `collection.operations.add` / `.remove` (on unless `false`).
 */
export function kernelFormTestServerAllows(index: FormTestServerIndex, collection: string, operation: "add" | "remove"): boolean {
  const id = kernelOwn(index.collections, collection);
  const node = id === undefined ? undefined : kernelOwn(index.nodeById, id);
  if (node === undefined) {
    return true;
  }
  if (node.type === "dataGrid") {
    return kernelOwn(kernelConfigurationOf(node), operation === "add" ? "canAdd" : "canRemove") !== false;
  }
  const binding = node.collection;
  const operations = binding !== undefined && binding !== null ? binding.operations : undefined;
  return operations === undefined || operations === null || kernelOwn(operations as Record<string, unknown>, operation) !== false;
}

/**
 * Why a row action is turned down, as the refusal the runner records (`refused` is the reason,
 * `params` what it is about), or `undefined` when the action may go ahead. The reasons and
 * their order are the runtime's: the path must be a repeating section's collection
 * (`unknownCollection`), then the operation allowed (`operations.add` / `operations.remove`),
 * then, adding, the most rows not passed (`rows.max`), or, removing, the row there
 * (`rowOutOfRange`). `rowIndex` is the row a removal names.
 */
export function kernelFormTestServerRowRefusal(
  answers: FormTestServerAnswers,
  index: FormTestServerIndex,
  collection: string,
  operation: "add" | "remove",
  rowIndex: number,
  rowBounds?: Record<string, { min?: unknown; max?: unknown }>
): { refused: string; params: Record<string, unknown> } | undefined {
  const params = kernelRecord() as Record<string, unknown>;
  params.path = collection;
  if (kernelOwn(index.lists, collection) !== true) {
    return { refused: "unknownCollection", params };
  }
  if (!kernelFormTestServerAllows(index, collection, operation)) {
    return { refused: operation === "add" ? "operations.add" : "operations.remove", params };
  }
  if (operation === "add") {
    if (!kernelFormTestServerRowRoom(answers, index, collection, rowBounds)) {
      params.max = kernelFormTestServerRowLimit(index, collection, rowBounds);
      return { refused: "rows.max", params };
    }
    return undefined;
  }
  const held = kernelOwn(answers.rows, collection);
  const count = held === undefined ? 0 : held.length;
  if (rowIndex < 0 || rowIndex >= count) {
    params.index = rowIndex;
    params.count = count;
    return { refused: "rowOutOfRange", params };
  }
  return undefined;
}

/**
 * The page a refused submit takes the person to (the runtime's `revealErrorPage`): the earliest
 * page on the path that places a component holding an error that blocks, an error placed by its
 * component, else by its value path's. `undefined` when no such page stands on the path (an
 * error on no page, off the path or the form's own moves nothing).
 */
export function kernelFormTestServerRevealPage(
  errors: WasmValidationError[],
  index: FormTestServerIndex,
  pagesOf: Record<string, string[]> | undefined,
  trace: JourneyTrace | undefined
): string | undefined {
  if (pagesOf === undefined || trace === undefined || trace.pages.length === 0) {
    return undefined;
  }
  let earliest = -1;
  for (const error of errors) {
    if (!kernelFormTestServerBlocking(error)) {
      continue;
    }
    const id = error.componentId !== undefined ? error.componentId : error.path !== undefined ? kernelFormTestServerComponentIdOf(index, error.path) : undefined;
    const owners = id === undefined ? undefined : kernelOwn(pagesOf, id);
    if (owners === undefined) {
      continue;
    }
    for (const pageId of owners) {
      const at = trace.pages.indexOf(pageId);
      if (at >= 0 && (earliest < 0 || at < earliest)) {
        earliest = at;
      }
    }
  }
  return earliest >= 0 ? trace.pages[earliest] : undefined;
}

/**
 * Whether the page shown is a review page (`kind: "review"`) the path takes: a send refused there
 * stays there (the runtime's `revealErrorPage`), so the page lists the errors itself.
 */
export function kernelFormTestServerOnReview(journey: Journey | undefined, pageId: string | undefined, trace: JourneyTrace | undefined): boolean {
  const page = kernelFormTestServerPage(journey, pageId);
  return page !== undefined && page.kind === "review" && trace !== undefined && trace.pages.indexOf(page.id) >= 0;
}

/**
 * The values a run is handed: every flat answer, and each section with rows as its list of row
 * objects at its collection path (each an ordinary object, as JSON builds them). A section with
 * no rows sends nothing, which is no rows.
 */
export function kernelFormTestServerValues(answers: FormTestServerAnswers): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(answers.flat)) {
    kernelFormTestServerPut(values, key, answers.flat[key]);
  }
  for (const collection of Object.keys(answers.rows)) {
    const rows = answers.rows[collection] as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      continue;
    }
    const list: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const plain: Record<string, unknown> = {};
      for (const key of Object.keys(row)) {
        kernelFormTestServerPut(plain, key, row[key]);
      }
      list.push(plain);
    }
    kernelFormTestServerPut(values, collection, list);
  }
  return values;
}

/** Row counts by collection path, every section of the form listed (none is `0`). */
export function kernelFormTestServerRowCounts(answers: FormTestServerAnswers, lists: Record<string, true>): Record<string, number> {
  const counts = kernelRecord() as Record<string, number>;
  for (const collection of Object.keys(lists)) {
    const rows = kernelOwn(answers.rows, collection);
    counts[collection] = rows === undefined ? 0 : rows.length;
  }
  return counts;
}

/** Whether an error stops a move or a submission: one with no severity, or `error`. */
export function kernelFormTestServerBlocking(error: { severity?: string | undefined }): boolean {
  return error.severity === undefined || error.severity === "error";
}

export function kernelFormTestServerAnyBlocking(errors: ReadonlyArray<{ severity?: string | undefined }>): boolean {
  for (const error of errors) {
    if (kernelFormTestServerBlocking(error)) {
      return true;
    }
  }
  return false;
}

/**
 * A page's check, kept to the page: the errors on the components the kernel places
 * on it (`pageComponentIds`), and those on no component bar `journey.exit` (the exit is the
 * path's verdict, not the page's). `undefined` ids (a program that cannot scope) keep every error.
 */
export function kernelFormTestServerPageErrors(errors: WasmValidationError[], pageComponentIds: string[] | undefined): WasmValidationError[] {
  if (pageComponentIds === undefined) {
    return errors;
  }
  const scoped: WasmValidationError[] = [];
  for (const error of errors) {
    if (error.componentId !== undefined ? pageComponentIds.indexOf(error.componentId) >= 0 : error.code !== "journey.exit") {
      scoped.push(error);
    }
  }
  return scoped;
}

/**
 * The errors on show once a page's check comes back: those it found replace whatever stood on
 * the page's components and on no component, as the runtime's page validation replaces the
 * errors within the page; the rest stand.
 */
export function kernelFormTestServerKeepShown(
  shown: WasmValidationError[],
  found: WasmValidationError[],
  pageComponentIds: string[] | undefined
): WasmValidationError[] {
  if (pageComponentIds === undefined) {
    return found;
  }
  const kept: WasmValidationError[] = [];
  for (const error of shown) {
    if (error.componentId !== undefined && pageComponentIds.indexOf(error.componentId) < 0) {
      kept.push(error);
    }
  }
  for (const error of found) {
    kept.push(error);
  }
  return kept;
}

/** Whether a blocking error on show stands on one of `componentIds`: what a deferred page's Continue reads. */
export function kernelFormTestServerShownBlocks(shown: WasmValidationError[], componentIds: string[] | undefined): boolean {
  if (componentIds === undefined) {
    return false;
  }
  for (const error of shown) {
    if (error.componentId !== undefined && componentIds.indexOf(error.componentId) >= 0 && kernelFormTestServerBlocking(error)) {
      return true;
    }
  }
  return false;
}

/**
 * The journey a scenario runs, as the runtime selects it (`resolveJourneySelection`): `none`
 * is the whole form; an id names one of the definition's journeys or is refused
 * (`scenario.unknownJourney`); absent, the definition's own choice (`defaultJourneyId`,
 * then the first; `opensAs` is the host's page choice and does not stop a test). The journey is returned as authored: the kernel
 * compiles it.
 */
export function kernelFormTestServerSelectJourney(
  configuration: unknown,
  given: string | undefined
): { journey: Journey | undefined; error?: FormTestStartError } {
  const journeys: Journey[] = [];
  let defaultId: string | undefined;
  if (configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)) {
    const listed: unknown = kernelOwn(configuration as Record<string, unknown>, "journeys");
    if (Array.isArray(listed)) {
      // Only a journey of a usable shape counts, as the runtime's `readJourneys` drops the
      // rest: a malformed first entry is not the default, and a malformed one named is unknown.
      for (const entry of listed) {
        if (kernelIsJourney(entry)) {
          journeys.push(entry);
        }
      }
    }
    const named: unknown = kernelOwn(configuration as Record<string, unknown>, "defaultJourneyId");
    if (typeof named === "string" && named !== "") {
      defaultId = named;
    }
  }
  if (given === "none") {
    return { journey: undefined };
  }
  if (given !== undefined) {
    for (const journey of journeys) {
      if (journey.id === given) {
        return { journey };
      }
    }
    return { journey: undefined, error: "scenario.unknownJourney" };
  }
  // A form that `opensAs` a form still has its default journey for a test: the scenario walks
  // pages, and `given journey = none` is how it asks for the whole form.
  if (journeys.length === 0) {
    return { journey: undefined };
  }
  if (defaultId !== undefined) {
    for (const journey of journeys) {
      if (journey.id === defaultId) {
        return { journey };
      }
    }
  }
  return { journey: journeys[0] };
}

/** The page ids of a journey in its declared order. */
export function kernelFormTestServerPageOrder(journey: Journey | undefined): string[] {
  const order: string[] = [];
  if (journey === undefined || !Array.isArray(journey.pages)) {
    return order;
  }
  for (const page of journey.pages) {
    if (page !== null && typeof page === "object" && typeof page.id === "string") {
      order.push(page.id);
    }
  }
  return order;
}

/** A page of the journey by id, as authored. */
export function kernelFormTestServerPage(journey: Journey | undefined, pageId: string | undefined): Journey["pages"][number] | undefined {
  if (journey === undefined || pageId === undefined || !Array.isArray(journey.pages)) {
    return undefined;
  }
  for (const page of journey.pages) {
    if (page !== null && typeof page === "object" && page.id === pageId) {
      return page;
    }
  }
  return undefined;
}

/** Whether Continue on `page` moves on unchecked (`validation.continue: "defer"`, the page's own over the journey's). */
export function kernelFormTestServerDeferred(journey: Journey | undefined, page: Journey["pages"][number] | undefined): boolean {
  const own = page !== undefined && page.validation !== undefined && page.validation !== null ? page.validation.continue : undefined;
  if (own === "defer" || own === "page") {
    return own === "defer";
  }
  const settings = journey !== undefined && journey.validation !== undefined && journey.validation !== null ? journey.validation.continue : undefined;
  return settings !== "page";
}

/**
 * After the answers moved: completed pages kept to the path, and a page the path no longer
 * takes giving way to the last page before it (in the journey's order) that it does take,
 * else its first page — the runtime's `reconcile`. A journey with no page on the path keeps
 * where it stands.
 */
export function kernelFormTestServerReconcile(navigation: FormTestServerNavigation, trace: JourneyTrace | undefined, order: string[]): void {
  if (trace === undefined) {
    return;
  }
  const kept: string[] = [];
  for (const pageId of navigation.completed) {
    if (trace.pages.indexOf(pageId) >= 0) {
      kept.push(pageId);
    }
  }
  navigation.completed = kept;
  // A Change link's return target goes once the path no longer takes the page it names.
  if (navigation.returnTo !== undefined && trace.pages.indexOf(navigation.returnTo) < 0) {
    navigation.returnTo = undefined;
  }
  if (trace.pages.length === 0) {
    return;
  }
  if (navigation.page === undefined) {
    navigation.page = trace.pages[0];
    return;
  }
  if (trace.pages.indexOf(navigation.page) >= 0) {
    return;
  }
  navigation.returnTo = undefined;
  const at = order.indexOf(navigation.page);
  let target = trace.pages[0];
  for (const pageId of trace.pages) {
    if (order.indexOf(pageId) < at) {
      target = pageId;
    }
  }
  navigation.page = target;
}

/** Where Continue goes from `page` when nothing blocks: the next page on the path, else nowhere (the last page submits, an exit page stops). */
export function kernelFormTestServerNextPage(trace: JourneyTrace | undefined, page: string | undefined): string | undefined {
  if (trace === undefined || page === undefined) {
    return undefined;
  }
  const at = trace.pages.indexOf(page);
  return at >= 0 && at + 1 < trace.pages.length ? trace.pages[at + 1] : undefined;
}

/** Where Back goes: the page before on the path, else nowhere. */
export function kernelFormTestServerBackPage(trace: JourneyTrace | undefined, page: string | undefined): string | undefined {
  if (trace === undefined || page === undefined) {
    return undefined;
  }
  const at = trace.pages.indexOf(page);
  return at > 0 ? trace.pages[at - 1] : undefined;
}

/** Marks a page completed, once. */
export function kernelFormTestServerComplete(navigation: FormTestServerNavigation, page: string): void {
  if (navigation.completed.indexOf(page) < 0) {
    navigation.completed.push(page);
  }
}

/**
 * Where Continue goes from the page a Change link opened, and Back from one completed before the
 * Change (the runtime's `journeyReturning`): the first page on the path not completed (the page
 * shown left out), else the Check answers page. `undefined` when no return holds: none recorded,
 * the page shown is the review page, or the path no longer takes a review page by that id.
 */
export function kernelFormTestServerReturning(journey: Journey | undefined, trace: JourneyTrace | undefined, navigation: FormTestServerNavigation): string | undefined {
  const returnTo = navigation.returnTo;
  if (returnTo === undefined || trace === undefined || navigation.page === undefined || returnTo === navigation.page || trace.pages.indexOf(returnTo) < 0) {
    return undefined;
  }
  const review = kernelFormTestServerPage(journey, returnTo);
  if (review === undefined || review.kind !== "review") {
    return undefined;
  }
  for (const pageId of trace.pages) {
    if (pageId !== navigation.page && navigation.completed.indexOf(pageId) < 0) {
      return pageId;
    }
  }
  return returnTo;
}

/** Shows `target`: the return target of a Change link goes with any move but one that keeps it, and on reaching the review page. */
export function kernelFormTestServerMove(navigation: FormTestServerNavigation, target: string, keepReturn: boolean): void {
  // No move to the page shown, as the runtime's movePage: a Change link's return survives it
  // (a refused send that reveals the asking step the person is on).
  if (navigation.page === target) {
    return;
  }
  if (navigation.returnTo !== undefined && (!keepReturn || navigation.returnTo === target)) {
    navigation.returnTo = undefined;
  }
  navigation.page = target;
}

/** The earliest page on the path that holds the component (the runtime's `view.pageOf`), else nowhere. */
export function kernelFormTestServerPageOf(pagesOf: Record<string, string[]> | undefined, trace: JourneyTrace | undefined, id: string | undefined): string | undefined {
  const owners = pagesOf === undefined || id === undefined ? undefined : kernelOwn(pagesOf, id);
  if (owners === undefined || trace === undefined) {
    return undefined;
  }
  for (const pageId of trace.pages) {
    if (owners.indexOf(pageId) >= 0) {
      return pageId;
    }
  }
  return undefined;
}

/**
 * A Change link of the Check answers page the scenario stands on (`change <path>`, with `id` the
 * component the path names): opens the step that asks it and records the return, or answers the
 * coded refusal the runtime driver gives for the same case.
 */
export function kernelFormTestServerChange(
  journey: Journey | undefined,
  navigation: FormTestServerNavigation,
  trace: JourneyTrace | undefined,
  pagesOf: Record<string, string[]> | undefined,
  id: string | undefined,
  path: string
): { refused: string; params?: Record<string, unknown> } | undefined {
  const page = kernelFormTestServerPage(journey, navigation.page);
  if (page === undefined || page.kind !== "review" || trace === undefined || trace.pages.indexOf(page.id) < 0) {
    return { refused: "change.notReview", params: { path } };
  }
  const review = page.review;
  if (review !== undefined && review !== null && review.change === false) {
    return { refused: "change.off", params: { path } };
  }
  const target = kernelFormTestServerPageOf(pagesOf, trace, id);
  if (target === undefined) {
    return { refused: "change.notListed", params: { path } };
  }
  if (navigation.completed.indexOf(target) < 0 && !journeyReachable(trace, navigation.completed, target)) {
    return { refused: "change.unreachable", params: { path, page: target } };
  }
  navigation.returnTo = page.id;
  navigation.page = target;
  return undefined;
}

/**
 * The run's answers as the kernel's fold reads them: the allowlist's known keys (or, under
 * `keep`, the rows flattened and everything else kept), as `runKernel` partitions them before
 * it folds.
 */
export function kernelFormTestServerFoldValues(
  prepared: KernelPrepared,
  values: Record<string, unknown>,
  unknownFields: WasmUnknownFieldsMode | undefined
): Record<string, unknown> {
  if (unknownFields === "keep") {
    return kernelFlattenRows(values, prepared.root, prepared).values;
  }
  return kernelPartitionValues(values, prepared.root, prepared).known;
}

/**
 * The evaluation a run builds for its rules (`runKernel`): the day, the host context the
 * scenario's `host.` givens make (absent when it gives none, so a rule reading `host.` is
 * skipped as on a server with no context), the plugins' functions, the shared pattern cache
 * refusing risky patterns.
 */
export function kernelFormTestServerEvaluation(
  prepared: KernelPrepared,
  today: string | undefined,
  functions: Record<string, (args: unknown[]) => unknown> | undefined,
  hostContext?: Record<string, unknown>
): KernelEvaluation {
  const evaluation: KernelEvaluation = { regexCache: { refuseRisky: true } };
  if (today !== undefined) {
    evaluation.today = today;
  }
  if (hostContext !== undefined) {
    evaluation.hostContext = hostContext;
  }
  if (functions !== undefined) {
    evaluation.functions = functions;
  }
  if (prepared.unparsedCalculations.length > 0) {
    evaluation.unparsedCalculations = prepared.unparsedCalculations;
  }
  return evaluation;
}

/**
 * Each component's requiredness after the hidden-required policy: the fold's `required` (its
 * flag or its `requiredWhen`, relaxed where the server cannot replay a visibility) where the
 * effective state lets requiredness apply.
 */
export function kernelFormTestServerRequired(fold: KernelSubmissionFold, effective: Record<string, EffectiveNodeState>): Record<string, boolean> {
  const required = kernelRecord() as Record<string, boolean>;
  for (const id of Object.keys(fold.required)) {
    const state = kernelOwn(effective, id);
    required[id] = fold.required[id] === true && state !== undefined && state.requiredApplies === true;
  }
  return required;
}

/**
 * The effective state of every component: the fold's, with the outcome's `effectiveState` laid
 * over it where the outcome lists a component (the run's own word). The outcome lists
 * only the components whose errors the hidden policy can drop, so the rest come from the fold.
 */
export function kernelFormTestServerEffective(
  fold: KernelSubmissionFold,
  reported: Record<string, EffectiveNodeState> | undefined
): Record<string, EffectiveNodeState> {
  const effective = kernelRecord() as Record<string, EffectiveNodeState>;
  for (const id of Object.keys(fold.effective)) {
    effective[id] = fold.effective[id] as EffectiveNodeState;
  }
  if (reported !== undefined) {
    for (const id of Object.keys(reported)) {
      effective[id] = reported[id] as EffectiveNodeState;
    }
  }
  return effective;
}

/**
 * The skip reason a rule this side leaves unevaluated earns: `host.` when it reads the host
 * context (whatever its scope) and the scenario gave no `host.` value (`hostKnown` false),
 * `browser` when it is scoped to the browser, else the clock when no day was given. A rule
 * that is none of those is `host`, the reason nothing else fits.
 */
export function kernelFormTestServerSkipReason(source: unknown, expression: Expression, today: string | undefined, hostKnown?: boolean): FormTestSkipReason {
  if (hostKnown !== true && kernelExprReadsHost(expression)) {
    return "unreplayable.host";
  }
  if (kernelRuleRun(source) === "browser") {
    return "unreplayable.browser";
  }
  return today === undefined && kernelExprReadsClock(expression) ? "unreplayable.clock" : "unreplayable.host";
}

/** `reasons[id] = reason` unless a reason stands there; a secret one always wins. True when the record changed. */
export function kernelFormTestServerMark(reasons: Record<string, FormTestSkipReason>, id: string, reason: FormTestSkipReason): boolean {
  const standing = kernelOwn(reasons, id);
  if (standing === undefined || (reason === "unreplayable.secret" && standing !== reason)) {
    reasons[id] = reason;
    return true;
  }
  return false;
}

/**
 * The component a rule's read names, for the closure over reads: the read is an id (a scope
 * word, `row.` or `ancestor.`, taken off), else a value path some component stores. A `host.`
 * read is no component.
 */
export function kernelFormTestServerReadId(index: FormTestServerIndex, path: string): string | undefined {
  if (path.indexOf("host.") === 0) {
    return undefined;
  }
  let name = path;
  if (name.indexOf("row.") === 0) {
    name = name.slice(4);
  } else if (name.indexOf("ancestor.") === 0) {
    name = name.slice(9);
  }
  if (kernelOwn(index.nodeById, name) !== undefined) {
    return name;
  }
  return kernelFormTestServerComponentIdOf(index, name);
}

/** Marks every component under `id` with `reason`; true when any mark was new. */
export function kernelFormTestServerMarkUnder(
  index: FormTestServerIndex,
  reasons: Record<string, FormTestSkipReason>,
  id: string,
  reason: FormTestSkipReason
): boolean {
  let changed = false;
  for (const other of index.order) {
    let parent = kernelOwn(index.parentOf, other);
    while (parent !== undefined) {
      if (parent === id) {
        if (kernelFormTestServerMark(reasons, other, reason)) {
          changed = true;
        }
        break;
      }
      parent = kernelOwn(index.parentOf, parent);
    }
  }
  return changed;
}

/**
 * Closes the marks over rule reads: a component whose rule reads a marked component is judged
 * on data this side does not have either, so it earns the same reason (a `visibleWhen` read
 * takes its descendants with it, as an own skipped visibility does). Repeated until nothing new
 * is marked, bounded by the number of components.
 */
export function kernelFormTestServerCloseReads(index: FormTestServerIndex, reasons: Record<string, FormTestSkipReason>): void {
  const keys = ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen", "validWhen", "value"];
  for (let pass = 0; pass <= index.order.length; pass += 1) {
    let changed = false;
    for (const id of index.order) {
      const node = kernelOwn(index.nodeById, id);
      if (node === undefined || !node.rules) {
        continue;
      }
      for (const key of keys) {
        const source = kernelOwn(node.rules as Record<string, unknown>, key);
        const expression = source ? kernelCompiledRule(source) : undefined;
        if (expression === undefined) {
          continue;
        }
        let reason: FormTestSkipReason | undefined;
        for (const path of kernelExprReadPaths(expression)) {
          const read = kernelFormTestServerReadId(index, path);
          reason = read === undefined || read === id ? undefined : kernelOwn(reasons, read);
          if (reason !== undefined) {
            break;
          }
        }
        if (reason === undefined) {
          continue;
        }
        if (kernelFormTestServerMark(reasons, id, reason)) {
          changed = true;
        }
        if (key === "visibleWhen" && kernelFormTestServerMarkUnder(index, reasons, id, reason)) {
          changed = true;
        }
      }
    }
    if (!changed) {
      return;
    }
  }
}

/** The reason of the first marked component a rule source reads (a route's `when`), else `undefined`. */
export function kernelFormTestServerReadsReason(
  source: unknown,
  index: FormTestServerIndex,
  reasons: Record<string, FormTestSkipReason>
): FormTestSkipReason | undefined {
  const expression = source === undefined ? undefined : kernelCompiledRule(source);
  if (expression === undefined) {
    return undefined;
  }
  for (const path of kernelExprReadPaths(expression)) {
    const read = kernelFormTestServerReadId(index, path);
    const reason = read === undefined ? undefined : kernelOwn(reasons, read);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

/**
 * Marks what a journey's path decides over a component this side could not replay. A route that
 * reads a marked component decides which page follows, so every later page is marked. Returns the first reason found, which is also the reason the path itself
 * is not this side's (`traceUnreplayable`: the page, the path, what was withheld or submitted),
 * or `undefined` when no journey runs or no condition reads a marked component.
 */
export function kernelFormTestServerMarkTrace(
  journey: Journey | undefined,
  index: FormTestServerIndex,
  ownership: JourneyOwnership | undefined,
  reasons: Record<string, FormTestSkipReason>
): FormTestSkipReason | undefined {
  if (journey === undefined || !Array.isArray(journey.pages)) {
    return undefined;
  }
  let first: FormTestSkipReason | undefined;
  for (let at = 0; at < journey.pages.length; at += 1) {
    const page = journey.pages[at];
    if (page === null || typeof page !== "object") {
      continue;
    }
    let routed: FormTestSkipReason | undefined;
    if (Array.isArray(page.routes)) {
      for (const route of page.routes) {
        const found = route !== null && typeof route === "object" ? kernelFormTestServerReadsReason(route.when, index, reasons) : undefined;
        if (found !== undefined && routed === undefined) {
          routed = found;
        }
      }
    }
    if (routed !== undefined) {
      first = first === undefined ? routed : first;
      for (let later = at + 1; later < journey.pages.length; later += 1) {
        const next = journey.pages[later];
        if (next !== null && typeof next === "object") {
          kernelFormTestServerMarkPage(ownership, next.id, routed, reasons);
        }
      }
    }
  }
  return first;
}

/** Marks the components a page places with `reason`. */
export function kernelFormTestServerMarkPage(
  ownership: JourneyOwnership | undefined,
  pageId: string,
  reason: FormTestSkipReason,
  reasons: Record<string, FormTestSkipReason>
): void {
  if (ownership === undefined) {
    return;
  }
  for (const id of kernelPageComponentIds(ownership, pageId)) {
    kernelFormTestServerMark(reasons, id, reason);
  }
}

/** Whether a component can decide a verdict: it is required, or has a `requiredWhen` or a `validWhen` that could refuse its answer. */
export function kernelFormTestServerCanRefuse(node: ComponentNode): boolean {
  if (kernelOwn(kernelConfigurationOf(node), "required") === true) {
    return true;
  }
  if (node.rules === undefined || node.rules === null) {
    return false;
  }
  const rules = node.rules as Record<string, unknown>;
  return kernelOwn(rules, "requiredWhen") !== undefined || kernelOwn(rules, "validWhen") !== undefined;
}

/**
 * The components whose rules this side could not replay, with the reason an expectation on
 * them skips. From the outcome: `visibilitySkipped` (an own `visibleWhen` reading `host.`,
 * scoped to the browser, or reading the clock with no day; the components under it inherit
 * the reason, since the kernel relaxes their requiredness with it), `clockDependent` when no
 * day was given, `clientDerived` (a calculation kept as sent, which the server could not
 * reproduce), and `serverRules` for a component whose applied rule is `server-secret`
 * (`unreplayable.secret`: no driver may judge it). The outcome names no
 * component whose `requiredWhen`, `validWhen`, `enabledWhen` or `readonlyWhen` it skipped, so
 * those are read from the compiled definition with the kernel's own `kernelRuleSkipped`.
 * `hostKnown`: the run was given a host context (the scenario's `host.` givens), so a rule
 * reading `host.` was evaluated against it and earns no mark of its own.
 */
export function kernelFormTestServerUnreplayable(
  index: FormTestServerIndex,
  outcome: WasmSubmissionOutcome,
  today: string | undefined,
  hostKnown?: boolean
): Record<string, FormTestSkipReason> {
  const reasons = kernelRecord() as Record<string, FormTestSkipReason>;
  const keys = ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen", "validWhen", "value"];
  const serverRules = outcome.serverRules !== undefined ? outcome.serverRules : [];
  for (const id of index.order) {
    const node = kernelOwn(index.nodeById, id);
    if (node === undefined || !node.rules) {
      continue;
    }
    for (const key of keys) {
      const source = kernelOwn(node.rules as Record<string, unknown>, key);
      const expression = source ? kernelCompiledRule(source) : undefined;
      if (expression === undefined) {
        continue;
      }
      if (kernelRuleRun(source) === "server-secret" && serverRules.indexOf(id) >= 0) {
        kernelFormTestServerMark(reasons, id, "unreplayable.secret");
      } else if (kernelRuleSkipped(source, expression, key, "server", today, hostKnown)) {
        kernelFormTestServerMark(reasons, id, kernelFormTestServerSkipReason(source, expression, today, hostKnown));
      }
    }
  }
  const skipped = outcome.visibilitySkipped !== undefined ? outcome.visibilitySkipped : [];
  for (const id of skipped) {
    const node = kernelOwn(index.nodeById, id);
    const source = node !== undefined && node.rules ? kernelOwn(node.rules as Record<string, unknown>, "visibleWhen") : undefined;
    const expression = source ? kernelCompiledRule(source) : undefined;
    kernelFormTestServerMark(reasons, id, expression !== undefined ? kernelFormTestServerSkipReason(source, expression, today, hostKnown) : "unreplayable.host");
  }
  // The components under a visibility the server could not replay: their requiredness is
  // relaxed with it (`kernelFoldRelaxUnreplayable`), so no expectation on them is this side's.
  if (skipped.length > 0) {
    for (const id of index.order) {
      let parent = kernelOwn(index.parentOf, id);
      while (parent !== undefined) {
        if (skipped.indexOf(parent) >= 0) {
          kernelFormTestServerMark(reasons, id, kernelOwn(reasons, parent) as FormTestSkipReason);
          break;
        }
        parent = kernelOwn(index.parentOf, parent);
      }
    }
  }
  if (today === undefined && outcome.clockDependent !== undefined) {
    for (const id of outcome.clockDependent) {
      if (kernelOwn(index.nodeById, id) !== undefined) {
        kernelFormTestServerMark(reasons, id, "unreplayable.clock");
      }
    }
  }
  if (outcome.clientDerived !== undefined) {
    for (const path of outcome.clientDerived) {
      // Kept as sent, so not reproduced here: a calculation reading `host.` with no host
      // context, or scoped to the browser, or reading an answer the server was not sent (one the
      // clock decides is marked above). The first two keep the reason their rule earns; the last
      // is `clientDerived`.
      const id = kernelFormTestServerComponentIdOf(index, path);
      if (id !== undefined) {
        const node = kernelOwn(index.nodeById, id);
        const source = node !== undefined && node.rules ? kernelOwn(node.rules as Record<string, unknown>, "value") : undefined;
        const expression = source ? kernelCompiledRule(source) : undefined;
        let reason: FormTestSkipReason = "unreplayable.clientDerived";
        if (hostKnown !== true && expression !== undefined && kernelExprReadsHost(expression)) {
          reason = "unreplayable.host";
        } else if (source !== undefined && kernelRuleRun(source) === "browser") {
          reason = "unreplayable.browser";
        }
        kernelFormTestServerMark(reasons, id, reason);
      }
    }
  }
  // What reads a marked component is judged on the same missing data.
  kernelFormTestServerCloseReads(index, reasons);
  return reasons;
}

/**
 * The reason the run's verdict is not wholly this side's, when a rule it left unevaluated could
 * have decided it. A verdict is the sum of every field's required and valid checks, and
 * `expect refused` / `expect accepted` / `expect no errors` name no field, so the field skip
 * cannot cover them: any component the marks reach (its own skipped `requiredWhen` or
 * `validWhen`; a skipped visibility, its own or a container's, which the kernel answers by
 * relaxing requiredness; a calculation kept as sent; a rule reading one of those) that can
 * refuse an answer (it is required, or has a `requiredWhen` or `validWhen`) names the reason,
 * the first in document order. A server-secret mark is not one: the kernel applies that rule, and
 * its field is skipped by its `unreplayable.secret` mark alone. Failing that, a journey path this side cannot
 * draw ({@link kernelFormTestServerTraceReason}) decides which pages' fields count.
 */
export function kernelFormTestServerVerdictReason(
  index: FormTestServerIndex,
  reasons: Record<string, FormTestSkipReason>,
  traceReason: FormTestSkipReason | undefined
): FormTestSkipReason | undefined {
  for (const id of index.order) {
    const reason = kernelOwn(reasons, id);
    if (reason === undefined || reason === "unreplayable.secret") {
      continue;
    }
    const node = kernelOwn(index.nodeById, id);
    if (node !== undefined && kernelFormTestServerCanRefuse(node)) {
      return reason;
    }
  }
  return traceReason;
}

/** An outcome error as a snapshot carries it: the field mapping and the code, the message worded by the caller. */
export function kernelFormTestServerSnapshotError(error: WasmValidationError, message: string | undefined): FormTestSnapshotError {
  const entry = kernelRecord() as FormTestSnapshotError;
  if (error.componentId !== undefined) {
    entry.componentId = error.componentId;
  }
  if (error.path !== undefined) {
    entry.path = error.path;
  }
  entry.code = error.code;
  entry.stage = error.stage;
  if (message !== undefined) {
    entry.message = message;
  }
  return entry;
}

/** The kernel driver's server half, spliced into the sandbox program for the `test` op. */
export const FORM_TEST_KERNEL_DRIVER_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelFormTestServerIndex,
  kernelFormTestServerComponentIdOf,
  kernelFormTestServerAnswers,
  kernelFormTestServerPut,
  kernelFormTestServerHostValue,
  kernelFormTestServerAnswerFor,
  kernelFormTestServerNotScalar,
  kernelFormTestServerRowNotScalar,
  kernelFormTestServerOffered,
  kernelFormTestServerRowAnswers,
  kernelFormTestServerRowsOf,
  kernelFormTestServerWrite,
  kernelFormTestServerAddRow,
  kernelFormTestServerRemoveRow,
  kernelFormTestServerInitialRows,
  kernelFormTestServerSeedRows,
  kernelFormTestServerRowLimit,
  kernelFormTestServerRowRoom,
  kernelFormTestServerAllows,
  kernelFormTestServerRowRefusal,
  kernelFormTestServerRevealPage,
  kernelFormTestServerOnReview,
  kernelFormTestServerValues,
  kernelFormTestServerRowCounts,
  kernelFormTestServerBlocking,
  kernelFormTestServerAnyBlocking,
  kernelFormTestServerPageErrors,
  kernelFormTestServerKeepShown,
  kernelFormTestServerShownBlocks,
  kernelFormTestServerSelectJourney,
  kernelFormTestServerPageOrder,
  kernelFormTestServerPage,
  kernelFormTestServerDeferred,
  kernelFormTestServerReconcile,
  kernelFormTestServerNextPage,
  kernelFormTestServerBackPage,
  kernelFormTestServerComplete,
  kernelFormTestServerReturning,
  kernelFormTestServerMove,
  kernelFormTestServerPageOf,
  kernelFormTestServerChange,
  kernelFormTestServerFoldValues,
  kernelFormTestServerEvaluation,
  kernelFormTestServerRequired,
  kernelFormTestServerEffective,
  kernelFormTestServerSkipReason,
  kernelFormTestServerMark,
  kernelFormTestServerReadId,
  kernelFormTestServerMarkUnder,
  kernelFormTestServerCloseReads,
  kernelFormTestServerReadsReason,
  kernelFormTestServerMarkTrace,
  kernelFormTestServerMarkPage,
  kernelFormTestServerCanRefuse,
  kernelFormTestServerUnreplayable,
  kernelFormTestServerVerdictReason,
  kernelFormTestServerSnapshotError
];

// --- The `test` op ------------------------------------------
//
// A host runs a form's tests through `__datum_inspect` with `op: "test"`: the scenarios are
// walked here, synchronously, over the kernel's own run (`runKernel`) with the functions above,
// the parser (`kernelParseFormTests`) and the judge (`kernelFormTestJudge`). It is the kernel
// driver's reading (`createFormTestKernelDriver`) step for step, with the host round trip taken
// out: each run's context and outcome cross JSON exactly as they cross the ABI, so a scenario
// comes to the same steps here and through the driver. Two readings the driver takes from
// modules that are not the kernel's are carried here in kernel shape: the validation messages
// (`resolveValidationMessage` over the field's layered `messages`, each worded through the
// definition's `translations` for the scenario's locale, the engine's English table
// with the definition's `texts` translations over it; no host translation catalog, as the
// driver has none) and the PDF layout a snapshot
// reports (`selectPdfLayoutForValues`, the layout's own shape checks read as far as its kind,
// root, template, fields and areas). `engine/tests/form-tests/kernel-test-op.test.ts` holds the
// copies to their originals.

/** One source the op parses: a definition entry (its `id`) or the request's sidecar text (no id). */
export interface FormTestOpSource {
  id?: string;
  text: string;
}

/** What the scenarios of one `test` request share: the definition read once, as each kernel driver reads it. */
export interface FormTestOpShared {
  definition: FormDefinition;
  /** The root with every data grid bound, as the run reads it. */
  authored: ComponentNode;
  /** The root as the wire carries it (keys in code-unit order), for every run's context. */
  wireForm: unknown;
  /** The definition's `translations` as the wire carries them, for every run's context; absent when it has none. */
  wireTranslations: unknown;
  /** The definition's `kinds` map as the wire carries it, for every run's context; absent when it has none. */
  wireKinds: unknown;
  policy: string;
  /** The request's own `formulaErrors` word, handed to every run; absent, the form's own policy. */
  formulaErrors: string | undefined;
  signatures: FormulaFunctionSignature[];
  functions: Record<string, (args: unknown[]) => unknown> | undefined;
  /** The plugin functions' names, which a layout's `when` may call beside the built-ins. */
  pluginNames: string[];
  validators: readonly KernelValidator[];
  cache: KernelPreparedCache;
  base: KernelPrepared;
  index: FormTestServerIndex;
  readsClock: boolean;
  locales: string[];
  problems: FormulaProblem[];
  /**
   * The message catalogs by locale ({@link kernelFormTestOpCatalogsFor}), filled as snapshots ask:
   * a form's messages are worded through its `translations` for the locale they are shown in.
   */
  catalogs: Record<string, { catalogs: Record<string, Record<string, string> | undefined>; root: Record<string, string> | undefined }>;
  layouts: Record<string, unknown>[];
}

/** One scenario's walk: the kernel driver's closure as a record. */
export interface FormTestOpState {
  shared: FormTestOpShared;
  prepared: KernelPrepared;
  answers: FormTestServerAnswers;
  navigation: FormTestServerNavigation;
  journey: Journey | undefined;
  wireJourney: unknown;
  foldJourney: Journey | undefined;
  pageOrder: string[];
  today: string | undefined;
  /** What the scenario's `host.` givens make, the runs' `hostContext`; absent when it gives none. */
  hostContext: Record<string, unknown> | undefined;
  /** {@link FormTestOpState.hostContext} as the wire carries it. */
  wireHostContext: unknown;
  locale: string;
  optionSnapshot: KernelOptionSnapshot | undefined;
  wireOptions: unknown;
  shown: WasmValidationError[];
  verdict: "accepted" | "refused" | undefined;
  submitted: Record<string, unknown> | undefined;
  withheld: string[] | undefined;
  last: { outcome: WasmSubmissionOutcome; values: Record<string, unknown> } | undefined;
}

/** The most UTF-8 bytes of test text one request may carry: 256 KiB. */
export function kernelFormTestOpMaxBytes(): number {
  return 262144;
}

/** The most scenarios one request may run. */
export function kernelFormTestOpMaxScenarios(): number {
  return 200;
}

/** The most statements one scenario may hold: the runner's `FORM_TEST_MAX_STEPS`, a literal here because the kernel reads no module constant (the tests pin the two). */
export function kernelFormTestOpMaxSteps(): number {
  return 1000;
}

/** The length of `text` in UTF-8 bytes, a lone surrogate counted as the replacement character it encodes to. */
export function kernelFormTestOpUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length && text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff) {
      bytes += 4;
      at += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The definition's own test entries, read as `readFormTests` reads them: a missing or malformed
 * `tests` is none, an entry needs a non-empty string `id` and a string `source`, and a repeated
 * id is dropped (the first wins).
 */
export function kernelFormTestOpEntries(definition: FormDefinition): FormTestOpSource[] {
  const entries: FormTestOpSource[] = [];
  const configuration = kernelOwn(definition as unknown as Record<string, unknown>, "tests");
  if (!kernelIsPlainRecord(configuration) || !Array.isArray(configuration.scenarios)) {
    return entries;
  }
  const seen = kernelRecord() as Record<string, true>;
  const listed: unknown[] = configuration.scenarios;
  for (let at = 0; at < listed.length; at += 1) {
    const entry = listed[at];
    if (!kernelIsPlainRecord(entry) || typeof entry.id !== "string" || entry.id === "" || typeof entry.source !== "string") {
      continue;
    }
    if (kernelOwn(seen, entry.id) === true) {
      continue;
    }
    seen[entry.id] = true;
    entries.push({ id: entry.id, text: entry.source });
  }
  return entries;
}

/** A parse problem as the report carries it: the problem, and the entry it is in when it came from the definition. */
export function kernelFormTestOpProblem(problem: FormTestProblem, id: string | undefined): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (id !== undefined) {
    entry.id = id;
  }
  entry.code = problem.code;
  entry.line = problem.line;
  entry.start = problem.start;
  entry.end = problem.end;
  if (problem.params !== undefined) {
    entry.params = problem.params;
  }
  return entry;
}

/**
 * Every source parsed alone, as the builder's panel (one entry, one block) and the CLI (a
 * sidecar source) read them. A definition entry with problems, no block, or a second block runs
 * nothing; a name an earlier entry took is a `duplicateName` problem and the entry still runs.
 * The sidecar text runs nothing when it has a problem. Scenarios come back in source order.
 */
export function kernelFormTestOpParse(
  sources: FormTestOpSource[],
  sidecar: boolean,
  signatures: FormulaFunctionSignature[]
): { scenarios: Array<{ id?: string; scenario: FormTestScenario }>; problems: Record<string, unknown>[] } {
  const scenarios: Array<{ id?: string; scenario: FormTestScenario }> = [];
  const problems: Record<string, unknown>[] = [];
  const taken = kernelRecord() as Record<string, true>;
  for (let s = 0; s < sources.length; s += 1) {
    const source = sources[s] as FormTestOpSource;
    const parsed = kernelParseFormTests(source.text, signatures);
    if (sidecar) {
      if (parsed.problems.length > 0) {
        for (let p = 0; p < parsed.problems.length; p += 1) {
          problems.push(kernelFormTestOpProblem(parsed.problems[p] as FormTestProblem, undefined));
        }
        continue;
      }
      for (let c = 0; c < parsed.scenarios.length; c += 1) {
        scenarios.push({ scenario: parsed.scenarios[c] as FormTestScenario });
      }
      continue;
    }
    const found: FormTestProblem[] = parsed.problems.slice();
    if (parsed.scenarios.length === 0 && found.length === 0) {
      found.push({ code: "expectedName", line: 1, start: 0, end: 0 });
    }
    const second = parsed.scenarios[1];
    if (second !== undefined) {
      found.push({ code: "stepOutsideTest", line: second.line, start: second.span.start, end: second.nameSpan.end });
    }
    const scenario = parsed.scenarios[0];
    if (scenario === undefined || found.length > 0) {
      for (let p = 0; p < found.length; p += 1) {
        problems.push(kernelFormTestOpProblem(found[p] as FormTestProblem, source.id));
      }
      continue;
    }
    if (kernelOwn(taken, scenario.name) === true) {
      problems.push(
        kernelFormTestOpProblem(
          { code: "duplicateName", line: scenario.nameSpan.line, start: scenario.nameSpan.start, end: scenario.nameSpan.end, params: { name: scenario.name } },
          source.id
        )
      );
    }
    taken[scenario.name] = true;
    scenarios.push(source.id !== undefined ? { id: source.id, scenario } : { scenario });
  }
  return { scenarios, problems };
}

/** The engine's English validation messages (`DEFAULT_VALIDATION_MESSAGES`), as a literal the kernel can read. */
export function kernelFormTestOpMessagesEn(): Record<string, string> {
  return {
    required: "This field is required",
    minLength: "Enter at least {minLength} characters",
    maxLength: "Enter no more than {maxLength} characters",
    pattern: "Enter a value in the expected format",
    fileType: "{file} is not a type of file this field accepts",
    maxFileSize: "{file} is larger than the {maxFileSizeLabel} this field accepts",
    number: "Enter a number",
    date: "Enter a real date",
    dateIncomplete: "Enter a complete date",
    "number.min": "Enter a number of {min} or more",
    "number.max": "Enter a number of {max} or less",
    "date.min": "Enter a date on or after {min}",
    "date.max": "Enter a date on or before {max}",
    text: "Enter text",
    file: "Upload a file",
    fileCount: "Too many files: the most allowed is {maxFiles}",
    fileSize: "This file could not be read. Choose it again",
    "file.sizeMismatch": "This file could not be read. Choose it again",
    "option.notAllowed": "Choose one of the options offered",
    "option.sourceUnavailable": "This answer could not be checked. Try again later.",
    "journey.server-unavailable": "We could not check your answers. Try again.",
    "journey.exit": "You cannot send this form with these answers.",
    "journey.unknown": "This version of the form cannot be sent. Reload the page and try again.",
    "wasm.values-missing": "Your answers could not be checked. Try again.",
    "fold.unsettled": "Your answers could not be checked: some questions depend on each other. Change an answer and try again.",
    "map.unsettled": "Your answers could not be checked: some questions depend on each other. Change an answer and try again.",
    "validator.failed": "This answer could not be checked. Try again later.",
    rule: "Check this answer",
    "rows.min": "Too few rows: add at least {min}.",
    "rows.max": "Too many rows: at most {max}."
  };
}

/** The codes the engine raises itself (`ENGINE_VALIDATION_CODES`), which it words over a raiser's message. */
export function kernelFormTestOpEngineCodes(): string[] {
  return [
    "required", "minLength", "maxLength", "pattern", "fileType", "maxFileSize", "fileSize", "file.sizeMismatch", "file", "fileCount",
    "text", "number", "number.min", "number.max", "date", "date.min", "date.max", "dateIncomplete", "rule", "rows.min", "rows.max"
  ];
}

/** The codes a field's declared limits raise, whose own message outranks the engine's (`HOST_WORDED_CODES`). */
export function kernelFormTestOpHostWordedCodes(): string[] {
  return ["required", "minLength", "maxLength", "pattern", "fileType", "maxFileSize"];
}

/**
 * `defaultValidationMessage` with no language pack (the kernel holds no binding): the
 * definition's `texts` translation of the engine's sentence for `code` in `locale`
 * (`texts › messages › <code>`, through {@link kernelResolveText}), else the English; `undefined`
 * for a code the engine does not word.
 */
export function kernelFormTestOpDefaultMessage(code: string, locale: string, translations?: unknown): string | undefined {
  const english = kernelFormTestOpMessagesEn();
  if (!Object.prototype.hasOwnProperty.call(english, code)) {
    return undefined;
  }
  return kernelResolveText(english[code] as string, { kind: "texts", owner: "messages", path: [code] }, locale, translations);
}

/** What a limit's code says with no parameters to fill its template (`PARAMETERLESS_WORDING`). */
export function kernelFormTestOpParameterless(code: string): string | undefined {
  const table: Record<string, string> = {
    minLength: "This answer is too short",
    maxLength: "This answer is too long",
    fileType: "This type of file is not accepted by this field",
    maxFileSize: "This file is too large for this field"
  };
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
}

/** `interpolate`: `{name}` tokens filled from the parameters, a string or number only; any other token kept as written. */
export function kernelFormTestOpInterpolate(message: string, parameters: Record<string, unknown> | undefined): string {
  if (!parameters) {
    return message;
  }
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (token: string, name: string): string {
    const value = parameters[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : token;
  });
}

/**
 * `readValidationMessages` with its `translate` (core/localization/validation-messages.ts): a
 * configuration's `messages` map, its string entries under a non-blank code, each
 * worded for `locale` through the definition's `translations` at the message's address — the
 * form's own (`form › messages › code`) on the root, where `ownerId` is absent, else
 * `components › ownerId › messages › code` — then the field's `patternMessage` standing in for
 * `pattern` when the map has no entry of its own, worded at `components › ownerId ›
 * patternMessage` (on the root it stays as authored, as the browser leaves it).
 */
export function kernelFormTestOpOwnMessages(
  configuration: unknown,
  ownerId: string | undefined,
  locale: string,
  translations: unknown
): Record<string, string> | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const read = configuration as Record<string, unknown>;
  const catalog = kernelRecord() as Record<string, string>;
  const messages = read.messages;
  if (messages && typeof messages === "object" && !Array.isArray(messages)) {
    const keys = Object.keys(messages);
    for (let k = 0; k < keys.length; k += 1) {
      const code = keys[k] as string;
      const text = (messages as Record<string, unknown>)[code];
      if (code.trim().length > 0 && typeof text === "string") {
        const address: KernelTextAddress =
          ownerId === undefined ? { kind: "form", path: ["messages", code] } : { kind: "components", owner: ownerId, path: ["messages", code] };
        catalog[code] = kernelResolveText(text, address, locale, translations);
      }
    }
  }
  if (kernelOwn(catalog, "pattern") === undefined && typeof read.patternMessage === "string") {
    catalog.pattern =
      ownerId !== undefined
        ? kernelResolveText(read.patternMessage, { kind: "components", owner: ownerId, path: ["patternMessage"] }, locale, translations)
        : read.patternMessage;
  }
  return Object.keys(catalog).length > 0 ? catalog : undefined;
}

/**
 * Each component's catalog as the renderer layers it (`messageCatalogs` in the driver), worded
 * for `locale`: its own over its containers' over the form's, walked in document order with an
 * explicit stack. The root's messages are the form's own (no owner id), every other node's its
 * component's. A repeated id keeps the last one walked, as a map set in that order does.
 */
export function kernelFormTestOpCatalogs(root: ComponentNode, locale: string, translations: unknown): Record<string, Record<string, string> | undefined> {
  const catalogs = kernelRecord() as Record<string, Record<string, string> | undefined>;
  const stack: Array<{ node: ComponentNode; inherited: Record<string, string> | undefined }> = [{ node: root, inherited: undefined }];
  while (stack.length > 0) {
    const item = stack.pop() as { node: ComponentNode; inherited: Record<string, string> | undefined };
    const own = kernelFormTestOpOwnMessages(item.node.configuration, item.node === root ? undefined : item.node.id, locale, translations);
    let layered: Record<string, string> | undefined;
    if (own !== undefined || item.inherited !== undefined) {
      layered = kernelRecord() as Record<string, string>;
      const layers = [own, item.inherited];
      for (let l = 0; l < layers.length; l += 1) {
        const layer = layers[l];
        if (layer === undefined) {
          continue;
        }
        const keys = Object.keys(layer);
        for (let k = 0; k < keys.length; k += 1) {
          if (kernelOwn(layered, keys[k] as string) === undefined) {
            layered[keys[k] as string] = layer[keys[k] as string] as string;
          }
        }
      }
      if (Object.keys(layered).length === 0) {
        layered = undefined;
      }
    }
    Object.defineProperty(catalogs, item.node.id, { value: layered, writable: true, enumerable: true, configurable: true });
    const pending: Array<{ node: ComponentNode; inherited: Record<string, string> | undefined }> = [];
    const slots = item.node.children !== undefined && item.node.children !== null ? Object.keys(item.node.children) : [];
    for (let s = 0; s < slots.length; s += 1) {
      const list = (item.node.children as Record<string, ComponentNode[]>)[slots[s] as string];
      if (!Array.isArray(list)) {
        continue;
      }
      for (let c = 0; c < list.length; c += 1) {
        pending.push({ node: list[c] as ComponentNode, inherited: layered });
      }
    }
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      stack.push(pending[p] as { node: ComponentNode; inherited: Record<string, string> | undefined });
    }
  }
  return catalogs;
}

/**
 * The catalogs for `locale`, worked out the first time a snapshot asks for that locale and kept
 * on the shared state (a scenario may switch locale; every scenario reads the same definition):
 * each component's layered catalog, and the root's own for an error that names no component.
 */
export function kernelFormTestOpCatalogsFor(
  shared: FormTestOpShared,
  locale: string
): { catalogs: Record<string, Record<string, string> | undefined>; root: Record<string, string> | undefined } {
  const known = kernelOwn(shared.catalogs, locale);
  if (known !== undefined) {
    return known;
  }
  const translations = kernelOwn(shared.definition as unknown as Record<string, unknown>, "translations");
  const worded = {
    catalogs: kernelFormTestOpCatalogs(shared.definition.root, locale, translations),
    root: kernelFormTestOpOwnMessages(shared.definition.root.configuration, undefined, locale, translations)
  };
  Object.defineProperty(shared.catalogs, locale, { value: worded, writable: true, enumerable: true, configurable: true });
  return worded;
}

/**
 * `resolveValidationMessage`: the catalog's entry (already worded for the locale), the engine's
 * wording (the definition's `texts` translation of it in `translations`, else the English), the
 * raiser's message, in the engine's order for the code.
 */
export function kernelFormTestOpMessage(
  error: WasmValidationError,
  catalog: Record<string, string> | undefined,
  locale: string,
  translations?: unknown
): string {
  const code = error.code;
  const parameters = (error as { parameters?: Record<string, unknown> }).parameters;
  const message = (error as { message?: unknown }).message;
  const raised = typeof message === "string" ? message : undefined;
  const entry: unknown = catalog !== undefined ? kernelOwn(catalog, code) : undefined;
  const resolved = typeof entry === "string" ? entry : undefined;
  const engine = kernelFormTestOpDefaultMessage(code, locale, translations);
  const engineFits = engine !== undefined && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(kernelFormTestOpInterpolate(engine, parameters));
  let text: string;
  if (kernelFormTestOpHostWordedCodes().indexOf(code) >= 0) {
    text = resolved ?? raised ?? (engineFits ? engine : kernelFormTestOpParameterless(code)) ?? code;
  } else if (kernelFormTestOpEngineCodes().indexOf(code) >= 0) {
    text = resolved ?? (engineFits ? engine : undefined) ?? raised ?? engine ?? code;
  } else {
    text = resolved ?? raised ?? engine ?? code;
  }
  return kernelFormTestOpInterpolate(text, parameters);
}

/** The locales the form offers, as `setLocale` checks a request against them (`supportedLocaleCodes`): codes trimmed, blanks dropped. */
export function kernelFormTestOpLocales(localization: unknown): string[] {
  const codes: string[] = [];
  const listed = kernelIsPlainRecord(localization) ? localization.supportedLocales : undefined;
  if (!Array.isArray(listed)) {
    return codes;
  }
  for (let at = 0; at < listed.length; at += 1) {
    const entry: unknown = listed[at];
    const code = kernelIsPlainRecord(entry) && typeof entry.code === "string" ? entry.code.trim() : "";
    if (code.length > 0) {
      codes.push(code);
    }
  }
  return codes;
}

/** Whether a finite number (`Number.isFinite`, no coercion). */
export function kernelFormTestOpFinite(value: unknown): boolean {
  return typeof value === "number" && isFinite(value);
}

/**
 * Whether a PDF layout is one the renderer's reader keeps (`validatePdfLayout`), read as far as
 * the kernel needs to choose one: an id, a generated layout's `pdf-document` root and rendition
 * map, a template layout's source, field mappings and areas. A malformed `conformance`,
 * `attachments` or `signature` block, which the reader also refuses, is not read here.
 */
export function kernelFormTestOpLayoutUsable(layout: unknown): boolean {
  if (!kernelIsPlainRecord(layout) || typeof layout.id !== "string" || layout.id.trim() === "") {
    return false;
  }
  if (layout.kind === "generated") {
    const root = layout.root;
    if (!kernelIsPlainRecord(root) || typeof root.id !== "string" || typeof root.type !== "string" || root.type !== "pdf-document") {
      return false;
    }
    return layout.renditionDefaults === undefined || kernelIsPlainRecord(layout.renditionDefaults);
  }
  if (layout.kind !== "template") {
    return false;
  }
  const template = layout.template;
  if (!kernelIsPlainRecord(template) || typeof template.storage !== "string" || template.storage === "") {
    return false;
  }
  if (template.storage === "base64" && typeof template.data !== "string") {
    return false;
  }
  if (!Array.isArray(layout.fields)) {
    return false;
  }
  for (let f = 0; f < layout.fields.length; f += 1) {
    const mapping: unknown = layout.fields[f];
    if (!kernelIsPlainRecord(mapping) || typeof mapping.pdfField !== "string" || mapping.pdfField === "") {
      return false;
    }
    if (!kernelIsPlainRecord(mapping.source) || typeof mapping.source.kind !== "string") {
      return false;
    }
  }
  if (layout.areas === undefined) {
    return true;
  }
  if (!Array.isArray(layout.areas)) {
    return false;
  }
  const ids = kernelRecord() as Record<string, true>;
  for (let a = 0; a < layout.areas.length; a += 1) {
    const area: unknown = layout.areas[a];
    if (!kernelIsPlainRecord(area) || typeof area.id !== "string" || area.id.trim() === "" || kernelOwn(ids, area.id) === true) {
      return false;
    }
    ids[area.id] = true;
    if (typeof area.page !== "number" || !isFinite(area.page) || Math.floor(area.page) !== area.page || area.page < 1) {
      return false;
    }
    const rect = area.rect;
    if (
      !kernelIsPlainRecord(rect) ||
      !kernelFormTestOpFinite(rect.x) ||
      !kernelFormTestOpFinite(rect.y) ||
      !kernelFormTestOpFinite(rect.width) ||
      !kernelFormTestOpFinite(rect.height) ||
      (rect.width as number) <= 0 ||
      (rect.height as number) <= 0
    ) {
      return false;
    }
    if (!kernelIsPlainRecord(area.source) || typeof area.source.kind !== "string") {
      return false;
    }
    if (area.field !== undefined) {
      if (!kernelIsPlainRecord(area.field)) {
        return false;
      }
      const name = area.field.name;
      if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.indexOf("..") >= 0)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether a layout condition's tree is one the evaluator can run all the way down
 * (`isEvaluableExpression`, a plugin's call accepted as `withPluginCallsMasked` accepts it), walked
 * with an explicit stack.
 */
export function kernelFormTestOpEvaluable(expression: unknown, builtins: string[], pluginNames: string[]): boolean {
  const stack: unknown[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!kernelIsPlainRecord(node)) {
      return false;
    }
    switch (node.kind) {
      case "literal":
        if (!(node.value === null || typeof node.value === "string" || typeof node.value === "number" || typeof node.value === "boolean")) {
          return false;
        }
        break;
      case "path":
        if (!(typeof node.path === "string" && node.path.length > 0)) {
          return false;
        }
        break;
      case "unary":
        if (node.operator !== "not") {
          return false;
        }
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic": {
        const operators =
          node.kind === "binary" ? ["eq", "neq", "gt", "gte", "lt", "lte"] : node.kind === "logical" ? ["and", "or"] : ["add", "subtract", "multiply", "divide"];
        if (typeof node.operator !== "string" || operators.indexOf(node.operator) < 0) {
          return false;
        }
        stack.push(node.left, node.right);
        break;
      }
      case "call":
        if (typeof node.name !== "string" || (builtins.indexOf(node.name) < 0 && pluginNames.indexOf(node.name) < 0) || !Array.isArray(node.args)) {
          return false;
        }
        for (let a = 0; a < node.args.length; a += 1) {
          stack.push(node.args[a]);
        }
        break;
      case "if":
        if (!Array.isArray(node.cases)) {
          return false;
        }
        for (let c = 0; c < node.cases.length; c += 1) {
          const entry: unknown = node.cases[c];
          if (!kernelIsPlainRecord(entry)) {
            return false;
          }
          stack.push(entry.when, entry.then);
        }
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * The PDF layout the answers choose (`selectPdfLayoutForValues`): the first usable
 * layout whose `when` holds over the answers keyed by component id (the schema's keys only, read
 * as JSON carries them), else the declared default, else the first; `undefined` when the form
 * declares none.
 */
export function kernelFormTestOpLayout(
  shared: FormTestOpShared,
  byPath: Record<string, unknown>,
  today: string | undefined,
  builtins: string[]
): string | undefined {
  let values: Record<string, unknown> | undefined;
  for (let l = 0; l < shared.layouts.length; l += 1) {
    const layout = shared.layouts[l] as Record<string, unknown>;
    if (layout.when === undefined || layout.when === null) {
      continue;
    }
    const expression = kernelRuleExpression(layout.when, kernelParseFormula, shared.signatures);
    if (expression === undefined || !kernelFormTestOpEvaluable(expression, builtins, shared.pluginNames)) {
      continue;
    }
    if (values === undefined) {
      values = kernelRecord() as Record<string, unknown>;
      const answers = kernelJsonAnswers(kernelPartitionValues(byPath, shared.authored).known);
      const owners = kernelComponentIdsByPath(shared.authored);
      const owned: Array<{ ids: string[]; value: unknown }> = [];
      const keys = Object.keys(answers);
      for (let k = 0; k < keys.length; k += 1) {
        const ids = kernelOwn(owners, keys[k] as string);
        if (ids !== undefined && ids.length > 0) {
          owned.push({ ids, value: answers[keys[k] as string] });
        } else {
          kernelFormTestServerPut(values, keys[k] as string, answers[keys[k] as string]);
        }
      }
      for (let o = 0; o < owned.length; o += 1) {
        const item = owned[o] as { ids: string[]; value: unknown };
        for (let i = 0; i < item.ids.length; i += 1) {
          kernelFormTestServerPut(values, item.ids[i] as string, item.value);
        }
      }
    }
    const context: RuleEvaluationContext = { values, regexCache: { refuseRisky: true } };
    if (today !== undefined) {
      context.today = today;
    }
    if (shared.functions !== undefined) {
      context.functions = shared.functions;
    }
    let holds = false;
    try {
      holds = kernelEvaluateExpression(expression, context) === true;
    } catch (_error) {
      holds = false;
    }
    if (holds) {
      return layout.id as string;
    }
  }
  const pdf = kernelOwn(shared.definition as unknown as Record<string, unknown>, "pdf");
  const named = kernelIsPlainRecord(pdf) && typeof pdf.defaultLayoutId === "string" && pdf.defaultLayoutId !== "" ? pdf.defaultLayoutId : undefined;
  if (named !== undefined) {
    for (let l = 0; l < shared.layouts.length; l += 1) {
      if ((shared.layouts[l] as Record<string, unknown>).id === named) {
        return named;
      }
    }
  }
  const first = shared.layouts[0];
  return first !== undefined ? (first.id as string) : undefined;
}

/** A JSON value as the wire carries it: keys in code-unit order, `undefined` dropped, as the ABI serialises a context and an outcome. */
export function kernelFormTestOpWire(value: unknown): unknown {
  const text = kernelStableStringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** What every scenario of the request reads, worked out once: the kernel driver's setup. */
export function kernelFormTestOpShare(
  definition: FormDefinition,
  formulaErrors: unknown,
  signatures: FormulaFunctionSignature[],
  functions: Record<string, (args: unknown[]) => unknown> | undefined,
  validators: readonly KernelValidator[]
): FormTestOpShared {
  const authored = kernelNormalizeDataGrids(definition.root);
  const word = typeof formulaErrors === "string" ? formulaErrors : undefined;
  const policy = kernelFormulaPolicy(authored.configuration, word);
  const base = kernelPrepareDefinition(authored, undefined, undefined, policy, undefined, signatures);
  const used = kernelRulesInventory(definition, kernelParseFormula, signatures).functionsUsed;
  const layouts: Record<string, unknown>[] = [];
  const pdf = kernelOwn(definition as unknown as Record<string, unknown>, "pdf");
  if (kernelIsPlainRecord(pdf) && Array.isArray(pdf.layouts)) {
    for (let l = 0; l < pdf.layouts.length; l += 1) {
      if (kernelFormTestOpLayoutUsable(pdf.layouts[l])) {
        layouts.push(pdf.layouts[l] as Record<string, unknown>);
      }
    }
  }
  return {
    definition,
    authored,
    wireForm: kernelFormTestOpWire(definition.root),
    wireTranslations: kernelFormTestOpWire(kernelOwn(definition as unknown as Record<string, unknown>, "translations")),
    wireKinds: kernelFormTestOpWire(kernelOwn(definition as unknown as Record<string, unknown>, "kinds")),
    policy,
    formulaErrors: word,
    signatures,
    functions,
    pluginNames: functions !== undefined ? Object.keys(functions) : [],
    validators,
    // One definition, and one more per journey a scenario picks: the cache keeps the compile
    // between the runs of every scenario (invisible to an outcome, as the hosts' caches are).
    cache: kernelCreatePreparedCache(8, 4000000),
    base,
    index: kernelFormTestServerIndex(base.root),
    readsClock: used.indexOf("today") >= 0 || used.indexOf("age") >= 0,
    locales: kernelFormTestOpLocales(definition.localization),
    problems: kernelCompileDefinition(authored, definition.journey, definition.pdf, kernelParseFormula, signatures, undefined).problems,
    catalogs: kernelRecord(),
    layouts
  };
}

/** A fresh walk for one scenario, as a new kernel driver starts. */
export function kernelFormTestOpState(shared: FormTestOpShared): FormTestOpState {
  const localization = shared.definition.localization;
  const locale = kernelIsPlainRecord(localization) && typeof localization.defaultLocale === "string" ? localization.defaultLocale : "en";
  return {
    shared,
    prepared: shared.base,
    answers: kernelFormTestServerAnswers(),
    navigation: { page: undefined, completed: [] },
    journey: undefined,
    wireJourney: undefined,
    foldJourney: undefined,
    pageOrder: [],
    today: undefined,
    hostContext: undefined,
    wireHostContext: undefined,
    locale,
    optionSnapshot: undefined,
    wireOptions: undefined,
    shown: [],
    verdict: undefined,
    submitted: undefined,
    withheld: undefined,
    last: undefined
  };
}

/** A kernel run over the current answers, the context and the outcome crossing JSON as they cross the ABI; `page` asks for a page's scope. */
export function kernelFormTestOpRun(state: FormTestOpState, page: string | undefined): { outcome: WasmSubmissionOutcome; values: Record<string, unknown> } {
  const shared = state.shared;
  const values = kernelFormTestServerValues(state.answers);
  const context: Record<string, unknown> = { form: shared.wireForm, values: kernelFormTestOpWire(values), locale: state.locale, reportFold: true };
  if (shared.definition.id !== undefined) {
    context.formId = shared.definition.id;
  }
  if (shared.wireTranslations !== undefined) {
    context.translations = shared.wireTranslations;
  }
  if (shared.wireKinds !== undefined) {
    context.kinds = shared.wireKinds;
  }
  if (state.journey !== undefined) {
    context.journey = state.wireJourney;
    if (page !== undefined) {
      context.page = page;
    }
  }
  if (state.today !== undefined) {
    context.today = state.today;
  }
  if (state.hostContext !== undefined) {
    context.hostContext = state.wireHostContext;
  }
  if (shared.formulaErrors !== undefined) {
    context.formulaErrors = shared.formulaErrors;
  }
  if (state.optionSnapshot !== undefined) {
    context.optionSnapshot = state.wireOptions;
  }
  const ran = runKernel(context as unknown as Parameters<typeof runKernel>[0], shared.validators, shared.functions, shared.signatures, shared.cache);
  const outcome = kernelFormTestOpWire(ran) as WasmSubmissionOutcome;
  state.last = { outcome, values };
  return state.last;
}

/** The last run, made again when the answers moved since. */
export function kernelFormTestOpCurrent(state: FormTestOpState): { outcome: WasmSubmissionOutcome; values: Record<string, unknown> } {
  return state.last !== undefined ? state.last : kernelFormTestOpRun(state, undefined);
}

/** After an answer changed: the run is stale, and with a journey the page and completed pages follow the new path. */
export function kernelFormTestOpAnswersChanged(state: FormTestOpState): void {
  state.last = undefined;
  if (state.journey !== undefined) {
    const fresh = kernelFormTestOpRun(state, undefined);
    kernelFormTestServerReconcile(state.navigation, fresh.outcome.trace, state.pageOrder);
  }
}

/** A page's check: the run, the errors it keeps to the page, and the errors on show replaced within the page. */
export function kernelFormTestOpCheckPage(state: FormTestOpState, page: string): { blocks: boolean; trace: JourneyTrace | undefined; withheld: string[] | undefined } {
  const checked = kernelFormTestOpRun(state, page);
  const scope = checked.outcome.pageComponentIds;
  const found = kernelFormTestServerPageErrors(checked.outcome.errors, scope);
  state.shown = kernelFormTestServerKeepShown(state.shown, found, scope);
  return {
    blocks: kernelFormTestServerAnyBlocking(found),
    trace: checked.outcome.trace,
    withheld: checked.outcome.withheld !== undefined ? checked.outcome.withheld.slice() : undefined
  };
}

/** The kernel's fold over answers as the run takes them (the same normalise, partition, day and functions). */
export function kernelFormTestOpFold(state: FormTestOpState, values: Record<string, unknown>): KernelSubmissionFold {
  return kernelFoldSubmission(
    state.prepared.root,
    kernelFormTestServerFoldValues(state.prepared, values, undefined),
    state.foldJourney,
    kernelFormTestServerEvaluation(state.prepared, state.today, state.shared.functions, state.hostContext),
    state.prepared
  );
}

/** What a data grid's bound formulas come to over the answers as they stand, when the grid at `collection` has one. */
export function kernelFormTestOpRowBounds(state: FormTestOpState, collection: string): Record<string, { min?: unknown; max?: unknown }> | undefined {
  const index = state.shared.index;
  const id = kernelOwn(index.collections, collection);
  const node = id === undefined ? undefined : kernelOwn(index.nodeById, id);
  const rules = node !== undefined && node.type === "dataGrid" ? (node.rules as Record<string, unknown> | undefined) : undefined;
  if (rules === undefined || rules === null || (kernelOwn(rules, "minRows") === undefined && kernelOwn(rules, "maxRows") === undefined)) {
    return undefined;
  }
  return kernelFormTestOpFold(state, kernelFormTestServerValues(state.answers)).rowBounds;
}

/** The givens, checked in the order written: the kernel driver's `start`. */
export function kernelFormTestOpStart(
  state: FormTestOpState,
  givens: FormTestGiven[]
): undefined | { error: FormTestStartError; params?: Record<string, unknown> } | { skip: FormTestSkipReason } {
  const shared = state.shared;
  const definition = shared.definition;
  let journeyGiven: string | undefined;
  const snapshot = kernelRecord() as Record<string, unknown>;
  let anyOptions = false;
  let hostContext: Record<string, unknown> | undefined;
  for (let g = 0; g < givens.length; g += 1) {
    const given = givens[g] as FormTestGiven;
    if (given.key === "today") {
      state.today = given.value;
    } else if (given.key === "locale") {
      if (shared.locales.length > 0 && shared.locales.indexOf(given.value) < 0) {
        return { error: "scenario.badGiven", params: { given: "locale", locale: given.value } };
      }
      state.locale = given.value;
    } else if (given.key === "journey") {
      const named = kernelFormTestServerSelectJourney(definition.journey, given.value);
      if (named.error !== undefined) {
        return { error: named.error, params: { journey: given.value } };
      }
      journeyGiven = given.value;
    } else if (given.key === "host") {
      // The scenario's host values are the runs' host context, as a server supplies one.
      if (hostContext === undefined) {
        hostContext = kernelRecord() as Record<string, unknown>;
      }
      kernelFormTestServerHostValue(hostContext, given.name, given.value);
    } else if (given.key === "options") {
      const id = kernelFormTestServerComponentIdOf(shared.index, given.path);
      const node = id !== undefined ? kernelOwn(shared.index.nodeById, id) : undefined;
      const sourceId = node !== undefined ? kernelOptionSourceId(node.configuration) : undefined;
      if (sourceId === undefined) {
        return { error: "scenario.badGiven", params: { given: "options", path: given.path, reason: id === undefined ? "unknownField" : "noSource" } };
      }
      const items: Array<{ value: string }> = [];
      for (let v = 0; v < given.values.length; v += 1) {
        items.push({ value: String(given.values[v]) });
      }
      kernelFormTestServerPut(snapshot, sourceId, items);
      anyOptions = true;
    }
  }
  state.optionSnapshot = anyOptions ? (Object.assign({}, snapshot) as KernelOptionSnapshot) : undefined;
  state.wireOptions = anyOptions ? kernelFormTestOpWire(state.optionSnapshot) : undefined;
  const selected = kernelFormTestServerSelectJourney(definition.journey, journeyGiven);
  if (shared.readsClock && state.today === undefined) {
    return { error: "scenario.clockUnset" };
  }
  if (shared.policy === "fail" && shared.problems.length > 0) {
    const problems: Array<Record<string, unknown>> = [];
    for (let p = 0; p < shared.problems.length && p < 5; p += 1) {
      const problem = shared.problems[p] as FormulaProblem;
      problems.push({ code: problem.code, where: problem.where });
    }
    return { error: "scenario.formulaInvalid", params: { problems } };
  }
  state.hostContext = hostContext;
  state.wireHostContext = hostContext !== undefined ? kernelFormTestOpWire(hostContext) : undefined;
  state.journey = selected.journey;
  state.wireJourney = selected.journey !== undefined ? kernelFormTestOpWire(selected.journey) : undefined;
  state.pageOrder = kernelFormTestServerPageOrder(state.journey);
  kernelFormTestServerSeedRows(state.answers, shared.index);
  if (state.journey !== undefined) {
    state.prepared = kernelPrepareDefinition(shared.authored, state.journey, undefined, shared.policy, undefined, shared.signatures);
    state.foldJourney = kernelIsJourney(state.prepared.journey) ? state.prepared.journey : undefined;
    const opened = kernelFormTestOpRun(state, undefined);
    kernelFormTestServerReconcile(state.navigation, opened.outcome.trace, state.pageOrder);
  }
  return undefined;
}

/** One action, as the kernel driver performs it; a row action the form turns down comes back as a coded refusal. */
export function kernelFormTestOpPerform(state: FormTestOpState, action: FormTestAction): FormTestRefusal | undefined {
  const shared = state.shared;
  const index = shared.index;
  switch (action.kind) {
    case "set": {
      // A write past the last row adds rows up to it, as the runtime does; never past the most a
      // person could add (the grid's maximum, else the cap every collection is drawn to), which
      // an add row is held to: the write refuses it, worded as the add's `rows.max`.
      const rowParts = kernelRowKeyParts(action.path, index.lists);
      const limit = rowParts !== undefined ? kernelFormTestServerRowLimit(index, rowParts.collection, kernelFormTestOpRowBounds(state, rowParts.collection)) : undefined;
      const id = kernelFormTestServerComponentIdOf(index, action.path);
      const node = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
      if (kernelFormTestServerNotScalar(node !== undefined ? node.type : undefined, action.value)) {
        const params = kernelRecord() as Record<string, unknown>;
        params.path = action.path;
        return { refused: "value.notScalar", params };
      }
      const offered = kernelFormTestServerOffered(node, state.optionSnapshot);
      if (!kernelFormTestServerWrite(state.answers, index.lists, action.path, kernelFormTestServerAnswerFor(node !== undefined ? node.type : undefined, action.value, offered), limit)) {
        const params = kernelRecord() as Record<string, unknown>;
        params.path = rowParts !== undefined ? rowParts.collection : action.path;
        params.max = limit;
        return { refused: "rows.max", params };
      }
      kernelFormTestOpAnswersChanged(state);
      return undefined;
    }
    case "clear":
      kernelFormTestServerWrite(state.answers, index.lists, action.path, undefined);
      kernelFormTestOpAnswersChanged(state);
      return undefined;
    case "addRow": {
      // A list in a cell that holds one value is refused as the `set` of it is, before the row is made.
      const held = kernelOwn(state.answers.rows, action.path);
      const notScalar = kernelFormTestServerRowNotScalar(action.path, held !== undefined ? held.length : 0, action.values, function (path: string): string | undefined {
        const id = kernelFormTestServerComponentIdOf(index, path);
        const node = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
        return node !== undefined ? node.type : undefined;
      });
      if (notScalar !== undefined) {
        const params = kernelRecord() as Record<string, unknown>;
        params.path = notScalar;
        return { refused: "value.notScalar", params };
      }
      const refusal = kernelFormTestServerRowRefusal(state.answers, index, action.path, "add", -1, kernelFormTestOpRowBounds(state, action.path));
      if (refusal !== undefined) {
        return { refused: refusal.refused, params: Object.assign({}, refusal.params) };
      }
      const cells = kernelFormTestServerRowAnswers(action.path, held !== undefined ? held.length : 0, action.values, function (path: string, value: FormTestValue): unknown {
        const id = kernelFormTestServerComponentIdOf(index, path);
        const node = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
        return kernelFormTestServerAnswerFor(node !== undefined ? node.type : undefined, value, kernelFormTestServerOffered(node, state.optionSnapshot));
      });
      kernelFormTestServerAddRow(state.answers, index.lists, action.path, cells);
      kernelFormTestOpAnswersChanged(state);
      return undefined;
    }
    case "removeRow": {
      const refusal = kernelFormTestServerRowRefusal(state.answers, index, action.path, "remove", action.index);
      if (refusal !== undefined) {
        return { refused: refusal.refused, params: Object.assign({}, refusal.params) };
      }
      kernelFormTestServerRemoveRow(state.answers, index.lists, action.path, action.index);
      kernelFormTestOpAnswersChanged(state);
      return undefined;
    }
    case "continue": {
      const page = state.navigation.page;
      if (state.journey === undefined || page === undefined) {
        return undefined;
      }
      const authoredPage = kernelFormTestServerPage(state.journey, page);
      if (authoredPage !== undefined && authoredPage.kind === "exit") {
        return undefined;
      }
      let trace = kernelFormTestOpCurrent(state).outcome.trace;
      if (kernelFormTestServerNextPage(trace, page) === undefined) {
        return undefined;
      }
      let validate = true;
      if (kernelFormTestServerDeferred(state.journey, authoredPage)) {
        const scoped = kernelFormTestOpRun(state, page);
        validate = kernelFormTestServerShownBlocks(state.shown, scoped.outcome.pageComponentIds);
        trace = scoped.outcome.trace;
      }
      if (validate) {
        const checked = kernelFormTestOpCheckPage(state, page);
        if (checked.blocks) {
          return undefined;
        }
        trace = checked.trace;
      }
      // On the way back from a Change link: the first page not yet completed, else the review page.
      const returning = kernelFormTestServerReturning(state.journey, trace, state.navigation);
      const target = returning !== undefined ? returning : kernelFormTestServerNextPage(trace, page);
      if (target === undefined) {
        return undefined;
      }
      kernelFormTestServerComplete(state.navigation, page);
      kernelFormTestServerMove(state.navigation, target, returning !== undefined);
      return undefined;
    }
    case "back": {
      if (state.journey === undefined) {
        return undefined;
      }
      const trace = kernelFormTestOpCurrent(state).outcome.trace;
      const returning = kernelFormTestServerReturning(state.journey, trace, state.navigation);
      const target =
        returning !== undefined && state.navigation.page !== undefined && state.navigation.completed.indexOf(state.navigation.page) >= 0
          ? returning
          : kernelFormTestServerBackPage(trace, state.navigation.page);
      if (target !== undefined) {
        kernelFormTestServerMove(state.navigation, target, returning !== undefined);
      }
      return undefined;
    }
    case "goTo": {
      if (state.journey === undefined || action.page === state.navigation.page) {
        return undefined;
      }
      const trace = kernelFormTestOpCurrent(state).outcome.trace;
      if (trace !== undefined && journeyReachable(trace, state.navigation.completed, action.page)) {
        kernelFormTestServerMove(state.navigation, action.page, false);
      }
      return undefined;
    }
    case "change": {
      const judged = kernelFormTestOpCurrent(state);
      const ownership = state.journey === undefined ? undefined : kernelFormTestOpFold(state, judged.values).ownership;
      return kernelFormTestServerChange(
        state.journey,
        state.navigation,
        judged.outcome.trace,
        ownership !== undefined ? ownership.pagesOf : undefined,
        kernelFormTestServerComponentIdOf(index, action.path),
        action.path
      );
    }
    case "check": {
      state.submitted = undefined;
      if (state.journey !== undefined && state.navigation.page !== undefined) {
        const checked = kernelFormTestOpCheckPage(state, state.navigation.page);
        state.verdict = checked.blocks ? "refused" : "accepted";
        state.withheld = checked.withheld;
        return undefined;
      }
      const checked = kernelFormTestOpRun(state, undefined);
      state.shown = checked.outcome.errors;
      state.withheld = checked.outcome.withheld !== undefined ? checked.outcome.withheld.slice() : undefined;
      state.verdict = kernelFormTestServerAnyBlocking(checked.outcome.errors) ? "refused" : "accepted";
      return undefined;
    }
    case "submit": {
      const judged = kernelFormTestOpRun(state, undefined);
      const outcome = judged.outcome;
      state.shown = outcome.errors;
      state.verdict = outcome.values !== undefined ? "accepted" : "refused";
      state.submitted = outcome.values !== undefined ? Object.assign({}, outcome.values) : undefined;
      state.withheld = outcome.withheld !== undefined ? outcome.withheld.slice() : undefined;
      // A send refused on a review page stays there, as the runtime's `revealErrorPage` does.
      const onReview = kernelFormTestServerOnReview(state.journey, state.navigation.page, outcome.trace);
      if (state.verdict === "refused" && state.journey !== undefined && !onReview) {
        const ownership = kernelFormTestOpFold(state, judged.values).ownership;
        const revealed = kernelFormTestServerRevealPage(outcome.errors, index, ownership !== undefined ? ownership.pagesOf : undefined, outcome.trace);
        if (revealed !== undefined) {
          kernelFormTestServerMove(state.navigation, revealed, false);
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The snapshot an expectation is judged on: the kernel driver's `snapshot`, its messages worded and its layout chosen in the kernel. */
export function kernelFormTestOpSnapshot(state: FormTestOpState, builtins: string[]): FormTestSnapshot {
  const shared = state.shared;
  const index = shared.index;
  const judged = kernelFormTestOpCurrent(state);
  const outcome = judged.outcome;
  const folded = kernelFormTestOpFold(state, judged.values);
  const effective = kernelFormTestServerEffective(folded, outcome.effectiveState);
  const byPath = outcome.values !== undefined ? outcome.values : outcome.submittable !== undefined ? outcome.submittable : {};
  const reasons = kernelFormTestServerUnreplayable(index, outcome, state.today, state.hostContext !== undefined);
  const errors: FormTestSnapshotError[] = [];
  for (let e = 0; e < state.shown.length; e += 1) {
    const error = state.shown[e] as WasmValidationError;
    const worded = kernelFormTestOpCatalogsFor(shared, state.locale);
    const owned = error.componentId !== undefined ? kernelOwn(worded.catalogs, error.componentId) : undefined;
    const translations = kernelOwn(shared.definition as unknown as Record<string, unknown>, "translations");
    errors.push(kernelFormTestServerSnapshotError(error, kernelFormTestOpMessage(error, owned !== undefined ? owned : worded.root, state.locale, translations)));
  }
  const snapshot: FormTestSnapshot = {
    effective,
    required: kernelFormTestServerRequired(folded, effective),
    values: folded.idValues,
    byPath,
    errors,
    rows: kernelFormTestServerRowCounts(state.answers, index.lists),
    unreplayable: reasons,
    pages: state.journey !== undefined ? state.pageOrder.slice() : []
  };
  const traceReason = state.journey !== undefined ? kernelFormTestServerMarkTrace(state.foldJourney, index, folded.ownership, reasons) : undefined;
  if (traceReason !== undefined) {
    kernelFormTestServerCloseReads(index, reasons);
    snapshot.traceUnreplayable = traceReason;
  }
  const verdictReason = kernelFormTestServerVerdictReason(index, reasons, traceReason);
  if (verdictReason !== undefined) {
    snapshot.verdictUnreplayable = verdictReason;
  }
  if (state.journey !== undefined && state.navigation.page !== undefined) {
    snapshot.page = state.navigation.page;
  }
  if (outcome.trace !== undefined) {
    snapshot.trace = outcome.trace;
  }
  if (state.verdict !== undefined) {
    snapshot.verdict = state.verdict;
  }
  if (state.submitted !== undefined) {
    snapshot.submitted = state.submitted;
  }
  if (state.withheld !== undefined) {
    snapshot.withheld = state.withheld.slice();
  }
  if (shared.layouts.length > 0) {
    const chosen = kernelFormTestOpLayout(shared, byPath, state.today, builtins);
    if (chosen !== undefined) {
      snapshot.layout = chosen;
    }
  }
  return snapshot;
}

/**
 * What a scenario's steps come to (the runner's `scenarioOutcome`): any failed step fails it,
 * else any error makes it an error, else one whose every expectation skipped is skipped with the
 * first skip's code, else it passed.
 */
export function kernelFormTestOpOutcome(steps: FormTestStepResult[]): { status: FormTestScenarioStatus; reason?: string } {
  let error = false;
  let expectations = 0;
  let skipped = 0;
  let firstSkip: string | undefined;
  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s] as FormTestStepResult;
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
      skipped += 1;
      if (firstSkip === undefined) {
        firstSkip = step.code;
      }
    }
  }
  if (error) {
    return { status: "error" };
  }
  if (expectations > 0 && skipped === expectations) {
    return firstSkip === undefined ? { status: "skipped" } : { status: "skipped", reason: firstSkip };
  }
  return { status: "passed" };
}

/** A thrown value as the runner words it (`messageOf`). */
export function kernelFormTestOpThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One scenario walked as `runFormTestScenario` walks it over a fresh kernel driver: `skip` first,
 * then the givens, then each statement in order, one snapshot serving a run of expectations and
 * taken again after the next action. A row action the form refuses ends the walk as
 * `action.refused`; anything that throws ends it as `action.failed` or `snapshot.failed`.
 */
export function kernelFormTestOpScenario(scenario: FormTestScenario, shared: FormTestOpShared, builtins: string[]): FormTestScenarioResult {
  if (scenario.skip !== undefined) {
    return { name: scenario.name, status: "skipped", reason: scenario.skip, steps: [] };
  }
  const state = kernelFormTestOpState(shared);
  try {
    const started = kernelFormTestOpStart(state, scenario.givens);
    if (started !== undefined) {
      if ("skip" in started) {
        return { name: scenario.name, status: "skipped", reason: started.skip, steps: [] };
      }
      const failed: FormTestScenarioResult = { name: scenario.name, status: "error", reason: started.error, steps: [] };
      if (started.params !== undefined) {
        failed.params = started.params;
      }
      return failed;
    }
  } catch (_error) {
    return { name: scenario.name, status: "error", reason: "action.failed", steps: [] };
  }
  const steps: FormTestStepResult[] = [];
  let snapshot: FormTestSnapshot | undefined;
  const context = {
    componentIdOf: function (path: string): string | undefined {
      const id = kernelFormTestServerComponentIdOf(shared.index, path);
      if (id !== undefined && path.indexOf("[") === -1 && kernelOwn(shared.index.entryFields, id) === true) {
        return undefined;
      }
      return id;
    },
    typeOf: function (componentId: string): string | undefined {
      const node = kernelOwn(shared.index.nodeById, componentId);
      return node !== undefined ? node.type : undefined;
    },
    evaluate: function (expression: Expression, values: Record<string, unknown>): unknown {
      const evaluation: RuleEvaluationContext = { values, regexCache: { refuseRisky: true } };
      if (state.hostContext !== undefined) {
        evaluation.hostContext = state.hostContext;
      }
      if (state.today !== undefined) {
        evaluation.today = state.today;
      }
      if (shared.functions !== undefined) {
        evaluation.functions = shared.functions;
      }
      return kernelEvaluateExpression(expression, evaluation);
    }
  };
  for (let at = 0; at < scenario.steps.length; at += 1) {
    const statement = scenario.steps[at] as FormTestStatement;
    const acting = statement.kind.indexOf("expect") !== 0;
    try {
      if (acting) {
        snapshot = undefined;
        const refusal = kernelFormTestOpPerform(state, statement as FormTestAction);
        if (refusal !== undefined) {
          const params: Record<string, unknown> = { action: statement.kind, reason: refusal.refused };
          if (refusal.params !== undefined) {
            const keys = Object.keys(refusal.params);
            for (let k = 0; k < keys.length; k += 1) {
              if (keys[k] !== "action" && keys[k] !== "reason") {
                params[keys[k] as string] = refusal.params[keys[k] as string];
              }
            }
          }
          steps.push({ line: statement.line, status: "error", code: "action.refused", params });
          break;
        }
        steps.push({ line: statement.line, status: "ran" });
        continue;
      }
      if (snapshot === undefined) {
        snapshot = kernelFormTestOpSnapshot(state, builtins);
      }
      steps.push(kernelFormTestJudge(statement as FormTestExpectation, snapshot, context));
    } catch (error) {
      steps.push({ line: statement.line, status: "error", code: acting ? "action.failed" : "snapshot.failed", params: { message: kernelFormTestOpThrown(error) } });
      break;
    }
  }
  const outcome = kernelFormTestOpOutcome(steps);
  return outcome.reason === undefined
    ? { name: scenario.name, status: outcome.status, steps }
    : { name: scenario.name, status: outcome.status, reason: outcome.reason, steps };
}

/**
 * The `test` op: a form's tests run on the kernel's reading.
 * `tests` is sidecar text (one or more `test` blocks); absent (or `null`), the definition's own
 * `tests.scenarios` are run, one block per entry. The answer lists every scenario (its entry's
 * `id`, its name, its header line, what it came to and its steps, the runner's shape), the
 * counts, and every parse problem. Refused as `invalid_request`: `tests` that is not text, more
 * than 256 KiB of test text (the sidecar, or the entries together), more than 200 scenarios, a
 * scenario of more than 1,000 statements; and, before any of those is read, a definition past a
 * size cap (`where: "definition"`, `limit`: `kernelInspectDefinition` gates first). No clock: a form that reads the day needs `given today`
 * in each scenario (`scenario.clockUnset`). `functions` and `validators` are the host's plugins,
 * as a run gets them; without them a plugin's rule reads as the run would read it unwired.
 */
export function kernelFormTestOp(
  request: Record<string, unknown>,
  definition: FormDefinition,
  signatures: FormulaFunctionSignature[],
  builtins: string[] | undefined,
  functions?: Record<string, (args: unknown[]) => unknown>,
  validators?: readonly KernelValidator[]
): DefinitionInspectResponse {
  const tests = request.tests;
  if (tests !== undefined && tests !== null && typeof tests !== "string") {
    return kernelInspectError("invalid_request", "The tests are text: one or more test blocks");
  }
  const sidecar = typeof tests === "string";
  const sources: FormTestOpSource[] = sidecar ? [{ text: tests as string }] : kernelFormTestOpEntries(definition);
  let bytes = 0;
  for (let s = 0; s < sources.length; s += 1) {
    bytes += kernelFormTestOpUtf8Bytes((sources[s] as FormTestOpSource).text);
  }
  if (bytes > kernelFormTestOpMaxBytes()) {
    return kernelInspectError(
      "invalid_request",
      "The tests are more than " + kernelFormTestOpMaxBytes() + " bytes of text (" + bytes + ")",
      sidecar ? "tests" : "definition.tests",
      kernelFormTestOpMaxBytes()
    );
  }
  // The names the parser checks a call against are the program's own, as for a run.
  const parsed = kernelFormTestOpParse(sources, sidecar, signatures);
  if (parsed.scenarios.length > kernelFormTestOpMaxScenarios()) {
    return kernelInspectError(
      "invalid_request",
      "The tests hold more than " + kernelFormTestOpMaxScenarios() + " scenarios (" + parsed.scenarios.length + ")",
      "scenarios",
      kernelFormTestOpMaxScenarios()
    );
  }
  for (let c = 0; c < parsed.scenarios.length; c += 1) {
    const scenario = (parsed.scenarios[c] as { scenario: FormTestScenario }).scenario;
    if (scenario.steps.length > kernelFormTestOpMaxSteps()) {
      return kernelInspectError(
        "invalid_request",
        "A scenario holds more than " + kernelFormTestOpMaxSteps() + " statements (" + scenario.steps.length + ", line " + scenario.line + ")",
        "steps",
        kernelFormTestOpMaxSteps()
      );
    }
  }
  const names = Array.isArray(builtins) ? builtins : [];
  const report: FormTestOpReport = { scenarios: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, error: 0 }, problems: parsed.problems as unknown as FormTestOpReport["problems"] };
  if (parsed.scenarios.length > 0) {
    const shared = kernelFormTestOpShare(definition, request.formulaErrors, signatures, functions, Array.isArray(validators) ? validators : []);
    for (let c = 0; c < parsed.scenarios.length; c += 1) {
      const item = parsed.scenarios[c] as { id?: string; scenario: FormTestScenario };
      const result = kernelFormTestOpScenario(item.scenario, shared, names);
      const entry: FormTestOpScenarioReport = { name: result.name, line: item.scenario.line, status: result.status, steps: result.steps };
      if (item.id !== undefined) {
        entry.id = item.id;
      }
      if (result.reason !== undefined) {
        entry.reason = result.reason;
      }
      if (result.params !== undefined) {
        entry.params = result.params;
      }
      report.scenarios.push(entry);
      report.summary[result.status] += 1;
    }
  }
  report.summary.total = report.scenarios.length;
  return { ok: true, op: "test", report };
}

/**
 * The per-request introspection entry: the sandbox program's `__datum_inspect` and
 * the in-process adapter's `inspect` both call this over the parsed request, with the same
 * parser signatures the run gets (the built-ins' plus the wired plugins') and the built-ins'
 * names so the inventory can tell a plugin function apart. Answers one of
 * `public` / `check` / `inspect` ({@link kernelInspectDefinition}), or an `abi_mismatch` /
 * `invalid_request` error; never throws, so a host always gets JSON back. Pure and
 * deterministic: no clock, no randomness, the definition handed in never changed. The `inspect`
 * answer lists every value path the kernel reads ({@link kernelDefinitionPaths}). It also answers
 * `test` ({@link kernelFormTestOp}),
 * which runs the form's tests over the kernel's own run: `functions` and `validators` are the
 * host's plugins as a run gets them, so a scenario over a plugin's rule is judged as a
 * submission would be. A host that passes neither runs the tests as an unwired program would.
 */
export function kernelRunInspect(
  request: unknown,
  signatures?: FormulaFunctionSignature[],
  builtins?: string[],
  functions?: Record<string, (args: unknown[]) => unknown>,
  validators?: readonly KernelValidator[]
): DefinitionInspectResponse {
  try {
    const known = Array.isArray(signatures) ? signatures : kernelBuiltInFunctionSignatures();
    const names = Array.isArray(builtins) ? builtins : undefined;
    const wired = functions !== undefined && functions !== null && typeof functions === "object" ? functions : undefined;
    return kernelInspectDefinition(
      request,
      kernelParseFormula,
      known,
      names,
      kernelDefinitionPaths,
      kernelIsJourney,
      kernelNormalizeDataGrids,
      function (asked: Record<string, unknown>, definition: FormDefinition): DefinitionInspectResponse {
        return kernelFormTestOp(asked, definition, known, names, wired, Array.isArray(validators) ? validators : undefined);
      }
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "The request could not be inspected: " + (error instanceof Error ? error.message : String(error))
      }
    };
  }
}

/** {@link kernelRunInspect} under the name the hosts call it by, beside {@link runKernel}. */
export const runInspect = kernelRunInspect;

/**
 * The complete kernel, in composition order, for adapters that evaluate it as source.
 * Every function above must be here, and every function they call from the modules the
 * kernel shares with the browser runtime: the sandbox program is exactly these declarations
 * spliced into one scope, and a missing entry is an unresolved reference at eval time.
 * Built by a call marked pure: a bundle that never reads the list (the PDF program, the form
 * and builder bundles) drops it, and with it every function only the sandbox program needs
 * (the `check` pass among them).
 */
export const PORTABLE_KERNEL_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = /* @__PURE__ */ (() => [
  kernelSortKeys,
  kernelStableStringify,
  kernelStableKeys,
  kernelStableWrite,
  kernelStableWriteDeep,
  kernelIsArrayIndex,
  kernelUtf8Binary,
  kernelSha256Hex,
  kernelDocumentDigest,
  kernelConfigurationOf,
  kernelIsDataScopeContainer,
  kernelIsValidDataKey,
  kernelDataKeyOf,
  kernelCollectionPathOf,
  kernelGridCopy,
  kernelDataGridNeedsNormal,
  kernelNormalizeDataGrid,
  kernelDataGridsPending,
  kernelNormalizeDataGrids,
  kernelDataGridRowsCap,
  kernelDataGridRowBounds,
  kernelResolveDataGridRowBounds,
  kernelValuePaths,
  kernelKnownKeyShapes,
  kernelKnownValuePaths,
  kernelKeyShape,
  kernelKeyShapeOnce,
  kernelDefinesKey,
  kernelNormalizePath,
  kernelRowListPaths,
  kernelContainerKeys,
  kernelFlattenRows,
  kernelPartitionValues,
  kernelSanitizeValues,
  kernelTreeIndex,
  kernelClaimsData,
  kernelComponentIdsByPath,
  kernelValueIndex,
  kernelDefinitionPaths,
  kernelRuleContext,
  kernelResolveSemanticState,
  kernelMarkRule,
  kernelRuleRequired,
  kernelRuleValid,
  kernelRuleRowBound,
  kernelCollectionOwners,
  kernelReadMayBeWithheld,
  kernelRecomputeCalculations,
  kernelClientDerived,
  kernelPageComponentIds,
  kernelJourneyClockPages,
  kernelFoldSubmission,
  kernelIsPresentationNode,
  kernelIsJourney,
  kernelErrorPassesFold,
  kernelIsSafeSegment,
  kernelTranslationLocaleKey,
  kernelTranslationText,
  kernelCatalogText,
  kernelResolveText,
  // kernelIsEmptyValue travels in ANSWER_KIND_FUNCTIONS (core/schema/answer-kinds.ts).
  kernelCompilePattern,
  kernelReadLengthLimits,
  kernelCountCharacters,
  kernelReadAcceptTokens,
  kernelReadFileLimits,
  kernelFileAttachments,
  kernelMatchesAccept,
  kernelBase64DecodedLength,
  kernelErrorCap,
  kernelFormatFileSize,
  kernelRowFields,
  kernelRowKeyParts,
  kernelRowIndexes,
  kernelRowValues,
  kernelRunFieldConstraints,
  kernelKindsSlot,
  kernelCreateLog,
  kernelFinishLog,
  kernelFrozenCopy,
  kernelValidatorErrorsCopy,
  kernelValidatorFault,
  runKernel,
  // The prepared-definition cache: created by the host, kept between runs on the host's side.
  kernelCreatePreparedCache,
  kernelPrepareDefinition,
  kernelPreparedKey,
  kernelPreparedLookup,
  kernelPreparedStore,
  kernelPreparedGet,
  kernelPreparedIsolate,
  kernelRunInspect,
  // The `test` op: the kernel driver's server half, then the op.
  ...FORM_TEST_KERNEL_DRIVER_FUNCTIONS,
  kernelFormTestOpMaxBytes,
  kernelFormTestOpMaxScenarios,
  kernelFormTestOpMaxSteps,
  kernelFormTestOpUtf8Bytes,
  kernelFormTestOpEntries,
  kernelFormTestOpProblem,
  kernelFormTestOpParse,
  kernelFormTestOpMessagesEn,
  kernelFormTestOpEngineCodes,
  kernelFormTestOpHostWordedCodes,
  kernelFormTestOpDefaultMessage,
  kernelFormTestOpParameterless,
  kernelFormTestOpInterpolate,
  kernelFormTestOpOwnMessages,
  kernelFormTestOpCatalogs,
  kernelFormTestOpCatalogsFor,
  kernelFormTestOpMessage,
  kernelFormTestOpLocales,
  kernelFormTestOpFinite,
  kernelFormTestOpLayoutUsable,
  kernelFormTestOpEvaluable,
  kernelFormTestOpLayout,
  kernelFormTestOpWire,
  kernelFormTestOpShare,
  kernelFormTestOpState,
  kernelFormTestOpRun,
  kernelFormTestOpCurrent,
  kernelFormTestOpAnswersChanged,
  kernelFormTestOpCheckPage,
  kernelFormTestOpFold,
  kernelFormTestOpRowBounds,
  kernelFormTestOpStart,
  kernelFormTestOpPerform,
  kernelFormTestOpSnapshot,
  kernelFormTestOpOutcome,
  kernelFormTestOpThrown,
  kernelFormTestOpScenario,
  kernelFormTestOp,
  // The modules the kernel shares with the browser runtime.
  ...EXPRESSION_EVALUATOR_FUNCTIONS,
  ...CALCULATION_CYCLE_FUNCTIONS,
  // The formula parser, the definition compiler and the introspection entry.
  ...FORMULA_FUNCTIONS,
  ...COMPILE_FUNCTIONS,
  ...INSPECT_FUNCTIONS,
  // The structure of a definition, answered by the `check` op.
  ...STRUCTURE_FUNCTIONS,
  // The formula function library's groups, which the evaluator dispatches to.
  ...TEXT_FUNCTIONS,
  ...NUMBER_FUNCTIONS,
  ...LIST_FUNCTIONS,
  ...DATE_FUNCTIONS,
  ...SEMANTIC_STATE_FUNCTIONS,
  computeEffectiveNodeState,
  ...SUBMITTABLE_FOLD_FUNCTIONS,
  ...JOURNEY_PATH_FUNCTIONS,
  ...ANSWER_KIND_FUNCTIONS,
  // The engine's types and the base a definition's `kinds` map gives any other type.
  ...COMPONENT_KIND_FUNCTIONS,
  // Choice answers held to their options.
  ...PORTABLE_OPTIONS_FUNCTIONS,
  // The form-test parser and judge the `test` op walks a scenario with.
  ...FORM_TEST_PARSE_FUNCTIONS,
  ...FORM_TEST_RUN_FUNCTIONS
])();
