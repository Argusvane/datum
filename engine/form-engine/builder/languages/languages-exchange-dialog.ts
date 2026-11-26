/**
 * The Languages workspace's export and import dialogs, each a `<dialog>`
 * drawn inside the surface's shadow root, beside the page it paints (a sibling of the painted
 * area, so a repaint of the surface never wipes an open dialog).
 *
 * - Export: a format (JSON, CSV, XLIFF), a scope (all, missing or source changed, one group), the
 *   languages to take (an XLIFF file per chosen language), "Copy as a prompt" and Download.
 * - Import: a file picker and a drop zone. The file is untrusted: its size is checked before a
 *   byte is read, and nothing of it is parsed outside `exchange.ts` (`previewImport` reads it,
 *   `applyImport` turns the preview into edits). The preview shows the counts, the languages the
 *   form lacks (add or skip each), the mode, and a row-by-row diff; Apply adds the chosen
 *   languages and writes every edit in one `setTranslations` call, so an import is one undo step.
 *
 * The dialog owns no data: the surface hands in its rows, the controller and its words
 * ({@link ExchangeHost}), and this module adapts the rows to the exchange's shape. Escape closes
 * it (the dialog's own `cancel`, and a key handler for an engine that has no modal dialog).
 */
import type { BuilderController } from "../controller/builder-controller.js";
import { languageCodeProblem, withLanguageAdded } from "../controller/language-edits.js";
import type { BuilderTextKey, BuilderWords } from "../logic/builder-texts.js";
import { esc } from "../web-component/builder-shared.js";
import { isRtlLocale } from "../../core/localization/localized-text.js";
import { sourceHash } from "../../core/localization/translations.js";
import type { LocalizationConfiguration } from "../../core/schema/types.js";
import {
  applyImport,
  countsFor,
  exportCsv,
  exportJson,
  exportXliff,
  MAX_IMPORT_BYTES,
  previewImport,
  promptText,
  textsInScope,
  willApply
} from "./exchange.js";
import type { ExchangeScope, ExchangeText, ImportMode, ImportPreview, ImportProblem, ImportRow } from "./exchange.js";
import { LANGUAGES_EXCHANGE_EN } from "./languages-exchange-texts-en.js";
import { effectiveDefaultLocale, languageEntries, languagesGroupsOf, rowKey } from "./languages-model.js";
import type { LanguageEntry, LanguagesGroupId, LanguagesRow } from "./languages-model.js";
import { MODAL_BACKDROP_CLIP, MODAL_H, MODAL_INSET, MODAL_W, showBuilderModal } from "../web-component/modal-place.js";

type ExchangeKey = keyof typeof LANGUAGES_EXCHANGE_EN;

/** Everything the dialogs take from the surface; the surface builds one per opening. */
export interface ExchangeHost {
  /** The surface's shadow root: the dialog is appended to it. */
  root: ShadowRoot;
  controller: BuilderController;
  /** The texts as the surface last painted them, read when the dialog needs them (so an import preview sees the current ones). */
  rows: () => readonly LanguagesRow[];
  /** The surface's words (the dialogs add their own table). */
  words: BuilderWords;
  /** The form's id, for file names and the file header. */
  formId: string;
  /** The row's name and place, worded by the surface (it holds the builder's words for option and header rows). */
  rowLabel: (row: LanguagesRow) => string;
  whereLabel: (row: LanguagesRow) => string;
  groupLabel: (id: LanguagesGroupId) => string;
  /** The surface's live region. */
  say: (text: string) => void;
}

// --- rows to the exchange's shape ---------------------------------------------------------------

/** A source no fingerprint equals, standing for "the stored translation answered older wording". */
const STALE_SOURCE = "stale";

/**
 * The surface's rows as the exchange's texts. The page's catalog rows are left out: no text of
 * the form sits behind them, so the controller would pass over an import of one. A cell's
 * `source` is not on the row, only whether it is stale, so a stale one gets a source that
 * matches no default and a current one the default's own fingerprint. A language the row has no
 * cell for is not applicable to it, and a cell the page's catalog words is marked, so the
 * exchange neither asks for a translation there nor writes one the page would not show. A cell
 * the form already shows from its base language (a regional language's `fr`) is marked served
 * like the page's, so it is not asked for either.
 */
export function exchangeTexts(host: Pick<ExchangeHost, "rowLabel" | "whereLabel" | "groupLabel">, rows: readonly LanguagesRow[], codes: readonly string[]): ExchangeText[] {
  return rows
    .filter((row) => row.groupId !== "catalog")
    .map((row) => {
      const texts: Record<string, string> = {};
      const sources: Record<string, string> = {};
      const applicable = new Set<string>();
      const catalog: Record<string, "overridden" | "served"> = {};
      for (const code of codes) {
        const cell = row.cells[code];
        if (cell === undefined) {
          continue;
        }
        applicable.add(code);
        if (cell.text) {
          texts[code] = cell.text;
          sources[code] = cell.stale ? STALE_SOURCE : sourceHash(row.default);
        }
        if (cell.overriddenBy === "catalog") {
          catalog[code] = "overridden";
        } else if (cell.pageText !== undefined || cell.fallbackText !== undefined) {
          catalog[code] = "served";
        }
      }
      return {
        address: row.address,
        default: row.default,
        group: row.groupId,
        where: `${host.whereLabel(row)} · ${host.rowLabel(row)}`,
        texts,
        sources,
        applicable,
        catalog
      };
    });
}

function fileSafe(id: string): string {
  return id.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "form";
}

function config(host: ExchangeHost): LocalizationConfiguration | undefined {
  return host.controller.localization();
}

/**
 * The languages a file has a column for: every language the grid has a column for, and the
 * default language too when some row has a cell in it. Only the engine's own words (English at
 * the source) do, in a form whose default language is not English; every other text's
 * default-language wording is the form's own, so no column of it exists.
 */
function exchangeEntries(host: ExchangeHost): LanguageEntry[] {
  const source = effectiveDefaultLocale(config(host));
  const rows = host.rows();
  return languageEntries(config(host)).filter((entry) => entry.code !== source || rows.some((row) => Object.hasOwn(row.cells, entry.code)));
}

// --- the shell of a dialog ------------------------------------------------------------------------

let sequence = 0;

abstract class ExchangeDialog {
  protected readonly host: ExchangeHost;
  protected readonly words: BuilderWords;
  protected readonly wrapper: HTMLElement;
  protected readonly dialog: HTMLDialogElement;
  protected readonly titleId: string;
  private readonly opener: Element | null;
  private readonly openerSelector: string;
  /** What `draw` fills; the live region beside it is never repainted, so a message put there is heard. */
  private readonly body: HTMLElement;
  private readonly live: HTMLElement;
  private closed = false;

  protected constructor(host: ExchangeHost, kind: "export" | "import") {
    this.host = host;
    this.words = host.words.with(LANGUAGES_EXCHANGE_EN);
    this.opener = host.root.activeElement;
    this.openerSelector = `[data-languages-${kind}]`;
    sequence += 1;
    this.titleId = `ex-title-${sequence}`;
    const doc = host.root.ownerDocument;
    this.wrapper = doc.createElement("div");
    this.wrapper.setAttribute("data-languages-exchange", kind);
    this.wrapper.innerHTML = `<style>${EXCHANGE_STYLES}</style><dialog class="ex" data-languages-exchange-dialog="${kind}" aria-labelledby="${this.titleId}"><div data-exchange-body></div><div class="sr-only" role="status" data-exchange-live></div></dialog>`;
    this.dialog = this.wrapper.querySelector("dialog")!;
    this.body = this.wrapper.querySelector<HTMLElement>("[data-exchange-body]")!;
    this.live = this.wrapper.querySelector<HTMLElement>("[data-exchange-live]")!;
    this.dialog.addEventListener("click", (event) => this.onClick(event));
    this.dialog.addEventListener("change", (event) => this.onChange(event));
    this.dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
    // The browser's own Escape ends in `close`; the dialog is torn down whichever way it went.
    this.dialog.addEventListener("close", () => this.close());
  }

  protected w(key: ExchangeKey, params?: Record<string, string | number>): string {
    return this.words.text(key as BuilderTextKey, params);
  }

  protected abstract paint(): void;
  protected abstract onClick(event: Event): void;
  protected abstract onChange(event: Event): void;

  protected show(): void {
    this.host.root.append(this.wrapper);
    this.paint();
    const dialog = this.dialog;
    if (typeof dialog.showModal === "function") {
      try {
        showBuilderModal(dialog);
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
  }

  /**
   * Says something to a screen reader from inside the dialog. A modal dialog makes the rest of the
   * page inert, so the surface's own live region (outside it) is not heard while it is open.
   */
  protected announce(text: string): void {
    this.live.textContent = text;
  }

  /**
   * Closes and removes the dialog; the focus goes back to the button that opened it. A repaint of
   * the surface while the dialog was open (an applied import repaints the grid) replaces that
   * button, so it is looked up again by its attribute, and a browser that did not focus the
   * button when it was clicked (Safari) has no element to remember.
   */
  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.dialog.hasAttribute("open") && typeof this.dialog.close === "function") {
      this.dialog.close();
    }
    this.wrapper.remove();
    const back = this.opener instanceof HTMLElement && this.opener.isConnected ? this.opener : this.host.root.querySelector<HTMLElement>(this.openerSelector);
    back?.focus();
  }

  /** Redraws the dialog's content and puts the focus back where it was (a repaint replaces the controls). */
  protected draw(html: string): void {
    const active = this.host.root.activeElement;
    const name = active && this.body.contains(active) ? active.getAttribute("data-ex") : null;
    this.body.innerHTML = html;
    if (name) {
      [...this.body.querySelectorAll<HTMLElement>("[data-ex]")].find((el) => el.getAttribute("data-ex") === name)?.focus();
    }
  }

  protected hit(event: Event, selector: string): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest<HTMLElement>(selector) ?? null;
  }
}

// --- Export ----------------------------------------------------------------------------------------

type ExportFormat = "json" | "csv" | "xliff";

const FORMAT_MIME: Record<ExportFormat, string> = {
  json: "application/json",
  csv: "text/csv;charset=utf-8",
  xliff: "application/xliff+xml"
};

class ExportDialog extends ExchangeDialog {
  private format: ExportFormat = "json";
  private scope = "all";
  private readonly chosen: Set<string>;
  /** Whether the prompt was copied, or the copy failed and the text is shown to select. */
  private copy: "none" | "copied" | "fallback" = "none";
  private fallbackText = "";
  /**
   * The files an XLIFF export of several languages made ready. A browser lets one download follow
   * a click and asks about or blocks the rest, so each file gets a link of its own in the dialog
   * and each click is its own gesture.
   */
  private links: Array<{ name: string; url: string }> = [];

  public constructor(host: ExchangeHost) {
    super(host, "export");
    this.chosen = new Set(exchangeEntries(host).map((entry) => entry.code));
    this.show();
  }

  private codes(): string[] {
    return exchangeEntries(this.host).map((entry) => entry.code);
  }

  private header(): { form: string; defaultLocale: string; exportedAt: string } {
    return { form: this.host.formId, defaultLocale: effectiveDefaultLocale(config(this.host)), exportedAt: new Date().toISOString() };
  }

  /** The languages to take, in the form's order. */
  private locales(): string[] {
    return this.codes().filter((code) => this.chosen.has(code));
  }

  private all(): ExchangeText[] {
    return exchangeTexts(this.host, this.host.rows(), this.codes());
  }

  /** The texts the scope picks, as a list the exporters take whole (their own scope is then "all"). */
  private picked(texts: readonly ExchangeText[], locales: readonly string[]): ExchangeText[] {
    if (this.scope === "needs") {
      const need = new Set([...textsInScope(texts, locales, "missing"), ...textsInScope(texts, locales, "stale")]);
      return texts.filter((text) => need.has(text));
    }
    if (this.scope.startsWith("group:")) {
      const scope: ExchangeScope = { group: this.scope.slice("group:".length) };
      return textsInScope(texts, locales, scope);
    }
    return [...texts];
  }

  private files(): Array<{ name: string; mime: string; content: string }> {
    const locales = this.locales();
    const texts = this.picked(this.all(), locales);
    const id = fileSafe(this.host.formId);
    const header = this.header();
    if (this.format === "json") {
      return [{ name: `${id}-translations.json`, mime: FORMAT_MIME.json, content: exportJson(texts, locales, "all", header) }];
    }
    if (this.format === "csv") {
      // The file leads with a byte-order mark so Excel opens it as UTF-8; the pasted prompt has none.
      return [{ name: `${id}-translations.csv`, mime: FORMAT_MIME.csv, content: exportCsv(texts, locales, "all", { bom: true }) }];
    }
    // The default language's file holds only the engine's own words, whose source is English.
    return locales.map((locale) => ({
      name: `${id}-${fileSafe(locale)}.xlf`,
      mime: FORMAT_MIME.xliff,
      content: exportXliff(texts, locale, "all", locale === header.defaultLocale ? { ...header, defaultLocale: "en" } : header)
    }));
  }

  protected paint(): void {
    const codes = this.codes();
    const entries = exchangeEntries(this.host);
    const all = this.all();
    const locales = this.locales();
    const count = this.picked(all, locales).length;
    const groups = languagesGroupsOf(this.host.rows()).filter((group) => group.id !== "catalog");
    if (this.scope.startsWith("group:") && !groups.some((group) => `group:${group.id}` === this.scope)) {
      this.scope = "all";
    }
    const none = codes.length === 0;
    const formats = (["json", "csv", "xliff"] as const)
      .map(
        (format) => `<label class="ex-choice"><input type="radio" name="format" value="${format}" data-ex="format-${format}" data-exchange-format="${format}"${this.format === format ? " checked" : ""}>
          <span>${esc(this.w(`languages.exchange.format.${format}` as ExchangeKey))}</span></label>`
      )
      .join("");
    const scopes = [
      `<option value="all">${esc(this.w("languages.exchange.scope.all"))}</option>`,
      `<option value="needs">${esc(this.w("languages.exchange.scope.needs"))}</option>`,
      ...groups.map((group) => `<option value="group:${group.id}">${esc(this.w("languages.exchange.scope.group", { group: this.host.groupLabel(group.id) }))}</option>`)
    ]
      .map((option) => (option.includes(`value="${this.scope}"`) ? option.replace("<option ", "<option selected ") : option))
      .join("");
    const languages = none
      ? `<p class="ex-note" data-exchange-no-languages>${esc(this.w("languages.exchange.languages.none"))}</p>`
      : `<fieldset class="ex-set"><legend>${esc(this.w("languages.exchange.languages.label"))}</legend>
          ${entries
            .map(
              (entry) => `<label class="ex-choice"><input type="checkbox" data-ex="language-${esc(entry.code)}" data-exchange-language="${esc(entry.code)}"${this.chosen.has(entry.code) ? " checked" : ""}>
                <span>${esc(entry.label)} <code>${esc(entry.code)}</code></span></label>`
            )
            .join("")}
        </fieldset>`;
    const fallback =
      this.copy === "fallback"
        ? `<p class="ex-note" data-exchange-copy-fallback>${esc(this.w("languages.exchange.prompt.fallback"))}</p>
           <textarea class="ex-prompt" readonly rows="8" data-ex="prompt-text" data-exchange-prompt aria-label="${esc(this.w("languages.exchange.prompt.fallbackLabel"))}">${esc(this.fallbackText)}</textarea>`
        : "";
    const ready = !none && locales.length > 0 && count > 0;
    const links = this.links.length
      ? `<ul class="ex-links" aria-label="${esc(this.w("languages.exchange.links.label"))}" data-exchange-links>${this.links
          .map((link) => `<li><a href="${esc(link.url)}" download="${esc(link.name)}" data-ex="link-${esc(link.name)}" data-exchange-link>${esc(link.name)}</a></li>`)
          .join("")}</ul>`
      : "";
    this.draw(`<h2 class="card-title" id="${this.titleId}">${esc(this.w("languages.exchange.export.title"))}</h2>
      <p class="ex-note">${esc(this.w("languages.exchange.export.lead"))}</p>
      <fieldset class="ex-set"><legend>${esc(this.w("languages.exchange.format.label"))}</legend>${formats}
        ${this.format === "xliff" ? `<p class="ex-note small" data-exchange-xliff-note>${esc(this.w("languages.exchange.format.xliff.note"))}</p>` : ""}
      </fieldset>
      <label class="ex-field field"><span class="field-label">${esc(this.w("languages.exchange.scope.label"))}</span>
        <select data-ex="scope" data-exchange-scope>${scopes}</select></label>
      ${languages}
      <p class="ex-note small" data-exchange-count>${esc(this.w("languages.exchange.export.count", { count }))}</p>
      <p class="ex-note small">${esc(this.w("languages.exchange.prompt.hint"))}</p>
      ${fallback}
      <p class="ex-note small" role="status" data-exchange-status>${this.copy === "copied" ? esc(this.w("languages.exchange.prompt.copied")) : ""}</p>
      ${links}
      <div class="ex-actions">
        <button type="button" class="btn" data-ex="close" data-exchange-close>${esc(this.w("languages.exchange.close"))}</button>
        <button type="button" class="btn" data-ex="prompt" data-exchange-prompt-copy${ready ? "" : " disabled"}>${esc(this.w("languages.exchange.prompt.button"))}</button>
        <button type="button" class="btn primary" data-ex="download" data-exchange-download autofocus${ready ? "" : " disabled"}>${esc(this.w("languages.exchange.download"))}</button>
      </div>`);
  }

  protected onClick(event: Event): void {
    if (this.hit(event, "[data-exchange-close]")) {
      this.close();
      return;
    }
    if (this.hit(event, "[data-exchange-download]")) {
      this.download();
      return;
    }
    if (this.hit(event, "[data-exchange-prompt-copy]")) {
      void this.copyPrompt();
    }
  }

  protected onChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const data = target.dataset ?? {};
    if (data.exchangeFormat !== undefined) {
      this.format = data.exchangeFormat as ExportFormat;
    } else if (data.exchangeScope !== undefined) {
      this.scope = target.value;
    } else if (data.exchangeLanguage !== undefined) {
      const code = data.exchangeLanguage;
      if ((target as HTMLInputElement).checked) {
        this.chosen.add(code);
      } else {
        this.chosen.delete(code);
      }
    } else {
      return;
    }
    this.copy = "none";
    this.announce("");
    this.revokeLinks();
    this.paint();
  }

  private revokeLinks(): void {
    for (const link of this.links) {
      URL.revokeObjectURL(link.url);
    }
    this.links = [];
  }

  public override close(): void {
    this.revokeLinks();
    super.close();
  }

  private download(): void {
    const files = this.files();
    this.revokeLinks();
    if (files.length > 1) {
      this.links = files.map((file) => ({ name: file.name, url: URL.createObjectURL(new Blob([file.content], { type: file.mime })) }));
      this.paint();
      this.dialog.querySelector<HTMLElement>("[data-exchange-link]")?.focus();
      this.announce(this.w("languages.exchange.say.prepared", { count: files.length }));
      return;
    }
    for (const file of files) {
      downloadFile(this.host.root.ownerDocument, file.name, file.mime, file.content);
    }
    this.announce(this.w("languages.exchange.say.downloaded", { names: files.map((file) => file.name).join(", ") }));
  }

  /** The prompt goes to the clipboard; where the page may not write there, its text is shown to select and copy by hand. */
  private async copyPrompt(): Promise<void> {
    const locales = this.locales();
    const text = promptText(this.picked(this.all(), locales), locales, "all", this.header());
    let copied = false;
    try {
      const clipboard = (this.host.root.ownerDocument.defaultView?.navigator ?? globalThis.navigator)?.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        await clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (this.dialog.isConnected === false) {
      return;
    }
    this.copy = copied ? "copied" : "fallback";
    this.fallbackText = text;
    this.paint();
    if (copied) {
      this.announce(this.w("languages.exchange.prompt.copied"));
    } else {
      const box = this.dialog.querySelector<HTMLTextAreaElement>("[data-exchange-prompt]");
      box?.focus();
      box?.select();
    }
  }
}

/** A Blob behind an anchor click. The object URL is revoked a second later, so the download has started. */
function downloadFile(doc: Document, name: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Import ----------------------------------------------------------------------------------------

/** The rows of the diff table drawn at once; a file may hold twenty thousand. */
const TABLE_ROWS = 300;

const IMPORT_ACCEPT = ".json,.csv,.xlf,.xliff,.xml,application/json,text/csv,application/xliff+xml";

/** A file's bytes. `Blob.arrayBuffer` where there is one, else a FileReader (the engines that lack it). */
function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The text of `bytes` read as UTF-8, or `undefined` when they are not. A lossy read would turn a
 * file a spreadsheet saved in its ANSI code page into replacement characters that Replace mode
 * then writes over good translations, so a file that is not UTF-8 is refused instead.
 */
function decodeUtf8(bytes: ArrayBuffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

/** A preview with no rows and one problem: a file refused before anything of it is read as a table. */
function refusedPreview(name: string, code: ImportProblem["code"]): ImportPreview {
  return { name, rows: [], newLocales: [], unknownCount: 0, noTargetCount: 0, counts: { new: 0, changed: 0, unchanged: 0, unknown: 0, skipped: 0, stale: 0 }, problems: [{ code }] };
}

class ImportDialog extends ExchangeDialog {
  private mode: ImportMode = "replace";
  private fileName: string | undefined;
  private reading = false;
  /** Which pick is the newest: a read that finishes after a later pick was made is not shown. */
  private loads = 0;
  /** The words of a refused addition, shown in the dialog (the surface's live region is not heard under a modal). */
  private refusal = "";
  private preview: ImportPreview | undefined;
  /** The new languages the author ticked to add; none is, until one is ticked, so a short spreadsheet header never becomes a language unasked. */
  private readonly ticked = new Set<string>();
  private dragging = false;

  public constructor(host: ExchangeHost) {
    super(host, "import");
    this.wireDrop();
    this.show();
  }

  private codes(): string[] {
    return exchangeEntries(this.host).map((entry) => entry.code);
  }

  private addLocales(): string[] {
    return (this.preview?.newLocales ?? []).filter((code) => this.ticked.has(code));
  }

  private problemText(problem: ImportProblem): string {
    // A broken XLIFF that knows which unit it broke in says so; one that does not keeps the plain sentence.
    const code = problem.code === "malformedXml" && problem.detail !== undefined ? "malformedXmlUnit" : problem.code;
    const message = this.w(`languages.exchange.problem.${code}` as ExchangeKey, { detail: problem.detail ?? "" });
    return problem.row === undefined ? message : this.w("languages.exchange.problem.row", { row: problem.row, message });
  }

  private rowStatus(row: ImportRow, added: ReadonlySet<string>): string {
    const flags: string[] = [];
    if (row.status === "unknown" || row.status === "pageWorded" || row.status === "noCell") {
      return this.w(`languages.exchange.status.${row.status}` as ExchangeKey);
    }
    if (row.newLocale && !added.has(row.locale)) {
      flags.push(this.w("languages.exchange.status.skippedLanguage"));
    } else if (row.status === "unchanged") {
      flags.push(this.w("languages.exchange.status.unchanged"));
    } else if (!willApply(row, this.mode)) {
      flags.push(this.w("languages.exchange.status.kept"));
    } else {
      flags.push(this.w(`languages.exchange.status.${row.status}` as ExchangeKey));
    }
    if (row.stale) {
      flags.push(this.w("languages.exchange.status.stale"));
    }
    return flags.join(" · ");
  }

  protected paint(): void {
    const preview = this.preview;
    const zone = `<div class="ex-drop${this.dragging ? " over" : ""}" data-exchange-drop>
        <label class="ex-field field"><span class="field-label">${esc(this.w("languages.exchange.file.label"))}</span>
          <input type="file" accept="${IMPORT_ACCEPT}" data-ex="file" data-exchange-file autofocus></label>
        <p class="ex-note small">${esc(this.w("languages.exchange.file.drop"))}</p>
        ${this.reading ? `<p class="ex-note small" role="status" data-exchange-reading>${esc(this.w("languages.exchange.file.reading", { name: this.fileName ?? "" }))}</p>` : ""}
      </div>`;
    const added = new Set(this.addLocales());
    const applying = preview ? applyImport(preview, { addLocales: [...added], mode: this.mode }).edits.length : 0;
    const body = preview ? this.previewHtml(preview, added, applying) : "";
    this.draw(`<h2 class="card-title" id="${this.titleId}">${esc(this.w("languages.exchange.import.title"))}</h2>
      <p class="ex-note">${esc(this.w("languages.exchange.import.lead"))}</p>
      ${zone}
      ${this.refusal ? `<p class="ex-note note" data-tone="error" role="alert" data-exchange-refused>${esc(this.refusal)}</p>` : ""}
      ${body}
      <div class="ex-actions">
        <button type="button" class="btn" data-ex="cancel" data-exchange-cancel>${esc(this.w("languages.exchange.cancel"))}</button>
        <button type="button" class="btn primary" data-ex="apply" data-exchange-apply${applying > 0 && !this.reading ? "" : " disabled"}>${esc(this.w("languages.exchange.apply"))}</button>
      </div>`);
  }

  private previewHtml(preview: ImportPreview, added: ReadonlySet<string>, applying: number): string {
    // Only what applying would touch is counted: a new language left unticked takes its rows out.
    const figures = countsFor(preview, [...added]);
    const counts = (["new", "changed", "unchanged", "unknown"] as const)
      .map((name) => `<li data-exchange-count="${name}"><span>${esc(this.w(`languages.exchange.counts.${name}` as ExchangeKey))}</span> <strong>${figures[name]}</strong></li>`)
      .join("");
    const stale = `<li data-exchange-count="stale"><span>${esc(this.w("languages.exchange.counts.stale"))}</span> <strong>${figures.stale}</strong></li>`;
    const skipped = figures.skipped > 0 ? `<li data-exchange-count="skipped"><span>${esc(this.w("languages.exchange.counts.skipped"))}</span> <strong>${figures.skipped}</strong></li>` : "";
    const noTarget = preview.noTargetCount > 0 ? `<li data-exchange-count="noTarget"><span>${esc(this.w("languages.exchange.counts.noTarget"))}</span> <strong>${preview.noTargetCount}</strong></li>` : "";
    const problems = preview.problems.length
      ? `<section class="ex-set" aria-labelledby="${this.titleId}-problems" data-exchange-problems>
          <h3 class="card-heading" id="${this.titleId}-problems">${esc(this.w("languages.exchange.problems.title"))}</h3>
          <ul>${preview.problems.map((problem) => `<li data-exchange-problem="${problem.code}">${esc(this.problemText(problem))}</li>`).join("")}</ul>
        </section>`
      : "";
    if (preview.rows.length === 0) {
      return `<p class="ex-note small" data-exchange-file-name>${esc(this.w("languages.exchange.file.name", { name: preview.name }))}</p>${problems}`;
    }
    const newLocales = preview.newLocales.length
      ? `<fieldset class="ex-set" data-exchange-new-locales><legend>${esc(this.w("languages.exchange.newLocales.title"))}</legend>
          ${preview.newLocales
            .map(
              (code) => `<label class="ex-choice"><input type="checkbox" data-ex="add-${esc(code)}" data-exchange-add="${esc(code)}"${this.ticked.has(code) ? " checked" : ""}>
                <span>${esc(this.w("languages.exchange.newLocales.add", { code }))}</span></label>`
            )
            .join("")}
          <p class="ex-note small">${esc(this.w("languages.exchange.newLocales.note"))}</p>
        </fieldset>`
      : "";
    const modes = (["replace", "fill"] as const)
      .map(
        (mode) => `<label class="ex-choice"><input type="radio" name="mode" value="${mode}" data-ex="mode-${mode}" data-exchange-mode="${mode}"${this.mode === mode ? " checked" : ""}>
          <span>${esc(this.w(`languages.exchange.mode.${mode}` as ExchangeKey))}</span></label>`
      )
      .join("");
    const labels = new Map(this.host.rows().map((row) => [rowKey(row.address), `${this.host.whereLabel(row)} · ${this.host.rowLabel(row)}`]));
    const shown = preview.rows.slice(0, TABLE_ROWS);
    const table = `<div class="ex-table-wrap"><table data-exchange-table>
        <caption class="sr-only">${esc(this.w("languages.exchange.table.caption"))}</caption>
        <thead><tr>${(["text", "language", "current", "imported", "status"] as const).map((name) => `<th scope="col">${esc(this.w(`languages.exchange.table.${name}` as ExchangeKey))}</th>`).join("")}</tr></thead>
        <tbody>${shown
          .map((row) => {
            const key = rowKey(row.address);
            const label = labels.get(key);
            return `<tr data-exchange-row="${esc(key)}" data-exchange-status="${row.status}" data-exchange-locale="${esc(row.locale)}">
              <th scope="row"><code>${esc(key)}</code>${label ? `<br><span class="muted">${esc(label)}</span>` : ""}</th>
              <td><code>${esc(row.locale)}</code></td>
              <td lang="${esc(row.locale)}" dir="${isRtlLocale(row.locale) ? "rtl" : "ltr"}">${esc(row.current ?? "")}</td>
              <td lang="${esc(row.locale)}" dir="${isRtlLocale(row.locale) ? "rtl" : "ltr"}">${esc(row.text)}</td>
              <td>${esc(this.rowStatus(row, added))}</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div>
      ${preview.rows.length > shown.length ? `<p class="ex-note small" data-exchange-more>${esc(this.w("languages.exchange.table.more", { shown: shown.length, total: preview.rows.length }))}</p>` : ""}`;
    return `<p class="ex-note small" data-exchange-file-name>${esc(this.w("languages.exchange.file.name", { name: preview.name }))}</p>
      <ul class="ex-counts" aria-label="${esc(this.w("languages.exchange.counts.label"))}">${counts}${skipped}${stale}${noTarget}</ul>
      ${problems}${newLocales}
      <fieldset class="ex-set"><legend>${esc(this.w("languages.exchange.mode.label"))}</legend>${modes}</fieldset>
      ${table}
      <p class="ex-note small" data-exchange-apply-count>${esc(this.w("languages.exchange.apply.count", { count: applying }))}</p>`;
  }

  protected onClick(event: Event): void {
    if (this.hit(event, "[data-exchange-cancel]")) {
      this.close();
      return;
    }
    if (this.hit(event, "[data-exchange-apply]")) {
      this.apply();
    }
  }

  protected onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const data = target.dataset ?? {};
    if (data.exchangeFile !== undefined) {
      const file = target.files?.[0];
      if (file) {
        void this.load(file);
      }
      return;
    }
    if (data.exchangeMode !== undefined) {
      this.mode = data.exchangeMode === "fill" ? "fill" : "replace";
    } else if (data.exchangeAdd !== undefined) {
      if (target.checked) {
        this.ticked.add(data.exchangeAdd);
      } else {
        this.ticked.delete(data.exchangeAdd);
      }
    } else {
      return;
    }
    this.paint();
  }

  /**
   * The drop zone is redrawn with the dialog, so the listeners sit on the dialog. A file dropped
   * anywhere on it is taken: an event nobody cancels is the browser's own, which opens the dropped
   * file in the tab and leaves the builder, so a drop a few pixels off the zone must not fall through.
   */
  private wireDrop(): void {
    const zone = (): HTMLElement | null => this.dialog.querySelector("[data-exchange-drop]");
    const carriesFiles = (event: Event): boolean => Array.from((event as DragEvent).dataTransfer?.types ?? []).includes("Files");
    this.dialog.addEventListener("dragover", (event) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      if (!this.dragging) {
        this.dragging = true;
        zone()?.classList.add("over");
      }
    });
    this.dialog.addEventListener("dragleave", (event) => {
      const into = (event as DragEvent).relatedTarget;
      if (this.dragging && !(into instanceof Node && this.dialog.contains(into))) {
        this.dragging = false;
        zone()?.classList.remove("over");
      }
    });
    this.dialog.addEventListener("drop", (event) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      this.dragging = false;
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file) {
        void this.load(file);
      } else {
        zone()?.classList.remove("over");
      }
    });
  }

  /**
   * Reads a file and previews it. The size is checked before a byte is read, so
   * an oversize file never reaches memory; the text is parsed by `previewImport` and nothing else.
   */
  private async load(file: File): Promise<void> {
    // Every pick supersedes the one before it, an oversize pick included, so a slow read that
    // finishes late never replaces the preview of the file chosen after it.
    this.loads += 1;
    const mine = this.loads;
    this.refusal = "";
    this.fileName = file.name;
    this.ticked.clear();
    if (file.size > MAX_IMPORT_BYTES) {
      this.preview = refusedPreview(file.name, "tooLarge");
      this.reading = false;
      this.paint();
      return;
    }
    this.reading = true;
    this.preview = undefined;
    this.paint();
    let bytes: ArrayBuffer | undefined;
    try {
      bytes = await readBytes(file);
    } catch {
      bytes = undefined;
    }
    if (!this.dialog.isConnected || mine !== this.loads) {
      return;
    }
    const text = bytes === undefined ? "" : decodeUtf8(bytes);
    if (text === undefined) {
      this.preview = refusedPreview(file.name, "notUtf8");
    } else {
      const config = this.host.controller.localization();
      const texts = exchangeTexts(this.host, this.host.rows(), this.codes());
      this.preview = previewImport({ name: file.name, text }, texts, this.codes(), { mode: this.mode, defaultLocale: effectiveDefaultLocale(config) });
    }
    this.reading = false;
    this.paint();
  }

  /**
   * Adds the chosen languages and writes every edit in **one** `setTranslations` call, so the
   * import is one undo step: a single Undo takes the languages and their entries back together.
   * A code the form would refuse is said first and nothing is changed.
   */
  private apply(): void {
    const preview = this.preview;
    if (!preview) {
      return;
    }
    const controller = this.host.controller;
    const added = this.addLocales();
    const { edits } = applyImport(preview, { addLocales: added, mode: this.mode });
    if (edits.length === 0) {
      return;
    }
    // Checked against the languages as the additions would leave them, before anything is written.
    const config = controller.localization();
    const sourceLocale = languageEntries(config).length === 0 ? effectiveDefaultLocale(config) : undefined;
    let probe = config;
    for (const code of added) {
      if (languageCodeProblem(code, probe) !== undefined) {
        this.refusal = this.w("languages.exchange.say.addRefused", { code });
        this.preview = undefined;
        this.paint();
        // The Apply button the focus was on is gone with the preview: it goes to the file chooser.
        this.dialog.querySelector<HTMLElement>("[data-exchange-file]")?.focus();
        return;
      }
      probe = withLanguageAdded(probe, code, "");
    }
    const written = controller.setTranslations(edits, { addLocales: added.map((code, index) => ({ code, ...(index === 0 && sourceLocale !== undefined ? { sourceLocale } : {}) })) });
    this.close();
    this.host.say(this.w("languages.exchange.say.imported", { count: written }));
  }
}

// --- opening ---------------------------------------------------------------------------------------

/** Opens the Export dialog over the surface. */
export function openExportDialog(host: ExchangeHost): { close: () => void } {
  return new ExportDialog(host);
}

/** Opens the Import dialog over the surface. */
export function openImportDialog(host: ExchangeHost): { close: () => void } {
  return new ImportDialog(host);
}

const EXCHANGE_STYLES = `
  dialog.ex {
    position: fixed; inset: ${MODAL_INSET}; margin: auto; height: fit-content; max-height: calc(${MODAL_H} - 32px); overflow: auto;
    box-sizing: border-box; width: min(760px, calc(${MODAL_W} - 32px));
    background: var(--db-surface); color: var(--db-ink); border: var(--db-border-w) solid var(--db-line-card);
    border-radius: var(--db-radius-lg); padding: var(--db-space-5); box-shadow: var(--db-shadow-overlay);
    font-family: var(--db-font); font-size: var(--db-text-md); line-height: 1.4;
  }
  dialog.ex::backdrop { background: var(--db-scrim, rgba(22, 23, 26, .42)); ${MODAL_BACKDROP_CLIP} }
  dialog.ex :is(h2, h3) { margin-block-end: var(--db-space-2); }
  dialog.ex code { font-family: var(--db-font-mono); font-size: var(--db-text-sm); }
  .ex-note { margin: 0 0 var(--db-space-3); color: var(--db-ink-muted); }
  .ex-note.small { font-size: var(--db-text-sm); }
  .ex-note.note { color: var(--db-ink); }
  .muted { color: var(--db-ink-muted); }
  .ex-set { margin: 0 0 var(--db-space-3); padding: var(--db-space-2) var(--db-space-3); border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); }
  .ex-set legend { padding: 0 var(--db-space-1); font-weight: 600; }
  .ex-set ul { margin: 0; padding-inline-start: var(--db-space-5); }
  .ex-choice { display: flex; align-items: center; gap: var(--db-space-2); min-block-size: var(--db-control-h); }
  .ex-field { margin-bottom: var(--db-space-3); }
  .ex-field select, .ex-field input[type="file"] { max-width: 100%; }
  /* The file box is not one of the shared text boxes (they leave a file input to the browser), so it has its own. */
  .ex-field input[type="file"] {
    box-sizing: border-box; min-block-size: var(--db-control-h); padding: 0 var(--db-space-3);
    border: var(--db-border-w) solid var(--db-line-input); border-radius: var(--db-radius-md); background: var(--db-surface); color: var(--db-ink); font: inherit; font-size: var(--db-text-base);
  }
  .ex-drop { margin-bottom: var(--db-space-3); padding: var(--db-space-3); border: var(--db-border-w) dashed var(--db-line-input); border-radius: var(--db-radius-md); }
  .ex-drop.over { background: var(--db-accent-soft); border-color: var(--db-accent-text); }
  .ex-prompt { box-sizing: border-box; width: 100%; margin-bottom: var(--db-space-3); font-family: var(--db-font-mono); }
  .ex-counts { list-style: none; margin: 0 0 var(--db-space-3); padding: 0; display: flex; flex-wrap: wrap; gap: var(--db-space-4); }
  .ex-table-wrap { max-block-size: calc(${MODAL_H} * .4); overflow: auto; margin-bottom: var(--db-space-2); border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); }
  .ex-table-wrap table { border-collapse: collapse; width: 100%; font-size: var(--db-text-sm); }
  .ex-table-wrap th, .ex-table-wrap td { padding: var(--db-space-1) var(--db-space-2); text-align: start; vertical-align: top; border-bottom: var(--db-border-w) solid var(--db-line-divider); overflow-wrap: anywhere; }
  .ex-table-wrap thead th { position: sticky; top: 0; background: var(--db-surface-sunken); }
  .ex-links { margin: 0 0 var(--db-space-3); padding-inline-start: var(--db-space-4); }
  .ex-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--db-space-2); margin-top: var(--db-space-3); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @media (forced-colors: active) {
    .ex-drop.over { outline: 2px solid Highlight; }
  }
`;
