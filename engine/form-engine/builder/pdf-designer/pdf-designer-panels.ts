/**
 * The PDF designer's own chrome, in plain DOM: the Preview
 * dialog (the rendered bytes, with the fill report for a populated form), the Add popover the
 * bar's `+` opens (a custom layout, or a populated form over a PDF loaded or picked), and the
 * styles of the page viewer a template layout shows on the canvas (`template-pages.ts`). Drawn for `createPdfBuilderMode`, inside a `<datum-builder>`'s shadow root, under the
 * builder's own `--db-*` tokens so a builder theme restyles them.
 */
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { BuilderWords, type BuilderTextCatalog, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { areaWords, builderText } from "./pdf-texts-en.js";
import { bytesToBase64 } from "../../core/schema/file-upload.js";
import { MAX_PDF_TEMPLATE_BYTES } from "../../core/schema/pdf-layout.js";
import type { PdfTemplateSource } from "../../core/schema/pdf-layout.js";
import { escapeHtml } from "../../render/core/escape-html.js";
import { placePopover } from "../popover-place.js";
import { beginDialogDrag, captureDialogFrame, type DialogFrameState } from "../web-component/dialog-frame.js";
import type { PdfAreaReport, PdfFillReport } from "../../render/pdf/pdf-abi.js";
import type { PdfTemplateOption } from "../../render/pdf/pdf-provider.js";
import type { RenderFormPdfResult } from "../../render/pdf/pdf-service.js";
import { showBuilderModal } from "../web-component/modal-place.js";

// --- shared -------------------------------------------------------------------------------

/** Shows a dialog modally; where `showModal` is missing (jsdom), the `open` attribute stands in. */
export function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) {
      showBuilderModal(dialog);
    }
  } else {
    dialog.setAttribute("open", "");
  }
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

const esc = escapeHtml;

export { sameTemplate, sameTemplateSource, templateProvenance } from "./pdf-template-source.js";

/** A builder words handle for a locale and the host's builder texts; English when neither is set. */
function builderWords(locale: string | undefined, catalog: BuilderTextCatalog | undefined): BuilderWords {
  const words = new BuilderWords();
  words.locale = locale;
  words.catalog = catalog;
  return areaWords(words);
}

/** A host's template or profile option is host data (a `LocalizedText`), worded from its own words. */
function optionLabel(option: PdfTemplateOption, locale: string): string {
  return resolveLocalizedText(option.label, locale) ?? option.id;
}

export { PDF_DESIGNER_PANEL_STYLES } from "./pdf-panel-styles.js";

// --- the Preview dialog -------------------------------------------------------------------

/**
 * What the preview dialog says about the render: the layout and paper, how many
 * answers from Try it filled it, and whether the answers chose the layout.
 */
export interface PreviewInfo {
  /** The layout's name. */
  layoutName?: string | undefined;
  /** The paper, in words ("Letter"); absent for a populated form, whose pages are the PDF's. */
  paper?: string | undefined;
  /** How many answers TYPED in Try it filled it (not calculated or sample ones); 0 reads "no answers yet". */
  answers?: number | undefined;
  /** True when the layout was chosen by the answers, not the one open in the designer. */
  byAnswers?: boolean | undefined;
}

export interface PreviewDialog {
  show(result: RenderFormPdfResult, info?: PreviewInfo): void;
  showError(message: string): void;
  close(): void;
}

/** The layout line of the side column: the open layout, or what the answers chose and why. */
export function layoutLine(result: Pick<RenderFormPdfResult, "layoutChoice">, info: PreviewInfo, text?: BuilderTextOptions): string {
  const words = builderWords(text?.locale, text?.catalog);
  const name = info.layoutName ?? "";
  // A form with no layout prints the one derived from it, whoever chose.
  if (result.layoutChoice === "derived") {
    return info.byAnswers ? words.text("pdf.layout.derivedByAnswers") : words.text("pdf.layout.derived");
  }
  if (!info.byAnswers) {
    return name ? words.text("pdf.layout.openNamed", { name }) : words.text("pdf.layout.open");
  }
  switch (result.layoutChoice) {
    case "condition":
      return words.text("pdf.layout.byCondition", { name });
    case "default":
      return words.text("pdf.layout.byDefault", { name });
    case "fallback":
      return words.text("pdf.layout.byFirst", { name });
    default:
      return name || words.text("pdf.layout.open");
  }
}

const STATUS_KEYS: Record<string, BuilderTextKey> = {
  filled: "pdf.report.status.filled",
  cleared: "pdf.report.status.cleared",
  empty: "pdf.report.status.empty",
  overflow: "pdf.report.status.overflow",
  missing: "pdf.report.status.missing",
  unsupported: "pdf.report.status.unsupported"
};

function statusWord(status: string, words: BuilderWords): string {
  const key = STATUS_KEYS[status];
  return key !== undefined ? words.text(key) : status;
}

/** What filled each of a populated form's fields and areas, as the preview lists it. */
export function fillReportHtml(fields: readonly PdfFillReport[] | undefined, areas: readonly PdfAreaReport[] | undefined, text?: BuilderTextOptions): string {
  const words = builderWords(text?.locale, text?.catalog);
  const message = (entry: { message?: string | undefined }): string => (entry.message ? words.html("pdf.report.message", { message: esc(entry.message) }) : "");
  const rows = [
    ...(fields ?? []).map(
      (entry) =>
        `<li data-status="${esc(entry.status)}">${words.html("pdf.report.field", { field: esc(entry.pdfField), status: esc(statusWord(entry.status, words)) })}${message(entry)}</li>`
    ),
    ...(areas ?? []).map(
      (entry) =>
        `<li data-status="${esc(entry.status)}" data-area-report="${esc(entry.id)}">${words.html("pdf.report.area", {
          id: esc(entry.id),
          page: String(entry.page),
          status: esc(statusWord(entry.status, words))
        })}${entry.field ? words.html("pdf.report.areaField", { field: esc(entry.field) }) : ""}${message(entry)}</li>`
    )
  ];
  return rows.length > 0 ? `<ul class="dpd-report" data-template-report>${rows.join("")}</ul>` : "";
}

/** What the dialog asks of the mode around it: where focus goes when it closes, and how to empty Try it's answers. */
export interface PreviewDialogHooks {
  /** The dialog closed (Close, Escape, a new show replacing it): focus goes back to what opened it. */
  onClose?(): void;
  /** The builder's locale, read as the dialog paints; absent, English. */
  locale?(): string | undefined;
  /** The host's builder texts per locale, read as the dialog paints; absent, English. */
  textCatalog?(): BuilderTextCatalog | undefined;
  /** Present when the shell can clear the answers tried; absent, the Answers section offers no button. */
  clearAnswers?(): void;
}

export function createPreviewDialog(dialog: HTMLDialogElement, hooks: PreviewDialogHooks = {}): PreviewDialog {
  dialog.classList.add("dpd", "dpd-preview");
  const words = (): BuilderWords => builderWords(hooks.locale?.(), hooks.textCatalog?.());
  dialog.setAttribute("aria-label", words().text("pdf.preview.label"));
  let url: string | undefined;
  // The shell's dialog frame (dialog-frame.ts): dragged by its title, maximized, kept where the author left it across shows.
  const frame: DialogFrameState = { maximized: false };
  const release = (): void => {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Nothing to release.
      }
      url = undefined;
    }
  };
  const maximizeLabel = (): string => words().text(frame.maximized ? "pdf.preview.restore" : "pdf.preview.maximize");
  const head = (title: string, subtitle: string, actions: string): string =>
    `<div class="dpd-head" data-preview-head><div class="dpd-head__text"><h2>${esc(title)}</h2>${
      subtitle ? `<p class="dpd-head__sub" data-preview-meta>${esc(subtitle)}</p>` : ""
    }</div>${actions}<button type="button" class="icon-btn" data-action="maximize" aria-label="${esc(maximizeLabel())}" data-tip="${esc(maximizeLabel())}" aria-pressed="${frame.maximized}">${
      frame.maximized ? "⤡" : "⤢"
    }</button><button type="button" class="icon-btn" data-action="close" aria-label="${esc(words().text("pdf.preview.close"))}" data-tip="${esc(words().text("pdf.preview.close"))}">×</button></div>`;
  const syncFrame = (): void => {
    dialog.classList.toggle("maximized", frame.maximized);
    if (frame.maximized) {
      // The drag and the corner write inline coordinates; a maximized dialog fills the shell whatever they say.
      for (const property of ["inset", "margin", "left", "top", "width", "height"]) {
        dialog.style.removeProperty(property);
      }
      return;
    }
    if (frame.frame) {
      dialog.style.inset = "auto";
      dialog.style.margin = "0";
      dialog.style.left = `${frame.frame.left}px`;
      dialog.style.top = `${frame.frame.top}px`;
      dialog.style.width = `${frame.frame.width}px`;
      dialog.style.height = `${frame.frame.height}px`;
    }
  };
  let frameEl: HTMLIFrameElement | null = null;
  dialog.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const action = target?.closest<HTMLElement>("[data-action]")?.getAttribute("data-action");
    if (action === "close") {
      close();
    } else if (action === "maximize") {
      frame.maximized = !frame.maximized;
      const button = target!.closest<HTMLElement>("[data-action]")!;
      button.setAttribute("aria-pressed", String(frame.maximized));
      button.setAttribute("aria-label", maximizeLabel());
      button.setAttribute("data-tip", maximizeLabel());
      button.textContent = frame.maximized ? "⤡" : "⤢";
      syncFrame();
    } else if (action === "open-tab" && url) {
      window.open(url, "_blank", "noopener");
    } else if (action === "clear-answers") {
      hooks.clearAnswers?.();
      const section = dialog.querySelector("[data-preview-answers] p");
      if (section) {
        section.textContent = words().text("pdf.preview.cleared");
      }
      target!.closest<HTMLButtonElement>("button")!.disabled = true;
    }
    const page = target?.closest<HTMLElement>("[data-preview-page]");
    if (page && url && frameEl) {
      frameEl.src = `${url}#page=${page.getAttribute("data-preview-page")}`;
    }
  });
  dialog.addEventListener("pointerdown", (event) => {
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>("[data-preview-head]");
    // The head's buttons and the Download link keep their own behaviour.
    if (handle && !target?.closest("button, a")) {
      beginDialogDrag(event, handle, dialog, frame, () => captureDialogFrame(dialog, frame));
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const show = (result: RenderFormPdfResult, info: PreviewInfo = {}): void => {
    release();
    const w = words();
    url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: "application/pdf" })) : "";
    const answers = info.answers ?? 0;
    const pages = w.plural("pdf.pages.count", result.pageCount);
    const filled = answers > 0 ? w.plural("pdf.preview.filled", answers) : w.text("pdf.preview.noAnswers");
    const subtitle = [info.paper, pages, filled].filter((part) => part).join(" · ");
    const title = result.layoutChoice === "derived" || !info.layoutName ? w.text("pdf.preview.title") : w.text("pdf.preview.titleOf", { layout: info.layoutName });
    const actions = `<a class="btn primary" href="${esc(url)}" download="${esc(result.fileName)}" data-action="download">${esc(w.text("pdf.preview.download"))}</a><button type="button" class="btn" data-action="open-tab">${esc(w.text("pdf.preview.openTab"))}</button>`;
    const pageButtons = Array.from({ length: result.pageCount }, (_, index) => `<button type="button" class="btn small" data-preview-page="${index + 1}">${esc(w.text("pdf.page.number", { page: index + 1 }))}</button>`).join("");
    const report = result.layoutKind === "template" ? fillReportHtml(result.fields, result.areas, w.options()) : "";
    const warnings =
      result.warnings.length > 0 ? `<ul class="dpd-warnings">${result.warnings.map((warning) => `<li>${esc(`${warning.code}: ${warning.message}`)}</li>`).join("")}</ul>` : "";
    dialog.innerHTML = `${head(title, subtitle, actions)}
      <div class="dpd-preview-body">
        <iframe class="dpd-preview-frame" title="${esc(w.text("pdf.preview.label"))}" src="${esc(url)}"></iframe>
        <div class="dpd-side" data-preview-side>
          <section><h3>${esc(w.text("pdf.preview.sec.pages"))}</h3><div class="dpd-side__pages">${pageButtons}</div></section>
          <section data-preview-answers><h3>${esc(w.text("pdf.preview.sec.answers"))}</h3><p>${esc(
            answers > 0 ? w.plural("pdf.preview.fromTryIt", answers) : w.text("pdf.preview.noneYet")
          )}</p>${answers > 0 && hooks.clearAnswers ? `<button type="button" class="btn small" data-action="clear-answers">${esc(w.text("pdf.preview.clearAnswers"))}</button>` : ""}</section>
          <section data-preview-layout><h3>${esc(w.text("pdf.preview.sec.layout"))}</h3><p>${esc(layoutLine(result, info, w.options()))}</p></section>
          <section data-preview-warnings><h3>${esc(w.text("pdf.preview.sec.warnings"))}</h3>${warnings || report ? `${warnings}${report}` : `<p class="dpd-muted">${esc(w.text("pdf.preview.none"))}</p>`}</section>
        </div>
      </div>`;
    frameEl = dialog.querySelector("iframe");
    syncFrame();
    openDialog(dialog);
  };
  const showError = (message: string): void => {
    release();
    frameEl = null;
    dialog.innerHTML = `${head(words().text("pdf.preview.label"), "", "")}<p class="note" data-tone="error" data-preview-error>${esc(message)}</p>`;
    syncFrame();
    openDialog(dialog);
  };
  const close = (): void => {
    const wasOpen = dialog.open || dialog.hasAttribute("open");
    release();
    captureDialogFrame(dialog, frame);
    closeDialog(dialog);
    if (wasOpen) {
      hooks.onClose?.();
    }
  };
  return { show, showError, close };
}

// --- the Add popover ------------------------------------------------------------------------

export interface AddPopoverContext {
  locale(): string;
  /** The host's builder texts per locale, read as the popover paints; absent, English. */
  textCatalog?(): BuilderTextCatalog | undefined;
  /** The PDF forms the host provides, for a populated-form layout. */
  templates(): Promise<readonly PdfTemplateOption[]>;
  /** Whether a populated form's fields can be read now (the PDF executor is needed). Without it the layout still waits. */
  canPopulate(): boolean;
  /**
   * Why an uploaded PDF cannot become a layout, in words: it would make the form too heavy to
   * open again (see `definitionBytes` on the mode). `undefined` when it can; absent, nothing is asked.
   */
  templateProblem?(source: PdfTemplateSource): string | undefined;
  /** Whether a layout is on the page to copy. Absent: there is (a form may have none). */
  canCopy?(): boolean;
  /** A custom layout: from the form, a blank page, or a copy of the layout on the page, under the name the author confirmed. */
  onCustom(from: "form" | "blank" | "copy", name: string): void;
  /** A populated form over this PDF, under this name. */
  onTemplate(source: PdfTemplateSource, name: string): void;
  /** The name a copy of the layout on the page would be given, offered as the suggestion; absent, "Custom layout". */
  copyName?(): string | undefined;
}

export interface AddPopover {
  /**
   * Opens under `anchor` (an overview's New, or the empty state's button); with none, at the top
   * of the shell. `onDismiss` is called when it closes with no layout chosen.
   */
  open(anchor: HTMLElement | undefined, options?: { onDismiss?(): void }): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * The name offered for a layout made over an uploaded PDF: the file's stem
 * made readable, so `customer_intake-v2.pdf` is offered as "Customer intake v2" rather than
 * the stem itself. Underscores, hyphens and runs of spaces become single spaces, a lower-case
 * letter followed by a capital splits ("CustomerIntake" is "Customer Intake"), and the first
 * letter is a capital. The author confirms or types another; this is only the suggestion.
 */
export function layoutNameForFile(fileName: string, text?: BuilderTextOptions): string {
  const stem = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim();
  return stem === "" ? builderText("pdf.newName.paper", undefined, text) : stem.charAt(0).toLocaleUpperCase() + stem.slice(1);
}

export { MAX_PDF_TEMPLATE_BYTES };

/** True when "%PDF-" opens the bytes, or sits in the first 1024 bytes as the PDF specification allows. */
function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let at = 0; at + 5 <= head.length; at += 1) {
    if (head[at] === 0x25 && head[at + 1] === 0x50 && head[at + 2] === 0x44 && head[at + 3] === 0x46 && head[at + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export function createAddPopover(host: HTMLElement, context: AddPopoverContext): AddPopover {
  host.classList.add("dpd-add", "menu");
  host.setAttribute("role", "dialog");
  const words = (): BuilderWords => builderWords(context.locale(), context.textCatalog?.());
  host.setAttribute("aria-label", words().text("pdf.add.label"));
  host.hidden = true;
  let templateOptions: readonly PdfTemplateOption[] = [];
  let error: string | undefined;
  let anchorEl: HTMLElement | undefined;
  let dismissed: (() => void) | undefined;
  /** The layout being named: what was chosen waits here for the author's name, or Escape. */
  let pending: { suggestion: string; create(name: string): void } | undefined;

  const isOpen = (): boolean => !host.hidden;

  const render = (): void => {
    if (pending) {
      const w = words();
      host.innerHTML = `
      <div class="dpd-add__group" data-add-name-step>
        <label>${esc(w.text("pdf.add.name.label"))}<input type="text" data-add-name value="${esc(pending.suggestion)}" autocomplete="off" spellcheck="false"></label>
        <p class="note">${esc(w.text("pdf.add.name.hint"))}</p>
        <div class="confirm-actions">
          <button type="button" class="btn small" data-add-cancel>${esc(w.text("pdf.add.name.cancel"))}</button>
          <button type="button" class="btn small primary" data-add-confirm>${esc(w.text("pdf.add.name.confirm"))}</button>
        </div>
      </div>`;
      return;
    }
    const canPopulate = context.canPopulate();
    const locale = context.locale();
    const w = words();
    host.innerHTML = `
      <div class="dpd-add__group">
        <h3>${esc(w.text("pdf.add.custom"))}</h3>
        <button type="button" class="menu-item" data-add-custom="form">${esc(w.text("pdf.add.fromForm"))}</button>
        <button type="button" class="menu-item" data-add-custom="blank">${esc(w.text("pdf.add.blank"))}</button>
        ${context.canCopy?.() === false ? "" : `<button type="button" class="menu-item" data-add-custom="copy">${esc(w.text("pdf.add.copy"))}</button>`}
      </div>
      <div class="dpd-add__group">
        <h3>${esc(w.text("pdf.add.populate"))}</h3>
        <button type="button" class="menu-item" data-add-upload>${esc(w.text("pdf.add.load"))}</button>
        ${templateOptions
          .map((option) => `<button type="button" class="menu-item" data-add-host="${esc(option.id)}">${esc(optionLabel(option, locale))}</button>`)
          .join("")}
        <input type="file" accept="application/pdf,.pdf" data-add-file hidden>
        ${canPopulate ? "" : `<p class="note">${esc(w.text("pdf.add.noExecutor"))}</p>`}
        ${error ? `<p class="note" data-tone="error" data-add-error>${esc(error)}</p>` : ""}
      </div>`;
  };

  const place = (): void => placePopover(host, anchorEl);

  const onWindowClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    if (!path.includes(host) && !(anchorEl && path.includes(anchorEl))) {
      close();
    }
  };

  /** Asks for the layout's name, the suggestion filled in and selected so typing replaces it; Enter accepts it. */
  const askName = (suggestion: string, create: (name: string) => void): void => {
    pending = { suggestion, create };
    render();
    place();
    const input = host.querySelector<HTMLInputElement>("[data-add-name]");
    input?.focus();
    input?.select();
  };

  /** Makes the layout under the typed name; a blank box takes the suggestion. */
  const confirmName = (): void => {
    const waiting = pending;
    if (!waiting) {
      return;
    }
    const typed = host.querySelector<HTMLInputElement>("[data-add-name]")?.value.trim() ?? "";
    pending = undefined;
    close(true);
    waiting.create(typed === "" ? waiting.suggestion : typed);
  };

  const open = (anchor: HTMLElement | undefined, options: { onDismiss?(): void } = {}): void => {
    anchorEl = anchor;
    dismissed = options.onDismiss;
    error = undefined;
    pending = undefined;
    render();
    place();
    host.hidden = false;
    host.querySelector<HTMLElement>("button")?.focus();
    // On the next turn: the click that opened the popover must not close it.
    setTimeout(() => {
      if (isOpen()) {
        window.addEventListener("click", onWindowClick);
      }
    }, 0);
    void context.templates().then(
      (options) => {
        templateOptions = options;
        // Not while a name is being typed: the redraw would take the box from under the author.
        if (isOpen() && !pending) {
          // The redraw replaces the buttons: focus goes back to the one it was on, else the first.
          const root = host.getRootNode() as Document | ShadowRoot;
          const focused = root.activeElement instanceof HTMLElement && host.contains(root.activeElement) ? root.activeElement : undefined;
          const key = focused ? [...host.querySelectorAll("button")].indexOf(focused as HTMLButtonElement) : -1;
          render();
          if (focused) {
            const buttons = host.querySelectorAll<HTMLElement>("button");
            (buttons[key] ?? buttons[0])?.focus();
          }
        }
      },
      () => undefined
    );
  };

  /** Closes; `chosen` says a layout is being made, so the flow has not been dismissed. */
  const close = (chosen = false): void => {
    if (host.hidden) {
      return;
    }
    host.hidden = true;
    pending = undefined;
    window.removeEventListener("click", onWindowClick);
    const onDismiss = dismissed;
    dismissed = undefined;
    if (!chosen) {
      onDismiss?.();
    }
  };

  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-add-confirm]")) {
      confirmName();
      return;
    }
    if (target?.closest("[data-add-cancel]")) {
      close();
      anchorEl?.focus();
      return;
    }
    const custom = target?.closest<HTMLElement>("[data-add-custom]")?.dataset.addCustom;
    if (custom === "form" || custom === "blank" || custom === "copy") {
      // Named before it is made: the box offers the layout's usual name.
      const suggestion = custom === "copy" ? context.copyName?.() ?? words().text("pdf.newName.custom") : words().text(custom === "blank" ? "pdf.newName.blank" : "pdf.newName.custom");
      askName(suggestion, (name) => context.onCustom(custom, name));
      return;
    }
    if (target?.closest("[data-add-upload]")) {
      host.querySelector<HTMLInputElement>("[data-add-file]")?.click();
      return;
    }
    const hostId = target?.closest<HTMLElement>("[data-add-host]")?.dataset.addHost;
    if (hostId !== undefined) {
      const option = templateOptions.find((entry) => entry.id === hostId);
      if (option) {
        askName(optionLabel(option, context.locale()), (name) => context.onTemplate(option.source, name));
      }
    }
  });
  host.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input || input.dataset.addFile === undefined) {
      return;
    }
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    void (async () => {
      try {
        if (file.size === 0) {
          error = words().text("pdf.add.error.empty", { name: file.name });
          render();
          return;
        }
        if (file.size > MAX_PDF_TEMPLATE_BYTES) {
          error = words().text("pdf.add.error.large", { name: file.name, megabytes: Math.floor(MAX_PDF_TEMPLATE_BYTES / (1024 * 1024)) });
          render();
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!hasPdfHeader(bytes)) {
          error = words().text("pdf.add.error.notPdf", { name: file.name });
          render();
          return;
        }
        const source: PdfTemplateSource = { storage: "base64", name: file.name, type: file.type || "application/pdf", size: file.size, data: bytesToBase64(bytes) };
        // Said before the layout is named, and nothing is changed: the form would save and never open again.
        const heavy = context.templateProblem?.(source);
        if (heavy !== undefined) {
          error = heavy;
          render();
          return;
        }
        // The file's stem, made readable, is the suggestion; the author confirms it or types another.
        askName(layoutNameForFile(file.name, words().options()), (name) => context.onTemplate(source, name));
      } catch (failure) {
        error = words().text("pdf.add.error.read", { name: file.name, message: failure instanceof Error ? failure.message : String(failure) });
        render();
      }
    })();
  });
  host.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" && (event.target as HTMLElement | null)?.hasAttribute("data-add-name")) {
      event.preventDefault();
      confirmName();
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      close();
      anchorEl?.focus();
    }
  });

  return {
    open,
    close: () => close(),
    get isOpen() {
      return isOpen();
    }
  };
}
