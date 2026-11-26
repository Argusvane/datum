import type { JourneyBlockReason, PageChangeDirection } from "../journey/journey-types.js";
import type { FormulaProblem } from "../expressions/formula-types.js";

/**
 * Canonical event-type names published on the {@link EventBus}.
 *
 * Runtime, renderer, builder, and plugin code all reference these constants instead of
 * bare string literals so that event names have one authoritative definition and typos
 * surface at compile time.
 */
export const FormEventType = {
  // Lifecycle
  FORM_INITIALIZED: "FORM_INITIALIZED",
  PLUGINS_INITIALIZED: "PLUGINS_INITIALIZED",
  PLUGIN_INITIALIZE_FAILED: "PLUGIN_INITIALIZE_FAILED",
  PLUGIN_INCOMPATIBLE: "PLUGIN_INCOMPATIBLE",

  // Value / recompute
  /**
   * A value was written. `data.value` is what was stored; `data.interim` is `true` when the
   * control holding it is still being edited (a keystroke in a text field), in which case a
   * `COMPONENT_COMMITTED` follows once the control is left.
   */
  COMPONENT_CHANGED: "COMPONENT_CHANGED",
  /**
   * The control that was editing a value has been left, so what it holds is what the person
   * meant: `data.value` is the stored value. Only follows interim writes; a
   * select, a checkbox or an API write is final when it is made.
   */
  COMPONENT_COMMITTED: "COMPONENT_COMMITTED",
  RECOMPUTE_COMPLETED: "RECOMPUTE_COMPLETED",
  LOCALE_CHANGED: "LOCALE_CHANGED",
  DATA_SOURCE_RESOLVE_FAILED: "DATA_SOURCE_RESOLVE_FAILED",

  // Validation
  /** A validation run began: `data` is a {@link ValidationStartedEventData} (`paths` on a check of single value paths). */
  VALIDATION_STARTED: "VALIDATION_STARTED",
  /**
   * A validation run finished: `data` is a {@link ValidationCompletedEventData}. Not every
   * `VALIDATION_STARTED` gets one: a run whose stage threw publishes `VALIDATION_FAILED` instead, and nothing comes for a
   * check of single paths that was dropped (a newer check of the path replaced it, or its answer
   * was replaced some other way) — a listener that pairs the two goes by `paths`, never by order.
   */
  VALIDATION_COMPLETED: "VALIDATION_COMPLETED",
  /**
   * A validation run that published `VALIDATION_STARTED` threw (a stage, a hook) instead of
   * completing: `data` is a {@link ValidationFailedEventData}, with the same `paths` as its start.
   * Nothing was written. A listener that marks the form or a field busy on the start clears it
   * here; a check dropped as stale publishes neither this nor `VALIDATION_COMPLETED`.
   */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /**
   * A value path started or stopped being pending — an async stage that declares it began or
   * settled (`FormState.validation.pending`). `data` is a {@link ValidationPendingChangedEventData}.
   */
  VALIDATION_PENDING_CHANGED: "VALIDATION_PENDING_CHANGED",
  /**
   * One WASM sandbox run finished (successfully or fail-closed). `data` carries the
   * exchange: the request values and unknown-fields mode that crossed the ABI, the outcome
   * (error contract + sanitized values) or the execution error, whether it blocked the
   * submission, and the wall-clock duration — the observability hook for hosts that show
   * or meter sandbox validation. `response.logs` is the run log: what the
   * kernel's steps and the rules said, at the level the submit asked for.
   */
  WASM_VALIDATION_COMPLETED: "WASM_VALIDATION_COMPLETED",
  ERRORS_CHANGED: "ERRORS_CHANGED",

  // Navigation
  NAVIGATION_STARTED: "NAVIGATION_STARTED",
  NAVIGATION_COMPLETED: "NAVIGATION_COMPLETED",
  NAVIGATION_BLOCKED: "NAVIGATION_BLOCKED",

  // Journeys
  /** A journey started or ended: `data` is a {@link JourneyChangedEventData}. */
  JOURNEY_CHANGED: "JOURNEY_CHANGED",
  /** The journey moved to another page: `data` is a {@link PageChangedEventData}. */
  PAGE_CHANGED: "PAGE_CHANGED",
  /** A page change was refused — errors, a veto, a check still out: {@link PageBlockedEventData}. */
  PAGE_BLOCKED: "PAGE_BLOCKED",
  /**
   * A check of the answers went to the host's server: a page's on Continue (`scope: "page"`),
   * or the whole journey's when it is submitted (`scope: "journey"`). `data` is a
   * {@link JourneyCheckEventData}. `JOURNEY_CHECK_COMPLETED` always follows, with the same `key`.
   * A check the in-memory cache answers publishes neither.
   */
  JOURNEY_CHECK_STARTED: "JOURNEY_CHECK_STARTED",
  /** How a check against the host's server came out: `data` is a {@link JourneyCheckCompletedEventData}. */
  JOURNEY_CHECK_COMPLETED: "JOURNEY_CHECK_COMPLETED",

  // Drafts
  DRAFT_SAVED: "DRAFT_SAVED",
  DRAFT_LOADED: "DRAFT_LOADED",

  // Submission
  SUBMISSION_STARTED: "SUBMISSION_STARTED",
  SUBMISSION_COMPLETED: "SUBMISSION_COMPLETED",
  SUBMISSION_FAILED: "SUBMISSION_FAILED",
  SUBMISSION_BLOCKED_ENVELOPE: "SUBMISSION_BLOCKED_ENVELOPE",
  SUBMISSION_HANDLER_FAILED: "SUBMISSION_HANDLER_FAILED",

  // Collections
  COLLECTION_CHANGED: "COLLECTION_CHANGED",

  // Formulas
  /**
   * The definition holds a rule whose formula does not parse, or a scope a rule may not take,
   * and the runtime's `formulaErrors` policy is `"warn"`: each such rule reads as absent.
   * `data` is a {@link FormulaInvalidEventData}. Under `"fail"` the runtime refuses the
   * definition instead (`FormulaError`), the default.
   */
  FORMULA_INVALID: "FORMULA_INVALID",

  // PDF
  /**
   * A rendered PDF was signed through `renderFormPdf`. `data` says what was
   * signed and how — the layout, the field, the algorithm and profile, the certification
   * level, how many certificates, the digest, whether a timestamp was added — never the bytes,
   * the attributes or the signature value.
   */
  PDF_SIGNED: "PDF_SIGNED"
} as const;

export type FormEventType = (typeof FormEventType)[keyof typeof FormEventType];

/**
 * What a runtime's `setValue` accepts beside the value. `interim` marks a write
 * from a control still being edited — a keystroke in a text field — so that the
 * `COMPONENT_CHANGED` it publishes carries `data.interim: true` and a host reporting changes
 * can hold it until the `COMPONENT_COMMITTED` that follows when the control is left.
 */
export interface SetValueOptions {
  interim?: boolean;
}

/**
 * `VALIDATION_STARTED`. `paths` names the value paths a scoped check covers (a check of one
 * field as it is left); absent on a whole-form, step or page run, so a listener can tell the two
 * apart.
 */
export interface ValidationStartedEventData {
  paths?: string[];
}

/** `VALIDATION_COMPLETED`: what the run found, and the value paths it covered when scoped. */
export interface ValidationCompletedEventData {
  errorCount: number;
  paths?: string[];
}

/** `VALIDATION_FAILED`: why the run threw, and the value paths it covered when scoped. */
export interface ValidationFailedEventData {
  message: string;
  paths?: string[];
}

/** `VALIDATION_PENDING_CHANGED`: the path that changed and every path pending after the change. */
export interface ValidationPendingChangedEventData {
  path: string;
  pending: boolean;
  /** Every value path pending now. */
  paths: string[];
}

/** `JOURNEY_CHANGED`: which journey runs now (`null`: none, the whole form) and which ran before. */
export interface JourneyChangedEventData {
  journeyId: string | null;
  previousJourneyId: string | null;
}

/** `PAGE_CHANGED`: where the journey went, how, and where that page sits on the path. */
export interface PageChangedEventData {
  journeyId: string;
  /** `null` when the journey has just started. */
  fromPageId: string | null;
  toPageId: string;
  direction: PageChangeDirection;
  /** The page's position on the path, 0-based. */
  index: number;
  /** Pages on the path. */
  total: number;
  /**
   * The review page the person is on the way back to after a Change link (`JourneyState.returnTo`),
   * while that holds after the move: set by a `"change"` move and kept by Continue and Back until
   * they arrive there.
   */
  returnPageId?: string;
}

/** `PAGE_BLOCKED`: a page change that did not happen, and why. */
export interface PageBlockedEventData {
  journeyId: string;
  fromPageId: string;
  toPageId?: string;
  reason: JourneyBlockReason;
  /** A veto's message, when there is one. */
  message?: string;
}

/**
 * How a check against the host's server came out. The one outcome vocabulary for
 * every check a journey makes — a page's on Continue, the journey's at its end.
 */
export type JourneyCheckOutcome =
  /** The server found nothing. */
  | "clean"
  /** The server reported an error that blocks. */
  | "invalid"
  /**
   * The server reported only warnings (or notes). On Continue they stop the person once, so
   * they are seen; Continue again with the same answers goes on.
   */
  | "warnings"
  /**
   * No verdict: a timeout, a network failure, any status that is no verdict (a 4xx as much as
   * a 5xx), a reply that is not `{ errors: [...] }`, or no validator at all. `onUnavailable`
   * decides whether the journey goes on.
   */
  | "unavailable"
  /** The answers changed while the check was out: its verdict was about other answers, and is dropped. */
  | "stale"
  /** Back, a jump or leaving the journey called the check off while it was out. */
  | "cancelled";

/** Why a check came back `"unavailable"`. */
export type JourneyCheckUnavailableReason =
  /** No answer within `journeyServerValidationTimeoutMs`. */
  | "timeout"
  /** The validator rejected without an HTTP status: the server was not reached. */
  | "network"
  /**
   * The server answered with a status that is no verdict, a 4xx included: a wrong URL or a form
   * the server does not know is not told apart from an outage, so a misconfigured host holds
   * the journey as an outage would rather than wave the answers through.
   */
  | "server-error"
  /** The server's answer was not `{ errors: [...] }` with a `code` on every entry. */
  | "malformed"
  /** The journey asks for a check and the host set no validator. */
  | "missing";

/** `JOURNEY_CHECK_STARTED`, and the part of `JOURNEY_CHECK_COMPLETED` that says which check. */
export interface JourneyCheckEventData {
  journeyId: string;
  scope: "page" | "journey";
  /** The page checked, for `scope: "page"`. */
  pageId?: string;
  /** A hash of the whole request: what a clean page check is remembered by, and what pairs the two events. */
  key: string;
}

/** `JOURNEY_CHECK_COMPLETED`. */
export interface JourneyCheckCompletedEventData extends JourneyCheckEventData {
  outcome: JourneyCheckOutcome;
  /** What the server reported that the form kept (a page's reply is kept to the page), warnings included. */
  errorCount: number;
  /** Of those, the ones that block. */
  blockingErrorCount: number;
  durationMs: number;
  /** The HTTP status the validator's rejection carried, when it carried one. */
  status?: number;
  /** For `"unavailable"`: why. */
  reason?: JourneyCheckUnavailableReason;
  /** The journey went on without a verdict: an unreachable server under `onUnavailable: "continue"`, or a refusal. */
  proceeded?: boolean;
}

/** `FORMULA_INVALID`: the problems the definition's compile found, in document order. */
export interface FormulaInvalidEventData {
  problems: FormulaProblem[];
}
