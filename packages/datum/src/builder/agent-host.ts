/**
 * The builder's element host of the agent tools: the `BuilderToolHost` the builder catalogue runs over
 * a `<datum-form-builder>`. Inside the builder bundle's agent chunk (`builder/agent.ts` imports
 * it, nothing else does), never in a bundle's entry, and it imports nothing of the form's host:
 * what both hosts share is `../agent-ui.ts`.
 *
 * What it puts on the page, all in the wrapper's own shadow root beside `[data-file-warning]`
 * (outside the inner builder, so outside the `inert` subtree and stable across the shell's
 * repaints), built once per element and adopted again on a later attachment:
 *
 * - `[data-agent-banner]`, a labelled region: the purpose with Stop while a session is open, the
 *   summary (or "paused") with Undo all ({n}) and Dismiss after it, the stopped line with Allow
 *   again and Dismiss after Stop. `{ open: false }` without `onUndoAll` and without `paused` hides
 *   it (the renderer's convention). Dismiss calls the closed state's `onDismiss`,
 *   so the catalogue lets that banner go and draws it no more; after the person's own Undo all
 *   press the catalogue draws the line again with Dismiss alone, where their focus
 *   was moved, and takes it down on their next own edit or a reseed.
 * - `[data-agent-notice]`, the row under a write outside a session: the sentence and one button
 *   (Undo / Redo), gone on `clearNotice()` (the catalogue calls it on the person's own next edit),
 *   on the next notice, or after 20 s.
 * - `[data-agent-live]`, the polite live region every announcement goes to.
 *
 * Words come from the builder's own lookup widened with `AGENT_EN` (a host's `textCatalog`
 * translates them like any builder key), styles from the studio's `--db-*` tokens only (no new
 * theme token). The rest forwards: the controller, the composed definition and the
 * wrapper's problem checks; reveal, highlight, Try it and the panels through the shell's agent
 * seams; the workspace, the mode, the dirty flag and the tried answers through the wrapper; the
 * shell's lazy loaders through `shellLoaders()`, never a fetch of their own.
 */

import {
  agentWords,
  shellLoaders,
  type AgentEventType,
  type BuilderSessionUi,
  type BuilderToolHost,
  type BuilderToolUi,
  type DesignerSide,
  type JourneyActions,
  type PdfActions,
  type PdfTemplateOption,
  type SelectDocumentOutcome,
  type TryItAdapter
} from "@argusvane/datum-engine/agent";
import {
  formulaFunctionSignatures,
  isCaretControl,
  pdfLayoutConditionFindings,
  resolveLocalizedText,
  type BuilderController,
  type BuilderWorkspace,
  type DatumBuilderElement,
  type FormDefinition,
  type JourneyBuilderMode,
  type PdfBuilderMode
} from "@argusvane/datum-engine";

import { AGENT_HIGHLIGHT_MS, AGENT_UI_BASE_STYLES, button } from "../agent-ui.js";
import type { DatumFormBuilderElement } from "../builder-element.js";
import { journeyDiagnosticsLoaded } from "../journey-debug.js";
import { definitionLoadProblem, emit, formDefinitionProblem } from "../support.js";

/** How long the notice row stays without a further write or an edit of the person's. */
export const AGENT_NOTICE_MS = 20_000;

/** How long `selectDocument` waits for the document to be up in its designer. */
export const AGENT_DOCUMENT_WAIT_MS = 10_000;

/** How long the site's template list may take (`pdfTemplates`). */
export const AGENT_TEMPLATES_WAIT_MS = 5_000;

/**
 * The banner's and the notice's own styles, inside the wrapper's shadow root: drawn the way the
 * Download warning (`[data-file-warning]`) is, from the studio's tokens with plain fallbacks (the
 * banner's line in the studio focus colour, the notice's in the card line), over the shared
 * token-free base (the hidden banner, its line and buttons, the clipped live region).
 */
const BUILDER_AGENT_STYLES = `
[data-agent-banner]{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 8px;padding:8px 12px;font:inherit;border:2px solid var(--db-focus, currentColor);border-radius:4px}
[data-agent-notice]{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 8px;padding:8px 12px;font:inherit;border:1px solid var(--db-line-card, currentColor);border-radius:4px}
[data-agent-notice][hidden]{display:none}
[data-agent-notice] p{flex:1 1 auto;margin:0}
[data-agent-notice] button{font:inherit}${AGENT_UI_BASE_STYLES}`;

/** The builder's words for the person, in the wrapper's text locale and catalog, widened with AGENT_EN. */
function wordsOf(wrapper: DatumFormBuilderElement): ReturnType<typeof agentWords> {
  const words = agentWords();
  words.locale = wrapper.textLocale;
  words.catalog = wrapper.textCatalog;
  return words;
}

/**
 * The deepest element focus is on inside the wrapper, through every open shadow root below its
 * own (the shell's, a panel's, the inspector's), or `undefined` when focus is not in the wrapper.
 */
function deepestFocus(wrapper: DatumFormBuilderElement): Element | undefined {
  let active = wrapper.shadowRoot?.activeElement ?? null;
  if (active === null) {
    return undefined;
  }
  while (active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * The banner, the notice row and the live region of one `<datum-form-builder>`. Each is looked up
 * again before use: the wrapper builds its shadow DOM on its first connection (replacing whatever
 * was there), and a later attachment (a features toggle, a move in the DOM) finds the ones an
 * earlier one left and adopts them, so there is one of each per element however often it registers.
 */
class BuilderAgentUi {
  private banner: HTMLElement | undefined;
  private notice: HTMLElement | undefined;
  private live: HTMLElement | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly wrapper: DatumFormBuilderElement) {}

  ensure(): { banner: HTMLElement; notice: HTMLElement; live: HTMLElement } | undefined {
    const root = this.wrapper.shadowRoot;
    if (root === null) {
      return undefined;
    }
    if (this.banner === undefined || !root.contains(this.banner)) {
      this.banner = root.querySelector<HTMLElement>("[data-agent-banner]") ?? undefined;
    }
    if (this.notice === undefined || !root.contains(this.notice)) {
      this.notice = root.querySelector<HTMLElement>("[data-agent-notice]") ?? undefined;
    }
    if (this.live === undefined || !root.contains(this.live)) {
      this.live = root.querySelector<HTMLElement>("[data-agent-live]") ?? undefined;
    }
    const words = wordsOf(this.wrapper);
    if (!root.querySelector("style[data-agent-styles]")) {
      const style = document.createElement("style");
      style.setAttribute("data-agent-styles", "");
      style.textContent = BUILDER_AGENT_STYLES;
      root.append(style);
    }
    // Beside the Download warning, above the builder: the first things in the element, outside
    // the shell that goes inert. Without the builder yet (an attachment before the first
    // connection), at the end; the wrapper's first build replaces them and they are made again.
    const before = root.querySelector("datum-builder");
    const place = (el: HTMLElement): void => {
      if (before !== null && before.parentNode === root) {
        root.insertBefore(el, before);
      } else {
        root.append(el);
      }
    };
    if (this.banner === undefined) {
      const banner = document.createElement("div");
      banner.setAttribute("data-agent-banner", "");
      banner.setAttribute("role", "region");
      banner.setAttribute("aria-label", words.text("agent.banner.label"));
      banner.hidden = true;
      place(banner);
      this.banner = banner;
    }
    if (this.notice === undefined) {
      const notice = document.createElement("div");
      notice.setAttribute("data-agent-notice", "");
      notice.setAttribute("role", "group");
      notice.setAttribute("aria-label", words.text("agent.notice.label"));
      notice.hidden = true;
      place(notice);
      this.notice = notice;
    }
    if (this.live === undefined) {
      const live = document.createElement("div");
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-label", words.text("agent.live.label"));
      live.setAttribute("data-agent-live", "");
      root.append(live);
      this.live = live;
    }
    return { banner: this.banner, notice: this.notice, live: this.live };
  }

  announce(text: string): void {
    const ui = this.ensure();
    if (ui === undefined) {
      return;
    }
    // Cleared first so the same sentence twice is still a change assistive technology reads.
    ui.live.textContent = "";
    ui.live.textContent = text;
  }

  /** Shows the banner with `text` and `buttons`; focus on the banner stays on it, on the first new button. */
  show(text: string, buttons: HTMLButtonElement[]): void {
    const ui = this.ensure();
    if (ui === undefined) {
      return;
    }
    const hadFocus = this.focusIn(ui.banner);
    ui.banner.setAttribute("aria-label", wordsOf(this.wrapper).text("agent.banner.label"));
    ui.banner.replaceChildren();
    const line = document.createElement("p");
    line.setAttribute("data-agent-banner-text", "");
    line.textContent = text;
    ui.banner.append(line, ...buttons);
    ui.banner.hidden = false;
    if (hadFocus) {
      buttons[0]?.focus();
    }
  }

  /**
   * Hides the banner. Focus is not moved into the shell: a caret in the inspector would only
   * refuse the agent's next write, and the person's sequential focus goes on from where the
   * button was.
   */
  hide(): void {
    if (this.banner === undefined) {
      return;
    }
    this.banner.hidden = true;
    this.banner.replaceChildren();
  }

  /** The notice row: `text` and one action, replacing any notice already up; gone after 20 s. */
  showNotice(text: string, action?: { label: string; run(): void }): void {
    const ui = this.ensure();
    if (ui === undefined) {
      return;
    }
    this.stopNoticeTimer();
    const line = document.createElement("p");
    line.setAttribute("data-agent-notice-text", "");
    line.textContent = text;
    const buttons: HTMLButtonElement[] = [];
    if (action !== undefined) {
      buttons.push(
        button("notice-action", action.label, () => {
          // One press: the row goes before the steps are taken back (they are this write's alone).
          // The button goes with it, so a person on it is given a place to go on from: the bar's
          // history buttons (where the same step is taken back or again), as the Download
          // warning's Dismiss gives its place back to the file menu.
          const hadFocus = this.focusIn(ui.notice);
          this.clearNotice();
          action.run();
          if (hadFocus) {
            this.focusHistory();
          }
        })
      );
    }
    ui.notice.replaceChildren(line, ...buttons);
    ui.notice.hidden = false;
    this.armNoticeTimer();
  }

  /** Removes the notice row if one shows. */
  clearNotice(): void {
    this.stopNoticeTimer();
    if (this.notice === undefined) {
      return;
    }
    this.notice.hidden = true;
    this.notice.replaceChildren();
  }

  private armNoticeTimer(): void {
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      // The person is on its button: it stays until they leave it (never pulled from under them).
      if (this.notice !== undefined && this.focusIn(this.notice)) {
        this.armNoticeTimer();
        return;
      }
      this.clearNotice();
    }, AGENT_NOTICE_MS);
  }

  private stopNoticeTimer(): void {
    if (this.noticeTimer !== undefined) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
  }

  /**
   * Focus on the shell's bar after the notice's button went: Redo (what the notice's Undo just
   * filled), else Undo, else the file menu; the first that is there and enabled takes it. The
   * bar follows the controller synchronously, so the step just run is already reflected.
   */
  private focusHistory(): void {
    const shellRoot = this.wrapper.builder?.shadowRoot;
    if (!shellRoot) {
      return;
    }
    for (const selector of ["[data-redo]", "[data-undo]", "[data-file-menu]"]) {
      const target = shellRoot.querySelector<HTMLElement>(selector);
      if (target === null || (target instanceof HTMLButtonElement && target.disabled) || target.closest("[hidden]") !== null) {
        continue;
      }
      target.focus();
      if (shellRoot.activeElement === target) {
        return;
      }
    }
  }

  /** Whether focus is on `el` or inside it. */
  focusIn(el: HTMLElement | undefined): boolean {
    const active = this.wrapper.shadowRoot?.activeElement ?? null;
    return active !== null && el !== undefined && el.contains(active);
  }

  focusInBanner(): boolean {
    return this.focusIn(this.banner);
  }

  /** Dismiss: the banner goes, and `onDismiss` (the closed state's) lets the catalogue forget it. */
  dismissButton(onDismiss?: () => void): HTMLButtonElement {
    return button("dismiss", wordsOf(this.wrapper).text("agent.dismiss"), () => {
      this.hide();
      onDismiss?.();
    });
  }

  /** What a withdrawn registration leaves: no banner, no notice, an empty live region, no inert shell. */
  reset(): void {
    this.hide();
    this.clearNotice();
    if (this.live !== undefined) {
      this.live.textContent = "";
    }
    this.wrapper.builder?.toggleAttribute("inert", false);
  }
}

/**
 * Whether the person's Leave would ask first on `controller` (what `requestLeave` holds for, in its
 * order: a prompt already up, the selection's draft, the root's, an editor outside the tree holding
 * edits). The document waiter never calls the shell's `selectDocument` then, so it never raises
 * the prompt on the person's behalf; the tools pre-check the same.
 */
function leaveHeld(controller: BuilderController): boolean {
  if (controller.unsavedChangesPrompt() !== undefined) {
    return true;
  }
  for (const subject of [controller.selectedComponentId(), controller.rootId()]) {
    if (subject !== undefined && controller.hasPendingChanges(subject)) {
      return true;
    }
  }
  return controller.hasPendingLeaveGuard();
}

/** `promise`, or a rejection once `ms` have passed (the timer goes either way). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms.`)), ms);
    promise.then(
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
 * The journeys' actions 1:1 over the Journeys mode: each member
 * is the one mode method of the same meaning, with the same arguments, and nothing else, so the
 * catalogue's journal and refusals read the mode exactly as the person's menu leaves it.
 */
function journeyActions(mode: JourneyBuilderMode): JourneyActions {
  return {
    list: () => mode.documents?.list() ?? [],
    opensAs: () => mode.opensAs,
    journeys: () => mode.journeys,
    // The getter, never the reseeding setter.
    configuration: () => mode.journeyConfiguration,
    newJourney: (options) => mode.newJourney(options),
    addJourney: (journey) => mode.addJourney(journey),
    rename: (id, name) => mode.renameJourney(id, name),
    duplicate: (id, options) => mode.duplicateJourney(id, options),
    chooseOpensAs: (id) => mode.chooseOpensAs(id),
    remove: (id) => mode.removeJourney(id),
    applyCatalog: (next, subjectId) => mode.applyCatalogForAgent(next, subjectId)
  };
}

/**
 * The PDF layouts' actions 1:1 over the PDF mode. One addition of
 * the host's: a preview asked for while the mode was never on the page has no dialog root of its
 * own, so it is given the shell's, as the Try it path gives it.
 */
function pdfActions(mode: PdfBuilderMode, shell: () => DatumBuilderElement | undefined): PdfActions {
  return {
    list: () => mode.documents?.list() ?? [],
    layouts: () => mode.layouts,
    defaultLayoutId: () => mode.pdfConfiguration.defaultLayoutId,
    // The getter, never the setter (which starts every designer over).
    configuration: () => mode.pdfConfiguration,
    newLayout: (options) => mode.newLayout(options),
    addLayout: (layout) => mode.addLayout(layout),
    addTemplate: (source, name) => mode.addTemplateLayout(source, name),
    rename: (id, name) => mode.renameLayout(id, name),
    duplicate: (id, options) => mode.duplicateLayout(id, options),
    setDefault: (id) => mode.setDefaultLayout(id),
    move: (id, toIndex) => mode.moveLayout(id, toIndex),
    remove: (id) => mode.removeLayout(id),
    applyCatalog: (next, subjectId) => mode.applyCatalogForAgent(next, subjectId),
    openState: () => mode.openState(),
    whenOpenReady: (timeoutMs) => mode.whenOpenReady(timeoutMs),
    suggestMappings: (options) => mode.suggestMappings(options),
    createFormFields: (options) => mode.createFormFields(options),
    previewReport(options) {
      const root = options.root ?? shell()?.shadowRoot ?? undefined;
      return mode.previewReport(root !== undefined ? { ...options, root } : options);
    },
    layoutController: () => (mode.layoutId !== undefined ? mode.controller : undefined)
  };
}

/**
 * The `BuilderToolHost` over a `<datum-form-builder>`: readiness
 * from the wrapper's package-internal `agentBuildState`, the controller and the composed
 * definition from the wrapper, and the page (`ui`) through the wrapper and the shell's agent
 * seams. `resetUi()` is the attachment's cleanup.
 */
export function elementBuilderHost(wrapper: DatumFormBuilderElement): BuilderToolHost & { resetUi(): void } {
  const view = new BuilderAgentUi(wrapper);
  // The live region goes in now, empty, so the first announcement is a change a screen reader reads.
  view.ensure();
  const loaders = shellLoaders();
  const words = () => wordsOf(wrapper);

  const ui: BuilderToolUi = {
    workspace: () => wrapper.workspace,
    availableWorkspaces: () => wrapper.builder?.availableWorkspaces() ?? ["form"],
    setWorkspace: (id: BuilderWorkspace) => wrapper.setWorkspace(id),
    mode: () => wrapper.mode,
    panel: () => wrapper.builder?.panel,
    panelOff: (id) => wrapper.builder?.panelHidden(id) ?? true,
    panelMovesWorkspace: (id) => wrapper.builder?.panelWorkspaceTarget(id as NonNullable<typeof wrapper.builder.panel>) !== undefined,
    setPanel(id) {
      const shell = wrapper.builder;
      if (shell !== undefined) {
        shell.panel = id;
      }
    },
    trying: () => wrapper.builder?.trying ?? false,
    setTrying: (on) => wrapper.builder?.setTrying(on) ?? false,
    // The feature and a surface the person could try: a designer's
    // tryable canvas counts too (a journey's Pages view), so no `mode === "form"` any
    // more; the shell's own gate says false on Logic, Data, Languages, an overview and the map.
    // Tree writes still refuse `wrong-mode` in a designer.
    canTry: () => wrapper.featureEnabled("try-it") && wrapper.builder?.tryable === true,
    triedAnswers: () => wrapper.triedAnswers(),
    clearTriedAnswers: () => wrapper.clearTriedAnswers(),
    dirty: () => wrapper.dirty,
    workspaceProblems: () => ({ ...(wrapper.builder?.workspaceProblems ?? {}) }),
    pdfFindings() {
      // The wrapper's own gate and call shape (its PDF tab count): eager, never a chunk.
      const definition = wrapper.definition;
      if (!definition.pdf || !wrapper.featureEnabled("pdf")) {
        return undefined;
      }
      const locale = definition.localization?.defaultLocale ?? "en";
      return pdfLayoutConditionFindings({ formRoot: definition.root, locale }, definition.pdf);
    },
    journeyDiagnostics() {
      // Only once the Journeys tab's count (or debug) has loaded the diagnostics; never a fetch.
      const diagnose = journeyDiagnosticsLoaded();
      if (diagnose === undefined || !wrapper.featureEnabled("journeys")) {
        return undefined;
      }
      const definition = wrapper.definition;
      return definition.journey === undefined ? [] : diagnose(definition);
    },
    onOutsideChange(listener) {
      const heard = (event: Event): void => {
        const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode;
        if (mode === "pdf" || mode === "journeys") {
          listener();
        }
      };
      wrapper.addEventListener("datum-builder-change", heard);
      return () => wrapper.removeEventListener("datum-builder-change", heard);
    },
    focusInTextControl() {
      const deepest = deepestFocus(wrapper);
      return deepest instanceof HTMLElement && (isCaretControl(deepest) || deepest.isContentEditable === true);
    },
    revealComponent(id) {
      wrapper.builder?.revealComponent(id);
    },
    highlight(ids) {
      wrapper.builder?.highlightComponents(ids, AGENT_HIGHLIGHT_MS);
    },
    announce(text) {
      view.announce(text);
    },
    notice(text, action) {
      view.showNotice(text, action);
    },
    clearNotice() {
      view.clearNotice();
    },
    setSessionUi(state: BuilderSessionUi) {
      const shell = wrapper.builder;
      const text = words();
      if ("stopped" in state) {
        shell?.toggleAttribute("inert", false);
        view.show(text.plural("agent.session.stopped", state.undone, { count: state.undone }), [
          button("allow-again", text.text("agent.allowAgain"), () => {
            view.hide();
            state.onAllowAgain();
          }),
          view.dismissButton()
        ]);
        return;
      }
      if (state.open) {
        // The shell goes inert (which blurs any focused control in it), then focus moves to
        // Stop, the one recorded exception to "never steal focus". Only when focus was
        // in this builder or nowhere: a field outside it (the page's own chat box) is not blurred
        // by inert, and taking focus from it is the theft "never steal focus" forbids. A resumed session
        // (a new purpose) only redraws the banner: focus on it stays on the new Stop.
        // In this builder counts the page's own controls slotted into the shell (toolbar, strip,
        // panel...): light-DOM children of the wrapper, which `inert` reaches through the flat
        // tree and blurs, while the wrapper's shadow root reports no active element for them.
        const active = document.activeElement;
        const inBuilder = wrapper.shadowRoot?.activeElement != null || (active !== null && active !== wrapper && wrapper.contains(active));
        const takeFocus = state.resumed !== true && (inBuilder || active === null || active === document.body);
        // An open session is the banner's account of the work: no notice row beside it.
        view.clearNotice();
        shell?.toggleAttribute("inert", true);
        const stop = button("stop", text.text("agent.stop"), () => state.onStop());
        view.show(text.text("agent.banner.working", { purpose: state.purpose }), [stop]);
        if (takeFocus) {
          stop.focus();
        }
        return;
      }
      shell?.toggleAttribute("inert", false);
      const onUndoAll = state.onUndoAll;
      if (onUndoAll === undefined && state.paused !== true) {
        // The hide convention: ended with nothing to show, or the person moved on.
        view.hide();
        return;
      }
      const buttons: HTMLButtonElement[] = [];
      const dismiss = view.dismissButton(state.onDismiss);
      const line = state.paused === true ? text.text("agent.session.paused") : text.text("agent.session.ended", { summary: state.summary ?? "" });
      if (onUndoAll !== undefined && state.undoAvailable > 0) {
        const undoAll = button("undo-all", text.text("agent.undoAll", { count: state.undoAvailable }), () => {
          // The person is on Undo all: their place moves to Dismiss before the button goes. The
          // catalogue then draws the line again with Dismiss alone, and show() keeps
          // focus on the banner's first button: the new Dismiss.
          if (view.focusInBanner()) {
            dismiss.focus();
          }
          undoAll.remove();
          onUndoAll();
        });
        buttons.push(undoAll);
      }
      buttons.push(dismiss);
      // End moves no focus from elsewhere; focus already on the banner stays on it (show()).
      view.show(line, buttons);
    },

    // ---- one call on the shell, the canvas or a
    // mode each; what the person's controls do, minus the asking.

    // A getter on the shell; never called before the host reads ready, so the shell is there.
    activeController: () => (wrapper.builder?.activeController ?? wrapper.controller) as BuilderController,
    // The agent's own step, the way the person's Undo goes: through the mode's history first.
    historyStep(controller, direction) {
      const shell = wrapper.builder;
      if (shell) {
        shell.historyStep(direction, controller, { own: true });
      } else if (direction === "undo") {
        controller.undo();
      } else {
        controller.redo();
      }
    },
    leaveGuardSubject: () => wrapper.builder?.activeController.leaveGuardSubject(),
    managedSettings: () => [...(wrapper.builder?.managedSettings ?? [])],
    setBinding: (id) => wrapper.builder?.setBindingForAgent(id) ?? false,
    setPreviewLocale(code) {
      wrapper.builder?.setPreviewLocale(code);
    },
    // The shell's own inputs, never recomputed here (the header rows come from a shell-private module).
    languageInputs: () => wrapper.builder?.agentLanguageInputs() ?? { extraTexts: [], pdfTexts: [], notLoaded: [] },
    languagesPending: () => wrapper.builder?.agentLanguagesPending() ?? 0,
    tryIt: () => tryItAdapter(),
    journeys(): DesignerSide<JourneyActions> {
      const state = wrapper.agentModeState.journeys;
      const mode = wrapper.journeyMode;
      if (state !== "ready" || mode === undefined) {
        return { state: state === "ready" ? "loading" : state };
      }
      return {
        state: "ready",
        workspace: () => "journeys",
        openId: () => mode.journeyId,
        controller: () => (mode.journeyId !== undefined ? mode.controller : undefined),
        actions: journeyActions(mode)
      };
    },
    pdfLayouts(): DesignerSide<PdfActions> {
      const state = wrapper.agentModeState.pdf;
      const mode = wrapper.pdfMode;
      if (state !== "ready" || mode === undefined) {
        return { state: state === "ready" ? "loading" : state };
      }
      return {
        state: "ready",
        workspace: () => "pdf",
        openId: () => mode.layoutId,
        controller: () => (mode.layoutId !== undefined ? mode.controller : undefined),
        actions: pdfActions(mode, () => wrapper.builder)
      };
    },
    selectDocument: (side, id) => selectDocument(side, id),
    async pdfTemplates(): Promise<PdfTemplateOption[]> {
      const resolver = wrapper.pdfTemplates;
      if (typeof resolver?.list !== "function") {
        return [];
      }
      const offered = await within(resolver.list(), AGENT_TEMPLATES_WAIT_MS, "The site's template list");
      // The labels the PDF designer's Add menu shows: its locale (PBM falls back to "en") and the
      // option's own locales, so the agent names the button the person can see. The option's
      // label is host data: the host's catalog does not reach it.
      const locale = wrapper.agentPdfLocale() ?? "en";
      return offered.map((option) => ({ templateId: option.id, label: resolveLocalizedText(option.label, locale) ?? option.id, source: option.source }));
    },
    triedRuntimeForPdf: () => wrapper.agentTriedRuntime(),
    hostRuntimeForPdf: () => wrapper.agentSampleRuntime(),
    saveAvailable: () => wrapper.builder?.saveAvailable(),
    save: () => wrapper.builder?.requestSave() ?? Promise.resolve({ status: "no-save" as const })
  };

  /**
   * Try it as the agent drives it, over the shell's `agentTryParts()`: `undefined` before the shell has drawn a canvas. Each member reaches the canvas the
   * shell has when it is called, so a rebuilt canvas is followed; `chunk()` is the canvas's own
   * account of the Try it chunk.
   */
  function tryItAdapter(): TryItAdapter | undefined {
    const shell = wrapper.builder;
    const parts = shell?.agentTryParts();
    if (shell === undefined || parts === undefined) {
      return undefined;
    }
    return {
      tryable: () => ui.canTry(),
      trying: () => shell.trying,
      start: () => shell.setTrying(true),
      ready: () => parts.tryReady(),
      runtime: () => parts.triedRuntime(),
      typed() {
        const state = parts.triedRuntime()?.state();
        return state === undefined ? { values: {}, dirty: new Set<string>() } : { values: { ...state.values }, dirty: new Set(state.dirty) };
      },
      where() {
        const workspace = wrapper.workspace;
        if (workspace === "journeys") {
          const journeyId = wrapper.journeyMode?.journeyId;
          return journeyId !== undefined ? { workspace, journeyId } : { workspace };
        }
        return { workspace: workspace === "pdf" ? "pdf" : "form" };
      },
      pageIdOf: (nodeId) => parts.tryPageIdOf(nodeId),
      nodeIdOf: (pageId) => parts.tryNodeIdOf(pageId),
      quietPageFocus: () => parts.quietTriedPageFocus(),
      focusedPath: () => parts.focusedTriedPath(),
      recording: () => parts.tryRecording(),
      showing: () => parts.tryShowing(),
      serverChecks: () => parts.tryServerChecks(),
      onSubmit: (listener) => parts.onTrySubmit(listener),
      check: () => parts.agentTryCheck(),
      submit: () => parts.agentTrySubmit(),
      clear: () => wrapper.clearTriedAnswers(),
      chunk: () => parts.tryChunkState()
    };
  }

  /**
   * Puts a journey or a layout on the page through the shell's `selectDocument` (the person's
   * route: the tab, the dropdown), never a mode's own selection of a journey or a layout, and
   * waits for it to be up: `opened` on the shell's `builder-document-change` (or
   * `builder-mode-change`) that shows it, `failed` on its `builder-mode-error` or when something
   * the person has not answered holds the page, `timeout` after 10 s.
   */
  function selectDocument(side: "journeys" | "pdf", id: string): Promise<SelectDocumentOutcome> {
    const shell = wrapper.builder;
    const mode = side === "journeys" ? wrapper.journeyMode : wrapper.pdfMode;
    if (shell === undefined || mode === undefined) {
      return Promise.resolve({ status: "failed", message: "That designer is not on the page." });
    }
    const shown = (): boolean => shell.mode === side && mode.documents?.selectedId() === id;
    if (shown()) {
      return Promise.resolve({ status: "opened" });
    }
    if (leaveHeld(shell.activeController)) {
      return Promise.resolve({ status: "failed", message: "Edits the person has not applied hold the page where it is." });
    }
    return new Promise<SelectDocumentOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: SelectDocumentOutcome): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        shell.removeEventListener("builder-document-change", moved);
        shell.removeEventListener("builder-mode-change", moved);
        shell.removeEventListener("builder-mode-error", failed);
        resolve(outcome);
      };
      const moved = (): void => {
        if (shown()) {
          finish({ status: "opened" });
        }
      };
      const failed = (event: Event): void => {
        const detail = (event as CustomEvent<{ mode?: string; error?: unknown }>).detail;
        if (detail?.mode === side) {
          finish({ status: "failed", message: detail.error instanceof Error ? detail.error.message : String(detail.error) });
        }
      };
      const timer = setTimeout(() => finish({ status: "timeout" }), AGENT_DOCUMENT_WAIT_MS);
      shell.addEventListener("builder-document-change", moved);
      shell.addEventListener("builder-mode-change", moved);
      shell.addEventListener("builder-mode-error", failed);
      let started: boolean;
      try {
        started = shell.selectDocument(side, id);
      } catch (error) {
        finish({ status: "failed", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!started) {
        // Held after all (the pre-check above makes this a race): the person answers, not the agent.
        finish({ status: "failed", message: "Edits the person has not applied hold the page where it is." });
        return;
      }
      moved();
    });
  }

  const host: BuilderToolHost & { resetUi(): void } = {
    id: wrapper.id,
    connected: () => wrapper.isConnected && wrapper.featureEnabled("agent"),
    controller: () => wrapper.controller,
    ready: () => wrapper.agentBuildState === "ready",
    definition: (): FormDefinition => wrapper.definition,
    signatures: () => [...formulaFunctionSignatures(), ...(wrapper.builder?.formulaFunctions?.signatures() ?? [])],
    formulaFunctions: () => wrapper.builder?.formulaFunctions,
    dataSources: () => wrapper.controller?.dataSources(),
    featureOn: (feature) => wrapper.featureEnabled(feature),
    definitionProblem: (definition) => definitionLoadProblem(definition),
    formDefinitionProblem: (definition) => formDefinitionProblem(definition),
    loadTests: loaders.loadTests,
    formulaEditorLoaded: loaders.formulaEditorLoaded,
    // The data-model planner : the same memoised loader the Data surface's chunk uses.
    loadDataModelKit: loaders.loadDataModelKit,
    words,
    ui,
    emit(type: AgentEventType, detail: unknown) {
      emit(wrapper, type, detail);
    },
    resetUi() {
      view.reset();
    }
  };
  return host;
}
