import type { FormTranslations, TranslationCatalog } from "../../core/localization/translations.js";
import type { ComponentNode, ComponentRules } from "../../core/schema/types.js";
import type { ValidationContext, ValidationResult, ValidationStage } from "../../core/schema/contracts.js";
import type { FormError, HostError } from "../../core/errors/form-error.js";
import type { JourneyCheckOutcome } from "../../core/events/event-types.js";
import type { EventBus } from "../../core/events/event-bus.js";
import type { BeforePageChangeHookContext } from "../../core/events/hooks.js";
import type { Expression, FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { FormStateStore, FormValues, JourneyState } from "../../core/state/form-state.js";
import type { SemanticNodeState } from "../../core/state/effective-state.js";
import type { KernelFoldJourney, KernelFoldResult } from "../../core/state/submittable-fold.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import type { CanonicalSubmission } from "../../core/submission/canonical-submission.js";
import type { FormDraftJourney } from "../../persistence/core/draft-store.js";
import {
  resolveJourneySelection,
  journeyEndValidation,
  journeyPageValidation,
  type Journey,
  type JourneyConfiguration,
  type JourneyHostChoice,
  type JourneyPage,
  type JourneySelectionResult,
  type JourneyServerUnavailable,
  type ResolvedJourneyValidation
} from "../../core/schema/journey.js";
import type {
  JourneyBlockReason,
  JourneyNavigationResult,
  JourneyOwnership,
  JourneyServerValidator,
  JourneyTrace,
  JourneyValidationRequest,
  JourneyView,
  PageChangeDirection
} from "../../core/journey/journey-types.js";
import type { JourneyCheckFailure, JourneyPathResolver } from "../../core/journey/journey-server-check.js";
import type { PresentationIndex } from "../../core/journey/presentation.js";
import type {
  ComponentRuleKey,
  PresentationNodeState,
  RuntimeOrchestrator,
  SemanticResolutionContext
} from "./runtime-orchestrator.js";

/**
 * The seam between the form runtime and the journey machinery.
 *
 * `FormRuntime` keeps what a form is made of — the state store, the event bus, the hook runner
 * and the error store — and asks a `JourneyEngine` the questions that are pure over the
 * definition and the state: which journeys there are, what a journey owns, where the path
 * stands, whether a move still holds, what a server check is keyed by. The engine answers with
 * plans and never touches the runtime's state, so it can be tested without a runtime and loaded
 * on its own (the lazy chunk of) without the runtime changing.
 *
 * Two engines: {@link NoopJourneyEngine} (this module; no journeys, so a form is one page) and
 * the eager one (`journey-engine-eager.ts`; every journey function). This module is the part
 * the renderer entry carries, so it imports the journey modules for their types only — the one
 * value it takes is the shared readers of `core/schema/journey.ts`, which stay in the entry.
 *
 * The path, the placements, the ownership and the fold stay the kernel's, the same functions on
 * both sides: the engine hands them to the fold as input ({@link ActiveJourneyPlan.fold}),
 * it does not own or replace them.
 *
 * One member is not a pure answer: {@link JourneyEngine.navigation} binds a journey's moves to one
 * runtime ({@link JourneyNavigation}). The moves live with the engine, so they load with it; what
 * they change — the state store, the events, the hooks, the errors — stays the runtime's, reached
 * through the {@link JourneyRuntimeHost} the runtime hands over. So do a draft's journey, put
 * back and saved, and a page shown for an error. Likewise {@link JourneyEngine.checks} (the
 * host's server) and {@link JourneyEngine.presentationOverlay}: a running presentation's
 * worked-out values and overlay, bound to the orchestrator, beside its fold.
 */

/** What the runtime asks to start a journey, worked out once per journey object. */
export interface ActivateJourneyInput {
  /** The compiled form's root. */
  root: ComponentNode;
  journey: Journey;
  /** Whether the form defines a value key, so a journey's own keys are told apart from the form's. */
  definesKey: (key: string) => boolean;
  /** Evaluates a route's condition (form scope only: the runtime's, with its plugins' functions). */
  evaluate: KernelFoldJourney["evaluate"];
  /** The host's word on risky patterns, for the presentation's own field constraints. */
  riskyPatterns?: "refuse" | "allow" | undefined;
  /** The form's formula policy in force, for how those constraints judge a pattern they cannot run. */
  formulaErrors?: FormulaErrorPolicy | undefined;
}

/** A running journey with what is worked out from it once: the engine's answer to {@link JourneyEngine.activate}. */
export interface ActiveJourneyPlan {
  journey: Journey;
  ownership: JourneyOwnership;
  /** What the orchestrator's fold reads, with the path and placement functions it is given as input. */
  fold: KernelFoldJourney;
  /** The journey's own nodes; absent for a journey of component ids alone. */
  presentation?: PresentationIndex;
  /** The own fields' constraints as a stage, run after the pipeline; built with {@link presentation}. */
  ownStage?: ValidationStage;
}

/** The active journey with what the engine works out from it once ({@link ActiveJourneyPlan}). */
export interface ActiveJourney extends ActiveJourneyPlan {
  /** `FormRuntime.journeyRenderRoot`'s answer, built when first asked for. */
  renderRoot?: { root: ComponentNode; tree: ComponentTree };
}

/** What `beforePageChange` said about a move (the runtime runs the hooks): a hook vetoes by throwing. */
export type PageChangeHookOutcome = { vetoed: false } | { vetoed: true; message: string | undefined };

/**
 * What a runtime hands its journey's moves: the parts of the runtime they read and
 * change. The runtime keeps the state store, the event bus, the hook runner and the error store;
 * the moves reach them through this, never around it.
 */
export interface JourneyRuntimeHost {
  /** The engine the runtime was built with: every pure answer the moves need is its. */
  readonly engine: JourneyEngine;
  readonly formId: string;
  /** The compiled form's root. */
  readonly root: ComponentNode;
  readonly stateStore: FormStateStore;
  readonly orchestrator: RuntimeOrchestrator;
  readonly eventBus: EventBus;
  /** The plugin formula functions on every rule context, by name: a route's condition reads them. */
  readonly formulaFunctions: Record<string, (args: unknown[]) => unknown>;
  /** The host's word on risky patterns, for a presentation's own field constraints. */
  readonly riskyPatterns: "refuse" | "allow" | undefined;
  /** The form's formula policy in force (host word, else the form's, else `fail`), for the same constraints. */
  readonly formulaErrors?: FormulaErrorPolicy | undefined;
  /** The form's usable journeys, in order (`FormRuntime.journeys`). */
  journeys(): Journey[];
  /** The journeys block as the runtime reads it (`FormRuntime.journeyConfiguration`). */
  journeyConfiguration(): JourneyConfiguration | undefined;
  /** Recomputes over the live state, then reconciles the journey (`FormRuntime.recompute`). */
  recompute(): void;
  /** A page's validation (`FormRuntime.validate({ page })`). */
  validate(options: { page: string }): Promise<unknown>;
  /**
   * Runs `beforePageChange` for a move the person asked for: `undefined`, at once, when no hook
   * is set; else what the hooks said. The runtime adds the form values to the context.
   */
  runBeforePageChange(context: Omit<BeforePageChangeHookContext, "values">): Promise<PageChangeHookOutcome> | undefined;
  /** Forgets what the controls said: it goes with the journey it was asked in. */
  clearInputStates(): void;
  /** Whether a page's components hold an error that blocks (the error store's answer). */
  pageHoldsBlockingError(pageId: string, withServerErrors: boolean): boolean;
  /** Drops the stored errors on components the path no longer validates (the error store's half of keeping errors to the path). */
  dropErrorsOffPath(): void;
  /** Drops the form-level errors a page's check left. */
  dropPageOwnedErrors(): void;
  /** Drops what a presentation's own validation left; with `left`, every error on its own nodes. */
  dropPresentationErrors(left?: PresentationIndex): void;
  /** What the controls know beyond the values, as a validation context's `inputStates`; nothing when there are none. */
  inputStates(): Pick<ValidationContext, "inputStates">;
  /** The journey's checks against the host's server, bound to this runtime ({@link JourneyEngine.checks}). */
  readonly checks: JourneyChecks;
}

/**
 * What a runtime hands the journey's checks against the host's server: the
 * parts of the runtime they read, and the error store's moves they ask for. The runtime keeps the
 * event bus, the error store and the submit; the checks reach them through this.
 */
export interface JourneyChecksHost {
  /** The engine the runtime was built with: a check's key, reply and outcome are its. */
  readonly engine: JourneyEngine;
  readonly formId: string;
  readonly eventBus: EventBus;
  /**
   * Whether the running journey is a builder's preview (`journeyConfiguration` set). A preview
   * is never checked against a server: the server knows the registered definition, not the
   * draft being edited.
   */
  readonly previewed: boolean;
  /** The host's way to its server and the time limit it asked for, as the dependencies gave them. */
  readonly validator: JourneyServerValidator | undefined;
  readonly timeoutMs: number | undefined;
  /** The answers as the rules see them now (`RuntimeOrchestrator.effectiveValues`). */
  effectiveValues(): Record<string, unknown>;
  /** The form's version a request names: the version context's, else the definition's. */
  formVersion(): string;
  locale(): string;
  /** The submission envelope a check hands the validator, built as Submit builds it; `undefined` without a version context. */
  document?(request: JourneyValidationRequest): CanonicalSubmission | undefined;
  /** Every component a page holds. */
  pageComponents(pageId: string): Set<string>;
  /** Whether the form has a component of that id anywhere in its tree. */
  hasComponent(componentId: string): boolean;
  /** The component a value path belongs to (`FormRuntime`'s one way from a path to a page). */
  componentIdForValuePath(path: string): string | undefined;
  /** A host's errors as the form stores them, under the stage given. */
  fromHostErrors(errors: HostError[], idPrefix: string, stage: string): FormError[];
  /** A page's check into the error store: the page's slice becomes its own findings plus the server's word. */
  storePageCheck(members: ReadonlySet<string>, errors: FormError[]): void;
  /** The page's "could not check" error, in place of any before it. */
  showPageUnavailable(error: FormError): void;
  /** Records each server error's answers as they stand, so the error stands until they change. */
  rememberServerErrors(errors: readonly FormError[]): void;
}

/** What refused a submit at the journey's end check: the runtime rejects the submission with it. */
export interface JourneyEndRefusal {
  errors: FormError[];
  scope: "page" | "journey";
  outcome: JourneyCheckOutcome;
  /** The final page, when the check was its Continue's place taken. */
  pageId?: string;
}

/**
 * A journey's checks against the host's server, bound to one runtime: a
 * page's on Continue, the journey's at its end, the one out, what the server passed. With no
 * journey engine nothing is ever checked, so every answer is "nothing out, nothing to refuse".
 */
export interface JourneyChecks {
  /** The check out at the host's server, while it is out. */
  pending(): { readonly inSubmit: boolean } | undefined;
  /** Continue's check against the host's server; `undefined` when the page may be left, else why not. */
  checkPage(active: ActiveJourney, pageId: string, onUnavailable: JourneyServerUnavailable): Promise<JourneyBlockReason | undefined>;
  /** The journey's check at its end, over the values the envelope will carry; `undefined` when the submission may go on. */
  checkEnd(
    active: ActiveJourney | undefined,
    trace: JourneyTrace | undefined,
    values: Record<string, unknown>,
    formVersion: string,
    skip: boolean
  ): Promise<JourneyEndRefusal | undefined>;
  /** Calls off a page's check still out at the server. */
  callOff(why: "cancelled" | "stale"): void;
  /** Forgets what the host's server passed and warned about. */
  forget(): void;
  /** Replaces the host's way to its server; what the old one passed is forgotten. */
  setValidator(validator?: JourneyServerValidator): void;
}

/**
 * A journey's moves, bound to one runtime: starting, leaving, Continue,
 * Back, a jump, the page kept to the path after a recompute. `FormRuntime`'s journey methods
 * delegate here. With no journey engine every move is refused with `"no-journey"` and every read
 * is empty, as for a form with no journey configured.
 */
export interface JourneyNavigation {
  /**
   * The journey running, with its ownership worked out — `undefined` when the form is being
   * filled on one page, or the journey it names has gone from the configuration.
   */
  active(): ActiveJourney | undefined;
  /** The path as the last recompute's fold drew it: read, never worked out again. */
  trace(): JourneyTrace | undefined;
  /** `FormRuntime.journeyView`. */
  view(): JourneyView | undefined;
  /** `FormRuntime.startJourney`. */
  start(journeyId: string | undefined, options: { pageId?: string }): JourneyNavigationResult;
  /** `FormRuntime.leaveJourney`. */
  leave(): void;
  /**
   * `FormRuntime.nextPage`. `waitFirst` (the runtime's checks of single fields still out) is
   * waited on as part of the Continue, before the page is judged: a Back meanwhile calls it off.
   */
  nextPage(waitFirst?: () => Promise<void>): Promise<JourneyNavigationResult>;
  /** `FormRuntime.previousPage`. */
  previousPage(): Promise<JourneyNavigationResult>;
  /** `FormRuntime.goToPage`. */
  goToPage(pageId: string, options: { direction?: "jump" | "error" | "change" }): Promise<JourneyNavigationResult>;
  /** After every recompute: the completed pages and the page shown kept to the path. */
  reconcile(): void;
  /** Every component a page holds. */
  pageComponents(pageId: string): Set<string>;
  /**
   * The own-field stage: the errors the running presentation's own fields' constraints
   * raise over the answers as stored, kept to the nodes that show. `[]` without a presentation.
   * `translations` is the definition's map and `catalog` the host's,
   * so a message is worded in the run's locale, the catalog first.
   */
  ownFieldErrors(state: { values: Record<string, unknown>; locale: string; translations?: FormTranslations | undefined; catalog?: TranslationCatalog | undefined }): Promise<ValidationResult["errors"]>;
  /**
   * Takes the person to the earliest page on the path that holds one of `componentIds` (the
   * components of the errors that block, read only once a journey runs), at once and without
   * hooks. Nothing moves when no journey runs or none of them is on a page of the path.
   */
  revealErrorPage(componentIds: () => Iterable<string | undefined>): void;
  /**
   * Puts a draft's journey back (`FormRuntime.hydrateFromDraft`); `false` when no journey runs
   * after it, and the draft is then revalidated as a whole form.
   */
  restoreFromDraft(saved: FormDraftJourney | undefined): boolean;
  /** After {@link restoreFromDraft}: which components a restored journey's validation keeps (the pages already continued from). */
  completedPagesScope(): (componentId: string) => boolean;
  /** The journey block a draft saves for a journey state; `undefined` when none runs. */
  draftJourney(state: Readonly<JourneyState> | undefined): FormDraftJourney | undefined;
}

/**
 * What a runtime's orchestrator hands a running presentation's overlay:
 * its rule machinery, read as the orchestrator reads it, and where a worked-out value's write
 * goes. Bound once, when the first presentation runs.
 */
export interface PresentationOverlayHost {
  readonly hostContext: Record<string, unknown>;
  /** The plugin formula functions, wrapped as the orchestrator wraps them. */
  readonly functions: Record<string, (args: unknown[]) => unknown> | undefined;
  /** The `matches` patterns compiled, shared by every rule context. */
  readonly regexCache: Record<string, unknown>;
  /** Where a formula function says what it did not do, once per message. */
  warn(message: string): void;
  /** The day of the recompute in progress. */
  today(): string | undefined;
  /** The tree a rule holds for the browser (`RuntimeOrchestrator.ruleOf`). */
  ruleOf(rules: ComponentRules | undefined, key: ComponentRuleKey): Expression | undefined;
  /** The orchestrator's semantic state resolver, over an own node's context. */
  resolve(node: ComponentNode, context: SemanticResolutionContext): SemanticNodeState;
  /** A rule of `node` evaluated over `context`, as the orchestrator evaluates a component's. */
  evaluate(rule: Expression, node: ComponentNode, context: SemanticResolutionContext): unknown;
  /** Persists a worked-out value's write-back (without marking the field dirty). */
  applyComputedValue(path: string, value: unknown): void;
  /** Keeps, or forgets, what a worked-out value wrote at a target's value path (`JourneyState.written`). */
  recordWritten(targetPath: string, value: unknown, held: boolean): void;
}

/** One recompute's rounds of a running presentation: what the orchestrator hands over. */
export interface PresentationRoundsInput {
  presentation: PresentationIndex;
  /** The form values the pipeline works on, written into in place. */
  working: FormValues;
  /** The answers as stored, a presentation's own included. */
  stored: FormValues;
  /** What the worked-out values last wrote (`JourneyState.written`). */
  written: Readonly<Record<string, unknown>> | undefined;
  locale: string;
  /** Records a round's writes for the recompute's result. */
  note(round: ReadonlyArray<{ componentId: string; value: unknown }>): void;
  /** The form's own calculations and defaults, over `working`. */
  runValueRules(working: FormValues): Array<{ componentId: string; value: unknown }>;
  /** The shared fold over `working`. */
  fold(working: FormValues): KernelFoldResult;
}

/** What a presentation's rounds settled on: the last fold, the overlay over it, and whether the worked-out values settled. */
export interface PresentationRoundsResult {
  fold: KernelFoldResult;
  overlay: Record<string, PresentationNodeState>;
  settled: boolean;
}

/**
 * A running presentation beside the form pipeline, bound to one orchestrator:
 * the worked-out values before the form's calculations, the overlay after the fold,
 * round again while which sources show keeps changing. It remembers which sources could be read
 * when the last recompute ended, so a keystroke usually settles in one round.
 */
export interface PresentationOverlay {
  recompute(input: PresentationRoundsInput): PresentationRoundsResult;
  /** Forgets which sources the worked-out values could read (the answers were replaced, or no presentation runs). */
  forget(): void;
}

/** What {@link JourneyEngine.view} reads: the journey, its ownership, the state's page and completions, the path as it stands. */
export interface JourneyViewInput {
  journey: Journey;
  ownership: JourneyOwnership;
  pageId: string;
  completedPages: ReadonlySet<string>;
  trace: JourneyTrace;
  /** The review page a Change link left (`JourneyState.returnTo`), when one did. */
  returnTo?: string | undefined;
}

/** A move the runtime worked out before the hooks ran, to be checked again after them. */
export interface MoveCheckInput {
  view: JourneyView;
  trace: JourneyTrace;
  to: string;
  direction: Extract<PageChangeDirection, "forward" | "back" | "jump" | "change">;
}

/** What to do with the journey a draft carries. */
export type JourneyRestorePlan =
  | { kind: "none" }
  /** The saved journey is gone from the configuration: start the running one over the draft's answers. */
  | { kind: "restart" }
  | {
      kind: "restore";
      journeyId: string;
      pageId: string;
      completedPages: readonly string[];
      /** Read tolerantly, as a draft is: what the worked-out values had written. */
      written: Record<string, unknown> | undefined;
      /** The review page a Change link had left (`JourneyState.returnTo`); the navigation keeps it only while it still holds. */
      returnTo: string | undefined;
    };

/** The pages a restored journey lands on, in the order they are set: the frontier when the draft's page is out of reach, then the host's wanted page when it is now reachable. */
export interface JourneyLanding {
  frontier?: string;
  wanted?: string;
}

/**
 * What a check against the host's server is made of: the request's key, the
 * reply read tolerantly, a failure classified, an outcome named. Pure functions of their
 * arguments.
 */
export interface JourneyServerCheckKit {
  /** The request as stable text, so a repeat of exactly the same check can be told. */
  key(request: JourneyValidationRequest): string;
  /** A value as the same text whatever order its keys were set in. */
  stableJson(value: unknown): string;
  classifyFailure(error: unknown, timedOut: boolean): JourneyCheckFailure;
  /** The reply's errors, or `undefined` when it is no reply at all. */
  normalizeReply(reply: unknown, resolve?: JourneyPathResolver): HostError[] | undefined;
  /** A page's check keeps the errors naming its components, those naming none, and those naming a component the form does not have (as the form's own). */
  scopeToPage(errors: readonly HostError[], members: ReadonlySet<string>, isComponent: (componentId: string) => boolean): HostError[];
  outcomeOf(errors: readonly { severity?: HostError["severity"] }[]): Extract<JourneyCheckOutcome, "clean" | "invalid" | "warnings">;
}

export interface JourneyEngine {
  /** Names the engine for a message and for the bundle guard's sentinel. */
  readonly name: string;
  /** `"none"` for the engine that has no journeys; the runtime says so once when a definition has them. */
  readonly kind: "none" | "journeys";

  /** The usable journeys of a configuration (already compiled by the runtime), in order. `[]` for no engine. */
  journeys(configuration: JourneyConfiguration | undefined): Journey[];
  /** The configuration's default journey (`startJourney()` without an id). */
  defaultJourney(configuration: JourneyConfiguration | undefined): Journey | undefined;
  /** Which journey the form opens as: the host's choice over the definition's. */
  selection(configuration: JourneyConfiguration | undefined, choice: JourneyHostChoice): JourneySelectionResult;

  /** The ownership, the fold's input and the presentation of a journey, worked out once. */
  activate(input: ActivateJourneyInput): ActiveJourneyPlan;
  /** The page being shown as a renderer needs it, without the runtime's `pending` and `hosts`. */
  view(input: JourneyViewInput): JourneyView | undefined;
  /** The first page on the path not completed. */
  frontier(trace: JourneyTrace, completed: readonly string[]): string | undefined;
  /** Whether a page is on the path at or before the frontier. */
  reachable(trace: JourneyTrace, completed: readonly string[], pageId: string): boolean;
  /** Whether a move worked out before the hooks ran is still the one the path allows now. */
  moveHolds(input: MoveCheckInput): boolean;
  /** Every component a page holds (its listed components and their subtrees; for a presentation, its own nodes too). */
  pageComponents(ownership: JourneyOwnership, pageId: string): Set<string>;
  pageValidation(journey: Journey, page: JourneyPage | undefined): ResolvedJourneyValidation;
  endValidation(journey: Journey): "client" | "server";
  /** The form's root with the presentation's container in the last slot, for a live page to be drawn from. */
  renderRoot(root: ComponentNode, presentation: PresentationIndex): ComponentNode;
  /** What to do with the journey a draft carries. */
  restore(
    saved: { id: string; page: string; completed: readonly string[]; written?: unknown; returnTo?: unknown } | undefined,
    journeys: readonly Journey[],
    running: boolean
  ): JourneyRestorePlan;
  /** The paths a presentation's worked-out values still work out (what a draft's `written` is kept to). */
  workedOutTargets(presentation: PresentationIndex | undefined): Set<string>;
  /** Where a restored journey lands. */
  landing(trace: JourneyTrace, completed: readonly string[], pageId: string, wanted: string | undefined): JourneyLanding;
  /** The journey as a draft, a submission and the sandbox name it. */
  describe(active: ActiveJourneyPlan | undefined): { journeyId: string } | undefined;
  readonly serverCheck: JourneyServerCheckKit;
  /** A journey's moves, bound to one runtime: called once, when the runtime is built. */
  navigation(host: JourneyRuntimeHost): JourneyNavigation;
  /** A journey's checks against the host's server, bound to one runtime: called once, before {@link navigation}, whose host holds it. */
  checks(host: JourneyChecksHost): JourneyChecks;
  /** A running presentation's overlay, bound to one orchestrator: called once, when its first presentation runs. */
  presentationOverlay(host: PresentationOverlayHost): PresentationOverlay;
}

/** The message every part of the runtime that needs an engine reports when there is none. */
export const JOURNEY_ENGINE_MISSING =
  "This form runtime was built without a journey engine, so it cannot run a journey. " +
  "Pass the journeyEngine dependency, or call setDefaultJourneyEngine(EagerJourneyEngine) once at startup.";

function missing(): never {
  throw new Error(JOURNEY_ENGINE_MISSING);
}

/**
 * Sorted-key JSON, the same text the eager engine's `journeyStableJson` gives. The runtime
 * compares held server errors with it on every form (`setErrors`), so the Noop engine cannot
 * leave it missing; it is spelt here because the real one sits in the journey-only server
 * check module, which the lazy split keeps out of the form entry. A test pins the two equal.
 */
function noopStableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        out[key] = sort(record[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(sort(value)) ?? "";
}

/**
 * The moves of a runtime with no journey engine: the answers a runtime gives when no journey is
 * configured. Nothing ever starts a journey here (no journeys, no default, a draft's journey is
 * never restored), so the state never holds one, and what only a running journey reaches says so.
 */
function noopNavigation(host: JourneyRuntimeHost): JourneyNavigation {
  return {
    active: () => undefined,
    trace: () => undefined,
    view: () => undefined,
    start(journeyId) {
      // Read as a runtime with an engine reads them, so a host's override is compiled, and its
      // problems said, alike; neither holds a journey this engine runs.
      if (journeyId !== undefined) {
        host.journeys();
      } else {
        host.engine.defaultJourney(host.journeyConfiguration());
      }
      return { ok: false, reason: "no-journey" };
    },
    leave: () => undefined,
    nextPage: async () => ({ ok: false, reason: "no-journey" }),
    previousPage: async () => ({ ok: false, reason: "no-journey" }),
    goToPage: async () => ({ ok: false, reason: "no-journey" }),
    reconcile: () => undefined,
    pageComponents: () => new Set<string>(),
    ownFieldErrors: async () => [],
    revealErrorPage: () => undefined,
    // The draft's journey is never put back: none runs here, so it is judged as a whole form.
    restoreFromDraft: () => false,
    completedPagesScope: missing,
    draftJourney: () => undefined
  };
}

/**
 * The overlay of a runtime with no journey engine: no presentation ever runs (no journey does),
 * so there is nothing to work out, and nothing remembered to forget.
 */
const noopOverlay: PresentationOverlay = {
  recompute: missing,
  forget: () => undefined
};

/**
 * The checks of a runtime with no journey engine: nothing is ever out and nothing is asked of
 * the server, since no journey runs. What only a running journey reaches (a page's check) says
 * so by throwing, like the rest of this engine.
 */
const noopChecks: JourneyChecks = {
  pending: () => undefined,
  checkPage: missing,
  checkEnd: async () => undefined,
  callOff: () => undefined,
  forget: () => undefined,
  setValidator: () => undefined
};

/**
 * The engine of a form with no journeys: every question has the answer it has when no journey
 * is configured. `FormRuntime` with this engine is a plain form: `journeys()`
 * is `[]`, `journeyView()` is `undefined`, a move is refused with `"no-journey"`. Given a
 * definition that does have journeys, the runtime says so once and runs it as one page.
 *
 * What cannot be reached with no journey running (a plan, a view, a check) says so by throwing
 * {@link JOURNEY_ENGINE_MISSING}, rather than answering as if something had been checked.
 */
export const NoopJourneyEngine: JourneyEngine = {
  name: "datum-journey-engine-noop",
  kind: "none",
  journeys: () => [],
  defaultJourney: () => undefined,
  // A plain form's own answer: the whole form, and a host's named journey warned about once.
  selection: (_configuration, choice) => resolveJourneySelection({ journey: undefined }, choice),
  activate: missing,
  view: () => undefined,
  frontier: () => undefined,
  reachable: () => false,
  moveHolds: () => false,
  pageComponents: () => new Set<string>(),
  pageValidation: journeyPageValidation,
  endValidation: journeyEndValidation,
  renderRoot: missing,
  restore: () => ({ kind: "none" }),
  workedOutTargets: () => new Set<string>(),
  landing: () => ({}),
  describe: () => undefined,
  serverCheck: {
    key: missing,
    stableJson: noopStableJson,
    classifyFailure: missing,
    normalizeReply: missing,
    scopeToPage: missing,
    outcomeOf: missing
  },
  navigation: noopNavigation,
  checks: () => noopChecks,
  presentationOverlay: () => noopOverlay
};

/**
 * The engine a runtime built without a `journeyEngine` dependency takes: the Noop
 * one, until a host that builds runtimes itself says otherwise with
 * {@link setDefaultJourneyEngine}. Never set by importing the engine package: it is
 * `sideEffects: false`, and a registration at import time could be dropped by a bundler. The
 * builder entry, the demo app's entry and the test setup files call it; `<datum-form>` hands
 * the engine it loaded to each runtime instead.
 *
 * Held on the global object under a registered symbol, the way the bundles keep their other
 * registries, rather than in a module variable: the builder and form bundles each carry a copy
 * of this module, and a module graph that is loaded again (a test's `vi.resetModules()`) is a
 * copy too, yet one registration should reach every runtime the page or the worker builds.
 */
const DEFAULT_ENGINE_KEY = Symbol.for("datum.journeyEngine.default");

type EngineHolder = { [DEFAULT_ENGINE_KEY]?: JourneyEngine };

/** Sets the engine runtimes take when their dependencies name none. */
export function setDefaultJourneyEngine(engine: JourneyEngine): void {
  (globalThis as EngineHolder)[DEFAULT_ENGINE_KEY] = engine;
}

/** The engine runtimes take when their dependencies name none. */
export function defaultJourneyEngine(): JourneyEngine {
  return (globalThis as EngineHolder)[DEFAULT_ENGINE_KEY] ?? NoopJourneyEngine;
}
