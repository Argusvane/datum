import type { JourneyServerUnavailable } from "../../../core/schema/journey.js";
import type {
  JourneyBlockReason,
  JourneyServerValidator,
  JourneyTrace,
  JourneyValidationRequest
} from "../../../core/journey/journey-types.js";
import {
  FormEventType,
  type JourneyCheckCompletedEventData,
  type JourneyCheckEventData,
  type JourneyCheckOutcome,
  type JourneyCheckUnavailableReason
} from "../../../core/events/event-types.js";
import type { FormError } from "../../../core/errors/form-error.js";
import type { ActiveJourney, JourneyChecks, JourneyChecksHost, JourneyEndRefusal } from "../journey-engine.js";

/** A check out at the host's server. */
interface PendingServerCheck {
  scope: "page" | "journey";
  pageId?: string;
  key: string;
  controller: AbortController;
  /**
   * Made while submitting — the journey's end check, or the final page's check in its place.
   * Nothing calls it off: the submit works on a snapshot, and the page cannot change under it.
   */
  inSubmit: boolean;
  /** Why it was called off, once it was: a page change, or answers changed under it. */
  ended?: "cancelled" | "stale";
  /** The runtime's time limit ran out. */
  timedOut: boolean;
}

/** What a check against the host's server came back with. */
interface ServerCheckResult {
  outcome: JourneyCheckOutcome;
  /** The server's findings as the form stores them — a page's kept to the page — warnings included. */
  errors: FormError[];
  status?: number;
  reason?: JourneyCheckUnavailableReason;
}

/** The form-level error a journey shows when the host's server could not be reached. Worded by the message catalogs alone. */
const SERVER_UNAVAILABLE_CODE = "journey.server-unavailable";

/** Absent `journeyServerValidationTimeoutMs`: ten seconds. */
const DEFAULT_SERVER_CHECK_TIMEOUT_MS = 10000;

/**
 * Whether an error blocks: any severity but `warning` and `info`. The runtime's own rule
 * (`isBlocking` in form-runtime.ts), spelt again because this module loads with the engine and
 * the runtime must not import it.
 */
function isBlocking(error: { severity?: string | undefined }): boolean {
  return error.severity !== "warning" && error.severity !== "info";
}

/**
 * `work`, or a rejection as soon as `signal` aborts — so a check called off or timed out ends
 * at once, whether or not the host's validator listens to the signal.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("The check was called off."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * A journey's checks against the host's server, bound to one runtime. They sit behind the
 * engine so they load with the engine and stay out of the renderer entry. The runtime keeps the
 * error store, the event bus and the submit; this class holds the check's own bookkeeping — the
 * check out, what the server passed and warned about, the validator, what the console has said.
 */
export class JourneyServerChecker implements JourneyChecks {
  /** A check out at the host's server, while it is out. */
  private pendingCheck: PendingServerCheck | undefined;
  /**
   * Page id -> the key of the last request the host's server passed clean, so Continue skips
   * a round trip for exactly that request. In memory only, never in a draft; a
   * journey's end check is never remembered, since the service's hooks read its own state.
   */
  private readonly cleanPageChecks = new Map<string, string>();
  /** Page id -> the key of the last request that came back with warnings only: Continue with it again goes on. */
  private readonly warnedPageChecks = new Map<string, string>();
  /** See `FormRuntimeDependencies.journeyServerValidator`; replaced by {@link setValidator}. */
  private validator: JourneyServerValidator | undefined;
  private readonly timeoutMs: number;
  /** The console has said once that a journey asks for checks and no validator is set. */
  private missingValidatorReported = false;

  constructor(private readonly host: JourneyChecksHost) {
    this.validator = host.validator;
    const timeout = host.timeoutMs;
    this.timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_SERVER_CHECK_TIMEOUT_MS;
  }

  public pending(): { readonly inSubmit: boolean } | undefined {
    return this.pendingCheck;
  }

  /**
   * Replaces the host's way to its server without rebuilding the runtime and losing
   * what has been typed. What the old one passed is forgotten; a check already out finishes with
   * it. `undefined` removes it, and a check the journey asks for then counts as unavailable.
   */
  public setValidator(validator?: JourneyServerValidator): void {
    this.validator = validator;
    this.forget();
  }

  /** What the host's server is asked to check: submittable answers, never a path. */
  private journeyRequest(
    journeyId: string,
    scope: "page" | "journey",
    values: Record<string, unknown>,
    options: { pageId?: string | undefined; formVersion?: string } = {}
  ): JourneyValidationRequest {
    const request: JourneyValidationRequest = {
      formId: this.host.formId,
      formVersion: options.formVersion ?? this.host.formVersion(),
      journeyId,
      scope,
      values,
      locale: this.host.locale()
    };
    if (options.pageId !== undefined) {
      request.pageId = options.pageId;
    }
    return request;
  }

  /**
   * Continue's check against the host's server, over every submittable answer as the page
   * stands. `undefined` when the page may be left: the server found nothing, or passed exactly
   * this request before, or the person has seen its warnings about these answers, or it could
   * not be reached (or answered with no verdict, a 4xx included) and the page says to carry on.
   * Otherwise why not.
   */
  public async checkPage(
    active: ActiveJourney,
    pageId: string,
    onUnavailable: JourneyServerUnavailable
  ): Promise<JourneyBlockReason | undefined> {
    if (this.host.previewed) {
      return undefined;
    }
    const request = this.journeyRequest(active.journey.id, "page", this.host.effectiveValues(), { pageId });
    const key = this.host.engine.serverCheck.key(request);
    if (this.cleanPageChecks.get(pageId) === key || this.warnedPageChecks.get(pageId) === key) {
      return undefined;
    }
    const members = this.host.pageComponents(pageId);
    const result = await this.askServer(request, key, { inSubmit: false, members, onUnavailable });
    switch (result.outcome) {
      case "cancelled":
      case "stale":
        return result.outcome;
      case "unavailable":
        if (onUnavailable === "continue") {
          return undefined;
        }
        this.host.showPageUnavailable(this.unavailableError(result, "page", pageId, `journey_page_${pageId}_unavailable`));
        return "server-unavailable";
      case "invalid":
        this.host.storePageCheck(members, result.errors);
        return "server";
      case "warnings":
        // Shown once: Continue again with the same answers goes on.
        this.host.storePageCheck(members, result.errors);
        this.warnedPageChecks.set(pageId, key);
        return "warnings";
      case "clean":
        this.host.storePageCheck(members, []);
        this.cleanPageChecks.set(pageId, key);
        return undefined;
    }
  }

  /**
   * One round trip to the host's server, announced: `JOURNEY_CHECK_STARTED`, then always
   * `JOURNEY_CHECK_COMPLETED` with the outcome. While it is out the journey view says so
   * (`pending`). A page's check is called off by a page change (`"cancelled"`) or by changed
   * answers (`"stale"`); every check by the time limit. The reply is read tolerantly
   * (`normalizeValidationReply`) and, for a page, kept to the page's components and the
   * entries naming none. An outage, any status that is no verdict included, is reported
   * through the event alone. Missing wiring is the host's, and the console says so once.
   */
  private async askServer(
    request: JourneyValidationRequest,
    key: string,
    options: { inSubmit: boolean; members?: ReadonlySet<string>; onUnavailable: JourneyServerUnavailable }
  ): Promise<ServerCheckResult> {
    this.callOff("cancelled");
    const check: PendingServerCheck = {
      scope: request.scope,
      key,
      controller: new AbortController(),
      inSubmit: options.inSubmit,
      timedOut: false,
      ...(request.pageId !== undefined ? { pageId: request.pageId } : {})
    };
    this.pendingCheck = check;
    const about: JourneyCheckEventData = {
      journeyId: request.journeyId,
      scope: request.scope,
      ...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
      key
    };
    const startedAt = Date.now();
    this.host.eventBus.publish({
      id: `journey_check_started_${request.pageId ?? request.scope}`,
      type: FormEventType.JOURNEY_CHECK_STARTED,
      timestamp: startedAt,
      source: "validation",
      formId: this.host.formId,
      data: about
    });

    // Whatever happens below, the check ends: a check left pending holds the page (or, made
    // while submitting, the whole journey) until a reload.
    let result: ServerCheckResult = { outcome: "unavailable", reason: "malformed", errors: [] };
    try {
      const validator = this.validator;
      if (!validator) {
        this.reportMissingValidator(request.journeyId);
        result = { outcome: "unavailable", reason: "missing", errors: [] };
      } else {
        const limit = this.timeoutMs;
        const timer =
          limit > 0
            ? setTimeout(() => {
                check.timedOut = true;
                check.controller.abort();
              }, limit)
            : undefined;
        let reply: unknown;
        let failure: { error: unknown } | undefined;
        try {
          // Called inside an async function, so a validator that throws rather than rejects is read alike.
          // The envelope over the request's values, as Submit builds it, is what a Datum host takes.
          const asked = (async () => {
            const document = this.host.document?.(request);
            return validator(request, { signal: check.controller.signal, ...(document !== undefined ? { document } : {}) });
          })();
          reply = await raceAbort(asked, check.controller.signal);
        } catch (error) {
          failure = { error };
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
        try {
          result = this.readServerCheck(request, check, reply, failure, options.members);
        } catch {
          // A reply the runtime could not read is no verdict: malformed, so an
          // unavailable server's rule decides, as for any other reply that is not one.
          result = { outcome: "unavailable", reason: "malformed", errors: [] };
        }
      }
    } finally {
      if (this.pendingCheck === check) {
        this.pendingCheck = undefined;
      }
      this.publishCheckCompleted(request, about, startedAt, result, options.onUnavailable);
    }
    return result;
  }

  /** `JOURNEY_CHECK_COMPLETED` for a check that has ended, however it ended. */
  private publishCheckCompleted(
    request: JourneyValidationRequest,
    about: JourneyCheckEventData,
    startedAt: number,
    result: ServerCheckResult,
    onUnavailable: JourneyServerUnavailable
  ): void {
    const proceeded = result.outcome === "unavailable" && onUnavailable === "continue";
    const completed: JourneyCheckCompletedEventData = {
      ...about,
      outcome: result.outcome,
      errorCount: result.errors.length,
      blockingErrorCount: result.errors.filter(isBlocking).length,
      durationMs: Date.now() - startedAt,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(proceeded ? { proceeded: true } : {})
    };
    this.host.eventBus.publish({
      id: `journey_check_completed_${request.pageId ?? request.scope}`,
      type: FormEventType.JOURNEY_CHECK_COMPLETED,
      timestamp: Date.now(),
      source: "validation",
      formId: this.host.formId,
      data: completed
    });
  }

  /** What a settled check means: called off, stale, failed (classified), or the server's reply read. */
  private readServerCheck(
    request: JourneyValidationRequest,
    check: PendingServerCheck,
    reply: unknown,
    failure: { error: unknown } | undefined,
    members: ReadonlySet<string> | undefined
  ): ServerCheckResult {
    const kit = this.host.engine.serverCheck;
    if (check.ended !== undefined) {
      return { outcome: check.ended, errors: [] };
    }
    // Answers that changed with no keystroke — a locale switched — make another request.
    if (!check.inSubmit) {
      const now = this.journeyRequest(request.journeyId, request.scope, this.host.effectiveValues(), {
        pageId: request.pageId,
        formVersion: request.formVersion
      });
      if (kit.key(now) !== check.key) {
        return { outcome: "stale", errors: [] };
      }
    }
    if (failure !== undefined) {
      const failed = kit.classifyFailure(failure.error, check.timedOut);
      return {
        outcome: "unavailable",
        reason: failed.reason,
        ...(failed.status !== undefined ? { status: failed.status } : {}),
        errors: []
      };
    }
    const reported = kit.normalizeReply(reply, (path) => this.host.componentIdForValuePath(path));
    if (reported === undefined) {
      return { outcome: "unavailable", reason: "malformed", errors: [] };
    }
    const kept = members !== undefined ? kit.scopeToPage(reported, members, (componentId) => this.host.hasComponent(componentId)) : reported;
    const errors = this.host.fromHostErrors(
      kept,
      request.scope === "page" ? `journey_page_${request.pageId ?? ""}_` : "journey_end_",
      "journey-server"
    );
    return { outcome: kit.outcomeOf(errors), errors };
  }

  /**
   * Calls off a page's check still out at the server — its verdict would be about a page no
   * longer shown (`"cancelled"`) or answers no longer given (`"stale"`) — and tells the
   * validator to stop. A check a submit made is left to finish: the submit judged a snapshot.
   */
  public callOff(why: "cancelled" | "stale"): void {
    const check = this.pendingCheck;
    if (!check || check.inSubmit) {
      return;
    }
    check.ended = why;
    this.pendingCheck = undefined;
    check.controller.abort();
  }

  /** Forgets what the host's server passed and warned about: a new journey, a new validator, a submission made. */
  public forget(): void {
    this.cleanPageChecks.clear();
    this.warnedPageChecks.clear();
  }

  /**
   * The form-level error a journey shows when it could not check the answers with the host's
   * server. Worded by the message catalogs alone (`DEFAULT_VALIDATION_MESSAGES`, a theme's, the
   * host's), never here; its parameters say which check and why.
   */
  private unavailableError(result: ServerCheckResult, scope: "page" | "journey", pageId: string | undefined, id: string): FormError {
    return {
      id,
      code: SERVER_UNAVAILABLE_CODE,
      stage: "journey",
      source: "client",
      severity: "error",
      parameters: {
        scope,
        ...(pageId !== undefined ? { pageId } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.status !== undefined ? { status: result.status } : {})
      }
    };
  }

  /** The console, once: a journey asks the host's server to check it, and the host set no way to. */
  private reportMissingValidator(journeyId: string): void {
    if (this.missingValidatorReported) {
      return;
    }
    this.missingValidatorReported = true;
    console.error(
      `[FormRuntime] Journey "${journeyId}" of form "${this.host.formId}" asks the host's server to check its answers, ` +
        "but no server validator is set, so every such check counts as the server being unavailable. " +
        "Set <datum-form>'s serverValidator property or its validate-url attribute " +
        "(FormRuntime: the journeyServerValidator dependency, or setJourneyServerValidator)."
    );
  }

  /**
   * The journey's check against the host's server at its end: after the browser's
   * validation and the sandbox, over the exact values the envelope will carry, before the
   * envelope is completed, signed or delivered — nobody is asked for a passkey for answers the
   * service will refuse. `validation.end: "server"` checks the whole journey, under the
   * journey's `onUnavailable`, and is never answered from memory: the service's hooks read its
   * own state. Otherwise a final page asking for the server (`server: true`, not deferred) is
   * checked here in its Continue's place, under its own `onUnavailable`. Skipped, silently,
   * for a download (`skip`) and for a builder's preview. Warnings do not stop a submit.
   * `undefined` when the submission may go on; else what refused it, for the submit to reject.
   */
  public async checkEnd(
    active: ActiveJourney | undefined,
    trace: JourneyTrace | undefined,
    values: Record<string, unknown>,
    formVersion: string,
    skip: boolean
  ): Promise<JourneyEndRefusal | undefined> {
    const engine = this.host.engine;
    if (!active || !trace || skip || this.host.previewed) {
      return undefined;
    }
    let pageId: string | undefined;
    let onUnavailable: JourneyServerUnavailable;
    if (engine.endValidation(active.journey) === "server") {
      onUnavailable = active.journey.validation?.onUnavailable ?? "block";
    } else {
      const finalPageId = trace.pages[trace.pages.length - 1];
      const finalPage = active.journey.pages.find((page) => page.id === finalPageId);
      if (finalPageId === undefined || !finalPage) {
        return undefined;
      }
      const resolved = engine.pageValidation(active.journey, finalPage);
      if (resolved.continue === "defer" || !resolved.server) {
        return undefined;
      }
      pageId = finalPageId;
      onUnavailable = resolved.onUnavailable;
    }

    const scope = pageId !== undefined ? "page" : "journey";
    const request = this.journeyRequest(active.journey.id, scope, values, { pageId, formVersion });
    const key = engine.serverCheck.key(request);
    if (pageId !== undefined && this.cleanPageChecks.get(pageId) === key) {
      return undefined;
    }
    const result = await this.askServer(request, key, {
      inSubmit: true,
      onUnavailable,
      ...(pageId !== undefined ? { members: this.host.pageComponents(pageId) } : {})
    });
    switch (result.outcome) {
      case "clean":
        if (pageId !== undefined) {
          this.cleanPageChecks.set(pageId, key);
        }
        return undefined;
      case "warnings":
        return undefined;
      case "unavailable":
        if (onUnavailable === "continue") {
          return undefined;
        }
        break;
      default:
        break;
    }
    const errors =
      result.outcome === "invalid"
        ? result.errors
        : [this.unavailableError(result, scope, pageId, "journey_end_unavailable")];
    this.host.rememberServerErrors(errors);
    return { errors, scope, outcome: result.outcome, ...(pageId !== undefined ? { pageId } : {}) };
  }
}
