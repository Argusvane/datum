import {
  BrowserLocalDraftStore,
  DatumFormRendererElement,
  FormRuntime,
  SUBMISSION_SIGNING_PLACEMENTS,
  SUBMISSION_SIGNING_SCOPES,
  NoopJourneyEngine,
  NoopJourneyRenderKit,
  WASM_ABI_VERSION,
  WasmValidationHost,
  addressOf,
  defineDataSources,
  declaredDefaultLocale,
  defineDatumFormRendererElement,
  downloadSubmission,
  duplicateComponentIds,
  negotiateLocale,
  ownValue,
  readJourneys,
  readPrintConfiguration,
  resolveJourneySelection,
  resolveFormText,
  resolveText,
  stringifyComponentPath,
  supportedLocaleCodes,
  type AgentProvenance,
  type CanonicalSubmission,
  type ComponentDefinition,
  type ComponentPath,
  type DataSourceInputs,
  type DataSourceSet,
  type DatumFormActionDetail,
  type DownloadPdfResult,
  type DraftStore,
  type FormDefinition,
  type FormDraftSummary,
  type FormError,
  type FormNotice,
  type FormNoticePlacement,
  type FormPlugin,
  type PrintCallOptions,
  type PrintRenditionsOffered,
  type PrintTheme,
  type FormTextCatalog,
  type HostError,
  type JourneyEngine,
  type JourneyHostChoice,
  type JourneyNavigationResult,
  type JourneyPageKind,
  type JourneyRenderKit,
  type JourneyServerValidator,
  type LocalizedText,
  type PageChangeDirection,
  type PageChangedEventData,
  type PdfLayoutOption,
  type RenderFormPdfOptions,
  type RenderFormPdfResult,
  type RenderMode,
  type SignedSubmissionDocument,
  type SigningProvider,
  type SubmissionSigningFormat,
  type SubmissionSigningOptions,
  type SubmitOptions,
  type SubmitResult,
  SubmitBusyError,
  type TranslationCatalog,
  type ValidationMessageCatalog,
  type WasmLogEntry,
  type WasmLogLevel,
  type WasmPluginModule,
  type WasmSubmissionOutcome,
  type WasmValidationRequest
} from "@argusvane/datum-engine";

import {
  createFormRuntime,
  versionContextFor,
  EMBED_SUBMISSION_MODE
} from "./runtime-factory.js";
import {
  ElementBase,
  canDefineCustomElements,
  MAX_DEFINITION_BYTES,
  allowOriginsProblem,
  DatumCodedError,
  attributeOriginProblem,
  codeOf,
  definitionShapeProblem,
  moduleAttributeUrl,
  emit,
  fetchJson,
  isDefinitionByteLimit,
  parseJsonAttribute,
  parseList,
  reportError,
  reportUnresolved,
  reportWarning,
  resolveStorage,
  toDefinitionByteLimit,
  toFormDefinition
} from "./support.js";
import { themes as sharedThemes, type DatumThemeRegistry, type PdfThemeInput } from "./themes.js";
import { loadPdfSupport } from "./pdf-loader.js";
import { pdfServiceDependencies } from "./pdf-render.js";
import { plugins as sharedPlugins, withPluginDataSources, type DatumPluginRegistry } from "./plugins.js";
// Journey diagnostics come in a lazy chunk, loaded by `debug` alone.
import { reportJourneyDiagnostics } from "./journey-debug.js";
import type { DatumPdfSupport } from "./pdf.js";
import { loadWasmValidationHost } from "./wasm-loader.js";
import { loadWebAuthn } from "./webauthn-loader.js";
import { ChunkLoadError } from "./chunk-load-error.js";
// The journeys runtime: the engine and the render kit a journey form runs and draws
// with, in a lazy chunk; a form with no journeys builds with the Noop pair and never asks for it.
import { loadJourneyEngine, loadedJourneyEngine, type JourneyEngineBundle } from "./journey-engine-loader.js";
import { loadJourneyReview } from "./journey-review-loader.js";
import { createFetchJourneyValidator, loadServerValidator } from "./server-validator-loader.js";
import { createUrlDraftStore, parseDraftStoreSpec, type DraftStoreSpec } from "./draft-store-url.js";
import { adoptPreUpgradeProperties } from "./pre-upgrade.js";
import { plainHostContext } from "./host-context.js";
import {
  AGENT_ACCESS_VALUES,
  DEFAULT_AGENT_ACCESS,
  FORM_FEATURE_PRESETS,
  parseFormFeatures,
  type AgentAccess,
  type FormFeature,
  type FormFeaturesInput
} from "./form-features.js";
// The agent tools: a lazy chunk the opt-in `agent` token asks for; the entry holds only the loader and types.
import { loadAgent } from "./agent-loader.js";
import type { AgentMarks, FormAgentAttachment } from "./agent.js";
import type { AgentTool, AgentToolResult } from "@argusvane/datum-engine/agent";
import type {
  FormChromeConfiguration,
  FormulaErrorPolicy,
  PdfSignatureOptions,
  PdfSigner,
  PdfTemplateResolver,
  LiveAssets,
  LiveBinding,
  PdfThemeDefinition,
  PdfUnknownComponentPolicy
} from "@argusvane/datum-engine";

export const DATUM_FORM_TAG = "datum-form";

/** The renderer the element's shadow root holds (`<datum-form-renderer part="form">`). */
const DATUM_FORM_RENDERER_TAG = "datum-form-renderer";

/** The element's own rules: its box, the renderer's, and the alert that takes the form's place. */
const FORM_ELEMENT_CSS = `:host { display: block; } datum-form-renderer { display: block; }
[data-form-error] { --notice-fg: #b3261e; --notice-bg: #fdecea; --notice-border: #b3261e; margin: 0 0 var(--space-3, 0.75rem); padding: var(--space-3, 0.75rem) var(--space-4, 1rem); border: 1px solid var(--color-error-border, var(--color-error, var(--notice-border))); border-radius: var(--radius-control, 4px); background: var(--color-error-bg, var(--notice-bg)); color: var(--color-error, var(--notice-fg)); font: inherit; }
@media (prefers-color-scheme: dark) { [data-form-error] { --notice-fg: #ffb4ab; --notice-bg: #3b1512; --notice-border: #ffb4ab; } }
[data-form-error] p, [data-form-error] ul { margin: 0; }
[data-form-error] ul { margin-top: var(--space-2, 0.5rem); padding-left: 1.25rem; }
[data-form-error] button { margin-top: var(--space-2, 0.5rem); font: inherit; }
datum-form-renderer[hidden] { display: none !important; }
`;

/** Detail of `datum-submit`: the outcome of `FormRuntime.submit` for the embedded form. */
export interface DatumFormSubmitDetail {
  accepted: boolean;
  /** The canonical submission envelope, present when accepted. */
  submission: CanonicalSubmission | undefined;
  errors: FormError[];
  /** The full runtime result, for a page that wants the signatures or handler errors. */
  result: SubmitResult;
  /**
   * Under the `"wrapper"` signing placement: the document to deliver — the envelope
   * untouched as its `payload`, the signatures beside it. Absent under `"embedded"`, where the
   * signatures ride on `submission` itself.
   */
  signed?: SignedSubmissionDocument;
  /**
   * `"agent"` when an agent tool submitted the form: the way a page tells
   * an assistant's submit from the person's. Absent otherwise; never forwarded to the runtime.
   */
  trigger?: "agent";
  /**
   * The attempt's key, on an accepted submit: minted when the attempt started, the
   * same for a call that joined it, a new one for the next submit. The page sends it beside the
   * document (`{ document, submissionKey }`) and sends it unchanged when it retries the delivery,
   * so the receiving service keeps one record per attempt, not one per set of answers.
   */
  submissionKey?: string;
  /**
   * The page's account of the answers the agent tools wrote:
   * which submitted answers they wrote last, whether they were ever involved, who started this
   * submit. Absent when the agent tools were never live for this form since it loaded (never
   * registered, or only ever sealed by `agent-access="definition"`).
   * Client-side and advisory, never in the canonical envelope; the `beforeSubmit` and
   * `afterSubmit` hooks get a frozen copy as `context.agent`.
   */
  agent?: AgentProvenance;
  /**
   * Keeps the form submitting until `promise` settles: the page hands over its
   * delivery — the `fetch` of the envelope — and the form stays locked, its status line up,
   * until the reply is in. Call it while the event is being dispatched, or while an earlier
   * extension is still pending; afterwards it throws. A rejected promise is reported as
   * `datum-error` and lifts the lock like a resolved one — what the page shows for it is
   * the page's `catch` (`setErrors`).
   */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Detail of `datum-change`: a value changed. `path` is the value path written (a component
 * id, or `container.field` inside a data-scoping container), `value` what it now holds, and
 * `values` the whole form's current values.
 *
 * Not one per keystroke: a value typed in reports once it has settled — under
 * `change-on="input"` (the default) after `change-debounce` ms without another keystroke or
 * when the field is left, whichever comes first; under `change-on="commit"` only when the
 * field is left. A pick (a select, a checkbox, a radio, a clickable renderer) and a value the
 * page writes report at once. What is still pending is reported before `datum-submit`.
 *
 * The form's answers alone: `values` never holds what a presentation's own fields
 * hold (`presentationValues()` does), and a write to one is not reported by its path — what
 * it moves on the form is: each worked-out value it feeds that changed, as a change of that
 * form field. An alias writes the form field it fills, and is reported as that field.
 */
export interface DatumFormChangeDetail {
  path: string | undefined;
  value: unknown;
  values: Record<string, unknown>;
}

/** Detail of `datum-validated`: the errors after `validate()` ran. */
export interface DatumFormValidatedDetail {
  errors: FormError[];
}

/** Detail of `datum-ready`: a runtime was built for the current definition. */
export interface DatumFormReadyDetail {
  runtime: FormRuntime;
}

/** Detail of `datum-wasm-ready`: the sandbox behind the form has arrived. */
export interface DatumFormWasmReadyDetail {
  host: WasmValidationHost;
}

/**
 * Detail of `datum-wasm-validated`: what crossed the sandbox at a submit. `logs` is
 * the run log — the kernel's steps and what the rules said, at the level
 * `wasm-log-level` asked for — for the page to forward to its console or its logger; the
 * sandbox itself has none. `outcome` is the sandbox's answer, `executionError` why it gave
 * none.
 */
export interface DatumFormWasmValidatedDetail {
  blocked: boolean;
  durationMs: number;
  unknownFields: string;
  logLevel?: WasmLogLevel;
  values: Record<string, unknown>;
  externalData?: Record<string, unknown>;
  outcome?: WasmSubmissionOutcome;
  executionError?: string;
  logs: WasmLogEntry[];
}

/**
 * Detail of `datum-page-change`: a journey moved to another page — on Continue
 * (`"forward"`), Back (`"back"`), a jump to a page already reached (`"jump"`), a Check answers
 * page's Change link (`"change"`: `returnPageId` names the Check answers page, which Continue goes
 * back to; it stays on each move until the person is there again), to the page holding an error
 * after a blocked submit (`"error"`), a journey started over the running form (`"start"`) or a
 * draft restored (`"resume"`). `"redirect"` reports a page the host asked for
 * (the `page` attribute) that the answers cannot reach: `pageId` is the page the person is on instead,
 * and the page draws a polite line saying so until the next move. `index` and `total` place the page on
 * the path as the answers draw it now (0-based; every page on it, an exit page included),
 * `title` is its heading in the form's locale, and `errorCount` the errors that block which
 * the page shows — on its fields and in its summary. For a page keeping the address bar in
 * step (`history.pushState` here, `goToPage` on `popstate`) or prefixing its title with
 * "Error: " while the page has errors.
 */
export interface DatumFormPageChangeDetail {
  journeyId: string;
  pageId: string;
  /** `null` when the journey has just started. */
  fromPageId: string | null;
  direction: PageChangeDirection | "redirect";
  index: number;
  total: number;
  title: string;
  kind: JourneyPageKind;
  errorCount: number;
  /** The Check answers page the person is on the way back to after a Change link; absent otherwise. */
  returnPageId?: string;
}

/** A journey the form declares, as `journeys()` lists it for a page offering a choice. */
export interface DatumFormJourneyOption {
  id: string;
  /** Its `name` in the form's locale, else its id. */
  label: string;
}

const WASM_LOG_LEVELS: readonly WasmLogLevel[] = ["off", "error", "warn", "info", "debug"];

function toWasmLogLevel(value: string): WasmLogLevel {
  if (!(WASM_LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`wasm-log-level must be one of ${WASM_LOG_LEVELS.join(", ")}, not "${value}"`);
  }
  return value as WasmLogLevel;
}

function toSigningScope(value: string): SubmissionSigningFormat["scope"] {
  if (!(SUBMISSION_SIGNING_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`signing-scope must be one of ${SUBMISSION_SIGNING_SCOPES.join(", ")}, not "${value}"`);
  }
  return value as SubmissionSigningFormat["scope"];
}

function toSigningPlacement(value: string): SubmissionSigningFormat["placement"] {
  if (!(SUBMISSION_SIGNING_PLACEMENTS as readonly string[]).includes(value)) {
    throw new Error(`signing-placement must be one of ${SUBMISSION_SIGNING_PLACEMENTS.join(", ")}, not "${value}"`);
  }
  return value as SubmissionSigningFormat["placement"];
}

const PDF_UNKNOWN_COMPONENT_POLICIES: readonly PdfUnknownComponentPolicy[] = ["ignore", "warn", "fail"];

const FORMULA_ERROR_POLICIES: readonly FormulaErrorPolicy[] = ["fail", "warn"];

function toFormulaErrors(value: string): FormulaErrorPolicy {
  if (!(FORMULA_ERROR_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`formula-errors must be one of ${FORMULA_ERROR_POLICIES.join(", ")}, not "${value}"`);
  }
  return value as FormulaErrorPolicy;
}

/** The `agent-access` sentence for a word outside the three. */
function agentAccessError(value: unknown): string {
  return `agent-access must be "always", "definition" or "never"; got "${String(value)}"`;
}

function toAgentAccess(value: string): AgentAccess {
  if (!(AGENT_ACCESS_VALUES as readonly string[]).includes(value)) {
    throw new Error(agentAccessError(value));
  }
  return value as AgentAccess;
}

const RISKY_PATTERN_POLICIES: readonly ("refuse" | "allow")[] = ["refuse", "allow"];

function toRiskyPatterns(value: string): "refuse" | "allow" {
  if (!(RISKY_PATTERN_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`risky-patterns must be one of ${RISKY_PATTERN_POLICIES.join(", ")}, not "${value}"`);
  }
  return value as "refuse" | "allow";
}

function toPdfUnknownComponents(value: string): PdfUnknownComponentPolicy {
  if (!(PDF_UNKNOWN_COMPONENT_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`pdf-unknown-components must be one of ${PDF_UNKNOWN_COMPONENT_POLICIES.join(", ")}, not "${value}"`);
  }
  return value as PdfUnknownComponentPolicy;
}

/**
 * When a value typed into a field is reported as `datum-change`: `"input"` once
 * typing pauses for `change-debounce` ms (or the field is left), `"commit"` only when the
 * field is left.
 */
export type DatumFormChangeOn = "input" | "commit";

const CHANGE_ON_VALUES: readonly DatumFormChangeOn[] = ["input", "commit"];

function toChangeOn(value: string): DatumFormChangeOn {
  if (!(CHANGE_ON_VALUES as readonly string[]).includes(value)) {
    throw new Error(`change-on must be one of ${CHANGE_ON_VALUES.join(", ")}, not "${value}"`);
  }
  return value as DatumFormChangeOn;
}

function toChangeDebounce(value: string): number {
  const parsed = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`change-debounce must be a whole number of milliseconds, not "${value}"`);
  }
  return parsed;
}

/** `data-source-wait`: `none` (paint at once) or `all` (paint when every source has answered or timed out). */
/** Absent `wasm-timeout`: fifteen seconds for the sandbox module to arrive. */
const DEFAULT_WASM_TIMEOUT_MS = 15000;

function toDataSourceWait(value: string): "none" | "all" {
  const wait = value.trim().toLowerCase();
  if (wait !== "none" && wait !== "all") {
    throw new Error(`data-source-wait must be "none" or "all", not "${value}"`);
  }
  return wait;
}

/** A whole number of milliseconds, `0` for no limit: `data-source-timeout` and `wasm-timeout`. */
function toTimeoutMs(name: string, value: string): number {
  const parsed = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole number of milliseconds (0 for no limit), not "${value}"`);
  }
  return parsed;
}

function toValidateTimeout(value: string): number {
  const parsed = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`validate-timeout must be a whole number of milliseconds (0 for no limit), not "${value}"`);
  }
  return parsed;
}

/** Whether a list of chrome parts holds a language switcher, at the top or inside a group. */
function hasLanguageSwitcherPart(parts: FormChromeConfiguration["header"]): boolean {
  return (parts ?? []).some((part) => part.type === "language-switcher" || (part.type === "group" && hasLanguageSwitcherPart(part.parts)));
}

/**
 * The page's `chrome` with the attribute shorthand (`language-switcher`, `frame`,
 * `frame-fixed`) merged in. Where both name the same setting the `chrome` wins whole: a `frame`
 * in it is used as it stands (`fixed` or not), and a language-switcher part in its header or
 * footer, wherever the page placed it, means the attribute adds none. Otherwise the shorthand
 * fills in: a frame, or a switcher at the end of the header. Nothing in either: `undefined`.
 */
function mergeChromeShorthand(chrome: FormChromeConfiguration | undefined, shorthand: FormChromeConfiguration): FormChromeConfiguration | undefined {
  if (Object.keys(shorthand).length === 0) {
    return chrome;
  }
  if (chrome === undefined) {
    return shorthand;
  }
  const switcher = shorthand.header;
  const addSwitcher = switcher !== undefined && !hasLanguageSwitcherPart(chrome.header) && !hasLanguageSwitcherPart(chrome.footer);
  return {
    ...chrome,
    ...(addSwitcher ? { header: [...(chrome.header ?? []), ...switcher] } : {}),
    ...(shorthand.frame !== undefined && (chrome.frame === undefined || chrome.frame === null) ? { frame: shorthand.frame } : {})
  };
}

/** A lazy file that did not arrive: the packages's `ChunkLoadError`, or the engine's same-named error from its own chunk loader. */
function isChunkLoadError(error: unknown): error is Error {
  return error instanceof ChunkLoadError || (error instanceof Error && error.name === "ChunkLoadError");
}

/**
 * Whether two `features` lists name the same capabilities apart from the opt-in `agent` token: an absent list is every capability but the opt-in ones, the same as `all`.
 */
function differsOnlyInAgent(previous: ReadonlySet<FormFeature> | undefined, next: ReadonlySet<FormFeature> | undefined): boolean {
  const words = (set: ReadonlySet<FormFeature> | undefined): FormFeature[] => [...(set ?? FORM_FEATURE_PRESETS.all)].filter((feature) => feature !== "agent").sort();
  const before = words(previous);
  const after = words(next);
  return before.length === after.length && before.every((feature, index) => feature === after[index]);
}

/** An attribute that names something, trimmed; empty is the same as absent. */
function namedValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The attributes that name code to import or an endpoint that receives answers, with the property each sets. */
const ORIGIN_BOUND_ATTRIBUTES: Readonly<Record<string, string>> = {
  wasm: "wasm",
  pdf: "pdf",
  "draft-store": "draftStore",
  "validate-url": "validateUrl"
};

/** The absolute URL an origin-bound attribute's value names; `undefined` for one that names none (`auto`, `local`, blank). */
function originBoundUrl(name: string, value: string): string | undefined {
  switch (name) {
    case "wasm":
    case "pdf":
      return moduleAttributeUrl(value);
    case "validate-url": {
      const named = namedValue(value);
      return named === undefined ? undefined : new URL(named, document.baseURI).href;
    }
    case "draft-store": {
      if (value.trim() === "") {
        return undefined;
      }
      const spec = parseDraftStoreSpec(value);
      return spec.kind === "server" ? spec.url : undefined;
    }
    default:
      return undefined;
  }
}

function isBlocking(error: FormError): boolean {
  return (error.severity ?? "error") === "error";
}

/** What a submit hands the page's external-data resolver: the form's id, the values as submitted, the locale. */
export interface DatumFormWasmExternalDataContext {
  formId: string;
  values: Record<string, unknown>;
  locale?: string | undefined;
}

/**
 * What the page injects into the sandbox beside the values: a snapshot, or a
 * function resolving one per submit. The sandbox itself never fetches, so whatever the rules
 * need to read — a list from the server, today's date — is gathered here, outside it. Every
 * value must be plain data.
 */
export type DatumFormWasmExternalData =
  | Record<string, unknown>
  | ((context: DatumFormWasmExternalDataContext) => Record<string, unknown> | Promise<Record<string, unknown>>);

/** A sandbox the page built: a host, or a promise of one (a submit before it arrives waits for it). */
export type DatumFormWasmHost = WasmValidationHost | Promise<WasmValidationHost>;

/** What `mode` accepts: the two the renderer paints. */
export type DatumFormMode = Extract<RenderMode, "interactive" | "readonly">;

/** A page's data sources: what `defineDataSources` takes, or a set it already built. */
export type DatumFormDataSources = DataSourceInputs | DataSourceSet;

type Update = "runtime" | "renderer" | "locale" | "values" | "pdf" | "journey" | "page" | "validator" | "host-context";

/** What a submit in flight was asked, so a second call can join it or be refused ({@link DatumFormElement.submitAsk}). */
interface SubmitAsk {
  definition: FormDefinition | undefined;
  runtime: FormRuntime | undefined;
  route: string;
}

function sameSubmitAsk(a: SubmitAsk, b: SubmitAsk): boolean {
  return a.definition === b.definition && a.runtime === b.runtime && a.route === b.route;
}

/** What a submit through the element takes: the page's options, and the download's skipped end check. */
type ElementSubmitOptions = Pick<SubmitOptions, "signWith" | "signing" | "trigger" | "journeyEndCheck"> & {
  /** The submit only saves a local copy (the download route): nothing is sent, so the built-in confirmation stays quiet. */
  localCopy?: boolean;
  /** An agent tool is submitting: the `datum-submit` detail carries `trigger: "agent"`; the runtime never sees this key. */
  agent?: true;
};

const AUTOSAVE_DEBOUNCE_MS = 300;
/** How long typing must pause before a value is reported as `datum-change`. */
const DEFAULT_CHANGE_DEBOUNCE_MS = AUTOSAVE_DEBOUNCE_MS;

/**
 * The reference a delivery's reply carries, if it has one: a `reference` or `confirmationNumber`
 * on the value a `waitUntil` promise settled with, or on its `receipt`. A reply that is not an
 * object, or names none, has no reference and the confirmation is shown without one.
 */
function receiptReference(replies: readonly unknown[]): string | undefined {
  for (const reply of replies) {
    if (!reply || typeof reply !== "object") {
      continue;
    }
    const outer = reply as Record<string, unknown>;
    const holder = outer.receipt && typeof outer.receipt === "object" ? (outer.receipt as Record<string, unknown>) : outer;
    for (const key of ["reference", "confirmationNumber"]) {
      const value = holder[key];
      if ((typeof value === "string" && value.trim() !== "") || typeof value === "number") {
        return String(value);
      }
    }
  }
  return undefined;
}

/**
 * The bounds of a notice's `data` (what `{{receipt.<path>}}` reads in a printed header or footer):
 * nested at most {@link NOTICE_DATA_MAX_DEPTH} objects or arrays below the top one, at most
 * {@link NOTICE_DATA_MAX_VALUES} values read in all (every key and array slot counts, kept or
 * not), and no string longer than {@link NOTICE_DATA_MAX_STRING} characters (a key or a value:
 * dropped, never cut).
 */
const NOTICE_DATA_MAX_DEPTH = 8;
const NOTICE_DATA_MAX_VALUES = 500;
const NOTICE_DATA_MAX_STRING = 2000;

/** A plain object of any realm: `{}` or `Object.create(null)`, never a class instance, a Response, a Map or a Proxy whose traps throw. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  } catch {
    return false;
  }
}

/**
 * `value` reduced to plain JSON for a notice's `data`: strings, finite numbers, booleans, null,
 * arrays and plain objects, within the bounds above; anything else (a function, a symbol, a
 * bigint, a date, a class instance, a value past the bounds, a reference back to an object
 * being read) is dropped, its key or array slot with it. `undefined` when `value` is no plain
 * object. Never throws, whatever getters or proxies it meets.
 */
function plainNoticeData(value: unknown): Record<string, unknown> | undefined {
  let budget = NOTICE_DATA_MAX_VALUES + 1;
  const reading = new Set<object>();
  const define = (out: Record<string, unknown>, key: string, item: unknown): void => {
    // Defined, not assigned: a key named `__proto__` is an entry, not a prototype.
    Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
  };
  const reduce = (input: unknown, depth: number): { value: unknown } | undefined => {
    budget -= 1;
    if (budget < 0) {
      return undefined;
    }
    if (input === null || typeof input === "boolean") {
      return { value: input };
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? { value: input } : undefined;
    }
    if (typeof input === "string") {
      return input.length <= NOTICE_DATA_MAX_STRING ? { value: input } : undefined;
    }
    if (typeof input !== "object" || depth > NOTICE_DATA_MAX_DEPTH || reading.has(input)) {
      return undefined;
    }
    let list: boolean;
    try {
      list = Array.isArray(input);
    } catch {
      return undefined;
    }
    if (!list && !isPlainRecord(input)) {
      return undefined;
    }
    reading.add(input);
    try {
      if (list) {
        const items = input as unknown[];
        const length = typeof items.length === "number" ? items.length : 0;
        const out: unknown[] = [];
        for (let index = 0; index < length && budget > 0; index += 1) {
          const item = reduce(items[index], depth + 1);
          if (item !== undefined) {
            out.push(item.value);
          }
        }
        return { value: out };
      }
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (budget <= 0) {
          break;
        }
        if (key.length > NOTICE_DATA_MAX_STRING) {
          budget -= 1;
          continue;
        }
        let raw: unknown;
        try {
          raw = record[key];
        } catch {
          budget -= 1;
          continue;
        }
        const item = reduce(raw, depth + 1);
        if (item !== undefined) {
          define(out, key, item.value);
        }
      }
      return { value: out };
    } catch {
      return undefined;
    } finally {
      reading.delete(input);
    }
  };
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const top = reduce(value, 0);
  return top !== undefined && isPlainRecord(top.value) ? top.value : undefined;
}

/**
 * The receipt data a delivery's reply carries: the first reply that is a plain object (a parsed
 * JSON body, never a fetch Response), or its `receipt` object when it has one, reduced by
 * {@link plainNoticeData}.
 */
function receiptData(replies: readonly unknown[]): Record<string, unknown> | undefined {
  for (const reply of replies) {
    if (!isPlainRecord(reply)) {
      continue;
    }
    let inner: unknown;
    try {
      inner = reply.receipt;
    } catch {
      inner = undefined;
    }
    const data = plainNoticeData(isPlainRecord(inner) ? inner : reply);
    if (data !== undefined) {
      return data;
    }
  }
  return undefined;
}

/** Whether a text of a notice says something: a non-empty string, or a `LocalizedText` with one. */
function noticeWords(value: unknown): boolean {
  if (typeof value === "string") {
    return value !== "";
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const text = value as { default?: unknown; locales?: unknown };
  return (typeof text.default === "string" && text.default !== "") || (!!text.locales && typeof text.locales === "object" && Object.values(text.locales).some((entry) => typeof entry === "string" && entry !== ""));
}

/** Whether a notice draws anything: a title, a message or a detail. One that carries only its `data` draws nothing and takes no focus. */
function noticeDraws(notice: FormNotice): boolean {
  return noticeWords(notice.title) || noticeWords(notice.message) || (Array.isArray(notice.details) && notice.details.some((detail) => detail !== null && typeof detail === "object"));
}

/** `notice` with its `data` reduced to plain JSON ({@link plainNoticeData}); the notice itself when it carries no `data` key. */
function withPlainData(notice: FormNotice | undefined): FormNotice | undefined {
  if (!notice || typeof notice !== "object" || !Object.prototype.hasOwnProperty.call(notice, "data")) {
    return notice;
  }
  const { data, ...rest } = notice;
  const plain = plainNoticeData(data);
  return plain !== undefined ? { ...rest, data: plain } : rest;
}

/**
 * A value typed but not yet reported, and the timer that will report it (input mode). The value
 * itself is read from the form when the report goes out, never kept here.
 */
interface PendingChange {
  timer?: ReturnType<typeof setTimeout> | undefined;
}
const DRAFT_STORE_PREFIX = "datum-form:";

/** Whether two answers are the same: the same value, or the same JSON (an object rebuilt by a recompute). */
function sameAnswer(before: unknown, after: unknown): boolean {
  return Object.is(before, after) || (typeof before === "object" && typeof after === "object" && JSON.stringify(before) === JSON.stringify(after));
}

/** The value path a change event is about, as `datum-change` reports it; `""` when the event names none. */
function changedPathOf(event: { path?: ComponentPath; componentId?: string }): string {
  return event.path ? stringifyComponentPath(event.path) : (event.componentId ?? "");
}

function isDataSourceSet(value: DatumFormDataSources): value is DataSourceSet {
  return typeof (value as DataSourceSet).ids === "function" && typeof (value as DataSourceSet).has === "function";
}

/**
 * The host the runtime is built with whenever the element has a way to a sandbox — `wasm` set,
 * or `wasmValidationHost` assigned — before that sandbox has necessarily arrived. It is a host
 * in name alone: each run defers to whichever sandbox the element resolves at that moment (the
 * page's, else the module's for the plugins of the moment). So a submit before the sandbox has
 * loaded waits for it rather than skipping it; the sandbox landing later rebuilds nothing,
 * which would drop what has been typed; and a change of plugins takes effect on the next submit.
 */
class DeferredWasmValidationHost extends WasmValidationHost {
  constructor(private readonly resolve: () => Promise<WasmValidationHost>) {
    // The base holds an instance; this one is never run, as `run` defers past it.
    super([], {
      instance: {
        abiVersion: WASM_ABI_VERSION,
        run: () => {
          throw new Error("The deferred sandbox runs through the one it resolves");
        }
      }
    });
  }

  public override run(request: WasmValidationRequest): Promise<WasmSubmissionOutcome> {
    return this.resolve().then((host) => host.run(request));
  }

  /** The sandboxes it resolves to are the element's, or the page's, to release. */
  public override dispose(): void {}
}

/** A sandbox load in progress or done: what it was asked for, and the host once it has arrived. */
interface WasmLoad {
  spec: string;
  /** The modules it was wired with: the installed plugins', then the page's `wasmPlugins`. */
  plugins: readonly WasmPluginModule[];
  host: Promise<WasmValidationHost>;
  ready: WasmValidationHost | undefined;
}

/** Whether two module lists are the same modules in the same order — a rebuilt runtime with the same plugins keeps its sandbox. */
function sameModules(a: readonly WasmPluginModule[], b: readonly WasmPluginModule[]): boolean {
  return a.length === b.length && a.every((module, index) => module === b[index]);
}

/** The pair a form with no journeys is built with: nothing to load, so nothing is fetched. */
const NOOP_JOURNEY_BUNDLE: Pick<JourneyEngineBundle, "engine" | "renderKit"> = { engine: NoopJourneyEngine, renderKit: NoopJourneyRenderKit };

/**
 * The journeys runtime for a form that runs one: the journeys chunk's engine and the kit
 * the definition's journeys need (`forDefinition`: with a Check answers page, the kit over that
 * page's chunk). A definition with such a page starts both fetches at once, and a form with none never asks for the second. Either chunk failing rejects the
 * build as a journeys chunk failure.
 */
function journeysBundle(definition: FormDefinition): Promise<Pick<JourneyEngineBundle, "engine" | "renderKit">> {
  const review = readJourneys(definition).some((journey) => journey.pages.some((page) => page.kind === "review")) ? loadJourneyReview() : undefined;
  return Promise.all([loadedJourneyEngine() ?? loadJourneyEngine(), review]).then(([journeys, check]) => journeys.forDefinition(definition, check));
}

/**
 * A form waiting for its runtime to be built: the calls a page makes meanwhile
 * (`nextPage`, `validate`, `submit`, ...) wait on `promise`. It resolves once a runtime is bound,
 * and they run then, in the order they were made; it rejects with why the runtime could not be
 * loaded, and they reject with that.
 */
interface BuildGate {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function openBuildGate(): BuildGate {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A failure no call waits on is told by the card and `datum-error`, never as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * The form renderer as one element a page configures with a form definition and plain data.
 *
 * Nothing but the form: its shadow root holds a bare `<datum-form-renderer>` — no Validate /
 * Print row, no panels — and the element builds the `FormRuntime` behind it from the standard
 * component catalogue, the engine's field-constraint validation and whatever the page hands
 * over (data sources, translations, a draft key). Every input is an attribute (JSON where it is
 * an object) with a matching property; the property is the better route for anything large.
 *
 * ```html
 * <datum-form language-switcher src="/forms/intake.json"></datum-form>
 * <script type="module">
 *   const form = document.querySelector("datum-form");
 *   form.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
 *   form.addEventListener("datum-submit", (event) => console.log(event.detail.submission));
 * </script>
 * ```
 *
 * A `button` component with `action: "submit"` submits through `submit()`, so the page
 * listens for `datum-submit` and delivers the envelope wherever it goes — through
 * `detail.waitUntil(fetch(...))`, which keeps the form locked and its status line up until
 * the reply is in. The body a receiving service reads is
 * the document and the attempt's key, `{ document: detail.signed ?? detail.submission,
 * submissionKey: detail.submissionKey }`: a retried delivery sends the same key and is kept
 * once, another submit has a key of its own. What the reply says goes back in
 * through `setErrors` (a verdict) or `setNotice` (a receipt). One with `action: "download"`
 * goes through `submitAndDownload()`: the same submit, and when accepted the envelope is
 * saved as a JSON file (cancel `datum-download` to take the file over). Other actions are
 * reported as `datum-form-action` for the page to handle.
 *
 * `pdf="auto"` loads the PDF module (`datum-pdf.js`, beside the bundle; or the URL given)
 * on first use, and with it `renderPdf()` / `downloadPdf()` and a `button` with
 * `action: "pdf"` produce the form as a PDF under the definition's layouts. A page
 * that imports the module itself assigns `pdfSupport` instead.
 *
 * `wasm="auto"` loads the sandbox module (`datum-wasm.js`, beside the bundle; or the URL
 * given) once the form is ready and wires it with the page's `wasmPlugins`; every submit then
 * re-validates and sanitizes inside the QuickJS sandbox, the rules'
 * verdicts showing on the form like any other error, with `wasmExternalData` as what the rules
 * may read beside the values. A page that imports the module itself assigns
 * `wasmValidationHost` instead.
 *
 * `datum-change` reports a value once it has settled, not on every keystroke:
 * with `change-on="input"` (the default) after `change-debounce` ms of quiet (300 by default;
 * `0` reports every write) or when the field is left, with `change-on="commit"` only when the
 * field is left. Picks and values the page writes report at once, and anything still pending
 * is reported before `datum-submit`.
 *
 * A form with journeys opens as one — a page at a time, Back above it and Continue
 * under it, Submit on the last — unless the definition says it opens as the whole form.
 * `journey` is the page's say: a journey's id, `"form"` for the whole form on one page, or
 * `"journey"` for the definition's default journey; changing it restarts the journey over
 * the answers already typed. `page` opens a page the person may already reach (a deep link,
 * a resume point); at the start only the first page is, so a later one waits for a draft
 * whose completed pages reach it, and the person's first move forgets it. Each move is reported as `datum-page-change`, and a draft is saved on it.
 * When a journey asks the service to check a page or the whole journey, `serverValidator`
 * (a function) or `validate-url` (a URL the element posts the check to, as a Datum host's
 * `POST /api/submissions/validate` takes it) is how the element reaches it; `validate-timeout` bounds each check.
 */
/** The `submitting-placement` attribute: the ends named, separated by spaces or commas. */
function parseSubmittingPlacement(raw: string): FormNoticePlacement[] {
  return parseList(raw).map((token) => {
    if (token !== "top" && token !== "bottom") {
      throw new Error(`submitting-placement lists "top" and/or "bottom", not "${token}"`);
    }
    return token;
  });
}

/** The `error-summary` attribute: the ends named, separated by spaces or commas, or "none". */
function parseErrorSummaryPlacement(raw: string): FormNoticePlacement[] {
  const tokens = parseList(raw);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "none")) {
    return [];
  }
  return tokens.map((token) => {
    if (token !== "top" && token !== "bottom") {
      throw new Error(`error-summary lists "top" and/or "bottom", or "none", not "${token}"`);
    }
    return token;
  });
}

export class DatumFormElement extends ElementBase {
  static get observedAttributes(): string[] {
    return [
      "definition",
      "src",
      "max-definition-bytes",
      "mode",
      "locale",
      "language-switcher",
      "chrome",
      "frame",
      "frame-fixed",
      "heading-level",
      "debug",
      "messages",
      "texts",
      "submitting-placement",
      "confirmation",
      "error-summary",
      "data-sources",
      "data-source-wait",
      "data-source-timeout",
      "translations",
      "values",
      "host-context",
      "draft",
      "draft-store",
      "features",
      "agent-access",
      "pdf",
      "pdf-theme",
      "pdf-unknown-components",
      "formula-errors",
      "risky-patterns",
      "wasm",
      "wasm-log-level",
      "wasm-timeout",
      "signing-scope",
      "signing-placement",
      "sign-with",
      "change-on",
      "change-debounce",
      "journey",
      "page",
      "validate-url",
      "validate-timeout",
      "allow-origins"
    ];
  }

  private readonly root: ShadowRoot;
  private rendererEl: DatumFormRendererElement | undefined;
  private pdfSpec: string | undefined;
  private pdfSupportValue: DatumPdfSupport | undefined;
  private pdfThemeValue: PdfThemeInput = undefined;
  private pdfLoad: Promise<DatumPdfSupport> | undefined;
  private pdfTemplatesValue: PdfTemplateResolver | undefined;
  private pdfUnknownComponentsValue: PdfUnknownComponentPolicy | undefined;
  private formulaErrorsValue: FormulaErrorPolicy | undefined;
  private riskyPatternsValue: "refuse" | "allow" | undefined;
  private pdfSignerValue: PdfSigner | undefined;
  private pdfSignatureValue: PdfSignatureOptions | undefined;

  private wasmSpec: string | undefined;
  /** The page's own sandbox, as assigned: a host or a promise of one. */
  private wasmHostValue: DatumFormWasmHost | undefined;
  /** The page's sandbox once it has arrived. */
  private wasmHostReady: WasmValidationHost | undefined;
  private wasmPluginsValue: WasmPluginModule[] = [];
  private wasmExternalDataValue: DatumFormWasmExternalData | undefined;
  private wasmLogLevelValue: WasmLogLevel | undefined;
  private signingProviderValue: SigningProvider | undefined;
  private signingProvidersValue: readonly SigningProvider[] | undefined;
  private signingValue: SubmissionSigningOptions | undefined;
  private signWithValue: string | null = null;
  private changeOnValue: DatumFormChangeOn = "input";
  private changeDebounceValue = DEFAULT_CHANGE_DEBOUNCE_MS;
  /** Typed values not yet reported as `datum-change`, by value path, in the order they were first typed. */
  private readonly pendingChanges = new Map<string, PendingChange>();
  /**
   * A write waiting for the recompute it sets off: whether it was typed, and what the
   * running presentation's worked-out values held before it.
   */
  private lastWrite: { interim: boolean; before: Map<string, unknown> } | undefined;
  /** The sandbox loaded from `wasm` for a spec and a plugin list; superseded by a change to either. */
  private wasmLoad: WasmLoad | undefined;

  /** The page's say in which journey opens: an id, `"form"` or `"journey"`; unset, the definition's. */
  private journeyValue: JourneyHostChoice = undefined;
  /** The page a journey opens on, or is taken to, when the person may reach it. */
  private pageValue: string | undefined;
  /** The `page` the host asked for, which the answers could not reach when the journey started: said once the runtime is bound. */
  private redirectedFromStart = false;
  private serverValidatorValue: JourneyServerValidator | undefined;
  private validateUrlValue: string | undefined;
  private validateTimeoutValue: number | undefined;
  private dataSourceWaitValue: "none" | "all" = "none";
  private dataSourceTimeoutValue: number | undefined;
  private wasmTimeoutValue: number | undefined;
  /** The validator built over `validate-url`, kept while the URL is the same one. */
  private fetchValidator: { url: string; validator: JourneyServerValidator } | undefined;
  /** The unknown journey id last warned about: once per choice, however often it is applied. */
  private warnedJourneyId: string | undefined;
  /**
   * The journey the element last started had no page to show for the answers then (every page
   * skipped): new `values` may give it one, so it is tried again when they land.
   */
  private journeyAwaitingAnswers = false;

  private definitionValue: FormDefinition | undefined;
  /** Whether the definition in place is one the page assigned (the property or the attribute), not one `src` brought. */
  private definitionAssigned = false;
  private srcValue: string | undefined;
  private srcToken = 0;
  /** Whether a `src` fetch is on its way: until it lands (or `src` is cleared), no definition is assigned over it. */
  private srcLoading = false;
  /** A definition could not be put in place (a failed `src`, a refused one): the card says so, until a definition arrives or `src` changes. */
  private definitionFailed = false;
  private maxDefinitionBytesValue = MAX_DEFINITION_BYTES;
  /** Every runtime build takes a new one; a journey form's build that ends under an older one is dropped. */
  private buildToken = 0;
  /** Open while a journey form waits for the journeys runtime: what the queueing methods wait on. */
  private buildGate: BuildGate | undefined;
  /** Why the journeys runtime could not be loaded, while the form has no runtime because of it (its card is up). */
  private journeysFailure: Error | undefined;
  /** What the bound runtime's pages are drawn and reported with: the loaded kit for a journey form, else the Noop one. */
  private journeyKit: JourneyRenderKit = NoopJourneyRenderKit;
  /** The definition the bound runtime was built for: answers carry across a rebuild only when it is still the current one. */
  private builtFor: FormDefinition | undefined;
  /**
   * Set when the page puts a definition in place (assigned, read from `src`, or cleared), until a
   * build lands: that build starts the form fresh, even for the very object it had. Any other
   * rebuild is for the form already on the page, and the answers typed so far go across it.
   */
  private freshDefinition = false;
  /**
   * Set when the page assigns `values`, until they are applied: a rebuild that lands meanwhile
   * puts them over the answers it carries across, as the page's latest word on them.
   */
  private valuesAssigned = false;
  /**
   * Set by `reset()` until the build it asks for lands: that build tells the page the form was
   * cleared, as one `datum-change`, since a build applies the seed before anything listens.
   */
  private resetAnnounced = false;
  /**
   * What `ready` hands out: one promise for "becoming ready", settled when a
   * build ends and kept until a new runtime request replaces a settled one. A superseded build
   * settles nothing; a failed one rejects it.
   */
  private readyState: { promise: Promise<void>; resolve(): void; reject(error: unknown): void; settled: boolean } | undefined;
  private bindingValue: LiveBinding | string | undefined = undefined;
  private assetsValue: LiveAssets | undefined = undefined;
  private colorSchemeValue: "light" | "dark" | undefined = undefined;
  /** `debug`: journey diagnostics are logged once the form is built. */
  private debugValue = false;
  /** The registry the `pdf-theme` id resolves through: the page's shared one unless a host sets its own. */
  private themesValue: DatumThemeRegistry = sharedThemes;
  private unsubscribeThemes: (() => void) | undefined;
  /** PDF theme ids reported as unknown and not resolved since: retried on every registration, reported once. */
  private readonly unresolvedThemes = new Set<string>();
  private modeValue: DatumFormMode = "interactive";
  private localeValue: string | undefined;
  private languageSwitcherValue = false;
  private chromeValue: FormChromeConfiguration | undefined;
  private frameValue: string | undefined;
  private headingLevelValue: number | undefined;
  private frameFixedValue = false;
  private messagesValue: ValidationMessageCatalog | undefined;
  private textsValue: FormTextCatalog | undefined;
  private submittingPlacementValue: FormNoticePlacement[] | undefined;
  private errorSummaryPlacementValue: FormNoticePlacement[] | undefined;
  private noticeValue: FormNotice | undefined;
  /** The print theme `print()` draws with; the renderer's basic one when unset. */
  private printThemeValue: PrintTheme | undefined;
  private dataSourcesValue: DataSourceSet | undefined;
  private translationsValue: TranslationCatalog | undefined;
  private valuesValue: Record<string, unknown> | undefined;
  /** What the rules' `host.` paths read: the page's `hostContext`, as {@link plainHostContext} copied it. */
  private hostContextValue: Record<string, unknown> | undefined;
  private draftKeyValue: string | undefined;
  /** The page's own store for the `draft` key, in place of the browser's storage. */
  private draftStoreValue: DraftStore | undefined;
  /** The `draft-store` attribute, read: where the draft goes when no `draftStore` object was assigned. */
  private draftStoreSpec: DraftStoreSpec | undefined;
  /** The origin-bound attributes whose value was refused (another origin): what a change to `allow-origins` looks at again. */
  private readonly refusedUrlAttributes = new Set<string>();
  /**
   * The origin-bound attributes whose own callback has run: an element upgraded from markup has every
   * attribute before the first callback, and `allow-origins` must not apply (and report) one
   * whose callback is still to come.
   */
  private readonly seenUrlAttributes = new Set<string>();
  /** The features that exist; `undefined`, the attribute absent, is every one. */
  private featuresValue: ReadonlySet<FormFeature> | undefined;
  /** The `agent-access` policy as set; `undefined`, the attribute absent, is `DEFAULT_AGENT_ACCESS`. */
  private agentAccessValue: AgentAccess | undefined;
  /** Features already warned about as asked-for-but-left-out: once each, until the list changes. */
  private readonly warnedFeatures = new Set<FormFeature>();
  /** The store the running form saves to: the page's, or the browser's; none without a `draft` key. */
  private activeDraftStore: DraftStore | undefined;
  private componentDefinitionsValue: ComponentDefinition[] = [];
  /** Plugins for this form alone, beside the page's. */
  private pluginsValue: FormPlugin[] = [];
  /** The registry the page's plugins come from: the shared one unless a host sets its own. */
  private pluginRegistryValue: DatumPluginRegistry = sharedPlugins;
  private unsubscribePlugins: (() => void) | undefined;

  private runtimeValue: FormRuntime | undefined;
  /**
   * The agent tools, while the `agent` token is on and the element is on the page: the
   * per-connection controller whose signal unregisters the form, the chunk's attachment once it
   * has landed (undefined when the element left before it did), and the runtime the registrar
   * last saw, so a rebuild is reported as `runtimeReplaced()` and a first build is not.
   */
  private agentAbort: AbortController | undefined;
  private agentAttachment: Promise<FormAgentAttachment | undefined> | undefined;
  private agentLive: FormAgentAttachment | undefined;
  private agentRuntime: FormRuntime | undefined;
  /**
   * What the element keeps for provenance beyond any one
   * registration, the marks the attachment keeps up to date in the chunk (`agent-attach.ts`):
   * `live` once a registration's access read live (a form only ever
   * sealed adds no `agent` key anywhere), `involved`, the documented `agentInvolved`, set on every
   * agent write and kept after a detach, `lost` once a registration that wrote went,
   * `sessions` those registrations opened.
   */
  private readonly agentMarks: AgentMarks = { involved: false, lost: false, sessions: 0, live: false };
  /** The submit in flight, if one is: a second call asking the same joins it rather than starting another. */
  private inFlight: Promise<DatumFormSubmitDetail> | undefined;
  /** What the submit in flight was asked: the form it submits and the route it takes ({@link submitAsk}). */
  private inFlightAsk: SubmitAsk | undefined;
  /**
   * Whether `datum-submit` is being dispatched for the submit in flight. A submit asked then comes
   * from a listener, and joining would hand it a promise (the run's, a download's wrapper, one it
   * chains on) that its own `waitUntil` would have the run wait on for good: it is refused.
   */
  private dispatchingSubmit = false;
  private unsub: Array<() => void> = [];
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<Update>();
  private flushQueued = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    defineDatumFormRendererElement();
  }

  public connectedCallback(): void {
    adoptPreUpgradeProperties(this);
    if (!this.rendererEl) {
      this.buildDom();
      // A definition that failed before the element had a shadow tree to draw the card in.
      if (this.definitionFailed) {
        this.showDefinitionUnavailable();
      }
    }
    this.watchThemes();
    this.watchPlugins();
    this.syncAgent();
    // A definition still on its way from `src` that the page says will run a journey: the journeys
    // runtime starts loading beside it, not after it.
    if (
      this.srcValue !== undefined &&
      this.definitionValue === undefined &&
      this.allows("journeys") &&
      ((this.journeyValue !== undefined && this.journeyValue !== "form") || this.featuresValue?.has("journeys") === true)
    ) {
      this.prefetchJourneys();
    }
    if (this.runtimeValue && !this.pending.has("runtime")) {
      // Re-attached with a live runtime (a host that moved the element): keep its state.
      this.bindRuntime(this.runtimeValue);
      this.rendererEl!.runtime = this.runtimeValue;
      this.flush();
      return;
    }
    this.request("runtime");
    this.flush();
  }

  public disconnectedCallback(): void {
    // A detached element builds nothing (a `src` that arrives meanwhile waits for the page too),
    // so the calls queued on a pending journeys build are told so rather than left hanging; the
    // build is requested afresh when the element is attached again.
    const gate = this.buildGate;
    if (gate) {
      this.buildGate = undefined;
      gate.reject(new Error("<datum-form> was removed from the page before its journeys runtime was built"));
    }
    this.unbindRuntime();
    this.unsubscribeThemes?.();
    this.unsubscribeThemes = undefined;
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = undefined;
    // Off the page: the agent registration goes with it (synchronously, so the browser's tool list follows at once).
    this.syncAgent();
  }

  /**
   * The registry the `pdf-theme` id resolves through:
   * the page's shared `themes` unless a host hands the element one of its own. A PDF theme
   * registered after the element connected is picked up: an id the page could not resolve
   * yet is retried on every registration.
   */
  public get themes(): DatumThemeRegistry {
    return this.themesValue;
  }

  public set themes(value: DatumThemeRegistry | undefined) {
    this.themesValue = value ?? sharedThemes;
    // Off the page the element listens to nothing: connecting subscribes, and a subscription
    // taken now would hold the element for the registry's lifetime (the page's, for the shared one).
    if (this.isConnected) {
      this.watchThemes();
    }
    this.request("renderer");
  }

  private watchThemes(): void {
    this.unsubscribeThemes?.();
    this.unsubscribeThemes = this.themesValue.subscribe(() => {
      if (this.rendererEl) {
        this.request("renderer");
      }
    });
  }

  /**
   * The registry the page's plugins come from: the shared `plugins` unless a host
   * hands the element one of its own. A plugin registered after the element connected is
   * taken up: the runtime is rebuilt with it, as it is for `componentDefinitions`, and the
   * answers typed so far carry over.
   */
  public get pluginRegistry(): DatumPluginRegistry {
    return this.pluginRegistryValue;
  }

  public set pluginRegistry(value: DatumPluginRegistry | undefined) {
    this.pluginRegistryValue = value ?? sharedPlugins;
    // As for `themes`: connecting subscribes, so a detached element holds no subscription.
    if (this.isConnected) {
      this.watchPlugins();
    }
    this.request("runtime");
  }

  private watchPlugins(): void {
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = this.pluginRegistryValue.subscribe(() => {
      if (this.rendererEl) {
        this.request("runtime");
      }
    });
  }

  /** The page's plugins, then this element's own. */
  private allPlugins(): FormPlugin[] {
    return [...this.pluginRegistryValue.plugins(), ...this.pluginsValue];
  }

  public attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    try {
      // An attribute naming another origin's code or endpoint is as good as absent (see attributeOriginProblem).
      if (name in ORIGIN_BOUND_ATTRIBUTES) {
        this.seenUrlAttributes.add(name);
      }
      if (value !== null && name in ORIGIN_BOUND_ATTRIBUTES && !this.originAllows(name, value)) {
        value = null;
      }
      switch (name) {
        case "allow-origins":
          this.allowOriginsChanged(value);
          break;
        case "definition":
          this.definition = value === null ? undefined : toFormDefinition(parseJsonAttribute("definition", value));
          break;
        case "src":
          this.src = value ?? undefined;
          break;
        case "max-definition-bytes":
          this.maxDefinitionBytes = value === null ? undefined : toDefinitionByteLimit(value);
          break;
        case "pdf-theme":
          this.pdfTheme = value ?? undefined;
          break;
        case "pdf-unknown-components":
          this.pdfUnknownComponents = value === null ? undefined : toPdfUnknownComponents(value);
          break;
        case "formula-errors":
          this.formulaErrors = value === null ? undefined : toFormulaErrors(value);
          break;
        case "agent-access":
          // A word outside the three throws here and is reported below; the property keeps its value.
          this.agentAccess = value === null ? undefined : toAgentAccess(value);
          break;
        case "risky-patterns":
          this.riskyPatterns = value === null ? undefined : toRiskyPatterns(value);
          break;
        case "mode":
          if (value !== null && value !== "interactive" && value !== "readonly") {
            throw new DatumCodedError("mode.invalid", `mode must be "interactive" or "readonly", not "${value}"`);
          }
          this.mode = value ?? "interactive";
          break;
        case "locale":
          this.locale = value ?? undefined;
          break;
        case "language-switcher":
          this.languageSwitcher = value !== null;
          break;
        case "chrome":
          this.chrome = value === null ? undefined : parseJsonAttribute("chrome", value);
          break;
        case "frame":
          this.frame = value === null || value.trim() === "" ? undefined : value.trim();
          break;
        case "frame-fixed":
          this.frameFixed = value !== null;
          break;
        case "debug":
          this.debugValue = value !== null;
          if (this.debugValue && this.runtimeValue && this.definitionValue && this.allows("journeys") && readJourneys(this.definitionValue).length > 0) {
            reportJourneyDiagnostics(this, this.definitionValue);
          }
          break;
        case "heading-level": {
          const level = value === null ? NaN : Number(value);
          this.headingLevel = Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined;
          break;
        }
        case "messages":
          this.messages = value === null ? undefined : parseJsonAttribute("messages", value);
          break;
        case "texts":
          this.texts = value === null ? undefined : parseJsonAttribute("texts", value);
          break;
        case "submitting-placement":
          this.submittingPlacement = value === null ? undefined : parseSubmittingPlacement(value);
          break;
        case "error-summary":
          this.errorSummaryPlacement = value === null ? undefined : parseErrorSummaryPlacement(value);
          break;
        case "data-sources":
          this.dataSources = value === null ? undefined : parseJsonAttribute("data-sources", value);
          break;
        case "data-source-wait":
          this.dataSourceWait = value === null ? "none" : toDataSourceWait(value);
          break;
        case "data-source-timeout":
          this.dataSourceTimeout = value === null ? undefined : toTimeoutMs("data-source-timeout", value);
          break;
        case "wasm-timeout":
          this.wasmTimeout = value === null ? undefined : toTimeoutMs("wasm-timeout", value);
          break;
        case "translations":
          this.translations = value === null ? undefined : parseJsonAttribute("translations", value);
          break;
        case "values":
          this.values = value === null ? undefined : parseJsonAttribute("values", value);
          break;
        case "host-context":
          this.hostContext = value === null ? undefined : parseJsonAttribute("host-context", value);
          break;
        case "draft":
          this.draft = value ?? undefined;
          break;
        case "draft-store":
          // An unreadable value clears the previous spec first: drafts must not keep going to the old server.
          this.draftStoreSpec = undefined;
          try {
            this.draftStoreSpec = value === null || value.trim() === "" ? undefined : parseDraftStoreSpec(value);
          } finally {
            this.request("runtime");
          }
          break;
        case "features":
          this.features = value === null ? undefined : value;
          break;
        case "pdf":
          this.pdf = value ?? undefined;
          break;
        case "wasm":
          this.wasm = value ?? undefined;
          break;
        case "wasm-log-level":
          this.wasmLogLevel = value === null ? undefined : toWasmLogLevel(value);
          break;
        case "signing-scope": {
          const { scope: _scope, ...rest } = this.signingValue ?? {};
          this.signing = value === null ? (Object.keys(rest).length > 0 ? rest : undefined) : { ...rest, scope: toSigningScope(value) };
          break;
        }
        case "signing-placement": {
          const { placement: _placement, ...rest } = this.signingValue ?? {};
          this.signing = value === null ? (Object.keys(rest).length > 0 ? rest : undefined) : { ...rest, placement: toSigningPlacement(value) };
          break;
        }
        case "sign-with":
          this.signWith = value;
          break;
        case "change-on":
          this.changeOn = value === null ? "input" : toChangeOn(value);
          break;
        case "change-debounce":
          this.changeDebounce = value === null ? DEFAULT_CHANGE_DEBOUNCE_MS : toChangeDebounce(value);
          break;
        case "journey":
          this.journey = namedValue(value);
          break;
        case "page":
          this.page = namedValue(value);
          break;
        case "validate-url":
          this.validateUrl = namedValue(value);
          break;
        case "validate-timeout":
          this.validateTimeout = value === null ? undefined : toValidateTimeout(value);
          break;
        default:
          break;
      }
    } catch (error) {
      // A parser that knows its cause (bad JSON, a bad byte cap, a bad mode) says so; any other
      // refused value is `attribute.invalid`, and a definition that does not hold up `definition.invalid`.
      reportError(this, codeOf(error, name === "definition" ? "definition.invalid" : "attribute.invalid"), error instanceof Error ? error.message : String(error), error);
      // A definition attribute that does not hold up would otherwise leave the placeholder for ever.
      if (name === "definition") {
        this.showDefinitionUnavailable();
      }
    }
  }

  /**
   * Whether an origin-bound attribute may use `value`; a refusal is reported and remembered, so a
   * later `allow-origins` that lists the origin takes the attribute after all. A value that does
   * not parse is left to its own case to report.
   */
  private originAllows(name: string, value: string): boolean {
    const problem = this.originProblem(name, value);
    if (problem === undefined) {
      this.refusedUrlAttributes.delete(name);
      return true;
    }
    this.refusedUrlAttributes.add(name);
    reportError(this, "attribute.origin-refused", problem);
    return false;
  }

  private originProblem(name: string, value: string): string | undefined {
    let url: string | undefined;
    try {
      url = originBoundUrl(name, value);
    } catch {
      return undefined;
    }
    return url === undefined ? undefined : attributeOriginProblem(this, name, ORIGIN_BOUND_ATTRIBUTES[name]!, url);
  }

  /** A new `allow-origins`: each origin-bound attribute whose verdict it changes is applied again (or dropped). */
  private allowOriginsChanged(value: string | null): void {
    const problem = allowOriginsProblem(value);
    if (problem) {
      reportError(this, "allow-origins.invalid", problem);
    }
    for (const name of Object.keys(ORIGIN_BOUND_ATTRIBUTES)) {
      const current = this.getAttribute(name);
      if (current === null || !this.seenUrlAttributes.has(name) || this.refusedUrlAttributes.has(name) === (this.originProblem(name, current) !== undefined)) {
        continue;
      }
      this.attributeChangedCallback(name, current, current);
    }
  }

  // --- configuration -----------------------------------------------------

  /**
   * The optional capabilities this form has: `journeys`, `print`, `translations`,
   * `data-sources`, `drafts`, `server-validation`, `signing`, `pdf`, `wasm`, with the presets
   * `all` and `minimal` (a single-page form that renders, validates and submits). As the
   * `features` attribute, tokens separated by spaces or commas; the property takes the same
   * string or an array. Absent (`undefined`), every capability is there for the attributes and
   * properties that configure it, as it always was. Present, only the listed ones: the
   * attributes and properties of a left-out capability are ignored with one console warning, its
   * methods reject (or throw, where they are synchronous) naming it, and the files behind it
   * (the PDF module, the sandbox, the WebAuthn code, the server validator) are never requested.
   * A per-feature attribute can narrow a listed feature; none can switch on one the list omits.
   * A word that names nothing is reported as `datum-error` and left out. Reads back the list
   * that applies, in a fixed order. Changing it rebuilds the runtime, the answers typed so far
   * carrying over, except an `agent`-only change, which only registers or withdraws the agent tools.
   * `agent` (the agent tools) is opt-in: not part of `all` and never on without a list;
   * `features="all agent"` turns it on.
   */
  public get features(): readonly FormFeature[] | undefined {
    return this.featuresValue ? [...this.featuresValue] : undefined;
  }

  public set features(value: FormFeaturesInput | undefined) {
    const previous = this.featuresValue;
    if (value === undefined || value === null) {
      this.featuresValue = undefined;
    } else {
      const parsed = parseFormFeatures(value);
      this.featuresValue = new Set(parsed.features);
      if (parsed.unknown.length > 0) {
        // Left out rather than read as "everything": a typo can only narrow what exists.
        reportError(this, "features.unknown", `features names no such feature or preset: ${parsed.unknown.map((word) => `"${word}"`).join(", ")}`);
      }
    }
    this.warnedFeatures.clear();
    // A list that differs only in `agent`: the runtime is built the same either
    // way, so it is kept with its answers and only the agent tools are registered or withdrawn.
    if (!differsOnlyInAgent(previous, this.featuresValue)) {
      this.request("runtime");
    }
    this.syncAgent(true);
  }

  /**
   * Whether this form's agent tools run, once the `agent` token loads them:
   * `"always"`, the page enforces them whatever the definition says; `"definition"` (the default
   * when absent, `DEFAULT_AGENT_ACCESS`), the form's own `root.configuration.agentTools` decides:
   * `"allowed"` registers them live, anything else registers them sealed (every call answers
   * `agent-off`, `describe_form` says the form is the person's to fill); `"never"`, the page
   * forbids them: nothing registers and the chunk is not loaded for this element. Without the
   * `agent` token it does nothing. A change never rebuilds the runtime: between `always` and
   * `definition` the registration re-reads its access, and to or from `never` the tools are
   * withdrawn or registered as an `agent`-only `features` change does. Reads back what was set
   * (`undefined` when absent). Also the `agent-access` attribute.
   */
  public get agentAccess(): AgentAccess | undefined {
    return this.agentAccessValue;
  }

  public set agentAccess(value: AgentAccess | undefined) {
    if (value !== undefined && value !== null && !(AGENT_ACCESS_VALUES as readonly unknown[]).includes(value)) {
      throw new TypeError(agentAccessError(value));
    }
    const before = this.agentAccessPolicy;
    this.agentAccessValue = value ?? undefined;
    const after = this.agentAccessPolicy;
    if (before === after) {
      return;
    }
    if (before === "never" || after === "never") {
      this.syncAgent(true);
      return;
    }
    // Between always and definition: the same registration re-reads its access,
    // never a rebuild. The attachment does not see this call, so the live mark is set here (3.10).
    const live = this.agentLive;
    if (live !== undefined) {
      live.registration.accessChanged();
      this.agentMarks.live ||= live.registration.access().state === "live";
    }
  }

  /** @internal The policy that applies: what was set, else `DEFAULT_AGENT_ACCESS`. Read by `agent-host.ts`. */
  public get agentAccessPolicy(): AgentAccess {
    return this.agentAccessValue ?? DEFAULT_AGENT_ACCESS;
  }

  /** Whether the `features` list (when there is one) has `feature`. */
  private allows(feature: FormFeature): boolean {
    return this.featuresValue === undefined || this.featuresValue.has(feature);
  }

  /**
   * Something the page or the definition asked of a feature the list leaves out: ignored, with one
   * console warning per feature (never a throw, never a `datum-error`: the page wrote the list).
   */
  private ignoreLeftOut(feature: FormFeature, asked: string): void {
    if (this.warnedFeatures.has(feature)) {
      return;
    }
    this.warnedFeatures.add(feature);
    console.warn(`[${this.tagName.toLowerCase()}] Ignoring ${asked}: the features list does not include "${feature}".`);
  }

  /** The error a method of a left-out feature fails with. */
  private leftOut(feature: FormFeature, what: string): Error {
    return new Error(`${what} is not available: the features list of this <${this.tagName.toLowerCase()}> does not include "${feature}"`);
  }

  /**
   * Where the PDF module is: `"auto"` for `datum-pdf.js` beside this bundle, else a URL. It is
   * loaded on the first PDF, not on assignment. `undefined` (the attribute absent) means no
   * PDFs unless `pdfSupport` is assigned.
   */
  public get pdf(): string | undefined {
    return this.pdfSpec;
  }

  public set pdf(value: string | undefined) {
    this.pdfSpec = value;
    this.pdfLoad = undefined;
  }

  /** The PDF provider and fonts in use, for a page that loaded the module itself. */
  public get pdfSupport(): DatumPdfSupport | undefined {
    return this.pdfSupportValue;
  }

  public set pdfSupport(value: DatumPdfSupport | undefined) {
    this.pdfSupportValue = value;
    this.request("pdf");
  }

  /**
   * The `"pdf"`-target theme PDFs render under: `"default"`, a registered id (`"acme"`), or a theme object. A
   * layout that names its own theme keeps it; this is the default for the rest.
   */
  public get pdfTheme(): PdfThemeInput {
    return this.pdfThemeValue;
  }

  public set pdfTheme(value: PdfThemeInput) {
    this.pdfThemeValue = value;
    this.request("pdf");
  }

  /**
   * The host's template resolver: how a populated-form layout's PDF is found from
   * the source it names — an asset store, a URL. Absent: only inline (`base64`) templates fill.
   */
  public get pdfTemplates(): PdfTemplateResolver | undefined {
    return this.pdfTemplatesValue;
  }

  public set pdfTemplates(value: PdfTemplateResolver | undefined) {
    this.pdfTemplatesValue = value;
    this.request("pdf");
  }

  /**
   * What a PDF does with a component whose type it has no rendition for: `"ignore"`
   * draws it generically and says nothing, `"warn"` (the default) does the same and reports
   * `component.unknown` in the result's warnings, `"fail"` rejects the PDF. Also the
   * `pdf-unknown-components` attribute.
   */
  public get pdfUnknownComponents(): PdfUnknownComponentPolicy | undefined {
    return this.pdfUnknownComponentsValue;
  }

  public set pdfUnknownComponents(value: PdfUnknownComponentPolicy | undefined) {
    this.pdfUnknownComponentsValue = value;
    this.request("pdf");
  }

  /**
   * What the form does with a formula problem: `"fail"` (the default) refuses the
   * definition, a submission with the problem named, and a PDF with the `formula_invalid` code;
   * `"warn"`, the explicit opt-in for preview and staging, drops the rule and says so. Over the form's own
   * `configuration.formulaErrors`; the runtime compiles with it, so a change rebuilds the
   * runtime. Also the `formula-errors` attribute.
   */
  public get formulaErrors(): FormulaErrorPolicy | undefined {
    return this.formulaErrorsValue;
  }

  public set formulaErrors(value: FormulaErrorPolicy | undefined) {
    this.formulaErrorsValue = value;
    this.request("runtime");
  }

  /**
   * What the form does with a regular expression of a catastrophic shape (a repeat of a repeat
   * such as `(x+)+`, a repeated back-reference): `"refuse"` (the default) reads a literal
   * `matches` pattern as a formula problem (`pattern.risky`, judged by `formula-errors`) and does
   * not run a field's `pattern` of that shape; `"allow"` runs them. The runtime and its sandbox
   * judge by the same word, so a change rebuilds the runtime. Also the `risky-patterns` attribute.
   */
  public get riskyPatterns(): "refuse" | "allow" | undefined {
    return this.riskyPatternsValue;
  }

  public set riskyPatterns(value: "refuse" | "allow" | undefined) {
    this.riskyPatternsValue = value;
    this.request("runtime");
  }

  /**
   * Who signs the PDFs: a `PdfSigner` — the page's own key through
   * `createWebCryptoPdfSigner`, or the person's hardware token through a local agent with
   * `createAgentPdfSigner`. Set, every `renderPdf` / `downloadPdf` that names no `signature`
   * of its own is signed, the toolbar's PDF button and a button's `pdf` action included; a
   * provider that cannot complete a signature rejects rather than delivering unsigned.
   * A property only — a key never belongs in markup.
   */
  public get pdfSigner(): PdfSigner | undefined {
    return this.pdfSignerValue;
  }

  public set pdfSigner(value: PdfSigner | undefined) {
    this.pdfSignerValue = value;
    this.request("pdf");
  }

  /** The settings (certification, reason, location…) and timestamper that go with `pdfSigner`. */
  public get pdfSignature(): PdfSignatureOptions | undefined {
    return this.pdfSignatureValue;
  }

  public set pdfSignature(value: PdfSignatureOptions | undefined) {
    this.pdfSignatureValue = value;
    this.request("pdf");
  }

  /**
   * Where the sandbox module is: `"auto"` for `datum-wasm.js` beside this bundle,
   * else a URL. It is fetched once the form is ready and wired with `wasmPlugins`; plugin
   * validators then run at submit inside it, and a submit before it has arrived waits for it.
   * `undefined` (the attribute absent) means no sandbox unless `wasmValidationHost` is
   * assigned: field constraints alone validate, in-process.
   */
  public get wasm(): string | undefined {
    return this.wasmSpec;
  }

  public set wasm(value: string | undefined) {
    const hadSandbox = this.hasSandbox();
    this.wasmSpec = value;
    this.dropLoadedWasm();
    this.settleSandbox(hadSandbox);
  }

  /**
   * The sandbox in use: the one the page assigned, else the one loaded from `wasm`, once it
   * has arrived. A page that imports `datum-wasm.js` itself assigns what its
   * `createWasmValidationHost` returns — the promise will do, and a submit before it settles
   * waits for it. Such a host carries its own plugins; `wasmPlugins` is for the module the
   * element loads.
   */
  public get wasmValidationHost(): WasmValidationHost | undefined {
    return this.wasmHostReady ?? this.wasmLoad?.ready;
  }

  public set wasmValidationHost(value: DatumFormWasmHost | undefined) {
    const hadSandbox = this.hasSandbox();
    this.wasmHostValue = value;
    this.wasmHostReady = undefined;
    if (value !== undefined) {
      Promise.resolve(value).then(
        (host) => {
          if (this.wasmHostValue === value) {
            this.wasmHostReady = host;
            emit<DatumFormWasmReadyDetail>(this, "datum-wasm-ready", { host });
          }
        },
        (error: unknown) => {
          if (this.wasmHostValue === value) {
            reportError(this, "sandbox.build-failed", "The validation sandbox the page assigned could not be built", error);
          }
        }
      );
    }
    this.settleSandbox(hadSandbox);
  }

  /**
   * The page's validator modules, wired into the sandbox loaded from `wasm`: each
   * `{ id, version, source }`, the source an ES2020 program whose value is
   * `{ validators: [(context) => ({ errors })] }` — closure-free and deterministic, as the
   * sandbox has no `Date`, no `Math.random` and no I/O. A new list takes effect on the next
   * submit, which waits for a sandbox wired with it. The modules the registered plugins
   * carry (`FormPlugin.wasmPlugin`) are wired in before these.
   */
  public get wasmPlugins(): WasmPluginModule[] {
    return this.wasmPluginsValue;
  }

  public set wasmPlugins(value: WasmPluginModule[]) {
    this.wasmPluginsValue = value;
    this.dropLoadedWasm();
    this.prefetchWasm();
  }

  /**
   * What the rules may read beside the values: a snapshot, or a function resolving
   * one for each submit from the form's id, values and locale. The sandbox never fetches, so
   * this is where the page gathers what its rules need. Read at submit; assigning it rebuilds
   * nothing.
   */
  public get wasmExternalData(): DatumFormWasmExternalData | undefined {
    return this.wasmExternalDataValue;
  }

  public set wasmExternalData(value: DatumFormWasmExternalData | undefined) {
    this.wasmExternalDataValue = value;
  }

  /**
   * What the sandbox's run log keeps: `"off"`, `"error"`, `"warn"` (the kernel's
   * default), `"info"` or `"debug"`. Read at each submit, so assigning it rebuilds nothing;
   * the log arrives on `datum-wasm-validated`.
   */
  public get wasmLogLevel(): WasmLogLevel | undefined {
    return this.wasmLogLevelValue;
  }

  public set wasmLogLevel(value: WasmLogLevel | undefined) {
    this.wasmLogLevelValue = value;
  }

  /**
   * The signing provider a submission uses when nothing names one: the embed's
   * submission mode does not force signing, so this matters together with `signingProviders`
   * and a button's `signature` option, or for a page that calls `submit({ signWith })`.
   * A property only — a signer never belongs in markup.
   */
  public get signingProvider(): SigningProvider | undefined {
    return this.signingProviderValue;
  }

  public set signingProvider(value: SigningProvider | undefined) {
    this.signingProviderValue = value;
    this.request("runtime");
  }

  /**
   * The signing providers a submission may name by id: a `button` component with
   * `signature: "webauthn"` signs through the one whose id is `"webauthn"`
   * (`createWebAuthnSigningProvider`); `submit({ signWith })` does the same from script.
   */
  public get signingProviders(): readonly SigningProvider[] | undefined {
    return this.signingProvidersValue;
  }

  public set signingProviders(value: readonly SigningProvider[] | undefined) {
    this.signingProvidersValue = value;
    this.request("runtime");
  }

  /**
   * How submissions are signed: `scope` — what the signed bytes cover (`envelope`,
   * `submission` or `values`) — and `placement` — the signatures inside the envelope
   * (`embedded`) or the envelope inside a signed document (`wrapper`, delivered as
   * `datum-submit`'s `signed`). Also the `signing-scope` / `signing-placement` attributes.
   * `statement` is the words the signer agrees to: signed with the document as
   * `{ document, statement }` and recorded on each signature; a property only.
   */
  public get signing(): SubmissionSigningOptions | undefined {
    return this.signingValue;
  }

  public set signing(value: SubmissionSigningOptions | undefined) {
    this.signingValue = value;
    this.request("runtime");
  }

  /**
   * Signature required: the id of the provider every submit signs
   * with — a submit button, Enter, a journey's last page, `submit()` and `submitAndDownload()`
   * alike. A button's own `signature` option or `submit({ signWith })` still names another. No
   * provider of that id refuses the submit as `signing.providerMissing`, and a provider that
   * cannot sign fails it as `signing.failed`: never delivered unsigned. Also the `sign-with`
   * attribute; `null` (or `""`) requires nothing.
   */
  public get signWith(): string | null {
    return this.signWithValue;
  }

  public set signWith(value: string | null | undefined) {
    this.signWithValue = value === undefined || value === null || value === "" ? null : value;
  }

  /**
   * When a typed value is reported as `datum-change`: `"input"` (the default) once
   * typing pauses for `changeDebounce` ms or the field is left, `"commit"` only when the field
   * is left. Read per write, so assigning it rebuilds nothing.
   */
  public get changeOn(): DatumFormChangeOn {
    return this.changeOnValue;
  }

  public set changeOn(value: DatumFormChangeOn) {
    this.changeOnValue = value;
  }

  /**
   * How long typing must pause, in milliseconds, before the value is reported under
   * `changeOn = "input"` (300 by default). `0` reports every write, as each keystroke lands.
   */
  public get changeDebounce(): number {
    return this.changeDebounceValue;
  }

  public set changeDebounce(value: number) {
    this.changeDebounceValue = value;
  }

  /**
   * The longest definition read from `src`, in UTF-8 bytes (2 MiB unless set): a response past it
   * is refused before it is parsed, as `max-definition-bytes`. `undefined` puts the 2 MiB back.
   */
  public get maxDefinitionBytes(): number {
    return this.maxDefinitionBytesValue;
  }

  public set maxDefinitionBytes(value: number | undefined) {
    if (value !== undefined && !isDefinitionByteLimit(value)) {
      reportError(this, "max-definition-bytes.invalid", `maxDefinitionBytes must be a whole number of bytes above 0, not ${String(value)}`);
      return;
    }
    this.maxDefinitionBytesValue = value ?? MAX_DEFINITION_BYTES;
  }

  /**
   * The form definition rendered. Assigning starts the form afresh, the same object assigned
   * again included: the answers typed so far are dropped (`values` seeds the new form). Every
   * other setting that rebuilds the runtime keeps them.
   * One source at a time: while a `src` fetch is on its way, an assigned definition is refused
   * (a `datum-error`, nothing replaced), and the fetched form loads when it lands; clear `src`
   * first to put a definition in its place.
   */
  public get definition(): FormDefinition | undefined {
    return this.definitionValue;
  }

  public set definition(value: FormDefinition | undefined) {
    // Which of two sources wins cannot depend on which response is slower: the page says which
    // one it means by clearing the other.
    if (value !== undefined && this.srcLoading) {
      reportError(this, "definition.source-conflict", `The form was not loaded: the form from src (${this.srcValue ?? ""}) is still loading; set src to nothing first to assign a definition in its place.`);
      return;
    }
    if (this.takeDefinition(value)) {
      this.definitionAssigned = value !== undefined;
    }
  }

  /** Puts `value` in place for whichever route brought it; `false` when its shape is refused. */
  private takeDefinition(value: FormDefinition | undefined): boolean {
    // A tree no walk can read (a root that is no form, a slot holding no component, a limit
    // passed) is reported and refused here, before it reaches the runtime: the form it had stays
    // drawn, rather than a half-built runtime throwing out of a paint.
    const problem = value === undefined ? undefined : definitionShapeProblem(value);
    if (problem !== undefined) {
      reportError(this, "definition.invalid", `The form was not loaded: ${problem}`);
      this.showDefinitionUnavailable();
      return false;
    }
    // A definition is in place: the card of an earlier failure has done its work.
    this.clearDefinitionFailure();
    this.definitionValue = value;
    this.freshDefinition = true;
    // A form with journeys starts loading the journeys runtime in the build this
    // schedules, not here: a `features` that leaves journeys out may still be assigned (or parsed
    // from a later attribute) in the same task, and a left-out feature's file is never requested.
    this.request("runtime");
    return true;
  }

  /**
   * A URL to load the definition from (JSON), resolved against the page. Refused (a
   * `datum-error`, nothing fetched) while a definition the page assigned is in place: clear
   * `definition` first. A later `src` replaces a form an earlier one brought.
   */
  public get src(): string | undefined {
    return this.srcValue;
  }

  public set src(value: string | undefined) {
    if (value !== undefined && this.definitionAssigned) {
      reportError(this, "definition.source-conflict", `The form was not loaded from src (${value}): a definition is assigned to this form; set definition to nothing first to load one from src.`);
      return;
    }
    this.srcValue = value;
    if (value === undefined) {
      this.srcToken += 1;
      this.srcLoading = false;
      this.clearDefinitionFailure();
      return;
    }
    this.loadSrc(value);
  }

  /**
   * The design-system binding the form is drawn by: a `LiveBinding`, the id of one registered on
   * the page (`bindings.register`), or nothing for Datum's own. An id nobody registered is
   * reported as `datum-binding-error` and the form is drawn by Datum's binding meanwhile.
   */
  public get binding(): LiveBinding | string | undefined {
    return this.bindingValue;
  }

  public set binding(value: LiveBinding | string | undefined) {
    this.bindingValue = value;
    this.request("renderer");
  }

  /** The design system's files as the host serves them (stylesheets, fonts, scripts), for a binding that needs them. */
  public get assets(): LiveAssets | undefined {
    return this.assetsValue;
  }

  public set assets(value: LiveAssets | undefined) {
    this.assetsValue = value;
    this.request("renderer");
  }

  /** The host page's colour scheme: `"dark"` draws the binding's dark look where it has one. */
  public get colorScheme(): "light" | "dark" | undefined {
    return this.colorSchemeValue;
  }

  public set colorScheme(value: "light" | "dark" | undefined) {
    this.colorSchemeValue = value;
    this.request("renderer");
  }

  public get mode(): DatumFormMode {
    return this.modeValue;
  }

  public set mode(value: DatumFormMode) {
    if (value !== "interactive" && value !== "readonly") {
      // The attribute refuses the same values; the form keeps the mode it has.
      reportError(this, "mode.invalid", `mode must be "interactive" or "readonly", not "${String(value)}"`);
      return;
    }
    this.modeValue = value;
    this.request("renderer");
  }

  /**
   * The locale to render in. Negotiated against the form's `localization.supportedLocales`
   * (case-insensitive, then region fall-back, then the default); "auto" negotiates the
   * visitor's `navigator.languages`.
   */
  public get locale(): string | undefined {
    return this.localeValue;
  }

  public set locale(value: string | undefined) {
    this.localeValue = value;
    this.request("locale");
  }

  /**
   * The locale the form is showing now: what `locale` negotiated to (never "auto" or a
   * request nothing matched), or what the switcher picked. Read-only; undefined before the
   * form has a runtime.
   */
  public get activeLocale(): string | undefined {
    return this.runtimeValue?.state().locale;
  }

  /**
   * Draws a language switcher at the top of the form over the form's supported locales, each
   * under the label the form authored for it (`localization.supportedLocales[].label`).
   */
  public get languageSwitcher(): boolean {
    return this.languageSwitcherValue;
  }

  public set languageSwitcher(value: boolean) {
    this.languageSwitcherValue = value;
    this.request("renderer");
  }

  /**
   * The page's chrome around the form's fields: a language switcher, a
   * logo, the form's title, instructions — each a typed part in the `header` or `footer`
   * list, added after whatever the form's author composed in the builder (`formChrome:
   * "exclude"` replaces that instead). As the `chrome` attribute, the same object as JSON.
   * `language-switcher`, `frame` and `frame-fixed` still apply as short forms and are merged
   * in; where one of them and this object give the same setting (a frame, a language-switcher
   * part), this object's wins.
   */
  public get chrome(): FormChromeConfiguration | undefined {
    return this.chromeValue;
  }

  public set chrome(value: FormChromeConfiguration | undefined) {
    this.chromeValue = value;
    this.request("renderer");
  }

  /**
   * The frame around the form, the short form of `chrome.frame`: a preset id the
   * engine (`seamless`, `outlined`, `paper`) or the binding's `frames` draws. As the `frame`
   * attribute. It is the page's *default* — the author's own pick in the definition wins —
   * unless {@link frameFixed} is set. A `chrome.frame` wins over both.
   */
  public get frame(): string | undefined {
    return this.frameValue;
  }

  public set frame(value: string | undefined) {
    this.frameValue = value;
    this.request("renderer");
  }

  /** Makes {@link frame} win over the author's pick on this page; the `frame-fixed` attribute. */
  public get frameFixed(): boolean {
    return this.frameFixedValue;
  }

  public set frameFixed(value: boolean) {
    this.frameFixedValue = value;
    this.request("renderer");
  }

  /**
   * The heading level of the form's title in this page's outline (1–6; 1 unless set): the
   * `heading-level` attribute. The headings the form draws itself — the error summary's, a
   * notice's, a group's label, a panel's title — sit one level under it, so a page that puts
   * the form under its own `h1` sets 2 and gets an `h2` title over `h3` sections.
   */
  public get headingLevel(): number | undefined {
    return this.headingLevelValue;
  }

  public set headingLevel(value: number | undefined) {
    this.headingLevelValue = value;
    this.request("renderer");
  }

  /**
   * The page's display text per validation code, per locale. It wins over the form's own
   * `messages` (authored on its root and fields) for every code it names, as the
   * page's `translations` win over the form's; the form's words stand for the codes it leaves out.
   */
  public get messages(): ValidationMessageCatalog | undefined {
    return this.messagesValue;
  }

  public set messages(value: ValidationMessageCatalog | undefined) {
    this.messagesValue = value;
    this.request("renderer");
  }

  /**
   * The page's wording for the form's own text, per locale (`FormTextCatalog`):
   * `submitting`, the line shown while a submit and its delivery are in flight. JSON in the
   * attribute; each entry a `LocalizedText`, so a `key` resolves through `translations`.
   * Unset, the engine's English.
   */
  public get texts(): FormTextCatalog | undefined {
    return this.textsValue;
  }

  public set texts(value: FormTextCatalog | undefined) {
    this.textsValue = value;
    this.request("renderer");
  }

  /**
   * The ends of the form the submitting line goes at, the way a notice's
   * `placement` lists them: `["top"]` (the default, where the error summary goes),
   * `["bottom"]` (after the fields, beside the button the person pressed), or both, with the
   * bottom copy a visual echo so the line is announced once. In the `submitting-placement`
   * attribute, the ends separated by spaces: `"top bottom"`.
   */
  public get submittingPlacement(): FormNoticePlacement[] | undefined {
    return this.submittingPlacementValue;
  }

  public set submittingPlacement(value: FormNoticePlacement[] | undefined) {
    this.submittingPlacementValue = value;
    this.request("renderer");
  }

  /**
   * The ends of the form the error summary goes at after an invalid submit: `["top"]` (the
   * default, before the fields), `["bottom"]` (after them), both, or `[]` for none — a page
   * that draws its own summary, or a design that shows the inline messages alone. In the
   * `error-summary` attribute, the ends separated by spaces (`"top bottom"`), or `"none"`.
   */
  public get errorSummaryPlacement(): FormNoticePlacement[] | undefined {
    return this.errorSummaryPlacementValue;
  }

  public set errorSummaryPlacement(value: FormNoticePlacement[] | undefined) {
    this.errorSummaryPlacementValue = value;
    this.request("renderer");
  }

  /**
   * Whether an accepted submit shows the form's own confirmation (the `confirmation` attribute,
   * a boolean one): a success message, with the reference the delivery's reply
   * carries when it has one, drawn as a notice and focused. Off by default, and then the page
   * owns what follows a submit as ever. On, it never replaces a receipt the page set itself
   * (`setNotice`) while delivering. Worded by `texts` keys `confirmationTitle`,
   * `confirmationMessage` and `confirmationReference` (the engine words English only; other languages are the form's `texts` translations). Read when a
   * submit is accepted, so setting it at any time takes effect (it is observed only so the
   * attribute reference lists it: a change does not rebuild anything).
   */
  public get confirmation(): boolean {
    return this.hasAttribute("confirmation");
  }

  public set confirmation(value: boolean) {
    this.toggleAttribute("confirmation", value === true);
  }

  /** The receipt shown since the last {@link setNotice}, if any. */
  public get notice(): FormNotice | undefined {
    return this.noticeValue;
  }

  /**
   * Whether a submit is in flight: from `submit()` until the runtime has answered
   * and every `waitUntil` promise has settled. Reflected as the `submitting` attribute, so a
   * page can style `datum-form[submitting]` or observe it.
   */
  public get submitting(): boolean {
    return this.inFlight !== undefined;
  }

  /**
   * Data sources the form's selects, radios and checkboxes name in `data.sourceId`: a plain
   * object of static lists (also as a JSON attribute), loader functions, or providers — what
   * `defineDataSources` takes — or a set already built with it.
   */
  public get dataSources(): DataSourceSet | undefined {
    return this.dataSourcesValue;
  }

  public set dataSources(value: DatumFormDataSources | undefined) {
    this.dataSourcesValue = value === undefined || value === null ? undefined : isDataSourceSet(value) ? value : defineDataSources(value);
    this.request("runtime");
  }

  /** Translations for the form's `LocalizedText.key` entries. */
  public get translations(): TranslationCatalog | undefined {
    return this.translationsValue;
  }

  public set translations(value: TranslationCatalog | undefined) {
    this.translationsValue = value;
    // A catalog is read when the runtime is built, so a new one rebuilds it, the answers typed
    // so far going across (see buildRuntime).
    this.request("runtime");
  }

  /**
   * Initial values, keyed by value path (a component id, or `container.field` inside a
   * data-scoping container). Applied to the current runtime, and again to any rebuilt one.
   * Read, the form's current answers — never what a presentation's own fields hold, which
   * stay in the browser (`presentationValues()` has them).
   */
  public get values(): Record<string, unknown> {
    return this.runtimeValue?.formValues() ?? this.valuesValue ?? {};
  }

  public set values(value: Record<string, unknown> | undefined) {
    this.valuesValue = value;
    this.valuesAssigned = true;
    this.request("values");
  }

  /**
   * What the form's `host.` paths read (`visibleWhen: host.role = "admin"`): facts the page knows
   * about the visit, such as the signed-in person's role or the site's region. Plain JSON data
   * (also as the `host-context` JSON attribute); a value JSON cannot carry (a function, `NaN`, a
   * `Date`) is left out and reported as `datum-error` `host-context.invalid`, and so is a value
   * that is no object at all, which then clears it. Read, the copy the form holds. Changing it
   * works the form out again in place: what is shown, required and calculated follows, and the
   * answers typed so far stay. The values are for display: they travel in no submission, and a
   * server judges `host.` rules with values of its own.
   */
  public get hostContext(): Record<string, unknown> | undefined {
    return this.hostContextValue;
  }

  public set hostContext(value: Record<string, unknown> | undefined) {
    const { context, problems } = plainHostContext(value);
    if (problems.length > 0) {
      reportError(this, "host-context.invalid", `hostContext was not taken whole: ${problems.join("; ")}`);
    }
    this.hostContextValue = context;
    this.request("host-context");
  }

  /**
   * A draft key. Set, every change autosaves the form to browser storage under it, and
   * `restoreDraft()` / `clearDraft()` act on that draft.
   */
  public get draft(): string | undefined {
    return this.draftKeyValue;
  }

  public set draft(value: string | undefined) {
    this.draftKeyValue = value;
    this.request("runtime");
  }

  /**
   * Where the `draft` key's draft is kept, when not in the browser's own storage: the page's
   * `DraftStore` (one that saves to a server, say). Autosave, `hasDraft()`, `restoreDraft()`
   * and `clearDraft()` then go through it. Unset, drafts stay in browser storage. It does
   * nothing without a `draft` key.
   */
  public get draftStore(): DraftStore | undefined {
    return this.draftStoreValue;
  }

  public set draftStore(value: DraftStore | undefined) {
    this.draftStoreValue = value;
    this.request("runtime");
  }

  /** Component types beyond the standard catalogue (each one's `ComponentDefinition.adapter` draws it). */
  public get componentDefinitions(): ComponentDefinition[] {
    return this.componentDefinitionsValue;
  }

  public set componentDefinitions(value: ComponentDefinition[]) {
    this.componentDefinitionsValue = value;
    this.request("runtime");
  }

  /**
   * Plugins for this form alone, beside those the page registered with
   * `plugins.register`: `FormPlugin` objects whose components join the catalogue (a type
   * matching a standard one replaces it), whose validators run after the field constraints,
   * whose hooks, submission handlers and PDF renditions the runtime takes up, whose sandbox
   * modules the sandbox is wired with, and whose data sources resolve behind `dataSources`.
   * A property only — a plugin is code, never markup. Assigning rebuilds the runtime; the
   * answers typed so far carry over.
   */
  public get plugins(): FormPlugin[] {
    return this.pluginsValue;
  }

  public set plugins(value: FormPlugin[]) {
    this.pluginsValue = value;
    this.request("runtime");
  }

  /**
   * Which journey the form opens as: a journey's id, `"form"` for the whole form on
   * one page, or `"journey"` for the definition's default journey even when the definition
   * opens as a form. Unset, the definition decides (`journey.opensAs`, then its default
   * journey). An id the form does not have is warned about and the definition decides.
   * Changing it restarts the journey — or leaves it for the whole form — over the answers
   * already typed; nothing is rebuilt. The `journey` attribute.
   */
  public get journey(): JourneyHostChoice {
    return this.journeyValue;
  }

  public set journey(value: JourneyHostChoice) {
    const next = value === "" ? undefined : value;
    if (next !== this.journeyValue) {
      this.warnedJourneyId = undefined;
    }
    this.journeyValue = next;
    this.request("journey");
  }

  /**
   * The page the journey shows. Set (the `page` attribute), the journey opens on that page —
   * a deep link, a resume point — or, once running, goes to it as a jump; either only when
   * the person may reach it (on the path, at or before the first page not yet completed),
   * else the journey stays where it is. At the start only the first page is reachable, so a
   * later page waits: restoring a draft whose completed pages reach it opens there, and the
   * person's first move forgets it. Read, the page shown now; the value set when no
   * journey runs.
   */
  public get page(): string | undefined {
    return this.runtimeValue?.journeyView()?.pageId ?? this.pageValue;
  }

  public set page(value: string | undefined) {
    this.pageValue = value === "" ? undefined : value;
    this.request("page");
  }

  /**
   * The page's way to its service for the checks a journey asks for: a page's on
   * Continue (`validation.server`), the whole journey's before submit (`validation.end:
   * "server"`). Handed each check — the journey, the scope, the submittable values, the
   * locale — and, beside it, a signal to abandon it by and the submission envelope over those
   * values (`document`, built as Submit builds its own) — it resolves with the service's
   * errors (`{ errors }`, as `setErrors` takes them) or rejects when the service cannot be reached; the journey's
   * `onUnavailable` decides what the person sees then. Wins over `validate-url`. Taken up at
   * once, without a rebuild. A property only — a function never belongs in markup.
   */
  public get serverValidator(): JourneyServerValidator | undefined {
    return this.serverValidatorValue;
  }

  public set serverValidator(value: JourneyServerValidator | undefined) {
    this.serverValidatorValue = value;
    this.request("validator");
  }

  /**
   * Where the element posts a journey's checks when no `serverValidator` is set (the
   * `validate-url` attribute): each check as `{ document, scope, pageId? }`, the delivery a Datum
   * host's `POST /api/submissions/validate` takes, the reply's `errors` read back — see
   * `createFetchJourneyValidator`, which a page with headers or credentials to send uses itself.
   */
  public get validateUrl(): string | undefined {
    return this.validateUrlValue;
  }

  public set validateUrl(value: string | undefined) {
    this.validateUrlValue = value === "" ? undefined : value;
    this.request("validator");
  }

  /**
   * How long a journey's check may take before it counts as the service being unavailable, in
   * milliseconds; `0` for no limit, unset for the runtime's 10 seconds. The `validate-timeout`
   * attribute. Read when the form is built: changing it rebuilds the runtime, and the answers
   * typed so far carry over.
   */
  public get validateTimeout(): number | undefined {
    return this.validateTimeoutValue;
  }

  public set validateTimeout(value: number | undefined) {
    this.validateTimeoutValue = value;
    this.request("runtime");
  }

  /**
   * Whether the first paint waits for the data sources: `"none"` (the default) draws the form
   * at once, a choice field whose source has not answered shown as loading and repainted when
   * it does; `"all"` shows only "Loading form…" until every source has answered or timed out.
   * The `data-source-wait` attribute.
   */
  public get dataSourceWait(): "none" | "all" {
    return this.dataSourceWaitValue;
  }

  public set dataSourceWait(value: "none" | "all" | undefined) {
    this.dataSourceWaitValue = value === "all" ? "all" : "none";
    this.request("renderer");
  }

  /**
   * How long a data source may take before it counts as failed (drawn under its field and
   * reported as `datum-error`), in milliseconds; `0` for no limit, unset for 15000. The
   * `data-source-timeout` attribute. The runtime reads it when the form is built, so changing
   * it rebuilds the runtime, and the answers typed so far carry over.
   */
  public get dataSourceTimeout(): number | undefined {
    return this.dataSourceTimeoutValue;
  }

  public set dataSourceTimeout(value: number | undefined) {
    this.dataSourceTimeoutValue = value;
    this.request("runtime");
  }

  /**
   * How long the sandbox module may take to load before the load fails (a submit meanwhile, and
   * after, reports the validator unavailable; the next submit tries again), in milliseconds;
   * `0` for no limit, unset for 15000. The `wasm-timeout` attribute.
   */
  public get wasmTimeout(): number | undefined {
    return this.wasmTimeoutValue;
  }

  public set wasmTimeout(value: number | undefined) {
    // A number of milliseconds (`0` for no limit), else the default, as a bad attribute leaves
    // it: NaN or a negative number would otherwise reach the loader as no limit at all.
    this.wasmTimeoutValue = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  // --- reads and actions ------------------------------------------------

  /** The runtime behind the form, for a page that wants the engine's full surface. */
  public get runtime(): FormRuntime | undefined {
    return this.runtimeValue;
  }

  /**
   * @internal What the agent tools' host reads for `form-not-ready`: `runtime`
   * is the previous runtime mid-rebuild and the build's own fields are private, so the state is
   * said here. `"loading"` while a runtime build is requested or in flight, or before the first
   * one is bound; `"failed"` while the journeys runtime did not arrive (its card is up); else
   * `"ready"`. Read by `agent-host.ts` alone; not part of the attribute reference.
   */
  public get agentBuildState(): "loading" | "failed" | "ready" {
    if (this.pending.has("runtime") || this.buildGate !== undefined) {
      return "loading";
    }
    if (this.journeysFailure !== undefined) {
      return "failed";
    }
    return this.runtimeValue === undefined ? "loading" : "ready";
  }

  /**
   * @internal Whether the page signs every PDF this form makes:
   * the renderer is handed the `pdfSigner` only when signing is allowed, so `download_pdf` refuses
   * before anything renders and the signer is never called. Read by `agent-host.ts` alone.
   */
  public get agentPdfSigns(): boolean {
    return this.pdfSignerValue !== undefined && this.allowsSigning("pdfSigner and pdfSignature");
  }

  /**
   * @internal Whether drafts go to a server because the `draft-store` attribute, as applied,
   * names one: an attribute on another origin that `allow-origins` does not list is as good as
   * absent, so its drafts stay in the browser. Read by `agent-host.ts` alone.
   */
  public get agentDraftsOnServer(): boolean {
    return this.draftStoreSpec?.kind === "server";
  }

  // --- the agent tools ----------------------------------------

  /**
   * The tools a browser agent (WebMCP) and page script can call over this form: the
   * page registrar's routing wrappers, the renderer's ten plus the session pair (twelve), as the
   * browser is given them. Rejects when the `features` list leaves `agent` out (it is opt-in:
   * `features="all agent"`) or `agent-access` is `"never"`, and with the loader's
   * `ChunkLoadError`, after `datum-error`, when the agent chunk could not be loaded; the next call
   * asks for the chunk again. A sealed form resolves: its tools but `describe_form` answer `agent-off`.
   */
  public async agentTools(): Promise<readonly AgentTool[]> {
    const attachment = await this.requireAgent("agentTools()");
    return attachment.tools();
  }

  /**
   * Runs one agent tool by name with the same pipeline the browser uses and resolves
   * to its envelope: `{ ok: true, ... }` or the refusal `{ ok: false, code, message, hint, ... }`.
   * Never rejects for a tool's refusal; rejects only as `agentTools()` does.
   */
  public async executeAgentTool(name: string, input: unknown = {}): Promise<AgentToolResult> {
    const attachment = await this.requireAgent("executeAgentTool()");
    return attachment.execute(name, input);
  }

  /** The chunk's attachment for a call: the token must be on and the element on the page. */
  private requireAgent(what: string): Promise<FormAgentAttachment> {
    if (this.featuresValue?.has("agent") !== true) {
      return Promise.reject(this.leftOut("agent", what));
    }
    if (this.agentAccessPolicy === "never") {
      return Promise.reject(new Error(`${what} is not available: agent-access is "never" on this <datum-form>`));
    }
    if (!this.isConnected) {
      return Promise.reject(new Error(`${what} needs this <${this.tagName.toLowerCase()}> to be on the page`));
    }
    // After a failed load the attachment was forgotten: asked for again here (absent-code resilience).
    this.syncAgent();
    return this.agentAttachment!.then((attachment) => {
      if (attachment === undefined) {
        // Withdrawn while the chunk was on its way: by the page's never, or by leaving the page.
        if (this.agentAccessPolicy === "never") {
          throw new Error(`${what} is not available: agent-access is "never" on this <datum-form>`);
        }
        throw new Error(`${what}: the <${this.tagName.toLowerCase()}> left the page while the agent tools were loading`);
      }
      return attachment;
    });
  }

  /**
   * Registers or withdraws the agent tools as the `agent` token and the connection come and go: on, a per-connection AbortController is created and the chunk loaded once, which
   * registers the form with the page registrar under that signal; off (the token gone, or the
   * element off the page), the registration is withdrawn with the reason and the signal aborted,
   * so the browser's tool list follows synchronously. A chunk that does not arrive is reported
   * once as `datum-error` and forgotten, so the next call or toggle asks again. Never called for
   * a form without the token: such a form creates no controller and loads nothing.
   */
  private syncAgent(reannounce = false): void {
    // `agent-access="never"` is the token's absence for this element alone.
    const wanted = this.isConnected && this.featuresValue?.has("agent") === true && this.agentAccessPolicy !== "never";
    if (wanted) {
      if (this.agentAbort !== undefined) {
        // A `features` change that kept the token says the page's tools again.
        if (reannounce) {
          this.agentLive?.announce();
        }
        return;
      }
      const controller = new AbortController();
      this.agentAbort = controller;
      // One handler after the attach, not beside it: a chunk that does not arrive and an attach
      // that throws (the host, registerForm, the catalogue) both end in one datum-error and a
      // forgotten attachment, so the next call asks again.
      // The chunk is asked for one microtask later, not here: an upgrade (markup parsed before the
      // script ran, or properties adopted from before it) applies every attribute in source order
      // while the element is already connected, so `features` written before `agent-access="never"`
      // would request it before the never is read. Whatever withdraws in
      // between aborts the controller, and nothing is loaded.
      const attachment = Promise.resolve()
        .then(() => (controller.signal.aborted ? undefined : loadAgent()))
        .then((module) => {
          if (module === undefined || controller.signal.aborted) {
            return undefined;
          }
          const live = module.attachFormAgent(this, controller.signal, this.agentMarks);
          this.agentLive = live;
          this.agentRuntime = this.runtimeValue;
          return live;
        })
        .catch((error: unknown) => {
          if (this.agentAbort === controller) {
            this.agentAbort = undefined;
            this.agentAttachment = undefined;
          }
          // Whatever an attach that threw half-way registered goes with its signal.
          controller.abort();
          reportError(this, isChunkLoadError(error) ? "file.unavailable" : "agent.attach-failed", error instanceof Error ? error.message : String(error), error);
          throw error;
        });
      // Reported above; whoever asked through agentTools() / executeAgentTool() gets the rejection too.
      attachment.catch(() => {});
      this.agentAttachment = attachment;
      return;
    }
    const controller = this.agentAbort;
    if (controller === undefined) {
      return;
    }
    this.agentAbort = undefined;
    this.agentAttachment = undefined;
    this.agentRuntime = undefined;
    const live = this.agentLive;
    this.agentLive = undefined;
    // The detach folds the going registration's account into `agentMarks` first.
    live?.detach(this.isConnected ? "features-changed" : "disconnected");
    controller.abort();
  }

  /**
   * The page's account of the agent-written answers for a submit or a download:
   * `undefined` while the tools were never live here (never
   * registered, or only ever sealed); the live attachment's while one is attached (it adds what
   * earlier registrations left); else what the element kept: involvement and sessions, no
   * paths, complete only when the agent never wrote.
   */
  private agentProvenance(by: "agent" | "page"): AgentProvenance | undefined {
    this.agentMarks.live ||= this.agentLive?.registration.access().state === "live";
    if (!this.agentMarks.live) {
      return undefined;
    }
    const { involved, sessions, lastWriteAt } = this.agentMarks;
    return (
      this.agentLive?.provenance(by) ?? {
        version: 1,
        involved,
        paths: [],
        tables: [],
        complete: !involved,
        submittedBy: by,
        sessions,
        sessionOpen: false,
        ...(lastWriteAt !== undefined ? { lastWriteAt } : {})
      }
    );
  }

  /**
   * A runtime landed (`datum-ready`): one that replaces the runtime the registrar knew is reported
   * as a rebuild; then, on every landing, the first included, the registration
   * re-reads its access, so a definition that arrived late
   * (`src`) or a swap that changed `agentTools` seals or opens the tools.
   */
  private agentRuntimeLanded(runtime: FormRuntime): void {
    const live = this.agentLive;
    if (live === undefined) {
      return;
    }
    if (this.agentRuntime !== undefined && this.agentRuntime !== runtime) {
      live.registration.runtimeReplaced();
    }
    this.agentRuntime = runtime;
    live.registration.accessChanged();
    // The attachment never sees that call, and before its bind settles it does not hear the
    // tools-changed it causes (a src form going live early), so the element marks it.
    this.agentMarks.live ||= live.registration.access().state === "live";
  }

  /**
   * Settles when the form next reaches a ready state for its current definition: resolves once `datum-ready` has been dispatched for the build, and at once when
   * the form is ready already. It rejects with why a build failed (the journeys runtime that did
   * not arrive, or a definition the runtime refused); a build that a newer request replaces
   * rejects nothing, as `ready` follows the form becoming ready, not one build. After a failure
   * the next build (Retry, a new definition) gives a fresh promise. With no definition it settles
   * once one is set and built. A promise that rejects unwaited is not an unhandled rejection.
   */
  public get ready(): Promise<void> {
    if (!this.readyState) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {});
      this.readyState = { promise, resolve, reject, settled: false };
    }
    return this.readyState.promise;
  }

  /** A build ended (`error` when it failed): settles what `ready` handed out, or will hand out. */
  private settleReady(error?: { error: unknown }): void {
    // A build is already requested (a listener's own assignment, or a new definition set in the
    // checkpoint where the old build failed): this outcome belongs to a build that is superseded,
    // and the one requested settles `ready`, once. Only "runtime" counts: a queued values or
    // locale update starts no build, so nothing would follow to settle it.
    if (this.pending.has("runtime")) {
      return;
    }
    // Reads the getter so a build nobody asked about yet still leaves its outcome to be asked for.
    void this.ready;
    const state = this.readyState!;
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (error) {
      state.reject(error.error);
    } else {
      state.resolve();
    }
  }

  /** The inner `<datum-form-renderer>`. */
  public get renderer(): DatumFormRendererElement | undefined {
    return this.rendererEl;
  }

  /** The current validation errors. */
  public get errors(): FormError[] {
    return this.runtimeValue?.errors() ?? [];
  }

  /**
   * Runs validation, moves focus to the first error, and reports the errors as
   * `datum-validated`. `{ focus: false }` shows the errors without moving focus or scrolling.
   */
  public async validate(options: { focus?: boolean } = {}): Promise<FormError[]> {
    const later = this.afterBuild(() => this.validate(options));
    if (later) {
      return later;
    }
    const runtime = this.requireRuntime();
    if (this.rendererEl) {
      await this.rendererEl.validate(options);
    } else {
      await runtime.validate();
    }
    const errors = runtime.errors();
    emit<DatumFormValidatedDetail>(this, "datum-validated", { errors });
    return errors;
  }

  /**
   * Shows errors the page learned after the form was submitted: the server's verdict on the
   * delivered envelope, or that it could not be delivered at all. An entry with a
   * `componentId` shows on that field and in the summary; one without is a form-level entry
   * the summary lists on its own. Focus moves to the first error, as it does after
   * `validate()`. The next `validate()` or `submit()` replaces them; `setErrors([])` clears
   * them. Returns what was stored, which `errors` reflects too.
   */
  public setErrors(errors: HostError[]): FormError[] {
    // Synchronous, so it cannot wait for a journey form's runtime: it throws while one loads.
    const stored = this.requireBuiltRuntime().setErrors(errors);
    this.rendererEl?.focusFirstError();
    return stored;
  }

  /**
   * Shows what the page learned after a delivered submission was accepted: the server's
   * receipt — a confirmation number, a word of thanks. Drawn where the error
   * summary goes, after the fields beside the button, or both — the ends `placement` lists,
   * `["top"]` by default — worded for the form's locale (every text a `LocalizedText`),
   * carried into the printed form, and
   * focus moves to it. Its `kind` is `"success"` (the default), `"info"`, `"warning"` or
   * `"error"`: an error is announced at once (`role="alert"` on the paint that first shows it, a
   * status after, so a keystroke's repaint does not announce it again), the other three politely
   * (`role="status"`). The next `submit()` clears it; so does `setNotice(undefined)`. What
   * happens to the answers is the page's choice: leave them editable, or set
   * `mode = "readonly"` to keep them as sent.
   */
  public setNotice(notice: FormNotice | undefined): void {
    const given = withPlainData(notice);
    this.noticeValue = given;
    if (this.rendererEl) {
      this.rendererEl.notice = given;
      // A notice with only `data` (what a printed header reads) draws nothing: no focus, no announcement.
      if (given && noticeDraws(given)) {
        this.rendererEl.focusNotice();
      }
    }
  }

  /**
   * Submits through the runtime: validates, and when accepted builds the canonical submission
   * envelope. The outcome is dispatched as `datum-submit` and returned; delivering the
   * envelope is the page's job, and `detail.waitUntil(promise)` keeps the form locked while
   * it does. One at a time: a call while one is in flight resolves with that one's
   * outcome. Resolves once the runtime has answered and every extension has settled. In a
   * journey answers that end at an exit page are refused, a blocked submit opens the
   * page holding the first error, and a journey that asks for it is checked with the service
   * (`serverValidator`, `validate-url`) before the envelope is made; the form stays locked
   * while it is.
   */
  public submit(options: Pick<SubmitOptions, "signWith" | "signing" | "trigger"> & { agent?: true } = {}): Promise<DatumFormSubmitDetail> {
    return this.startSubmit(options);
  }

  /** `submit()`, and what the element's own routes add to it (the download's skipped end check). */
  private startSubmit(options: ElementSubmitOptions): Promise<DatumFormSubmitDetail> {
    if (this.inFlight) {
      // A double click joins. Anything else would be answered with another request's outcome (a
      // download handed a plain submit's, or the form before a definition change): refused.
      // The refusal names the form in flight, which a definition swap may have replaced since.
      // A call made while the run waits on one of the host's hooks may come from that hook, which
      // the run would then wait on for good: refused too.
      const ask = this.inFlightAsk;
      return ask !== undefined &&
        !this.dispatchingSubmit &&
        ask.runtime?.submitWaitsOnHost?.() !== true &&
        sameSubmitAsk(ask, this.submitAsk(options))
        ? this.inFlight
        : Promise.reject(new SubmitBusyError(ask?.definition?.id ?? this.definitionValue?.id ?? "", EMBED_SUBMISSION_MODE));
    }
    const later = this.afterBuild(() => this.startSubmit(options));
    if (later) {
      return later;
    }
    const runtime = this.requireRuntime();
    // What the page has been told matches what is about to be submitted.
    this.flushPendingChanges(runtime);
    const ask = this.submitAsk(options);
    const run = this.runSubmit(runtime, options).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
        this.inFlightAsk = undefined;
        this.setSubmitting(false);
      }
    });
    this.inFlight = run;
    this.inFlightAsk = ask;
    this.setSubmitting(true);
    return run;
  }

  /**
   * What a submit call asks for, as far as joining goes: the form and runtime it would submit and
   * the route it takes (a download's local copy and skipped end check, the signer, an agent's).
   * A button's `trigger` is who asked, not what: a click and a `submit()` meanwhile join.
   */
  private submitAsk(options: ElementSubmitOptions): SubmitAsk {
    return {
      definition: this.definitionValue,
      runtime: this.runtimeValue,
      route: JSON.stringify([options.localCopy === true, options.journeyEndCheck ?? null, options.signWith ?? null, options.signing ?? null, options.agent === true])
    };
  }

  private async runSubmit(runtime: FormRuntime, options: ElementSubmitOptions): Promise<DatumFormSubmitDetail> {
    // A new submit is a new outcome: the last receipt goes the way the last errors do.
    this.setNotice(undefined);
    const definition = this.definitionValue!;
    // The call's provider (a button's `signature`, `submit({ signWith })`), else the one every submit requires.
    const signWith = this.allowsSigning("the signWith option and attribute", options.signWith !== undefined) ? (options.signWith ?? this.signWithValue ?? undefined) : undefined;
    // `agent` is the element's own key, like `localCopy`: it reaches the
    // detail as `trigger: "agent"` and never the runtime, whose `trigger` is a button's identity.
    const { localCopy, agent, ...submitOptions } = options;
    // Nor does the journey page a refused agent submit moves to, the one holding the first error
    //: the renderer paints it and leaves focus where the person left it. The quiet
    // ends once the submit settles (the page move happens inside it), so a submit that moved no
    // page leaves none for a later page change.
    const release = agent ? this.rendererEl?.quietNextPageFocus() : undefined;
    // Provenance is read before the runtime submits: the catalogue resets its
    // marks once the submission completes. The runtime hands the hooks a frozen copy, and puts
    // it nowhere else; `datum-submit` carries it too.
    const provenance = this.agentProvenance(agent ? "agent" : "page");
    let result: Awaited<ReturnType<FormRuntime["submit"]>>;
    try {
      result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition), {
        ...(this.wasmLogLevelValue !== undefined ? { wasmLogLevel: this.wasmLogLevelValue } : {}),
        ...submitOptions,
        ...(signWith !== undefined ? { signWith } : {}),
        ...(provenance !== undefined ? { agent: provenance } : {})
      });
    } finally {
      release?.();
    }
    // An agent's submit moves no focus: the person may be typing, and the
    // repaint already shows the errors; only the person's own submit takes them to the first one.
    if (!result.accepted && !agent) {
      this.rendererEl?.focusFirstError();
    }
    const extensions: Promise<unknown>[] = [];
    let open = true;
    const detail: DatumFormSubmitDetail = {
      accepted: result.accepted,
      submission: result.canonicalSubmission,
      errors: result.errors,
      result,
      ...(result.signed ? { signed: result.signed } : {}),
      ...(result.submissionKey !== undefined ? { submissionKey: result.submissionKey } : {}),
      ...(agent ? { trigger: "agent" as const } : {}),
      ...(provenance !== undefined ? { agent: provenance } : {}),
      waitUntil: (promise) => {
        if (!open) {
          throw new Error("waitUntil() must be called while datum-submit is being dispatched, or while an earlier extension is still pending");
        }
        // This very submit, however a listener came by it (a join after the dispatch, while an
        // earlier extension is pending): waiting on it here would wait on itself, for good.
        if (promise === this.inFlight) {
          throw new Error("waitUntil() cannot wait on the submit whose datum-submit it was handed");
        }
        extensions.push(Promise.resolve(promise));
      }
    };
    this.dispatchingSubmit = true;
    try {
      emit<DatumFormSubmitDetail>(this, "datum-submit", detail);
    } finally {
      this.dispatchingSubmit = false;
    }
    // By index, not by iterator: an extension added while an earlier one is awaited is awaited too.
    const replies: unknown[] = [];
    let delivered = true;
    for (let index = 0; index < extensions.length; index += 1) {
      try {
        const reply = await extensions[index];
        replies.push(reply);
        // The documented recipe hands over a fetch, which resolves on a 500: a Response-like
        // reply that says it is not ok is a refused delivery, not a received one.
        if (reply && typeof reply === "object" && (reply as { ok?: unknown }).ok === false) {
          delivered = false;
        }
      } catch (error) {
        delivered = false;
        reportError(this, "submit.delivery-failed", "The delivery handed to datum-submit's waitUntil failed", error);
      }
    }
    open = false;
    // The built-in confirmation: only when asked for, only for an accepted submit
    // whose delivery did not fail, not for the download route (it sends nothing, so "we have
    // received your answers" would be false), and never over a receipt or verdict the page set itself.
    // A notice the page set with only `data` is no receipt on screen: the confirmation is drawn, the page's data kept.
    const pageNotice = this.noticeValue;
    if (
      this.confirmation &&
      !localCopy &&
      result.accepted &&
      delivered &&
      (pageNotice === undefined || !noticeDraws(pageNotice)) &&
      !this.errors.some((error) => error.severity !== "warning" && error.severity !== "info")
    ) {
      this.showConfirmation(receiptReference(replies), pageNotice?.data ?? receiptData(replies), !agent);
    }
    return detail;
  }

  /**
   * Draws the built-in confirmation as a success notice (`confirmation`), focused unless an agent
   * submitted (the notice is drawn, focus stays where the person left it).
   * `data` is the receipt as plain JSON (the reply's, else the page's), which a printed header or
   * footer reads as `{{receipt.<path>}}`.
   */
  private showConfirmation(reference: string | undefined, data: Record<string, unknown> | undefined, focus: boolean): void {
    const word = (key: "confirmationTitle" | "confirmationMessage" | "confirmationReference"): LocalizedText => this.confirmationWord(key);
    const notice: FormNotice = {
      kind: "success",
      title: word("confirmationTitle"),
      message: word("confirmationMessage"),
      ...(reference !== undefined ? { details: [{ label: word("confirmationReference"), value: reference }] } : {}),
      ...(data !== undefined ? { data } : {})
    };
    if (focus) {
      this.setNotice(notice);
      return;
    }
    this.noticeValue = notice;
    if (this.rendererEl) {
      this.rendererEl.notice = notice;
    }
  }

  /**
   * One of the confirmation's sentences as a `LocalizedText`, so the notice follows a locale
   * switch: the engine's English, the page's `texts` and the form's `texts` translations (the
   * definition's map under the host catalog) worded for each locale any of them names.
   */
  private confirmationWord(key: "confirmationTitle" | "confirmationMessage" | "confirmationReference"): LocalizedText {
    const runtime = this.runtimeValue;
    const words = runtime !== undefined ? { translations: runtime.translations(), catalog: runtime.translationCatalog() } : undefined;
    const at = (locale: string): string => resolveFormText(this.textsValue, key, locale, undefined, undefined, undefined, words);
    const tags = new Set<string>([...Object.keys(words?.translations ?? {}), ...Object.keys(words?.catalog ?? {})]);
    const page = this.textsValue?.[key];
    if (page !== undefined && typeof page === "object") {
      for (const tag of Object.keys(page.locales ?? {})) {
        tags.add(tag);
      }
    }
    const locales: Record<string, string> = {};
    for (const tag of tags) {
      locales[tag] = at(tag);
    }
    return { default: at("en"), locales };
  }

  /** The lock, on the renderer and on this element's own attribute, for a page to style or observe. */
  private setSubmitting(value: boolean): void {
    if (this.rendererEl) {
      this.rendererEl.submitting = value;
    }
    if (value) {
      this.setAttribute("submitting", "");
    } else {
      this.removeAttribute("submitting");
    }
  }

  /**
   * Submits, and when accepted saves the canonical envelope as a JSON file the browser
   * downloads — what a `button` with `action: "download"` does. `datum-submit` is dispatched
   * as for `submit()`; then, for an accepted submission, a cancelable `datum-download` carries
   * the file name and text, and `preventDefault()` hands the file to the page instead of the
   * browser. A rejected submit shows its errors and downloads nothing. A journey's check with
   * the service at its end is not run: the person keeps a copy of the answers
   * offline, and the service judges them when they are sent.
   */
  public async submitAndDownload(options: Pick<SubmitOptions, "signWith" | "signing" | "trigger"> = {}): Promise<DatumFormSubmitDetail> {
    const detail = await this.startSubmit({ ...options, journeyEndCheck: "skip", localCopy: true });
    if (detail.accepted && detail.submission) {
      // Under the wrapper placement the signed document is what leaves the page.
      downloadSubmission(this, detail.signed ?? detail.submission);
    }
    return detail;
  }

  /**
   * The print theme {@link print} draws with: `basicPrintTheme` when left out;
   * `datumPrintTheme`, or a design system's, which draws through the `html` tag its drawers are
   * handed. Read when `print()` is called.
   */
  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
    if (this.rendererEl) {
      this.rendererEl.printTheme = value;
    }
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  /**
   * Prints the form (cancel `datum-print` to route the document elsewhere): the form's default
   * rendition (its answers unless the form says otherwise), with `rendition: "blank"` a paper
   * form to fill in by hand, with `rendition: "filled"` that paper form with the answers written
   * in, or with `rendition: "answers"` the answers, on the paper `page` asks for. `locale` prints
   * in another language than the form shows, leaving the form's own as it is.
   */
  public async print(options: PrintCallOptions = {}): Promise<void> {
    if (!this.allows("print")) {
      throw this.leftOut("print", "print()");
    }
    const later = this.afterBuild(() => this.print(options));
    if (later) {
      return later;
    }
    await this.rendererEl?.print(options);
  }

  /**
   * The print renditions the definition offers a person (`configuration.print.renditions`,
   * `["answers"]` when it says nothing) and the one a print without a rendition asks for, for a
   * page offering a choice.
   */
  public get printRenditions(): PrintRenditionsOffered {
    const print = readPrintConfiguration(this.definitionValue?.root?.configuration);
    return { offered: [...print.renditions], default: print.defaultRendition };
  }

  /** The PDF layouts the definition declares, for a page offering a choice; none when `pdf` is left out of `features`. */
  public pdfLayouts(): PdfLayoutOption[] {
    return this.allows("pdf") ? (this.rendererEl?.pdfLayouts() ?? []) : [];
  }

  /** The journeys the definition declares, for a page offering a choice (`journey`). */
  public journeys(): DatumFormJourneyOption[] {
    const runtime = this.runtimeValue;
    if (!runtime || !this.allows("journeys")) {
      return [];
    }
    const locale = runtime.state().locale;
    // A journey's name is a plain string in the default language; its translation lives in the
    // definition's map or the host's catalog at the journey's own address.
    const sources = { translations: runtime.translations(), catalog: runtime.translationCatalog() };
    return runtime.journeys().map((journey) => {
      const name = journey.name === undefined ? undefined : resolveText(journey.name, addressOf.journey(journey.id, "name"), locale, sources).trim();
      return { id: journey.id, label: name ? name : journey.id };
    });
  }

  /**
   * What the running presentation's own fields hold, by own field id: the answers a
   * journey asks for itself and fills no form field with. They stay in the
   * browser — kept in drafts, never in a submission, `values`, `datum-change` or a PDF — so
   * this is where a page reads one. `{}` when no presentation runs, it owns no such field, or
   * nothing is answered; an alias is not listed (its answer is the form field's).
   */
  public presentationValues(): Record<string, unknown> {
    return this.runtimeValue?.presentationValues() ?? {};
  }

  /**
   * Continue, from the page's own control: checks the page as its journey says —
   * and with the service, when it asks — and moves to the next page. A refusal comes back as
   * `{ ok: false, reason }` with focus on what stopped it, as the form's own Continue does.
   */
  public async nextPage(): Promise<JourneyNavigationResult> {
    this.requireJourneys("nextPage()");
    const later = this.afterBuild(() => this.nextPage());
    if (later) {
      return later;
    }
    const result = await this.requireRuntime().nextPage();
    if (!result.ok) {
      this.rendererEl?.focusFirstError();
    }
    return result;
  }

  /** Back: the page before this one on the path as the answers stand now. Nothing is checked. */
  public previousPage(): Promise<JourneyNavigationResult> {
    // Not `async`: with no runtime `requireRuntime()` throws synchronously, as it always did.
    if (!this.allows("journeys")) {
      return Promise.reject(this.leftOut("journeys", "previousPage()"));
    }
    return this.afterBuild(() => this.previousPage()) ?? this.requireRuntime().previousPage();
  }

  /**
   * Opens a page the person has already reached (at or before the first page not yet
   * completed) — a task list's link, the address bar's back button. Refused otherwise.
   */
  public goToPage(pageId: string): Promise<JourneyNavigationResult> {
    if (!this.allows("journeys")) {
      return Promise.reject(this.leftOut("journeys", "goToPage()"));
    }
    return this.afterBuild(() => this.goToPage(pageId)) ?? this.requireRuntime().goToPage(pageId);
  }

  /**
   * Renders the form as a PDF: the layout asked for by id, else the definition's default,
   * else one derived from the form. Loads the PDF module first when `pdf` names one; throws
   * when there is no way to make PDFs.
   */
  public async renderPdf(options: RenderFormPdfOptions = {}): Promise<RenderFormPdfResult> {
    const later = this.afterBuild(() => this.renderPdf(options));
    if (later) {
      return later;
    }
    await this.ensurePdfSupport();
    const result = await this.rendererEl?.renderPdf(options).catch((error: unknown) => this.failPdf(error));
    if (!result) {
      throw new Error("No form to render as a PDF");
    }
    return result;
  }

  /**
   * Renders the form as a PDF and saves it as a file — after a cancelable `datum-pdf` event
   * carrying the bytes, which a page cancels to take the file over. `agent: true` is the agent
   * tools' `download_pdf`: it never reaches the renderer, and the event says
   * `trigger: "agent"`. The event carries the page's provenance account as `agent` whenever the
   * agent tools were ever live for this form.
   */
  public async downloadPdf(options: RenderFormPdfOptions & { agent?: true } = {}): Promise<DownloadPdfResult> {
    const later = this.afterBuild(() => this.downloadPdf(options));
    if (later) {
      return later;
    }
    await this.ensurePdfSupport();
    const { agent, ...rest } = options;
    const provenance = this.agentProvenance(agent ? "agent" : "page");
    const result = await this.rendererEl
      ?.downloadPdf({ ...rest, ...(agent ? { trigger: "agent" as const } : {}), ...(provenance !== undefined ? { agent: provenance } : {}) })
      .catch((error: unknown) => this.failPdf(error));
    if (!result) {
      throw new Error("No form to render as a PDF");
    }
    return result;
  }

  /** Switches locale; throws for one the form does not support. */
  public setLocale(locale: string): void {
    if (!this.allows("translations")) {
      throw this.leftOut("translations", "setLocale()");
    }
    this.localeValue = locale;
    // Synchronous, so it cannot wait for a journey form's runtime: it throws while one loads
    // (the locale is kept, and the runtime is built in it).
    this.requireBuiltRuntime().setLocale(locale);
  }

  /**
   * Clears the form back to how it first opened for its current definition: what the person
   * typed, the errors and notice shown, which fields were touched and the journey's position all
   * go, and the page's `values` seed is applied again. The language the person chose, the
   * definition and every setting stay. It is a rebuild on the same path as assigning `definition`,
   * so `datum-ready` is raised again, and then one `datum-change` (no `path`, `value` and `values`
   * the form's answers now) tells the page the answers were cleared. Resolves once that is done;
   * rejects as `ready` does when the build fails. Nothing happens for a form with no definition.
   *
   * A stored draft is left as it is: reset writes no draft and deletes none. The autosave that a
   * later change arms then saves the answers as they stand, so the first edit after a reset
   * replaces the draft with the new, mostly empty form. Call `clearDraft()` as well to drop it.
   */
  public reset(): Promise<void> {
    if (!this.definitionValue) {
      return Promise.resolve();
    }
    // The same fresh start a newly assigned definition gets (nothing carried across the build),
    // with the seed applied again by that build.
    this.freshDefinition = true;
    this.resetAnnounced = true;
    this.request("runtime");
    return this.ready;
  }

  /** Whether a draft is stored under the `draft` key. */
  public async hasDraft(): Promise<boolean> {
    const later = this.afterBuild(() => this.hasDraft());
    if (later) {
      return later;
    }
    const { store, key } = this.requireDraft();
    try {
      await store.load(key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Saves the answers under the `draft` key now, as the autosave would after its pause (which
   * this one replaces): what is still being typed is reported first, then saved. Resolves with
   * the saved draft's summary.
   */
  public async saveDraft(): Promise<FormDraftSummary> {
    const later = this.afterBuild(() => this.saveDraft());
    if (later) {
      return later;
    }
    const { key } = this.requireDraft();
    return this.saveDraftOf(this.requireRuntime(), key);
  }

  /**
   * Loads the draft stored under the `draft` key into the form, and resolves with when it was
   * saved and the language it put the form in, and `dropped`: the value paths of answers the
   * form cannot hold (an object or a list in a single-valued field), left out while the rest is
   * restored and told once as `datum-warning` (`code` `draft.dropped`). Rejects with a `DraftError` (`code`
   * `draft.notFound`, `draft.formMismatch`, `draft.incompatible`, `draft.malformed`) from the
   * built-in stores and the runtime, or with a page-assigned store's own error.
   */
  public async restoreDraft(): Promise<{ updatedAt: number; locale: string; dropped?: string[] }> {
    const later = this.afterBuild(() => this.restoreDraft());
    if (later) {
      return later;
    }
    const { store, key } = this.requireDraft();
    const draft = await store.load(key);
    const runtime = this.requireRuntime();
    const restored = await runtime.hydrateFromDraft(draft);
    const dropped = restored.dropped.map((entry) => entry.path);
    // An answer the field cannot hold (an object in a text box) is left out and the rest
    // restored; the page hears which, since the person will not find them on the form.
    if (dropped.length > 0) {
      const named = dropped.slice(0, 5);
      const more = dropped.length > named.length ? `, and ${dropped.length - named.length} more` : "";
      reportWarning(this, {
        code: "draft.dropped",
        count: dropped.length,
        addresses: named,
        message: `The draft was restored without ${dropped.length === 1 ? "1 answer" : `${dropped.length} answers`} the form cannot hold (${named.join(", ")}${more}).`
      });
    }
    return { updatedAt: draft.updatedAt, locale: runtime.state().locale, ...(dropped.length > 0 ? { dropped } : {}) };
  }

  /** Deletes the draft stored under the `draft` key. */
  public async clearDraft(): Promise<void> {
    const later = this.afterBuild(() => this.clearDraft());
    if (later) {
      return later;
    }
    const { store, key } = this.requireDraft();
    // The autosave the last write armed would put the draft straight back 300 ms later, so a
    // cleared draft (the person's or an agent's `drafts { action: "clear" }`) stays gone.
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    await store.delete(key);
  }

  // --- internals ---------------------------------------------------------

  /**
   * The shadow root's skeleton: the element's own rules and the renderer. Built from elements and
   * a constructed sheet, never markup, so the element draws on a page that enforces Trusted Types
   * and under a `style-src` with no `'unsafe-inline'` (a `<style>` only where sheets cannot be adopted).
   */
  private buildDom(): void {
    const owner = this.ownerDocument;
    const nodes: Node[] = [];
    const adoptable =
      typeof CSSStyleSheet === "function" &&
      Array.isArray((this.root as { adoptedStyleSheets?: unknown }).adoptedStyleSheets) &&
      typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync === "function";
    let adopted = false;
    if (adoptable) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(FORM_ELEMENT_CSS);
        this.root.adoptedStyleSheets = [...this.root.adoptedStyleSheets, sheet];
        adopted = true;
      } catch {
        // A browser that has the property but refuses the sheet: the element below.
      }
    }
    if (!adopted) {
      const style = owner.createElement("style");
      style.textContent = FORM_ELEMENT_CSS;
      nodes.push(style);
    }
    const renderer = owner.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    renderer.setAttribute("part", "form");
    nodes.push(renderer);
    this.root.replaceChildren(...nodes);
    this.rendererEl = renderer;

    // A `submit` or `download` button is the element's to act on; the page hears the outcome
    // as `datum-submit` (and `datum-download`). Any other action is the page's, and passes
    // through (the engine's event is composed, so it reaches listeners on this element
    // untouched). A journey's own Submit on its last page comes this way too, as a
    // `submit` naming the form root: no button of the form pressed it, so it triggers as none.
    // A locale the filler picks in the switcher is the form's locale from then on: a rebuilt
    // runtime starts at the default and applyLocale puts this one back. (Not reflected to the
    // attribute, as setLocale does not.)
    renderer.addEventListener("datum-locale-applied", (event) => {
      this.localeValue = (event as CustomEvent<{ locale: string }>).detail.locale;
    });
    renderer.addEventListener("datum-form-action", (event) => {
      const detail = (event as CustomEvent<DatumFormActionDetail>).detail;
      // A button's `signature` option names the signing provider its submit uses.
      const signing = {
        ...(detail.signature && this.allowsSigning("a button's signature option", true) ? { signWith: detail.signature } : {}),
        ...(detail.journey ? {} : { trigger: { componentId: detail.componentId } })
      };
      switch (detail.action) {
        case "submit":
          event.stopPropagation();
          void this.submit(signing).catch((error: unknown) => {
            reportError(this, "submit.failed", "Submit failed", error);
          });
          break;
        case "download":
          event.stopPropagation();
          void this.submitAndDownload(signing).catch((error: unknown) => {
            reportError(this, "submit.failed", "Submit and download failed", error);
          });
          break;
        case "pdf":
          // Served here only when PDFs are possible; otherwise it passes through as unhandled.
          if (this.allows("pdf") && (this.pdfSpec !== undefined || this.pdfSupportValue)) {
            event.stopPropagation();
            this.root.querySelector("[data-pdf-error]")?.remove();
            // The button checks the answers first, as Submit does: an invalid form
            // shows the same summary and focus, and no PDF of blanks is made. Warnings and notes
            // do not stop it, as they do not stop a submit.
            void this.validate()
              .then((errors) => (errors.some((error) => error.severity !== "warning" && error.severity !== "info") ? undefined : this.downloadPdf()))
              .catch((error: unknown) => {
                // A missing module was told to the page when it failed to load (once is enough),
                // and the filler is told too, in the form's own alert: the button would
                // otherwise seem to do nothing.
                if (isChunkLoadError(error)) {
                  this.showPdfUnavailable();
                } else {
                  reportError(this, "pdf.failed", "PDF failed", error);
                }
              });
          }
          break;
        default:
          break;
      }
    });
  }

  private request(update: Update): void {
    if (update === "runtime") {
      // A settled `ready` (resolved for the form that was, or rejected by a failure a Retry
      // answers) is over: the next one to ask gets the promise for the build this starts.
      if (this.readyState?.settled) {
        this.readyState = undefined;
      }
    }
    this.pending.add(update);
    if (this.flushQueued) {
      return;
    }
    this.flushQueued = true;
    // One rebuild per batch of attribute and property assignments, not one per assignment.
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.isConnected || !this.rendererEl || this.pending.size === 0) {
      return;
    }
    const pending = new Set(this.pending);
    this.pending.clear();
    if (pending.has("runtime")) {
      this.rebuildRuntime();
      return;
    }
    if (pending.has("renderer")) {
      this.applyRendererConfig();
    }
    if (pending.has("pdf")) {
      this.applyPdfSupport();
    }
    // A form waiting for its runtime: values, locale, journey, page and the
    // validator are read when that runtime is built, so they wait with it rather than land on
    // the form it replaces.
    if (this.buildGate) {
      return;
    }
    // In place: the runtime works the form out again over the answers it holds.
    if (pending.has("host-context")) {
      this.runtimeValue?.setHostContext(this.hostContextValue);
    }
    if (pending.has("values")) {
      this.applyValues();
    }
    if (pending.has("locale")) {
      this.applyLocale();
    }
    if (pending.has("validator")) {
      this.applyServerValidator();
    }
    // A journey (re)started opens on `page` when it may; otherwise `page` is a jump. Values
    // arriving for a journey that had no page to open on may give it one.
    const restarted =
      (pending.has("journey") || (pending.has("values") && this.journeyAwaitingAnswers)) && this.applyJourney();
    if (pending.has("page") && !restarted) {
      this.applyPage();
    }
  }

  /**
   * The notice a refused definition draws inside the element: `data-form-error`, `role="alert"`,
   * the error's message, and for a formula refusal one line per problem (where, then the text).
   * The renderer has no runtime to paint then, so without this the page would be blank.
   */
  private showFormError(error: unknown): HTMLElement {
    this.clearFormError();
    const notice = document.createElement("div");
    notice.setAttribute("data-form-error", "");
    notice.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.className = "form-error__message";
    message.textContent = error instanceof Error ? error.message : String(error);
    notice.append(message);
    const problems = (error as { problems?: unknown } | null)?.problems;
    if (Array.isArray(problems) && problems.length > 0) {
      const list = document.createElement("ul");
      list.className = "form-error__problems";
      for (const problem of problems as Array<{ where?: unknown; message?: unknown }>) {
        const item = document.createElement("li");
        const where = document.createElement("code");
        where.textContent = String(problem.where ?? "");
        item.append(where, document.createTextNode(` ${String(problem.message ?? "")}`));
        list.append(item);
      }
      notice.append(list);
    }
    this.root.insertBefore(notice, this.rendererEl ?? null);
    return notice;
  }

  /**
   * The card a definition that could not be put in place leaves: the form's alert marked
   * `data-definition-error`, worded by the form's `definitionUnavailable` text for the person
   * filling in the form. The reason (address, status) stays with `datum-error` and the console.
   * It is drawn only when the element has no form at all: the renderer is hidden so its
   * "Loading form…" line does not stand beside the card. An element that holds a definition, drawn
   * or still being built, keeps that form and says nothing over it, as it does for any refused
   * definition; so does one showing why its journeys could not start. The card stays until a
   * definition arrives or `src` changes or goes (see {@link clearDefinitionFailure}), through any
   * rebuild in between.
   */
  private showDefinitionUnavailable(): void {
    if (this.definitionValue !== undefined || this.runtimeValue || this.journeysFailure) {
      return;
    }
    this.definitionFailed = true;
    // Before the element is connected there is no shadow tree yet: connecting draws the card.
    if (!this.rendererEl) {
      return;
    }
    this.root.querySelector("[data-definition-error]")?.remove();
    this.showFormError(new Error(this.ownText("definitionUnavailable"))).setAttribute("data-definition-error", "");
    this.rendererEl.hidden = true;
  }

  /** Takes the definition card down and brings the renderer (and its loading line, while there is no form) back. */
  private clearDefinitionFailure(): void {
    if (!this.definitionFailed) {
      return;
    }
    this.definitionFailed = false;
    this.root.querySelector("[data-definition-error]")?.remove();
    if (this.rendererEl && !this.journeysFailure) {
      this.rendererEl.hidden = false;
    }
  }

  /** The alert the form's PDF button leaves when the PDF module is missing: `data-form-error` with `data-pdf-error`, worded by the form's `pdfUnavailable` text. */
  private showPdfUnavailable(): void {
    const message = resolveFormText(this.textsValue, "pdfUnavailable", this.localeValue ?? "en", this.runtimeValue?.translationCatalog());
    this.showFormError(new Error(message)).setAttribute("data-pdf-error", "");
  }

  private clearFormError(): void {
    // The definition card is not a build's to take down: no build mends a definition that never came.
    this.root.querySelector("[data-form-error]:not([data-definition-error])")?.remove();
  }

  /**
   * Builds the runtime for the definition as it stands, one way for every form. The form is building from here until the build lands: the form it replaces (if
   * any) stays up and bound until the swap, the queueing methods wait (`afterBuild`), and a newer
   * request takes over (a stale build is dropped by its token, and reuses the import already on
   * its way). What the build waits for is the journey engine: a form with no journeys, or whose
   * `features` leave journeys out, has the Noop pair at once and fetches nothing; a form with
   * journeys awaits the chunk, which resolves at once when it is already on the page. Either way
   * the runtime lands in a later microtask, and `datum-ready` with it. A journey with a page of
   * kind `review` waits for the Check answers chunk too (fetched beside the journeys chunk), so that
   * page is drawn with its list the first time it shows. A chunk that does not
   * arrive leaves the card with Retry and a `datum-error`, never the form drawn as one page.
   */
  private rebuildRuntime(): void {
    const token = ++this.buildToken;
    // A new build replaces a failed one: the card goes, and the form shows it is loading again.
    this.clearJourneysFailure();
    this.buildGate ??= openBuildGate();
    const bundle: Promise<Pick<JourneyEngineBundle, "engine" | "renderKit">> = this.needsJourneysRuntime(this.definitionValue)
      ? journeysBundle(this.definitionValue!)
      : Promise.resolve(NOOP_JOURNEY_BUNDLE);
    bundle.then(
      (loaded) => {
        if (token !== this.buildToken) {
          // A newer request builds (and settles the waiting calls) instead.
          return;
        }
        if (!this.isConnected) {
          // Taken out of the page meanwhile: built when it is attached again, as a request would be.
          this.pending.add("runtime");
          return;
        }
        try {
          this.buildRuntime(loaded.engine, loaded.renderKit);
        } catch (error) {
          // Not a refused definition (that is told by the card): something broke the swap. The
          // calls waiting on it go ahead rather than hang, and the error is not swallowed.
          this.settleBuild();
          this.settleReady({ error });
          throw error;
        }
      },
      (error: unknown) => {
        if (token === this.buildToken) {
          this.failJourneysRuntime(error);
        }
      }
    );
  }

  /**
   * The body of a build, with the journey engine the runtime runs and the kit its pages are drawn
   * with: the Noop pair, or the pair the journeys chunk holds. Always passed, never the page's
   * default (`setDefaultJourneyEngine`), which another bundle on the page may have set.
   */
  private buildRuntime(journeyEngine: JourneyEngine, journeyKit: JourneyRenderKit): void {
    // A rebuild for the form already on the page (a new catalog, data sources, plugins, a
    // timeout, a policy) hands the answers typed so far to the runtime that replaces it. Only a
    // runtime built for this very definition hands its answers on: one built for another is
    // still bound while a build waits, and its answers are not this form's. A definition the
    // page has just put in place starts fresh, even the same object assigned again.
    const fresh = this.freshDefinition;
    this.freshDefinition = false;
    const carried =
      !fresh && this.runtimeValue && this.builtFor === this.definitionValue ? this.runtimeValue.formValues() : undefined;
    // `values` the page assigned since they were last applied are its word on the answers, over
    // the ones carried across; otherwise they are the seed the carried answers were typed over.
    const valuesWin = this.valuesAssigned;
    // A `reset()` asked for this build: the page hears of it once the form is up.
    const announceReset = this.resetAnnounced;
    this.resetAnnounced = false;
    // The answers carry over, so what was typed into them is a change the page has yet to hear:
    // reported now, as unbinding drops whatever is still pending.
    if (carried && this.runtimeValue) {
      this.flushPendingChanges(this.runtimeValue);
    }
    this.unbindRuntime();
    const renderer = this.rendererEl!;
    this.clearFormError();
    if (!this.definitionValue) {
      this.runtimeValue = undefined;
      renderer.runtime = undefined;
      this.settleBuild();
      return;
    }
    let runtime: FormRuntime;
    try {
      this.activeDraftStore = this.chosenDraftStore();
      const signing = this.allowsSigning("signingProvider, signingProviders and signing");
      if (signing && (this.signingProviderValue !== undefined || this.signingProvidersValue !== undefined || this.signingValue !== undefined)) {
        // Signing is configured and allowed: fetch the WebAuthn chunk now so sign() does not
        // spend Safari's user gesture on it. Never when signing is left out, even if the
        // host built a provider. A failure surfaces, retried, through sign().
        loadWebAuthn().catch(() => {});
      }
      runtime = createFormRuntime(this.definitionValue, {
        dataSources: this.allowsDataSources() ? this.dataSourcesValue : this.ignoredDataSources(),
        pluginDataSources: this.allows("data-sources"),
        translations: this.allows("translations") ? this.translationsValue : undefined,
        componentDefinitions: this.componentDefinitionsValue,
        plugins: this.pluginsValue,
        pluginRegistry: this.pluginRegistryValue,
        draftStore: this.activeDraftStore,
        signingProvider: signing ? this.reportingProvider(this.signingProviderValue) : undefined,
        signingProviders: signing ? this.signingProvidersValue?.map((provider) => this.reportingProvider(provider)!) : undefined,
        signing: signing ? this.signingValue : undefined,
        // Built as the whole form: the journey the page asks for starts below, once
        // the prefill is in. Its first page, and whether `page` may be opened, are decided over
        // the answers the page seeded — a route's `when` may read a component on no page that
        // only the host fills — never over an empty form.
        journey: "form",
        // What runs a journey: the journeys chunk's engine for a form with journeys, else the Noop one.
        journeyEngine,
        // The way to the service for the checks a journey asks of it.
        journeyServerValidator: this.effectiveServerValidator(),
        journeyServerValidationTimeoutMs: this.allows("server-validation") ? this.validateTimeoutValue : undefined,
        ...(this.dataSourceTimeoutValue !== undefined ? { dataSourceTimeoutMs: this.dataSourceTimeoutValue } : {}),
        // The policy for rules the parser rejects (formulas), for the runtime's compile and its sandbox.
        ...(this.formulaErrorsValue !== undefined ? { formulaErrors: this.formulaErrorsValue } : {}),
        ...(this.riskyPatternsValue !== undefined ? { riskyPatterns: this.riskyPatternsValue } : {}),
        // What the rules' `host.` paths read, from the start: the first paint already follows it.
        ...(this.hostContextValue !== undefined ? { hostContext: this.hostContextValue } : {}),
        // With a way to a sandbox, the runtime gets a stage that defers to it: what the
        // element resolves at each submit, arrived or awaited (see DeferredWasmValidationHost).
        ...(this.hasSandbox()
          ? {
              wasmValidationHost: new DeferredWasmValidationHost(() => this.ensureWasmHost()),
              wasmExternalDataProvider: (context: DatumFormWasmExternalDataContext) => this.resolveWasmExternalData(context)
            }
          : {})
      });
    } catch (error) {
      this.runtimeValue = undefined;
      renderer.runtime = undefined;
      this.showFormError(error);
      reportError(this, "definition.build-failed", "The form definition could not be loaded into a runtime", error);
      this.settleBuild();
      this.settleReady({ error });
      return;
    }
    this.runtimeValue = runtime;
    this.builtFor = this.definitionValue;
    // Two components with one id are one answer to the runtime: said once per build, in the
    // notice a refused definition gets and as a `datum-error`; the form is still drawn.
    const repeatedIds = duplicateComponentIds(this.definitionValue.root);
    if (repeatedIds.length > 0) {
      const message = `The form has more than one component with the id ${repeatedIds.map((id) => `"${id}"`).join(", ")}; they share one value. Give each component its own id.`;
      this.showFormError(new Error(message));
      reportError(this, "definition.duplicate-ids", message);
    }
    if (this.debugValue && this.allows("journeys") && readJourneys(this.definitionValue).length > 0) {
      reportJourneyDiagnostics(this, this.definitionValue);
    }
    // A new form has no receipt yet; the last one was for the form that went.
    this.noticeValue = undefined;
    // Prefill and locale go in before anything listens, so neither reads as a user change;
    // then the journey starts over them, before the first paint and before anything listens
    // (no `datum-page-change`, no draft save), as a start is the runtime's move.
    this.journeyAwaitingAnswers = false;
    if (!valuesWin) {
      this.applyValues();
    }
    if (carried) {
      for (const { path, error } of runtime.setValues(carried)) {
        reportError(this, "answer.keep-failed", `Could not keep the answer of "${path}"`, error);
      }
    }
    if (valuesWin) {
      this.applyValues();
    }
    this.applyLocale();
    this.applyJourney();
    this.applyRendererConfig();
    // The kit before the runtime, so the renderer's first build of it draws the pages with it.
    this.journeyKit = journeyKit;
    if (renderer.journeyKit !== journeyKit) {
      renderer.journeyKit = journeyKit;
    }
    renderer.runtime = runtime;
    this.bindRuntime(runtime);
    if (this.redirectedFromStart) {
      this.redirectedFromStart = false;
      this.reportRedirect(runtime, null);
    }
    // Settled before `datum-ready` is heard, so a listener's own calls run at once; the calls that
    // waited run after the listeners, in the order they were made.
    this.settleBuild();
    emit<DatumFormReadyDetail>(this, "datum-ready", { runtime });
    // The agent registrar hears of a rebuilt runtime here: its revision moves and an open session ends.
    this.agentRuntimeLanded(runtime);
    // One settled change for the whole form, after `datum-ready` and before `reset()` resolves.
    // Not through the write path: it arms no autosave, so a stored draft is left as it was.
    if (announceReset) {
      this.emitChange(runtime, "", runtime.formValues());
    }
    // After the listeners have run, so whoever awaits `ready` meets a form its listeners have seen.
    this.settleReady();
    this.prefetchWasm();
  }

  /** A build ended, with a runtime or without one: the calls waiting on it go ahead (and meet what is there). */
  private settleBuild(): void {
    const gate = this.buildGate;
    this.buildGate = undefined;
    gate?.resolve();
  }

  /** Whether the definition runs on the journeys runtime: it has journeys, and `features` (when set) lists them. */
  private needsJourneysRuntime(definition: FormDefinition | undefined): boolean {
    return definition !== undefined && this.allows("journeys") && readJourneys(definition).length > 0;
  }

  /** Starts the journeys runtime loading ahead of the build that needs it; a failure is the build's to report. */
  private prefetchJourneys(): void {
    loadJourneyEngine().catch(() => {});
  }

  /**
   * The journeys runtime did not arrive (absent-code resilience): the form it was for
   * cannot run without it, and is never drawn as one page instead; the form it was to replace
   * belonged to another definition, so it goes too. The card says so, with Retry; the page hears
   * it once as `datum-error`, with the browser's error as `cause`; the calls that waited reject
   * with the same error, and so do the queueing methods until a build replaces it.
   */
  private failJourneysRuntime(error: unknown): void {
    const failure = error instanceof Error ? error : new ChunkLoadError("The journeys runtime", error);
    this.unbindRuntime();
    this.runtimeValue = undefined;
    this.rendererEl!.runtime = undefined;
    this.journeysFailure = failure;
    this.showJourneysUnavailable();
    reportError(this, "journeys.unavailable", failure.message, (failure as { cause?: unknown }).cause ?? failure);
    const gate = this.buildGate;
    this.buildGate = undefined;
    gate?.reject(failure);
    this.settleReady({ error: failure });
  }

  /**
   * The card a journey form leaves when its runtime did not arrive: the form's alert
   * (`data-form-error`, `role="alert"`) marked `data-journeys-error`, worded by the form's
   * `journeysUnavailable` text, with a Retry button (`data-journeys-retry`, worded by `retry`)
   * that builds again, the chunk asked for anew. The renderer is hidden meanwhile: it has no form
   * to draw, and its "Loading form…" would never end.
   */
  private showJourneysUnavailable(): void {
    const card = this.showFormError(new Error(this.ownText("journeysUnavailable")));
    card.setAttribute("data-journeys-error", "");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.setAttribute("data-journeys-retry", "");
    retry.textContent = this.ownText("retry");
    retry.addEventListener("click", () => this.request("runtime"));
    card.append(retry);
    this.rendererEl!.hidden = true;
  }

  /** Takes the card down and shows the renderer again, when a build replaces a failed one. */
  private clearJourneysFailure(): void {
    if (!this.journeysFailure) {
      return;
    }
    this.journeysFailure = undefined;
    this.root.querySelector("[data-journeys-error]")?.remove();
    this.rendererEl!.hidden = false;
  }

  /** A text the element words itself when the form has no runtime: the page's `texts` in the page's locale, else the engine's English (`DEFAULT_FORM_TEXTS`). */
  private ownText(key: "definitionUnavailable" | "journeysUnavailable" | "retry"): string {
    return resolveFormText(this.textsValue, key, this.localeValue ?? "en", this.allows("translations") ? this.translationsValue : undefined);
  }

  /**
   * For a method that cannot run before the form's runtime is built: while it
   * is building (every form does, for a microtask at least), `run` once it is (the calls in the order they were made), or the load's error
   * when the journeys runtime does not arrive; after that failure, until a build replaces it, the
   * same error at once. `undefined` when the method runs now.
   */
  private afterBuild<T>(run: () => Promise<T>): Promise<T> | undefined {
    if (this.buildGate) {
      return this.buildGate.promise.then(run);
    }
    if (this.journeysFailure) {
      return Promise.reject(this.journeysFailure);
    }
    return undefined;
  }

  // --- the sandbox ---------------------------------------------------------

  /** Whether the runtime is built with a sandbox stage: there is a way to a sandbox, arrived or not. */
  private hasSandbox(): boolean {
    if (this.wasmSpec === undefined && this.wasmHostValue === undefined) {
      return false;
    }
    // Asked for, but the list leaves the sandbox out: no stage, no module request.
    if (!this.allows("wasm")) {
      this.ignoreLeftOut("wasm", "the wasm attribute and wasmValidationHost");
      return false;
    }
    return true;
  }

  /**
   * After `wasm` or `wasmValidationHost` changed. The runtime gains or loses its sandbox stage
   * only when the way to one appeared or went, so a sandbox arriving on a form built to expect
   * one rebuilds nothing; otherwise the new way is taken up at once.
   */
  private settleSandbox(hadSandbox: boolean): void {
    if (this.hasSandbox() !== hadSandbox) {
      this.request("runtime");
    } else {
      this.prefetchWasm();
    }
  }

  /** Starts the sandbox loading as soon as a form is live, so the first submit does not wait on the module. */
  private prefetchWasm(): void {
    if (!this.runtimeValue || !this.hasSandbox() || this.wasmHostValue !== undefined) {
      return;
    }
    void this.ensureWasmHost().catch(() => {
      // Reported by the load itself; a submit meanwhile fails closed with the same cause.
    });
  }

  /** The sandbox to run in: the page's, else the module's for the current spec and plugins, loading it if need be. */
  private ensureWasmHost(): Promise<WasmValidationHost> {
    if (!this.allows("wasm")) {
      return Promise.reject(this.leftOut("wasm", "The validation sandbox"));
    }
    if (this.wasmHostValue !== undefined) {
      return Promise.resolve(this.wasmHostValue);
    }
    const spec = this.wasmSpec;
    if (spec === undefined) {
      return Promise.reject(new Error('No validation sandbox: set the "wasm" attribute (e.g. wasm="auto") or assign wasmValidationHost'));
    }
    const plugins = this.wasmModules();
    let load = this.wasmLoad;
    if (!load || load.spec !== spec || !sameModules(load.plugins, plugins)) {
      this.dropLoadedWasm();
      const current: WasmLoad = { spec, plugins, host: loadWasmValidationHost(spec, plugins, { timeoutMs: this.wasmTimeoutValue ?? DEFAULT_WASM_TIMEOUT_MS }), ready: undefined };
      load = current;
      this.wasmLoad = current;
      current.host.then(
        (host) => {
          if (this.wasmLoad === current) {
            current.ready = host;
            emit<DatumFormWasmReadyDetail>(this, "datum-wasm-ready", { host });
          } else {
            // Superseded while loading: nothing will run in it.
            host.dispose();
          }
        },
        (error: unknown) => {
          if (this.wasmLoad === current) {
            this.wasmLoad = undefined;
            // A module that is not there arrives as a ChunkLoadError: its message names the file,
            // and the browser's own error is the cause, as for the PDF module.
            if (isChunkLoadError(error)) {
              reportError(this, "sandbox.unavailable", `The validation sandbox could not be loaded (wasm="${spec}"): ${error.message}`, (error as { cause?: unknown }).cause);
            } else {
              reportError(this, "sandbox.unavailable", `The validation sandbox could not be loaded (wasm="${spec}")`, error);
            }
          }
        }
      );
    }
    return load.host;
  }

  /** The modules the sandbox is wired with: the installed plugins', then the page's `wasmPlugins`. */
  private wasmModules(): WasmPluginModule[] {
    return [...(this.runtimeValue?.installedPlugins()?.mergedWasmPlugins ?? []), ...this.wasmPluginsValue];
  }

  /** Releases the sandbox loaded from `wasm`; one still loading is released on arrival. */
  private dropLoadedWasm(): void {
    const load = this.wasmLoad;
    if (!load) {
      return;
    }
    this.wasmLoad = undefined;
    load.ready?.dispose();
  }

  /** The snapshot a submit injects: what the page assigned, resolved for this submit when it is a function. */
  private async resolveWasmExternalData(context: DatumFormWasmExternalDataContext): Promise<Record<string, unknown>> {
    const source = this.wasmExternalDataValue;
    if (source === undefined) {
      return {};
    }
    return typeof source === "function" ? source(context) : source;
  }

  private applyRendererConfig(): void {
    const renderer = this.rendererEl!;
    renderer.mode = this.modeValue;
    // The form is drawn by a binding: the renderer resolves an id through the page's
    // `bindings` registry and falls back to Datum's, reporting an unknown id itself.
    renderer.binding = this.bindingValue;
    renderer.assets = this.assetsValue;
    renderer.colorScheme = this.colorSchemeValue;
    renderer.messages = this.messagesValue;
    renderer.texts = this.textsValue;
    renderer.headingLevel = this.headingLevelValue;
    renderer.submittingPlacement = this.submittingPlacementValue;
    renderer.errorSummaryPlacement = this.errorSummaryPlacementValue;
    renderer.notice = this.noticeValue;
    renderer.printTheme = this.printThemeValue;
    // The plugins' data sources behind the page's, and their components beside the catalogue.
    const plugins = this.allPlugins();
    renderer.dataSources = this.allowsDataSources() ? withPluginDataSources(this.dataSourcesValue, plugins) : undefined;
    renderer.dataSourceWait = this.dataSourceWaitValue;
    renderer.dataSourceTimeout = this.dataSourceTimeoutValue;
    // `language-switcher` is the short form of a header switcher, which on a form whose author
    // placed one fills the author's slot, and `frame` / `frame-fixed` the short form
    // of `chrome.frame`. They merge into the page's `chrome`; a setting both give is
    // the `chrome` property's.
    const translations = this.allows("translations");
    if (!translations && (this.languageSwitcherValue || this.translationsValue !== undefined)) {
      this.ignoreLeftOut("translations", "the language-switcher and translations settings");
    }
    const shorthand: FormChromeConfiguration = {
      ...(this.languageSwitcherValue && translations ? { header: [{ type: "language-switcher" as const }] } : {}),
      ...(this.frameValue ? { frame: this.frameFixedValue ? { id: this.frameValue, fixed: true } : this.frameValue } : {})
    };
    const chrome = mergeChromeShorthand(this.chromeValue, shorthand);
    // No translations, no language switcher: the host's is dropped, and the form author's with
    // it (the chrome's own `formLanguageSwitcher: false`).
    renderer.chrome = translations ? chrome : this.withoutLanguageSwitchers(chrome);
    this.applyPdfSupport();
  }

  private applyPdfSupport(): void {
    const renderer = this.rendererEl;
    if (!renderer) {
      return;
    }
    // The list leaves PDFs out: the renderer gets none of the PDF wiring, and what the
    // page set for it is ignored with one warning. formulaErrors and riskyPatterns are the
    // runtime's, not the PDF's, and stay.
    const pdf = this.allows("pdf");
    if (!pdf && (this.pdfSpec !== undefined || this.pdfSupportValue !== undefined || this.pdfThemeValue !== undefined)) {
      this.ignoreLeftOut("pdf", "the pdf, pdfSupport and pdf-theme settings");
    }
    // The support and the element's settings map onto the PDF pipeline as `renderPdf(runtime)`
    // in datum-pdf.js maps them (pdf-render.ts), so the element and the function draw one document.
    const drawing = pdf
      ? pdfServiceDependencies(this.pdfSupportValue, { theme: this.resolvedPdfTheme(), themes: this.themesValue.pdfLookup, templates: this.pdfTemplatesValue })
      : undefined;
    renderer.pdfProvider = drawing?.provider;
    renderer.pdfFonts = drawing?.fonts;
    renderer.pdfImages = drawing?.images;
    renderer.pdfTemplates = drawing?.templates;
    renderer.pdfTheme = drawing?.theme;
    renderer.pdfThemes = drawing?.themes;
    renderer.pdfUnknownComponents = pdf ? this.pdfUnknownComponentsValue : undefined;
    renderer.formulaErrors = this.formulaErrorsValue;
    renderer.riskyPatterns = this.riskyPatternsValue;
    const signs = pdf && this.allowsSigning("pdfSigner and pdfSignature");
    renderer.pdfSigner = signs ? this.pdfSignerValue : undefined;
    renderer.pdfSignature = signs ? this.pdfSignatureValue : undefined;
  }

  /** The `pdf-theme` attribute's theme; unset is `undefined` (the support's, else the engine default), a typo is reported once. */
  private resolvedPdfTheme(): PdfThemeDefinition | undefined {
    if (this.pdfThemeValue === undefined || this.pdfThemeValue === null) {
      return undefined;
    }
    const key = `pdf:${String(this.pdfThemeValue)}`;
    try {
      const theme = this.themesValue.resolvePdf(this.pdfThemeValue);
      this.unresolvedThemes.delete(key);
      return theme;
    } catch (error) {
      reportUnresolved(this, this.unresolvedThemes, key, error, "pdf-theme.unresolved");
      return undefined;
    }
  }

  /** A PDF that failed in the renderer: the PDF service chunk not arriving is told to the page, then the failure goes on to the caller. */
  private failPdf(error: unknown): never {
    this.reportChunkLoadFailure(error);
    throw error;
  }

  /** The PDF support, loading the module named by `pdf` the first time it is needed. */
  private async ensurePdfSupport(): Promise<DatumPdfSupport> {
    if (!this.allows("pdf")) {
      throw this.leftOut("pdf", "PDF rendering");
    }
    if (this.pdfSupportValue) {
      return this.pdfSupportValue;
    }
    if (this.pdfSpec === undefined) {
      throw new Error('No PDF support: set the "pdf" attribute (e.g. pdf="auto") or assign pdfSupport');
    }
    const load = (this.pdfLoad ??= loadPdfSupport(this.pdfSpec));
    let support: DatumPdfSupport;
    try {
      support = await load;
    } catch (error) {
      // A load that failed (a chunk that 404ed for a moment) is forgotten, so the next request asks again.
      if (this.pdfLoad === load) {
        this.pdfLoad = undefined;
      }
      // A module that is not there is told to the page as `datum-error`, as the
      // WebAuthn and server-validator chunks are; the caller still gets the rejection.
      this.reportChunkLoadFailure(error);
      throw error;
    }
    if (!this.pdfSupportValue) {
      this.pdfSupportValue = support;
      this.applyPdfSupport();
    }
    return this.pdfSupportValue;
  }

  private applyValues(): void {
    const runtime = this.runtimeValue;
    if (!runtime) {
      return;
    }
    this.valuesAssigned = false;
    if (!this.valuesValue) {
      return;
    }
    for (const { path, error } of runtime.setValues(this.valuesValue)) {
      reportError(this, "values.invalid", `Could not set the initial value of "${path}"`, error);
    }
  }

  private applyLocale(): void {
    const runtime = this.runtimeValue;
    const requested = this.localeValue;
    if (!runtime || !requested) {
      return;
    }
    if (!this.allows("translations")) {
      this.ignoreLeftOut("translations", "the locale setting");
      return;
    }
    const target = this.negotiatedLocale(requested);
    if (target === undefined || runtime.state().locale === target) {
      return;
    }
    try {
      runtime.setLocale(target);
    } catch (error) {
      reportError(this, "locale.switch-failed", `Could not switch to locale "${requested}"`, error);
      return;
    }
    // The attribute path says what it negotiated to, as the switcher does (the renderer's own
    // event is not re-used: its listener would overwrite the requested value with the result).
    this.dispatchEvent(new CustomEvent("datum-locale-applied", { detail: { locale: target }, bubbles: true, composed: true }));
  }

  /**
   * The locale the `locale` attribute means for this form: negotiated against the form's
   * `supportedLocales` (case, "_", then region fall-back, then the default), with "auto"
   * asking for the visitor's `navigator.languages`. A form that declares none accepts the
   * value as written ("auto": the visitor's first language). `setLocale` stays strict.
   */
  private negotiatedLocale(requested: string): string | undefined {
    const localization = this.definitionValue?.localization;
    const supported = supportedLocaleCodes(localization);
    let asked: string | string[] = requested;
    if (requested.trim().toLowerCase() === "auto") {
      const nav = typeof navigator === "undefined" ? undefined : navigator;
      const languages = nav?.languages?.length ? [...nav.languages] : nav?.language ? [nav.language] : [];
      if (supported.length === 0) {
        return languages[0];
      }
      asked = languages;
    } else if (supported.length === 0) {
      return requested;
    }
    // A request nothing matches with no default declared reads as the form's first language,
    // rather than leaving the runtime on whatever it showed before.
    return negotiateLocale(asked, supported, declaredDefaultLocale(localization)) ?? supported[0];
  }

  // --- journeys --------------------------------------------------

  /** The way to the service a journey's checks take: the page's function, else one posting to `validate-url`. */
  private effectiveServerValidator(): JourneyServerValidator | undefined {
    if (!this.allows("server-validation")) {
      if (this.serverValidatorValue || this.validateUrlValue !== undefined) {
        this.ignoreLeftOut("server-validation", "the serverValidator and validate-url settings");
      }
      return undefined;
    }
    if (this.serverValidatorValue) {
      return this.serverValidatorValue;
    }
    const url = this.validateUrlValue;
    // Only journey checks use the validator, so without journeys its chunk is never requested.
    if (url === undefined || !this.allows("journeys")) {
      return undefined;
    }
    if (this.fetchValidator?.url !== url) {
      // The code behind the validator is a lazy chunk: asked for now that `validate-url`
      // is applied, so the first check does not wait for it; a check made before it has arrived
      // waits, and a load that failed is the check's failure to report, not an unhandled one here.
      loadServerValidator().catch((error: unknown) => this.reportChunkLoadFailure(error));
      const fetchValidator = createFetchJourneyValidator(url);
      // A check made while the chunk is missing is the journey's unavailable-server case (it blocks
      // by default); the page also hears why, as `datum-error`.
      const validator: JourneyServerValidator = async (request, call) => {
        try {
          return await fetchValidator(request, call);
        } catch (error) {
          this.reportChunkLoadFailure(error);
          throw error;
        }
      };
      this.fetchValidator = { url, validator };
    }
    return this.fetchValidator.validator;
  }

  /** A lazy chunk that did not arrive is told to the page as `datum-error`; any other error is not this method's. */
  private reportChunkLoadFailure(error: unknown): void {
    if (isChunkLoadError(error)) {
      reportError(this, "file.unavailable", error.message, (error as { cause?: unknown }).cause);
    }
  }

  /**
   * A signing provider whose failures to load its code are reported: the page's own
   * provider is called as it was, and a `ChunkLoadError` out of it (the WebAuthn wrapper's
   * chunk missing) is told to the page as `datum-error` before the signature fails as it did.
   */
  private reportingProvider(provider: SigningProvider | undefined): SigningProvider | undefined {
    if (!provider) {
      return undefined;
    }
    // Getters that read through the original, not Object.create(provider): a provider whose `id`
    // is a getter over a #private field throws when `this` is the wrapper. Own and prototype
    // properties are both visible; `sign` is called with the provider as `this`.
    const wrapper = {} as SigningProvider;
    const names = new Set<string>();
    for (let at: object | null = provider; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
      Object.getOwnPropertyNames(at).forEach((name) => names.add(name));
    }
    names.delete("constructor");
    names.delete("sign");
    for (const name of names) {
      Object.defineProperty(wrapper, name, {
        enumerable: true,
        get: () => {
          const value = (provider as unknown as Record<string, unknown>)[name];
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(provider) : value;
        }
      });
    }
    Object.defineProperty(wrapper, "sign", {
      enumerable: true,
      value: async (request: Parameters<SigningProvider["sign"]>[0]) => {
        try {
          return await provider.sign(request);
        } catch (error) {
          this.reportChunkLoadFailure(error);
          throw error;
        }
      }
    });
    return wrapper;
  }

  private applyServerValidator(): void {
    this.runtimeValue?.setJourneyServerValidator(this.effectiveServerValidator());
  }

  /**
   * Takes up a new `journey` on the running form: the journey it names starts over the answers
   * already typed (on `page`, when the person may reach it), `"form"` leaves the journey for
   * the whole form, and the journey already running is left as it is. What the definition
   * decides when the page names nothing, or names a journey the form does not have, is worked
   * out as the runtime works it out when it is built. It also starts the journey on a runtime
   * the element has just built as the whole form, over the prefill. `true` when a journey
   * started or was left; a journey with no page to show for the answers is remembered, and
   * tried again when new `values` land.
   */
  private applyJourney(): boolean {
    const runtime = this.runtimeValue;
    if (!runtime) {
      return false;
    }
    // The list leaves journeys out: the runtime was built as the whole form and stays one; a
    // definition that has journeys, or a `journey` or `page` the page set, is ignored with one warning.
    if (!this.allows("journeys")) {
      // Asked of the definition itself: the runtime here is built with the Noop engine and lists no journeys.
      if ((this.definition !== undefined && readJourneys(this.definition).length > 0) || (this.journeyValue !== undefined && this.journeyValue !== "form") || this.pageValue !== undefined) {
        this.ignoreLeftOut("journeys", "the definition's journeys and the journey and page settings");
      }
      this.journeyAwaitingAnswers = false;
      return false;
    }
    const opening = resolveJourneySelection({ journey: runtime.journeyConfiguration() }, this.journeyValue);
    if (opening.unknownJourneyId !== undefined && opening.unknownJourneyId !== this.warnedJourneyId) {
      this.warnedJourneyId = opening.unknownJourneyId;
      console.warn(
        `[${this.tagName.toLowerCase()}] The form has no journey "${opening.unknownJourneyId}": ${
          opening.selection.kind === "journey" ? `opening its journey "${opening.selection.journeyId}" instead` : "opening the whole form instead"
        }.`
      );
    }
    const running = runtime.journeyView()?.journeyId;
    if (opening.selection.kind === "form") {
      this.journeyAwaitingAnswers = false;
      if (running === undefined) {
        return false;
      }
      runtime.leaveJourney();
      return true;
    }
    if (running === opening.selection.journeyId) {
      this.journeyAwaitingAnswers = false;
      return false;
    }
    const started = runtime.startJourney(opening.selection.journeyId, this.pageValue !== undefined ? { pageId: this.pageValue } : {});
    this.journeyAwaitingAnswers = !started.ok && started.reason === "unreachable";
    this.redirectedFromStart = started.ok && this.pageValue !== undefined && started.pageId !== this.pageValue;
    return started.ok;
  }

  /** Takes the running journey to `page`, as a jump the runtime allows only to a page already reached. */
  private applyPage(): void {
    if (!this.allows("journeys")) {
      return;
    }
    const runtime = this.runtimeValue;
    const pageId = this.pageValue;
    const view = runtime?.journeyView();
    if (!runtime || pageId === undefined || !view || view.pageId === pageId) {
      return;
    }
    void runtime
      .goToPage(pageId)
      .then((result) => {
        if (!result.ok && result.reason === "unreachable") {
          this.reportRedirect(runtime, view.pageId);
        }
      })
      .catch((error: unknown) => {
        reportError(this, "journey.page-failed", `Could not open the journey's page "${pageId}"`, error);
      });
  }

  /** A refused `page`: the page the person is on says so (muted, polite) until the next move, and `datum-page-change` reports the `"redirect"`. */
  private reportRedirect(runtime: FormRuntime, fromPageId: string | null): void {
    const view = runtime.journeyView();
    if (!view || this.runtimeValue !== runtime) {
      return;
    }
    if (this.rendererEl) {
      this.rendererEl.pageRedirected = true;
    }
    this.emitPageChange(runtime, {
      journeyId: view.journeyId,
      fromPageId,
      toPageId: view.pageId,
      direction: "redirect",
      index: view.index,
      total: view.path.length
    });
  }

  /** `datum-page-change` for a move the runtime made, worded as the page it opened is drawn. */
  private emitPageChange(runtime: FormRuntime, data: Omit<PageChangedEventData, "direction"> & { direction: PageChangeDirection | "redirect" }): void {
    const view = runtime.journeyView();
    const state = runtime.state();
    // Through the kit the runtime was built with: only a journey form moves, and its kit is the loaded one.
    const kit = this.journeyKit;
    const meta =
      view && view.pageId === data.toPageId
        ? // A page holding nodes of its own is drawn from the combined root.
          kit.buildMeta(runtime.journeyRenderRoot()?.root ?? runtime.formRoot(), view, {
            locale: state.locale,
            translations: runtime.translations(),
            translationCatalog: runtime.translationCatalog(),
            effectiveStates: runtime.effectiveStatesMap()
          })
        : undefined;
    emit<DatumFormPageChangeDetail>(this, "datum-page-change", {
      journeyId: data.journeyId,
      pageId: data.toPageId,
      fromPageId: data.fromPageId,
      direction: data.direction,
      index: data.index,
      total: data.total,
      title: meta?.title ?? data.toPageId,
      kind: meta?.kind ?? "questions",
      // As the page shows them: a form field's moved onto the node standing for it, once.
      errorCount: kit.pageErrors(runtime.errors(), view?.hosts).filter(isBlocking).length,
      ...(data.returnPageId !== undefined ? { returnPageId: data.returnPageId } : {})
    });
  }

  /** Saves the draft now, not after the typing debounce: a page change is where a person leaves off. */
  private saveDraftNow(runtime: FormRuntime): void {
    const key = this.draftKeyValue;
    if (!this.activeDraftStore || !key) {
      return;
    }
    void this.saveDraftOf(runtime, key).catch((error: unknown) => {
      reportError(this, "draft.save-failed", "Autosave failed", error);
    });
  }

  /**
   * The save `saveDraft()` and a page change make: the
   * autosave's pending timer cleared, so one save goes out and not two, what is still being typed
   * reported first, then the draft saved.
   */
  private saveDraftOf(runtime: FormRuntime, key: string): Promise<FormDraftSummary> {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    this.flushPendingChanges(runtime);
    return runtime.saveDraft(key);
  }

  private bindRuntime(runtime: FormRuntime): void {
    this.unbindRuntime();
    // A final write (a pick, a value the page set) is reported as it lands. An interim one
    // (a keystroke) waits: for the debounce or the field being left in input mode, for the
    // field being left alone in commit mode. Autosave sees every write.
    this.unsub.push(
      runtime.events().subscribe("COMPONENT_CHANGED", (event) => {
        const data = event.data as { value?: unknown; interim?: boolean } | undefined;
        const path = changedPathOf(event);
        const interim = data?.interim === true;
        // Any write may move a worked-out value — an own field it reads, an alias's form
        // field, a form answer that hides one of its sources — once the runtime has worked it out:
        // what each holds now is compared after the recompute this write sets off.
        const values = runtime.state().values;
        this.lastWrite = {
          interim,
          before: new Map((runtime.presentationIndex()?.workedOut ?? []).map(({ targetPath }) => [targetPath, ownValue(values, targetPath)]))
        };
        // A presentation's own answer is not reported.
        if (!this.isOwnKey(runtime, path)) {
          this.reportChange(runtime, path, data?.value, interim);
        }
        this.scheduleAutosave(runtime);
      }),
      runtime.events().subscribe("RECOMPUTE_COMPLETED", () => {
        const write = this.lastWrite;
        if (!write) {
          return;
        }
        this.lastWrite = undefined;
        const values = runtime.state().values;
        for (const [target, before] of write.before) {
          const now = ownValue(values, target);
          if (!sameAnswer(before, now)) {
            this.reportChange(runtime, target, now, write.interim);
          }
        }
      })
    );
    this.unsub.push(
      runtime.events().subscribe("COMPONENT_COMMITTED", (event) => {
        // A field left: what it moved while typed in, worked-out values too, is settled with it.
        this.reportPendingChange(runtime, changedPathOf(event));
        for (const { targetPath } of runtime.presentationIndex()?.workedOut ?? []) {
          this.reportPendingChange(runtime, targetPath);
        }
      })
    );
    // A journey's move to another page: reported to the page, and saved, so a
    // reload resumes on the page the person reached.
    this.unsub.push(
      runtime.events().subscribe("PAGE_CHANGED", (event) => {
        const data = event.data as PageChangedEventData | undefined;
        if (!data || typeof data.toPageId !== "string") {
          return;
        }
        // What was typed on the page being left is reported before the move is,
        // and before the draft that holds it is saved.
        this.flushPendingChanges(runtime);
        this.emitPageChange(runtime, data);
        // A draft being restored is what is stored already.
        if (data.direction !== "resume") {
          this.saveDraftNow(runtime);
        }
      })
    );
    // The sandbox's exchange, run log included, for a page that shows or forwards it.
    this.unsub.push(
      runtime.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => {
        const data = (event.data ?? {}) as Partial<{
          blocked: boolean;
          durationMs: number;
          unknownFields: string;
          logLevel: WasmLogLevel;
          requestValues: Record<string, unknown>;
          externalData: Record<string, unknown>;
          response: WasmSubmissionOutcome;
          executionError: string;
        }>;
        emit<DatumFormWasmValidatedDetail>(this, "datum-wasm-validated", {
          blocked: data.blocked === true,
          durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
          unknownFields: data.unknownFields ?? "strip",
          ...(data.logLevel !== undefined ? { logLevel: data.logLevel } : {}),
          values: data.requestValues ?? {},
          ...(data.externalData !== undefined ? { externalData: data.externalData } : {}),
          ...(data.response !== undefined ? { outcome: data.response } : {}),
          ...(data.executionError !== undefined ? { executionError: data.executionError } : {}),
          logs: data.response?.logs ?? []
        });
      })
    );
  }

  private unbindRuntime(): void {
    for (const off of this.unsub) {
      off();
    }
    this.unsub = [];
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    // Dropped, not reported: the runtime these belong to is going (a rebuild discards its
    // values), the way the autosave above is dropped.
    for (const path of [...this.pendingChanges.keys()]) {
      this.dropPendingChange(path);
    }
    this.lastWrite = undefined;
  }

  /** A form value written: reported at once when final, held until it settles when typed in. */
  private reportChange(runtime: FormRuntime, path: string, value: unknown, interim: boolean): void {
    if (!interim || (this.changeOnValue === "input" && this.changeDebounceValue === 0)) {
      this.dropPendingChange(path);
      this.emitChange(runtime, path, value);
    } else {
      this.holdChange(runtime, path);
    }
  }

  /**
   * Whether `path` is a presentation's own answer — a key starting with `@` that the
   * form does not define — which `datum-change` never reports.
   */
  private isOwnKey(runtime: FormRuntime, path: string): boolean {
    if (!path.startsWith("@")) {
      return false;
    }
    const presentation = runtime.presentationIndex();
    // With none running, an own answer of one no longer running (a draft's): never the form's.
    return presentation ? presentation.isPresentationKey(path) : !Object.prototype.hasOwnProperty.call(runtime.formValues(), path);
  }

  private emitChange(runtime: FormRuntime, path: string, value: unknown): void {
    emit<DatumFormChangeDetail>(this, "datum-change", {
      path: path === "" ? undefined : path,
      value,
      // The form's answers alone: a presentation's own stay in the browser.
      values: runtime.formValues()
    });
  }

  /** Keeps an interim write for later: the latest value per path, and in input mode a fresh debounce. */
  private holdChange(runtime: FormRuntime, path: string): void {
    const pending = this.pendingChanges.get(path);
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    } else {
      this.pendingChanges.set(path, {});
    }
    if (this.changeOnValue === "input") {
      this.pendingChanges.get(path)!.timer = setTimeout(() => {
        this.reportPendingChange(runtime, path);
      }, this.changeDebounceValue);
    }
  }

  /**
   * Reports the pending change for `path`, if there is one, with the value the form holds now: a
   * write that reports nothing (a restored draft) may have replaced the one typed meanwhile, and
   * the page must never hear a value the form no longer has.
   */
  private reportPendingChange(runtime: FormRuntime, path: string): void {
    const pending = this.pendingChanges.get(path);
    if (!pending) {
      return;
    }
    this.dropPendingChange(path);
    this.emitChange(runtime, path, ownValue(runtime.state().values, path));
  }

  private dropPendingChange(path: string): void {
    const pending = this.pendingChanges.get(path);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingChanges.delete(path);
    }
  }

  /** Reports every pending change, in the order the fields were typed in. */
  private flushPendingChanges(runtime: FormRuntime): void {
    for (const path of [...this.pendingChanges.keys()]) {
      this.reportPendingChange(runtime, path);
    }
  }

  private scheduleAutosave(runtime: FormRuntime): void {
    const key = this.draftKeyValue;
    if (!this.activeDraftStore || !key) {
      return;
    }
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      void runtime.saveDraft(key).catch((error: unknown) => {
        reportError(this, "draft.save-failed", "Autosave failed", error);
      });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * The store the `draft` key saves to: the page's `draftStore` object, else the one the
   * `draft-store` attribute names, else the browser's storage; none without a key, or when the
   * list leaves drafts out.
   */
  private chosenDraftStore(): DraftStore | undefined {
    if (!this.draftKeyValue && this.draftStoreValue === undefined && this.draftStoreSpec === undefined) {
      return undefined;
    }
    if (!this.allows("drafts")) {
      this.ignoreLeftOut("drafts", "the draft, draft-store and draftStore settings");
      return undefined;
    }
    if (!this.draftKeyValue) {
      return undefined;
    }
    if (this.draftStoreValue) {
      return this.draftStoreValue;
    }
    return this.draftStoreSpec?.kind === "server"
      ? createUrlDraftStore(this.draftStoreSpec.url)
      : new BrowserLocalDraftStore(resolveStorage(), DRAFT_STORE_PREFIX);
  }

  /** Whether the page's data sources (and the plugins') reach the form; asking for them while left out is warned about once. */
  private allowsDataSources(): boolean {
    if (this.allows("data-sources")) {
      return true;
    }
    if (this.dataSourcesValue !== undefined || withPluginDataSources(undefined, this.allPlugins()) !== undefined) {
      this.ignoreLeftOut("data-sources", "the dataSources setting and the plugins' data sources");
    }
    return false;
  }

  /**
   * With `data-sources` left out, a source the definition names answers an empty list (one warning)
   * rather than the runtime's "not configured" error, which would be a datum-error and an
   * inline note for something the page chose to leave out. Undefined when the feature is allowed.
   */
  private ignoredDataSources(): DataSourceSet | undefined {
    if (this.allows("data-sources")) {
      return undefined;
    }
    // A DataSourceSet (not a bare runtime): `has` claims every id so the stub, not the runtime's
    // own "not configured" error, answers; `ids` is empty because it holds no real source.
    return {
      has: () => true,
      ids: () => [],
      load: async () => {
        this.ignoreLeftOut("data-sources", "the data sources the definition names");
        return { items: [] };
      }
    };
  }

  /** Whether signing is there; a signing setting made while it is left out (`used` says this very call made one) is warned about once. */
  private allowsSigning(asked: string, used = false): boolean {
    if (this.allows("signing")) {
      return true;
    }
    if (
      used ||
      this.signingProviderValue !== undefined ||
      this.signingProvidersValue !== undefined ||
      this.signingValue !== undefined ||
      this.signWithValue !== null ||
      this.pdfSignerValue !== undefined
    ) {
      this.ignoreLeftOut("signing", `the signing settings (${asked})`);
    }
    return false;
  }

  /** Throws for a journey method when the list leaves journeys out. */
  private requireJourneys(what: string): void {
    if (!this.allows("journeys")) {
      throw this.leftOut("journeys", what);
    }
  }

  /** A chrome with every language switcher part taken out, groups included, and the form author's own switcher off. */
  private withoutLanguageSwitchers(chrome: FormChromeConfiguration | undefined): FormChromeConfiguration {
    const strip = (parts: FormChromeConfiguration["header"]): FormChromeConfiguration["header"] =>
      parts
        ?.filter((part) => part.type !== "language-switcher")
        .map((part) => (part.type === "group" ? { ...part, parts: strip(part.parts) ?? [] } : part));
    const header = strip(chrome?.header);
    const footer = strip(chrome?.footer);
    return {
      ...chrome,
      ...(header ? { header } : {}),
      ...(footer ? { footer } : {}),
      formLanguageSwitcher: false
    };
  }

  private loadSrc(url: string): void {
    const token = ++this.srcToken;
    this.srcLoading = true;
    // A new address: the card of the last one goes, and the placeholder says the form is on its way.
    this.clearDefinitionFailure();
    fetchJson(url, () => this.maxDefinitionBytesValue).then(
      (json) => {
        if (token !== this.srcToken) {
          return;
        }
        this.srcLoading = false;
        try {
          // A shape it refuses is reported (and carded) by takeDefinition itself.
          this.takeDefinition(toFormDefinition(json));
        } catch (error) {
          reportError(this, "definition.invalid", `The form definition at ${url} is not usable`, error);
          this.showDefinitionUnavailable();
          // Told to whoever awaits `ready` too: no definition will follow from this fetch.
          this.settleReady({ error });
        }
      },
      (error: unknown) => {
        if (token === this.srcToken) {
          this.srcLoading = false;
          reportError(this, codeOf(error, "definition.load"), `Could not load the form definition from ${url}: ${error instanceof Error ? error.message : String(error)}`, error);
          this.showDefinitionUnavailable();
          this.settleReady({ error });
        }
      }
    );
  }

  private requireRuntime(): FormRuntime {
    if (!this.runtimeValue) {
      // A journey form whose runtime did not arrive: that is why there is no form.
      if (this.journeysFailure) {
        throw this.journeysFailure;
      }
      throw new Error("<datum-form> has no form yet: set `definition` (or `src`) first");
    }
    return this.runtimeValue;
  }

  /**
   * The runtime, for a method that answers synchronously and so cannot wait for the form's
   * runtime: it throws while a build is pending, even over the form it will replace.
   */
  private requireBuiltRuntime(): FormRuntime {
    if (this.buildGate) {
      throw new Error("<datum-form> has no form yet: the form is still building; call this after datum-ready (or await `ready`)");
    }
    return this.requireRuntime();
  }

  private requireDraft(): { store: DraftStore; key: string } {
    if (!this.allows("drafts")) {
      throw this.leftOut("drafts", "Drafts");
    }
    if (!this.activeDraftStore || !this.draftKeyValue) {
      throw new Error("<datum-form> has no draft key: set the `draft` attribute first");
    }
    return { store: this.activeDraftStore, key: this.draftKeyValue };
  }
}

export function defineDatumFormElement(): void {
  defineDatumFormRendererElement();
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_FORM_TAG)) {
    customElements.define(DATUM_FORM_TAG, DatumFormElement);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [DATUM_FORM_TAG]: DatumFormElement;
  }
}
