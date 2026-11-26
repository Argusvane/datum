/**
 * The element hosts of the agent tools,
 * inside the agent chunk and never in a bundle's entry. `elementAgentHost(form)` is the
 * `FormAgentHost` the renderer catalogue runs over a `<datum-form>`: the session banner with its
 * Stop / Undo all / Allow again / Dismiss buttons and the polite live region, both appended once
 * to the element's own shadow root beside the renderer (nothing inside the renderer's shadow root
 * survives a paint); the `inert` attribute on the renderer while a session is open; the timed
 * `data-agent-touched` highlight with its one style rule appended to the renderer's
 * `extraStyles`; the focused-field rule through `document.hasFocus()`, the deepest active element
 * and the renderer's own `isCaretControl`; the render options the catalogue's memo is built with
 * (the data sources already wrapped with the renderer's timeout); the element's package-internal
 * build state; and `submit({ agent: true })`. Only the form bundle's agent chunk imports it: the
 * builder's host is `builder/agent-host.ts`, in the builder bundle's own chunk (the agent chunk is split per bundle); what both share (the highlight constants, the token-free
 * base styles, the banner's button) is `agent-ui.ts`.
 */

import type {
  AgentEventType,
  AgentSessionUi,
  FormAgentBuildState,
  FormAgentDrafts,
  FormAgentFeature,
  FormAgentHost,
  FormAgentPdf,
  FormAgentSubmitOutcome
} from "@argusvane/datum-engine/agent";
import {
  createFormTextResolver,
  isCaretControl,
  NoopJourneyRenderKit,
  timedDataSourceSet,
  type DataSourceSet,
  type FormTextResolver,
  type JourneyRenderKit,
  type LanguagePack,
  type RuntimeRenderOptions
} from "@argusvane/datum-engine";
import type { DatumFormRendererElement } from "@argusvane/datum-engine";

import { AGENT_HIGHLIGHT_MS, AGENT_HIGHLIGHT_RULE, AGENT_UI_BASE_STYLES, button } from "./agent-ui.js";
import type { DatumFormElement } from "./form-element.js";
import { emit } from "./support.js";

// Re-exported so `agent.ts` (the form chunk) keeps naming them from here.
export { AGENT_HIGHLIGHT_MS, AGENT_HIGHLIGHT_RULE };

/**
 * The banner's and the live region's own styles, inside `<datum-form>`'s shadow root: the form's
 * spacing, radius and focus tokens with the renderer's fallbacks and the text colour inherited,
 * over the shared token-free base (the hidden banner, its line and buttons, the clipped live region).
 */
const AGENT_UI_STYLES = `
[data-agent-banner]{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2,0.5rem);margin:0 0 var(--space-3,0.75rem);padding:var(--space-2,0.5rem) var(--space-3,0.75rem);border:1px solid var(--focus-ring-color,var(--color-accent,#2f6feb));border-radius:var(--radius-control,4px);font:inherit;color:inherit}${AGENT_UI_BASE_STYLES}`;

/**
 * Where focus is inside `form`, when it is there at all: `top` is the element at the form's own
 * shadow-root level, `field` the one at the renderer's (the box that carries `data-component-id`
 * and sits under `data-value-path`, a binding's custom element included), `deepest` the element
 * the caret is in, through every open shadow root below. Read from the form's own shadow root,
 * never from `document.activeElement`: inside another component's shadow root the document only
 * sees that component, and `closest()` stops at a design-system control's own shadow root.
 */
function focusIn(form: DatumFormElement): { top: Element; field: Element | undefined; deepest: Element } | undefined {
  const top = form.shadowRoot?.activeElement ?? null;
  if (top === null) {
    return undefined;
  }
  const field = form.renderer?.shadowRoot?.activeElement ?? undefined;
  let deepest: Element = top;
  while (deepest.shadowRoot?.activeElement) {
    deepest = deepest.shadowRoot.activeElement;
  }
  return { top, field, deepest };
}

/** The language pack of the binding the form is drawn by (`undefined` when it brings none): the words layer under the form's own. */
function languagePackOf(form: DatumFormElement): LanguagePack | undefined {
  const binding = form.renderer?.drawnBinding;
  return binding !== undefined && (binding.texts !== undefined || binding.messages !== undefined)
    ? { texts: binding.texts, messages: binding.messages }
    : undefined;
}

/** The catalogue's text resolver over the element's layers: the page's `texts`, the definition's `texts` translations (the runtime's catalog over them), the binding's language pack, in the form's locale. */
function textsOf(form: DatumFormElement): FormTextResolver {
  const runtime = form.runtime;
  const locale = runtime?.state().locale ?? form.locale ?? "en";
  return createFormTextResolver(locale, form.texts, runtime?.translationCatalog(), undefined, { translations: runtime?.translations(), pack: languagePackOf(form) });
}

/**
 * The banner and the live region, built once per element and kept across the renderer's paints
 * (they live in `<datum-form>`'s shadow root, not the renderer's). The banner sits before the
 * renderer so it is the first thing in the form; it is `hidden` until a session shows it.
 */
class AgentUi {
  private banner: HTMLElement | undefined;
  private live: HTMLElement | undefined;

  constructor(private readonly form: DatumFormElement) {}

  private root(): ShadowRoot | undefined {
    return this.form.shadowRoot ?? undefined;
  }

  /**
   * The banner and the live region, adopted from the shadow root when an earlier attachment (a
   * features toggle, a move in the DOM) left them there, else created: one of each per element,
   * however often it registers. Called when the host is built, so the live
   * region is in the accessibility tree, empty, before its first announcement (a region inserted
   * already filled is commonly not read).
   */
  ensure(): { banner: HTMLElement; live: HTMLElement } | undefined {
    const root = this.root();
    if (root === undefined) {
      return undefined;
    }
    if (this.banner === undefined || !root.contains(this.banner)) {
      this.banner = root.querySelector<HTMLElement>("[data-agent-banner]") ?? undefined;
    }
    if (this.live === undefined || !root.contains(this.live)) {
      this.live = root.querySelector<HTMLElement>("[data-agent-live]") ?? undefined;
    }
    if (this.banner === undefined) {
      if (!root.querySelector("style[data-agent-styles]")) {
        const style = document.createElement("style");
        style.setAttribute("data-agent-styles", "");
        style.textContent = AGENT_UI_STYLES;
        root.append(style);
      }
      const banner = document.createElement("div");
      banner.setAttribute("data-agent-banner", "");
      banner.setAttribute("role", "region");
      banner.hidden = true;
      const renderer = root.querySelector("datum-form-renderer");
      if (renderer) {
        root.insertBefore(banner, renderer);
      } else {
        root.append(banner);
      }
      this.banner = banner;
    }
    if (this.live === undefined) {
      const live = document.createElement("div");
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("data-agent-live", "");
      root.append(live);
      this.live = live;
    }
    return { banner: this.banner, live: this.live };
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

  /**
   * Shows the banner with `text` and `buttons`, worded now (the form's locale may have moved);
   * `note` is a second line under it (the ended line after a draft restore).
   */
  show(text: string, buttons: HTMLButtonElement[], note?: string): HTMLElement | undefined {
    const ui = this.ensure();
    if (ui === undefined) {
      return undefined;
    }
    const texts = textsOf(this.form);
    // Replacing the buttons drops the one the person is on (Stop, Undo all): their place is kept
    // on the first button of the new state rather than lost to the page's body.
    const hadFocus = this.focusInBanner();
    ui.banner.setAttribute("aria-label", texts("agentBannerLabel"));
    ui.banner.replaceChildren();
    const line = document.createElement("p");
    line.setAttribute("data-agent-banner-text", "");
    line.textContent = text;
    ui.banner.append(line);
    if (note !== undefined) {
      const second = document.createElement("p");
      second.setAttribute("data-agent-banner-note", "");
      second.textContent = note;
      ui.banner.append(second);
    }
    ui.banner.append(...buttons);
    ui.banner.hidden = false;
    if (hadFocus) {
      buttons[0]?.focus();
    }
    return ui.banner;
  }

  /**
   * Hides the banner (Dismiss, Allow again, a withdrawn registration). Focus is not moved into the
   * form: the first control is usually a text field, and a caret there would refuse the agent's
   * next write as field-in-use the moment the person allowed it again. The browser's sequential
   * focus starting point stays where the button was, so Tab goes on from the form's top.
   */
  hide(): void {
    if (this.banner === undefined) {
      return;
    }
    this.banner.hidden = true;
    this.banner.replaceChildren();
  }

  /** Whether focus is on the banner (one of its buttons). */
  focusInBanner(): boolean {
    const active = this.root()?.activeElement ?? null;
    return active !== null && this.banner !== undefined && this.banner.contains(active);
  }

  /** What a withdrawn registration leaves: no banner, no buttons bound to its journal, no inert body. */
  reset(): void {
    this.hide();
    if (this.live !== undefined) {
      this.live.textContent = "";
    }
    this.form.renderer?.toggleAttribute("inert", false);
  }

  dismissButton(): HTMLButtonElement {
    return button("dismiss", textsOf(this.form)("agentDismiss"), () => this.hide());
  }
}

/**
 * Which highlight owns each marked component, per renderer: the latest write to a component owns
 * its mark, so an earlier write's timer never clears a later one's outline early.
 */
const highlightOwners = new WeakMap<DatumFormRendererElement, Map<string, object>>();

/**
 * The timed highlight of a write: `data-agent-touched` on every touched
 * component or container box in the renderer's shadow root, removed 1 500 ms after the latest
 * write to it, re-applied once if a paint lands inside the window (a paint replaces the markup,
 * and with it the marks).
 */
function highlight(renderer: DatumFormRendererElement, componentIds: readonly string[]): void {
  const root = renderer.shadowRoot;
  if (root === null || componentIds.length === 0) {
    return;
  }
  let owners = highlightOwners.get(renderer);
  if (owners === undefined) {
    owners = new Map();
    highlightOwners.set(renderer, owners);
  }
  const call = {};
  for (const id of componentIds) {
    owners.set(id, call);
  }
  const mark = (on: boolean, ids: readonly string[]): void => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-component-id], [data-container-id]")) {
      const id = el.dataset.componentId ?? el.dataset.containerId;
      if (id !== undefined && ids.includes(id)) {
        el.toggleAttribute("data-agent-touched", on);
      }
    }
  };
  mark(true, componentIds);
  let reapplied = false;
  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          if (reapplied) {
            return;
          }
          reapplied = true;
          observer?.disconnect();
          mark(true, componentIds);
        })
      : undefined;
  observer?.observe(root, { childList: true, subtree: true });
  setTimeout(() => {
    observer?.disconnect();
    // Only the marks this write still owns: a later write to the same component keeps its own window.
    const mine = componentIds.filter((id) => owners.get(id) === call);
    for (const id of mine) {
      owners.delete(id);
    }
    mark(false, mine);
  }, AGENT_HIGHLIGHT_MS);
}

/**
 * The `FormAgentHost` over a `<datum-form>` : what the catalogue asks of the page.
 * Reads go to the element's public surface and its renderer; `allows()` is computed from the
 * public `features` getter (the element's own `allows` is private); the render
 * options wrap the renderer's raw data sources with `timedDataSourceSet` and its timeout, memoised
 * so the memo sees one object while neither changed; `buildState()` is the element's
 * package-internal `agentBuildState`.
 */
export function elementAgentHost(form: DatumFormElement): FormAgentHost & { resetUi(): void } {
  const ui = new AgentUi(form);
  // The live region goes in now, empty, so the first announcement is a change a screen reader reads.
  ui.ensure();
  let timed: { raw: DataSourceSet; ms: number; wrapped: DataSourceSet } | undefined;

  const allows = (feature: FormAgentFeature): boolean => {
    const list = form.features;
    return list === undefined || list.includes(feature);
  };

  const timedSources = (): DataSourceSet | undefined => {
    const renderer = form.renderer;
    const raw = renderer?.dataSources;
    if (renderer === undefined || raw === undefined) {
      timed = undefined;
      return undefined;
    }
    const ms = renderer.dataSourceTimeout;
    if (timed === undefined || timed.raw !== raw || timed.ms !== ms) {
      timed = { raw, ms, wrapped: timedDataSourceSet(raw, ms) };
    }
    return timed.wrapped;
  };

  /** True while a control inside either shadow root has focus and the document has it. */
  const hasFocusWithin = (): boolean => {
    if (!document.hasFocus()) {
      return false;
    }
    return focusIn(form) !== undefined;
  };

  const host: FormAgentHost & { resetUi(): void } = {
    id: form.id,
    locksUi: true,
    // `never` withdraws the registration, so it is not connected either.
    connected: () => form.isConnected && form.features?.includes("agent") === true && form.agentAccessPolicy !== "never",
    // The page's policy, never `never` here (nothing registers under it): `always` runs the tools
    // whatever the definition says, `definition` lets the form's `agentTools` decide.
    agentAccess: () => (form.agentAccessPolicy === "always" ? "always" : "definition"),
    runtime: () => form.runtime,
    bindingId: () => form.renderer?.drawnBinding.id,
    languagePack: () => languagePackOf(form),
    capabilitiesOf: (type) => form.renderer?.capabilitiesOf(type),
    buildState: (): FormAgentBuildState => form.agentBuildState,
    renderOptions(): Pick<RuntimeRenderOptions, "dataSources" | "journeyKit"> {
      const renderer = form.renderer;
      const journeyKit = allows("journeys") ? renderer?.journeyKit : undefined;
      const dataSources = allows("data-sources") ? timedSources() : undefined;
      return {
        ...(journeyKit !== undefined ? { journeyKit } : {}),
        ...(dataSources !== undefined ? { dataSources } : {})
      };
    },
    // The renderer's drawn kit: the loaded journeys kit when `journeys` is allowed, the Noop otherwise
    // (the catalogue reads a journey page only through it, never through journey-render.ts).
    journeyKit: (): JourneyRenderKit => (allows("journeys") ? form.renderer?.journeyKit : undefined) ?? NoopJourneyRenderKit,
    messages: () => form.messages,
    texts: () => form.texts,
    allows,
    signWith: () => form.signWith,
    drafts(): FormAgentDrafts | undefined {
      // The store kind in `<datum-form>`'s own order: no key, no draft; the
      // page's `draftStore` object; a `draft-store="server:<url>"`; else the browser's storage.
      if (!allows("drafts") || !form.draft) {
        return undefined;
      }
      return {
        // Truthy, as the element tests it: a page that cleared the property with `null` saves elsewhere.
        store: form.draftStore ? "page" : form.agentDraftsOnServer ? "server" : "browser",
        save: () => form.saveDraft(),
        restore: () => form.restoreDraft(),
        clear: () => form.clearDraft()
      };
    },
    pdf(): FormAgentPdf | undefined {
      // The condition `<datum-form>` serves a PDF button on.
      if (!allows("pdf") || (form.pdf === undefined && form.pdfSupport === undefined)) {
        return undefined;
      }
      return {
        signed: () => form.agentPdfSigns,
        layouts: () => form.pdfLayouts(),
        // The two keys the seam admits, and nothing else of the caller's object.
        download: ({ layoutId, locale }) =>
          form.downloadPdf({ ...(layoutId !== undefined ? { layoutId } : {}), ...(locale !== undefined ? { locale } : {}), agent: true })
      };
    },
    async submit(options): Promise<FormAgentSubmitOutcome> {
      const detail = await form.submit(options);
      return { accepted: detail.accepted, errors: detail.errors, result: detail.result };
    },
    setLocale(locale) {
      form.setLocale(locale);
    },
    notice: () => form.notice,
    dataSourceTimeoutMs: () => form.renderer?.dataSourceTimeout ?? 15_000,
    focusedValuePath() {
      if (!document.hasFocus()) {
        return undefined;
      }
      const focus = focusIn(form);
      if (focus === undefined || focus.field === undefined || !(focus.deepest instanceof HTMLElement) || !isCaretControl(focus.deepest)) {
        return undefined;
      }
      // The path from the box in the renderer's tree: `closest()` from inside a design-system control's own
      // shadow root (an acme-input) would never reach it.
      return focus.field.closest<HTMLElement>("[data-value-path]")?.dataset.valuePath ?? focus.field.closest<HTMLElement>("[data-component-id]")?.dataset.componentId;
    },
    painted: () => form.renderer?.painted() ?? Promise.resolve(),
    reveal(componentIds) {
      const renderer = form.renderer;
      if (renderer === undefined) {
        return;
      }
      // Appended, never replacing a host's own styles; appended again only if a host replaced them.
      if (!renderer.extraStyles.includes(AGENT_HIGHLIGHT_RULE)) {
        renderer.extraStyles = `${renderer.extraStyles}\n${AGENT_HIGHLIGHT_RULE}`;
      }
      const [first] = componentIds;
      if (first !== undefined) {
        renderer.revealComponent(first);
      }
      highlight(renderer, componentIds);
    },
    scrollTo(componentId) {
      if (hasFocusWithin()) {
        return;
      }
      const target = form.renderer?.shadowRoot?.querySelector<HTMLElement>(`[data-component-id="${componentId}"], [data-container-id="${componentId}"]`);
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center" });
      }
    },
    quietPageFocus() {
      // An agent's page move leaves focus where the person left it outside the form;
      // the renderer still paints, and quiets nothing while focus is on the page being
      // left. The release ends the quiet once navigate's move settles.
      return form.renderer?.quietNextPageFocus() ?? (() => undefined);
    },
    announce(text) {
      ui.announce(text);
    },
    setSessionUi(state: AgentSessionUi) {
      const renderer = form.renderer;
      const texts = textsOf(form);
      if ("stopped" in state) {
        renderer?.toggleAttribute("inert", false);
        ui.show(texts.plural("agentStopped", state.undone, { count: state.undone }), [
          button("allow-again", texts("agentAllowAgain"), () => {
            ui.hide();
            state.onAllowAgain();
          }),
          ui.dismissButton()
        ]);
        return;
      }
      if (state.open) {
        // The body goes inert (which blurs any focused control in it), then focus moves to Stop,
        // the one recorded exception to "never steal focus". Only when focus was in this
        // form or nowhere: a field outside the form (the page's own chat box) is not blurred by
        // inert, and taking focus from it is the theft "never steal focus" forbids. A resumed session
        // (a second begin_session that changed the purpose) only redraws the banner:
        // focus already on it stays on the new Stop (show()), and nothing else is moved.
        const active = document.activeElement;
        const takeFocus = state.resumed !== true && (focusIn(form) !== undefined || active === null || active === document.body);
        renderer?.toggleAttribute("inert", true);
        const stop = button("stop", texts("agentStop"), () => state.onStop());
        ui.show(texts("agentBanner", { purpose: state.purpose }), [stop]);
        if (takeFocus) {
          stop.focus();
        }
        return;
      }
      renderer?.toggleAttribute("inert", false);
      const onUndoAll = state.onUndoAll;
      if (onUndoAll === undefined) {
        // Ended for a reason with nothing to show (disconnected, rebuilt, cancelled, features changed).
        ui.hide();
        return;
      }
      const buttons: HTMLButtonElement[] = [];
      const dismiss = ui.dismissButton();
      if (state.undoAvailable) {
        const undoAll = button("undo-all", texts("agentUndoAll"), () => {
          // The person is on Undo all: their place moves to Dismiss before the button goes.
          if (ui.focusInBanner()) {
            dismiss.focus();
          }
          undoAll.remove();
          onUndoAll();
        });
        buttons.push(undoAll);
      }
      buttons.push(dismiss);
      // End moves no focus from elsewhere; focus already on the banner stays on it (show() above).
      // A draft restored during the session adds the catalogue's ended line, worded in
      // the form's language; with nothing after the restore to undo the banner offers Dismiss alone.
      ui.show(state.summary !== undefined ? texts("agentSessionEnded", { summary: state.summary }) : texts("agentPaused"), buttons, state.restoredNote);
    },
    settleInput() {
      form.renderer?.settleInput();
    },
    emit(type: AgentEventType, detail: unknown) {
      emit(form, type, detail);
    },
    resetUi() {
      ui.reset();
    }
  };
  return host;
}
