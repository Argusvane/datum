import type { AccessibilityConfiguration, FormDefinition, LocalizationConfiguration } from "../../core/schema/types.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import {
  readJourneys,
  type Journey,
  type JourneyConfiguration,
  type JourneyHostChoice
} from "../../core/schema/journey.js";
import type {
  JourneyNavigationResult,
  JourneyServerValidator,
  JourneyTrace,
  JourneyValidationRequest,
  JourneyView
} from "../../core/journey/journey-types.js";
import type { PresentationIndex } from "../../core/journey/presentation.js";
import { kernelJsonAnswers, kernelOwn } from "../../core/state/submittable-fold.js";
// The journey functions (the path, the presentation index, the server-check helpers) are asked
// of the runtime's journey engine, never imported here: the renderer entry carries
// this module and loads the engine on its own.
import {
  defaultJourneyEngine,
  type ActiveJourney,
  type JourneyChecks,
  type JourneyEngine,
  type JourneyNavigation,
  type PageChangeHookOutcome
} from "./journey-engine.js";
import type {
  AfterSubmitHookContext,
  AgentProvenance,
  FormHooks,
  BeforeSubmitHookContext,
  BeforePageChangeHookContext
} from "../../core/events/hooks.js";
import { EventBus } from "../../core/events/event-bus.js";
import {
  FormEventType,
  type SetValueOptions,
  type ValidationCompletedEventData,
  type ValidationFailedEventData,
  type ValidationPendingChangedEventData,
  type ValidationStartedEventData
} from "../../core/events/event-types.js";
import { mergeFormHooks, runHookSeries, runValueTransforms } from "../../core/events/hooks.js";
import { FormStateStore, ownValue, type FormState } from "../../core/state/form-state.js";
import { declaredDefaultLocale, supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import { readDraft } from "./draft-read.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import { applyHiddenValuePolicy } from "../../core/state/hidden-value-policy.js";
import { SCALAR_ANSWER_TYPES, checkboxAnswer, checkboxesAnswer, isScalarAnswer, sameAnswer } from "../../core/state/answer-shape.js";
import { mintSubmissionKey } from "./submission-key.js";
import { parseComponentPath, stringifyComponentPath } from "../../core/tree/component-path.js";
import { ComponentTree, assertAcyclicComponentTree } from "../../core/tree/component-tree.js";
import { buildRowKeys, collectionPathOf } from "../../core/tree/data-scope.js";
import { CollectionRuntime } from "./collection-runtime.js";
import type { JourneyActionOutcome, JourneyActionPage } from "./journey/journey-action.js";
import { readTypedMonth } from "../../render/web-component/typed-answers.js";
import type { CollectionOperations } from "../../core/schema/collection.js";
import { DATA_GRID_ROWS_CAP, dataGridSettingsOf, isDataGrid, normalizeDataGrids, rowOperationsOf } from "../../core/schema/data-grid.js";
import { kernelRowFields } from "../../validation/wasm/portable-kernel.js";
import {
  RuntimeOrchestrator,
  type SemanticStateResolver
} from "./runtime-orchestrator.js";
import { DraftError, type DraftStore, type FormDraftSummary } from "../../persistence/core/draft-store.js";
import {
  assertDraftCompatible,
  type DraftCompatibilityPolicy
} from "../../persistence/core/draft-compatibility.js";
import {
  canonicalizeSubmission,
  serializeCanonicalSubmission,
  signedCanonicalOf,
  type CanonicalSubmission,
  type SubmissionVersionContext
} from "../../core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../../core/submission/submission-modes.js";
import type { SubmissionHandlerDefinition } from "../../core/submission/submission-handler.js";
import type { SubmissionHandlerRegistry } from "../../registry/submission/submission-handler-registry.js";
import {
  DEFAULT_SUBMISSION_SIGNING_FORMAT,
  normalizeSigningFormat,
  signingStatementOf,
  type SignedSubmissionDocument,
  type SigningProvider,
  type SignatureResult,
  type SignatureParticipant,
  type SubmissionSigningFormat,
  type SubmissionSigningOptions
} from "../../core/submission/signing.js";
import { assertEnvelopeComplete } from "../../core/submission/envelope-completeness.js";
import { SIGNATURE_COMPONENT_TYPE } from "../../core/schema/signature.js";
import type { ComponentRegistry } from "../../registry/components/component-registry.js";
import type { PdfRenditionRegistry } from "../../registry/pdf/pdf-rendition-registry.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import type {
  ComponentDefinition,
  DataSourceResult,
  DataSourceRuntime,
  FormPlugin,
  TranslationCatalog,
  ValidationContext,
  ValidationResult
} from "../../core/schema/contracts.js";
import type { FormError, HostError } from "../../core/errors/form-error.js";
import type { ComponentNode, ComponentPath } from "../../core/schema/types.js";
import type { FormDraft } from "../../persistence/core/draft-store.js";
import { PluginLifecycle } from "../../plugins/lifecycle/plugin-lifecycle.js";
import { PluginPlatform, type PluginPlatformResult } from "../../plugins/platform/plugin-platform.js";
import { ValidationPipeline, type ValidationPipelineResult } from "../../validation/core/validation-pipeline.js";
import { PathValidationRuns, type PathRunOutcome } from "./path-validation-runs.js";
import { readValidateOnSetting } from "../../core/schema/validate-on-setting.js";
import type { FieldConstraintsContext } from "../../validation/core/field-constraints.js";
import type { FieldInputState } from "../../core/schema/answer-kinds.js";
import { ErrorStore } from "../../validation/core/error-store.js";
import {
  WasmValidationHost,
  type WasmSandboxPolicy,
  type WasmSubmissionContext,
  type WasmSubmissionOutcome,
  type WasmLogLevel,
  type WasmUnknownFieldsMode
} from "../../validation/wasm/wasm-validation-host.js";
import { kernelOptionChoiceOf, kernelOptionQuestions, type KernelOptionSnapshot } from "../../validation/wasm/portable-options.js";
import { ServerValidationRunner } from "../../validation/server/server-validation.js";
import type { PluginRegistry } from "../../registry/plugins/plugin-registry.js";
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { FormulaFunctionSignature, FormulaProblem } from "../../core/expressions/formula-types.js";
import { kernelCompileDefinition, kernelComponentTooDeep, kernelComponentTreeFault, kernelMaxComponentDepth, kernelCompileJourney, kernelCompilePdf, kernelFormulaPolicy, kernelRiskGuardParser } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import type { FormulaFunctionRegistry } from "../../registry/formula-functions/formula-function-registry.js";

/**
 * The definition the runtime refuses under `formulaErrors: "fail"`: a rule whose formula does
 * not parse, or a scope a rule may not take. `problems` lists each, in document order, as the
 * compile step found them (`kernelCompileDefinition`).
 */
export class FormulaError extends Error {
  public readonly formId: string;
  public readonly problems: FormulaProblem[];

  constructor(formId: string, problems: FormulaProblem[]) {
    super(
      `Form "${formId}" has ${problems.length} formula problem${problems.length === 1 ? "" : "s"}: ` +
        problems.map((problem) => `${problem.where}: ${problem.message}`).join("; ")
    );
    this.name = "FormulaError";
    this.formId = formId;
    this.problems = problems;
  }
}

/**
 * A submit refused because another one, asking for something else, is still in flight: the
 * runtime runs one submission at a time, and only an identical call may join it.
 */
export class SubmitBusyError extends Error {
  public readonly code = "submission.busy";
  public readonly formId: string;
  /** The mode of the submission in flight. */
  public readonly modeId: string;

  constructor(formId: string, modeId: string) {
    super(`Form "${formId}" is already submitting ("${modeId}"); wait for it to finish before submitting again.`);
    this.name = "SubmitBusyError";
    this.formId = formId;
    this.modeId = modeId;
  }
}

/**
 * An answer refused as it is written: a value that is not a scalar (an object, a list, a
 * function) for a field whose control holds one value (`SCALAR_ANSWER_TYPES`: a text box, a text
 * area, a number or date control, a select, a radio group, a lone checkbox), in a row of a
 * collection too. Such a value is no answer a person could give, and the renderer could not draw
 * it. `setValue` throws it, `setValues` lists it among its failures, `addRow` and `addRows`
 * throw it for a new row's cell, and `hydrateFromDraft` leaves such an answer out and reports
 * it, restoring the rest.
 */
export class NonScalarAnswerError extends Error {
  public readonly code = "value.notScalar";
  public readonly formId: string;
  /** The value path written. */
  public readonly path: string;
  public readonly componentId: string;
  public readonly componentType: string;

  constructor(formId: string, path: string, componentId: string, componentType: string) {
    super(`Form "${formId}": "${path}" holds one value (a ${componentType} field); an object, a list or a function cannot be its answer.`);
    this.name = "NonScalarAnswerError";
    this.formId = formId;
    this.path = path;
    this.componentId = componentId;
    this.componentType = componentType;
  }
}

/** What {@link FormRuntime.hydrateFromDraft} restored without: each answer left out, and why. */
export interface DraftRestoreResult {
  dropped: Array<{ path: string; error: NonScalarAnswerError }>;
}

/**
 * Whether two submit calls ask for the same thing: equal plain data all the way down (an element
 * builds its version context afresh on every call), anything else (a function, a class instance)
 * only when it is the very same value.
 */
function sameSubmitRequest(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => sameSubmitRequest(entry, b[index]));
  }
  if (!isPlainData(a) || !isPlainData(b)) {
    return false;
  }
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  const otherKeys = Object.keys(b).filter((key) => b[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => Object.hasOwn(b, key) && sameSubmitRequest(a[key], b[key]));
}

function isPlainData(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A date as the calendar day it falls on where the code runs, `YYYY-MM-DD`: the day a person
 * filling the form would name. Never `toISOString`, which names the UTC day and is a day off
 * in the evening or the morning for everyone east or west of it.
 */
export function localCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year < 1000 ? String(year).padStart(4, "0") : year}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}

/**
 * The name and arity of each formula function a plugin declares (`FormPlugin.formulaFunctions`),
 * as the parser checks a call: what `FormulaFunctionRegistry.signatures()` answers once the
 * plugins are installed, read from the declarations alone.
 */
export function pluginFormulaSignatures(plugins: readonly FormPlugin[]): FormulaFunctionSignature[] {
  const signatures: FormulaFunctionSignature[] = [];
  for (const plugin of plugins) {
    for (const contribution of plugin.formulaFunctions ?? []) {
      const required = contribution.params.filter((param) => !param.endsWith("?")).length;
      signatures.push(
        contribution.variadic
          ? { name: contribution.name, min: contribution.min ?? 0, max: Infinity }
          : { name: contribution.name, min: contribution.min ?? required, max: contribution.params.length }
      );
    }
  }
  return signatures;
}

/**
 * A key as one field of a collection's entry (`items[2].sku` -> entry 2, field `sku`), the
 * index digits as the runtime writes them and below the most rows a grid may hold;
 * `undefined` for any other key.
 */
function entryKeyOf(key: string, collectionPath: string): { index: number; field: string } | undefined {
  const start = collectionPath.length + 1;
  if (!key.startsWith(collectionPath) || key.charAt(start - 1) !== "[") {
    return undefined;
  }
  const close = key.indexOf("]", start);
  const digits = close > start ? key.slice(start, close) : "";
  if (!/^(?:0|[1-9][0-9]*)$/.test(digits) || key.charAt(close + 1) !== "." || close + 2 >= key.length || Number(digits) >= DATA_GRID_ROWS_CAP) {
    return undefined;
  }
  return { index: Number(digits), field: key.slice(close + 2) };
}

/**
 * Whether a host-supplied catalog is a record at all. The type says it is when present, but a
 * JavaScript embedder can hand `null` or a list; that is no catalog (the map words the text),
 * never a throw inside a validation run.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A sandbox outcome as the ABI shapes it: a list of error records, the values (when sent) as one
 * record, and the run log (when sent) as a list.
 */
function isWasmOutcomeShape(value: unknown): value is WasmSubmissionOutcome {
  if (!isRecord(value) || !Array.isArray(value.errors) || !value.errors.every(isRecord)) {
    return false;
  }
  return (value.values === undefined || isRecord(value.values)) && (value.logs === undefined || Array.isArray(value.logs));
}

/** A list of plain objects: rows posted whole at a collection's path (`items: [{ sku: "A" }, {}]`). */
function isRowList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

/**
 * A deep copy of the provenance the element handed `submit`, frozen with its two lists: the hook contexts share it, so one hook pushing a path, or the caller changing
 * its own object after the call, can never change what another hook reads.
 */
function frozenProvenance(agent: AgentProvenance): Readonly<AgentProvenance> {
  const copy = structuredClone(agent);
  Object.freeze(copy.paths);
  Object.freeze(copy.tables);
  return Object.freeze(copy);
}

/**
 * Puts that frozen copy on a hook context as `agent`, a property no hook can delete or replace.
 * Every hook of a series gets the same context object, so a frozen copy on
 * a plain property would still let one hook `delete context.agent` and hide it from the next,
 * the attestation hook included; fixed, the delete or the assignment fails (a
 * TypeError in strict code) as a push onto `paths` does. The context's other keys stay as
 * writable as they always were (a hook may still replace `values`). No provenance, no key.
 */
function withProvenance<T extends { agent?: Readonly<AgentProvenance> }>(context: T, agent: Readonly<AgentProvenance> | undefined): T {
  if (agent !== undefined) {
    Object.defineProperty(context, "agent", { value: agent, enumerable: true, writable: false, configurable: false });
  }
  return context;
}

/**
 * A definition compiled for a runtime: every formula replaced by its tree, in a copy, with
 * the problems found (`kernelCompileDefinition`). The parser checks calls against the
 * built-in functions plus whatever `functions` adds: signatures already worked out, or the
 * plugins whose declarations hold them.
 */
export function compileFormDefinition(
  definition: FormDefinition,
  functions: {
    signatures?: readonly FormulaFunctionSignature[];
    plugins?: readonly FormPlugin[];
    /** `"allow"` lets a literal `matches` pattern of a catastrophic shape compile; default `"refuse"`. */
    riskyPatterns?: "refuse" | "allow" | undefined;
  } = {}
): { definition: FormDefinition; problems: FormulaProblem[]; warnings: FormulaProblem[] } {
  const signatures = [
    ...formulaFunctionSignatures(),
    ...(functions.signatures ?? []),
    ...pluginFormulaSignatures(functions.plugins ?? [])
  ];
  // A definition that is its own ancestor is refused here, with a message, before the kernel's walk.
  assertAcyclicComponentTree(definition.root);
  // A data grid with no collection binding is bound at its id before anything walks the tree:
  // the kernel does the same at the top of its run, so both sides read its rows at one path.
  const root = normalizeDataGrids(definition.root);
  // The form's tree nested past the limit is refused with a message too, the count the sandbox
  // and the server hosts use (root = level 1). A journey page's own
  // nodes are left to the sandbox and `check` (the browser may draw them deeper).
  const deep = kernelComponentTooDeep(root, undefined);
  if (deep !== undefined) {
    throw new Error(`Components nest more than ${kernelMaxComponentDepth()} levels deep (at ${deep}): the validator reads at most ${kernelMaxComponentDepth()}.`);
  }
  // Then what no walk survives, refused as the sandbox refuses it: a node that is no component
  // record, a slot that is no list, or an id on its own ancestor chain (every walk up the
  // parents of such a tree would come back to where it began).
  const fault = kernelComponentTreeFault(root);
  if (fault !== undefined) {
    throw new Error(
      fault.code === "definition.idCycle"
        ? `A component shares an id with one of its own ancestors (at ${fault.where}): a form tree cannot hold that.`
        : `A component or a children slot is not of the shape a form tree has (at ${fault.where}).`
    );
  }
  const compiled = kernelCompileDefinition(root, definition.journey, definition.pdf, kernelParseFormula, signatures, functions.riskyPatterns);
  // The compiled tree is the author's tree and nothing else: the browser and the sandbox kernel
  // validate the same stored definition. A keyboard (`inputmode: "email"`) is a device hint and
  // derives no pattern here; the inspector's Email preset writes one.
  const copy: FormDefinition = { ...definition, root: compiled.definition.root };
  if (definition.journey !== undefined) {
    copy.journey = compiled.definition.journey as JourneyConfiguration;
  }
  if (definition.pdf !== undefined) {
    copy.pdf = compiled.definition.pdf as PdfConfiguration;
  }
  return { definition: copy, problems: compiled.problems, warnings: compiled.warnings ?? [] };
}

/**
 * Runtime-level version identity captured into drafts on save. Mirrors the client half of
 * {@link SubmissionVersionContext} without submission-time server fields.
 */
export interface RuntimeVersionContext {
  formVersion: string;
  schemaVersion: string;
  rendererVersion: string;
}

export interface FormRuntimeDependencies {
  eventBus?: EventBus;
  hooks?: FormHooks;
  validationPipeline: ValidationPipeline;
  submissionModes: SubmissionModeRegistry;
  wasmValidationHost?: WasmValidationHost;
  /**
   * Resolves the deterministic external-data snapshot injected into the wasm validation
   * context: the host gathers whatever data-source results validation needs —
   * the sandbox itself never fetches. Every key must be allowlisted via
   * {@link wasmPolicy}'s `allowedExternalDataKeys` or the run is rejected at the ABI.
   */
  wasmExternalDataProvider?: (context: {
    formId: string;
    values: Record<string, unknown>;
    locale?: string;
  }) => Promise<Record<string, unknown>>;
  /**
   * Policy for wasm validation runs. Privileges must remain all-`false` (the host throws
   * otherwise); this exists so a host can set `allowedExternalDataKeys` for the data its
   * {@link wasmExternalDataProvider} injects. Defaults to `WasmValidationHost.STRICT_POLICY`.
   */
  wasmPolicy?: WasmSandboxPolicy;
  /**
   * Default for what the sandbox does with submitted keys the schema does not define:
   * `"strip"` (silently removed — the default), `"keep"`, or `"reject"` (blocks with
   * `unknown_field` errors). Overridable per call via `submit()`'s `options`.
   */
  wasmUnknownFields?: WasmUnknownFieldsMode;
  /**
   * Default for what the sandbox's run log keeps: `"off"`, `"error"`, `"warn"`
   * (the kernel's own default), `"info"` or `"debug"`. The log comes back on
   * `WASM_VALIDATION_COMPLETED` as `response.logs`. Overridable per call via `submit()`'s
   * `options`.
   */
  wasmLogLevel?: WasmLogLevel;
  serverValidationRunner?: ServerValidationRunner;
  dataSources?: DataSourceRuntime;
  pluginRegistry?: PluginRegistry;
  pluginPlatform?: PluginPlatform;
  /**
   * Post-acceptance submission handlers invoked after `SUBMISSION_COMPLETED`. Handlers
   * contributed by installed plugins (via `pluginPlatform`) are appended to these.
   */
  submissionHandlerRegistry?: SubmissionHandlerRegistry;
  draftStore?: DraftStore;
  versionContext?: RuntimeVersionContext;
  semanticStateResolver?: SemanticStateResolver;
  hostContext?: Record<string, unknown>;
  /** Supplies the service bag passed to server validation hooks (policy-guarded by the runner). */
  serverServicesProvider?: () => Record<string, unknown>;
  /** Required for submission modes with `sign === true`: the default signer, the one a signing mode forces. */
  signingProvider?: SigningProvider;
  /**
   * Further signers a submission may name by id (`SubmitOptions.signWith`, a button's
   * `signature` option): a WebAuthn provider beside a server-side one. The default
   * `signingProvider` is reachable by its id too.
   */
  signingProviders?: SigningProvider[];
  /**
   * The provider every submission signs with when the call names none ("signature required"): a submission signs whether or not its mode does, and a missing
   * provider refuses it (`signing.providerMissing`) — never delivered unsigned. A call's own
   * `signWith` (a button's `signature` option) still wins.
   */
  signWith?: string;
  /**
   * How submissions are signed — what is hashed, where the signatures land, in
   * which canonical text (`"jcs"` by default) — and the signing statement the signer
   * agrees to, signed with the document. The default is embedded, over the whole envelope.
   */
  signing?: SubmissionSigningOptions;
  /** Used to auto-populate `client.components` manifest entries during submit. */
  componentRegistry?: ComponentRegistry;
  /** Which of the host's form versions `hydrateFromDraft` takes a draft from; the schema version must always match. */
  draftCompatibilityPolicy?: DraftCompatibilityPolicy;
  /**
   * The host's translations of the form's texts, sourced by the host — fetched,
   * bundled, read from a database, however it likes — and handed to the runtime ready-made, in
   * the shape of the definition's own `translations` map (locale → kind → owner → property,
   * string leaves). The runtime never fetches translations itself: supplying (or not supplying)
   * this is the whole translation-loading story. Resolution order per text: the catalog's entry
   * for the locale, the definition's own, then the default-language string.
   */
  translationCatalog?: TranslationCatalog;
  /**
   * The PDF layouts this runtime renders under, for a host that keeps them
   * outside the definition — a layout designer editing them while the form runs, a layout
   * library shared by several forms. A function is read on every render, so the layouts
   * may change without rebuilding the runtime (and losing what has been typed). Absent, the
   * definition's own `pdf` block applies.
   */
  pdfConfiguration?: PdfConfiguration | (() => PdfConfiguration | undefined);
  /**
   * The journeys this runtime runs, in place of the definition's own `journey`
   * block — for a builder previewing journeys while they are edited. A function is read on
   * every recompute, so a page or a route may change without rebuilding the runtime. Only a
   * preview should set it: a server judges a submission by the definition's journeys, so a
   * form in service keeps them there.
   */
  journeyConfiguration?: JourneyConfiguration | (() => JourneyConfiguration | undefined);
  /**
   * Which journey the form opens as, when the host says: a journey's id, `"form"`
   * for the whole form on one page, or `"journey"` for the definition's default journey even
   * when the definition opens as a form. Absent, the definition decides. A journey the form
   * does not have is warned about once and the definition decides instead.
   */
  journey?: JourneyHostChoice;
  /**
   * The page the journey opens on — a resume point. Honoured only when the page is reachable
   * (on the path, at or before the first page not yet completed). Nothing is completed when a
   * journey starts, so at first that is the first page alone; a later page is kept until a
   * draft is restored (`hydrateFromDraft`) whose completed pages reach it, and the journey then
   * opens on it rather than on the draft's own page. The person's first move forgets it.
   */
  page?: string;
  /**
   * The host's way to its server for the checks a journey asks for: a page's on
   * Continue (`validation.server`) and the whole journey's when it is submitted
   * (`validation.end: "server"`). The definition says when a check runs; this says how.
   * Without one, a check the journey asks for counts as the server being unavailable (and the
   * console says once how to set one), so a host that forgot the wiring never ships unchecked
   * journeys. {@link FormRuntime.setJourneyServerValidator} replaces it without a rebuild.
   */
  journeyServerValidator?: JourneyServerValidator;
  /**
   * The version context a journey's check stamps into the submission envelope it hands the
   * validator (`document`, which `createFetchJourneyValidator` posts to a Datum host), enriched
   * and canonicalized as {@link FormRuntime.submit} does with its own. Absent: checks carry no
   * envelope. `submit` takes its version context from its caller, never from here.
   */
  submissionVersionContext?: SubmissionVersionContext;
  /**
   * How long a check against the host's server may take before it counts as unavailable, in
   * milliseconds. Absent: 10000. `0`: no limit (the validator's own, if it has one).
   */
  journeyServerValidationTimeoutMs?: number;
  /**
   * The journey machinery this runtime asks: the path, the ownership, a page's view,
   * a move's checks, a server check's key. Absent, the default engine
   * (`setDefaultJourneyEngine`; the Noop one until a host sets another), which has no
   * journeys: a definition that declares some is warned about once and runs as one page.
   * `<datum-form>` passes the engine it loaded; a host building runtimes itself passes
   * `EagerJourneyEngine` or sets it as the default once at startup.
   */
  journeyEngine?: JourneyEngine;
  /**
   * How long a data source may take to answer before it counts as failed, in milliseconds:
   * the request ends with an error naming the source, which the renderer draws
   * under the field and reports as `datum-error`. Absent: 15000. `0`: no limit.
   */
  dataSourceTimeoutMs?: number;
  /**
   * What the runtime does with a rule whose formula does not parse, or a scope a rule may not
   * take: `"fail"` (the default) refuses the definition
   * (the constructor throws a {@link FormulaError}); `"warn"`, the explicit opt-in for preview
   * and staging, drops the rule, says so on the console and publishes `FORMULA_INVALID`.
   * Overrides the form's own `root.configuration.formulaErrors`; absent, the form's word, else
   * `"fail"`. A `submit()` may say otherwise for the sandbox's run
   * (`SubmitOptions.formulaErrors`).
   */
  formulaErrors?: FormulaErrorPolicy;
  /**
   * What the runtime does with a regular expression of a catastrophic shape (a repeat of a repeat
   * such as `(x+)+`, a repeated back-reference; `kernelRegexRisky`): `"refuse"` (the default)
   * reads a literal `matches` pattern as a formula problem (`pattern.risky`, judged by
   * `formulaErrors`) and does not run a field's `pattern` of that shape; `"allow"` runs them.
   * What a submit tells the sandbox, which judges by the same word.
   */
  riskyPatterns?: "refuse" | "allow";
  /**
   * The calendar day the rules read (`today()`, `age()`), as `YYYY-MM-DD`, or a function read
   * at the top of every recompute. Absent: the day where the code runs
   * ({@link localCalendarDate}). What the sandbox is told at submit, so a server given no day
   * of its own judges by the browser's.
   */
  today?: string | (() => string);
  /**
   * Formula functions beyond the plugin platform's: a host wiring functions without
   * a platform registers them here. The platform's registry (`pluginPlatform.formulaFunctions`)
   * is read as well; the two must not share a name.
   */
  formulaFunctions?: FormulaFunctionRegistry;
}

export interface DataSourceResolutionRequest {
  componentId: string;
  sourcePropertyPath?: string;
  query?: Record<string, unknown>;
  /** The locale the source loads in, for a render in another language than the runtime's (`buildRuntimeRenderOutput`'s `locale`); else the runtime's own. */
  locale?: string | undefined;
}

export interface SubmitOptions {
  /**
   * Per-submission override of the sandbox's unknown-submitted-fields policy (see
   * `FormRuntimeDependencies.wasmUnknownFields`). Only meaningful when a
   * `wasmValidationHost` is configured.
   */
  wasmUnknownFields?: WasmUnknownFieldsMode;
  /** Per-submission override of what the sandbox's run log keeps (see `FormRuntimeDependencies.wasmLogLevel`). */
  wasmLogLevel?: WasmLogLevel;
  /** Per-submission override of the sandbox's formula policy (see `FormRuntimeDependencies.formulaErrors`). */
  formulaErrors?: FormulaErrorPolicy;
  /**
   * Sign this submission with the provider of that id — what a button's
   * `signature: "webauthn"` option asks for — whether or not the mode signs. An id no
   * provider carries is refused as `signing.providerMissing`.
   */
  signWith?: string;
  /** Per-submission override of the signing format and statement (see `FormRuntimeDependencies.signing`). */
  signing?: SubmissionSigningOptions;
  /** The component that triggered the submission, handed to the signing provider. */
  trigger?: { componentId?: string };
  /**
   * `"skip"` leaves out the journey's check against the host's server at its end —
   * what a download button asks, so a person offline can still keep their answers. Absent:
   * the check runs whenever the journey asks for it.
   */
  journeyEndCheck?: "skip";
  /**
   * The page's account of the answers the agent tools wrote, as the caller
   * worked it out (the `<datum-form>` element; a runtime driven without one, its agent host).
   * The runtime does not know agents: it puts a frozen copy into the `beforeSubmit` and
   * `afterSubmit` hook contexts as `agent` and nowhere else, not the envelope, the signing
   * request, the value transforms or a draft. Absent, the contexts carry no `agent`.
   */
  agent?: AgentProvenance;
}

export interface SubmitResult {
  accepted: boolean;
  errors: ReturnType<ErrorStore["listAll"]>;
  canonicalSubmission?: CanonicalSubmission;
  signatures?: SignatureResult[];
  /**
   * Under the `"wrapper"` placement: the document to deliver — the envelope untouched
   * as `payload`, the signatures beside it. Absent under `"embedded"`, where the signatures are
   * on `canonicalSubmission` itself.
   */
  signed?: SignedSubmissionDocument;
  /**
   * Delivery failures from post-acceptance submission handlers. Present only when a handler
   * threw; the submission is still `accepted: true` (delivery failure does not un-accept).
   */
  handlerErrors?: Array<{ id: string; message: string }>;
  /**
   * The attempt's key, on an accepted submission: a version 4 UUID minted when the
   * attempt started, the same for a second call that joined it. What the page sends beside the
   * document in the receiving service's body, and sends again unchanged when it retries the
   * delivery, so the service keeps one record per attempt rather than one per set of answers.
   */
  submissionKey?: string;
}

/** What {@link FormRuntime.checkValues} is asked: a page to keep to, and the sandbox overrides `submit` takes. */
export interface CheckValuesOptions extends Pick<SubmitOptions, "wasmUnknownFields" | "wasmLogLevel" | "formulaErrors"> {
  /**
   * A page of the running journey: only the errors on its components are kept, as
   * `validate({ page })` keeps them, and of the sandbox's those on no component too, bar
   * `journey.exit` (the exit is the path's verdict, not the page's). Absent: the whole form,
   * with an exit path refused first, as `submit` refuses it.
   */
  page?: string;
}

/** What {@link FormRuntime.checkValues} found. */
export interface CheckValuesResult {
  /** Whether a submit over these answers would be refused: an error that blocks was found. */
  refused: boolean;
  /**
   * The errors the check that refused raised, as `submit` returns them: the pipeline's, the
   * exit's or the sandbox's. With nothing refused, the pipeline's and the sandbox's that do not
   * block (warnings, information).
   */
  errors: FormError[];
  /** Which check refused: the pipeline (`"validation"`), the journey's exit path, or the sandbox. Absent when nothing did. */
  refusedBy?: "validation" | "journey" | "wasm";
}

/** One run of the sandbox's check, as `submit` and `checkValues` both make it. */
interface WasmCheck {
  /** Its errors after the browser's hidden policy, with `wasm.values-missing` or `wasm.execution_error` as the run came to. */
  errors: FormError[];
  sanitizedValues: Record<string, unknown> | undefined;
  outcome: WasmSubmissionOutcome | undefined;
  executionError: string | undefined;
  externalData: Record<string, unknown> | undefined;
  /** The values it was sent: the hidden-value policy applied, every row drawn whole. */
  requestValues: Record<string, unknown>;
  unknownFields: WasmUnknownFieldsMode | undefined;
  logLevel: WasmLogLevel | undefined;
  startedAt: number;
}

export interface NavigationResult {
  ok: boolean;
  currentStepId: string | undefined;
  reason?: string;
}

/** Absent `dataSourceTimeoutMs`: fifteen seconds. */
const DEFAULT_DATA_SOURCE_TIMEOUT_MS = 15000;

/**
 * The form-level error for a fold that did not settle: rules feeding each other
 * through answers they hide, so there is no one submittable view to judge. Worded by the
 * message catalogs alone.
 */
const FOLD_UNSETTLED_CODE = "fold.unsettled";

/**
 * The form-level error for worked-out values that did not settle: which of their
 * sources show keeps changing with what they write, so there is no one value to submit.
 * Blocks like {@link FOLD_UNSETTLED_CODE}; worded by the message catalogs alone.
 */
const MAP_UNSETTLED_CODE = "map.unsettled";

/**
 * The stage the constraints of a presentation's own fields are reported under:
 * browser-only, run after the pipeline, never part of it — a host's hooks and the sandbox see
 * form values alone. Its errors go when the presentation is left.
 */
const PRESENTATION_STAGE_ID = "presentation-fields";

/**
 * The field-constraints codes that speak about the shape of an answer rather than its
 * presence: what a hidden component whose answer is still submitted is held to —
 * a number or a date that is not one among them, a text that is not a string, a file
 * answer that is no attachment, and a declared or inline size no file has (the kernel's kind
 * checks, which it keeps for a hidden, retained answer; the list is the kernel's
 * `kernelErrorPassesFold` list, and the form-test parity probes play the two against each other).
 * Bounds and the file count are not here: a hidden answer is not held to them.
 */
const ANSWER_SHAPE_CODES: ReadonlySet<string> = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "maxFileSize",
  "fileType",
  "number",
  "date",
  "text",
  "file",
  "fileSize",
  "file.sizeMismatch"
]);

/**
 * Whether an error blocks: any severity but `warning` and `info`. An error with none is an
 * error, and so is one whose severity is none of the three words (a typo is not a pass).
 */
function isBlocking(error: { severity?: string | undefined }): boolean {
  return error.severity !== "warning" && error.severity !== "info";
}

/**
 * A rule that cannot run: a plugin function threw while a rule was evaluated,
 * under `formulaErrors: "fail"`. Blocks every page, like an unsettled fold, and is the same code
 * the kernel raises for a formula it cannot use.
 */
const FORMULA_INVALID_CODE = "formula.invalid";

/** Whether an error says the answers did not settle — the fold's rules, or a presentation's worked-out values — or that a rule could not run, which blocks every page. */
function isFoldUnsettled(error: { code: string; componentId?: string | undefined }): boolean {
  return (error.code === FOLD_UNSETTLED_CODE || error.code === MAP_UNSETTLED_CODE || error.code === FORMULA_INVALID_CODE) && error.componentId === undefined;
}

/**
 * Normalizes a staged/wasm/server validation error into a canonical {@link FormError}.
 * The pipeline models `path` as a string; the error store and navigation model it as a
 * {@link ComponentPath}. Undefined optionals are omitted to satisfy
 * `exactOptionalPropertyTypes`.
 */
/** What one check of a value path judged ({@link FormRuntime.checkPath}): the pipeline's result, the state and context it ran on, and the presentation's own-field errors when asked for. */
interface PathCheck {
  result: ValidationPipelineResult;
  state: FormState;
  context: ValidationContext;
  own: ValidationResult["errors"];
}

/** What one validation run covers ({@link FormRuntime.runValidation}). */
interface RunValidationOptions {
  keep?: (componentId: string) => boolean;
  within?: ReadonlySet<string>;
  idPrefix?: string;
  foldCheck?: boolean;
  stale?: () => boolean;
  /** The submission's own check: its hooks count as ones the submission waits on. */
  forSubmit?: boolean;
}

/** A stage's error path in the engine's one spelling, or undefined for a path that does not parse. */
function normalizedValuePath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  try {
    return stringifyComponentPath(parseComponentPath(path));
  } catch {
    return undefined;
  }
}

function toFormError(error: ValidationResult["errors"][number], id: string): FormError {
  const formError: FormError = {
    id,
    code: error.code,
    stage: error.stage,
    source: error.source
  };
  if (error.componentId !== undefined) {
    formError.componentId = error.componentId;
  }
  if (error.path !== undefined) {
    formError.path = parseComponentPath(error.path);
  }
  if (error.severity !== undefined) {
    formError.severity = error.severity;
  }
  if (error.parameters !== undefined) {
    formError.parameters = error.parameters;
    /*
     * A stage that knows a better message than its code can carry says so in
     * `parameters.message` — an author's own "Use a 6-digit code", for instance. A host
     * `ValidationMessageCatalog` entry for the code still wins over it (see
     * `resolveValidationMessage`), so this adds a fallback rather than taking control of the
     * wording away from the host.
     */
    if (typeof error.parameters.message === "string") {
      formError.message = error.parameters.message;
    }
  }
  return formError;
}

export class FormRuntime {
  private readonly stateStore: FormStateStore;
  private readonly eventBus: EventBus;
  private hooks: FormHooks;
  /** The host's pipeline, with the installed plugins' validators appended (see {@link installedPlugins}). */
  private validationPipeline: ValidationPipeline;
  private readonly submissionModes: SubmissionModeRegistry;
  private readonly wasmValidationHost: WasmValidationHost | undefined;
  private readonly wasmExternalDataProvider:
    | FormRuntimeDependencies["wasmExternalDataProvider"]
    | undefined;
  private readonly wasmPolicy: WasmSandboxPolicy | undefined;
  private readonly wasmUnknownFields: WasmUnknownFieldsMode | undefined;
  private readonly wasmLogLevel: WasmLogLevel | undefined;
  private readonly serverValidationRunner: ServerValidationRunner | undefined;
  private readonly dataSources: DataSourceRuntime | undefined;
  private readonly draftStore: DraftStore | undefined;
  private readonly versionContext: RuntimeVersionContext | undefined;
  private readonly submissionVersionContext: SubmissionVersionContext | undefined;
  private readonly serverServicesProvider: (() => Record<string, unknown>) | undefined;
  private readonly signingProvider: SigningProvider | undefined;
  private readonly signingProviders: SigningProvider[];
  private readonly signingFormat: SubmissionSigningFormat;
  private readonly signingStatement: string | undefined;
  private readonly defaultSignWith: string | undefined;
  private readonly componentRegistry: ComponentRegistry | undefined;
  /** The installed plugins' PDF renditions, from the platform's registry. */
  private readonly pluginPdfRenditions: PdfRenditionRegistry | undefined;
  private readonly draftCompatibilityPolicy: DraftCompatibilityPolicy | undefined;
  private readonly pluginRegistryRef: PluginRegistry | undefined;
  private readonly pluginPlatformRef: PluginPlatform | undefined;
  /** The submission in flight and what it was asked, so a second call can join or be refused. */
  private submitInFlight: { request: readonly [string, SubmissionVersionContext, SubmitOptions]; result?: Promise<SubmitResult> } | undefined;
  /**
   * How many of the host's hooks a submission in flight is waiting on (a hook series or the
   * transforms). A submit asked meanwhile may come from one of them, and joining would have the
   * run wait on itself, so it is refused instead. Delivery is not counted: a double click while
   * the handlers post is the join's very case.
   */
  private submitCallbacksRunning = 0;
  /** Post-acceptance handlers: from `submissionHandlerRegistry` then installed plugins. */
  private readonly submissionHandlers: SubmissionHandlerDefinition[] = [];
  /** What the plugin platform installed for this runtime, when one was given. */
  private installedPluginsResult: PluginPlatformResult | undefined;
  private readonly tree: ComponentTree;
  private readonly orchestrator: RuntimeOrchestrator;
  private readonly errorStore = new ErrorStore();
  private readonly collectionRuntime = new CollectionRuntime();
  /** collectionPath -> its binding metadata. */
  private readonly collections = new Map<
    string,
    { componentId: string; operations: CollectionOperations; itemFields: string[] }
  >();
  /** Host-supplied at construction; see {@link translationCatalog}. */
  private translationCatalogValue: TranslationCatalog | undefined;
  /** Host-supplied at construction; see {@link FormRuntimeDependencies.pdfConfiguration}. */
  private readonly pdfConfigurationSource: FormRuntimeDependencies["pdfConfiguration"];
  /** Host-supplied at construction; see {@link FormRuntimeDependencies.journeyConfiguration}. */
  private readonly journeyConfigurationSource: FormRuntimeDependencies["journeyConfiguration"];
  /** The journey machinery: the dependency, else the default engine at construction. */
  private readonly journeyEngine: JourneyEngine;
  /** See {@link FormRuntimeDependencies.dataSourceTimeoutMs}. */
  private readonly dataSourceTimeoutMs: number;
  /** The last configuration read and its usable journeys, so a recompute does not re-read them. */
  private journeysRead: { configuration: JourneyConfiguration | undefined; journeys: Journey[] } | undefined;
  /** The last PDF override read and its compiled copy, so a render does not compile it again. */
  private pdfRead: { configuration: PdfConfiguration; compiled: PdfConfiguration } | undefined;
  /** The journey's moves: the engine's, bound to this runtime once it is built. */
  private readonly journeyNavigation: JourneyNavigation;
  /** The journey's checks against the host's server: the engine's, bound to this runtime once it is built. */
  private readonly journeyChecks: JourneyChecks;
  /**
   * Each stored server error (a host's `setErrors`, a page's check, the end check) -> its
   * field's answers when it was stored. The error stands through the page's own re-validation
   * until the answer changes: the server said it, and only the server unsays it.
   */
  private readonly serverErrorAnswers = new WeakMap<FormError, string>();
  /** The form-level errors a page's check left, owned by that page: gone when the page changes. */
  private readonly pageOwnedErrors = new WeakSet<FormError>();
  /** Each field of a repeating section's entries -> its key within an entry, read once when needed. */
  private rowKeys: Map<string, string> | undefined;
  /** What the controls know that the stored values cannot say, by value path ({@link setInputState}). */
  private readonly inputStates = new Map<string, FieldInputState>();
  /**
   * Checks of single value paths and per-field pending state: the path tokens that make an
   * older check of a path stale, the checks still out (a submit and a journey's Continue wait
   * for them), and `validation.pending` in the state, announced as `VALIDATION_PENDING_CHANGED`.
   */
  private readonly pathRuns = new PathValidationRuns((path, pending) => this.pendingChanged(path, pending));
  /** Whether a submission has begun checking the answers: every field then counts as one the person tried to go on from ({@link validatePath}). */
  private submitAttempted = false;
  /**
   * The components a Continue (a journey page's, a steps container's scoped run) has checked:
   * their fields count as ones the person tried to go on from, so {@link validatePath} checks
   * them as they are committed even before an error shows.
   */
  private readonly attemptedComponents = new Set<string>();
  /**
   * After a journey draft is restored, the components of the pages it had already continued from
   * (`completedPagesScope`): attempted too, as if those Continues had been pressed in this session.
   */
  private attemptedOnResume: ((componentId: string) => boolean) | undefined;
  /**
   * The definition as the runtime reads it: the author's, compiled (every formula a tree, in a
   * copy: {@link compileFormDefinition}). The author's object ({@link authored}) is never
   * changed; a host hashes it and hands it to a server as it is.
   */
  private readonly form: FormDefinition;
  /** The definition as the host gave it. */
  private readonly authored: FormDefinition;
  /** The compile step's problems, in document order (empty under a clean definition). */
  private readonly problems: FormulaProblem[];
  /** The policy the compile was judged by: the host's word, else the form's, else `"warn"`. */
  private readonly formulaPolicy: FormulaErrorPolicy;
  /** The host's own word on the policy, when it gave one: what a submit tells the sandbox. */
  private readonly hostFormulaErrors: FormulaErrorPolicy | undefined;
  /** The host's word on risky regular expressions (`FormRuntimeDependencies.riskyPatterns`), when it gave one. */
  private readonly hostRiskyPatterns: "refuse" | "allow" | undefined;
  /** The plugin formula functions on every rule context, by name. */
  private readonly formulaFunctionsByName: Record<string, (args: unknown[]) => unknown>;
  /** The parser's signatures: the built-ins' plus the wired plugins'. */
  private readonly signatures: FormulaFunctionSignature[];
  /** The day the rules read; see {@link today}. */
  private readonly todayOf: () => string;
  /** What `host.` reads, when the host supplied it (`deps.hostContext`, {@link setHostContext}); see {@link hostContext}. */
  private hostContextValue: Record<string, unknown> | undefined;

  constructor(
    definition: FormDefinition,
    deps: FormRuntimeDependencies
  ) {
    this.authored = definition;
    // First of all: the recompute below asks for the active journey, which asks the engine.
    this.journeyEngine = deps.journeyEngine ?? defaultJourneyEngine();
    // A default that is not a non-blank string is as if unwritten, as every reader of it takes it.
    this.stateStore = new FormStateStore(declaredDefaultLocale(definition.localization) ?? "en");
    this.eventBus = deps.eventBus ?? new EventBus();
    this.hooks = deps.hooks ?? {};
    this.validationPipeline = deps.validationPipeline;
    this.submissionModes = deps.submissionModes;
    this.wasmValidationHost = deps.wasmValidationHost;
    this.hostContextValue = deps.hostContext;
    this.wasmExternalDataProvider = deps.wasmExternalDataProvider;
    this.wasmPolicy = deps.wasmPolicy;
    this.wasmUnknownFields = deps.wasmUnknownFields;
    this.wasmLogLevel = deps.wasmLogLevel;
    this.serverValidationRunner = deps.serverValidationRunner;
    this.dataSources = deps.dataSources;
    this.draftStore = deps.draftStore;
    this.versionContext = deps.versionContext;
    this.submissionVersionContext = deps.submissionVersionContext;
    this.serverServicesProvider = deps.serverServicesProvider;
    this.signingProvider = deps.signingProvider;
    this.signingProviders = deps.signingProviders ?? [];
    this.signingFormat = deps.signing ? normalizeSigningFormat({ ...DEFAULT_SUBMISSION_SIGNING_FORMAT, ...deps.signing }) : DEFAULT_SUBMISSION_SIGNING_FORMAT;
    this.signingStatement = signingStatementOf(deps.signing?.statement);
    this.defaultSignWith = deps.signWith !== undefined && deps.signWith !== "" ? deps.signWith : undefined;
    this.componentRegistry = deps.componentRegistry;
    this.pluginPdfRenditions = deps.pluginPlatform?.pdfRenditions;
    this.draftCompatibilityPolicy = deps.draftCompatibilityPolicy;
    this.pluginRegistryRef = deps.pluginRegistry;
    this.pluginPlatformRef = deps.pluginPlatform;
    this.pdfConfigurationSource = deps.pdfConfiguration;
    this.journeyConfigurationSource = deps.journeyConfiguration;
    const sourceTimeout = deps.dataSourceTimeoutMs;
    this.dataSourceTimeoutMs =
      typeof sourceTimeout === "number" && Number.isFinite(sourceTimeout) && sourceTimeout >= 0 ? sourceTimeout : DEFAULT_DATA_SOURCE_TIMEOUT_MS;
    if (deps.submissionHandlerRegistry) {
      this.submissionHandlers.push(...deps.submissionHandlerRegistry.listLatest());
    }
    const dayDep = deps.today;
    this.todayOf = typeof dayDep === "function" ? dayDep : dayDep !== undefined ? () => dayDep : () => localCalendarDate(new Date());

    // The plugins first: their formula functions must be known before the definition is
    // compiled, since the parser checks every call against the functions it knows.
    this.installPlugins(deps, definition.id);
    const functions: Record<string, (args: unknown[]) => unknown> = {
      ...(deps.formulaFunctions?.functions() ?? {}),
      ...(this.installedPluginsResult?.mergedFormulaFunctions ?? {})
    };
    this.formulaFunctionsByName = functions;
    this.signatures = [
      ...formulaFunctionSignatures(),
      ...(deps.formulaFunctions?.signatures() ?? []),
      ...(deps.pluginPlatform?.formulaFunctions?.signatures() ?? [])
    ];

    // The compile point: a copy of the definition with every formula a tree, before
    // anything reads a rule. The author's object stays exactly as it was given.
    this.hostRiskyPatterns = deps.riskyPatterns;
    const compiled = compileFormDefinition(definition, {
      signatures: this.signatures.slice(formulaFunctionSignatures().length),
      riskyPatterns: deps.riskyPatterns
    });
    this.form = compiled.definition;
    this.problems = compiled.problems;
    // Findings that never refuse a run (a condition that is no yes-or-no): one line each, like a
    // formula warning, so a form that holds nothing by strict truthiness says why.
    for (const warning of compiled.warnings) {
      console.warn(`[FormRuntime] Form "${definition.id}": ${warning.where}: ${warning.message}`);
    }
    this.formulaPolicy = kernelFormulaPolicy(definition.root.configuration, deps.formulaErrors);
    this.hostFormulaErrors = deps.formulaErrors;
    if (this.problems.length > 0) {
      if (this.formulaPolicy === "fail") {
        throw new FormulaError(definition.id, this.problems);
      }
      this.reportFormulaProblems(this.problems, "definition");
    }
    const form = this.form;

    this.tree = new ComponentTree(form.root);
    this.errorStore.setTree(this.tree);
    this.registerCollections();
    // A data grid opens with its starting rows, before the first recompute reads them.
    this.seedInitialRows();
    this.orchestrator = new RuntimeOrchestrator(this.tree, {
      eventBus: this.eventBus,
      formId: form.id,
      riskyPatterns: this.hostRiskyPatterns,
      semanticStateResolver: deps.semanticStateResolver,
      hostContext: deps.hostContext,
      applyComputedValue: (componentId, value) => {
        this.stateStore.setComputedValue(parseComponentPath(componentId), value);
      },
      journey: () => this.activeJourney()?.fold,
      presentation: () => this.activeJourney()?.presentation,
      recordWritten: (targetPath, value, held) => this.stateStore.setJourneyWritten(targetPath, value, held),
      today: () => this.today(),
      functions,
      signatures: this.signatures,
      // A running presentation's worked-out values and overlay are this engine's.
      journeyEngine: this.journeyEngine
    });
    // The journey's checks against the host's server, then its moves, which
    // hold them. What they change stays this runtime's — the state, the events, the hooks, the errors.
    this.journeyChecks = this.journeyEngine.checks({
      engine: this.journeyEngine,
      formId: form.id,
      eventBus: this.eventBus,
      previewed: this.journeyConfigurationSource !== undefined,
      validator: deps.journeyServerValidator,
      timeoutMs: deps.journeyServerValidationTimeoutMs,
      effectiveValues: () => this.orchestrator.effectiveValues(),
      formVersion: () => this.versionContext?.formVersion ?? this.form.version,
      locale: () => this.stateStore.snapshot().locale,
      document: (request) => this.journeyCheckDocument(request),
      pageComponents: (pageId) => this.pageComponentIds(pageId),
      hasComponent: (componentId) => this.tree.find(componentId) !== undefined,
      componentIdForValuePath: (path) => this.componentIdForValuePath(path),
      fromHostErrors: (errors, idPrefix, stage) => this.fromHostErrors(errors, idPrefix, stage),
      storePageCheck: (members, errors) => this.storePageCheck(members, errors),
      showPageUnavailable: (error) => this.showPageUnavailable(error),
      rememberServerErrors: (errors) => this.rememberServerErrors(errors)
    });
    // The journey's moves, before the first recompute: it asks for the active journey.
    this.journeyNavigation = this.journeyEngine.navigation({
      engine: this.journeyEngine,
      formId: form.id,
      root: form.root,
      stateStore: this.stateStore,
      orchestrator: this.orchestrator,
      eventBus: this.eventBus,
      formulaFunctions: this.formulaFunctionsByName,
      riskyPatterns: this.hostRiskyPatterns,
      formulaErrors: this.formulaPolicy,
      journeys: () => this.journeys(),
      journeyConfiguration: () => this.journeyConfiguration(),
      recompute: () => this.recompute(),
      validate: (options) => this.validate(options),
      runBeforePageChange: (context) => this.runBeforePageChange(context),
      clearInputStates: () => this.inputStates.clear(),
      pageHoldsBlockingError: (pageId, withServerErrors) => this.pageHoldsBlockingError(pageId, withServerErrors),
      dropErrorsOffPath: () => this.dropErrorsOffPath(),
      dropPageOwnedErrors: () => this.dropPageOwnedErrors(),
      dropPresentationErrors: (left) => this.dropPresentationErrors(left),
      inputStates: () => this.inputStatesContext(),
      checks: this.journeyChecks
    });

    // Seed the effective-state cache before any host interaction.
    this.orchestrator.recompute(this.stateStore.snapshot());

    // The journey the form opens as: the host's choice over the definition's.
    // Started here, synchronously, so the first render already shows its first page.
    // A runtime with no journey engine runs a definition that has journeys as one page, and
    // says so once: the journeys are not quietly dropped.
    // Not when the host chose the whole form ("form") or none ("off"): that is an explicit
    // one-page choice, and the element says so itself once.
    if (
      this.journeyEngine.kind === "none" &&
      deps.journey !== "form" &&
      deps.journey !== "off" &&
      readJourneys({ journey: this.journeyConfiguration() }).length > 0
    ) {
      console.warn(
        `[FormRuntime] Form "${form.id}" has journeys, but this runtime has no journey engine, so it runs as one page. ` +
          "Pass the journeyEngine dependency, or call setDefaultJourneyEngine(EagerJourneyEngine) once at startup."
      );
    }
    const opening = this.journeyEngine.selection(this.journeyConfiguration(), deps.journey);
    if (opening.unknownJourneyId !== undefined) {
      console.warn(
        `[FormRuntime] Form "${form.id}" has no journey "${opening.unknownJourneyId}": ${
          opening.selection.kind === "journey"
            ? `opening its journey "${opening.selection.journeyId}" instead`
            : "opening the whole form instead"
        }.`
      );
    }
    if (opening.selection.kind === "journey") {
      this.startJourney(opening.selection.journeyId, deps.page !== undefined ? { pageId: deps.page } : {});
    }

    this.eventBus.publish({
      id: "form_initialized",
      type: FormEventType.FORM_INITIALIZED,
      timestamp: Date.now(),
      source: "runtime",
      formId: form.id
    });

    this.translationCatalogValue = deps.translationCatalog;
  }

  /** The plugin platform's install, or the plain registry's lifecycle: hooks, handlers, validators, events. */
  private installPlugins(deps: FormRuntimeDependencies, formId: string): void {
    if (deps.pluginPlatform) {
      const result = deps.pluginPlatform.installAndInitialize({ environment: "browser" });
      this.installedPluginsResult = result;
      // Plugin-contributed runtime hooks run after host hooks.
      this.hooks = mergeFormHooks(this.hooks, result.mergedHooks);
      // Plugin-contributed submission handlers run after any host-registered ones.
      this.submissionHandlers.push(...result.mergedSubmissionHandlers);
      // Plugin-contributed validators run after the host's stages (deterministic ones first,
      // as the pipeline orders them).
      this.validationPipeline = this.validationPipeline.withStages(result.mergedValidators);
      for (const incompatible of result.incompatibilities) {
        this.eventBus.publish({
          id: `plugin_incompatible_${incompatible.pluginId}`,
          type: FormEventType.PLUGIN_INCOMPATIBLE,
          timestamp: Date.now(),
          source: "plugin",
          formId,
          data: incompatible
        });
      }
      this.eventBus.publish({
        id: "plugins_initialized",
        type: FormEventType.PLUGINS_INITIALIZED,
        timestamp: Date.now(),
        source: "plugin",
        formId,
        data: result
      });
    } else if (deps.pluginRegistry) {
      const lifecycle = new PluginLifecycle(deps.pluginRegistry.listLatest(), {
        onError: (error) => {
          this.eventBus.publish({
            id: "plugin_initialize_failed",
            type: FormEventType.PLUGIN_INITIALIZE_FAILED,
            timestamp: Date.now(),
            source: "plugin",
            formId,
            data: {
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
      });

      const result = lifecycle.initialize({ environment: "browser" });
      this.eventBus.publish({
        id: "plugins_initialized",
        type: FormEventType.PLUGINS_INITIALIZED,
        timestamp: Date.now(),
        source: "plugin",
        formId,
        data: result
      });
    }
  }

  /**
   * Says what the compile found, under `"warn"`: one console line per problem, and one
   * `FORMULA_INVALID` event carrying them all. `source` names what was compiled: the
   * definition, or a host's journey or PDF override.
   */
  private reportFormulaProblems(problems: FormulaProblem[], source: "definition" | "journeys" | "pdf"): void {
    for (const problem of problems) {
      console.warn(`[FormRuntime] Form "${this.authored.id}" ${source}: ${problem.where}: ${problem.message}`);
    }
    this.eventBus.publish({
      id: `formula_invalid_${source}_${Date.now()}`,
      type: FormEventType.FORMULA_INVALID,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.authored.id,
      data: { problems }
    });
  }

  /**
   * The calendar day the rules read (`today()`, `age()`), `YYYY-MM-DD`: the host's
   * (`FormRuntimeDependencies.today`), else the day where the code runs. Read once per
   * recompute by the orchestrator, and told to the sandbox at submit.
   */
  public today(): string {
    return this.todayOf();
  }

  /**
   * What the rules' `host.` paths read, as the host supplied it (`FormRuntimeDependencies.hostContext`,
   * {@link setHostContext}); `undefined` when it supplied none, and then `host.` reads nothing.
   */
  public hostContext(): Record<string, unknown> | undefined {
    return this.hostContextValue;
  }

  /**
   * Replaces what `host.` reads and works the form out again in place: every visibility,
   * requiredness, check, calculation and journey placement follows the new values, and the
   * answers typed so far stay. `undefined` clears it (`host.` reads nothing). The values are the
   * page's, for display: they travel in no submission, and a server judges with its own.
   */
  public setHostContext(hostContext: Record<string, unknown> | undefined): void {
    this.hostContextValue = hostContext;
    this.orchestrator.setHostContext(hostContext);
    this.recompute();
  }

  /**
   * The definition as the host gave it: the author's object, never changed and never a copy,
   * so a host that hashes, stores or hands on what it gets back has exactly what it handed in
   * (a server judges the same bytes). The runtime itself reads a compiled copy of it (every
   * formula a tree: {@link compileFormDefinition}), which {@link formRoot}, the component tree
   * and the journeys expose; that copy is not this.
   */
  public definition(): FormDefinition {
    return this.authored;
  }

  /** The problems the definition's compile found, in document order; empty under a clean definition. */
  public formulaProblems(): readonly FormulaProblem[] {
    return this.problems;
  }

  /** The policy the definition's formulas were judged by (`FormRuntimeDependencies.formulaErrors`, else the form's, else `"fail"`). */
  public formulaErrorPolicy(): FormulaErrorPolicy {
    return this.formulaPolicy;
  }

  /** The host-supplied translation catalog (`deps.translationCatalog`), if any. */
  public translationCatalog(): TranslationCatalog | undefined {
    return this.translationCatalogValue;
  }

  /**
   * The definition's own translations (`FormDefinition.translations`), if it has any:
   * what the renderer words every authored text from, beside {@link translationCatalog}.
   */
  public translations(): FormTranslations | undefined {
    return this.form.translations;
  }

  /** The form's own `localization` block (default and supported locales), if it declares one. */
  public localization(): LocalizationConfiguration | undefined {
    return this.form.localization;
  }

  /** The form's own `accessibility` block (whether the first error takes focus), if it declares one. */
  public accessibility(): AccessibilityConfiguration | undefined {
    return this.form.accessibility;
  }

  /**
   * The form's own `pdf` block — its PDF layouts — if it declares one, or the
   * host's override, compiled (every layout condition and expression source a tree, in a copy
   * read once per override object; its problems reported under the runtime's policy, never
   * refused: an override is a preview).
   */
  public pdfConfiguration(): PdfConfiguration | undefined {
    const override = this.pdfConfigurationSource;
    if (override === undefined) {
      return this.form.pdf;
    }
    const configuration = typeof override === "function" ? override() : override;
    if (configuration === undefined) {
      return undefined;
    }
    if (this.pdfRead === undefined || this.pdfRead.configuration !== configuration) {
      const problems: FormulaProblem[] = [];
      const compiled = kernelCompilePdf(configuration, kernelRiskGuardParser(kernelParseFormula, this.hostRiskyPatterns), this.signatures, problems, this.hostRiskyPatterns) as PdfConfiguration;
      this.pdfRead = { configuration, compiled };
      if (problems.length > 0) {
        this.reportFormulaProblems(problems, "pdf");
      }
    }
    return this.pdfRead.compiled;
  }

  /**
   * The form's journeys block: the host's override when it gave one
   * ({@link FormRuntimeDependencies.journeyConfiguration}), else the definition's own.
   */
  public journeyConfiguration(): JourneyConfiguration | undefined {
    const override = this.journeyConfigurationSource;
    if (override === undefined) {
      return this.form.journey;
    }
    return typeof override === "function" ? override() : override;
  }

  /**
   * The form's usable journeys, in order. A host's override
   * ({@link FormRuntimeDependencies.journeyConfiguration}) is compiled first, once per
   * configuration object (every page and route condition, every worked-out value a tree, in a
   * copy); its problems are reported under the runtime's policy, never refused, since an
   * override is a preview. The definition's own journeys were compiled with the definition.
   */
  public journeys(): Journey[] {
    const configuration = this.journeyConfiguration();
    if (this.journeysRead === undefined || this.journeysRead.configuration !== configuration) {
      let read = configuration;
      if (this.journeyConfigurationSource !== undefined && configuration !== undefined) {
        const problems: FormulaProblem[] = [];
        read = kernelCompileJourney(configuration, kernelRiskGuardParser(kernelParseFormula, this.hostRiskyPatterns), this.signatures, problems) as JourneyConfiguration;
        if (problems.length > 0) {
          this.reportFormulaProblems(problems, "journeys");
        }
      }
      this.journeysRead = { configuration, journeys: this.journeyEngine.journeys(read) };
    }
    return this.journeysRead.journeys;
  }

  /** The definition's id, which names a submission file and a PDF. */
  public formId(): string {
    return this.form.id;
  }

  /**
   * Where a PDF's rendition lookup looks beyond the engine's built-ins: the
   * registry the component definitions live in, for the renditions a definition declares
   * (`ComponentDefinition.pdf`), and the installed plugins' contributions
   * (`FormPlugin.pdfRenditions`). `renderFormPdf` builds its resolver from these when the
   * host hands it none.
   */
  public pdfRenditionSources(): { components?: ComponentRegistry | undefined; renditions?: PdfRenditionRegistry | undefined } {
    return { components: this.componentRegistry, renditions: this.pluginPdfRenditions };
  }

  /**
   * The component definitions the runtime was built with (the latest of each type in its
   * registry; none without one): what a form element draws a host's or a plugin's own types with
   * (`ComponentDefinition.adapter`). The same array until the runtime is rebuilt.
   */
  public componentDefinitions(): readonly ComponentDefinition[] {
    return (this.componentDefinitionsList ??= this.componentRegistry?.latest() ?? []);
  }

  private componentDefinitionsList: readonly ComponentDefinition[] | undefined;

  /**
   * What the plugin platform installed for this runtime — the ids installed, initialized
   * and rejected, and the merged contributions (hooks, submission handlers, validators, the
   * sandbox modules a host wires into its WASM validation host) — or `undefined` when the
   * runtime was built without a platform.
   */
  public installedPlugins(): PluginPlatformResult | undefined {
    return this.installedPluginsResult;
  }

  public state() {
    return this.stateStore.snapshot();
  }

  public errors() {
    return this.errorStore.listAll();
  }

  /** Per-container `{ own, descendants }` error counts from the last validation. */
  public containerErrorCounts() {
    return this.errorStore.aggregateByContainer();
  }

  /** Error summary (count + component ids) for a wizard step / tab subtree. */
  public stepErrorSummary(stepId: string) {
    return this.errorStore.summaryForStep(stepId);
  }

  public events(): EventBus {
    return this.eventBus;
  }

  /**
   * Effective semantic state for a component from the latest recompute — a form component's
   * from the fold, or, while a presentation runs, one of its own nodes' from the
   * overlay: an alias and a worked-out value's copy take the form field's state, any other own
   * node its own rules' on a page the path takes.
   */
  public effectiveState(componentId: string): EffectiveNodeState | undefined {
    return this.orchestrator.stateOf(componentId)?.effective;
  }

  /**
   * Whether a component is required as of the last recompute: its
   * `configuration.required`, OR its `rules.requiredWhen` holding over the submittable view —
   * the rule adds to the tick, never removes it. Before the hidden-required policy: a hidden
   * field can be required here and still not held to it (`effectiveState`'s `requiredApplies`).
   * A field that is only ticked, with no rule, is not required.
   */
  public isRequired(componentId: string): boolean {
    return this.orchestrator.stateOf(componentId)?.required ?? false;
  }

  /**
   * Effective semantic state for every component from the last recompute (for renderers): the
   * form's components in document order, then — while a presentation runs — its own
   * nodes and reference placeholders in the presentation's order.
   */
  public effectiveStatesMap(): ReadonlyMap<string, EffectiveNodeState> {
    return this.orchestrator.mergedEffectiveStates();
  }

  /**
   * The answers as a submission would carry them, keyed by value path, from the last recompute:
   * the shared fold's submittable view — journey placement and the hidden-value
   * policy applied, calculations included, each answer as its JSON carries it (a calculation's
   * `NaN` as `null`; a cleared answer holds `undefined`, which JSON leaves out). What a PDF
   * layout's `when` reads; a server reads the same answers from the submission it
   * judged. A copy.
   */
  public submittableValues(): Record<string, unknown> {
    return this.orchestrator.effectiveValues();
  }

  /**
   * The answers as stored, keyed by value path, without the ones a presentation's own fields
   * hold: every key of `state().values` but those that start with `@` and that the
   * form does not define. What anything that leaves the browser, or is handed to host code that
   * may send it on, is built from; the hidden-value policy is not applied
   * ({@link submittableValues} applies it). A copy.
   */
  public formValues(): Record<string, unknown> {
    return this.orchestrator.formValues(this.stateStore.snapshot().values);
  }

  /**
   * The answers as stored, form values only, with the hidden-value policy applied: a hidden
   * answer left out of the submission is not here, a cleared one holds `undefined`, a retained
   * one is as typed. Keyed by value path like {@link formValues}, an empty row's keys kept. What
   * a PDF and a printed copy are made from, so neither shows an answer the submission leaves out
   * (the server prints the submission it judged). A copy; the state keeps every answer.
   */
  public printableValues(): Record<string, unknown> {
    return applyHiddenValuePolicy(
      this.formValues(),
      this.orchestrator.effectiveStates(),
      (path) => this.orchestrator.componentIdForPath(path),
      (key) => this.orchestrator.collectionOwnerOf(key)
    );
  }

  /**
   * The running presentation's own answers, keyed by own field id: what its fields
   * that fill no form field hold, as stored under `@<presentation id>.<id>`. They stay in the
   * browser — kept in drafts, never submitted — so a host that wants one reads it here. A field
   * left unanswered is absent; an alias is not listed (its answer is the form field's); `{}`
   * when no presentation runs or it owns no such field.
   */
  public presentationValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const presentation = this.activeJourney()?.presentation;
    if (!presentation) {
      return out;
    }
    const values = this.stateStore.snapshot().values;
    for (const id of presentation.order) {
      const key = kernelOwn(presentation.ownKeys, id);
      const value = key !== undefined ? kernelOwn(values, key) : undefined;
      if (value !== undefined) {
        // Defined, so an id such as `constructor` lands as a key of its own.
        Object.defineProperty(out, id, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    return out;
  }

  /**
   * The index of the running journey's own nodes — its aliases, worked-out values,
   * reference placeholders and where each node stands — or `undefined` when no journey runs or
   * the journey holds component ids alone. Read-only: the runtime's own copy.
   */
  public presentationIndex(): PresentationIndex | undefined {
    return this.activeJourney()?.presentation;
  }

  /**
   * Where the answer of a node the running presentation owns is stored: an alias
   * and a worked-out value's copy at the value path of the form field they fill or show, any
   * other own node at `@<presentation id>.<id>`. `undefined` for a reference's placeholder, for
   * a form component, and when no presentation runs.
   */
  public presentationValuePathOf(id: string): string | undefined {
    const presentation = this.activeJourney()?.presentation;
    if (!presentation) {
      return undefined;
    }
    const kind = kernelOwn(presentation.kindOf, id);
    if (kind === undefined || kind === "reference") {
      return undefined;
    }
    return presentation.keyOf(id) ?? `${presentation.containerId}.${id}`;
  }

  /**
   * What a live journey page is drawn from while the journey holds nodes of its own:
   * the form's root with one more slot, the last
   * (`PRESENTATION_SLOT`, `"@presentation"`), holding the data-scoping container
   * `@<presentation id>` with the presentation's usable own entries — so a tree's own path
   * builder gives every own field `@<presentation id>.<id>`. In it a worked-out value is a
   * read-only copy of the form field it sets (that field's type and configuration under the
   * node's own label, `configuration.presentation = { kind: "worked-out", to }`), and a
   * reference inside an own layout is a placeholder (`type: "journey-field"`,
   * `configuration.componentId`, id `@<presentation id>/ref-<n>`) for the renderer to replace
   * with the form component it names. `tree` is a `ComponentTree` over `root`.
   *
   * `undefined` when no journey runs, or the running one lists component ids alone. For the
   * page being filled in only: a review, a printed copy and a PDF draw {@link formRoot}.
   */
  public journeyRenderRoot(): { root: ComponentNode; tree: ComponentTree } | undefined {
    const active = this.activeJourney();
    const presentation = active?.presentation;
    if (!active || !presentation) {
      return undefined;
    }
    if (active.renderRoot === undefined) {
      const root = this.journeyEngine.renderRoot(this.form.root, presentation);
      active.renderRoot = { root, tree: new ComponentTree(root) };
    }
    return active.renderRoot;
  }

  /**
   * {@link isRequired} for every component but the root, in document order, from the last
   * recompute: `required` OR `requiredWhen`, before the hidden-required policy. What
   * the renderer's required marker reads (`runtime-render-bridge.ts`). While a presentation
   * runs its own nodes follow the form's: an own field by its own Required or
   * Required-when, an alias by its own or the form field's, a worked-out value's copy by the
   * form field's.
   */
  public requiredMap(): ReadonlyMap<string, boolean> {
    return this.orchestrator.mergedRequiredComponents();
  }

  /**
   * The components whose Validate rule (`rules.validWhen`) does not hold over the
   * answers, id -> `true`, from the last recompute: the field-constraints stage's
   * `invalidComponents`, the browser-only twin of {@link requiredMap}. Builder Try it reads it
   * for every kind of session, so a failing rule is flagged the same way in a mode's runtime.
   */
  public invalidMap(): Record<string, boolean> {
    return this.orchestrator.invalidComponents();
  }

  /**
   * Each data grid's row-count bounds from the last recompute, grid id ->
   * `{ minRows, maxRows }`: the fixed bounds of its configuration with its `rules.minRows` /
   * `rules.maxRows` laid over them where they came to a whole number. What the renderer
   * disables Add and Remove at, what {@link addRow} refuses to go past, and what the
   * field-constraints stage counts the rows against (`dataGridRowBounds`).
   */
  public dataGridRowBounds(): Record<string, { minRows: number; maxRows: number | undefined }> {
    return this.orchestrator.dataGridRowBounds();
  }

  /** The runtime's component tree (read model for renderers / error navigation). */
  public componentTree(): ComponentTree {
    return this.tree;
  }

  /**
   * The canonical form root node as the runtime reads it: the compiled copy's root, the same
   * object the component tree, the effective states and the journeys' ownership are built
   * from, so a renderer or a host that walks it and looks nodes up again finds the ones the
   * runtime holds ({@link componentTree}). Its `configuration` objects are the author's own
   * (the compile shares them and copies only `rules` and the children lists). The author's
   * root, for hashing or handing on, is {@link definition}'s.
   */
  public formRoot(): ComponentNode {
    return this.form.root;
  }

  /** Wizard step component ids in document order. */
  public wizardSteps(): string[] {
    return this.wizardStepIds();
  }

  private recompute(changedPaths?: string[]): void {
    // The orchestrator never writes what it is given (frozen-state tests prove it) and keeps
    // nothing of it, so it reads the live store: a snapshot copy per keystroke grew with the form.
    // `RuntimeOrchestrator.recompute` types its parameter as a mutable FormState; the view is read-only.
    this.orchestrator.recompute(this.stateStore.readView() as FormState, changedPaths);
    this.journeyNavigation.reconcile();
  }

  private registerCollections(): void {
    // Each collection's fields within an entry (`sku`, `address.city`), for a binding that lists
    // none: what an empty row holds a key for.
    const rowFields = kernelRowFields(this.form.root);
    for (const node of [this.form.root, ...this.tree.descendantsOf(this.form.root.id)]) {
      const binding = node.collection;
      const collectionPath = collectionPathOf(node);
      if (binding && collectionPath !== undefined) {
        // The one reader of row operations: a grid's from its configuration,
        // a repeating section's from its binding, add and remove but not reorder by default.
        const operations = rowOperationsOf(node);
        const listed = Array.isArray(binding.itemFields) && binding.itemFields.length > 0 ? binding.itemFields : undefined;
        const itemFields =
          listed ??
          Object.keys(rowFields)
            .map((id) => rowFields[id] as { collection: string; suffix: string })
            .filter((field) => field.collection === collectionPath)
            .map((field) => field.suffix.slice(1));
        this.collectionRuntime.initialize({ collectionPath, itemSchema: node, operations });
        this.collections.set(collectionPath, { componentId: node.id, operations, itemFields });
      }
    }
  }

  /**
   * Opens every data grid with its starting rows (`initialRows`) when the answers
   * hold none of its entries: empty rows, each holding a key per field so the row is counted
   * and checked as one (see {@link writeEntryKeys}). Not marked dirty: nobody typed anything.
   */
  private seedInitialRows(): void {
    for (const [collectionPath, entry] of this.collections) {
      const node = this.tree.find(entry.componentId);
      if (!node || !isDataGrid(node) || this.collectionRuntime.count(collectionPath) > 0) {
        continue;
      }
      const initial = dataGridSettingsOf(node).initialRows;
      for (let index = 0; index < initial; index += 1) {
        this.collectionRuntime.addRow(collectionPath, this.emptyRow(collectionPath));
      }
      if (initial > 0) {
        this.writeEntryKeys(collectionPath);
      }
    }
  }

  /** A row with every field of the collection's entries present and unanswered. */
  private emptyRow(collectionPath: string, row: Record<string, unknown> = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of this.collections.get(collectionPath)?.itemFields ?? []) {
      out[field] = undefined;
    }
    for (const key of Object.keys(row)) {
      out[key] = row[key];
    }
    return out;
  }

  /**
   * Gives every entry of a collection a key for each of its fields, `undefined` where it holds
   * no answer: an empty row is then a row to everything that reads the answers by
   * key — the renderer's row count, the field constraints' per-entry checks and row count, the
   * per-row calculations — as it is to the kernel, which is sent the row whole
   * ({@link withRowsWhole}). An undefined answer is left out of everything that crosses JSON.
   */
  private writeEntryKeys(collectionPath: string): void {
    const values = this.stateStore.readView().values;
    const fields = this.collections.get(collectionPath)?.itemFields ?? [];
    const count = this.collectionRuntime.count(collectionPath);
    for (let index = 0; index < count; index += 1) {
      for (const field of fields) {
        const key = `${collectionPath}[${index}].${field}`;
        if (!Object.prototype.hasOwnProperty.call(values, key)) {
          this.stateStore.setComputedValue(parseComponentPath(key), undefined);
        }
      }
    }
  }

  /**
   * Seeds the collection runtime from the entries the answers hold (a draft put back):
   * each collection's rows rebuilt from its `collection[i].field` keys, then a grid with none
   * opened with its starting rows again.
   */
  private reseedCollections(): void {
    const values = this.stateStore.readView().values;
    for (const collectionPath of this.collections.keys()) {
      const rows: Record<string, unknown>[] = [];
      for (const key of Object.keys(values)) {
        const entry = entryKeyOf(key, collectionPath);
        if (entry === undefined) {
          continue;
        }
        while (rows.length <= entry.index) {
          rows.push({});
        }
        (rows[entry.index] as Record<string, unknown>)[entry.field] = values[key];
      }
      this.collectionRuntime.setRows(collectionPath, rows.map((row) => this.emptyRow(collectionPath, row)), { freshKeys: true });
      this.writeEntryKeys(collectionPath);
    }
    this.seedInitialRows();
  }

  /**
   * A collection's rows as the answers hold them: one object per entry the
   * collection runtime counts, each with a key per field of the entry and every
   * `collection[i].field` answer the state holds for it — the per-row calculations' values
   * included, which the orchestrator writes into the state alone. What {@link rows} and the
   * settled change after a row operation report.
   */
  private rowsFromState(collectionPath: string): Record<string, unknown>[] {
    const count = this.collectionRuntime.count(collectionPath);
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(this.emptyRow(collectionPath));
    }
    const values = this.stateStore.readView().values;
    for (const key of Object.keys(values)) {
      const entry = entryKeyOf(key, collectionPath);
      if (entry !== undefined && entry.index < count) {
        (rows[entry.index] as Record<string, unknown>)[entry.field] = values[key];
      }
    }
    return rows;
  }

  /**
   * One row posted whole, read as the runtime keys an entry: a plain object under a
   * key that leads on to fields of the entry (a data-scoping container, `address: { city }`)
   * is read a level further (`address.city`), anything else is the answer, as the kernel reads
   * rows posted whole (`kernelFlattenRows`).
   */
  private flattenRow(collectionPath: string, row: Record<string, unknown>): Record<string, unknown> {
    const fields = this.collections.get(collectionPath)?.itemFields ?? [];
    const out: Record<string, unknown> = {};
    const walk = (prefix: string, object: Record<string, unknown>, depth: number): void => {
      for (const key of Object.keys(object)) {
        const name = prefix === "" ? key : `${prefix}.${key}`;
        const value = object[key];
        if (
          depth < 16 &&
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          fields.some((field) => field.startsWith(`${name}.`))
        ) {
          walk(name, value as Record<string, unknown>, depth + 1);
        } else {
          out[name] = value;
        }
      }
    };
    walk("", row, 0);
    return out;
  }

  /**
   * A collection's rows written whole at its path (`setValues({ items: [{ sku: "A" }, {}] })`,
   * a prefill or a host's record): they become its entries — in the collection
   * runtime and as the state's `items[i].…` keys, a key per field of every row — and no answer
   * is kept at the bare path, so the form draws, checks and posts them as rows.
   */
  private replaceRows(collectionPath: string, list: ReadonlyArray<Record<string, unknown>>): void {
    const rows = list.map((row) => this.emptyRow(collectionPath, this.flattenRow(collectionPath, row)));
    this.collectionRuntime.setRows(collectionPath, rows, { freshKeys: true });
    this.callOffEntryChecks(collectionPath);
    this.stateStore.replaceCollectionValues(collectionPath, rows);
    this.writeEntryKeys(collectionPath);
    // What the controls of the rows replaced said is about answers no longer there.
    for (const key of [...this.inputStates.keys()]) {
      if (entryKeyOf(key, collectionPath) !== undefined) {
        this.inputStates.delete(key);
      }
    }
    this.publishCollectionChanged(collectionPath, "replace");
  }

  /**
   * Answers about to be put in wholesale (a draft) with every collection's rows posted whole
   * (`items: [...]`) read as the entries' keys, as {@link replaceRows} reads them; a
   * list beside flat keys of its own is dropped, the flat keys winning as in the kernel.
   */
  private withRowListsAsKeys(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    let out: Record<string, unknown> | undefined;
    for (const collectionPath of this.collections.keys()) {
      if (!Object.prototype.hasOwnProperty.call(values, collectionPath)) {
        continue;
      }
      const list = values[collectionPath];
      if (!isRowList(list)) {
        continue;
      }
      out ??= { ...values };
      delete out[collectionPath];
      if (Object.keys(values).some((key) => entryKeyOf(key, collectionPath) !== undefined)) {
        continue;
      }
      list.forEach((row, index) => {
        const flat = this.flattenRow(collectionPath, row);
        for (const field of Object.keys(flat)) {
          (out as Record<string, unknown>)[`${collectionPath}[${index}].${field}`] = flat[field];
        }
      });
    }
    return out ?? { ...values };
  }

  /**
   * The answers as sent to a server, every collection's entries posted as one list at its path:
   * `items: [{ sku: "A" }, {}]` in place of its `items[i].…` keys, an
   * empty row as `{}` and no row as `[]`, so the sandbox kernel reads every row the person saw
   * and counts what the browser drew. `drawn` is the answers as stored with the hidden-value
   * policy applied: the rows the person saw, which `values` (the sandbox's sanitized answers,
   * a transform's) may hold no key for when a row is empty. A collection that does not submit
   * (hidden and excluded, or cleared) is posted only if `values` still holds an answer of it,
   * and then as a list too. Flat entry keys are never posted; a form without a collection gets
   * `values` back as it is.
   */
  private withRowsWhole(values: Record<string, unknown>, drawn: Readonly<Record<string, unknown>>): Record<string, unknown> {
    let out: Record<string, unknown> | undefined;
    for (const [collectionPath, entry] of this.collections) {
      const state = this.orchestrator.effectiveStates().get(entry.componentId);
      const submits = state === undefined || (state.submitValue && !state.clearValue);
      let count = submits ? this.drawnEntryCount(drawn, collectionPath) : 0;
      const found: Array<{ key: string; index: number; field: string }> = [];
      for (const key of Object.keys(values)) {
        const at = entryKeyOf(key, collectionPath);
        if (at === undefined) {
          continue;
        }
        found.push({ key, index: at.index, field: at.field });
        if (values[key] !== undefined && at.index + 1 > count) {
          count = at.index + 1;
        }
      }
      if (found.length === 0 && Object.prototype.hasOwnProperty.call(values, collectionPath)) {
        // Posted whole already (a transform's): left as it is.
        continue;
      }
      if (!submits && count === 0) {
        if (found.length > 0) {
          out ??= { ...values };
          for (const at of found) {
            delete out[at.key];
          }
        }
        continue;
      }
      const rows: Record<string, unknown>[] = [];
      for (let index = 0; index < count; index += 1) {
        rows.push({});
      }
      for (const at of found) {
        if (at.index < count && values[at.key] !== undefined) {
          (rows[at.index] as Record<string, unknown>)[at.field] = values[at.key];
        }
      }
      out ??= { ...values };
      for (const at of found) {
        delete out[at.key];
      }
      out[collectionPath] = rows;
    }
    return out ?? values;
  }

  /**
   * The rows the person saw: the answers as stored, form values only, with
   * the hidden-value policy applied. Read once per submission, for the sandbox's context, a
   * server check and the envelope alike.
   */
  private drawnRowsView(): Record<string, unknown> {
    return applyHiddenValuePolicy(
      this.orchestrator.formValues(this.stateStore.readView().values),
      this.orchestrator.effectiveStates(),
      (path) => this.orchestrator.componentIdForPath(path),
      (key) => this.orchestrator.collectionOwnerOf(key)
    );
  }

  /** How many entries of a collection the answers hold a key for (an empty row's keys included). */
  private drawnEntryCount(values: Readonly<Record<string, unknown>>, collectionPath: string): number {
    let count = 0;
    for (const key of Object.keys(values)) {
      const entry = entryKeyOf(key, collectionPath);
      if (entry !== undefined && entry.index + 1 > count) {
        count = entry.index + 1;
      }
    }
    return count;
  }

  private syncCollectionValuesToState(collectionPath: string): void {
    this.stateStore.replaceCollectionValues(
      collectionPath,
      this.collectionRuntime.list(collectionPath)
    );
  }

  private publishCollectionChanged(collectionPath: string, action: string): void {
    this.eventBus.publish({
      id: `collection_changed_${collectionPath}_${Date.now()}`,
      type: FormEventType.COLLECTION_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { collectionPath, action, rowCount: this.collectionRuntime.count(collectionPath) }
    });
  }

  /**
   * A row added, removed or moved is a settled change of the collection's value: a final write at the collection path, published once the recompute after it has
   * worked out the rows' calculations, so a host listening for changes hears it once, with the
   * answers as they now stand.
   */
  private publishCollectionValue(collectionPath: string): void {
    this.eventBus.publish({
      id: `component_changed_${collectionPath}`,
      type: FormEventType.COMPONENT_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      path: parseComponentPath(collectionPath),
      // Read from the state, so each row's calculated values are in it.
      data: { value: this.rowsFromState(collectionPath) }
    });
  }

  private requireCollection(collectionPath: string): {
    operations: CollectionOperations;
  } {
    const entry = this.collections.get(collectionPath);
    if (!entry) {
      throw new Error(`No collection registered for path: ${collectionPath}`);
    }
    return entry;
  }

  /**
   * Current row values for a registered collection, as the answers hold them: each row's
   * calculated values included.
   */
  public rows(collectionPath: string): Record<string, unknown>[] {
    return this.collections.has(collectionPath) ? this.rowsFromState(collectionPath) : this.collectionRuntime.list(collectionPath);
  }

  /**
   * Refuses `adding` rows past the most a collection may hold, as the Add button is
   * disabled there: a data grid's maximum as of the last recompute (its formula's, else its
   * fixed one), else the cap every collection is drawn to.
   */
  private assertRowRoom(collectionPath: string, adding: number): void {
    const componentId = this.collections.get(collectionPath)?.componentId;
    const limit = (componentId !== undefined ? kernelOwn(this.orchestrator.dataGridRowBounds(), componentId)?.maxRows : undefined) ?? DATA_GRID_ROWS_CAP;
    if (this.collectionRuntime.count(collectionPath) + adding > limit) {
      throw new Error(`Collection ${collectionPath} holds the most rows it may (${limit})`);
    }
  }

  /**
   * The stable keys of a collection's rows, in row order: one per entry, kept while the entry
   * is moved or the rows around it are added or removed, new for every entry of a draft or a
   * whole list put in. An identity for a renderer to key its row elements by; never part of
   * the answers or of any value that crosses JSON.
   */
  public entryKeys(collectionPath: string): readonly string[] {
    return this.collectionRuntime.rowKeys(collectionPath);
  }

  /** {@link entryKeys} of every registered collection, by collection path (what the render model is built with). */
  public entryKeysByCollection(): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, readonly string[]>();
    for (const collectionPath of this.collections.keys()) {
      out.set(collectionPath, this.collectionRuntime.rowKeys(collectionPath));
    }
    return out;
  }

  public rowContext(collectionPath: string, rowIndex: number) {
    return this.collectionRuntime.rowContext(collectionPath, rowIndex);
  }

  /**
   * Appends a row; honours `operations.add`. Returns the new row index. Throws a
   * {@link NonScalarAnswerError} for a cell that is not a scalar in a field that holds one value,
   * as a write of that cell would, before the row is added.
   */
  public addRow(collectionPath: string, row: Record<string, unknown> = {}): number {
    const { operations } = this.requireCollection(collectionPath);
    if (operations.add === false) {
      throw new Error(`Collection ${collectionPath} does not allow adding rows`);
    }
    this.assertRowRoom(collectionPath, 1);
    this.assertScalarCells(collectionPath, [row], this.collectionRuntime.count(collectionPath));
    // Every field of the new row present, unanswered where the caller gave nothing.
    this.collectionRuntime.addRow(collectionPath, this.emptyRow(collectionPath, this.storedCells(collectionPath, row)));
    const index = this.collectionRuntime.count(collectionPath) - 1;
    this.syncCollectionValuesToState(collectionPath);
    this.journeyChecks.callOff("stale");
    this.publishCollectionChanged(collectionPath, "add");
    this.recompute([collectionPath]);
    this.publishCollectionValue(collectionPath);
    return index;
  }

  /**
   * Appends several rows like as many {@link addRow} calls, syncing the answers, publishing
   * the change and recomputing once for all of them: an import of hundreds of rows would
   * otherwise fold the whole form once per row. Returns the new rows' indices. A row with a cell
   * {@link addRow} refuses refuses the whole call, before any row is added.
   */
  public addRows(collectionPath: string, rows: ReadonlyArray<Record<string, unknown>>): number[] {
    const { operations } = this.requireCollection(collectionPath);
    if (operations.add === false) {
      throw new Error(`Collection ${collectionPath} does not allow adding rows`);
    }
    if (rows.length === 0) {
      return [];
    }
    this.assertRowRoom(collectionPath, rows.length);
    this.assertScalarCells(collectionPath, rows, this.collectionRuntime.count(collectionPath));
    const indices: number[] = [];
    for (const row of rows) {
      this.collectionRuntime.addRow(collectionPath, this.emptyRow(collectionPath, this.storedCells(collectionPath, row)));
      indices.push(this.collectionRuntime.count(collectionPath) - 1);
    }
    this.syncCollectionValuesToState(collectionPath);
    this.journeyChecks.callOff("stale");
    this.publishCollectionChanged(collectionPath, "add");
    this.recompute([collectionPath]);
    this.publishCollectionValue(collectionPath);
    return indices;
  }

  public removeRow(collectionPath: string, rowIndex: number): void {
    const { operations } = this.requireCollection(collectionPath);
    if (operations.remove === false) {
      throw new Error(`Collection ${collectionPath} does not allow removing rows`);
    }
    // The rows moved as the answers hold them, calculated values included.
    this.collectionRuntime.setRows(collectionPath, this.rowsFromState(collectionPath));
    this.collectionRuntime.removeRow(collectionPath, rowIndex);
    this.syncCollectionValuesToState(collectionPath);
    this.callOffEntryChecks(collectionPath);
    this.journeyChecks.callOff("stale");
    this.publishCollectionChanged(collectionPath, "remove");
    this.recompute([collectionPath]);
    this.publishCollectionValue(collectionPath);
  }

  public reorderRow(collectionPath: string, fromIndex: number, toIndex: number): void {
    const { operations } = this.requireCollection(collectionPath);
    if (operations.reorder === false) {
      throw new Error(`Collection ${collectionPath} does not allow reordering rows`);
    }
    this.collectionRuntime.setRows(collectionPath, this.rowsFromState(collectionPath));
    this.collectionRuntime.reorderRow(collectionPath, fromIndex, toIndex);
    this.syncCollectionValuesToState(collectionPath);
    this.callOffEntryChecks(collectionPath);
    this.journeyChecks.callOff("stale");
    this.publishCollectionChanged(collectionPath, "reorder");
    this.recompute([collectionPath]);
    this.publishCollectionValue(collectionPath);
  }

  public async resolveDataSource(
    request: DataSourceResolutionRequest
  ): Promise<DataSourceResult | undefined> {
    let component = this.findComponentById(request.componentId);
    if (!component) {
      // A node the running presentation owns names no data source of its own (its
      // inline options stand); a worked-out value's copy is drawn with the form field's.
      const presentation = this.activeJourney()?.presentation;
      const kind = presentation ? kernelOwn(presentation.kindOf, request.componentId) : undefined;
      // The presentation's synthetic container (`@<id>`) is no data source either: the renderer
      // asks for every node it draws, this one included.
      if (presentation !== undefined && request.componentId === presentation.containerId) {
        return undefined;
      }
      if (presentation === undefined || kind === undefined) {
        throw new Error(`Component not found: ${request.componentId}`);
      }
      const workedOut = kernelOwn(presentation.workedOutOf, request.componentId);
      component = workedOut !== undefined ? this.findComponentById(workedOut.targetId) : undefined;
      if (!component) {
        return undefined;
      }
    }

    const sourcePath = request.sourcePropertyPath ?? "data.sourceId";
    const sourceId = this.readConfigurationPath(component.configuration, sourcePath);
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      return undefined;
    }

    if (!this.dataSources) {
      throw new Error("Data source runtime is not configured");
    }

    const state = this.stateStore.snapshot();
    // Option loading uses the current value snapshot so providers can evaluate contextual
    // filters deterministically, in the locale the render asks for (the runtime's, unless a
    // render for another language names its own).
    try {
      // Form values only: a provider may send its context on.
      const pending = this.dataSources.load(sourceId, request.query, {
        locale: request.locale ?? state.locale,
        values: this.orchestrator.formValues(state.values)
      });
      const answer = await this.withinDataSourceTimeout(pending, sourceId);
      // Ran and answered nothing: a failure, not "no source here".
      if (answer === undefined || answer === null) {
        throw new Error(`The data source "${sourceId}" answered nothing`);
      }
      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.eventBus.publish({
        id: `data_source_resolve_failed_${request.componentId}_${Date.now()}`,
        type: FormEventType.DATA_SOURCE_RESOLVE_FAILED,
        timestamp: Date.now(),
        source: "runtime",
        formId: this.form.id,
        data: { componentId: request.componentId, sourceId, error: message }
      });
      throw error;
    }
  }

  /**
   * The snapshot the sandbox holds source-backed choice answers to: each data
   * source a choice of the form names, loaded now with no query (the whole list, not a filtered
   * one) over the same timeout the renderer used. A source that is not wired, throws, times out,
   * or answers something other than a list is absent from the snapshot, which the kernel reads
   * as "unavailable" and refuses the answers that pick from it. `undefined` when the form names
   * no source.
   */
  private async resolveOptionSnapshot(locale: string): Promise<KernelOptionSnapshot | undefined> {
    const sourceIds: string[] = [];
    // Over the normalized tree, the one the kernel asks over.
    for (const question of kernelOptionQuestions(normalizeDataGrids(this.authored.root)).questions) {
      // A source whose answers the author declared free (`data.answersFree`) is no list to hold
      // an answer to, so it is not loaded for the snapshot.
      if (question.sourceId !== undefined && question.free !== true && !sourceIds.includes(question.sourceId)) {
        sourceIds.push(question.sourceId);
      }
    }
    if (sourceIds.length === 0) {
      return undefined;
    }
    const sources = this.dataSources;
    if (!sources) {
      return undefined;
    }
    const context = { locale, values: this.orchestrator.formValues(this.stateStore.snapshot().values) };
    const answers = await Promise.all(
      sourceIds.map(async (sourceId): Promise<readonly [string, KernelOptionSnapshot[string]] | undefined> => {
        try {
          const result = await this.withinDataSourceTimeout(Promise.resolve(sources.load(sourceId, undefined, context)), sourceId);
          // Plain strings only cross the sandbox: a localized label is read in the
          // submit locale here; the kernel compares values, never labels.
          return result && Array.isArray(result.items)
            ? [sourceId, result.items.map((item) => this.snapshotItem(item, locale))]
            : undefined;
        } catch {
          return undefined;
        }
      })
    );
    const snapshot = Object.create(null) as KernelOptionSnapshot;
    for (const answer of answers) {
      if (answer !== undefined) {
        snapshot[answer[0]] = answer[1];
      }
    }
    return snapshot;
  }

  /** One source item for the sandbox's snapshot: texts resolved for `locale`, anything else as given. */
  private snapshotItem(item: DataSourceResult["items"][number], locale: string): KernelOptionSnapshot[string][number] {
    if (item === null || typeof item !== "object") {
      return item;
    }
    const { label, description, ...rest } = item;
    const resolvedLabel = label !== undefined ? resolveLocalizedText(label, locale) : undefined;
    const resolvedDescription = description !== undefined ? resolveLocalizedText(description, locale) : undefined;
    return {
      ...rest,
      ...(resolvedLabel !== undefined ? { label: resolvedLabel } : {}),
      ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {})
    };
  }

  /** `pending`, or a rejection once the data source timeout has passed; the timer never outlives the answer. */
  private withinDataSourceTimeout<T>(pending: Promise<T>, sourceId: string): Promise<T> {
    const ms = this.dataSourceTimeoutMs;
    if (ms <= 0) {
      return pending;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The data source "${sourceId}" did not answer within ${ms} ms`)), ms);
      Promise.resolve(pending).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * Writes a value and publishes `COMPONENT_CHANGED`. `interim` marks a write from a control
   * still being edited — a keystroke — so a host reporting changes can wait for the
   * `COMPONENT_COMMITTED` that `commitValue` publishes once the control is left.
   * The store, the rules and the repaint see every write either way.
   *
   * A write of the answer already stored changes nothing, so it publishes nothing and
   * recomputes nothing: a listener that writes back a normalised value (trimmed, upper-cased)
   * hears its own write once and stops there, where an event for every write would call it
   * again for ever. Throws a {@link NonScalarAnswerError} for a value that is not a scalar in a
   * field that holds one value, before anything is written. A checkbox's `"true"` / `"false"`
   * is stored as the boolean and a checkbox group's list of picked values as its record of one
   * boolean per option, the shapes every surface reads.
   */
  public setValue(path: string, value: unknown, options?: SetValueOptions): void {
    // A value change can flip visibility / enablement / calculations downstream.
    if (this.writeValue(path, value, options)) {
      this.recompute([path]);
    }
  }

  /**
   * Writes several answers like as many {@link setValue} calls, with one recompute at the end
   * instead of one per answer: a host prefilling a large record would otherwise fold the whole
   * form once per key. A write that throws (a {@link NonScalarAnswerError} among them) is
   * skipped and handed back (its path and the error) with the rest still written. An answer
   * already stored is neither written again nor reported.
   */
  public setValues(values: Record<string, unknown>): Array<{ path: string; error: unknown }> {
    const failed: Array<{ path: string; error: unknown }> = [];
    const written: string[] = [];
    for (const [path, value] of Object.entries(values)) {
      try {
        if (this.writeValue(path, value)) {
          written.push(path);
        }
      } catch (error) {
        failed.push({ path, error });
      }
    }
    if (written.length > 0) {
      this.recompute(written);
    }
    return failed;
  }

  /** Writes one answer (or a collection's rows whole) and publishes it; `false` when it was already stored, and nothing happened. */
  private writeValue(path: string, value: unknown, options?: SetValueOptions): boolean {
    const parsed = parseComponentPath(path);
    const key = stringifyComponentPath(parsed);
    // A collection's rows written whole (`items: [{ sku: "A" }, {}]`) are its
    // entries, kept as the runtime keys them; no answer stays at the bare path, and the change
    // reports the rows as they now stand.
    if (this.collections.has(key) && isRowList(value)) {
      this.assertScalarCells(key, value, 0);
      const rows = this.storedRows(key, value);
      if (this.rowsStored(key, rows)) {
        return false;
      }
      this.replaceRows(key, rows);
      value = this.rowsFromState(key);
    } else {
      this.assertScalarAnswer(key, value);
      value = this.storedAnswer(key, value);
      if (this.answerStored(key, value)) {
        return false;
      }
      this.writeOne(parsed, key, value);
    }
    // A check out at the server was asked about the answers as they were.
    this.journeyChecks.callOff("stale");
    this.eventBus.publish({
      id: `component_changed_${path}`,
      type: FormEventType.COMPONENT_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      path: parsed,
      // The payload is unchanged for a final write: only an interim one carries the flag.
      data: options?.interim ? { value, interim: true } : { value }
    });
    return true;
  }

  /**
   * Whether `value` is the answer already stored at `key`, so writing it would change nothing.
   * Never while the control there says something its stored answer cannot: a write
   * then replaces what the control said, though the answer stays the same.
   */
  private answerStored(key: string, value: unknown): boolean {
    if (this.inputStates.has(key)) {
      return false;
    }
    const values = this.stateStore.readView().values;
    return Object.prototype.hasOwnProperty.call(values, key) && sameAnswer(values[key], value);
  }

  /**
   * Whether `rows` are the rows the collection already holds, cell for cell as the runtime keys
   * them (the per-row calculations' values included), so writing them whole would change
   * nothing. Never while a control in the rows says something its stored answer cannot,
   * nor while the answers hold an entry the collection does not count, which the
   * write would clear.
   */
  private rowsStored(collectionPath: string, rows: ReadonlyArray<Record<string, unknown>>): boolean {
    for (const key of this.inputStates.keys()) {
      if (entryKeyOf(key, collectionPath) !== undefined) {
        return false;
      }
    }
    const count = this.collectionRuntime.count(collectionPath);
    for (const key of Object.keys(this.stateStore.readView().values)) {
      const entry = entryKeyOf(key, collectionPath);
      if (entry !== undefined && entry.index >= count) {
        return false;
      }
    }
    const next = rows.map((row) => this.emptyRow(collectionPath, this.flattenRow(collectionPath, row)));
    return sameAnswer(this.rowsFromState(collectionPath), next);
  }

  /**
   * Refuses, before anything is written, a row whose cell is not a scalar in a field that holds
   * one value, naming the cell by the index the row will take (`first` for the first of `rows`).
   */
  private assertScalarCells(collectionPath: string, rows: ReadonlyArray<Record<string, unknown>>, first: number): void {
    rows.forEach((row, offset) => {
      const flat = this.flattenRow(collectionPath, row);
      for (const field of Object.keys(flat)) {
        this.assertScalarAnswer(`${collectionPath}[${first + offset}].${field}`, flat[field]);
      }
    });
  }

  /**
   * `value` as it is stored at `key`: a lone checkbox's `"true"` / `"false"` as the booleans, a
   * checkbox group's list of the values picked as its record of one boolean per option
   * (`checkboxAnswer`, `checkboxesAnswer`), so every surface reads the one shape. Anything
   * else as written.
   */
  private storedAnswer(key: string, value: unknown): unknown {
    if (value !== "true" && value !== "false" && !Array.isArray(value)) {
      return value;
    }
    const node = this.answerFieldAt(key);
    if (node?.type === "checkbox") {
      return checkboxAnswer(value);
    }
    if (node?.type === "checkboxes") {
      return checkboxesAnswer(value, kernelOptionChoiceOf(node)?.options ?? []);
    }
    return value;
  }

  /** Rows written whole, each read as the runtime keys an entry ({@link flattenRow}) and its cells as {@link storedCells} stores them. */
  private storedRows(collectionPath: string, rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] {
    return rows.map((row) => this.storedCells(collectionPath, this.flattenRow(collectionPath, row)));
  }

  /** A row's cells, each as {@link storedAnswer} stores the answer of that field of the collection's entries. */
  private storedCells(collectionPath: string, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const field of Object.keys(out)) {
      out[field] = this.storedAnswer(`${collectionPath}[0].${field}`, out[field]);
    }
    return out;
  }

  /** Each collection path -> its row fields (`sku`, `address.city`) -> the field's component. */
  private rowFieldNodes: Map<string, Map<string, ComponentNode>> | undefined;

  /**
   * The component of a field that holds one value whose answer is stored at `key` — a field of
   * the form, or a field of a collection's entry (`items[0].sku`) — or `undefined` for any other
   * key (a checkbox group, a file field, a plugin's type, a host's extra).
   */
  private singleValueFieldAt(key: string): ComponentNode | undefined {
    const node = this.answerFieldAt(key);
    return node !== undefined && SCALAR_ANSWER_TYPES.has(node.type) ? node : undefined;
  }

  /** The component whose answer is stored at `key`, a field of the form or of a collection's entry; `undefined` for a host's extra. */
  private answerFieldAt(key: string): ComponentNode | undefined {
    const id = this.orchestrator.componentIdForPath(key);
    let node = id !== undefined ? this.tree.find(id) : undefined;
    if (node === undefined && key.includes("[")) {
      if (this.rowFieldNodes === undefined) {
        const byCollection = new Map<string, Map<string, ComponentNode>>();
        const rowFields = kernelRowFields(this.form.root);
        for (const fieldId of Object.keys(rowFields)) {
          const field = rowFields[fieldId] as { collection: string; suffix: string };
          const fieldNode = this.tree.find(fieldId);
          if (fieldNode !== undefined) {
            const fields = byCollection.get(field.collection) ?? new Map<string, ComponentNode>();
            fields.set(field.suffix.slice(1), fieldNode);
            byCollection.set(field.collection, fields);
          }
        }
        this.rowFieldNodes = byCollection;
      }
      for (const collectionPath of this.collections.keys()) {
        const entry = entryKeyOf(key, collectionPath);
        if (entry !== undefined) {
          node = this.rowFieldNodes.get(collectionPath)?.get(entry.field);
          break;
        }
      }
    }
    return node;
  }

  /** The failure a non-scalar answer for a single-valued field is, or `undefined` when `value` may be stored at `key`. */
  private nonScalarAnswer(key: string, value: unknown): NonScalarAnswerError | undefined {
    if (isScalarAnswer(value)) {
      return undefined;
    }
    const node = this.singleValueFieldAt(key);
    return node !== undefined ? new NonScalarAnswerError(this.form.id, key, node.id, node.type) : undefined;
  }

  private assertScalarAnswer(key: string, value: unknown): void {
    const refused = this.nonScalarAnswer(key, value);
    if (refused !== undefined) {
      throw refused;
    }
  }

  /** One answer written at its key, mirrored into its collection when it is an entry's field. */
  private writeOne(parsed: ComponentPath, key: string, value: unknown): void {
    // Mirror row-field writes (`collectionPath[i].field`) into the collection runtime. A
    // collection path may itself be dotted (`order.items`): the entry index sits on
    // its last segment, the first one of the write to carry an index.
    const indexed = parsed.segments.findIndex((segment) => segment.index !== undefined);
    const entry = indexed >= 0 ? parsed.segments[indexed] : undefined;
    const collectionPath =
      entry && entry.index !== undefined && indexed < parsed.segments.length - 1
        ? parsed.segments
            .slice(0, indexed + 1)
            .map((segment) => segment.key)
            .join(".")
        : undefined;
    // A write past the last row grows the collection to reach it, so an entry no collection may
    // hold is refused before anything is written: one key would otherwise allocate every row up
    // to it. The same bound a draft's keys are read under (`entryKeyOf`); `maxRows` is left to
    // validation, since a prefill may still write past it.
    if (collectionPath !== undefined && entry?.index !== undefined && entry.index >= DATA_GRID_ROWS_CAP && this.collections.has(collectionPath)) {
      throw new RangeError(`"${key}" is past the last entry a collection can hold (${DATA_GRID_ROWS_CAP} rows)`);
    }
    this.stateStore.setValue(parsed, value);
    // A written answer, empty included, replaces what the control said. A control
    // records its own state after its own write, so only a write from elsewhere forgets it.
    if (this.inputStates.size > 0) {
      this.inputStates.delete(key);
    }

    if (collectionPath !== undefined && entry?.index !== undefined) {
      if (this.collections.has(collectionPath)) {
        const before = this.collectionRuntime.count(collectionPath);
        this.collectionRuntime.setRowField(
          collectionPath,
          entry.index,
          parsed.segments
            .slice(indexed + 1)
            .map((segment) => segment.key)
            .join("."),
          value
        );
        // A write past the last row (a prefill) adds rows: each holds a key per field.
        if (this.collectionRuntime.count(collectionPath) > before) {
          this.collectionRuntime.setRows(
            collectionPath,
            this.collectionRuntime.list(collectionPath).map((row) => this.emptyRow(collectionPath, row))
          );
          this.writeEntryKeys(collectionPath);
        }
      }
    }
  }

  /**
   * Reports that the control editing `path` has been left, publishing `COMPONENT_COMMITTED`
   * with the value it holds. Writes nothing and recomputes nothing: the interim
   * `setValue` calls before it already did.
   */
  public commitValue(path: string): void {
    const parsed = parseComponentPath(path);
    this.eventBus.publish({
      id: `component_committed_${path}`,
      type: FormEventType.COMPONENT_COMMITTED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      path: parsed,
      data: { value: kernelOwn(this.stateStore.snapshot().values, stringifyComponentPath(parsed)) }
    });
  }

  /**
   * Records what the control at the value path `path` knows that its stored answer cannot say
   * — a date typed in part (`incomplete`, with the parts still empty) or a number
   * box holding text the browser could not read (`badInput`) — or forgets it (`undefined`).
   * The renderer calls it right after it writes the empty answer such a control stores. The
   * next validation raises `dateIncomplete` or `number` for that empty answer in place of
   * `required`. Client-only: never in a draft, the envelope or a server check. Forgotten when
   * any answer is written to the path, empty included (so a host's write replaces what the
   * control said), when a draft is loaded, and when a journey is left or another started.
   * Writes nothing and publishes nothing.
   */
  public setInputState(path: string, state: FieldInputState | undefined): void {
    const key = stringifyComponentPath(parseComponentPath(path));
    if (state !== undefined && (state.badInput === true || state.incomplete !== undefined)) {
      this.inputStates.set(key, state);
    } else {
      this.inputStates.delete(key);
    }
  }

  /** What {@link setInputState} last recorded for the value path `path`, if it still holds. */
  public inputState(path: string): FieldInputState | undefined {
    return this.inputStates.get(stringifyComponentPath(parseComponentPath(path)));
  }

  /**
   * Composes a date answer from the boxes it is typed into (year, month, day) and writes it.
   * All-or-nothing: with every part present the answer is `YYYY-MM-DD` (year padded to four
   * digits, month and day to two); with any part missing it is the empty string, so an
   * incomplete date stores nothing a half-typed value could fail on. The month may be a name
   * in the form's language or English ("Feb", "February", {@link readTypedMonth}) and is
   * stored as its number; a name that cannot be read is kept as typed, for validation to call
   * not a real date. The answer is written only when it differs from the one stored, so a
   * keystroke that changes nothing the store holds does not repaint.
   *
   * After the write, which forgets what the control said, a date typed in part
   * records which parts are still empty ({@link setInputState} `incomplete`), so validation
   * names them; whole, or empty again, it records nothing. Returns the composed answer.
   * `options` go to the write ({@link setValue}).
   */
  public setDateParts(
    path: string,
    parts: { readonly year?: string | undefined; readonly month?: string | undefined; readonly day?: string | undefined },
    options?: SetValueOptions
  ): string {
    const year = (parts.year ?? "").trim();
    const typedMonth = (parts.month ?? "").trim();
    const day = (parts.day ?? "").trim();
    const monthNumber = /^\d+$/.test(typedMonth) ? undefined : readTypedMonth(typedMonth, this.stateStore.snapshot().locale);
    const month = monthNumber === undefined ? typedMonth : String(monthNumber);
    const composed = year && month && day ? `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : "";
    const current = ownValue(this.stateStore.readView().values, stringifyComponentPath(parseComponentPath(path)));
    if ((current ?? "") !== composed) {
      this.setValue(path, composed, options);
    }
    const missing = (["day", "month", "year"] as const).filter((part) => (parts[part] ?? "").trim() === "");
    this.setInputState(path, missing.length > 0 && missing.length < 3 ? { incomplete: { missing } } : undefined);
    return composed;
  }

  /** Counts the locale-switch re-validations; a run holding an older number is stale. */
  private revalidationRun = 0;

  public setLocale(locale: string): void {
    const supported = supportedLocaleCodes(this.form.localization);
    if (supported.length > 0 && !supported.includes(locale)) {
      throw new Error(`Locale "${locale}" is not supported`);
    }

    this.stateStore.setLocale(locale);

    this.eventBus.publish({
      id: `locale_changed_${locale}`,
      type: FormEventType.LOCALE_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { locale }
    });

    this.recompute();
    this.revalidateShownErrors();
  }

  /**
   * After a locale switch, validation runs again for the fields already showing errors, so a
   * message a custom or plugin validator worded in the old locale is worded afresh. Untouched
   * fields stay untouched. Fire-and-forget: the switch itself is synchronous.
   */
  private revalidateShownErrors(): void {
    // A later switch supersedes an earlier run still waiting on a validator: its result is in the
    // old locale's words and is dropped.
    this.revalidationRun += 1;
    const shown = new Set<string>();
    for (const error of this.errorStore.listAll()) {
      if (error.componentId !== undefined) {
        shown.add(error.componentId);
      }
    }
    if (shown.size === 0) {
      return;
    }
    const run = this.revalidationRun;
    this.runValidation({ keep: (componentId) => shown.has(componentId), within: shown, stale: () => run !== this.revalidationRun }).catch(
      (error: unknown) => {
        // A hook or validator that rejected: said the way the runtime says what it cannot act on,
        // since nobody awaits this run to be told.
        console.error(
          `[FormRuntime] Form "${this.form.id}": validation after switching to "${this.stateStore.snapshot().locale}" failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  }

  /**
   * Puts a stored draft's answers, place and journey back into the form. Before anything
   * changes it throws a {@link DraftError}: `draft.formMismatch` for a draft of another form,
   * `draft.incompatible` for a version the compatibility policy refuses, `draft.malformed` for
   * one with no answers to give (a caller branches on the code, never on the
   * message).
   *
   * An answer `setValue` would refuse (a {@link NonScalarAnswerError}: an object or a list for
   * a field that holds one value) is left out and the rest restored: it resolves with each
   * one dropped, and `DRAFT_LOADED` names their paths as `dropped`.
   */
  public async hydrateFromDraft(draft: FormDraft): Promise<DraftRestoreResult> {
    if (!isRecord(draft)) {
      throw new DraftError("draft.malformed", "Draft is malformed: it is not a record");
    }
    if (draft.formId !== this.form.id) {
      throw new DraftError("draft.formMismatch", `Draft form mismatch: ${draft.formId} != ${this.form.id}`);
    }

    if (this.versionContext) {
      assertDraftCompatible(
        draft,
        {
          formVersion: this.versionContext.formVersion,
          schemaVersion: this.versionContext.schemaVersion
        },
        this.draftCompatibilityPolicy
      );
    }

    // Read and checked whole before the first change: a draft that cannot be put back leaves
    // the form as it was, never half restored.
    const read = readDraft(draft, supportedLocaleCodes(this.form.localization), this.stateStore.snapshot().locale);
    const currentStep = read.currentStep;
    // Rows a draft holds whole (`items: [...]`) are put back as the entries' keys.
    const values = this.withRowListsAsKeys(read.values);
    const dropped: DraftRestoreResult["dropped"] = [];
    for (const key of Object.keys(values)) {
      const refused = this.nonScalarAnswer(key, values[key]);
      if (refused !== undefined) {
        dropped.push({ path: key, error: refused });
        delete values[key];
      } else {
        values[key] = this.storedAnswer(key, values[key]);
      }
    }
    this.journeyChecks.callOff("cancelled");
    // Every check of one field still out is about answers the draft replaces.
    this.pathRuns.cancelWhere(() => true);
    // So is every go-on attempt: the draft's own session decides when its fields are checked
    // on commit (a journey's completed pages count as continued from, `validateCompletedPages`).
    this.submitAttempted = false;
    this.attemptedComponents.clear();
    this.attemptedOnResume = undefined;
    // The controls' states were about the answers being replaced.
    this.inputStates.clear();
    this.stateStore.hydrate({
      values,
      touched: read.touched,
      dirty: read.dirty,
      locale: read.locale,
      navigation: {
        mode: read.mode,
        ...(currentStep !== undefined ? { currentStepId: currentStep } : {}),
        visitedSteps: read.visitedSteps,
        completedSteps: read.completedSteps
      }
    });
    // The answers were replaced wholesale: which of a presentation's sources show is
    // worked out again from the draft's answers, never carried over from the ones before it.
    this.orchestrator.forgetReadable();
    // The rows the draft holds are the rows the form draws.
    this.reseedCollections();

    // Restored state must be recomputed and transiently revalidated. A journey
    // resumes where the draft left it, and only the pages already continued from
    // are revalidated: the page the person comes back to shows no errors before they act.
    if (this.journeyNavigation.restoreFromDraft(read.journey)) {
      await this.validateCompletedPages();
    } else {
      this.recompute();
      await this.validate();
    }

    await runHookSeries(this.hooks.afterDraftLoad ?? [], {
      draftId: draft.id,
      values: { ...read.values }
    });

    this.eventBus.publish({
      id: `draft_loaded_${draft.id}`,
      type: FormEventType.DRAFT_LOADED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: dropped.length > 0 ? { draftId: draft.id, dropped: dropped.map((entry) => entry.path) } : { draftId: draft.id }
    });
    return { dropped };
  }

  /**
   * Builds a draft from the current state and persists it through the configured
   * {@link DraftStore}. Requires `draftStore` and `versionContext` dependencies.
   */
  public async saveDraft(draftId?: string): Promise<FormDraftSummary> {
    if (!this.draftStore) {
      throw new Error("Draft store is not configured");
    }
    if (!this.versionContext) {
      throw new Error("Runtime versionContext is not configured");
    }

    const id = draftId ?? `${this.form.id}-draft`;
    const state = this.stateStore.snapshot();
    // The journey's block is the engine's to write, as it is the engine's to put back.
    const journey = this.journeyNavigation.draftJourney(state.journey);

    await runHookSeries(this.hooks.beforeDraftSave ?? [], {
      draftId: id,
      values: { ...state.values }
    });

    const updatedAt = Date.now();
    const draft: FormDraft = {
      id,
      formId: this.form.id,
      formVersion: this.versionContext.formVersion,
      runtime: {
        schemaVersion: this.versionContext.schemaVersion,
        rendererVersion: this.versionContext.rendererVersion
      },
      locale: state.locale,
      values: { ...state.values },
      state: {
        mode: state.navigation.mode,
        ...(state.navigation.currentStepId !== undefined
          ? { currentStep: state.navigation.currentStepId }
          : {}),
        touched: [...state.touched],
        dirty: [...state.dirty],
        visitedSteps: [...state.navigation.visitedSteps],
        completedSteps: [...state.navigation.completedSteps],
        ...(journey ? { journey } : {})
      },
      updatedAt
    };

    const saveStartedAt = Date.now();
    await this.draftStore.save(draft);
    const latencyMs = Date.now() - saveStartedAt;

    this.eventBus.publish({
      id: `draft_saved_${id}`,
      type: FormEventType.DRAFT_SAVED,
      timestamp: updatedAt,
      source: "runtime",
      formId: this.form.id,
      data: { draftId: id, latencyMs }
    });

    return {
      id,
      formId: this.form.id,
      formVersion: draft.formVersion,
      locale: draft.locale,
      updatedAt
    };
  }

  // --- Navigation ---------------------------------------------------------------

  private static readonly STEP_TYPES = new Set(["step"]);

  private wizardStepIds(): string[] {
    return this.tree
      .descendantsOf(this.form.root.id)
      .filter((node) => FormRuntime.STEP_TYPES.has(node.type))
      .map((node) => node.id);
  }

  public canNavigate(toStepId: string): boolean {
    return this.wizardStepIds().includes(toStepId);
  }

  /**
   * Navigates the wizard to `toStepId`. Runs `beforeNavigation` hooks (which may throw to
   * veto), moves the current step, recomputes, and emits `NAVIGATION_*` events.
   */
  public async navigate(toStepId: string): Promise<NavigationResult> {
    const fromStepId = this.stateStore.snapshot().navigation.currentStepId;

    if (!this.canNavigate(toStepId)) {
      this.eventBus.publish({
        id: `navigation_blocked_${toStepId}`,
        type: FormEventType.NAVIGATION_BLOCKED,
        timestamp: Date.now(),
        source: "runtime",
        formId: this.form.id,
        data: { fromStepId: fromStepId ?? null, toStepId, reason: "unknown-step" }
      });
      return { ok: false, currentStepId: fromStepId, reason: "unknown-step" };
    }

    // Declarative navigation gating (rules.navigationGating on the target step).
    if (!this.orchestrator.navigationAllowed(toStepId, this.stateStore.snapshot())) {
      this.eventBus.publish({
        id: `navigation_blocked_${toStepId}`,
        type: FormEventType.NAVIGATION_BLOCKED,
        timestamp: Date.now(),
        source: "runtime",
        formId: this.form.id,
        data: { fromStepId: fromStepId ?? null, toStepId, reason: "gating-rule" }
      });
      return { ok: false, currentStepId: fromStepId, reason: "gating-rule" };
    }

    this.eventBus.publish({
      id: `navigation_started_${toStepId}`,
      type: FormEventType.NAVIGATION_STARTED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { fromStepId: fromStepId ?? null, toStepId }
    });

    try {
      await runHookSeries(this.hooks.beforeNavigation ?? [], {
        ...(fromStepId !== undefined ? { fromStepId } : {}),
        toStepId,
        mode: "wizard"
      });
    } catch (error) {
      this.eventBus.publish({
        id: `navigation_blocked_${toStepId}`,
        type: FormEventType.NAVIGATION_BLOCKED,
        timestamp: Date.now(),
        source: "runtime",
        formId: this.form.id,
        data: {
          fromStepId: fromStepId ?? null,
          toStepId,
          reason: error instanceof Error ? error.message : "hook-veto"
        }
      });
      return {
        ok: false,
        currentStepId: fromStepId,
        reason: error instanceof Error ? error.message : "hook-veto"
      };
    }

    this.stateStore.setWizardStep(toStepId);
    this.recompute();

    this.eventBus.publish({
      id: `navigation_completed_${toStepId}`,
      type: FormEventType.NAVIGATION_COMPLETED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { fromStepId: fromStepId ?? null, toStepId }
    });

    return { ok: true, currentStepId: toStepId };
  }

  public async next(): Promise<NavigationResult> {
    return this.step(1);
  }

  public async back(): Promise<NavigationResult> {
    return this.step(-1);
  }

  private async step(delta: 1 | -1): Promise<NavigationResult> {
    const steps = this.wizardStepIds();
    if (steps.length === 0) {
      return { ok: false, currentStepId: undefined, reason: "no-steps" };
    }

    const current = this.stateStore.snapshot().navigation.currentStepId;
    const currentIndex = current === undefined ? -1 : steps.indexOf(current);
    // A step a rule hides holds nothing to answer: the move passes over it.
    const states = this.effectiveStatesMap();
    let targetIndex = currentIndex === -1 && delta === 1 ? 0 : currentIndex + delta;
    while (targetIndex >= 0 && targetIndex < steps.length && states.get(steps[targetIndex] as string)?.visible === false) {
      targetIndex += delta;
    }

    const target = steps[targetIndex];
    if (target === undefined) {
      return {
        ok: false,
        currentStepId: current,
        reason: delta === 1 ? "at-last-step" : "at-first-step"
      };
    }

    return this.navigate(target);
  }

  /**
   * Validates the form. With `scope`, only the errors on that component and its
   * descendants are kept — what a multi-step form's Continue button asks before it advances:
   * the step in front of the person, not the ones still to come. The stored errors are
   * replaced either way, so a scoped run clears what an earlier run found elsewhere; the
   * submit runs unscoped and finds it again.
   *
   * With `page`, only the errors on the components of that page of the running
   * journey are kept, and they replace only that page's: what Continue on a journey page
   * asks, leaving the errors other pages hold where they are. An error the host's server
   * reported on one of the page's answers stays until that answer changes: the page's own
   * validation cannot unsay the server. `page` wins over `scope`.
   */
  public async validate(options: { scope?: string; page?: string } = {}): Promise<ReturnType<ErrorStore["listAll"]>> {
    if (options.page !== undefined) {
      const within = this.pageComponentIds(options.page);
      // Continue on a journey page is the first submit attempt for the fields on that page.
      within.forEach((componentId) => this.attemptedComponents.add(componentId));
      return this.runValidation({
        keep: (componentId) => within.has(componentId),
        within,
        idPrefix: `${options.page}_`,
        foldCheck: true
      });
    }
    const inScope = options.scope !== undefined ? this.scopedComponentIds(options.scope) : undefined;
    inScope?.forEach((componentId) => this.attemptedComponents.add(componentId));
    return this.runValidation(inScope ? { keep: (componentId) => inScope.has(componentId) } : { foldCheck: true });
  }

  /**
   * One validation run: the whole pipeline over the current answers, the hidden-validation
   * and hidden-required policy applied, then — with `keep` — narrowed to the components it
   * accepts. The result replaces the stored errors, or with `within` only those on its
   * components, bar the ones a server reported on answers not changed since.
   *
   * With `foldCheck` (a whole-form run, a journey page's), a fold that did not settle adds one
   * blocking form-level `fold.unsettled`: with no one submittable view there is
   * nothing to judge the answers by, and the kernel, handed the last pass's view, may well
   * settle somewhere else — so a submit refuses before the sandbox and the envelope, and
   * Continue refuses on every page. A steps container's scoped run is left as it was.
   */
  private async runValidation(options: RunValidationOptions): Promise<ReturnType<ErrorStore["listAll"]>> {
    const progress = { started: false };
    try {
      return await this.runValidationOnce(options, progress);
    } catch (thrown) {
      // A run that threw after it started says so, so whatever marked the form busy can stop.
      if (progress.started) {
        this.publishValidationFailed(thrown);
      }
      throw thrown;
    }
  }

  /** `VALIDATION_FAILED` for a run that threw after its `VALIDATION_STARTED`. */
  private publishValidationFailed(thrown: unknown, paths?: string[]): void {
    this.eventBus.publish({
      id: "validation_failed",
      type: FormEventType.VALIDATION_FAILED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data: { message: thrown instanceof Error ? thrown.message : String(thrown), ...(paths ? { paths } : {}) } satisfies ValidationFailedEventData
    });
  }

  private async runValidationOnce(options: RunValidationOptions, progress: { started: boolean }): Promise<ReturnType<ErrorStore["listAll"]>> {
    // Ensure effective state reflects the latest values before enforcing hidden policy.
    this.recompute();
    const state = this.stateStore.snapshot();
    const context = this.validationContext(state);
    // A path checked on its own after this point (`validatePath`) is judged on newer answers than
    // this run's: what such a check says stands, and this run leaves that path's errors alone.
    const checkedMark = this.pathRuns.mark();

    this.eventBus.publish({
      id: "validation_started",
      type: FormEventType.VALIDATION_STARTED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id
    });
    progress.started = true;

    // Hooks run before staged validators so hosts can inject/normalize context.
    await this.hostCallback(options.forSubmit === true, this.hooks.beforeValidation, () =>
      runHookSeries(this.hooks.beforeValidation ?? [], {
        values: context.values,
        validationContext: context
      })
    );

    const filteredErrors = await this.validationErrors(context, state, { ...options, trackPending: true });
    if (options.stale?.() === true) {
      return this.errorStore.listAll();
    }
    const result: ValidationResult = { errors: filteredErrors };

    // Error ids are runtime-scoped; canonical comparison uses code/path/stage.
    const stored = result.errors.map((error, index) => toFormError(error, `${error.stage}_${options.idPrefix ?? ""}${index}`));
    const newer = [...this.pathRuns.takenSince(checkedMark)];
    const onNewer = (error: FormError): boolean => newer.some((key) => this.errorIsOnPath(error, key));
    const written = newer.length > 0 ? stored.filter((error) => !onNewer(error)) : stored;
    const within = options.within;
    if (within) {
      this.errorStore.replaceWhere(
        (error) =>
          !onNewer(error) &&
          (isFoldUnsettled(error) ||
            (error.componentId !== undefined &&
              within.has(error.componentId) &&
              !this.serverErrorStands(error, state.values))),
        written
      );
    } else if (newer.length > 0) {
      // What the newer checks found keeps its field's place among the run's errors (form order).
      this.errorStore.replaceAround((error) => !onNewer(error), written);
    } else {
      this.errorStore.setAll(stored);
    }
    const all = this.errorStore.listAll();
    this.stateStore.setValidity(!all.some(isBlocking));
    this.stateStore.markValidated();

    await this.hostCallback(options.forSubmit === true, this.hooks.afterValidation, () =>
      runHookSeries(this.hooks.afterValidation ?? [], {
        values: context.values,
        validationContext: context,
        result
      })
    );

    this.eventBus.publish({
      id: "validation_completed",
      type: FormEventType.VALIDATION_COMPLETED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data: { errorCount: result.errors.length }
    });

    this.eventBus.publish({
      id: "errors_changed",
      type: FormEventType.ERRORS_CHANGED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data: { errorCount: all.length }
    });

    if (options.forSubmit === true && newer.length > 0) {
      // The submission decides on the answers it validated and sends, whatever a newer check
      // left shown on the paths it judged after them.
      return [...this.errorStore.listAll().filter((error) => !onNewer(error)), ...stored.filter(onNewer)];
    }
    return this.errorStore.listAll();
  }

  /** The context a validation run hands its stages and hooks: the answers as they stand in `state`. */
  private validationContext(state: FormState): FieldConstraintsContext {
    return {
      formId: this.form.id,
      // Form values only: no stage and no hook is handed a presentation's own answer.
      values: this.orchestrator.formValues(state.values),
      locale: state.locale,
      // The definition's translations: the field-constraints stage words a pattern's
      // own message from them, as the kernel does from the run context, and from the host's
      // catalog too, which wins over the map under the same tag.
      ...(this.form.translations !== undefined ? { translations: this.form.translations } : {}),
      ...(isRecord(this.translationCatalogValue) ? { catalog: this.translationCatalogValue } : {}),
      // The definition's `kinds` map: the field-constraints stage reads a plugin's or a binding's
      // type as its base engine type, as the kernel does from the run context.
      ...(this.form.kinds !== undefined ? { kinds: this.form.kinds } : {}),
      // Required OR Required when, from the same recompute: the field-constraints
      // stage holds a field to its `requiredWhen` as the kernel does. Never sent to the sandbox.
      requiredComponents: Object.fromEntries(this.orchestrator.requiredComponents()),
      // The fields whose Validate rule does not hold, from the same recompute: the
      // stage refuses their answers with `rule` as the kernel does. Never sent to the sandbox.
      invalidComponents: this.orchestrator.invalidComponents(),
      // Each data grid's row-count bounds with its formulas laid over them, from the same
      // recompute: the stage counts the rows against these. Never sent to the sandbox,
      // which works the formulas out itself; absent on a form without a grid.
      ...this.gridBoundsContext(),
      // What the controls know beyond the values. Browser-only, like the above.
      ...this.inputStatesContext()
    };
  }

  /**
   * What one validation run finds, before anything is stored: the pipeline over `context`, the
   * running presentation's own fields, the hidden-validation / hidden-required policy, `keep`,
   * and with `foldCheck` the form-level errors of a fold, a rule or a mapping that did not
   * settle. Writes nothing and fires nothing: `runValidation` stores and announces it,
   * `checkValues` only reports it.
   */
  private async validationErrors(
    context: FieldConstraintsContext,
    state: FormState,
    options: { keep?: (componentId: string) => boolean; foldCheck?: boolean; trackPending?: boolean }
  ): Promise<ValidationResult["errors"]> {
    // A run that stores what it finds marks the paths its async stages declare pending while
    // they run (`checkValues` only reports, and marks nothing).
    const formRun = options.trackPending === true ? this.pathRuns.formRun() : undefined;
    let raw: ValidationResult;
    try {
      raw = (await this.validationPipeline.run(context, formRun ? { onStage: formRun.onStage } : {})).merged;
    } finally {
      formRun?.end();
    }
    // The running presentation's own fields, after the pipeline and apart from it: the
    // journey engine's own-field stage, nothing without a presentation.
    // A journey page's own fields are worded from the definition's map too and from
    // the host's catalog, as the form's own fields are.
    const ownErrors = await this.journeyNavigation.ownFieldErrors({
      ...state,
      ...(context.translations !== undefined ? { translations: context.translations } : {}),
      ...(context.catalog !== undefined ? { catalog: context.catalog } : {})
    });
    // Enforce hidden-validation / hidden-required policy from effective state.
    const policed = [...raw.errors, ...ownErrors].filter((error) => this.errorPassesHiddenPolicy(error));
    const keep = options.keep;
    const filteredErrors = keep
      ? policed.filter((error) => error.componentId !== undefined && keep(error.componentId))
      : [...policed];
    if (options.foldCheck === true && !this.orchestrator.lastFoldConverged()) {
      // No componentId: nothing the hidden policy or a page's scope reads can drop it.
      filteredErrors.push({ code: FOLD_UNSETTLED_CODE, stage: "state", source: "client", severity: "error" });
    }
    if (options.foldCheck === true && this.formulaPolicy === "fail") {
      // A plugin function that threw while a rule was evaluated: the rule read nothing, which
      // hides a field or drops a requirement. Under `fail` that refuses, naming the rule, as the
      // sandbox's run does and as a formula that does not parse does at construction.
      for (const failure of this.orchestrator.ruleFailures()) {
        filteredErrors.push({
          code: FORMULA_INVALID_CODE,
          stage: "definition",
          source: "client",
          severity: "error",
          parameters: {
            where: failure.where,
            message: `function "${failure.name}" threw${failure.message !== "" ? `: ${failure.message}` : ""}`,
            function: failure.name
          }
        });
      }
    }
    if (options.foldCheck === true && !this.orchestrator.lastMappingsSettled()) {
      // The worked-out values did not settle: there is no one value to submit.
      filteredErrors.push({ code: MAP_UNSETTLED_CODE, stage: "state", source: "client", severity: "error" });
    }
    return filteredErrors;
  }

  /** The data grids' bounds as a context's `dataGridRowBounds`, or nothing on a form without a grid. */
  private gridBoundsContext(): Pick<FieldConstraintsContext, "dataGridRowBounds"> {
    const bounds = this.orchestrator.dataGridRowBounds();
    return Object.keys(bounds).length > 0 ? { dataGridRowBounds: bounds } : {};
  }

  /** The recorded input states as a context's `inputStates`, or nothing when there are none. */
  private inputStatesContext(): Pick<ValidationContext, "inputStates"> {
    return this.inputStates.size > 0 ? { inputStates: Object.fromEntries(this.inputStates) } : {};
  }

  /** The value paths an async validation stage is judging right now (`state().validation.pending`), as a copy. */
  public pendingPaths(): ReadonlySet<string> {
    return new Set(this.stateStore.readView().validation.pending);
  }

  /**
   * One check of the value path `path` under the path's token — what a check of one field as it
   * is left runs on: the current answers recomputed, the pipeline's `runFor` over them with the
   * run's abort `signal` in the context, the path pending while an async stage declaring it runs.
   * A newer check of the same path makes this one stale: its signal aborts, and `commit` is never
   * called. Otherwise `commit` is handed the pipeline's result, the state it judged and the
   * context, synchronously, while the run still holds the token; writing the errors is the
   * commit's. The check stays in flight until it settles, so `submit()` and a journey's
   * Continue wait for it. With `ownFields` (a path of the running presentation's own fields)
   * the presentation's own-field errors are judged too, apart from the pipeline, as a
   * whole-form run does; they come back as `own`.
   *
   * Answers written some other way while the check runs (a host's or an agent's `setValue`, a
   * row removed or moved) take no token, so the check is also dropped — `commit` not called —
   * when the answer at the path, or for a collection's entry the entry at that index, is no
   * longer the one it judged: its verdict is about an answer that is not there any more.
   */
  private checkPath(
    path: string,
    commit: (outcome: PathCheck) => void,
    options: { ownFields?: boolean } = {}
  ): Promise<PathRunOutcome<PathCheck>> {
    const key = stringifyComponentPath(parseComponentPath(path));
    let judgedEntries: string[] = [];
    return this.pathRuns.run(
      key,
      async (run): Promise<PathCheck> => {
        this.recompute();
        const state = this.stateStore.snapshot();
        judgedEntries = this.entriesHolding(key);
        const context: FieldConstraintsContext = { ...this.validationContext(state), signal: run.signal };
        const result = await this.validationPipeline.runFor(context, key, { onStage: run.onStage });
        const own =
          options.ownFields === true
            ? await this.journeyNavigation.ownFieldErrors({
                ...state,
                ...(context.translations !== undefined ? { translations: context.translations } : {}),
                ...(context.catalog !== undefined ? { catalog: context.catalog } : {})
              })
            : [];
        return { result, state, context, own };
      },
      (check) => {
        const now = this.stateStore.readView().values;
        if (
          !sameAnswer(kernelOwn(now, key), kernelOwn(check.state.values, key)) ||
          !sameAnswer(this.entriesHolding(key), judgedEntries)
        ) {
          return;
        }
        commit(check);
      }
    );
  }

  /**
   * The entries a value path lies in, as `collection#entry key`: `items[1].sku` names
   * whichever entry is second now, and its key tells it apart from the one that moved up into its
   * place. Empty for a path in no collection.
   */
  private entriesHolding(key: string): string[] {
    const out: string[] = [];
    for (const collectionPath of this.collections.keys()) {
      const entry = entryKeyOf(key, collectionPath);
      if (entry !== undefined) {
        out.push(`${collectionPath}#${this.collectionRuntime.rowKeys(collectionPath)[entry.index] ?? ""}`);
      }
    }
    return out;
  }

  /**
   * Checks the answer at the value path `path` as it is committed (the leave-field check): what
   * the path's own stages find replaces what was shown on that path, and nothing else moves.
   *
   * Whether it checks at all follows the form root's `configuration.validateOn`. With
   * `"commitAfterError"` (the default) it checks when the path already shows an error — the
   * server's included — or when the person already tried to go on from it (a submit, or the
   * Continue of the journey page or the steps container the field is on); never on first blur.
   * With `"submit"` it checks nothing. Skipped, it returns the stored errors as they stand.
   *
   * It runs the deterministic stages and the async stages that declare the path
   * ({@link ValidationPipeline.runFor}), under the path's token: a newer check of the same path
   * aborts this one and this one's errors are dropped, and `submit()` and a journey's Continue
   * wait for it. Only errors whose `FormError.path` is `path` are replaced — `items[1].sku`
   * leaves `items[0].sku` alone, and no error is picked by component id. An error the host's
   * server reported on this path stands while its answers are the ones it was reported against,
   * and goes with the first check after they change, in a single-page form and a journey alike.
   * `beforeValidation` and `afterValidation` do not run (they belong to `validate` and
   * `submit`); `VALIDATION_STARTED` and `VALIDATION_COMPLETED` carry `paths: [path]`, and
   * `VALIDATION_COMPLETED` is not published for a check a newer one replaced, nor for one whose
   * answer was replaced some other way while it ran (a draft loaded, a row removed or moved, a
   * host's `setValue`): such a check writes nothing.
   */
  public async validatePath(path: string): Promise<ReturnType<ErrorStore["listAll"]>> {
    const key = stringifyComponentPath(parseComponentPath(path));
    if (!this.checksOnCommit(key)) {
      return this.errorStore.listAll();
    }
    this.eventBus.publish({
      id: "validation_started",
      type: FormEventType.VALIDATION_STARTED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data: { paths: [key] } satisfies ValidationStartedEventData
    });
    try {
      await this.checkPathAndStore(key);
    } catch (thrown) {
      this.publishValidationFailed(thrown, [key]);
      throw thrown;
    }
    return this.errorStore.listAll();
  }

  /** {@link validatePath}'s check of `key` and, while it is current, its write. */
  private async checkPathAndStore(key: string): Promise<void> {
    await this.checkPath(
      key,
      ({ result, state, own }) => {
        const found = [...result.merged.errors, ...own].filter(
          (error) => normalizedValuePath(error.path) === key && this.errorPassesHiddenPolicy(error)
        );
        const stored = found.map((error, index) => toFormError(error, `${error.stage}_${key}_${index}`));
        // In place: the field keeps its place in `errors()` and so in the summary (form order).
        this.errorStore.replaceInPlace((error) => this.errorIsOnPath(error, key) && !this.serverErrorStands(error, state.values), stored);
        this.eventBus.publish({
          id: "validation_completed",
          type: FormEventType.VALIDATION_COMPLETED,
          timestamp: Date.now(),
          source: "validation",
          formId: this.form.id,
          data: { errorCount: stored.length, paths: [key] } satisfies ValidationCompletedEventData
        });
        this.publishStoredErrors();
      },
      { ownFields: this.orchestrator.isPresentationKey(key) }
    );
  }

  /** Whether a committed answer at `key` is checked now: the form's `validateOn`, then an error shown or a go-on attempted. */
  private checksOnCommit(key: string): boolean {
    if (readValidateOnSetting(this.form.root.configuration) === "submit") {
      return false;
    }
    if (this.submitAttempted) {
      return true;
    }
    const owner = this.componentIdForValuePath(key);
    return (
      (owner !== undefined && (this.attemptedComponents.has(owner) || this.attemptedOnResume?.(owner) === true)) ||
      this.errorStore.listAll().some((error) => this.errorIsOnPath(error, key))
    );
  }

  /** Calls off the checks of one field still out on the entries of `collectionPath`: its rows were removed, moved or replaced. */
  private callOffEntryChecks(collectionPath: string): void {
    this.pathRuns.cancelWhere((path) => entryKeyOf(path, collectionPath) !== undefined);
  }

  /**
   * Whether the stored `error` is about the value path `key`: its own `path` is `key` — never
   * the path of a row beside it, never a component's id. A server error that names a component
   * and no path (`setErrors({ componentId })`) is on the path that component's answer is stored
   * at, so a check of that path can take it back once the answer changed.
   */
  private errorIsOnPath(error: FormError, key: string): boolean {
    if (error.path !== undefined) {
      return stringifyComponentPath(error.path) === key;
    }
    return (
      error.componentId !== undefined &&
      this.serverErrorAnswers.has(error) &&
      (this.presentationValuePathOf(error.componentId) ?? this.orchestrator.valuePathOf(error.componentId)) === key
    );
  }

  /** A path's pending flag flipped: into the state, then announced. */
  private pendingChanged(path: string, pending: boolean): void {
    if (!this.stateStore.setPending(path, pending)) {
      return;
    }
    const data: ValidationPendingChangedEventData = {
      path,
      pending,
      paths: [...(this.stateStore.readView().validation.pending ?? [])]
    };
    this.eventBus.publish({
      id: `validation_pending_changed_${path}`,
      type: FormEventType.VALIDATION_PENDING_CHANGED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data
    });
  }

  /**
   * Drops what a presentation's own validation left — its own fields' errors and an
   * unsettled worked-out value — when the presentation is left or another journey starts: they
   * are about fields no longer asked. With the presentation being left (`left`), also every
   * error, whatever its source — a host's, a server's — on one of its own nodes: nothing asks
   * such a node any more, and no later validation would replace it.
   */
  private dropPresentationErrors(left?: PresentationIndex): void {
    const before = this.errorStore.listAll().length;
    this.errorStore.removeWhere(
      (error) =>
        error.stage === PRESENTATION_STAGE_ID ||
        (error.code === MAP_UNSETTLED_CODE && error.componentId === undefined) ||
        (left !== undefined && error.componentId !== undefined && kernelOwn(left.kindOf, error.componentId) !== undefined)
    );
    if (this.errorStore.listAll().length !== before) {
      this.publishStoredErrors();
    }
  }

  /** A component and every descendant of it, for a scoped validation. */
  private scopedComponentIds(scope: string): Set<string> {
    return new Set([scope, ...this.tree.descendantsOf(scope).map((node) => node.id)]);
  }

  /**
   * Records a step as completed: what a multi-step form's Continue button does
   * once the step validated clean, before it navigates on. The indicator draws it from the
   * navigation state on the next render; no event, since a navigation follows.
   */
  public markStepCompleted(stepId: string): void {
    this.stateStore.markStepCompleted(stepId);
  }

  // --- Journeys --------------------------------------------------------
  // The moves are the journey engine's, bound to this runtime as `journeyNavigation`;
  // the runtime keeps the state store, the event bus, the hook runner and the error store.

  /**
   * The journey running, with its ownership worked out — `undefined` when the form is being
   * filled on one page, or the journey it names has gone from the configuration.
   */
  private activeJourney(): ActiveJourney | undefined {
    return this.journeyNavigation.active();
  }

  /**
   * The journey `id` as its author wrote it: the host's override when it gave one, else the
   * definition's own. What the sandbox is handed, as it is handed the authored form: the kernel
   * compiles its own copy, and refuses a compiled copy's trees as an author's.
   */
  private authoredJourney(id: string | undefined): Journey | undefined {
    if (id === undefined) {
      return undefined;
    }
    const configuration = this.journeyConfigurationSource !== undefined ? this.journeyConfiguration() : this.authored.journey;
    const journeys: unknown = configuration?.journeys;
    return Array.isArray(journeys) ? (journeys as Journey[]).find((journey) => isRecord(journey) && journey.id === id) : undefined;
  }

  /**
   * The page being shown, as a renderer needs it: where it sits on the path, where Back goes,
   * whether it is the last, what it draws. `undefined` when no journey runs.
   */
  public journeyView(): JourneyView | undefined {
    return this.journeyNavigation.view();
  }

  /**
   * The path the running journey takes for the answers as they stand: the pages on it and why
   * each way was taken (a route or the fall-through). What a builder's
   * Try it draws the way taken from; `undefined` when no journey runs. Read from the last
   * recompute, never worked out again.
   */
  public journeyTrace(): JourneyTrace | undefined {
    return this.journeyNavigation.trace();
  }

  /**
   * Starts a journey — the one named, else the definition's default — on its first page, or
   * on `pageId` when that page is reachable. Replaces any journey running, and forgets what it
   * had completed and what the host's server passed. Synchronous and hook-free: starting is the
   * runtime's move, not the person's.
   *
   * Nothing is completed when a journey starts, so the only page reachable then is the first:
   * a later `pageId` is kept as a resume point instead, and a draft restored before the person
   * moves (`hydrateFromDraft`) opens on it when the draft's completed pages reach it. The
   * result's `pageId` is the page actually opened.
   */
  public startJourney(journeyId?: string, options: { pageId?: string } = {}): JourneyNavigationResult {
    return this.journeyNavigation.start(journeyId, options);
  }

  /**
   * Stops the journey: the whole form is in play again, on one page. Answers are kept; a page's
   * check still out at the server is called off, and what the server passed is forgotten.
   */
  public leaveJourney(): void {
    this.journeyNavigation.leave();
  }

  /**
   * Re-reads the journey configuration and works the path out again — for a host whose
   * `journeyConfiguration` function now returns something else (a preview being edited).
   * A value change does this anyway.
   */
  public refreshJourney(): void {
    this.recompute();
  }

  /**
   * Replaces the host's way to its server — `<datum-form>`'s `serverValidator` or
   * `validate-url` changing — without rebuilding the runtime and losing what has been typed.
   * What the old one passed is forgotten; a check already out finishes with it. `undefined`
   * removes it, and a check the journey asks for then counts as unavailable.
   */
  public setJourneyServerValidator(validator?: JourneyServerValidator): void {
    this.journeyChecks.setValidator(validator);
  }

  /**
   * Continue: checks the page as its `validation` says — its own answers (`continue: "page"`,
   * the default) and then the host's server (`server: true`) — and moves to the next page on
   * the path. A deferred page (`continue: "defer"`) moves on unchecked, unless it holds an
   * error that blocks: then it is validated, so a fix can be confirmed. The last page submits
   * rather than continues (`"at-end"`); an exit page does neither (`"exit"`). A second call
   * while one is still out is refused (`"pending"`).
   */
  public nextPage(): Promise<JourneyNavigationResult> {
    // A check of one field still out (`checkPath`) finishes before the page is judged, as part of
    // the Continue: a second Continue meanwhile is refused, and a Back meanwhile calls it off.
    // With none out, nothing is waited on: no extra turn before a caller's await resumes.
    return this.journeyNavigation.nextPage(this.pathRuns.busy ? () => this.pathRuns.settled() : undefined);
  }

  /**
   * A journey page's action, decided here so no renderer carries the rule: Continue
   * on any page but the last ({@link nextPage}); on the last page the page's own submit or
   * download button when it holds one, else the journey's Submit, which names the answers to
   * send ({@link submittableValues}) for the submit that follows, whose end check against the
   * host's server runs over those same values. An exit page has no action, and nothing is done
   * while a server check is out. See {@link JourneyActionOutcome}.
   */
  public async journeyAction(page: JourneyActionPage): Promise<JourneyActionOutcome> {
    if (page.kind === "exit" || page.pending !== undefined) {
      return { kind: "idle" };
    }
    if (!page.final) {
      return { kind: "moved", result: await this.nextPage() };
    }
    if (page.hasOwnSubmit) {
      return { kind: "own-submit" };
    }
    return { kind: "submit", journeyId: page.journeyId, pageId: page.pageId, values: this.submittableValues() };
  }

  /**
   * Back: the page before this one on the path as the answers stand now. Nothing is validated.
   * Calls off the page's check still out at the server; refused (`"pending"`) while a submit's
   * check at the journey's end is out.
   */
  public previousPage(): Promise<JourneyNavigationResult> {
    return this.journeyNavigation.previousPage();
  }

  /**
   * Goes to a page of the path. A `"jump"` (the default) goes only to a page at or before the
   * first one not yet completed, and runs `beforePageChange`; an `"error"` move goes to any
   * page on the path, at once and without hooks — what a renderer does to show an error
   * where it is. Either calls off the page's check still out at the server; both are refused
   * (`"pending"`) while a submit's check at the journey's end is out.
   *
   * A `"change"` move is a review page's Change link: from a review page only, to a page on the
   * path the person has completed, with `beforePageChange`; it records the review page as the
   * return target, so Continue and Back from there go to the first page on the path not yet
   * completed, else back to the review page (`JourneyView.returning`).
   *
   * The `"error"` move is a host-only seam: `<datum-form>`'s `goToPage` takes
   * no direction and never makes it, and a host must not use `beforePageChange` or the frontier as
   * a gate against a script that holds the runtime. The gate is the server's fold of the answers.
   */
  public goToPage(pageId: string, options: { direction?: "jump" | "error" | "change" } = {}): Promise<JourneyNavigationResult> {
    return this.journeyNavigation.goToPage(pageId, options);
  }

  /**
   * Runs `beforePageChange` — the runtime's hook runner — for a move the person asked for:
   * `undefined`, at once, when no hook is set, so the move is made in the same turn;
   * else whether a hook vetoed it by throwing. The journey's moves re-check the target after it.
   */
  private runBeforePageChange(context: Omit<BeforePageChangeHookContext, "values">): Promise<PageChangeHookOutcome> | undefined {
    const hooks = this.hooks.beforePageChange ?? [];
    if (hooks.length === 0) {
      return undefined;
    }
    return (async (): Promise<PageChangeHookOutcome> => {
      try {
        await runHookSeries(hooks, {
          ...context,
          // Form values only: a hook may send what it is handed on.
          values: this.formValues()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        return { vetoed: true, message };
      }
      return { vetoed: false };
    })();
  }

  /**
   * The error store's half of keeping the stored errors to the journey's path (the journey's
   * moves decide when: the path changed, or another journey started): gone
   * are the errors the hidden-validation policy would no longer let through, bar what a server
   * said about a component whose answer is still submitted.
   */
  private dropErrorsOffPath(): void {
    const before = this.errorStore.listAll().length;
    this.errorStore.removeWhere(
      (error) =>
        error.componentId !== undefined &&
        !this.errorPassesHiddenPolicy(error) &&
        !(this.serverErrorAnswers.has(error) && this.orchestrator.stateOf(error.componentId)?.effective.submitValue === true)
    );
    if (this.errorStore.listAll().length !== before) {
      this.publishStoredErrors();
    }
  }

  /**
   * Every component a page holds: its listed components and their subtrees and, for a
   * presentation, its own nodes, the form components they reference, and the form
   * fields they fill or work out.
   */
  private pageComponentIds(pageId: string): Set<string> {
    return this.journeyNavigation.pageComponents(pageId);
  }

  /**
   * Whether a page's components hold an error that blocks — bar, without `withServerErrors`,
   * the ones the host's server reported, for a Continue about to ask it again — or the form's
   * rules did not settle (`fold.unsettled`), which blocks every page. The server's errors are
   * known by where they came from (a host's `setErrors`, a page's check, the end check: the
   * ones {@link rememberServerErrors} recorded), never by `source`: a host's own pipeline
   * stage may call its errors `"server"`, and those are the page's own, which always block.
   */
  private pageHoldsBlockingError(pageId: string, withServerErrors: boolean): boolean {
    const members = this.pageComponentIds(pageId);
    return this.errorStore
      .listAll()
      .some(
        (error) =>
          isBlocking(error) &&
          ((error.componentId !== undefined &&
            members.has(error.componentId) &&
            (withServerErrors || !this.serverErrorAnswers.has(error))) ||
            isFoldUnsettled(error))
      );
  }

  /**
   * The component a value path belongs to: the one stored there, else the nearest
   * one above it, found by trimming the path from the right — an entry of a repeating section
   * (`order.items[0].sku`) to the section's field keyed so, a key under a data-scoping
   * container to the container. The runtime's one way from a path to a page: a data key, or a
   * container that names its data other than its id, never misplaces an error. A key an own
   * field of the running presentation is stored at (`@<presentation id>.<id>`) names
   * that field; an alias's answer is at the form field's path, so it names the form field.
   */
  private componentIdForValuePath(path: string): string | undefined {
    if (this.orchestrator.isPresentationKey(path)) {
      // An own answer's key names the running presentation's field, or nothing.
      const presentation = this.activeJourney()?.presentation;
      for (let key = path; presentation !== undefined && key.length > 0; ) {
        const owner = presentation.idOfKey(key);
        if (owner !== undefined) {
          return owner;
        }
        const cut = Math.max(key.lastIndexOf("."), key.lastIndexOf("["));
        if (cut <= 0) {
          break;
        }
        key = key.slice(0, cut);
      }
      return undefined;
    }
    let at = path;
    while (at.length > 0) {
      const owner = this.orchestrator.componentIdForPath(at) ?? this.collections.get(at)?.componentId;
      if (owner !== undefined) {
        return at === path ? owner : this.entryFieldOf(owner, path.slice(at.length)) ?? owner;
      }
      const cut = Math.max(at.lastIndexOf("."), at.lastIndexOf("["));
      if (cut <= 0) {
        return undefined;
      }
      at = at.slice(0, cut);
    }
    return undefined;
  }

  /** The field of a repeating section's entries that `rest` (`[0].sku`) names, when the section has one keyed so. */
  private entryFieldOf(sectionId: string, rest: string): string | undefined {
    const match = /^\[\d+\]\.(.+)$/.exec(rest);
    if (!match) {
      return undefined;
    }
    const rowKeys = (this.rowKeys ??= buildRowKeys(this.form.root));
    const fields = this.tree.descendantsOf(sectionId).map((node) => node.id);
    let key = match[1] as string;
    while (key.length > 0) {
      const found = fields.find((componentId) => rowKeys.get(componentId) === key);
      if (found !== undefined) {
        return found;
      }
      const cut = Math.max(key.lastIndexOf("."), key.lastIndexOf("["));
      if (cut <= 0) {
        return undefined;
      }
      key = key.slice(0, cut);
    }
    return undefined;
  }

  // --- The error store's half of the host's server checks ----------------------
  // The checks themselves are the journey engine's, bound to this runtime as
  // `journeyChecks`; what they leave in the error store, and what a server error stands on, is here.

  /**
   * A page's check into the store. The page's slice becomes what its own validation
   * just found, warnings included, plus the server's word; what the server said about the page
   * before — on its components, or the form-level entries a page's check left — gives way.
   * The reply's form-level entries are the page's, until the page changes. What the server said
   * is known by where it came from, not by `source`: the errors a pipeline stage calling itself
   * `"server"` just found are the page's own, and are merged with the reply, never wiped by it.
   */
  private storePageCheck(members: ReadonlySet<string>, errors: FormError[]): void {
    this.errorStore.replaceWhere(
      (error) =>
        this.pageOwnedErrors.has(error) ||
        (this.serverErrorAnswers.has(error) && error.componentId !== undefined && members.has(error.componentId)),
      errors
    );
    this.rememberServerErrors(errors);
    for (const error of errors) {
      if (error.componentId === undefined) {
        this.pageOwnedErrors.add(error);
      }
    }
    this.publishStoredErrors();
  }

  /**
   * The page's "could not check" error, in place of any before it (the one the page already
   * shows with the same code). The page's earlier server errors stand: nothing unsaid them.
   */
  private showPageUnavailable(error: FormError): void {
    this.errorStore.replaceWhere((stored) => this.pageOwnedErrors.has(stored) && stored.code === error.code, [error]);
    this.pageOwnedErrors.add(error);
    this.publishStoredErrors();
  }

  /** Drops the form-level errors a page's check left — the page they were about is no longer shown. */
  private dropPageOwnedErrors(): void {
    const before = this.errorStore.listAll().length;
    this.errorStore.removeWhere((error) => this.pageOwnedErrors.has(error));
    if (this.errorStore.listAll().length !== before) {
      this.publishStoredErrors();
    }
  }

  /**
   * Records each server error's answers as they stand: the error then stands
   * through the page's own re-validation until they change.
   */
  private rememberServerErrors(errors: readonly FormError[]): void {
    const values = this.stateStore.snapshot().values;
    for (const error of errors) {
      if (error.source !== "server") {
        continue;
      }
      const answers = this.answersOf(error, values);
      if (answers !== undefined) {
        this.serverErrorAnswers.set(error, answers);
      }
    }
  }

  /** Whether a server error's answers are the ones it was reported against. */
  private serverErrorStands(error: FormError, values: Readonly<Record<string, unknown>>): boolean {
    if (error.source !== "server") {
      return false;
    }
    const then = this.serverErrorAnswers.get(error);
    return then !== undefined && then === this.answersOf(error, values);
  }

  /**
   * What an error's field holds, as text: the answer at its value path and everything under it
   * (a container's fields, a repeating section's entries). An error naming a component takes in
   * the answers of its whole subtree — a fieldset or a panel stores nothing of its own, its
   * fields do — and, for a field of a repeating section, that field in every entry
   * (`items[0].sku`), where its answers actually live. Otherwise such an error would read "{}"
   * for good and never stop standing, whatever the person changed. `undefined` for an error
   * naming no field.
   */
  private answersOf(error: FormError, values: Readonly<Record<string, unknown>>): string | undefined {
    const roots: string[] = [];
    const entryKeys: RegExp[] = [];
    if (error.path !== undefined) {
      roots.push(stringifyComponentPath(error.path));
    } else if (error.componentId !== undefined) {
      // A node the running presentation owns is read where its answer lives — an
      // alias at the form field it fills, an own field at its `@` key — with what it holds.
      const presentation = this.activeJourney()?.presentation;
      const own = presentation !== undefined && kernelOwn(presentation.kindOf, error.componentId) !== undefined;
      const tree = own ? (presentation as PresentationIndex).tree : this.tree;
      const ids = [error.componentId, ...tree.descendantsOf(error.componentId).map((node) => node.id)];
      for (const id of ids) {
        roots.push(this.presentationValuePathOf(id) ?? this.orchestrator.valuePathOf(id));
        for (const [collectionPath, entry] of this.collections) {
          if (entry.componentId === id) {
            roots.push(collectionPath);
          }
        }
        const entryKey = this.entryKeyPattern(id);
        if (entryKey !== undefined) {
          entryKeys.push(entryKey);
        }
      }
    } else {
      return undefined;
    }
    const held: Record<string, unknown> = {};
    for (const key of Object.keys(values)) {
      if (
        roots.some((root) => key === root || key.startsWith(`${root}.`) || key.startsWith(`${root}[`)) ||
        entryKeys.some((pattern) => pattern.test(key))
      ) {
        held[key] = values[key];
      }
    }
    return this.journeyEngine.serverCheck.stableJson(held);
  }

  /**
   * The keys a field of a repeating section holds its answers at — `items[0].sku`,
   * `items[1].sku`, and anything under them — as a pattern; `undefined` for a component in no
   * section. The section is the nearest one above the field: a section nested in another keeps
   * its entries at its own collection path, and its fields are keyed relative to it.
   */
  private entryKeyPattern(componentId: string): RegExp | undefined {
    const rowKey = (this.rowKeys ??= buildRowKeys(this.form.root)).get(componentId);
    if (rowKey === undefined) {
      return undefined;
    }
    for (const ancestor of this.tree.ancestorsOf(componentId)) {
      const collectionPath = collectionPathOf(ancestor);
      if (collectionPath !== undefined) {
        const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${escape(collectionPath)}\\[\\d+\\]\\.${escape(rowKey)}(?=$|[.[])`);
      }
    }
    return undefined;
  }

  /** Announces the store as it stands, after a journey check changed it outside a validation run. */
  private publishStoredErrors(): void {
    const all = this.errorStore.listAll();
    this.stateStore.setValidity(!all.some(isBlocking));
    this.eventBus.publish({
      id: "errors_changed",
      type: FormEventType.ERRORS_CHANGED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.form.id,
      data: { errorCount: all.length }
    });
  }

  /**
   * Takes the person to the earliest page on the path holding an error that blocks — the
   * journey's move; the errors are the store's. An error is placed by its component,
   * else by its value path's (never by a guess from the path's first segment: a data key or a
   * data-scoping container names its data other than its id).
   */
  private revealErrorPage(): void {
    this.journeyNavigation.revealErrorPage(() =>
      this.errorStore
        .listAll()
        .filter(isBlocking)
        .map((error) => error.componentId ?? (error.path !== undefined ? this.componentIdForValuePath(stringifyComponentPath(error.path)) : undefined))
    );
  }

  /**
   * A submit whose journey's path ends at an exit page: refused before anything
   * touches the answers. `undefined` when the path ends anywhere else, or no journey runs.
   */
  private refuseExitPath(modeId: string): SubmitResult | undefined {
    const exitErrors = this.exitPathErrors();
    if (exitErrors === undefined) {
      return undefined;
    }
    this.rejectSubmission(exitErrors, "runtime");
    this.publishSubmissionFailed({ modeId, reason: "journey-exit" });
    return { accepted: false, errors: exitErrors };
  }

  /**
   * The error a journey's path ending at an exit page refuses a submit with, stored
   * nowhere; `undefined` when the path ends anywhere else, or no journey runs.
   */
  private exitPathErrors(): FormError[] | undefined {
    if (!this.activeJourney()) {
      return undefined;
    }
    this.recompute();
    if (this.journeyNavigation.trace()?.end !== "exit") {
      return undefined;
    }
    // Worded by the message catalogs (`DEFAULT_VALIDATION_MESSAGES` and over it), not here.
    return [{ id: "journey_exit", code: "journey.exit", stage: "journey", source: "client" }];
  }

  private publishSubmissionFailed(data: Record<string, unknown>): void {
    this.eventBus.publish({
      id: "submission_failed",
      type: FormEventType.SUBMISSION_FAILED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data
    });
  }

  /**
   * A restored journey's validation: the pages already continued from, not the page the
   * person comes back to, and not a deferred page (the journey engine says which).
   */
  private async validateCompletedPages(): Promise<void> {
    const keep = this.journeyNavigation.completedPagesScope();
    // Those pages were continued from: their fields are checked as they are committed.
    this.attemptedOnResume = keep;
    await this.runValidation({ keep });
  }

  /**
   * Replaces the form's errors with ones the host learned outside validation: a server's
   * verdict on a delivered submission, typically, which arrives after `submit()` has
   * accepted and returned. They are stored and announced exactly as a validation stage's
   * errors are (`ERRORS_CHANGED`), so a renderer shows them inline and in its summary; an
   * entry with no `componentId` is a form-level error the summary lists on its own.
   *
   * Replaces rather than merges: the store is empty after an accepted submit, and the next
   * `validate()` or `submit()` replaces these in turn, which is the intended lifecycle. On a
   * journey page, though, an error from the server (`source` absent or `"server"`) stands
   * through the page's own validation until its answer changes.
   * `setErrors([])` clears. Returns what was stored, as `errors()` now reports it.
   */
  public setErrors(errors: HostError[]): FormError[] {
    const stored = this.fromHostErrors(errors, "host_");

    this.errorStore.setAll(stored);
    this.rememberServerErrors(stored);
    const blocking = stored.some(isBlocking);
    this.stateStore.setValidity(!blocking);

    this.eventBus.publish({
      id: "errors_changed",
      type: FormEventType.ERRORS_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { errorCount: stored.length, source: "host" }
    });

    // In a journey the person is taken to the first page holding one.
    this.revealErrorPage();

    return this.errorStore.listAll();
  }

  /**
   * A host's errors as the form stores them: `stage: "host"` (or the stage given — a
   * journey's check's are `"journey-server"`), `source` defaulting to `"server"`.
   */
  private fromHostErrors(errors: HostError[], idPrefix: string, stage = "host"): FormError[] {
    return errors.map((error, index) => {
      const formError: FormError = {
        id: `${idPrefix}${index}`,
        code: error.code,
        stage,
        source: error.source ?? "server"
      };
      if (error.message !== undefined) {
        formError.message = error.message;
      }
      if (error.componentId !== undefined) {
        formError.componentId = error.componentId;
      } else if (error.path !== undefined && !error.path.includes("[")) {
        // A server that names only where the answer is stored (`billing.street`, a data key)
        // still means one field: place it there, so a journey takes the person to its page.
        // A row's path stays as it is — it names an entry, not the field.
        const owner = this.componentIdForValuePath(error.path);
        if (owner !== undefined) {
          formError.componentId = owner;
        }
      }
      if (error.path !== undefined) {
        formError.path = parseComponentPath(error.path);
      }
      if (error.severity !== undefined) {
        formError.severity = error.severity;
      }
      if (error.parameters !== undefined) {
        formError.parameters = error.parameters;
      }
      return formError;
    });
  }

  /**
   * A dry run of a submit's checks (the browser's form-test driver's `check` and the
   * page check behind its `continue`): what `submit` under a mode that validates would find over
   * the answers as they stand — a journey's exit path, the validation pipeline with the hidden
   * policy and the fold's own checks, then the sandbox (`wasmValidationHost`) over the envelope's
   * values with the data sources' option snapshot, the strict policy and the unknown-fields
   * setting, so an answer outside a choice's options, a server rule or a shape bound refuses
   * here as it does at a submit. The first check that blocks ends it, as in `submit`.
   *
   * Changes nothing: no state, no stored error, no submission state, no validity; no hook
   * (`beforeValidation`, `afterValidation`, `beforeSubmit`, the value transforms), no handler
   * and no event but the recompute's (the fold worked out over the answers as stored, as
   * `validate` and `submit` start). So the answers are judged as stored, not as a transform
   * would change them.
   * The host's own checks are not asked either — `serverValidation` and the journey's checks
   * against the host's server — only what runs in the browser and its sandbox; the external
   * data provider and the data sources are read as a submit reads them.
   *
   * With `page`, only that journey page's errors are kept (see {@link CheckValuesOptions.page})
   * and the exit path is not checked: what Continue on the page would refuse for.
   */
  public async checkValues(options: CheckValuesOptions = {}): Promise<CheckValuesResult> {
    const page = options.page;
    if (page === undefined) {
      const exitErrors = this.exitPathErrors();
      if (exitErrors !== undefined) {
        return { refused: true, errors: exitErrors, refusedBy: "journey" };
      }
    }
    this.recompute();
    const state = this.stateStore.snapshot();
    const within = page !== undefined ? this.pageComponentIds(page) : undefined;
    const found = await this.validationErrors(this.validationContext(state), state, {
      ...(within !== undefined ? { keep: (componentId: string) => within.has(componentId) } : {}),
      foldCheck: true
    });
    // Numbered as `validate` numbers what it stores, so the ids read as a submit's would.
    const idPrefix = page !== undefined ? `${page}_` : "";
    const errors = found.map((error, index) => toFormError(error, `${error.stage}_${idPrefix}${index}`));
    if (errors.some(isBlocking)) {
      return { refused: true, errors, refusedBy: "validation" };
    }
    if (!this.wasmValidationHost) {
      return { refused: false, errors };
    }
    // The values a submit with no transform sends: the form's own, the rows drawn read from the state.
    const check = await this.runWasmCheck(this.wasmValidationHost, this.orchestrator.formValues(state.values), () => this.drawnRowsView(), options);
    const wasmErrors =
      within === undefined
        ? check.errors
        : check.errors.filter((error) => {
            const owner =
              error.componentId ?? (error.path !== undefined ? this.componentIdForValuePath(stringifyComponentPath(error.path)) : undefined);
            return owner !== undefined ? within.has(owner) : error.code !== "journey.exit";
          });
    if (wasmErrors.some(isBlocking)) {
      return { refused: true, errors: wasmErrors, refusedBy: "wasm" };
    }
    return { refused: false, errors: [...errors, ...wasmErrors] };
  }

  /**
   * The sandbox's check of the answers a submit sends, shared by `submit` and
   * `checkValues`: the envelope's values built from `values`, the run, and the browser's hidden
   * policy over what it reports. Stores nothing and announces nothing: `submit` publishes the
   * exchange and acts on it.
   */
  private async runWasmCheck(
    host: WasmValidationHost,
    values: Record<string, unknown>,
    drawn: () => Record<string, unknown>,
    options: Pick<SubmitOptions, "wasmUnknownFields" | "wasmLogLevel" | "formulaErrors">
  ): Promise<WasmCheck> {
    let wasmErrors: FormError[];
    let sanitizedValues: Record<string, unknown> | undefined;
    let wasmOutcome: WasmSubmissionOutcome | undefined;
    let wasmExecutionError: string | undefined;
    let wasmExternalData: Record<string, unknown> | undefined;
    const unknownFields = options.wasmUnknownFields ?? this.wasmUnknownFields;
    const logLevel = options.wasmLogLevel ?? this.wasmLogLevel;
    // The sandbox judges by the host's word when there is one, else by the form's own
    // setting, which it reads itself from the definition it is sent.
    const formulaErrors = options.formulaErrors ?? this.hostFormulaErrors;
    const wasmStartedAt = Date.now();
    // The sandbox sees what the envelope will carry: the answers with the hidden-value
    // policy applied, so an answer the person cannot see — off the journey's
    // path, or hidden by its own rule — is judged by neither side, and a server holding
    // only the envelope reaches the same verdict.
    const policed = applyHiddenValuePolicy(
      values,
      this.orchestrator.effectiveStates(),
      (path) => this.orchestrator.componentIdForPath(path),
      (key) => this.orchestrator.collectionOwnerOf(key)
    );
    // Every row drawn is sent as one list per collection, an empty one included, so the
    // kernel counts what the browser did; the rows drawn are
    // read once, for this and the envelope alike.
    const wasmValues = this.withRowsWhole(policed, drawn());
    const wasmJourney = this.authoredJourney(this.activeJourney()?.journey.id);
    try {
      const locale = this.stateStore.snapshot().locale;
      // The host resolves data sources outside the sandbox and injects a
      // deterministic snapshot; the sandbox itself never fetches. Waited on as a data source
      // is: a provider that never answers would hold the submission `submitting` for good.
      wasmExternalData = this.wasmExternalDataProvider
        ? await this.withinDataSourceTimeout(
            this.wasmExternalDataProvider({
              formId: this.form.id,
              values: wasmValues,
              locale
            }),
            "wasmExternalDataProvider"
          )
        : undefined;
      // The options the form's data sources hold right now: the kernel refuses an
      // answer to a source-backed choice it has no list for, so a source that failed or timed
      // out is left out on purpose and its answers are refused.
      const wasmOptionSnapshot = await this.resolveOptionSnapshot(locale);
      // The definition as the host holds it (the kernel compiles its own copy, as every
      // server does), and the day the browser judged by, so a server given no day of
      // its own reads the same `today()`.
      const wasmContext: WasmSubmissionContext = {
        formId: this.form.id,
        values: wasmValues,
        locale,
        form: this.authored.root,
        ...(this.form.translations !== undefined ? { translations: this.form.translations } : {}),
        // The definition's `kinds` map: the kernel reads a plugin's or a binding's type as its base.
        ...(this.authored.kinds !== undefined ? { kinds: this.authored.kinds } : {}),
        // The host's catalog, only when it holds something.
        ...(isRecord(this.translationCatalogValue) && Object.keys(this.translationCatalogValue).length > 0
          ? { catalog: this.translationCatalogValue }
          : {}),
        today: this.today(),
        // The host context the browser judged by, when the page supplied one, so the in-page
        // sandbox replays the same `host.` rules. A server never takes it from the browser.
        ...(this.hostContextValue !== undefined ? { hostContext: this.hostContextValue } : {}),
        ...(unknownFields !== undefined ? { unknownFields } : {}),
        ...(logLevel !== undefined ? { logLevel } : {}),
        ...(formulaErrors !== undefined ? { formulaErrors } : {}),
        ...(this.hostRiskyPatterns !== undefined ? { riskyPatterns: this.hostRiskyPatterns } : {}),
        ...(wasmExternalData !== undefined ? { externalData: wasmExternalData } : {}),
        ...(wasmOptionSnapshot !== undefined ? { optionSnapshot: wasmOptionSnapshot } : {}),
        ...(wasmJourney !== undefined ? { journey: wasmJourney } : {})
      };
      const returned: unknown = await host.run({
        context: wasmContext,
        policy: this.wasmPolicy ?? WasmValidationHost.STRICT_POLICY
      });
      // The outcome crossed a boundary (a program, a page-assigned host): read as the contract
      // says it is or not at all. Values as a string or a list would otherwise become the
      // submission key by key, and null would throw past the gate. A refused outcome is never
      // kept, so it is not published as the run's response either.
      if (!isWasmOutcomeShape(returned)) {
        throw new Error("The sandbox returned an outcome that is not { errors: [...], values?: {...}, logs?: [...] }.");
      }
      wasmOutcome = returned;
      // The browser's hidden-validation policy has the last word on what the sandbox
      // reports, as it has on the pipeline's: a plugin validator flagging a field the
      // person cannot see does not block.
      const kept = wasmOutcome.errors.filter((error) => this.errorPassesHiddenPolicy(error));
      wasmErrors = kept.map((error, index) => toFormError(error, `wasm_${index}`));
      sanitizedValues = wasmOutcome.values;
      if (sanitizedValues === undefined && !wasmErrors.some(isBlocking)) {
        // The sandbox withholds its sanitized values when it blocked; once that block is
        // filtered away there is nothing sanitized to submit. Fail closed rather than
        // deliver the unsanitized answers.
        wasmErrors.push(
          toFormError(
            { code: "wasm.values-missing", stage: "wasm", source: "wasm", severity: "error" },
            "wasm_values_missing"
          )
        );
      }
    } catch (error) {
      // Fail closed: a sandbox or host failure blocks the submission with one
      // deterministic error rather than rejecting the submit() promise.
      wasmExecutionError = error instanceof Error ? error.message : String(error);
      wasmErrors = [
        toFormError(
          {
            code: "wasm.execution_error",
            stage: "wasm",
            source: "wasm",
            severity: "error",
            parameters: { message: wasmExecutionError }
          },
          "wasm_execution"
        )
      ];
    }
    return {
      errors: wasmErrors,
      sanitizedValues,
      outcome: wasmOutcome,
      executionError: wasmExecutionError,
      externalData: wasmExternalData,
      requestValues: wasmValues,
      unknownFields,
      logLevel,
      startedAt: wasmStartedAt
    };
  }

  /**
   * Sends the answers through `modeId`. One submission runs at a time: a second call while one
   * is in flight joins it when it asks for the same thing (a double click), and is refused with a
   * {@link SubmitBusyError} when it asks for anything else, which would otherwise be answered
   * with the first one's result or deliver twice.
   */
  public submit(
    modeId: string,
    versionContext: SubmissionVersionContext,
    options: SubmitOptions = {}
  ): Promise<SubmitResult> {
    const current = this.submitInFlight;
    if (current) {
      return current.result !== undefined &&
        this.submitCallbacksRunning === 0 &&
        sameSubmitRequest(current.request, [modeId, versionContext, options])
        ? current.result
        : Promise.reject(new SubmitBusyError(this.form.id, current.request[0]));
    }
    // Held before the submission starts: a call made while it is still starting (a hook that
    // submits) is refused rather than run beside it.
    const entry: { request: readonly [string, SubmissionVersionContext, SubmitOptions]; result?: Promise<SubmitResult> } = {
      request: [modeId, versionContext, options]
    };
    this.submitInFlight = entry;
    entry.result = this.submitSettled(modeId, versionContext, options);
    const release = (): void => {
      if (this.submitInFlight === entry) {
        this.submitInFlight = undefined;
      }
    };
    entry.result.then(release, release);
    return entry.result;
  }

  /**
   * Whether a submission in flight is waiting on one of the host's hooks right now. A submit
   * asked meanwhile may come from that hook, and joining it would have the run wait on itself:
   * a caller that joins at its own level (the `<datum-form>` element) refuses instead.
   */
  public submitWaitsOnHost(): boolean {
    return this.submitCallbacksRunning > 0;
  }

  /**
   * Waits on a host hook (a hook series or the transforms). With `counted` (a series of the
   * submission's own: its hooks, its transforms, its validation) and a submission in flight, it
   * counts as one the run is waiting on, so a submit asked from inside it is refused rather than
   * joined (see {@link submit}). A series someone else started meanwhile (a page's validate(), a
   * language switch's revalidation) is not the submission's and never counts. No hook set,
   * nothing to wait on: a second call then still joins.
   *
   * Not counting, it hands back the run's own promise: an extra wrapper would add turns between
   * the events a page move publishes, and the renderer would paint once for each gap.
   */
  private hostCallback<T>(counted: boolean, hooks: readonly unknown[] | undefined, run: () => Promise<T>): Promise<T> {
    if (!counted || this.submitInFlight === undefined || hooks === undefined || hooks.length === 0) {
      return run();
    }
    this.submitCallbacksRunning += 1;
    const release = (): void => {
      this.submitCallbacksRunning -= 1;
    };
    let pending: Promise<T>;
    try {
      pending = run();
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    return pending.finally(release);
  }

  /**
   * One submission, which never stays `submitting` past its end: whatever throws part way (a
   * hook, a pipeline stage, a server runner) settles it back to `idle` and is reported once as
   * the host's failure before the caller sees the throw. A submission that already settled is
   * left as it is: a stage's refusal published its own failure, and an `afterSubmit` hook that
   * throws does so after the answers were accepted.
   */
  private async submitSettled(
    modeId: string,
    versionContext: SubmissionVersionContext,
    options: SubmitOptions
  ): Promise<SubmitResult> {
    try {
      return await this.runSubmit(modeId, versionContext, options);
    } catch (error) {
      if (this.stateStore.snapshot().submission.status === "submitting") {
        this.stateStore.abandonSubmission();
        this.publishSubmissionFailed({ modeId, stage: "host" });
      }
      throw error;
    }
  }

  private async runSubmit(
    modeId: string,
    versionContext: SubmissionVersionContext,
    options: SubmitOptions
  ): Promise<SubmitResult> {
    const mode = this.submissionModes.resolve(modeId);
    // The agent provenance is for the two hook contexts alone, one frozen
    // copy both share on a fixed property (`withProvenance`): a hook can neither change what the
    // next hook reads nor reach the caller's object, and nothing else in a submission ever sees
    // it. Copied before the submission begins, so a provenance that cannot be copied rejects the
    // call with the form's state untouched rather than left `submitting`.
    const agent = options.agent !== undefined ? frozenProvenance(options.agent) : undefined;
    // One key per attempt, minted before it begins: a call that joins this attempt is handed
    // this attempt's result, key included, and the next attempt mints its own.
    const submissionKey = mintSubmissionKey();
    let state = this.stateStore.snapshot();
    this.stateStore.beginSubmission();

    this.eventBus.publish({
      id: "submission_started",
      type: FormEventType.SUBMISSION_STARTED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: { modeId }
    });

    // A submit makes its own checks: a page's check still out is about to be moot.
    this.journeyChecks.callOff("cancelled");
    if (mode.validate && this.pathRuns.busy) {
      // A check of one field still out (`checkPath`) finishes before the submission reads the
      // answers, and they are read again after it: the hooks, the transforms, the validation, the
      // sandbox and the envelope all see the answers as they stand once the wait is over, never
      // ones the person changed during it. A check begun after this point is newer than the
      // submission's own run, which leaves its verdict in place (`runValidation`).
      await this.pathRuns.settled();
      state = this.stateStore.snapshot();
    }

    // Form values only: a presentation's own answers never reach a submit hook,
    // a transform, the sandbox or the envelope.
    const beforeSubmitContext = withProvenance<BeforeSubmitHookContext>(
      {
        values: this.orchestrator.formValues(state.values),
        modeId
      },
      agent
    );
    // A journey whose path ends at an exit page sends nothing, whatever the mode.
    const exitRefusal = this.refuseExitPath(modeId);
    if (exitRefusal) {
      return exitRefusal;
    }
    const journeyId = this.journeyEngine.describe(this.activeJourney())?.journeyId;

    // Value transforms are deterministic serial transforms applied in order. Reassigned
    // once wasm validation succeeds: the sandbox's sanitized values become the submission.
    let transformedValues: Record<string, unknown>;
    try {
      await this.hostCallback(true, this.hooks.beforeSubmit, () => runHookSeries(this.hooks.beforeSubmit ?? [], beforeSubmitContext));
      transformedValues = await this.hostCallback(true, this.hooks.transformValues, () =>
        runValueTransforms(this.hooks.transformValues ?? [], beforeSubmitContext.values)
      );
    } catch (error) {
      // The site stopped the submission (a hook or a transform threw, such as the attestation
      // recipe's refusal): it settles back to idle, so the form can be sent again once the person
      // acts, and is reported as the host's failure before the caller sees the throw.
      this.stateStore.abandonSubmission();
      this.publishSubmissionFailed({ modeId, stage: "host" });
      throw error;
    }
    // Again after the hooks and the transforms: neither can put a presentation's key back in.
    transformedValues = this.orchestrator.formValues(transformedValues);

    // The rows the person saw, read from the state once, when first asked,
    // after validation has written whatever a transform changed: the sandbox's context, a
    // server check and the envelope all post these rows.
    let drawnRows: Record<string, unknown> | undefined;
    const drawn = (): Record<string, unknown> => (drawnRows ??= this.drawnRowsView());

    if (mode.validate) {
      // Validate the transformed snapshot that is about to be submitted. Only what a transform
      // changed is written: rewriting every value would report each as a change.
      const current = this.stateStore.snapshot().values;
      Object.entries(transformedValues).forEach(([path, value]) => {
        if (kernelOwn(current, path) !== value) {
          this.setValue(path, value);
        }
      });

      // No wait for checks of one field here: the submission waited for those out when it began,
      // and one begun since (a field left during the hooks) is about answers newer than the ones
      // validated and sent below, so its verdict stands beside the submission's (`runValidation`).
      // From here a committed answer is checked at once, whichever field it is ({@link validatePath}).
      this.submitAttempted = true;
      // The whole-form run `validate()` makes, marked as the submission's own: a page's or an
      // agent's validate() meanwhile is not something the submission waits on.
      const errors = await this.runValidation({ foldCheck: true, forSubmit: true });
      const blockingErrors = errors.filter(isBlocking);

      if (blockingErrors.length > 0) {
        this.stateStore.failSubmission();
        this.revealErrorPage();
        this.eventBus.publish({
          id: "submission_failed",
          type: FormEventType.SUBMISSION_FAILED,
          timestamp: Date.now(),
          source: "runtime",
          formId: this.form.id,
          data: { modeId, blockingErrorCount: blockingErrors.length }
        });

        return {
          accepted: false,
          errors
        };
      }

      if (this.wasmValidationHost) {
        const {
          errors: wasmErrors,
          sanitizedValues,
          outcome: wasmOutcome,
          executionError: wasmExecutionError,
          externalData: wasmExternalData,
          requestValues: wasmValues,
          unknownFields,
          logLevel,
          startedAt: wasmStartedAt
        } = await this.runWasmCheck(this.wasmValidationHost, transformedValues, drawn, options);

        const wasmBlocked = wasmErrors.some(isBlocking);
        // The exchange, observable by hosts (a status panel, telemetry): what crossed the
        // ABI and what came back. The schema itself is omitted — hosts have it already.
        this.eventBus.publish({
          id: "wasm_validation_completed",
          type: FormEventType.WASM_VALIDATION_COMPLETED,
          timestamp: Date.now(),
          source: "validation",
          formId: this.form.id,
          data: {
            modeId,
            unknownFields: unknownFields ?? "strip",
            ...(logLevel !== undefined ? { logLevel } : {}),
            durationMs: Date.now() - wasmStartedAt,
            blocked: wasmBlocked,
            requestValues: wasmValues,
            ...(wasmExternalData !== undefined ? { externalData: wasmExternalData } : {}),
            ...(wasmOutcome !== undefined ? { response: wasmOutcome } : {}),
            ...(wasmExecutionError !== undefined ? { executionError: wasmExecutionError } : {})
          }
        });

        if (wasmBlocked) {
          // Hand the error contract to the renderer: store + ERRORS_CHANGED is the whole
          // job here — presentation (summary, inline field errors, localization by code)
          // belongs to the renderer's existing pull model.
          this.rejectSubmission(wasmErrors, "validation");
          this.eventBus.publish({
            id: "submission_failed",
            type: FormEventType.SUBMISSION_FAILED,
            timestamp: Date.now(),
            source: "runtime",
            formId: this.form.id,
            data: { modeId, blockingErrorCount: wasmErrors.length, source: "wasm" }
          });

          return {
            accepted: false,
            errors: wasmErrors
          };
        }

        // The sandbox's sanitized values are the submission from here on: any key the
        // schema does not define has been stripped.
        if (sanitizedValues !== undefined) {
          transformedValues = sanitizedValues;
        }
      }
    }

    if (mode.serverValidation && this.serverValidationRunner) {
      // The rows as the envelope will post them, an empty one included.
      const serverValues = this.withRowsWhole(transformedValues, drawn());
      const serverResult = await this.serverValidationRunner.run({
        values: serverValues,
        formId: this.form.id,
        validationContext: {
          formId: this.form.id,
          values: serverValues,
          locale: this.stateStore.snapshot().locale
        },
        services: this.serverServicesProvider ? this.serverServicesProvider() : {},
        environment: "server"
      });

      const serverErrors = serverResult.errors.map((error, index) =>
        toFormError(error, `server_${index}`)
      );

      if (serverErrors.some(isBlocking)) {
        // Same contract-to-renderer handoff as the wasm stage: without this, server errors
        // were returned but never displayed.
        this.rejectSubmission(serverErrors, "validation");
        this.eventBus.publish({
          id: "submission_failed",
          type: FormEventType.SUBMISSION_FAILED,
          timestamp: Date.now(),
          source: "runtime",
          formId: this.form.id,
          data: { modeId, blockingErrorCount: serverErrors.length, source: "server" }
        });

        return {
          accepted: false,
          errors: serverErrors
        };
      }
    }

    // Apply hidden-value policy (exclude-from-submission / clear) before canonicalizing.
    this.recompute();
    // A repeating section's entries, at its own collection path too, are judged as the section:
    // the fold's reading, so an abandoned branch's rows are not sent. The envelope
    // holds each answer as its JSON carries it (a calculation's NaN as null, an undefined entry
    // left out), so a host handed the object in-process reads what one reading the bytes does,
    // and what `submittableValues()` said. Spread, so an own `__proto__` key stays a key.
    // Every collection's entries travel as one list, every row the person
    // saw in it, an empty one as `{}`: the sandbox's sanitized answers have no key for a row
    // with no answer, so the rows drawn are read from the answers as stored (`drawn`).
    const submissionValues: Record<string, unknown> = {
      ...kernelJsonAnswers(
        this.withRowsWhole(
          applyHiddenValuePolicy(
            transformedValues,
            this.orchestrator.effectiveStates(),
            (path) => this.orchestrator.componentIdForPath(path),
            (key) => this.orchestrator.collectionOwnerOf(key)
          ),
          drawn()
        )
      )
    };

    // The journey's check against the host's server: the last validation stage,
    // after the client's and the sandbox's, over exactly these values, and
    // before the envelope is completed, canonicalized or signed.
    if (mode.validate) {
      // Skipped, silently, for a download (`journeyEndCheck: "skip"`); the engine's own tells why else.
      const endRefusal = await this.journeyChecks.checkEnd(
        this.activeJourney(),
        this.journeyNavigation.trace(),
        submissionValues,
        versionContext.form.version,
        options.journeyEndCheck === "skip"
      );
      if (endRefusal) {
        // Warnings do not stop a submit: the engine returns only what refuses it.
        const errors = endRefusal.errors;
        this.rejectSubmission(errors, "validation");
        this.publishSubmissionFailed({
          modeId,
          blockingErrorCount: errors.filter(isBlocking).length,
          source: "journey-server",
          scope: endRefusal.scope,
          outcome: endRefusal.outcome,
          ...(endRefusal.pageId !== undefined ? { pageId: endRefusal.pageId } : {})
        });
        return { accepted: false, errors };
      }
    }

    // Enrich the version context with manifests from the registries, then require
    // completeness before acceptance.
    const enrichedContext = this.enrichVersionContext(versionContext, mode.serverValidation);
    const completeness = assertEnvelopeComplete(enrichedContext, {
      // Component-manifest coverage is only enforceable when a registry can supply and
      // verify versions; runtime/renderer/schema/plugin/server manifests are always checked.
      componentTypes: this.componentRegistry ? this.formComponentTypes() : [],
      pluginVersions: this.installedPluginVersions(),
      requireServer: mode.serverValidation
    });
    if (!completeness.complete) {
      const envelopeErrors: FormError[] = completeness.missing.map((field, index) => ({
        id: `envelope_${index}`,
        code: "envelope.incomplete",
        message: `The submission envelope is missing ${field}.`,
        stage: "envelope",
        source: "custom" as const,
        parameters: { field }
      }));
      this.rejectSubmission(envelopeErrors, "runtime");
      this.eventBus.publish({
        id: "submission_blocked_envelope",
        type: FormEventType.SUBMISSION_BLOCKED_ENVELOPE,
        timestamp: Date.now(),
        source: "runtime",
        formId: this.form.id,
        data: { modeId, missing: completeness.missing }
      });
      return { accepted: false, errors: envelopeErrors };
    }

    // Canonicalization is required before signing or cross-runtime comparison.
    let canonicalSubmission: CanonicalSubmission = this.submissionEnvelope(enrichedContext, this.stateStore.snapshot().locale, submissionValues, journeyId);

    // Signing (optional; required when the mode requests it, or when the call names a
    // provider — a button's `signature` option). The format says what the provider
    // sees and where its result lands.
    let signatures: SignatureResult[] | undefined;
    let signed: SignedSubmissionDocument | undefined;
    const format = options.signing ? normalizeSigningFormat({ ...this.signingFormat, ...options.signing }) : this.signingFormat;
    // A call's statement replaces the host's; an empty one clears it.
    const statement = options.signing?.statement !== undefined ? signingStatementOf(options.signing.statement) : this.signingStatement;
    // The call's provider, else the one the host requires for every submission.
    const signWith = options.signWith ?? this.defaultSignWith;
    const wantsSigning = signWith !== undefined || mode.sign;
    if (wantsSigning) {
      const provider = this.resolveSigningProvider(signWith);
      if (!provider) {
        const missingErrors: FormError[] = [
          {
            id: "signing_0",
            code: "signing.providerMissing",
            message:
              signWith !== undefined
                ? `The submission could not be signed: no signing provider "${signWith}" is registered.`
                : "The submission could not be signed: no signing provider is registered.",
            stage: "signing",
            source: "custom" as const,
            ...(signWith !== undefined ? { parameters: { signWith } } : {})
          }
        ];
        this.rejectSubmission(missingErrors, "runtime");
        this.eventBus.publish({
          id: "submission_failed",
          type: FormEventType.SUBMISSION_FAILED,
          timestamp: Date.now(),
          source: "runtime",
          formId: this.form.id,
          data: { modeId, reason: "signing-provider-missing", ...(signWith !== undefined ? { signWith } : {}) }
        });
        return { accepted: false, errors: missingErrors };
      }
      let results: SignatureResult[];
      try {
        results = await provider.sign({
          canonical: signedCanonicalOf(canonicalSubmission, format.scope, statement),
          participants: this.signatureParticipants(),
          modeId,
          format,
          ...(signWith !== undefined ? { signWith } : {}),
          ...(options.trigger ? { trigger: options.trigger } : {}),
          ...(statement !== undefined ? { statement } : {})
        });
      } catch (error) {
        // A provider that could not sign — a dismissed passkey prompt, no token registered —
        // fails the submission the way a missing provider does: never delivered unsigned.
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
        const failedErrors: FormError[] = [
          {
            id: "signing_1",
            code: "signing.failed",
            message: `The submission could not be signed: ${message}`,
            stage: "signing",
            source: "custom" as const,
            parameters: { providerId: provider.id, message, ...(errorCode ? { errorCode } : {}) }
          }
        ];
        this.rejectSubmission(failedErrors, "runtime");
        this.eventBus.publish({
          id: "submission_failed",
          type: FormEventType.SUBMISSION_FAILED,
          timestamp: Date.now(),
          source: "runtime",
          formId: this.form.id,
          data: { modeId, reason: "signing-failed", providerId: provider.id, message, ...(errorCode ? { errorCode } : {}) }
        });
        return { accepted: false, errors: failedErrors };
      }
      signatures = results.map((result) => ({ ...result, format: result.format ?? format, ...(statement !== undefined && result.statement === undefined ? { statement } : {}) }));
      if (format.placement === "wrapper") {
        signed = { format, payload: canonicalSubmission, signatures };
      } else {
        canonicalSubmission = { ...canonicalSubmission, signatures };
      }
    }

    const submissionId = `${this.form.id}:${Date.now()}`;
    this.stateStore.completeSubmission(submissionId);

    this.eventBus.publish({
      id: "submission_completed",
      type: FormEventType.SUBMISSION_COMPLETED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.form.id,
      data: {
        modeId,
        submissionId,
        submissionKey,
        sign: mode.sign,
        signatureCount: signatures?.length ?? 0,
        ...(signatures ? { signWith: signWith ?? this.signingProvider?.id, signing: format } : {}),
        serverValidation: mode.serverValidation
      }
    });
    // What the host's server passed was about answers now submitted: the next ones are asked afresh.
    this.journeyChecks.forget();

    // Post-acceptance delivery. A handler that throws is isolated and reported via
    // SUBMISSION_HANDLER_FAILED + `handlerErrors`; the submission stays accepted.
    const handlerErrors = await this.runSubmissionHandlers(canonicalSubmission, modeId, signed, submissionKey);

    await this.hostCallback(true, this.hooks.afterSubmit, () =>
      runHookSeries(
        this.hooks.afterSubmit ?? [],
        withProvenance<AfterSubmitHookContext>(
          {
            values: transformedValues,
            modeId,
            submissionId
          },
          agent
        )
      )
    );

    return {
      accepted: true,
      errors: [],
      canonicalSubmission,
      submissionKey,
      ...(signatures ? { signatures } : {}),
      ...(signed ? { signed } : {}),
      ...(handlerErrors.length > 0 ? { handlerErrors } : {})
    };
  }

  /**
   * A stage's rejection of the submission, handed to the renderer: the errors go into the
   * store and ERRORS_CHANGED announces them, so the summary (and any field they name)
   * redraws through the renderer's existing pull model. A stage that only returned its errors
   * from `submit()` left the form looking as if nothing had happened — a signing failure
   * showed in the host's result panel and nowhere on the form. The stage's own
   * SUBMISSION_* event is the caller's, published after this.
   */
  private rejectSubmission(errors: FormError[], source: "validation" | "runtime"): void {
    this.errorStore.setAll(errors);
    this.eventBus.publish({
      id: "errors_changed",
      type: FormEventType.ERRORS_CHANGED,
      timestamp: Date.now(),
      source,
      formId: this.form.id,
      data: { errorCount: errors.length }
    });
    this.stateStore.failSubmission();
    this.revealErrorPage();
  }

  /** The signer for this submission: the id the call named (any provider carries it), else the mode's default. */
  private resolveSigningProvider(signWith: string | undefined): SigningProvider | undefined {
    if (signWith === undefined) {
      return this.signingProvider;
    }
    if (this.signingProvider?.id === signWith) {
      return this.signingProvider;
    }
    return this.signingProviders.find((provider) => provider.id === signWith);
  }

  private async runSubmissionHandlers(
    submission: CanonicalSubmission,
    modeId: string,
    signed: SignedSubmissionDocument | undefined,
    submissionKey: string
  ): Promise<Array<{ id: string; message: string }>> {
    const handlerErrors: Array<{ id: string; message: string }> = [];
    for (const handler of this.submissionHandlers) {
      try {
        await handler.handle(submission, { modeId, formId: this.form.id, submissionKey, ...(signed ? { signed } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handlerErrors.push({ id: handler.id, message });
        this.eventBus.publish({
          id: `submission_handler_failed_${handler.id}_${Date.now()}`,
          type: FormEventType.SUBMISSION_HANDLER_FAILED,
          timestamp: Date.now(),
          source: "runtime",
          formId: this.form.id,
          data: { modeId, handlerId: handler.id, message }
        });
      }
    }
    return handlerErrors;
  }

  private formComponentTypes(): string[] {
    const types = new Set<string>([this.form.root.type]);
    for (const node of this.tree.descendantsOf(this.form.root.id)) {
      types.add(node.type);
    }
    return [...types];
  }

  private installedPluginVersions(): Record<string, string> {
    // The plugins the platform installed (what shaped a formula's value), then the engine registry's.
    const versions: Record<string, string> =
      this.pluginPlatformRef && this.installedPluginsResult
        ? this.pluginPlatformRef.pluginVersions(this.installedPluginsResult.installedPluginIds)
        : {};
    for (const plugin of this.pluginRegistryRef?.listLatest() ?? []) {
      versions[plugin.id] = plugin.version;
    }
    return versions;
  }

  /** The canonical envelope over `values`: Submit's, and a journey check's `document`. */
  private submissionEnvelope(
    enrichedContext: SubmissionVersionContext,
    locale: string,
    values: Record<string, unknown>,
    journeyId: string | undefined
  ): CanonicalSubmission {
    return canonicalizeSubmission({
      versionContext: enrichedContext,
      submission: {
        locale,
        values,
        // Which journey the answers were given through — never its path, which a
        // server works out again from the values.
        ...(journeyId !== undefined ? { journey: { id: journeyId } } : {})
      }
    });
  }

  /**
   * The envelope a journey's check hands its validator: the request's answers, locale and
   * journey under the host's version context, enriched as Submit enriches its own, so a Datum
   * host judges the check over the document it would be sent. The form's version is the
   * request's (the one a submit in progress names).
   */
  private journeyCheckDocument(request: JourneyValidationRequest): CanonicalSubmission | undefined {
    const context = this.submissionVersionContext;
    if (!context) {
      return undefined;
    }
    const enriched = this.enrichVersionContext({ ...context, form: { id: context.form.id, version: request.formVersion } }, false);
    return this.submissionEnvelope(enriched, request.locale, request.values, request.journeyId);
  }

  private enrichVersionContext(
    versionContext: SubmissionVersionContext,
    requireServer: boolean
  ): SubmissionVersionContext {
    const components: Record<string, string> = { ...(versionContext.client.components ?? {}) };
    if (this.componentRegistry) {
      for (const type of this.formComponentTypes()) {
        if (!components[type]) {
          try {
            components[type] = this.componentRegistry.resolve(type).version;
          } catch {
            // Unregistered types are reported by the completeness check.
          }
        }
      }
    }

    const plugins: Record<string, string> = {
      ...(versionContext.client.plugins ?? {}),
      ...this.installedPluginVersions()
    };

    const enriched: SubmissionVersionContext = {
      form: versionContext.form,
      client: {
        ...versionContext.client,
        components,
        plugins
      }
    };
    if (versionContext.server || requireServer) {
      enriched.server = { ...(versionContext.server ?? {}) };
    }
    return enriched;
  }

  private signatureParticipants(): SignatureParticipant[] {
    const participants: SignatureParticipant[] = [];
    for (const node of [this.form.root, ...this.tree.descendantsOf(this.form.root.id)]) {
      if (node.type !== SIGNATURE_COMPONENT_TYPE) {
        continue;
      }
      const config = node.configuration;
      if (config && typeof config === "object" && !Array.isArray(config)) {
        const raw = (config as Record<string, unknown>).participants;
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as { id?: unknown }).id === "string" &&
              typeof (entry as { role?: unknown }).role === "string"
            ) {
              participants.push({
                id: (entry as { id: string }).id,
                role: (entry as { role: string }).role
              });
            }
          }
        }
      }
    }
    return participants;
  }

  /**
   * Hidden-validation / hidden-required policy filter. Drops errors on nodes whose
   * effective state says validation must not run, and `required`-coded errors on nodes
   * where requiredness does not apply.
   *
   * Hiding relaxes "required", not the shape of an answer that is still submitted:
   * on a node not validated whose answer is submitted as given (`submitValue`, not cleared),
   * the field-constraints stage's length, pattern, file size and type errors pass — the
   * validation kernel holds the same answer to the same constraints, and a client choosing
   * the answer that hides a field must not be able to store anything in it. `required`, and
   * every other stage's errors (a plugin's, a custom one), stay dropped. The renderer lists such
   * an error in the summary, since its field is not shown. What a control says about an empty
   * answer (`dateIncomplete`, a `number` marked `badInput`) is not a shape: it goes
   * whenever the component is not visible, whatever its hidden-validation behaviour says — a
   * control nobody sees has nothing to tell the person, and a server never hears it.
   */
  private errorPassesHiddenPolicy(error: {
    code: string;
    stage: string;
    componentId?: string | undefined;
    parameters?: Record<string, unknown> | undefined;
  }): boolean {
    if (!error.componentId) {
      return true;
    }
    // The one lookup: a node the running presentation owns by the overlay, a form
    // component by the fold.
    const effective = this.orchestrator.stateOf(error.componentId)?.effective;
    if (!effective) {
      return true;
    }
    if (!effective.visible && (error.code === "dateIncomplete" || (error.code === "number" && error.parameters?.badInput === true))) {
      return false;
    }
    if (!effective.runValidation) {
      // Not when cleared: the pipeline checks the answer as stored, but a cleared one is
      // submitted empty, and the kernel then has nothing to hold to a shape.
      return (
        error.stage === "field-constraints" &&
        ANSWER_SHAPE_CODES.has(error.code) &&
        error.parameters?.badInput !== true &&
        effective.submitValue &&
        !effective.clearValue
      );
    }
    const isRequiredCode = error.code === "required" || error.code.endsWith(".required");
    if (isRequiredCode && !effective.requiredApplies) {
      return false;
    }
    return true;
  }

  private findComponentById(componentId: string): ComponentNode | undefined {
    const walk = (node: ComponentNode): ComponentNode | undefined => {
      if (node.id === componentId) {
        return node;
      }

      if (!node.children) {
        return undefined;
      }

      for (const slotChildren of Object.values(node.children)) {
        for (const child of slotChildren) {
          const match = walk(child);
          if (match) {
            return match;
          }
        }
      }

      return undefined;
    };

    return walk(this.form.root);
  }

  private readConfigurationPath(configuration: unknown, path: string): unknown {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      return undefined;
    }

    const parts = path.split(".").filter(Boolean);
    let cursor: unknown = configuration;

    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    return cursor;
  }
}
