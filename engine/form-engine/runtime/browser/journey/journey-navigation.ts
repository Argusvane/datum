import type { Journey } from "../../../core/schema/journey.js";
import type {
  JourneyBlockReason,
  JourneyNavigationResult,
  JourneyTrace,
  JourneyView,
  PageChangeDirection
} from "../../../core/journey/journey-types.js";
import type { BeforePageChangeHookContext } from "../../../core/events/hooks.js";
import {
  FormEventType,
  type JourneyChangedEventData,
  type PageBlockedEventData,
  type PageChangedEventData
} from "../../../core/events/event-types.js";
import type { ValidationResult } from "../../../core/schema/contracts.js";
import type { JourneyState } from "../../../core/state/form-state.js";
import type { FormTranslations, TranslationCatalog } from "../../../core/localization/translations.js";
import { kernelOwn } from "../../../core/state/submittable-fold.js";
import type { FormDraftJourney } from "../../../persistence/core/draft-store.js";
import { evaluateExpression } from "../../../rules/evaluator/evaluator.js";
import type { ActiveJourney, JourneyNavigation, JourneyRuntimeHost } from "../journey-engine.js";

/** The running journey's own nodes, as the engine worked them out. */
type PresentationIndex = NonNullable<ActiveJourney["presentation"]>;

/**
 * A journey's moves, bound to one runtime. They sit behind the engine so they load with the
 * engine and stay out of the renderer entry.
 * The runtime keeps its state store, event bus, hook runner and error store and hands them over
 * as the {@link JourneyRuntimeHost}; this class holds only the journey's own bookkeeping — the
 * active journey worked out once, a Continue in progress, a page waiting to be reached, the path
 * the stored errors were last kept to. A draft's journey (put back, its completed pages
 * revalidated, saved), the page shown for an error, and a presentation's own-field checks and
 * error hosts live here too.
 */
export class JourneyNavigator implements JourneyNavigation {
  /** The active journey's ownership, worked out once per journey object. */
  private activeJourneyCache: ActiveJourney | undefined;
  /** A Continue in progress: a second one is refused (`"pending"`) rather than run twice. */
  private continuing = false;
  /**
   * A page a journey was asked to open on (`page`, `startJourney`'s `pageId`) that the person
   * could not reach yet — nothing is completed when a journey starts. Honoured once a draft
   * puts back the pages before it (a resume point), forgotten on the first move.
   */
  private pendingOpenPage: { journeyId: string; pageId: string } | undefined;
  /** The journey and path the stored errors were last kept to (see {@link keepErrorsToPath}). */
  private errorsKeptTo: { journey: Journey; pages: string } | undefined;

  /** The `matches` patterns compiled for the journey's conditions; a risky one is refused unless the host allows it. */
  private readonly regexCache: Record<string, unknown>;

  constructor(private readonly host: JourneyRuntimeHost) {
    this.regexCache = host.riskyPatterns === "allow" ? {} : { refuseRisky: true };
  }

  /**
   * The journey running, with its ownership worked out — `undefined` when the form is being
   * filled on one page, or the journey it names has gone from the configuration.
   */
  public active(): ActiveJourney | undefined {
    const state = this.host.stateStore.peekJourney();
    if (!state) {
      return undefined;
    }
    const journey = this.host.journeys().find((entry) => entry.id === state.journeyId);
    if (!journey) {
      return undefined;
    }
    const cached = this.activeJourneyCache;
    if (cached && cached.journey === journey) {
      return cached;
    }
    // The ownership, the fold's input and the journey's own nodes are the engine's
    // to work out, once per journey object.
    const active: ActiveJourney = this.host.engine.activate({
      root: this.host.root,
      journey,
      definesKey: (key) => this.host.orchestrator.definesKey(key),
      // Form scope only: a condition naming `row.`, `ancestor.` or `host.` is a diagnostic
      // error, and a server re-working the path out has none of them. The day is the fold's
      // (the orchestrator's snapshot for the recompute), the functions the plugins'.
      evaluate: (expression, values, today) =>
        evaluateExpression(expression, {
          values,
          ...(today !== undefined ? { today } : {}),
          functions: this.host.formulaFunctions,
          regexCache: this.regexCache
        }),
      riskyPatterns: this.host.riskyPatterns,
      formulaErrors: this.host.formulaErrors
    });
    this.activeJourneyCache = active;
    return active;
  }

  /** The path as the last recompute's fold drew it (the orchestrator's): read, never worked out again. */
  public trace(): JourneyTrace | undefined {
    return this.host.orchestrator.lastJourneyTrace();
  }

  /**
   * The page being shown, as a renderer needs it: where it sits on the path, where Back goes,
   * whether it is the last, what it draws. `undefined` when no journey runs.
   */
  public view(): JourneyView | undefined {
    const state = this.host.stateStore.peekJourney();
    const active = this.active();
    const trace = this.trace();
    if (!state || !active || !trace) {
      return undefined;
    }
    const view = this.host.engine.view({
      journey: active.journey,
      ownership: active.ownership,
      pageId: state.pageId,
      completedPages: state.completedPages,
      trace,
      returnTo: state.returnTo
    });
    if (!view) {
      return undefined;
    }
    const pendingCheck = this.host.checks.pending();
    if (pendingCheck) {
      view.pending = pendingCheck.inSubmit ? "journey" : "page";
    }
    if (active.presentation) {
      view.hosts = this.errorHosts(active.presentation, state.pageId);
    }
    return view;
  }

  /**
   * Which node of a page shows the errors of a form field the page asks without drawing it:
   * the first alias on the page that shows, else the worked-out value's copy.
   * Never for a field the page draws itself — listed or referenced — which shows its own.
   */
  private errorHosts(presentation: PresentationIndex, pageId: string): Record<string, string> {
    const hosts = Object.create(null) as Record<string, string>;
    const drawn = kernelOwn(presentation.drawnOf, pageId);
    const hostless = (targetId: string): boolean =>
      kernelOwn(hosts, targetId) === undefined && (drawn === undefined || kernelOwn(drawn, targetId) !== true);
    for (const alias of presentation.aliases) {
      if (alias.pageId === pageId && hostless(alias.targetId) && this.host.orchestrator.presentationStateOf(alias.nodeId)?.effective.visible === true) {
        hosts[alias.targetId] = alias.nodeId;
      }
    }
    for (const mapping of presentation.workedOut) {
      if (mapping.pageId === pageId && hostless(mapping.targetId)) {
        hosts[mapping.targetId] = mapping.nodeId;
      }
    }
    return hosts;
  }

  /**
   * The own-field stage: the constraints the running presentation's own fields
   * declare — Required, lengths, a pattern — checked in the browser only, over the answers as
   * stored: an own field's at its `@` key, an alias's at the form field it fills. Requiredness
   * is the overlay's (the field's own tick or `requiredWhen`). A worked-out value's copy holds
   * no answer of its own: the form's rules judge its target. Nothing without a presentation.
   *
   * `translations` is the definition's map, the same the runtime's own validation
   * context carries: a pattern's message on an own field is worded from it for the run's
   * locale, at `components › <node id> › patternMessage`, as the field-constraints stage does
   * for a form field. Absent, the message reads in the default language. `catalog` is the
   * host's, read before the map under the same tag.
   */
  public async ownFieldErrors(state: { values: Record<string, unknown>; locale: string; translations?: FormTranslations | undefined; catalog?: TranslationCatalog | undefined }): Promise<ValidationResult["errors"]> {
    const active = this.active();
    const presentation = active?.presentation;
    const stage = active?.ownStage;
    if (!presentation || !stage) {
      return [];
    }
    const orchestrator = this.host.orchestrator;
    const required = Object.create(null) as Record<string, boolean>;
    for (const id of presentation.order) {
      required[id] = orchestrator.presentationStateOf(id)?.ownRequired === true;
    }
    const result = await stage.validate({
      formId: this.host.formId,
      values: state.values,
      locale: state.locale,
      requiredComponents: required,
      ...(state.translations !== undefined ? { translations: state.translations } : {}),
      ...(state.catalog !== undefined ? { catalog: state.catalog } : {}),
      ...this.host.inputStates()
    });
    return result.errors.filter(
      (error) =>
        error.componentId !== undefined &&
        kernelOwn(presentation.kindOf, error.componentId) !== "worked-out" &&
        // Never from a node nobody sees: whatever the hidden policy lets through for the form's
        // own fields, an own node's checks are the browser's alone and ask only while it shows.
        orchestrator.presentationStateOf(error.componentId)?.effective.visible === true &&
        // The tick is read through the overlay too: on an alias or a field it is the node's own.
        (error.code !== "required" || kernelOwn(required, error.componentId) === true)
    );
  }

  /**
   * Takes the person to the earliest page on the path holding an error that blocks — at once,
   * without hooks, past the furthest page reached if need be. An error is placed by its
   * component, else by its value path's (the runtime's to say: `componentIds` lists them, read
   * only once a journey runs). An error on no page of the path (off it, on no page, or the
   * form's own) moves nothing: the renderer lists it in the summary.
   *
   * On a review page nothing moves either: a send refused there stays there, and the page lists
   * the errors against the answers they are about, each with its Change link (the error store
   * holds them; the renderer reads them).
   */
  public revealErrorPage(componentIds: () => Iterable<string | undefined>): void {
    const state = this.host.stateStore.peekJourney();
    const active = this.active();
    const trace = this.trace();
    if (!state || !active || !trace || trace.pages.length === 0) {
      return;
    }
    if (trace.pages.includes(state.pageId) && active.journey.pages.find((page) => page.id === state.pageId)?.kind === "review") {
      return;
    }
    let earliest = -1;
    for (const componentId of componentIds()) {
      const owners = componentId !== undefined ? active.ownership.pagesOf[componentId] : undefined;
      for (const pageId of owners ?? []) {
        const at = trace.pages.indexOf(pageId);
        if (at >= 0 && (earliest < 0 || at < earliest)) {
          earliest = at;
        }
      }
    }
    if (earliest >= 0) {
      this.movePage(trace.pages[earliest] as string, "error");
    }
  }

  /**
   * Puts a draft's journey back — its page and what was completed — when the form still has
   * that journey; else starts the running journey again over the draft's answers. The page is
   * kept to one the person may reach; the host's `page`, waiting since the journey started, wins
   * over the draft's own once the draft's completed pages reach it. `false` when no journey runs.
   */
  public restoreFromDraft(saved: FormDraftJourney | undefined): boolean {
    const host = this.host;
    const before = host.stateStore.peekJourney();
    const previousJourneyId = before?.journeyId ?? null;
    const previousPageId = before?.pageId ?? null;
    const plan = host.engine.restore(saved, host.journeys(), before !== undefined);
    if (plan.kind === "restore") {
      host.stateStore.restoreJourney({
        journeyId: plan.journeyId,
        pageId: plan.pageId,
        completedPages: plan.completedPages,
        written: plan.written,
        returnTo: plan.returnTo
      });
    } else if (plan.kind === "restart" && before) {
      host.stateStore.startJourney(before.journeyId, before.pageId);
    } else {
      return false;
    }
    // What the draft says its worked-out values wrote, kept only for a path one of them still
    // works out: an entry the definition no longer backs — its node removed, or
    // moved to another field — would let a later mapping clear an answer it never wrote.
    const targets = host.engine.workedOutTargets(this.active()?.presentation);
    for (const path of Object.keys(host.stateStore.peekJourney()?.written ?? {})) {
      if (!targets.has(path)) {
        host.stateStore.setJourneyWritten(path, undefined, false);
      }
    }
    // Which sources show is the draft's answers' to say, never the state's before it.
    host.orchestrator.forgetReadable();
    host.orchestrator.recompute(host.stateStore.snapshot());

    const state = host.stateStore.peekJourney();
    const trace = this.trace();
    if (!state || !trace) {
      return false;
    }
    host.stateStore.keepCompletedPages(trace.pages);
    const completed = [...state.completedPages];
    // The page the host asked to open on (`page`), which nothing completed could reach when the
    // journey started: the draft's completed pages may reach it now. One chance, whichever way.
    const wanted = this.takeOpenPage();
    const landing = host.engine.landing(
      trace,
      completed,
      state.pageId,
      wanted !== undefined && wanted.journeyId === state.journeyId ? wanted.pageId : undefined
    );
    if (landing.frontier !== undefined) {
      host.stateStore.setJourneyPage(landing.frontier);
    }
    if (landing.wanted !== undefined) {
      host.stateStore.setJourneyPage(landing.wanted);
    }
    // A Change link's return target survives the resume only on the page it was left for, and
    // while it is still a review page the path takes.
    if (state.returnTo !== undefined && (landing.frontier !== undefined || landing.wanted !== undefined || this.view()?.returning === undefined)) {
      host.stateStore.setJourneyReturn(undefined);
    }
    if (previousJourneyId !== state.journeyId) {
      this.publishJourneyChanged(state.journeyId, previousJourneyId);
    }
    if (previousJourneyId !== state.journeyId || previousPageId !== state.pageId) {
      this.publishPageChanged(state.journeyId, previousPageId, state.pageId, "resume");
    }
    return true;
  }

  /**
   * A restored journey's validation: the pages already continued from, not the page the
   * person comes back to — it shows no errors before they have done anything on it — and not
   * a deferred page, whose errors wait for the journey's end, a resume included.
   */
  public completedPagesScope(): (componentId: string) => boolean {
    const state = this.host.stateStore.peekJourney();
    const active = this.active();
    const completed = new Set<string>();
    for (const pageId of state?.completedPages ?? []) {
      const page = active?.journey.pages.find((entry) => entry.id === pageId);
      if (active && this.host.engine.pageValidation(active.journey, page).continue === "defer") {
        continue;
      }
      for (const componentId of this.pageComponents(pageId)) {
        completed.add(componentId);
      }
    }
    const current = state ? this.pageComponents(state.pageId) : new Set<string>();
    return (componentId) => completed.has(componentId) && !current.has(componentId);
  }

  /** The journey block a draft saves (`FormRuntime.saveDraft`): the journey, its page and what was completed. */
  public draftJourney(state: Readonly<JourneyState> | undefined): FormDraftJourney | undefined {
    if (!state) {
      return undefined;
    }
    return {
      id: state.journeyId,
      page: state.pageId,
      completed: [...state.completedPages],
      // What the presentation's worked-out values wrote, so a resume knows.
      ...(state.written !== undefined && Object.keys(state.written).length > 0
        ? { written: { ...state.written } }
        : {}),
      // The review page a Change link left, so a resumed journey still returns there.
      ...(state.returnTo !== undefined ? { returnTo: state.returnTo } : {})
    };
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
  public start(journeyId: string | undefined, options: { pageId?: string }): JourneyNavigationResult {
    const host = this.host;
    const journey =
      journeyId !== undefined
        ? host.journeys().find((entry) => entry.id === journeyId)
        : host.engine.defaultJourney(host.journeyConfiguration());
    if (!journey) {
      return { ok: false, reason: "no-journey" };
    }
    const previousJourneyId = host.stateStore.peekJourney()?.journeyId ?? null;
    // The presentation being left, whose own nodes' errors go with it.
    const left = this.active()?.presentation;
    host.checks.callOff("cancelled");
    host.checks.forget();
    this.pendingOpenPage = undefined;
    // What the controls said goes with the journey they were asked in.
    host.clearInputStates();
    host.stateStore.startJourney(journey.id, journey.pages[0]?.id ?? "");
    host.orchestrator.recompute(host.stateStore.snapshot());

    const trace = this.trace();
    const first = trace ? host.engine.frontier(trace, []) : undefined;
    if (!trace || first === undefined) {
      // The journey has no pages: there is no page to show.
      host.stateStore.endJourney();
      host.orchestrator.recompute(host.stateStore.snapshot());
      this.errorsKeptTo = undefined;
      host.dropPresentationErrors(left);
      if (previousJourneyId !== null) {
        this.publishJourneyChanged(null, previousJourneyId);
      }
      return { ok: false, reason: "unreachable" };
    }
    const wanted = options.pageId;
    const opensOnWanted = wanted !== undefined && host.engine.reachable(trace, [], wanted);
    const pageId = opensOnWanted ? wanted : first;
    if (wanted !== undefined && !opensOnWanted && journey.pages.some((page) => page.id === wanted)) {
      this.pendingOpenPage = { journeyId: journey.id, pageId: wanted };
    }
    host.stateStore.setJourneyPage(pageId);
    host.dropPageOwnedErrors();
    // A presentation's own fields are asked by it alone: their errors go with it.
    host.dropPresentationErrors(left);
    // Errors on components the new journey leaves off its path go with the journey they were
    // found in; those on components on no page stay while the fold still validates them
    // (a field on no page is judged as the whole form judges it).
    this.keepErrorsToPath();
    this.publishJourneyChanged(journey.id, previousJourneyId);
    this.publishPageChanged(journey.id, null, pageId, "start");
    return { ok: true, pageId };
  }

  /**
   * Stops the journey: the whole form is in play again, on one page. Answers are kept; a page's
   * check still out at the server is called off, and what the server passed is forgotten.
   */
  public leave(): void {
    const host = this.host;
    const state = host.stateStore.peekJourney();
    if (!state) {
      return;
    }
    const left = this.active()?.presentation;
    host.checks.callOff("cancelled");
    host.checks.forget();
    this.pendingOpenPage = undefined;
    // The presentation's worked-out values stop with it: what they wrote is
    // forgotten with the journey's state, and the fields they set stay as ordinary answers.
    host.stateStore.endJourney();
    host.clearInputStates();
    host.dropPageOwnedErrors();
    host.dropPresentationErrors(left);
    host.recompute();
    this.publishJourneyChanged(null, state.journeyId);
  }

  /**
   * Continue: checks the page as its `validation` says — its own answers (`continue: "page"`,
   * the default) and then the host's server (`server: true`) — and moves to the next page on
   * the path. A deferred page (`continue: "defer"`) moves on unchecked, unless it holds an
   * error that blocks: then it is validated, so a fix can be confirmed. The last page submits
   * rather than continues (`"at-end"`); an exit page does neither (`"exit"`). A second call
   * while one is still out is refused (`"pending"`).
   *
   * `waitFirst` is something the Continue waits on before it judges the page (the runtime's
   * checks of single fields still out). The wait is part of the Continue: a second call during
   * it is refused (`"pending"`), and a page that changed during it (Back, an error shown, the
   * journey left) calls the Continue off (`"cancelled"`), as one during the page's validation does.
   */
  public async nextPage(waitFirst?: () => Promise<void>): Promise<JourneyNavigationResult> {
    const view = this.view();
    if (!view) {
      return { ok: false, reason: "no-journey" };
    }
    if (this.continuing || this.host.checks.pending()) {
      return this.refusePageChange(view.journeyId, view.pageId, undefined, "pending");
    }
    if (view.kind === "exit") {
      return this.refusePageChange(view.journeyId, view.pageId, undefined, "exit");
    }
    if (view.final) {
      return this.refusePageChange(view.journeyId, view.pageId, undefined, "at-end");
    }
    this.continuing = true;
    try {
      if (waitFirst === undefined) {
        return await this.continueFrom(view);
      }
      await waitFirst();
      const now = this.view();
      if (!now || this.pageMoved(view.journeyId, view.pageId)) {
        return this.refusePageChange(view.journeyId, view.pageId, undefined, "cancelled");
      }
      // The answers may have rerouted the path during the wait: the page is judged as it is now.
      if (now.kind === "exit") {
        return this.refusePageChange(now.journeyId, now.pageId, undefined, "exit");
      }
      if (now.final) {
        return this.refusePageChange(now.journeyId, now.pageId, undefined, "at-end");
      }
      return await this.continueFrom(now);
    } finally {
      this.continuing = false;
    }
  }

  private async continueFrom(view: JourneyView): Promise<JourneyNavigationResult> {
    const { journeyId, pageId } = view;
    const active = this.active();
    if (!active) {
      return { ok: false, reason: "no-journey" };
    }

    const deferred = view.validation.continue === "defer";
    // `server` is ignored on a deferred page — the diagnostic page.validation-server-deferred
    // says so: a server is asked about answers the page has checked, never unchecked ones.
    const asksServer = !deferred && view.validation.server;
    // A deferred page moves on unvalidated, unless it holds an error that blocks — the end
    // check or a submit sent the person back to it — when Continue confirms the fix.
    if (!deferred || this.host.pageHoldsBlockingError(pageId, true)) {
      await this.host.validate({ page: pageId });
      if (this.pageMoved(journeyId, pageId)) {
        return this.refusePageChange(journeyId, pageId, undefined, "cancelled");
      }
      // With the server to ask next, what it said before is its own to say again.
      if (this.host.pageHoldsBlockingError(pageId, !asksServer)) {
        return this.refusePageChange(journeyId, pageId, undefined, "validation");
      }
    }

    if (asksServer) {
      const refusal = await this.host.checks.checkPage(active, pageId, view.validation.onUnavailable);
      if (refusal !== undefined) {
        return this.refusePageChange(journeyId, pageId, undefined, refusal);
      }
    }

    // Where Continue goes is the next page on the path as the answers stand now. A page that
    // changed meanwhile (an error shown elsewhere, the journey left) called this Continue off.
    const now = this.view();
    if (!now || now.journeyId !== journeyId || now.pageId !== pageId) {
      return this.refusePageChange(journeyId, pageId, undefined, "cancelled");
    }
    // On the way back from a Change link: the first page on the path not yet completed (one the
    // changed answers put on it), else the review page.
    const target = now.returning?.nextPageId ?? now.path[now.index + 1];
    if (target === undefined) {
      return this.refusePageChange(journeyId, pageId, undefined, "at-end");
    }
    return this.changePage(journeyId, pageId, target, "forward", () => this.host.stateStore.markPageCompleted(pageId), now.returning !== undefined);
  }

  /**
   * Back: the page before this one on the path as the answers stand now. Nothing is validated.
   * Calls off the page's check still out at the server; refused (`"pending"`) while a submit's
   * check at the journey's end is out.
   */
  public async previousPage(): Promise<JourneyNavigationResult> {
    const view = this.view();
    if (!view) {
      return { ok: false, reason: "no-journey" };
    }
    if (this.host.checks.pending()?.inSubmit) {
      return this.refusePageChange(view.journeyId, view.pageId, view.backPageId, "pending");
    }
    if (view.backPageId === undefined) {
      return this.refusePageChange(view.journeyId, view.pageId, undefined, "at-start");
    }
    // On the way back from a Change link, Back goes where `backPageId` says (where Continue would,
    // from a page completed before the Change) and the return target stands.
    return this.changePage(view.journeyId, view.pageId, view.backPageId, "back", undefined, view.returning !== undefined);
  }

  /**
   * Goes to a page of the path. A `"jump"` (the default) goes only to a page at or before the
   * first one not yet completed, and runs `beforePageChange`; an `"error"` move goes to any
   * page on the path, at once and without hooks — what a renderer does to show an error
   * where it is. Either calls off the page's check still out at the server; both are refused
   * (`"pending"`) while a submit's check at the journey's end is out. The `"error"` move is a
   * host-only seam, never offered by the element; the server's fold is the gate.
   *
   * A `"change"` move is a review page's Change link: only from a review page, only to a page on
   * the path the person has completed or the first one they have not, with the hooks. It records the review page as the return
   * target (`JourneyState.returnTo`), which Continue and Back then follow ({@link JourneyView.returning}).
   */
  public async goToPage(pageId: string, options: { direction?: "jump" | "error" | "change" }): Promise<JourneyNavigationResult> {
    const view = this.view();
    if (!view) {
      return { ok: false, reason: "no-journey" };
    }
    if (pageId === view.pageId) {
      return { ok: true, pageId };
    }
    if (this.host.checks.pending()?.inSubmit) {
      return this.refusePageChange(view.journeyId, view.pageId, pageId, "pending");
    }
    if (options.direction === "error") {
      if (!view.path.includes(pageId)) {
        return this.refusePageChange(view.journeyId, view.pageId, pageId, "unreachable");
      }
      this.movePage(pageId, "error");
      return { ok: true, pageId };
    }
    if (options.direction === "change") {
      // A completed page, or the first one not yet completed: an answer changed while on the
      // review page can put a page on the path that the person has still to visit.
      const changeTrace = this.trace();
      const open = view.completed.includes(pageId) || (changeTrace !== undefined && this.host.engine.reachable(changeTrace, view.completed, pageId));
      if (view.kind !== "review" || !open) {
        return this.refusePageChange(view.journeyId, view.pageId, pageId, "unreachable");
      }
      const reviewPageId = view.pageId;
      return this.changePage(view.journeyId, reviewPageId, pageId, "change", () => this.host.stateStore.setJourneyReturn(reviewPageId), true);
    }
    const trace = this.trace();
    if (!trace || !this.host.engine.reachable(trace, view.completed, pageId)) {
      return this.refusePageChange(view.journeyId, view.pageId, pageId, "unreachable");
    }
    return this.changePage(view.journeyId, view.pageId, pageId, "jump");
  }

  /**
   * A move the person asked for: `beforePageChange` may veto it by throwing (the runtime runs
   * the hooks). `beforeMove` runs once the move is certain (Continue marks the page completed
   * there). `keepReturn`: the move is a Change link's, or Continue or Back on the way back from
   * one, so the return target stands until the review page is reached.
   */
  private async changePage(
    journeyId: string,
    fromPageId: string,
    toPageId: string,
    direction: BeforePageChangeHookContext["direction"],
    beforeMove?: () => void,
    keepReturn = false
  ): Promise<JourneyNavigationResult> {
    // No hook set: the move is made at once, with no turn of the event loop in between.
    const hooks = this.host.runBeforePageChange({ journeyId, fromPageId, toPageId, direction });
    if (hooks !== undefined) {
      const outcome = await hooks;
      if (outcome.vetoed) {
        return this.refusePageChange(journeyId, fromPageId, toPageId, "vetoed", outcome.message);
      }
      // The page moved under the hooks — an error shown, the journey left: this move is moot.
      if (this.pageMoved(journeyId, fromPageId)) {
        return this.refusePageChange(journeyId, fromPageId, toPageId, "pending");
      }
      // The answers may have changed under the hooks too — an autosave awaited while the person
      // edited — and rerouted the path. The hooks approved this target, not whatever the new
      // path would take instead: refused, and Continue again asks them about the right one.
      if (!this.moveStillHolds(toPageId, direction)) {
        return this.refusePageChange(journeyId, fromPageId, toPageId, "cancelled");
      }
    }
    beforeMove?.();
    this.movePage(toPageId, direction, keepReturn);
    return { ok: true, pageId: toPageId };
  }

  /** Whether a move worked out before the hooks ran is still the one the path allows now. */
  private moveStillHolds(toPageId: string, direction: BeforePageChangeHookContext["direction"]): boolean {
    const now = this.view();
    const trace = this.trace();
    if (!now || !trace) {
      return false;
    }
    return this.host.engine.moveHolds({ view: now, trace, to: toPageId, direction });
  }

  /**
   * Shows `toPageId`, at once. Leaving a page calls off its check still out at the server, and
   * drops the form-level errors its last check left: they were about that page. A Change link's
   * return target goes with any move but one that `keepReturn`s it, and on reaching the page.
   */
  private movePage(toPageId: string, direction: PageChangeDirection, keepReturn = false): void {
    const state = this.host.stateStore.peekJourney();
    if (!state || state.pageId === toPageId) {
      return;
    }
    if (state.returnTo !== undefined && (!keepReturn || state.returnTo === toPageId)) {
      this.host.stateStore.setJourneyReturn(undefined);
    }
    const fromPageId = state.pageId;
    const journeyId = state.journeyId;
    this.host.checks.callOff("cancelled");
    // A resume point waits only until the person (or an error shown) moves: then they are
    // somewhere of their own. The runtime keeping the page on the path is no such move.
    if (direction !== "resume") {
      this.pendingOpenPage = undefined;
    }
    this.host.stateStore.setJourneyPage(toPageId);
    this.host.dropPageOwnedErrors();
    this.publishPageChanged(journeyId, fromPageId, toPageId, direction);
  }

  private pageMoved(journeyId: string, pageId: string): boolean {
    const state = this.host.stateStore.peekJourney();
    return !state || state.journeyId !== journeyId || state.pageId !== pageId;
  }

  private refusePageChange(
    journeyId: string,
    fromPageId: string,
    toPageId: string | undefined,
    reason: JourneyBlockReason,
    message?: string
  ): JourneyNavigationResult {
    const data: PageBlockedEventData = {
      journeyId,
      fromPageId,
      reason,
      ...(toPageId !== undefined ? { toPageId } : {}),
      ...(message !== undefined ? { message } : {})
    };
    this.host.eventBus.publish({
      id: `page_blocked_${fromPageId}`,
      type: FormEventType.PAGE_BLOCKED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.host.formId,
      data
    });
    const shown = this.host.stateStore.peekJourney()?.pageId;
    return {
      ok: false,
      reason,
      ...(shown !== undefined ? { pageId: shown } : {}),
      ...(message !== undefined ? { message } : {})
    };
  }

  private publishJourneyChanged(journeyId: string | null, previousJourneyId: string | null): void {
    const data: JourneyChangedEventData = { journeyId, previousJourneyId };
    this.host.eventBus.publish({
      id: `journey_changed_${journeyId ?? "none"}`,
      type: FormEventType.JOURNEY_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.host.formId,
      data
    });
  }

  private publishPageChanged(
    journeyId: string,
    fromPageId: string | null,
    toPageId: string,
    direction: PageChangeDirection
  ): void {
    const pages = this.trace()?.pages ?? [];
    const data: PageChangedEventData = {
      journeyId,
      fromPageId,
      toPageId,
      direction,
      index: pages.indexOf(toPageId),
      total: pages.length
    };
    const returnTo = this.host.stateStore.peekJourney()?.returnTo;
    if (returnTo !== undefined) {
      data.returnPageId = returnTo;
    }
    this.host.eventBus.publish({
      id: `page_changed_${toPageId}`,
      type: FormEventType.PAGE_CHANGED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.host.formId,
      data
    });
  }

  /** The page a journey was asked to open on and could not reach yet, handed over once: one chance, whichever way. */
  private takeOpenPage(): { journeyId: string; pageId: string } | undefined {
    const wanted = this.pendingOpenPage;
    this.pendingOpenPage = undefined;
    return wanted;
  }

  /**
   * After every recompute: completed pages are kept to the path as the answers now draw it,
   * and a page the path no longer takes gives way to the last page before it that it does
   * take. A journey gone from the configuration ends.
   */
  public reconcile(): void {
    const host = this.host;
    const state = host.stateStore.peekJourney();
    if (!state) {
      this.errorsKeptTo = undefined;
      return;
    }
    const active = this.active();
    if (!active) {
      // The fold already ran without it (the orchestrator found none); the state follows.
      host.checks.callOff("cancelled");
      this.pendingOpenPage = undefined;
      this.errorsKeptTo = undefined;
      host.stateStore.endJourney();
      host.clearInputStates();
      // The presentation that ran, as last built: its own nodes' errors go with it.
      const cached = this.activeJourneyCache;
      host.dropPresentationErrors(cached !== undefined && cached.journey.id === state.journeyId ? cached.presentation : undefined);
      this.publishJourneyChanged(null, state.journeyId);
      return;
    }
    const trace = this.trace();
    if (!trace) {
      return;
    }
    host.stateStore.keepCompletedPages(trace.pages);
    // A Change link's return target goes once the path no longer takes it as a review page.
    if (state.returnTo !== undefined && this.view()?.returning === undefined) {
      host.stateStore.setJourneyReturn(undefined);
    }
    this.keepErrorsToPath();
    if (trace.pages.length === 0 || trace.pages.includes(state.pageId)) {
      // A page before this one may have just joined the path; the person is not moved back to
      // it mid-page (an answer on this page can be what made it apply). It is not completed,
      // so it bounds any jump, and the submit's whole-path validation takes the person there
      // if it holds an error.
      return;
    }
    const order = active.journey.pages.map((page) => page.id);
    const at = order.indexOf(state.pageId);
    let target = trace.pages[0] as string;
    for (const pageId of trace.pages) {
      if (order.indexOf(pageId) < at) {
        target = pageId;
      }
    }
    this.movePage(target, "resume");
  }

  /**
   * Once the path changes (or another journey starts), the stored errors are kept to it: an
   * error on a component that has left the path is about an answer that is no longer validated,
   * which the person can neither see nor fix, and which would otherwise sit in every
   * later page's summary and error count until the final submit. A component on no page of the
   * journey now running is judged as the whole form judges it, so its errors stand
   * while the fold validates it. Gone are the errors the hidden-validation policy would no longer
   * let through; kept are a component's answer-shape errors while its answer is still
   * submitted (the policy lets those through), and what a server said about a component whose
   * answer is still submitted, which stands until that answer changes. A path unchanged since
   * the last look keeps everything: a host's error on an off-path field stays in the summary.
   * Which errors go is the error store's to say ({@link JourneyRuntimeHost.dropErrorsOffPath}).
   */
  private keepErrorsToPath(): void {
    const active = this.active();
    const trace = this.trace();
    if (!active || !trace) {
      this.errorsKeptTo = undefined;
      return;
    }
    const pages = JSON.stringify(trace.pages);
    const last = this.errorsKeptTo;
    this.errorsKeptTo = { journey: active.journey, pages };
    if (last !== undefined && last.journey === active.journey && last.pages === pages) {
      return;
    }
    this.host.dropErrorsOffPath();
  }

  /**
   * Every component a page holds: its listed components and their subtrees and, for a
   * presentation, its own nodes, the form components they reference, and the form
   * fields they fill or work out.
   */
  public pageComponents(pageId: string): Set<string> {
    const active = this.active();
    if (!active) {
      return new Set<string>();
    }
    return this.host.engine.pageComponents(active.ownership, pageId);
  }
}
