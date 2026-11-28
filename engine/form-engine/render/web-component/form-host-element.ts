import type { DataSourceSet } from "../../core/schema/contracts.js";
import { HTMLElementBase, adoptPreUpgradeProperties, canDefineCustomElements } from "./custom-element-base.js";
import type { ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import { createFormTextResolver, type FormTextCatalog } from "../../core/localization/form-texts.js";
import { FormEventType } from "../../core/events/event-types.js";
import type { FormNotice, FormNoticePlacement } from "../../core/submission/form-notice.js";
import type { RenderMode } from "../core/render-contracts.js";
import type { LiveAssets, LiveBinding } from "../live/contract.js";
import type { PrintTheme } from "../print/theme.js";
import type { PrintRendition } from "../print/model.js";
import { bindingById, onBindingsChanged } from "../live/binding-registry.js";
import type { FileStorageResolver } from "../core/file-storage.js";
import { LANGUAGE_SWITCHER_PART_TYPE, type FormChromeConfiguration } from "../../core/schema/form-chrome.js";
import {
  DatumFormRendererElement,
  defineDatumFormRendererElement,
  type PrintCallOptions,
  type PrintRenditionsOffered,
  type RenderHostRuntime
} from "./form-renderer-element.js";
import type { RenderFormPdfOptions } from "../pdf/pdf-service.js";
import { defaultIconSet, renderIcon, type IconSet } from "../icons/icon-set.js";
import type { DatumIconName } from "../icons/icon-names.js";
import type { PdfUnknownComponentPolicy } from "../pdf/pdf-abi.js";
import type { PdfFontProvider, PdfImageResolver, PdfRenderProvider, PdfSigner, PdfTemplateResolver } from "../pdf/pdf-provider.js";
import type { PdfSignatureOptions } from "./form-renderer-element.js";
import type { PdfThemeDefinition, PdfThemeSource } from "../pdf/pdf-theme.js";
import { resolveJourneySelection, type JourneyConfiguration, type JourneyHostChoice } from "../../core/schema/journey.js";
import { parseFormFeatures, type FormFeature } from "./form-features.js";
import { readPrintConfiguration } from "../../core/schema/print.js";

export const DATUM_FORM_HOST_TAG = "datum-form-host";

/**
 * The toolbar's glyphs by the name each button draws from the icon set: a checked
 * clipboard for Validate, a printer for Print, a document for PDF in the Font Awesome set.
 */
const TOOLBAR_GLYPHS: ReadonlyArray<DatumIconName> = ["validate", "print", "pdf"];

/**
 * What `<datum-form-host>` drives: the renderer's contract ({@link RenderHostRuntime}; locale
 * switching belongs to the renderer), and what the host's
 * `journey` asks of a runtime — its journeys, and starting or leaving one. Those
 * are optional: a runtime without them (the builder's preview) runs no journey, and
 * `journey` leaves it alone. `FormRuntime` satisfies it structurally.
 */
export interface DatumFormHostRuntime extends RenderHostRuntime {
  journeyConfiguration?(): JourneyConfiguration | undefined;
  startJourney?(journeyId?: string, options?: { pageId?: string }): unknown;
  leaveJourney?(): void;
}

const STYLES = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .host { display: grid; gap: 10px; }
  .host-actions-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Icon and label side by side by default; a host that wants icon-only buttons hides the
     label through its part (the button's aria-label and title carry the name regardless). */
  .validate-btn, .print-btn, .pdf-btn {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid #a9bbcb; border-radius: 8px; background: #eef3f8;
    padding: 6px 10px; font: inherit; cursor: pointer;
  }
  /* The PDF controls exist only once a provider is wired; a form without one has no PDF. */
  .pdf-btn[hidden], .pdf-layout[hidden], .print-btn[hidden] { display: none; }
  .pdf-layout { font: inherit; padding: 5px 8px; border: 1px solid #a9bbcb; border-radius: 8px; background: #fff; }
  .pdf-btn[aria-busy="true"] { opacity: 0.6; cursor: progress; }
  /* The glyph must never be the hit target — the click belongs to the button. */
  .glyph { display: inline-flex; align-items: center; pointer-events: none; }
  .validate-btn svg, .print-btn svg, .pdf-btn svg { pointer-events: none; }
  /* The Print menu, when the form offers more than one rendition: under the button, one choice a row. */
  .print-wrap { position: relative; display: inline-flex; }
  .print-wrap[hidden], .print-menu[hidden] { display: none; }
  .print-menu {
    position: absolute; z-index: 1; top: calc(100% + 4px); inset-inline-start: 0;
    display: grid; min-width: max-content; padding: 4px;
    border: 1px solid #a9bbcb; border-radius: 8px; background: #fff;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
  }
  .print-option { font: inherit; text-align: start; border: 0; border-radius: 6px; background: none; padding: 6px 10px; cursor: pointer; }
  .print-option:hover, .print-option:focus { background: #eef3f8; }
`;

/** Each rendition's word in the Print menu (form texts). */
const PRINT_RENDITION_TEXT: Readonly<Record<PrintRendition, "printAnswers" | "printBlank" | "printFilled">> = {
  answers: "printAnswers",
  blank: "printBlank",
  filled: "printFilled"
};

/**
 * Default composition around the renderer web component: a row of host controls (slot
 * `"actions"` — e.g. Restore/Clear draft buttons — beside its own Validate and Print buttons),
 * with `<datum-form-renderer>` below rendering the form itself.
 *
 * The language switcher is not on that row: it is form chrome, drawn by the renderer inside
 * the form where the binding that draws the form can dress it. `languageSwitcher` is the short
 * form of asking for one — a switcher at the top of the form over the form's own locales,
 * under the labels the form authored — and `chrome` the long form, choosing header
 * or footer and the switcher's label. The renderer applies a pick to `runtime.setLocale()`,
 * reverts the control when the runtime rejects it (an unsupported locale), and reports either
 * outcome as `datum-locale-applied` / `datum-locale-rejected`; both bubble through this
 * element, so a host listens here.
 *
 * The shadow tree exposes CSS parts so a host can dress the composition without owning it:
 * `::part(actions)` is the controls row, `::part(validate)` its Validate button,
 * `::part(print)` its Print button (which prints the form through the renderer, see
 * `DatumFormRendererElement.print`), and `::part(form)` the renderer the form draws in —
 * enough to float the row as a toolbar and put the form on a sheet, the way the builder's
 * canvas presents them. Each button is an icon beside a text label; the labels are parts too
 * (`::part(validate-label)`, `::part(print-label)`), so a host can hide them for an icon-only
 * toolbar without losing the buttons' names, which their aria-label and title carry.
 *
 * A form that offers more than one print rendition (`configuration.print.renditions`) turns
 * the Print button into a menu button: it opens `::part(print-menu)`, a menu of the renditions
 * offered in the form's order, each a `::part(print-option)` worded by the form texts
 * `printAnswers`, `printBlank` and `printFilled`. Arrow keys, Home and End move through it,
 * Escape closes it back onto the button, and a choice prints that rendition. A form that offers
 * one keeps the plain button, which prints the form's default rendition.
 *
 * A form's buttons report intent as `datum-form-action` and the host acts on it (the host owns
 * the submission mode and version context `runtime.submit` needs). A journey's own Submit on
 * its last page reports the same way: `action: "submit"`, as a submit button's
 * does, with `componentId` the form root's — no button of the form was pressed — and
 * `journey` naming the journey and the page. It passes through this element untouched, so
 * the host's one handler submits both. `journey` (property or attribute) is the host's say in
 * which journey the runtime runs: a journey's id, `"form"` for the whole form on one page,
 * `"journey"` for the definition's default journey, or unset for the definition's choice.
 */
export class DatumFormHostElement extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ["journey", "features"];
  }

  private readonly root: ShadowRoot;
  private rendererEl: DatumFormRendererElement | undefined;
  private runtimeRef: DatumFormHostRuntime | undefined;
  private modeValue: RenderMode = "interactive";
  private bindingValue: LiveBinding | string | undefined;
  private assetsValue: LiveAssets | undefined;
  private printThemeValue: PrintTheme | undefined;
  private colorSchemeValue: "light" | "dark" | undefined;
  private messagesValue: ValidationMessageCatalog | undefined;
  private textsValue: FormTextCatalog | undefined;
  private noticeValue: FormNotice | undefined;
  private submittingPlacementValue: FormNoticePlacement[] | undefined;
  private chromeValue: FormChromeConfiguration | undefined;
  private dataSourcesValue: DataSourceSet | undefined;
  private fileStorageValue: FileStorageResolver | undefined;
  private languageSwitcherValue = false;
  private pdfProviderValue: PdfRenderProvider | undefined;
  private pdfFontsValue: PdfFontProvider | undefined;
  private pdfTemplatesValue: PdfTemplateResolver | undefined;
  private pdfImagesValue: PdfImageResolver | undefined;
  private pdfThemeValue: PdfThemeDefinition | undefined;
  private pdfThemesValue: PdfThemeSource | undefined;
  private pdfUnknownComponentsValue: PdfUnknownComponentPolicy | undefined;
  private pdfSignerValue: PdfSigner | undefined;
  private pdfSignatureValue: PdfSignatureOptions | undefined;
  private iconsValue: IconSet | undefined;
  private journeyValue: JourneyHostChoice = undefined;
  private featuresValue: string | undefined;
  /** The list read once, for the controls the host draws itself; `undefined` is every feature. */
  private featureSet: ReadonlySet<FormFeature> | undefined;
  /** Set once the `journey` choice has been warned about as ignored (`journeys` left out); cleared when the list or the choice changes. */
  private warnedJourneysLeftOut = false;
  /** The unknown journey id last warned about: once per choice, not once per runtime handed over. */
  private warnedJourneyId: string | undefined;
  private pdfBusy = false;
  /** Set while a print the toolbar started is in flight: a press meanwhile starts no second one. */
  private printBusy = false;
  /** Off-switches for the runtime events the toolbar's wording follows (the locale). */
  private unsubLocale: Array<() => void> = [];
  /** Stops hearing the binding registry (a binding registered after `binding = "id"` brings its words). */
  private stopBindings: (() => void) | undefined;
  /**
   * The picker's value the person chose themselves (`""` for Automatic); `undefined` until they
   * choose. Only their choice survives a refresh: a value the host put there is recomputed, so
   * a layout that gains a `when` turns the picker to Automatic rather than keep sending an id.
   */
  private pdfLayoutPicked: string | undefined;
  /** The renditions the Print menu lists; empty while the button prints at once (one offered). */
  private printMenuRenditions: PrintRendition[] = [];
  /** Closes the Print menu when the person presses outside it; set while it is open. */
  private stopPrintMenuOutside: (() => void) | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    defineDatumFormRendererElement();
  }

  public connectedCallback(): void {
    adoptPreUpgradeProperties(this);
    // Built once: an element moved or put back keeps its toolbar, its listeners and the renderer
    // inside it, which keeps its form across a move within one task as a bare renderer does.
    if (!this.rendererEl) {
      this.buildDom();
    } else {
      this.refreshPrintControls();
      this.applyToolbarTexts();
    }
    this.followLocale();
    // The binding this host names by id may be registered (or replaced) later: the toolbar takes its words then.
    this.stopBindings ??= onBindingsChanged(() => {
      if (typeof this.bindingValue === "string") {
        this.applyToolbarTexts();
      }
    });
  }

  public disconnectedCallback(): void {
    this.closePrintMenu(false);
    this.stopFollowingLocale();
    this.stopBindings?.();
    this.stopBindings = undefined;
  }

  private stopFollowingLocale(): void {
    for (const off of this.unsubLocale) {
      off();
    }
    this.unsubLocale = [];
  }

  private followLocale(): void {
    this.stopFollowingLocale();
    const events = this.isConnected ? this.runtimeRef?.events?.() : undefined;
    if (events) {
      this.unsubLocale.push(events.subscribe(FormEventType.LOCALE_CHANGED, () => this.applyToolbarTexts()));
    }
  }

  /**
   * Words the toolbar's buttons and layout picker (labels, titles, accessible names) in the
   * form's current locale through the form-texts catalog; run again when the locale, the
   * page's texts or the theme change, since the markup is built before any of them is known.
   */
  private applyToolbarTexts(): void {
    const runtime = this.runtimeRef;
    const text = createFormTextResolver(
      runtime?.state?.().locale ?? "en",
      this.textsValue,
      undefined,
      { translations: runtime?.translations?.(), catalog: runtime?.translationCatalog?.(), pack: this.bindingPack() }
    );
    const name = (selector: string, label: string, visible?: { selector: string; text: string }): void => {
      const el = this.root.querySelector<HTMLElement>(selector);
      if (!el) {
        return;
      }
      el.setAttribute("aria-label", label);
      if (el.localName !== "select") {
        el.setAttribute("title", label);
      }
      if (visible) {
        const span = el.querySelector<HTMLElement>(visible.selector);
        if (span) {
          span.textContent = visible.text;
        }
      }
    };
    name("[data-validate]", text("validateLabel"), { selector: '[part="validate-label"]', text: text("validateLabel") });
    name("[data-print]", text("printLabel"), { selector: '[part="print-label"]', text: text("printLabel") });
    const menu = this.root.querySelector<HTMLElement>("[data-print-menu]");
    if (menu) {
      menu.setAttribute("aria-label", text("printLabel"));
      for (const option of menu.querySelectorAll<HTMLElement>("[data-print-rendition]")) {
        const rendition = option.dataset.printRendition as PrintRendition;
        const key = PRINT_RENDITION_TEXT[rendition];
        if (key !== undefined) {
          option.textContent = text(key);
        }
      }
    }
    name("[data-pdf-layout]", text("pdfLayoutLabel"));
    name("[data-pdf]", text("downloadPdfLabel"), { selector: '[part="pdf-label"]', text: text("pdfLabel") });
  }

  public set runtime(value: DatumFormHostRuntime | undefined) {
    this.runtimeRef = value;
    this.followLocale();
    // A host that chose a journey keeps it across the runtimes it hands over (a rebuild per
    // edit): taken up before the renderer paints the new one.
    if (this.journeyValue !== undefined) {
      this.applyJourney();
    }
    if (this.rendererEl) {
      this.rendererEl.runtime = value;
    }
    this.refreshPrintControls();
    this.applyToolbarTexts();
    this.refreshPdfControls();
  }

  public get runtime(): DatumFormHostRuntime | undefined {
    return this.runtimeRef;
  }

  public attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "journey") {
      this.journey = value?.trim() || undefined;
    }
    if (name === "features") {
      // An empty attribute is an empty list (the same as `minimal`), not an absent one.
      this.features = value === null ? undefined : value.trim();
    }
  }

  /**
   * The features that exist: a space or comma list, forwarded to the inner renderer
   * as its own `features` attribute (the renderer is the element that reads it, with the same
   * meaning it has on `<datum-form>`: absent, every feature exists; present, only the listed
   * ones, an empty list being `minimal`). The host also reads it for what it draws itself: no
   * Print button without `print`, no PDF controls without `pdf`, and no `journey` choice
   * without `journeys`. The `features` attribute.
   */
  public set features(value: string | string[] | undefined) {
    this.featuresValue = value === undefined || value === null ? undefined : Array.isArray(value) ? value.join(" ") : value;
    this.featureSet = this.featuresValue === undefined ? undefined : new Set(parseFormFeatures(this.featuresValue).features);
    this.warnedJourneysLeftOut = false;
    this.forwardFeatures();
    this.applyFeatureControls();
    if (this.journeyValue !== undefined) {
      this.applyJourney();
    }
  }

  public get features(): string | undefined {
    return this.featuresValue;
  }

  private allows(feature: FormFeature): boolean {
    return this.featureSet === undefined || this.featureSet.has(feature);
  }

  /** Shows the controls the list leaves in (the PDF ones follow {@link refreshPdfControls}). */
  private applyFeatureControls(): void {
    this.refreshPrintControls();
    this.refreshPdfControls();
  }

  /**
   * Re-reads the renditions the form offers into the Print control: hidden without `print`; a
   * plain button for one rendition; a menu button over the renditions for more than one. For a
   * host whose form's print settings change while it runs (a designer beside it): the control is
   * read when the runtime or the features are set, and when the button is pressed.
   */
  public refreshPrintControls(): void {
    const button = this.root.querySelector<HTMLButtonElement>("[data-print]");
    const wrap = this.root.querySelector<HTMLElement>("[data-print-wrap]");
    const menu = this.root.querySelector<HTMLElement>("[data-print-menu]");
    if (!button || !wrap || !menu) {
      return;
    }
    const allowed = this.allows("print");
    button.hidden = !allowed;
    wrap.hidden = !allowed;
    const offered = allowed && this.rendererEl ? this.rendererEl.printRenditions.offered : [];
    const renditions = offered.length > 1 ? offered : [];
    const same = renditions.length === this.printMenuRenditions.length && renditions.every((rendition, index) => rendition === this.printMenuRenditions[index]);
    if (same) {
      return;
    }
    this.closePrintMenu(false);
    this.printMenuRenditions = renditions;
    if (renditions.length === 0) {
      button.removeAttribute("aria-haspopup");
      button.removeAttribute("aria-expanded");
      button.removeAttribute("aria-controls");
      menu.replaceChildren();
      return;
    }
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", menu.id);
    menu.replaceChildren(
      ...renditions.map((rendition) => {
        const option = this.ownerDocument.createElement("button");
        option.type = "button";
        option.className = "print-option";
        option.setAttribute("part", "print-option");
        option.setAttribute("role", "menuitem");
        option.tabIndex = -1;
        option.dataset.printRendition = rendition;
        return option;
      })
    );
    this.applyToolbarTexts();
  }

  /** Whether the Print menu is open. */
  private printMenuOpen(): boolean {
    const menu = this.root.querySelector<HTMLElement>("[data-print-menu]");
    return menu !== null && !menu.hidden;
  }

  /** Opens the Print menu and puts focus on its first choice (`"last"`: its last). */
  private openPrintMenu(at: "first" | "last"): void {
    const button = this.root.querySelector<HTMLButtonElement>("[data-print]");
    const menu = this.root.querySelector<HTMLElement>("[data-print-menu]");
    if (!button || !menu || this.printMenuRenditions.length === 0) {
      return;
    }
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const options = this.printMenuOptions();
    (at === "last" ? options[options.length - 1] : options[0])?.focus();
    if (!this.stopPrintMenuOutside) {
      const doc = this.ownerDocument;
      const outside = (event: Event): void => {
        const wrap = this.root.querySelector("[data-print-wrap]");
        if (wrap && !event.composedPath().includes(wrap)) {
          this.closePrintMenu(false);
        }
      };
      doc.addEventListener("pointerdown", outside, true);
      this.stopPrintMenuOutside = () => doc.removeEventListener("pointerdown", outside, true);
    }
  }

  /** Closes the Print menu; `refocus` puts focus back on the Print button. */
  private closePrintMenu(refocus: boolean): void {
    this.stopPrintMenuOutside?.();
    this.stopPrintMenuOutside = undefined;
    const button = this.root.querySelector<HTMLButtonElement>("[data-print]");
    const menu = this.root.querySelector<HTMLElement>("[data-print-menu]");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      button?.setAttribute("aria-expanded", "false");
      if (refocus) {
        button?.focus();
      }
    }
  }

  private printMenuOptions(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>("[data-print-menu] [data-print-rendition]")];
  }

  /** The Print button and its menu's keys: the menu button pattern (arrows open it and move through it, Escape closes it, Tab leaves it). */
  private onPrintKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (this.printMenuRenditions.length === 0 || !target) {
      return;
    }
    if (target.matches("[data-print]")) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openPrintMenu(event.key === "ArrowUp" ? "last" : "first");
      } else if (event.key === "Escape" && this.printMenuOpen()) {
        event.preventDefault();
        this.closePrintMenu(true);
      }
      return;
    }
    if (target.dataset.printRendition === undefined) {
      return;
    }
    const options = this.printMenuOptions();
    const at = options.indexOf(target);
    const move = (index: number): void => {
      event.preventDefault();
      options[(index + options.length) % options.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(options.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        this.closePrintMenu(true);
        break;
      case "Tab":
        this.closePrintMenu(false);
        break;
    }
  }

  /** The Print button pressed: prints at once, or opens (or closes) the menu of renditions. */
  private pressPrint(): void {
    this.refreshPrintControls();
    if (this.printMenuRenditions.length === 0) {
      void this.printOnce();
      return;
    }
    if (this.printMenuOpen()) {
      this.closePrintMenu(true);
    } else {
      this.openPrintMenu("first");
    }
  }

  /** Prints through the renderer, unless a print the toolbar started is still in flight. */
  private async printOnce(options?: PrintCallOptions): Promise<void> {
    if (!this.rendererEl || this.printBusy) {
      return;
    }
    this.printBusy = true;
    try {
      await this.rendererEl.print(options);
    } finally {
      this.printBusy = false;
    }
  }

  /**
   * The renditions the form offers a person and its default, as the inner renderer's
   * `printRenditions` gives them (`configuration.print.renditions`, `["answers"]` when it says
   * nothing), for a page or toolbar of its own that offers a choice.
   */
  public get printRenditions(): PrintRenditionsOffered {
    if (this.rendererEl) {
      return this.rendererEl.printRenditions;
    }
    // Not yet on the page (no renderer drawn): read off the runtime's form the same way.
    let configuration: unknown;
    try {
      configuration = this.runtimeRef?.formRoot()?.configuration;
    } catch {
      configuration = undefined;
    }
    const print = readPrintConfiguration(configuration);
    return { offered: [...print.renditions], default: print.defaultRendition };
  }

  private forwardFeatures(): void {
    if (!this.rendererEl) {
      return;
    }
    if (this.featuresValue === undefined) {
      this.rendererEl.removeAttribute("features");
    } else {
      this.rendererEl.setAttribute("features", this.featuresValue);
    }
  }

  /**
   * Which journey the runtime runs: a journey's id, `"form"` for the whole form on
   * one page, `"journey"` for the definition's default journey even when the definition opens
   * as a form; unset, the definition's choice. An id the form does not have is warned about,
   * and the definition decides. A change starts the journey — or leaves it for the whole form
   * — over the answers already given; the journey already running is left as it is. Kept for
   * every runtime set after it. The `journey` attribute.
   */
  public set journey(value: JourneyHostChoice) {
    this.journeyValue = value === "" ? undefined : value;
    this.warnedJourneyId = undefined;
    this.applyJourney();
  }

  public get journey(): JourneyHostChoice {
    return this.journeyValue;
  }

  private applyJourney(): void {
    const runtime = this.runtimeRef;
    if (!runtime?.startJourney || !runtime.leaveJourney) {
      return;
    }
    if (!this.allows("journeys")) {
      // The list leaves journeys out: the choice is ignored, the renderer draws the form whole,
      // and the one warning is the renderer's when the runtime runs a journey (it says so itself).
      if (this.journeyValue !== undefined && !this.warnedJourneysLeftOut && runtime.journeyView?.() === undefined) {
        this.warnedJourneysLeftOut = true;
        console.warn(`[${DATUM_FORM_HOST_TAG}] Ignoring the journey setting: the features list does not include "journeys".`);
      }
      return;
    }
    const opening = resolveJourneySelection({ journey: runtime.journeyConfiguration?.() }, this.journeyValue);
    if (opening.unknownJourneyId !== undefined && opening.unknownJourneyId !== this.warnedJourneyId) {
      this.warnedJourneyId = opening.unknownJourneyId;
      console.warn(
        `[${DATUM_FORM_HOST_TAG}] The form has no journey "${opening.unknownJourneyId}": ${
          opening.selection.kind === "journey" ? `opening its journey "${opening.selection.journeyId}" instead` : "opening the whole form instead"
        }.`
      );
    }
    const running = runtime.journeyView?.()?.journeyId;
    if (opening.selection.kind === "form") {
      if (running !== undefined) {
        runtime.leaveJourney();
      }
      return;
    }
    if (running !== opening.selection.journeyId) {
      runtime.startJourney(opening.selection.journeyId);
    }
  }

  public set mode(value: RenderMode) {
    this.modeValue = value;
    if (this.rendererEl) {
      this.rendererEl.mode = value;
    }
  }

  public get mode(): RenderMode {
    return this.modeValue;
  }

  /**
   * The design-system binding the form is drawn by (see the renderer's own property): a
   * binding, the id of one registered on the page, or nothing for Datum's. The toolbar's words
   * follow the binding's language pack.
   */
  public set binding(value: LiveBinding | string | undefined) {
    this.bindingValue = value;
    this.applyToolbarTexts();
    if (this.rendererEl) {
      this.rendererEl.binding = value;
    }
  }

  public get binding(): LiveBinding | string | undefined {
    return this.bindingValue;
  }

  /** The design system's files as the host serves them, forwarded to the renderer (see its own property). */
  public set assets(value: LiveAssets | undefined) {
    this.assetsValue = value;
    if (this.rendererEl) {
      this.rendererEl.assets = value;
    }
  }

  public get assets(): LiveAssets | undefined {
    return this.assetsValue;
  }

  /** The print theme the Print button draws the form with, forwarded to the renderer (see its own property). */
  public set printTheme(value: PrintTheme | undefined) {
    this.printThemeValue = value;
    if (this.rendererEl) {
      this.rendererEl.printTheme = value;
    }
  }

  public get printTheme(): PrintTheme | undefined {
    return this.printThemeValue;
  }

  /** The page's colour scheme, forwarded to the renderer (see its own property). */
  public set colorScheme(value: "light" | "dark" | undefined) {
    this.colorSchemeValue = value;
    if (this.rendererEl) {
      this.rendererEl.colorScheme = value;
    }
  }

  public get colorScheme(): "light" | "dark" | undefined {
    return this.colorSchemeValue;
  }

  /** The words the binding brings (its language pack), for the toolbar the host draws itself. */
  private bindingPack(): { texts: LiveBinding["texts"]; messages: LiveBinding["messages"] } | undefined {
    const value = this.bindingValue;
    const binding = typeof value === "string" ? bindingById(value) : value;
    return binding && (binding.texts !== undefined || binding.messages !== undefined)
      ? { texts: binding.texts, messages: binding.messages }
      : undefined;
  }

  public set messages(value: ValidationMessageCatalog | undefined) {
    this.messagesValue = value;
    if (this.rendererEl) {
      this.rendererEl.messages = value;
    }
  }

  public get messages(): ValidationMessageCatalog | undefined {
    return this.messagesValue;
  }

  /** The page's wording for the form's own text, forwarded to the renderer (see its own property). */
  public set texts(value: FormTextCatalog | undefined) {
    this.textsValue = value;
    this.applyToolbarTexts();
    if (this.rendererEl) {
      this.rendererEl.texts = value;
    }
  }

  public get texts(): FormTextCatalog | undefined {
    return this.textsValue;
  }

  /** The host's receipt after a delivered submission, forwarded to the renderer. */
  public set notice(value: FormNotice | undefined) {
    this.noticeValue = value;
    if (this.rendererEl) {
      this.rendererEl.notice = value;
    }
  }

  public get notice(): FormNotice | undefined {
    return this.noticeValue;
  }

  /** The ends of the form the submitting line goes at, forwarded to the renderer. */
  public set submittingPlacement(value: FormNoticePlacement[] | undefined) {
    this.submittingPlacementValue = value;
    if (this.rendererEl) {
      this.rendererEl.submittingPlacement = value;
    }
  }

  public get submittingPlacement(): FormNoticePlacement[] | undefined {
    return this.submittingPlacementValue;
  }

  /**
   * The form's chrome, forwarded to the renderer (see its own property). Set, it replaces
   * whatever {@link languageSwitcher} would have asked for.
   */
  public set chrome(value: FormChromeConfiguration | undefined) {
    this.chromeValue = value;
    this.forwardChrome();
  }

  public get chrome(): FormChromeConfiguration | undefined {
    return this.chromeValue;
  }

  /** Host-defined data sources (`defineDataSources`), forwarded to the renderer (see its own property). */
  public set dataSources(value: DataSourceSet | undefined) {
    this.dataSourcesValue = value;
    if (this.rendererEl) {
      this.rendererEl.dataSources = value;
    }
  }

  public get dataSources(): DataSourceSet | undefined {
    return this.dataSourcesValue;
  }

  /** File storages a `file` component may name, forwarded to the renderer (see its own property). */
  public set fileStorage(value: FileStorageResolver | undefined) {
    this.fileStorageValue = value;
    if (this.rendererEl) {
      this.rendererEl.fileStorage = value;
    }
  }

  public get fileStorage(): FileStorageResolver | undefined {
    return this.fileStorageValue;
  }

  /**
   * Asks for a language switcher at the top of the form, over the form's own locales; false
   * (the default) asks for none. The short form of {@link chrome} — an explicit `chrome` wins
   * over it.
   */
  public set languageSwitcher(value: boolean) {
    this.languageSwitcherValue = value;
    this.forwardChrome();
  }

  public get languageSwitcher(): boolean {
    return this.languageSwitcherValue;
  }

  /**
   * What turns the form into PDF bytes, forwarded to the renderer (see its own
   * property). Set, the toolbar gains a PDF button — and a layout picker when the form
   * declares more than one PDF layout; unset, neither exists.
   */
  public set pdfProvider(value: PdfRenderProvider | undefined) {
    this.pdfProviderValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfProvider = value;
    }
    this.refreshPdfControls();
  }

  public get pdfProvider(): PdfRenderProvider | undefined {
    return this.pdfProviderValue;
  }

  /**
   * The icon set the action row's buttons are drawn from. Unset, the default set —
   * whatever the page registered with `setDefaultIconSet`, else the engine's own drawings.
   * Setting it repaints the glyphs in place.
   */
  public set icons(value: IconSet | undefined) {
    this.iconsValue = value;
    this.paintIcons();
  }

  public get icons(): IconSet | undefined {
    return this.iconsValue;
  }

  /** Draws every toolbar glyph from the current set, and writes the set's CSS beside them. */
  private paintIcons(): void {
    const set = this.iconsValue ?? defaultIconSet();
    for (const name of TOOLBAR_GLYPHS) {
      const slot = this.root.querySelector<HTMLElement>(`[data-glyph="${name}"]`);
      if (slot) {
        slot.innerHTML = renderIcon(set, name);
      }
    }
    const style = this.root.querySelector<HTMLStyleElement>("style[data-icon-css]");
    if (style) {
      style.textContent = set.css ?? "";
    }
  }

  public set pdfFonts(value: PdfFontProvider | undefined) {
    this.pdfFontsValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfFonts = value;
    }
  }

  public get pdfFonts(): PdfFontProvider | undefined {
    return this.pdfFontsValue;
  }

  public set pdfTemplates(value: PdfTemplateResolver | undefined) {
    this.pdfTemplatesValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfTemplates = value;
    }
  }

  public get pdfTemplates(): PdfTemplateResolver | undefined {
    return this.pdfTemplatesValue;
  }

  public set pdfImages(value: PdfImageResolver | undefined) {
    this.pdfImagesValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfImages = value;
    }
  }

  public get pdfImages(): PdfImageResolver | undefined {
    return this.pdfImagesValue;
  }

  /** The `"pdf"`-target theme, forwarded to the renderer (see its own property). */
  public set pdfTheme(value: PdfThemeDefinition | undefined) {
    this.pdfThemeValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfTheme = value;
    }
  }

  public get pdfTheme(): PdfThemeDefinition | undefined {
    return this.pdfThemeValue;
  }

  /** Where PDF themes named by id are looked up, forwarded to the renderer (see its own property). */
  public set pdfThemes(value: PdfThemeSource | undefined) {
    this.pdfThemesValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfThemes = value;
    }
  }

  public get pdfThemes(): PdfThemeSource | undefined {
    return this.pdfThemesValue;
  }

  /** The unknown-component policy for PDFs, forwarded to the renderer (see its own property). */
  public set pdfUnknownComponents(value: PdfUnknownComponentPolicy | undefined) {
    this.pdfUnknownComponentsValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfUnknownComponents = value;
    }
  }

  public get pdfUnknownComponents(): PdfUnknownComponentPolicy | undefined {
    return this.pdfUnknownComponentsValue;
  }

  /** Who signs the PDFs, forwarded to the renderer (see its own property): set, the toolbar's PDF button signs. */
  public set pdfSigner(value: PdfSigner | undefined) {
    this.pdfSignerValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfSigner = value;
    }
  }

  public get pdfSigner(): PdfSigner | undefined {
    return this.pdfSignerValue;
  }

  /** The settings and timestamper that go with `pdfSigner`, forwarded to the renderer. */
  public set pdfSignature(value: PdfSignatureOptions | undefined) {
    this.pdfSignatureValue = value;
    if (this.rendererEl) {
      this.rendererEl.pdfSignature = value;
    }
  }

  public get pdfSignature(): PdfSignatureOptions | undefined {
    return this.pdfSignatureValue;
  }

  /**
   * The layout the picker currently shows; `undefined` when it offers no choice (fewer than two
   * layouts) or shows Automatic, and the form chooses.
   */
  public get selectedPdfLayoutId(): string | undefined {
    const select = this.root.querySelector<HTMLSelectElement>("[data-pdf-layout]");
    return select && !select.hidden && select.value !== "" ? select.value : undefined;
  }

  /**
   * Re-reads the runtime's PDF layouts into the layout picker. For a host whose layouts
   * change while the form runs (a designer beside it, `FormRuntimeDependencies.pdfConfiguration`
   * as a function): the picker is filled when the runtime or provider is set, and this is
   * how it learns of a layout added or renamed since.
   */
  public refreshPdfLayouts(): void {
    this.refreshPdfControls();
  }

  /**
   * Shows the PDF button once a provider is wired, and fills the layout picker from the
   * form's declared layouts — shown only when there is a choice to make. When a layout has a
   * `when` the picker leads with Automatic, which names no layout so the answers
   * choose, and starts there; otherwise it starts on the form's default (never simply the
   * first, which would override the default with an explicit id). The person's own choice is
   * kept across refreshes while the picker still offers it.
   */
  private refreshPdfControls(): void {
    const button = this.root.querySelector<HTMLButtonElement>("[data-pdf]");
    const select = this.root.querySelector<HTMLSelectElement>("[data-pdf-layout]");
    if (!button || !select || !this.rendererEl) {
      return;
    }
    const hasProvider = this.pdfProviderValue !== undefined && this.allows("pdf");
    button.hidden = !hasProvider;
    const layouts = hasProvider ? this.rendererEl.pdfLayouts() : [];
    const automatic = layouts.some((layout) => layout.conditional);
    select.innerHTML = [
      ...(automatic ? [`<option value="">${escapeAttribute(PDF_AUTOMATIC_LAYOUT_LABEL)}</option>`] : []),
      ...layouts.map((layout) => `<option value="${escapeAttribute(layout.id)}">${escapeAttribute(layout.label)}</option>`)
    ].join("");
    const offered = (value: string): boolean => (value === "" ? automatic : layouts.some((layout) => layout.id === value));
    const picked = this.pdfLayoutPicked;
    if (picked !== undefined && offered(picked)) {
      select.value = picked;
    } else {
      this.pdfLayoutPicked = undefined;
      select.value = automatic ? "" : (layouts.find((layout) => layout.isDefault) ?? layouts[0])?.id ?? "";
    }
    select.hidden = layouts.length < 2;
  }

  /**
   * Renders the form as a PDF and hands the file to the person, as the toolbar's PDF button
   * does: under the picker's layout unless `options` name one, through the renderer's
   * `downloadPdf` (so a `datum-pdf` listener can still take the bytes over). One at a time;
   * a call while one is in flight does nothing. For a host serving a `button` component's
   * `"pdf"` action.
   */
  public async downloadPdf(options: RenderFormPdfOptions = {}): Promise<void> {
    if (!this.rendererEl || this.pdfBusy) {
      return;
    }
    const button = this.root.querySelector<HTMLButtonElement>("[data-pdf]");
    this.pdfBusy = true;
    button?.setAttribute("aria-busy", "true");
    try {
      const layoutId = this.selectedPdfLayoutId;
      await this.rendererEl.downloadPdf(options.layoutId === undefined && layoutId !== undefined ? { ...options, layoutId } : options);
    } finally {
      this.pdfBusy = false;
      button?.removeAttribute("aria-busy");
    }
  }

  private async producePdf(): Promise<void> {
    await this.downloadPdf();
  }

  /**
   * Moves focus to the first error once the repaint the errors triggered has landed — to
   * the field it names, or to the summary for a form-level error such as a signing failure.
   * For a host that submits through `runtime.submit` itself after a `datum-form-action`:
   * the runtime stores the rejection and the form redraws, but nothing moves the person to
   * it unless the host asks, the way `validate()` does after its own run.
   */
  public focusFirstError(): void {
    this.rendererEl?.focusFirstError();
  }

  private effectiveChrome(): FormChromeConfiguration | undefined {
    if (this.chromeValue) {
      return this.chromeValue;
    }
    if (this.languageSwitcherValue) {
      return { header: [{ type: LANGUAGE_SWITCHER_PART_TYPE }] };
    }
    return undefined;
  }

  private forwardChrome(): void {
    if (this.rendererEl) {
      this.rendererEl.chrome = this.effectiveChrome();
    }
  }

  private buildDom(): void {
    this.root.innerHTML = `
      <style>${STYLES}</style>
      <style data-icon-css></style>
      <div class="host">
        <div class="host-actions-row" part="actions">
          <slot name="actions"></slot>
          <button type="button" class="validate-btn" part="validate" data-validate
            aria-label="Validate" title="Validate"><span class="glyph" data-glyph="validate"></span><span part="validate-label">Validate</span></button>
          <span class="print-wrap" data-print-wrap><button type="button" class="print-btn" part="print" data-print
            aria-label="Print" title="Print"><span class="glyph" data-glyph="print"></span><span part="print-label">Print</span></button><div
            class="print-menu" part="print-menu" role="menu" id="datum-print-menu" data-print-menu hidden></div></span>
          <select class="pdf-layout" part="pdf-layout" data-pdf-layout aria-label="PDF layout" hidden></select>
          <button type="button" class="pdf-btn" part="pdf" data-pdf hidden
            aria-label="Download PDF" title="Download PDF"><span class="glyph" data-glyph="pdf"></span><span part="pdf-label">PDF</span></button>
        </div>
        <datum-form-renderer part="form"></datum-form-renderer>
      </div>`;
    this.paintIcons();
    this.applyToolbarTexts();
    this.printMenuRenditions = [];

    this.rendererEl = this.root.querySelector("datum-form-renderer") as DatumFormRendererElement;

    this.forwardFeatures();
    this.rendererEl.runtime = this.runtimeRef;
    this.rendererEl.binding = this.bindingValue;
    this.rendererEl.assets = this.assetsValue;
    this.rendererEl.printTheme = this.printThemeValue;
    this.rendererEl.colorScheme = this.colorSchemeValue;
    this.rendererEl.mode = this.modeValue;
    this.rendererEl.messages = this.messagesValue;
    this.rendererEl.texts = this.textsValue;
    this.rendererEl.notice = this.noticeValue;
    this.rendererEl.submittingPlacement = this.submittingPlacementValue;
    this.rendererEl.chrome = this.effectiveChrome();
    this.rendererEl.dataSources = this.dataSourcesValue;
    this.rendererEl.fileStorage = this.fileStorageValue;
    this.rendererEl.pdfProvider = this.pdfProviderValue;
    this.rendererEl.pdfFonts = this.pdfFontsValue;
    this.rendererEl.pdfTemplates = this.pdfTemplatesValue;
    this.rendererEl.pdfImages = this.pdfImagesValue;
    this.rendererEl.pdfTheme = this.pdfThemeValue;
    this.rendererEl.pdfThemes = this.pdfThemesValue;
    this.rendererEl.pdfUnknownComponents = this.pdfUnknownComponentsValue;
    this.rendererEl.pdfSigner = this.pdfSignerValue;
    this.rendererEl.pdfSignature = this.pdfSignatureValue;
    this.root.querySelector<HTMLSelectElement>("[data-pdf-layout]")?.addEventListener("change", (event) => {
      this.pdfLayoutPicked = (event.target as HTMLSelectElement).value;
    });
    this.refreshPdfControls();
    this.refreshPrintControls();
    this.root.querySelector<HTMLElement>("[data-print-wrap]")?.addEventListener("keydown", (event) => this.onPrintKeydown(event));

    this.root.addEventListener("click", (event) => {
      // Resolved up to the button: the click usually lands on its icon or label.
      const target = (event.target as Element | null)?.closest?.<HTMLElement>("[data-validate], [data-print], [data-print-rendition], [data-pdf]");
      if (!target) {
        return;
      }
      if (target.dataset.validate !== undefined) {
        void this.rendererEl?.validate();
      }
      if (target.dataset.print !== undefined) {
        this.pressPrint();
      }
      if (target.dataset.printRendition !== undefined) {
        const rendition = target.dataset.printRendition as PrintRendition;
        this.closePrintMenu(true);
        void this.printOnce({ rendition });
      }
      if (target.dataset.pdf !== undefined) {
        void this.producePdf();
      }
    });
  }
}

/** The picker's first option once a layout has a `when`: no id is sent, and the answers choose. */
const PDF_AUTOMATIC_LAYOUT_LABEL = "Automatic (by the answers)";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function defineDatumFormHostElement(): void {
  defineDatumFormRendererElement();
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_FORM_HOST_TAG)) {
    customElements.define(DATUM_FORM_HOST_TAG, DatumFormHostElement);
  }
}
