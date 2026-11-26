/**
 * The Journeys and PDF overviews. Entering
 * the Journeys or the PDF workspace shows that side's own overview where the canvas is: its
 * documents as cards with their status, Open into the designer, and + New. Journeys lists the
 * journeys with what each asks and its problems; PDF lists the layouts in the order their rules
 * are tried. Loaded in a chunk of its own the first time either overview opens
 * (`overview-loader.ts`).
 *
 * It reads the whole definition and writes nothing: opening a card hands over to the designer.
 */
import type { BuilderController } from "../controller/builder-controller.js";
import { builderTokens, esc } from "../web-component/builder-shared.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { journeyPageFormIds } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import { kernelFoldHoldsOwnAnswer } from "../../core/state/submittable-fold.js";
import { pdfLayoutConditionFindings } from "../pdf-designer/layout-conditions.js";
import { pdfLayoutLabel, pdfLayoutsOf } from "../pdf-designer/layout-catalog.js";
import { journeyLabel } from "../journey-designer/journey-catalog.js";
import { missingLayoutBindings } from "../pdf-designer/layout-bindings.js";
import { conditionSentence } from "../logic/logic-model.js";
import type { BuilderTextCatalog } from "../logic/builder-texts.js";
import { areaWords } from "./overview-texts-en.js";

export const DATUM_BUILDER_OVERVIEW_TAG = "datum-builder-overview";

/** The overview drawn: the journeys or the PDF layouts. */
export type OverviewSection = "journeys" | "pdf";

/** Detail of `overview-open`: a card's Open, into that document's designer. */
export interface OverviewOpenDetail {
  mode: OverviewSection;
  documentId?: string | undefined;
}

/** Detail of `overview-add`: "+ New journey" or "+ New layout", the mode's own add flow. */
export interface OverviewAddDetail {
  mode: OverviewSection;
}

type JourneyDiagnoser = (definition: { root: ComponentNode; journey?: unknown }) => Array<{ severity: "error" | "warning"; journeyId: string }>;

let diagnoserLoad: Promise<JourneyDiagnoser> | undefined;

/** The journey diagnostics, from the chunk they already ride in; a failed load is tried again. */
function loadDiagnoser(): Promise<JourneyDiagnoser> {
  if (!diagnoserLoad) {
    const next = import("../../core/journey/journey-diagnostics.js").then((module) => module.diagnoseJourneys as unknown as JourneyDiagnoser);
    next.catch(() => {
      if (diagnoserLoad === next) {
        diagnoserLoad = undefined;
      }
    });
    diagnoserLoad = next;
  }
  return diagnoserLoad;
}

export class DatumBuilderOverviewElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private ctrl: BuilderController | undefined;
  private unsubscribe: (() => void) | undefined;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private modeIds: readonly string[] = [];
  private sectionValue: OverviewSection = "journeys";
  /** Journey errors by journey, once the diagnostics ran over this definition. */
  private journeyErrors: { signature: string; byJourney: Map<string, number> } | undefined;
  private diagnosing: string | undefined;
  /** The definition (by signature) whose diagnostics failed to load: shown as "Couldn't check", not asked for again until it changes. */
  private diagnoseFailed: string | undefined;
  private bound = false;
  /** The builder's words (the text catalog) for the overview's own lines. */
  private readonly words = areaWords();

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.paint();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.paint();
    }
  }

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  public connectedCallback(): void {
    this.bind();
    this.subscribe();
    this.paint();
  }

  public disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Listens to the controller's changes while the surface is on the page. A surface the shell drops
   * (a reconnect replaces its markup) would otherwise stay in the controller's listener list for
   * the controller's life, so it lets go on disconnect and takes the listener again on connect.
   * The controller itself stays: the setter owns that, and clearing it would also clear the
   * controller's single leave-guard slot.
   */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.ctrl?.on("change", (event) => {
      if (event.reason !== "select" && event.reason !== "preview") {
        this.paint();
      }
    });
  }

  /** The form's controller: its changes repaint the overview. */
  public set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctrl = value;
    if (this.isConnected) {
      this.subscribe();
    }
    this.paint();
  }

  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  /** The whole definition: journeys and PDF layouts included. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
    this.paint();
  }

  /** The modes the page has: New is offered only where its mode is. */
  public set modes(ids: readonly string[]) {
    this.modeIds = ids;
    this.paint();
  }

  /** Which overview is drawn: the journeys or the PDF layouts. */
  public get section(): OverviewSection {
    return this.sectionValue;
  }

  public set section(value: OverviewSection) {
    const next: OverviewSection = value === "pdf" ? "pdf" : "journeys";
    if (next === this.sectionValue) {
      return;
    }
    this.sectionValue = next;
    this.paint();
  }

  /** Repaints from the definition as it stands (the shell calls it on entering the overview, and when a mode's documents change). */
  public refresh(): void {
    this.paint();
  }

  /**
   * Puts focus on the card of `documentId` (its Open), else on New, else on the heading: where
   * focus lands when the author comes back from a designer.
   */
  public focusCard(documentId?: string): void {
    const open =
      documentId === undefined
        ? undefined
        : [...this.root.querySelectorAll<HTMLElement>("[data-overview-open]")].find((button) => button.dataset.documentId === documentId);
    const target = open ?? this.root.querySelector<HTMLElement>("[data-overview-add]") ?? this.root.querySelector<HTMLElement>("#overview-heading");
    target?.focus({ preventScroll: true });
  }

  // --- painting ---------------------------------------------------------------------

  private paint(): void {
    if (!this.isConnected) {
      return;
    }
    const definition = this.definitionSource?.() ?? (this.ctrl ? ({ id: "form", version: "1", root: this.ctrl.snapshot() } as FormDefinition) : undefined);
    if (!definition) {
      this.root.innerHTML = `<style>${builderTokens()}${OVERVIEW_STYLES}</style><div class="overview"><p class="empty">${esc(this.words.text("overview.empty"))}</p></div>`;
      return;
    }
    // The preview language names the cards: a journey or a layout reads in the language
    // the author is previewing, from the form's translations, not always in the default one.
    const locale = this.ctrl?.currentLocale() ?? definition.localization?.defaultLocale ?? "en";
    const section = this.sectionValue === "pdf" ? this.pdfHtml(definition, locale) : this.journeysHtml(definition, locale);
    // A repaint (the journeys' checks arriving, a document added elsewhere) keeps focus on the same control.
    const focused = this.root.activeElement as HTMLElement | null;
    const kept = focused
      ? {
          open: focused.dataset.overviewOpen !== undefined ? focused.dataset.documentId : undefined,
          add: focused.dataset.overviewAdd !== undefined,
          heading: focused.id === "overview-heading"
        }
      : undefined;
    this.root.innerHTML = `<style>${builderTokens()}${OVERVIEW_STYLES}</style>
      <div class="overview" data-overview-section="${this.sectionValue}">${section}</div>`;
    if (kept) {
      const again =
        (kept.open !== undefined ? [...this.root.querySelectorAll<HTMLElement>("[data-overview-open]")].find((button) => button.dataset.documentId === kept.open) : undefined) ??
        (kept.add ? this.root.querySelector<HTMLElement>("[data-overview-add]") : null) ??
        (kept.heading || kept.open !== undefined ? this.root.querySelector<HTMLElement>("#overview-heading") : null);
      again?.focus({ preventScroll: true });
    }
  }

  private problemsText(count: number): string {
    return this.words.plural("problems.count", count);
  }

  private status(kind: "ok" | "problems" | "pending", label: string): string {
    return `<span class="status status--${kind}">${kind === "problems" ? '<span class="status-mark" aria-hidden="true">!</span>' : ""}${esc(label)}</span>`;
  }

  private journeysHtml(definition: FormDefinition, locale: string): string {
    this.diagnose(definition);
    const root = definition.root;
    const journeys = definition.journey?.journeys ?? [];
    // The default journey is only what the form opens as while `opensAs` is not "form".
    const opensAsForm = definition.journey?.opensAs === "form";
    const defaultId = opensAsForm ? undefined : (definition.journey?.defaultJourneyId ?? journeys[0]?.id);
    const answers = countAnswers(root);
    const errors = this.journeyErrors?.byJourney;
    const total = errors ? [...errors.values()].reduce((sum, count) => sum + count, 0) : undefined;
    const w = this.words;
    const sectionStatus =
      journeys.length === 0
        ? ""
        : total === 0
          ? this.status("ok", w.text("overview.noProblems"))
          : total === undefined
            ? this.diagnoseFailed !== undefined && this.diagnoseFailed === JSON.stringify([definition.root, definition.journey])
              ? this.status("problems", w.text("overview.checkFailed"))
              : this.status("pending", w.text("overview.pending"))
            : this.status("problems", this.problemsText(total));
    const cards = journeys
      .map((journey) => {
        const name = journeyLabel(journey, locale, { translations: this.ctrl?.translations(), catalog: this.ctrl?.translationCatalog() });
        const pages = journey.pages.length;
        const asked = countAsked(root, journey.pages.flatMap((page) => journeyPageFormIds(page)));
        const detail = w.text("overview.journey.detail", {
          pages: w.plural("overview.pages", pages),
          asked,
          answers,
          first: journey.id === defaultId ? w.text("overview.journey.first") : ""
        });
        const count = errors?.get(journey.id) ?? 0;
        return this.cardHtml({
          title: name,
          detail,
          status: count > 0 ? this.status("problems", this.problemsText(count)) : "",
          action: `<button type="button" class="btn small" data-overview-open="journeys" data-document-id="${esc(journey.id)}" aria-label="${esc(w.text("overview.open.label", { name }))}">${esc(w.text("overview.open"))}</button>`
        });
      })
      .join("");
    const add = this.modeIds.includes("journeys")
      ? `<li><button type="button" class="add" data-overview-add="journeys">${esc(w.text("overview.new.journey"))}</button></li>`
      : "";
    return `<section class="section card" aria-labelledby="overview-heading">
        <header class="section-head"><h2 class="card-title" id="overview-heading" tabindex="-1">${esc(w.text("overview.journeys"))}</h2>${sectionStatus}</header>
        ${journeys.length === 0 ? `<div class="empty-state" data-overview-journeys-none><p>${esc(w.text("overview.journeys.none"))}</p></div>` : ""}
        <ul class="cards">${cards}${add}</ul>
      </section>`;
  }

  private pdfHtml(definition: FormDefinition, locale: string): string {
    const layouts = pdfLayoutsOf(definition.pdf);
    const findings = pdfLayoutConditionFindings({ formRoot: definition.root, locale }, definition.pdf);
    // Bindings whose field the form no longer has: they print blank, and nothing said so.
    const missing = missingLayoutBindings(definition.root, definition.pdf);
    const defaultId = definition.pdf?.defaultLayoutId ?? layouts[0]?.id;
    const w = this.words;
    const problemCount = findings.length + missing.length;
    const status =
      layouts.length === 0
        ? ""
        : problemCount === 0
          ? this.status("ok", w.text("overview.noProblems"))
          : this.status("problems", this.problemsText(problemCount));
    const cards = layouts
      .map((layout, index) => {
        const name = pdfLayoutLabel(layout, locale, { translations: this.ctrl?.translations(), catalog: this.ctrl?.translationCatalog() });
        const when = (layout as PdfLayoutDocument & { when?: unknown }).when;
        const condition = when ? conditionSentence(when as never, { root: definition.root, locale }).map((token) => token.text).join("").replace(/\s+/g, " ").trim() : "";
        const kind = w.text(layout.kind === "template" ? "overview.kind.template" : "overview.kind.generated");
        const parts = [kind, layout.id === defaultId ? w.text("overview.default") : "", condition ? w.text("overview.when", { condition }) : ""].filter(Boolean);
        const own = [
          ...findings.filter((finding) => finding.layoutId === layout.id).map((finding) => finding.message),
          ...missing.filter((binding) => binding.layoutId === layout.id).map((binding) => w.text("overview.pdf.missingField", { name: binding.name }))
        ];
        return this.cardHtml({
          index: layouts.length > 1 ? index + 1 : undefined,
          title: name,
          detail: parts.join(w.text("overview.sep")),
          // Each problem on its own line: a missing field is not hidden behind a condition's finding.
          status: own.map((message) => `<span class="status status--problems" data-overview-problem><span class="status-mark" aria-hidden="true">!</span>${esc(message)}</span>`).join(""),
          action: `<button type="button" class="btn small" data-overview-open="pdf" data-document-id="${esc(layout.id)}" aria-label="${esc(w.text("overview.open.label", { name }))}">${esc(w.text("overview.open"))}</button>`
        });
      })
      .join("");
    const add = this.modeIds.includes("pdf") ? `<li><button type="button" class="add" data-overview-add="pdf">${esc(w.text("overview.new.layout"))}</button></li>` : "";
    return `<section class="section card" aria-labelledby="overview-heading">
        <header class="section-head"><h2 class="card-title" id="overview-heading" tabindex="-1">${esc(w.text("overview.pdf.title"))}</h2>${status}</header>
        ${
          layouts.length > 1
            ? `<p class="card-lead">${esc(w.text("overview.pdf.order"))}</p>`
            : layouts.length === 0
              ? `<div class="empty-state" data-overview-pdf-none><p>${esc(w.text("overview.pdf.none"))}</p></div>`
              : ""
        }
        <ol class="cards${layouts.length > 1 ? " cards--numbered" : ""}">${cards}${add}</ol>
      </section>`;
  }

  private cardHtml(card: { index?: number | undefined; title: string; detail: string; status: string; action: string }): string {
    return `<li class="out-card">
        ${card.index !== undefined ? `<span class="out-index" aria-hidden="true">${card.index}</span>` : ""}
        <div class="out-text"><strong>${esc(card.title)}</strong><span class="muted">${esc(card.detail)}</span>${card.status}</div>
        ${card.action}
      </li>`;
  }

  // --- diagnostics --------------------------------------------------------------------

  /** Counts each journey's errors once per definition; the overview shows "Not checked yet" until then. */
  private diagnose(definition: FormDefinition): void {
    if (!definition.journey?.journeys?.length) {
      this.journeyErrors = { signature: "", byJourney: new Map() };
      return;
    }
    const signature = JSON.stringify([definition.root, definition.journey]);
    if (this.journeyErrors?.signature === signature || this.diagnosing === signature || this.diagnoseFailed === signature) {
      return;
    }
    this.diagnosing = signature;
    loadDiagnoser().then(
      (diagnose) => {
        const byJourney = new Map<string, number>();
        for (const finding of diagnose({ root: definition.root, journey: definition.journey })) {
          if (finding.severity === "error") {
            byJourney.set(finding.journeyId, (byJourney.get(finding.journeyId) ?? 0) + 1);
          }
        }
        if (this.diagnosing === signature) {
          this.diagnosing = undefined;
          this.journeyErrors = { signature, byJourney };
          this.paint();
        }
      },
      (cause: unknown) => {
        if (this.diagnosing !== signature) {
          return;
        }
        this.diagnosing = undefined;
        this.diagnoseFailed = signature;
        // Said, not silent: the status reads "Couldn't check" and the host hears it.
        this.paint();
        this.dispatchEvent(new CustomEvent("datum-error", { bubbles: true, composed: true, detail: { code: "file.unavailable", message: this.words.text("overview.checkFailedEvent"), cause } }));
      }
    );
  }

  // --- events -----------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const open = target.closest<HTMLElement>("[data-overview-open]");
      if (open) {
        this.dispatchEvent(
          new CustomEvent<OverviewOpenDetail>("overview-open", {
            detail: { mode: open.dataset.overviewOpen as OverviewSection, documentId: open.dataset.documentId },
            bubbles: true,
            composed: true
          })
        );
        return;
      }
      const add = target.closest<HTMLElement>("[data-overview-add]");
      if (add) {
        this.dispatchEvent(new CustomEvent<OverviewAddDetail>("overview-add", { detail: { mode: add.dataset.overviewAdd as OverviewSection }, bubbles: true, composed: true }));
      }
    });
  }
}

/** How many answers the form holds. */
function countAnswers(root: ComponentNode): number {
  let count = 0;
  const walk = (node: ComponentNode): void => {
    if (node.id !== root.id && kernelFoldHoldsOwnAnswer(node)) {
      count += 1;
    }
    for (const group of Object.values(node.children ?? {})) {
      group.forEach(walk);
    }
  };
  walk(root);
  return count;
}

/** How many answers the components `ids` bring, each with its subtree. */
function countAsked(root: ComponentNode, ids: readonly string[]): number {
  const wanted = new Set(ids);
  let count = 0;
  const walk = (node: ComponentNode, inside: boolean): void => {
    const on = inside || wanted.has(node.id);
    if (on && node.id !== root.id && kernelFoldHoldsOwnAnswer(node)) {
      count += 1;
    }
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child, on);
      }
    }
  };
  walk(root, false);
  return count;
}

const OVERVIEW_STYLES = `
  :host { display: block; height: 100%; min-height: 0; container-type: inline-size; }
  .overview {
    box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; padding: var(--db-gap, 12px);
    display: grid; align-content: start; justify-items: center;
    font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
  }
  .muted { color: var(--db-ink-muted); }
  .section { box-sizing: border-box; inline-size: 100%; max-inline-size: 720px; padding: var(--db-space-4); display: grid; gap: var(--db-space-3); }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-2); }
  .section-head h2:focus { outline: none; }
  .section-head h2:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; border-radius: var(--db-radius-xs); }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-2); }
  .out-card {
    display: flex; align-items: center; gap: var(--db-space-3); padding: var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-lg); background: var(--db-surface);
  }
  .out-index { display: grid; place-items: center; inline-size: 24px; block-size: 24px; flex: none; border-radius: 50%; background: var(--db-surface-sunken); font-size: var(--db-text-sm); font-weight: 600; }
  .out-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .out-text .muted { font-size: var(--db-text-sm); }
  .status { display: inline-flex; align-items: center; gap: var(--db-space-1); font-size: var(--db-text-sm); font-weight: 500; }
  .status--ok { color: var(--db-ok); }
  .status--ok::before { content: ""; inline-size: 8px; block-size: 8px; border-radius: 50%; background: currentColor; }
  .status--pending { color: var(--db-ink-muted); }
  .status--problems { color: var(--db-danger); }
  .status-mark { display: grid; place-items: center; inline-size: 16px; block-size: 16px; border-radius: 50%; background: var(--db-danger); color: var(--db-surface); font-size: var(--db-text-xs); font-weight: 700; }
  .add {
    inline-size: 100%; min-block-size: 40px; border: var(--db-border-w) dashed var(--db-line-input); border-radius: var(--db-radius-lg);
    background: transparent; color: var(--db-ink); font: inherit; font-weight: 500; cursor: pointer;
  }
  .add:hover { background: var(--db-surface-hover); }
  .add:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  @media (pointer: coarse) { .add { min-block-size: 44px; } }
`;

export function defineBuilderOverview(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_OVERVIEW_TAG)) {
    customElements.define(DATUM_BUILDER_OVERVIEW_TAG, DatumBuilderOverviewElement);
  }
}

defineBuilderOverview();
