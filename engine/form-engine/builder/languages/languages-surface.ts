/**
 * The Languages workspace's surface: every translation setting of the form
 * on one page, drawn where the canvas is in Form. Loaded in a chunk of its own the first time the
 * author opens Languages (`languages-loader.ts`).
 *
 * - Languages: a card per language of the form (`FormDefinition.localization`) with its code,
 *   name, a Default badge, how much of the form says something in it, how many texts are missing
 *   or changed at the source, and a menu (Make default, Rename code, Remove). Each action is the
 *   controller's (`localizationActions`): the language list and the translations map change
 *   together in one undo step, so a removal prunes the language's translations and a new default
 *   swaps the strings. A removal and a new default ask first.
 * - The switcher: where the form shows its language switcher (header, footer, not shown) and the
 *   switcher's label, written to the `language-switcher` chrome part (an id is assigned to a new
 *   one); and the language the canvas previews in, the one the Settings panel keeps, read and
 *   written through the controller's locale option.
 * - Texts: every text the form shows, a row each, listed by `languages-model.ts`: a group rail
 *   (Fields, Options, Messages, Header & footer, Journeys, PDF, the page's catalog), search, a
 *   status filter, and either a column per language or one language beside the default text, where
 *   Enter moves to the next text that needs the author. A cell the page's catalog words is
 *   read-only and says so; a stale one says "Source changed" and offers Confirm
 *   (`reconcileTranslations`). Typing writes nothing: the cells wait in a pending bar (n changes,
 *   Apply, Discard), Apply is one `setTranslations` call, so one undo step; while any wait, the
 *   surface is the controller's leave guard, and leaving the workspace asks first.
 * - Export and Import buttons open the exchange dialogs (`openExport` / `openImport`), which
 *   `languages-exchange-dialog.ts` draws; `exchangeHost()` hands them the controller and the rows.
 *   While typed cells wait, Import asks Apply or Discard first, with the leave guard's question.
 * - Undo and Redo keys step the form's history through the shell's `historyStep`, never a box's
 *   own; typed cells are not history and stay as they are.
 *
 * It edits the form's controller only. The shell hears `builder-languages-goto` (show a
 * component in Form) from the surface, and sends the same event the other way (a panel's "Open in
 * Languages"): that copy does not bubble and filters the Texts to the component.
 */
import type { BuilderChangeEvent, BuilderController, TranslatableText } from "../controller/builder-controller.js";
import { languageCodeIssue, languageRenameIssue, type LanguageCodeIssue } from "../controller/language-edits.js";
import type { BuilderTextCatalog, BuilderTextKey } from "../logic/builder-texts.js";
import { areaWords } from "./languages-texts-en.js";
import { openExportDialog, openImportDialog } from "./languages-exchange-dialog.js";
import type { ExchangeHost } from "./languages-exchange-dialog.js";
import { builderTokens, esc, nextChromePartId } from "../web-component/builder-shared.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import type { FormDefinition, LocalizationConfiguration } from "../../core/schema/types.js";
import { isRtlLocale, primaryLocaleSubtag } from "../../core/localization/localized-text.js";
import { TEXTS_MESSAGES_OWNER, type TranslationCatalog } from "../../core/localization/translations.js";
import { engineTexts, enginePluralTexts } from "./engine-texts.js";
import { localeDisplayName, supportedLocaleOptions } from "../../core/localization/supported-locales.js";
import { LANGUAGE_SWITCHER_PART_TYPE } from "../../core/schema/form-chrome.js";
import { chromePartIds } from "../controller/translation-rules.js";
import {
  cellEditable,
  cellStatus,
  cellText,
  changedCells,
  defaultAfterRemoval,
  effectiveDefaultLocale,
  filterLanguagesRows,
  languageCoverage,
  languageEntries,
  languagesEdits,
  languagesGroupsOf,
  languagesTexts,
  promotedTextCount,
  rowKey,
  translationColumns,
  type CellStatus,
  type LanguageCoverage,
  type LanguageEntry,
  type LanguagesGroupId,
  type LanguagesPending,
  type LanguagesRow,
  type LanguagesTexts
} from "./languages-model.js";
import { showBuilderModal } from "../web-component/modal-place.js";

export const DATUM_BUILDER_LANGUAGES_TAG = "datum-builder-languages";

/**
 * Detail of `builder-languages-goto`. From the surface (it bubbles) it asks the shell to show the
 * component in Form; sent to the surface by the shell (it does not bubble) it filters the Texts
 * to the component. The Header & footer panel names a part instead (`kind: "chrome"`): its
 * texts are the part's rows, `chrome › <partId> › …`, and no component of the form.
 */
export type BuilderLanguagesGotoDetail = { componentId: string; kind?: undefined; partId?: undefined } | { kind: "chrome"; partId: string; componentId?: undefined };

/** Texts a mode lends: the list, or a function asked at every paint (a write to the mode's document changes it). */
type TextsSource = readonly TranslatableText[] | ((words: BuilderTextOptions) => readonly TranslatableText[]);

/** The leave guard's subject id: the prompt the surface draws is the one naming it (never shown to the author). */
/** The id this surface's leave guard names itself by: the held prompt carries it as `external.id`. */
export const GUARD_ID = "languages-texts";

/** Languages the Add row suggests, besides whatever the author types. */
const SUGGESTED_CODES = ["en", "fr", "fr-CA", "es", "de", "it", "pt", "nl", "zh", "ja", "ko", "ar", "hi", "iu", "cr"];

/** Where the form shows its language switcher. */
export type SwitcherPlace = "header" | "footer" | "both" | "none";

type RawPart = Record<string, unknown>;

const isRaw = (value: unknown): value is RawPart => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every language-switcher part of a region, groups walked. */
function switchersIn(parts: unknown): RawPart[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.flatMap((part) => (!isRaw(part) ? [] : part.type === LANGUAGE_SWITCHER_PART_TYPE ? [part] : part.type === "group" ? switchersIn(part.parts) : []));
}

/** The region's parts without any switcher; a group that held nothing else goes with it. */
function withoutSwitchers(parts: unknown): unknown[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  const out: unknown[] = [];
  for (const part of parts) {
    if (isRaw(part) && part.type === LANGUAGE_SWITCHER_PART_TYPE) {
      continue;
    }
    if (isRaw(part) && part.type === "group" && Array.isArray(part.parts)) {
      const rest = withoutSwitchers(part.parts);
      if (rest.length > 0 || part.parts.length === 0) {
        out.push({ ...part, parts: rest });
      }
      continue;
    }
    out.push(part);
  }
  return out;
}

/** The parts with the label of every switcher in them set (blank: removed). */
function labelledSwitchers(parts: unknown, label: string): unknown[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.map((part) => {
    if (!isRaw(part)) {
      return part;
    }
    if (part.type === LANGUAGE_SWITCHER_PART_TYPE) {
      const { label: _old, ...rest } = part;
      void _old;
      return label.trim() ? { ...rest, label: label.trim() } : rest;
    }
    return part.type === "group" && Array.isArray(part.parts) ? { ...part, parts: labelledSwitchers(part.parts, label) } : part;
  });
}

/** Where the authored chrome shows a language switcher, and what it is labelled (the first one's label). */
export function switcherState(chrome: unknown): { place: SwitcherPlace; label: string } {
  const header = isRaw(chrome) ? switchersIn(chrome.header) : [];
  const footer = isRaw(chrome) ? switchersIn(chrome.footer) : [];
  const label = [...header, ...footer].map((part) => part.label).find((value): value is string => typeof value === "string") ?? "";
  const place: SwitcherPlace = header.length > 0 && footer.length > 0 ? "both" : header.length > 0 ? "header" : footer.length > 0 ? "footer" : "none";
  return { place, label };
}

/**
 * The authored chrome with its language switcher placed in `place` (moved when it was in the other
 * region, taken away for `none`) and labelled `label`. A new switcher gets a free `part_1`-style
 * id; one that exists keeps its id, so its translations stay where they are. `undefined`
 * when nothing is left of the chrome.
 */
export function chromeWithSwitcher(chrome: unknown, place: "header" | "footer" | "none", label: string): Record<string, unknown> | undefined {
  const current: RawPart = isRaw(chrome) ? structuredClone(chrome) : {};
  const existing = [...switchersIn(current.header), ...switchersIn(current.footer)][0];
  const part: RawPart = existing ? { ...existing } : { id: nextChromePartId(chromePartIds({ chrome: current })), type: LANGUAGE_SWITCHER_PART_TYPE };
  const { label: _old, ...bare } = part;
  void _old;
  const placed: RawPart = label.trim() ? { ...bare, label: label.trim() } : bare;
  const next: RawPart = { ...current };
  for (const region of ["header", "footer"] as const) {
    const parts = Array.isArray(current[region]) ? (current[region] as unknown[]) : [];
    const kept = place === region && switchersIn(parts).length > 0 ? labelledSwitchers(parts, label) : withoutSwitchers(parts);
    const here = place === region && switchersIn(parts).length === 0 ? [...kept, placed] : kept;
    if (here.length > 0) {
      next[region] = here;
    } else {
      delete next[region];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The authored chrome with the label of every language switcher set; the same object when it has none. */
export function chromeWithSwitcherLabel(chrome: unknown, label: string): unknown {
  if (!isRaw(chrome)) {
    return chrome;
  }
  const next: RawPart = { ...chrome };
  for (const region of ["header", "footer"] as const) {
    if (Array.isArray(chrome[region])) {
      next[region] = labelledSwitchers(chrome[region], label);
    }
  }
  return next;
}

interface FocusSnapshot {
  selector: string;
  start: number | null;
  end: number | null;
}

/** What the Texts list is narrowed to. */
interface TextsFilter {
  query: string;
  status: "all" | CellStatus;
  group: LanguagesGroupId | "all";
  /** Only the texts of one component, until cleared (what the goto event asks for). */
  componentId: string | undefined;
  /** Only the texts of one header or footer part, until cleared (the Header & footer panel's goto). */
  chromePartId: string | undefined;
}

export class DatumBuilderLanguagesElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private ctrl: BuilderController | undefined;
  private unsubscribe: (() => void) | undefined;
  private definitionSource: (() => FormDefinition | undefined) | undefined;
  private localeValue: string | undefined;
  private hostCatalogValue = false;
  private translationCatalogValue: TranslationCatalog | undefined;
  private extraTextsValue: TextsSource = [];
  private pdfTextsValue: TextsSource = [];
  private bound = false;
  /** The texts as last painted. */
  private texts: LanguagesTexts = { rows: [], emptyCount: 0 };
  /** What the last paint drew from: a change that alters none of it repaints nothing. */
  private paintedKey: string | undefined;
  private filter: TextsFilter = { query: "", status: "all", group: "all", componentId: undefined, chromePartId: undefined };
  /** All languages in a column each, or one language beside the default text. */
  private view: "grid" | "one" = "grid";
  private oneLanguage: string | undefined;
  /** Cells typed and not yet applied; Apply writes them all as one undo step. */
  private readonly pending: LanguagesPending = new Map();
  /**
   * How many rows of each group the table has painted (absent = the first window). A form with
   * thousands of texts would otherwise build tens of thousands of inputs in one innerHTML on every
   * filter change; "Show more" widens one group's window by one step.
   */
  private readonly windows = new Map<string, number>();
  /** The search box's pending repaint: typing sets the query at once and paints the table once it pauses. */
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Takes this surface's leave guard off the controller's stack while it holds typed cells. The
   * guard is stacked (`pushLeaveGuard`), never the controller's one slot: the slot is the Logic
   * surface's, and either surface clearing it would drop the other's question.
   */
  private removeGuard: (() => void) | undefined;
  /** Whether the shell shows the surface; hidden, a change is only noted and drawn when it is back. */
  private shownValue = true;
  /** Something the page draws from changed while it was hidden. */
  private dirty = false;
  /** Set while a write of its own runs: the change it raises is settled by the caller, not repainted over the box being typed in. */
  private committing = false;
  /** The language whose card menu is open. */
  private menuOpen: string | undefined;
  /** The language whose removal is being asked about. */
  private confirmingRemoval: string | undefined;
  /** The language being made the default, asked about first. */
  private confirmingDefault: string | undefined;
  /** The language whose code is being renamed, with the new code as typed and why it was refused. */
  private renaming: string | undefined;
  private renameCode = "";
  private renameProblem: string | undefined;
  /** The Add row as typed. */
  private addCode = "";
  private addLabel = "";
  /** Why the last language change was refused. */
  private languageProblem: string | undefined;
  /** The form root's draft held a language change back: the card says so and offers to settle it. */
  private rootBlocked = false;
  /** The cell typed into last: where focus goes once Apply or Discard takes the pending bar away. */
  private lastTyped: { key: string; locale: string } | undefined;
  /** Import was asked for while typed cells waited: the surface's own Apply or Discard question is up. */
  private askingImport = false;
  /**
   * Where the surface's Undo and Redo keys go (as on `DatumBuilderPanelBase`): the
   * shell's one method, which asks the mode's history first. Unset (the surface on its own): the
   * controller's own Undo and Redo.
   */
  public historyStep: ((controller: BuilderController, direction: "undo" | "redo") => void) | undefined;

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    // The shell's copy of the goto event (a panel's "Open in Languages") reaches the surface itself
    // and does not bubble; the surface's own raise (show it in Form) bubbles and is not for it.
    this.addEventListener("builder-languages-goto", (event) => this.onGoto(event as CustomEvent<BuilderLanguagesGotoDetail>));
  }

  public connectedCallback(): void {
    this.bind();
    this.subscribe();
    this.paint();
  }

  public disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.releaseGuard();
    this.closeExchange();
    this.cancelSearchPaint();
  }

  /**
   * Listens to the controller's changes while the surface is on the page. A surface the shell drops
   * (a reconnect replaces its markup) would otherwise stay in the controller's listener list for
   * the controller's life, so it lets go on disconnect and takes the listener again on connect.
   * The controller itself stays: the setter owns that, and the leave guard with it.
   */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.ctrl?.on("change", (change) => this.onChange(change));
  }

  /**
   * Whether the shell shows the surface (the Languages workspace is on). Hidden, it draws nothing:
   * a change is noted, and the page is drawn once when it is shown again, if anything it draws
   * from changed meanwhile.
   */
  public get shown(): boolean {
    return this.shownValue;
  }

  public set shown(value: boolean) {
    const next = value !== false;
    if (next === this.shownValue) {
      return;
    }
    this.shownValue = next;
    if (next && this.dirty) {
      this.dirty = false;
      this.refresh();
    }
  }

  /** The form's controller: Languages reads and writes the form only. */
  public get controller(): BuilderController | undefined {
    return this.ctrl;
  }

  public set controller(value: BuilderController | undefined) {
    if (value === this.ctrl) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.releaseGuard();
    this.ctrl = value;
    this.pending.clear();
    this.lastTyped = undefined;
    this.askingImport = false;
    this.menuOpen = undefined;
    this.confirmingRemoval = undefined;
    this.confirmingDefault = undefined;
    this.renaming = undefined;
    if (this.isConnected) {
      this.subscribe();
    }
    this.paint();
  }

  /** The whole definition, as the other workspaces take it; kept for the shell's one wiring. */
  public get definition(): (() => FormDefinition | undefined) | undefined {
    return this.definitionSource;
  }

  /** Read when an exchange dialog opens (the form's id names the file); the page draws nothing from it. */
  public set definition(source: (() => FormDefinition | undefined) | undefined) {
    this.definitionSource = source;
  }

  /**
   * The canvas's preview language (the bar's and Settings'): the switcher row shows it. This
   * setter and the other inputs the shell hands on every visit draw only what they change.
   */
  public set locale(value: string | undefined) {
    if (value === this.localeValue) {
      return;
    }
    this.localeValue = value;
    this.refresh();
  }

  public get locale(): string | undefined {
    return this.localeValue;
  }

  /** The builder's words (the text catalog), English until the host sets a locale or catalog. */
  private readonly words = areaWords();

  /** The builder's own language for its words, not the form's (`locale` is the bar's preview language). */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.paintWords();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.paintWords();
    }
  }

  /** New builder words: every label changes, which the texts' key does not see. */
  private paintWords(): void {
    this.paintedKey = undefined;
    this.refresh();
  }

  private t(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return this.words.text(key, params);
  }

  /** Whether the page lent a translations catalog: the Texts say that a text it words is read-only. */
  public set hostCatalog(value: boolean) {
    this.hostCatalogValue = value === true;
    this.refresh();
  }

  public get hostCatalog(): boolean {
    return this.hostCatalogValue;
  }

  /**
   * The host's catalog itself (what `translationsSource` answers): a text it holds an entry for
   * shows that entry in the cell, read-only, and coverage counts it, since the catalog wins over
   * the form's own translation.
   */
  public set translationCatalog(value: TranslationCatalog | undefined) {
    if (value === this.translationCatalogValue) {
      return;
    }
    this.translationCatalogValue = value;
    this.refresh();
  }

  public get translationCatalog(): TranslationCatalog | undefined {
    return this.translationCatalogValue;
  }

  /**
   * Texts kept outside the form's tree that a catalog lists too — the journeys' names, wording
   * and page titles (`BuilderMode.translatableTexts`). Listed under Journeys; the controller
   * writes their translations like any other.
   */
  public set extraTexts(value: TextsSource | undefined) {
    this.extraTextsValue = value ?? [];
    this.refresh();
  }

  public get extraTexts(): readonly TranslatableText[] {
    return this.listed(this.extraTextsValue);
  }

  /** The PDF layouts' names, titles, headings and static text, listed under PDF. */
  public set pdfTexts(value: TextsSource | undefined) {
    this.pdfTextsValue = value ?? [];
    this.refresh();
  }

  public get pdfTexts(): readonly TranslatableText[] {
    return this.listed(this.pdfTextsValue);
  }

  private listed(source: TextsSource): readonly TranslatableText[] {
    return typeof source === "function" ? source(this.words.options()) : source;
  }

  /** How many typed cells differ from what the form stores. */
  public get pendingCount(): number {
    return changedCells(this.texts.rows, this.pending).length;
  }

  /** The texts as last painted: what the exchange dialogs adapt to their rows. */
  public get textRows(): readonly LanguagesRow[] {
    return this.texts.rows;
  }

  /** The exchange dialog this surface opened and has not seen close (one at a time). */
  private exchange: { close: () => void } | undefined;

  /** Opens the Export dialog (`languages-exchange-dialog.ts`). */
  public openExport(): void {
    const host = this.exchangeHost();
    if (host) {
      this.closeExchange();
      this.exchange = openExportDialog(host);
    }
  }

  /**
   * Opens the Import dialog; Apply writes through the controller's `setTranslations`, one undo
   * step. While typed cells wait, it asks Apply or Discard first (the leave guard's question), so
   * the preview compares the file with what the form stores and no typed cell is left to write
   * over the import afterwards.
   */
  public openImport(): void {
    if (this.ctrl && this.pendingCount > 0) {
      this.closeExchange();
      this.askingImport = true;
      this.paint();
      return;
    }
    const host = this.exchangeHost();
    if (host) {
      this.closeExchange();
      this.exchange = openImportDialog(host);
    }
  }

  /**
   * Closes the exchange dialog this surface opened, if one is up, and the Apply or Discard
   * question with it. The shell calls it when it hides the Languages workspace from code (a modal
   * dialog under a hidden ancestor would leave the page inert behind nothing); a disconnect does
   * it too. Closing twice is harmless.
   */
  public closeExchange(): void {
    const open = this.exchange;
    this.exchange = undefined;
    open?.close();
    this.closeQuestion();
  }

  /**
   * Drops the typed cells, lets go of the leave guard and puts away any question about them. The
   * shell calls it when the host takes the workspace away while cells wait (discard and leave);
   * with nothing typed or asked it changes nothing.
   */
  public discardPending(): void {
    // A leave question the controller holds for this guard would outlive the cells it asks about (and
    // be redrawn as "You typed 1 translation" with nothing pending): drop the held run, as Stay does.
    if (this.ctrl?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
      this.ctrl.answerUnsavedChangesPrompt("stay");
    }
    const held = this.pending.size > 0 || this.askingImport;
    this.closeQuestion();
    this.releaseGuard();
    if (!held) {
      return;
    }
    this.pending.clear();
    this.paintedKey = undefined;
    this.refresh();
  }

  /**
   * Forgets the Import question and takes down the question dialog on the page. The next paint
   * draws whatever is still asked (the controller's own leave question comes back while it is held).
   */
  private closeQuestion(): void {
    this.askingImport = false;
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (dialog) {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
      dialog.remove();
      this.paintedKey = undefined;
    }
  }

  private exchangeHost(): ExchangeHost | undefined {
    const controller = this.ctrl;
    if (!controller) {
      return undefined;
    }
    return {
      root: this.root,
      controller,
      rows: () => this.texts.rows,
      words: this.words,
      formId: this.definitionSource?.()?.id ?? "form",
      rowLabel: (row) => this.rowLabel(row),
      whereLabel: (row) => this.whereLabel(row),
      groupLabel: (id) => this.groupLabel(id),
      say: (text) => this.say(text)
    };
  }

  // --- the controller and its leave guard ------------------------------------------

  private syncGuard(): void {
    const held = this.pendingCount > 0;
    if (held && this.removeGuard === undefined && this.ctrl && this.isConnected) {
      this.removeGuard = this.ctrl.pushLeaveGuard({
        pending: () => this.pendingCount > 0,
        subject: () => ({ id: GUARD_ID, label: this.t("languages.translations.guard"), blocked: false }),
        save: () => this.apply(),
        discard: () => this.discard()
      });
    } else if (!held && this.removeGuard !== undefined) {
      this.releaseGuard();
    }
  }

  private releaseGuard(): void {
    const remove = this.removeGuard;
    this.removeGuard = undefined;
    remove?.();
  }

  private onChange(change: BuilderChangeEvent | undefined): void {
    if (!this.isConnected || !this.ctrl) {
      return;
    }
    if (change?.reason === "init") {
      // Another document in the same controller (a host's options): what was typed, asked or
      // narrowed to belongs to the last one, as the controller's own drafts did.
      this.forgetDocument();
    }
    if (this.committing) {
      return;
    }
    if (!this.shownValue) {
      // Hidden: drawn when shown again. Typed cells of a text that has gone still go now, so the
      // leave guard never names one; with none typed (the usual case) nothing is listed.
      this.dirty = true;
      if (this.pending.size > 0) {
        this.prunePending(this.computeTexts());
        this.syncGuard();
      }
      return;
    }
    this.refresh();
  }

  /**
   * Draws the page when something it draws from changed since the last paint, else nothing: a
   * change elsewhere (a selection, a draft keystroke in a panel, the shell handing the same
   * inputs again) leaves the cells alone, so a box being typed in keeps its caret.
   */
  private refresh(): void {
    if (!this.isConnected) {
      return;
    }
    if (!this.shownValue) {
      this.dirty = true;
      return;
    }
    if (!this.ctrl) {
      this.paint();
      return;
    }
    const texts = this.computeTexts();
    if (this.drawKey(texts) === this.paintedKey) {
      return;
    }
    this.paint(texts);
  }

  /** Drops what was typed, asked about or narrowed to for the document the controller held before. */
  private forgetDocument(): void {
    this.pending.clear();
    this.lastTyped = undefined;
    this.askingImport = false;
    this.releaseGuard();
    this.menuOpen = undefined;
    this.confirmingRemoval = undefined;
    this.confirmingDefault = undefined;
    this.renaming = undefined;
    this.renameCode = "";
    this.renameProblem = undefined;
    this.addCode = "";
    this.addLabel = "";
    this.languageProblem = undefined;
    this.rootBlocked = false;
    this.filter.componentId = undefined;
    this.filter.chromePartId = undefined;
    this.windows.clear();
    // Drawn again even when the new document's texts read the same: the boxes held the typing.
    this.paintedKey = undefined;
  }

  /** Typed cells of a text that has gone (an undo, a field removed in Form) go with it. */
  private prunePending(texts: LanguagesTexts): void {
    const keys = new Set(texts.rows.map((row) => rowKey(row.address)));
    for (const key of [...this.pending.keys()]) {
      if (!keys.has(key)) {
        this.pending.delete(key);
      }
    }
  }

  private computeTexts(): LanguagesTexts {
    const controller = this.ctrl!;
    return languagesTexts({
      texts: controller.translatableTexts(),
      modeTexts: [...this.extraTexts, ...this.pdfTexts],
      engineTexts: engineTexts(),
      enginePluralTexts,
      translations: controller.translations(),
      catalog: this.translationCatalogValue ?? controller.translationCatalog(),
      localization: controller.localization()
    });
  }

  private drawKey(texts: LanguagesTexts): string {
    const controller = this.ctrl!;
    return JSON.stringify({
      texts,
      hostCatalog: this.hostCatalogValue,
      localization: controller.localization() ?? null,
      rootPending: controller.hasPendingChanges(controller.rootId()),
      prompt: controller.unsavedChangesPrompt() ?? null,
      switcher: this.switcher(),
      preview: this.previewLocale()
    });
  }

  private config(): LocalizationConfiguration | undefined {
    return this.ctrl?.localization();
  }

  private switcher(): { place: SwitcherPlace; label: string } {
    return switcherState(this.chromeOf());
  }

  /** The form root's authored chrome, as stored. */
  private chromeOf(): unknown {
    return (this.ctrl?.snapshot().configuration as Record<string, unknown> | undefined)?.chrome;
  }

  private previewLocale(): string | undefined {
    // The controller's language is the truth: a change that skipped the shell (an agent tool, a
    // direct call) leaves the surface's own copy behind, so the select and drawKey would lag it.
    return this.ctrl?.currentLocale() ?? this.localeValue;
  }

  // --- painting ---------------------------------------------------------------------

  /** What stays put across repaints: the styles and the live region. */
  private frame(): HTMLElement {
    let main = this.root.querySelector<HTMLElement>("[data-languages-main]");
    if (!main) {
      this.root.innerHTML = `<style>${builderTokens()}${LANGUAGES_STYLES}</style>
        <div class="languages" data-languages-main></div>
        <p class="sr-only" aria-live="polite" data-languages-live></p>`;
      main = this.root.querySelector<HTMLElement>("[data-languages-main]")!;
    }
    return main;
  }

  private paint(texts?: LanguagesTexts): void {
    if (!this.isConnected) {
      return;
    }
    if (!this.shownValue) {
      // Asked for while hidden (the leave guard's Discard from another workspace): drawn in
      // full once shown, whatever the texts say then, since the boxes may hold what went.
      this.dirty = true;
      this.paintedKey = undefined;
      return;
    }
    const main = this.frame();
    const controller = this.ctrl;
    if (!controller) {
      main.innerHTML = `<p class="empty">${esc(this.t("shell.noController"))}</p>`;
      this.paintedKey = undefined;
      return;
    }
    this.texts = texts ?? this.computeTexts();
    this.prunePending(this.texts);
    if (!controller.hasPendingChanges(controller.rootId())) {
      this.rootBlocked = false;
    }
    const config = this.config();
    const columns = translationColumns(config);
    if (columns.length < 2) {
      this.view = "grid";
    }
    if (this.oneLanguage === undefined || !columns.some((entry) => entry.code === this.oneLanguage)) {
      this.oneLanguage = columns[0]?.code;
    }
    if (this.filter.group !== "all" && !this.texts.rows.some((row) => row.groupId === this.filter.group)) {
      this.filter.group = "all";
    }
    if (columns.length === 0) {
      this.filter.status = "all";
    }
    for (const key of ["menuOpen", "confirmingRemoval", "confirmingDefault", "renaming"] as const) {
      const code = this[key];
      if (code !== undefined && !languageEntries(config).some((entry) => entry.code === code)) {
        this[key] = undefined;
      }
    }
    this.cancelSearchPaint();
    const focus = this.captureFocus();
    main.innerHTML = `${this.languagesHtml(config, columns)}
      ${this.switcherHtml(config, columns)}
      ${this.textsHtml(config, columns)}
      ${this.promptHtml(controller)}`;
    this.restoreFocus(focus);
    this.paintedKey = this.drawKey(this.texts);
    this.syncGuard();
    const dialog = this.root.querySelector<HTMLDialogElement>("dialog[data-prompt]");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
      dialog.querySelector<HTMLElement>("[autofocus]:not([disabled])")?.focus();
    }
  }

  // --- the Languages cards ----------------------------------------------------------------

  private languagesHtml(config: LocalizationConfiguration | undefined, columns: LanguageEntry[]): string {
    const entries = languageEntries(config);
    const list =
      entries.length === 0
        ? ""
        : `<ul class="lang-list">${entries.map((entry) => this.languageHtml(entry, columns)).join("")}</ul>
          ${config?.defaultLocale === undefined ? `<p class="muted small">${this.words.html("languages.noDefault", { code: `<code>${esc(effectiveDefaultLocale(config))}</code>` })}</p>` : ""}`;
    // A form with no second language is invited to add one before anything else.
    const invite = columns.length === 0 ? `<p class="lead" data-languages-invite>${esc(this.t("languages.invite.body"))}</p>` : "";
    const taken = new Set(entries.map((entry) => entry.code.toLowerCase()));
    const suggestions = SUGGESTED_CODES.filter((code) => !taken.has(code.toLowerCase()))
      .map((code) => `<option value="${esc(code)}">${esc(localeDisplayName(code))}</option>`)
      .join("");
    const namePlaceholder = this.addCode.trim() && !languageCodeIssue(this.addCode, config) ? localeDisplayName(this.addCode.trim()) : this.t("languages.add.name.placeholder");
    return `<section class="langs card" aria-labelledby="languages-title" data-languages-card>
        <header class="card-head"><h2 class="card-title" id="languages-title">${esc(this.t("languages.title"))}</h2><p class="card-lead">${esc(this.t("languages.lead"))}</p></header>
        ${this.rootBlocked ? this.rootBlockedHtml() : ""}
        ${invite}
        ${list}
        <div class="lang-add" role="group" aria-labelledby="languages-add-title">
          <h3 class="card-heading" id="languages-add-title">${esc(this.t("languages.add.title"))}</h3>
          <div class="lang-add-row">
            <label class="field"><span class="field-label">${esc(this.t("languages.add.code"))}</span><input type="text" data-languages-add-code list="languages-codes" value="${esc(this.addCode)}" placeholder="${esc(this.t("languages.add.code.placeholder"))}" spellcheck="false" autocomplete="off"${
              this.languageProblem ? ' aria-invalid="true" aria-describedby="languages-add-problem"' : ""
            }></label>
            <label class="field"><span class="field-label">${esc(this.t("languages.add.name"))}</span><input type="text" data-languages-add-label value="${esc(this.addLabel)}" placeholder="${esc(namePlaceholder)}"></label>
            <button type="button" class="btn" data-languages-add>${esc(this.t("languages.add.button"))}</button>
          </div>
          <datalist id="languages-codes">${suggestions}</datalist>
          ${this.languageProblem ? `<p class="problem" id="languages-add-problem" role="alert">${esc(this.languageProblem)}</p>` : ""}
        </div>
      </section>`;
  }

  /** The figures on a language's card: a meter, the share translated, and what still needs the author. */
  private statsHtml(entry: LanguageEntry): string {
    const coverage = languageCoverage(this.texts.rows, entry.code, this.pending);
    const percent = coverage.total === 0 ? 0 : Math.round((coverage.translated / coverage.total) * 100);
    if (coverage.total === 0) {
      return `<span class="muted">${esc(this.t("languages.card.none"))}</span>`;
    }
    return `<progress max="100" value="${percent}" aria-label="${esc(this.t("languages.card.progress", { name: entry.label }))}"></progress>
      <span data-languages-percent>${esc(this.t("languages.card.percent", { percent }))}</span>
      <span class="muted" data-languages-lang-coverage="${esc(entry.code)}">${esc(this.coverageText(coverage))}</span>
      ${coverage.missing > 0 ? `<span class="badge badge--warn" data-languages-missing-count>${esc(this.t("languages.card.missing", { count: coverage.missing }))}</span>` : ""}
      ${coverage.stale > 0 ? `<span class="badge badge--warn" data-languages-stale-count>${esc(this.t("languages.card.stale", { count: coverage.stale }))}</span>` : ""}`;
  }

  private languageHtml(entry: LanguageEntry, columns: LanguageEntry[]): string {
    const code = esc(entry.code);
    const translated = columns.some((column) => column.code === entry.code);
    const open = this.menuOpen === entry.code;
    return `<li class="lang" data-languages-lang="${code}">
        <div class="lang-row">
          <code class="lang-code" lang="${code}">${code}</code>
          <input type="text" class="lang-label" data-languages-label="${code}" value="${esc(entry.storedLabel)}" placeholder="${esc(localeDisplayName(entry.code))}"
            aria-label="${esc(this.t("languages.lang.nameLabel", { name: entry.label, code: entry.code }))}">
          ${entry.isDefault ? `<span class="badge badge--default" data-languages-default-badge>${esc(this.t("languages.default.badge"))}</span>` : ""}
          <span class="lang-menu-wrap" data-languages-menu-wrap>
            <button type="button" class="icon-btn" data-languages-menu="${code}" aria-expanded="${open}" aria-controls="languages-menu-${code}"
              aria-label="${esc(this.t("languages.card.menu", { name: entry.label, code: entry.code }))}" data-tip="${esc(this.t("languages.card.menu", { name: entry.label, code: entry.code }))}" data-tip-side="start"><span aria-hidden="true">⋯</span></button>
            <div class="menu lang-menu" id="languages-menu-${code}" role="group" aria-label="${esc(this.t("languages.card.menu", { name: entry.label, code: entry.code }))}"${open ? "" : " hidden"}>
              ${entry.isDefault ? "" : `<button type="button" class="menu-item" data-languages-default="${code}">${esc(this.t("languages.default.make"))}</button>`}
              <button type="button" class="menu-item" data-languages-rename="${code}" aria-label="${esc(this.t("languages.rename.buttonLabel", { name: entry.label, code: entry.code }))}">${esc(this.t("languages.rename.button"))}</button>
              <button type="button" class="menu-item danger" data-languages-remove="${code}" aria-label="${esc(this.t("languages.lang.removeLabel", { name: entry.label, code: entry.code }))}">${esc(this.t("languages.lang.remove"))}</button>
            </div>
          </span>
        </div>
        <div class="lang-stats" data-languages-lang-stats="${code}">${translated ? this.statsHtml(entry) : `<span class="muted">${esc(this.t("languages.card.source"))}</span>`}</div>
        ${this.renaming === entry.code ? this.renameHtml(entry) : ""}
        ${this.confirmingDefault === entry.code ? this.defaultHtml(entry) : ""}
        ${this.confirmingRemoval === entry.code ? this.removalHtml(entry) : ""}
      </li>`;
  }

  /** The new code's box under the language: the code is checked as a new one is, and the translations written in it go along. */
  private renameHtml(entry: LanguageEntry): string {
    return `<div class="confirm note" role="group" aria-labelledby="languages-rename-title" data-languages-rename-form>
        <p id="languages-rename-title"><strong>${this.words.html("languages.rename.title", { code: `<code>${esc(entry.code)}</code>` })}</strong></p>
        <label class="field"><span class="field-label">${esc(this.t("languages.rename.code"))}</span><input type="text" data-languages-rename-code value="${esc(this.renameCode)}" spellcheck="false" autocomplete="off"${
          this.renameProblem ? ' aria-invalid="true" aria-describedby="languages-rename-problem"' : ""
        }></label>
        ${this.renameProblem ? `<p class="problem" id="languages-rename-problem" role="alert">${esc(this.renameProblem)}</p>` : ""}
        <p>${this.words.html("languages.rename.detail", { code: `<code>${esc(entry.code)}</code>` })}</p>
        <div class="confirm-actions">
          <button type="button" class="btn small" data-languages-rename-cancel>${esc(this.t("languages.rename.cancel"))}</button>
          <button type="button" class="btn small primary" data-languages-rename-confirm="${esc(entry.code)}">${esc(this.t("languages.rename.confirm"))}</button>
        </div>
      </div>`;
  }

  /** The question before a new default: what becomes the default text and where the old one goes, Keep first. */
  private defaultHtml(entry: LanguageEntry): string {
    const config = this.config();
    const old = languageEntries(config).find((candidate) => candidate.code === effectiveDefaultLocale(config));
    const count = promotedTextCount(this.texts.rows, entry.code);
    const typed = this.typedCount(entry.code);
    const detail = count === 0 ? this.t("languages.default.detail.none") : this.words.plural("languages.default.detail.some", count, { old: old?.label ?? effectiveDefaultLocale(config) });
    return `<div class="confirm note" data-tone="warning" role="group" aria-labelledby="languages-default-title" data-languages-default-confirm-box>
        <p id="languages-default-title"><strong>${this.words.html("languages.default.title", { name: esc(entry.label), code: `<code>${esc(entry.code)}</code>` })}</strong></p>
        <p>${esc(detail)}${count > 0 ? ` ${esc(this.t("languages.default.detail.rest"))}` : ""}</p>
        ${typed > 0 ? `<p data-languages-default-typed>${esc(this.words.plural("languages.default.typed", typed, { name: entry.label }))}</p>` : ""}
        <div class="confirm-actions">
          <button type="button" class="btn small" data-languages-default-keep>${esc(this.t("languages.default.keep", { name: old?.label ?? effectiveDefaultLocale(config) }))}</button>
          <button type="button" class="btn small primary" data-languages-default-confirm="${esc(entry.code)}">${esc(this.t("languages.default.confirm"))}</button>
        </div>
      </div>`;
  }

  /** The removal's question, under the language: what goes with it, Keep first. */
  private removalHtml(entry: LanguageEntry): string {
    const inline = this.ctrl!.localeTranslationCount([entry.code]);
    const typed = changedCells(this.texts.rows, this.pending).filter((cell) => cell.locale === entry.code).length;
    // Taking the default language away promotes the first left: its wording becomes the default text.
    const config = this.config();
    const nextCode = entry.isDefault ? defaultAfterRemoval(config, entry.code) : undefined;
    const next = nextCode !== undefined ? languageEntries(config).find((candidate) => candidate.code === nextCode) : undefined;
    const promoted = nextCode !== undefined ? promotedTextCount(this.texts.rows, nextCode) : 0;
    const typedNext = nextCode !== undefined ? this.typedCount(nextCode) : 0;
    const parts = [
      inline === 0 ? this.t("languages.remove.none") : this.words.plural("languages.remove.some", inline),
      typed > 0 ? this.t("languages.remove.typed", { count: typed }) : "",
      next ? (promoted === 0 ? this.t("languages.remove.default.none", { next: next.label }) : this.words.plural("languages.remove.default.some", promoted, { next: next.label })) : "",
      next && typedNext > 0 ? this.words.plural("languages.remove.default.typed", typedNext, { next: next.label }) : ""
    ].filter(Boolean);
    return `<div class="confirm note" data-tone="warning" role="group" aria-labelledby="languages-remove-title" data-languages-confirm>
        <p id="languages-remove-title"><strong>${this.words.html("languages.remove.title", { name: esc(entry.label), code: `<code>${esc(entry.code)}</code>` })}</strong></p>
        <p>${esc(this.t("languages.remove.detail", { parts: parts.join("; ") }))}</p>
        <div class="confirm-actions">
          <button type="button" class="btn small" data-languages-remove-keep>${esc(this.t("languages.remove.keep"))}</button>
          <button type="button" class="btn small danger" data-languages-remove-confirm="${esc(entry.code)}">${esc(this.t("languages.remove.confirm"))}</button>
        </div>
      </div>`;
  }

  /**
   * The form root has settings not applied, which a language change that rewrites the form's
   * texts (rename, make default, a removal that moves the default) will not run over: say so, and
   * offer to settle them.
   */
  private rootBlockedHtml(): string {
    return `<div class="notice note" data-tone="warning" role="alert" data-languages-root-blocked>
        <p>${esc(this.t("languages.blocked"))}</p>
        <div class="confirm-actions">
          <button type="button" class="btn small" data-languages-root-discard>${esc(this.t("languages.blocked.discard"))}</button>
          <button type="button" class="btn small primary" data-languages-root-apply>${esc(this.t("languages.blocked.apply"))}</button>
        </div>
      </div>`;
  }

  // --- the switcher row -------------------------------------------------------------------

  private switcherHtml(config: LocalizationConfiguration | undefined, columns: LanguageEntry[]): string {
    const { place, label } = this.switcher();
    const places: Array<[SwitcherPlace, string]> = [
      ["header", this.t("languages.switcher.place.header")],
      ["footer", this.t("languages.switcher.place.footer")],
      ...(place === "both" ? ([["both", this.t("languages.switcher.place.both")]] as Array<[SwitcherPlace, string]>) : []),
      ["none", this.t("languages.switcher.place.none")]
    ];
    // The canvas language: the form's languages, and the language its strings are written in when the list leaves it out (as Settings does).
    const fallback = effectiveDefaultLocale(config);
    const options = supportedLocaleOptions(config);
    const previewOptions = options.some((option) => option.code === fallback) ? options : [{ code: fallback, label: localeDisplayName(fallback) }, ...options];
    const preview = this.previewLocale() ?? fallback;
    return `<section class="switcher card" aria-labelledby="languages-switcher-title" data-languages-switcher>
        <header class="card-head"><h3 class="card-heading" id="languages-switcher-title">${esc(this.t("languages.switcher.title"))}</h3><p class="card-lead">${esc(this.t("languages.switcher.lead"))}</p></header>
        <div class="switcher-row">
          <label class="field"><span class="field-label">${esc(this.t("languages.switcher.place"))}</span><select data-languages-switcher-place>${places
            .map(([value, text]) => `<option value="${value}"${place === value ? " selected" : ""}>${esc(text)}</option>`)
            .join("")}</select></label>
          <label class="field"><span class="field-label">${esc(this.t("languages.switcher.label"))}</span><input type="text" data-languages-switcher-label value="${esc(label)}" placeholder="${esc(this.t("languages.switcher.label.placeholder"))}"${place === "none" ? " disabled" : ""}></label>
          <label class="field"><span class="field-label">${esc(this.t("languages.switcher.preview"))}</span><select data-languages-preview>${previewOptions
            .map((option) => `<option value="${esc(option.code)}"${preview === option.code ? " selected" : ""}>${esc(option.label)}</option>`)
            .join("")}</select></label>
        </div>
        <p class="muted small">${esc(this.t("languages.switcher.previewNote"))}${columns.length === 0 ? ` ${esc(this.t("languages.switcher.idle"))}` : ""}</p>
      </section>`;
  }

  // --- the Texts --------------------------------------------------------------------------

  private textsHtml(config: LocalizationConfiguration | undefined, columns: LanguageEntry[]): string {
    const rows = this.texts.rows;
    const groups = languagesGroupsOf(rows);
    const lead =
      languageEntries(config).length === 0
        ? `<p class="muted">${esc(this.t("languages.texts.addFirst"))}</p>`
        : columns.length === 0
          ? `<p class="muted">${esc(this.t("languages.texts.onlyDefault"))}</p>`
          : "";
    const rail = [
      `<li><button type="button" class="rail-btn" data-languages-group="all" aria-pressed="${this.filter.group === "all"}">${esc(this.t("languages.texts.group.all"))} <span class="muted">${rows.length}</span></button></li>`,
      ...groups.map(
        (group) =>
          `<li><button type="button" class="rail-btn" data-languages-group="${group.id}" aria-pressed="${this.filter.group === group.id}">${esc(this.groupLabel(group.id))} <span class="muted">${group.count}</span></button></li>`
      )
    ].join("");
    const statuses: Array<["all" | CellStatus, BuilderTextKey]> = [
      ["all", "languages.filter.status.all"],
      ["missing", "languages.filter.status.missing"],
      ["stale", "languages.filter.status.stale"],
      ["overridden", "languages.filter.status.overridden"]
    ];
    return `<section class="texts card" aria-labelledby="languages-texts-title" data-languages-texts>
        <header class="card-head texts-head">
          <div><h3 class="card-heading" id="languages-texts-title">${esc(this.t("languages.texts.title"))}</h3><p class="card-lead">${esc(this.t("languages.texts.sub", { count: this.words.plural("languages.texts.count", rows.length) }))}</p></div>
          <div class="exchange">
            <button type="button" class="btn small" data-languages-export>${esc(this.t("languages.export"))}</button>
            <button type="button" class="btn small" data-languages-import>${esc(this.t("languages.import"))}</button>
          </div>
        </header>
        ${this.hostCatalogValue ? `<p class="muted small" data-languages-catalog-note>${esc(this.t("languages.texts.catalogNote"))}</p>` : ""}
        ${lead}
        <div class="texts-body">
          <nav class="rail" aria-label="${esc(this.t("languages.rail.label"))}"><ul>${rail}</ul></nav>
          <div class="texts-main">
            <div class="filters" role="group" aria-label="${esc(this.t("languages.filter.label"))}">
              <label class="field search"><span class="field-label">${esc(this.t("languages.filter.search"))}</span><input type="search" data-languages-search value="${esc(this.filter.query)}" placeholder="${esc(this.t("languages.filter.search.placeholder"))}"></label>
              ${
                columns.length > 0
                  ? `<label class="field"><span class="field-label">${esc(this.t("languages.filter.status"))}</span><select data-languages-status>${statuses
                      .map(([value, key]) => `<option value="${value}"${this.filter.status === value ? " selected" : ""}>${esc(this.t(key))}</option>`)
                      .join("")}</select></label>`
                  : ""
              }
              ${
                columns.length > 1
                  ? `<div class="field" role="group" aria-label="${esc(this.t("languages.view.label"))}"><span class="field-label">${esc(this.t("languages.view.label"))}</span>
                      <span class="seg"><button type="button" data-languages-view="grid" aria-pressed="${this.view === "grid"}">${esc(this.t("languages.view.grid"))}</button><button type="button" data-languages-view="one" aria-pressed="${this.view === "one"}">${esc(this.t("languages.view.single"))}</button></span></div>
                    ${
                      this.view === "one"
                        ? `<label class="field"><span class="field-label">${esc(this.t("languages.view.language"))}</span><select data-languages-language>${columns
                            .map((entry) => `<option value="${esc(entry.code)}"${this.oneLanguage === entry.code ? " selected" : ""}>${esc(entry.label)}</option>`)
                            .join("")}</select></label>`
                        : ""
                    }`
                  : ""
              }
            </div>
            ${this.view === "one" ? `<p class="muted small" data-languages-one-hint>${esc(this.t("languages.view.hint"))}</p>` : ""}
            ${this.componentChipHtml()}
            <div class="table-region" data-languages-table>${this.tableHtml(columns)}</div>
            ${this.pendingBarHtml()}
          </div>
        </div>
      </section>`;
  }

  private componentChipHtml(): string {
    const part = this.filter.chromePartId;
    const id = this.filter.componentId;
    if (id === undefined && part === undefined) {
      return "";
    }
    const name =
      part !== undefined
        ? this.t("languages.texts.row.chromePart", { part })
        : (this.texts.rows.find((row) => row.componentId === id)?.componentLabel ?? id ?? "");
    return `<p class="chip" data-languages-component><span>${esc(this.t("languages.component.only", { name }))}</span> <button type="button" class="btn small" data-languages-component-clear>${esc(this.t("languages.component.clear"))}</button></p>`;
  }

  private pendingBarHtml(): string {
    const count = this.pendingCount;
    return `<div class="pending" role="region" aria-label="${esc(this.t("languages.pending.label"))}" data-languages-pending${count > 0 ? "" : " hidden"}>
        <p data-languages-pending-count aria-live="polite">${esc(this.words.plural("languages.pending.count", count))}</p>
        <button type="button" class="btn small" data-languages-discard>${esc(this.t("languages.pending.discard"))}</button>
        <button type="button" class="btn small primary" data-languages-apply>${esc(this.t("languages.pending.apply"))}</button>
      </div>`;
  }

  private groupLabel(id: LanguagesGroupId): string {
    return this.t(`languages.texts.group.${id}` as BuilderTextKey);
  }

  /** The columns the table draws: every language, or the one chosen in the one-language view. */
  private shownColumns(columns: LanguageEntry[]): LanguageEntry[] {
    return this.view === "one" ? columns.filter((entry) => entry.code === this.oneLanguage) : columns;
  }

  private filteredRows(columns: LanguageEntry[]): LanguagesRow[] {
    return filterLanguagesRows(
      this.texts.rows,
      {
        group: this.filter.group,
        status: this.filter.status,
        query: this.filter.query,
        ...(this.filter.componentId !== undefined ? { componentId: this.filter.componentId } : {}),
        ...(this.filter.chromePartId !== undefined ? { chromePartId: this.filter.chromePartId } : {}),
        language: this.view === "one" && this.oneLanguage !== undefined ? this.oneLanguage : "all"
      },
      columns.map((entry) => entry.code),
      this.pending,
      (row) => `${this.whereLabel(row)}\n${this.rowLabel(row)}`
    );
  }

  private tableHtml(columns: LanguageEntry[]): string {
    const all = this.texts.rows;
    const shown = this.shownColumns(columns);
    const empty = this.texts.emptyCount > 0 ? `<p class="muted small">${esc(this.words.plural("languages.unlisted", this.texts.emptyCount))}</p>` : "";
    if (all.length === 0) {
      return `<div class="empty-state"><p>${esc(this.t("languages.table.none"))}</p></div>${empty}`;
    }
    const rows = this.filteredRows(columns);
    if (rows.length === 0) {
      return `<div class="empty-state"><p>${esc(this.t("languages.table.noMatch"))}</p></div>${empty}`;
    }
    const config = this.config();
    const sourceName = config?.defaultLocale !== undefined ? supportedLocaleOptions(config).find((option) => option.code === config.defaultLocale)?.label : undefined;
    const span = 3 + shown.length;
    const bodies = languagesGroupsOf(rows)
      .map(
        (group) => `<tbody data-languages-group-body="${group.id}">
            <tr class="group-row"><th scope="colgroup" colspan="${span}">${esc(this.groupLabel(group.id))} <span class="muted">· ${group.count}</span></th></tr>
            ${this.groupRowsHtml(group.id, rows, shown, span)}
          </tbody>`
      )
      .join("");
    return `<div class="table-wrap"><table>
        <caption class="sr-only">${esc(this.t("languages.table.caption"))}</caption>
        <thead><tr>
          <th scope="col">${esc(this.t("languages.col.where"))}</th><th scope="col">${esc(this.t("languages.col.text"))}</th>
          <th scope="col">${esc(this.t("languages.col.default"))}${sourceName ? ` <span class="muted">(${esc(sourceName)})</span>` : ""}</th>
          ${shown.map((entry) => `<th scope="col" lang="${esc(entry.code)}">${esc(entry.label)} <code>${esc(entry.code)}</code></th>`).join("")}
        </tr></thead>
        ${bodies}
      </table></div>
      <p class="muted small" data-languages-shown>${esc(this.words.plural("languages.shown", all.length, { shown: rows.length, total: all.length }))}</p>
      ${empty}`;
  }

  /** One group's rows up to its window, then the "Show more" row when some wait. */
  private groupRowsHtml(id: LanguagesGroupId, rows: LanguagesRow[], shown: LanguageEntry[], span: number): string {
    const mine = rows.filter((row) => row.groupId === id);
    const limit = this.windows.get(id) ?? TEXTS_WINDOW;
    const html = mine.slice(0, limit).map((row) => this.rowHtml(row, shown)).join("");
    if (mine.length <= limit) {
      return html;
    }
    const left = mine.length - limit;
    return `${html}<tr class="more-row"><td colspan="${span}"><button type="button" class="btn small" data-languages-more="${id}">${esc(this.words.plural("languages.table.more", left, { left, group: this.groupLabel(id) }))}</button></td></tr>`;
  }

  /** What the row is, in the builder's words: the model words an option and a header or footer part in English. */
  private rowLabel(row: LanguagesRow): string {
    const { address } = row;
    if (row.groupId === "options" && address.path.length === 3) {
      const value = address.path[1]!;
      return address.path[2] === "description" ? this.t("languages.texts.row.optionDescription", { value }) : this.t("languages.texts.row.option", { value });
    }
    if (row.groupId === "chrome" && address.owner !== undefined) {
      // The region is not part of the address; the builder's name for the property has it.
      const region = /^chrome\.(header|footer)\./.exec(row.propertyPath ?? "")?.[1];
      const part = address.owner;
      const name = region === "header" ? this.t("languages.texts.row.header", { part }) : region === "footer" ? this.t("languages.texts.row.footer", { part }) : this.t("languages.texts.row.chromePart", { part });
      const property = address.path[0] ?? "text";
      if (property === "text") {
        return name;
      }
      const key = `languages.texts.property.${property}` as BuilderTextKey;
      return this.t("languages.texts.row.chromeProperty", { part: name, property: Object.hasOwn(LANGUAGES_CHROME_PROPERTIES, property) ? this.t(key) : property });
    }
    return row.label;
  }

  private whereLabel(row: LanguagesRow): string {
    if (row.groupId === "texts") {
      return this.t(row.address.owner === TEXTS_MESSAGES_OWNER ? "languages.texts.row.engineMessage" : "languages.texts.row.engineText");
    }
    return row.groupId === "catalog" && row.componentId === "" ? this.t("languages.texts.row.catalogForm") : row.componentLabel;
  }

  /**
   * The default column of a row: its text in the default language. An engine word's source is
   * its English, so when the default language is not English its row has a cell for that
   * language too, typed here under the English.
   */
  private defaultCellHtml(row: LanguagesRow): string {
    const source = row.default.trim().length > 0 ? esc(row.default) : '<span class="muted">—</span>';
    const code = effectiveDefaultLocale(this.config());
    const entry = row.groupId === "texts" && Object.hasOwn(row.cells, code) ? languageEntries(this.config()).find((candidate) => candidate.code === code) : undefined;
    if (!entry) {
      return `<td class="default">${source}</td>`;
    }
    const { status, changed, inner } = this.cellParts(row, entry);
    return `<td class="default cell ${status}${changed ? " changed" : ""}" data-status="${status}"><span lang="en">${source}</span>${inner}</td>`;
  }

  private rowHtml(row: LanguagesRow, columns: LanguageEntry[]): string {
    const key = rowKey(row.address);
    const where = row.inForm
      ? `<button type="button" class="row-link" data-languages-goto="${esc(row.componentId)}" title="${esc(this.t("languages.texts.row.goto"))}">${esc(this.whereLabel(row))}</button>`
      : esc(this.whereLabel(row));
    return `<tr data-languages-row="${esc(key)}">
        <td class="where">${where}</td>
        <th scope="row" class="what">${esc(this.rowLabel(row))}</th>
        ${this.defaultCellHtml(row)}
        ${columns.map((entry) => this.cellHtml(row, entry)).join("")}
      </tr>`;
  }

  /** The marker under a cell: what the page's catalog does to it, or that its source changed with Confirm. */
  private cellNoteHtml(row: LanguagesRow, entry: LanguageEntry, status: CellStatus): string {
    if (status === "overridden") {
      return `<span class="marker marker--page" title="${esc(this.t("languages.cell.pageTitle"))}">${esc(this.t("languages.cell.page"))}</span>`;
    }
    // The catalog words it under the language's primary subtag: the cell is the author's to fill,
    // and until it is filled the page's wording is what the form shows.
    const served = Object.hasOwn(row.cells, entry.code) ? row.cells[entry.code]?.pageText : undefined;
    if (served !== undefined && cellText(row, entry.code, this.pending).trim() === "") {
      return `<span class="marker marker--page" data-languages-page-wording>${esc(this.t("languages.cell.pageWording", { text: served }))}</span>`;
    }
    // The form's own text in the language's base language (fr for fr-CA) is what the form shows
    // until this cell has a text of its own: present, and still the author's to fill.
    const cell = Object.hasOwn(row.cells, entry.code) ? row.cells[entry.code] : undefined;
    if (cell?.fallbackFrom === "form" && cell.fallbackText !== undefined && cellText(row, entry.code, this.pending).trim() === "") {
      return `<span class="marker marker--page" data-languages-fallback-wording>${esc(this.t("languages.cell.fallbackWording", { language: this.baseLanguageName(entry.code), text: cell.fallbackText }))}</span>`;
    }
    if (status === "stale") {
      return `<span class="marker marker--stale" title="${esc(this.t("languages.cell.staleTitle"))}">${esc(this.t("languages.cell.stale"))}</span>
        <button type="button" class="btn small" data-languages-reconcile="${esc(rowKey(row.address))}" data-languages-locale="${esc(entry.code)}"
          aria-label="${esc(this.t("languages.cell.confirmLabel", { language: entry.label, what: this.rowLabel(row) }))}">${esc(this.t("languages.cell.confirm"))}</button>`;
    }
    return "";
  }

  /** What the language's base language (its primary subtag) is called: the form's name for it, else its own name. */
  private baseLanguageName(code: string): string {
    const base = primaryLocaleSubtag(code);
    return languageEntries(this.config()).find((candidate) => candidate.code.toLowerCase() === base.toLowerCase())?.label ?? localeDisplayName(base);
  }

  private cellHtml(row: LanguagesRow, entry: LanguageEntry): string {
    const cell = Object.hasOwn(row.cells, entry.code) ? row.cells[entry.code] : undefined;
    if (!cell) {
      // A text only the page's catalog words has a cell just for the languages the page words.
      return `<td class="cell none"><span class="muted">—</span></td>`;
    }
    const { status, changed, inner } = this.cellParts(row, entry);
    return `<td class="cell ${status}${changed ? " changed" : ""}" data-status="${status}">${inner}
      </td>`;
  }

  /** A cell's status, whether its typed text differs from the stored, and its box and note. */
  private cellParts(row: LanguagesRow, entry: LanguageEntry): { status: CellStatus; changed: boolean; inner: string } {
    const cell = Object.hasOwn(row.cells, entry.code) ? row.cells[entry.code] : undefined;
    const status = cellStatus(row, entry.code, this.pending);
    const overridden = status === "overridden";
    const text = overridden ? (cell?.catalogText ?? "") : cellText(row, entry.code, this.pending);
    const changed = !overridden && text.trim() !== (cell?.text ?? "").trim();
    const readonly = overridden || !cellEditable(row, entry.code);
    const inner = `
        <input type="text" data-languages-cell="${esc(rowKey(row.address))}" data-languages-locale="${esc(entry.code)}" lang="${esc(entry.code)}" dir="${isRtlLocale(entry.code) ? "rtl" : "ltr"}"
          value="${esc(text)}" placeholder="${esc(row.default)}" aria-label="${esc(this.t("languages.cell.label", { what: this.rowLabel(row), where: this.whereLabel(row), language: entry.label }))}"${readonly ? ' readonly aria-readonly="true"' : ""}>
        <div class="cell-note" data-languages-note>${this.cellNoteHtml(row, entry, status)}</div>`;
    return { status, changed, inner };
  }

  private coverageText(coverage: LanguageCoverage): string {
    return this.words.plural("languages.coverage", coverage.total, { translated: coverage.translated, total: coverage.total });
  }

  /** Only the table, for a search: the search box keeps its focus and caret. */
  private paintTable(): void {
    this.cancelSearchPaint();
    const region = this.root.querySelector<HTMLElement>("[data-languages-table]");
    if (!region || !this.ctrl) {
      return;
    }
    const focus = this.captureFocus();
    region.innerHTML = this.tableHtml(translationColumns(this.config()));
    this.restoreFocus(focus);
  }

  /** Paints the table once the search box has been still for a moment; every keystroke restarts the wait. */
  private schedulePaintTable(): void {
    this.cancelSearchPaint();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.paintTable();
    }, SEARCH_DEBOUNCE_MS);
  }

  private cancelSearchPaint(): void {
    if (this.searchTimer !== undefined) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
  }

  /** Enter or leaving the search box paints what is typed now, without waiting out the pause. */
  private flushSearchPaint(): void {
    if (this.searchTimer !== undefined) {
      this.paintTable();
    }
  }

  /** A new filter starts every group at its first window again. */
  private filterChanged(): void {
    this.windows.clear();
  }

  /**
   * After the surface's own write of a few rows (Confirm): repaints those rows alone, with the
   * cards' figures, when the texts keep the same rows in the same order and no filter could now
   * hide one; otherwise the whole page, as any other change. A row outside the painted window is
   * simply not there to repaint.
   */
  private settleRows(keys: string[]): void {
    const texts = this.computeTexts();
    const before = this.texts.rows;
    const sameShape = texts.rows.length === before.length && texts.rows.every((row, index) => rowKey(row.address) === rowKey(before[index]!.address));
    if (!sameShape || this.filter.status !== "all" || !this.isConnected) {
      this.paint(texts);
      return;
    }
    const columns = translationColumns(this.config());
    const shown = this.shownColumns(columns);
    const focus = this.captureFocus();
    this.texts = texts;
    for (const key of keys) {
      const row = texts.rows.find((entry) => rowKey(entry.address) === key);
      const tr = this.root.querySelector<HTMLElement>(`tr[data-languages-row="${quoteAttr(key)}"]`);
      if (row && tr) {
        tr.outerHTML = this.rowHtml(row, shown);
      }
    }
    for (const entry of columns) {
      const stats = this.root.querySelector(`[data-languages-lang-stats="${quoteAttr(entry.code)}"]`);
      if (stats) {
        stats.innerHTML = this.statsHtml(entry);
      }
    }
    this.restoreFocus(focus);
    this.paintedKey = this.drawKey(texts);
  }

  /** After a keystroke in a cell: its marks, the card's figures and the pending bar, in place. */
  private refreshLive(input: HTMLInputElement): void {
    const key = input.dataset.languagesCell;
    const locale = input.dataset.languagesLocale;
    const row = this.texts.rows.find((entry) => rowKey(entry.address) === key);
    const td = input.closest("td");
    if (row && locale && td) {
      const status = cellStatus(row, locale, this.pending);
      const cell = Object.hasOwn(row.cells, locale) ? row.cells[locale] : undefined;
      const entry = languageEntries(this.config()).find((candidate) => candidate.code === locale);
      td.classList.remove("missing", "stale", "overridden", "present");
      td.classList.add(status);
      td.dataset.status = status;
      td.classList.toggle("changed", status !== "overridden" && cellText(row, locale, this.pending).trim() !== (cell?.text ?? "").trim());
      const note = td.querySelector("[data-languages-note]");
      if (note && entry) {
        note.innerHTML = this.cellNoteHtml(row, entry, status);
      }
    }
    if (locale) {
      const entry = languageEntries(this.config()).find((candidate) => candidate.code === locale);
      const stats = this.root.querySelector(`[data-languages-lang-stats="${quoteAttr(locale)}"]`);
      if (entry && stats) {
        stats.innerHTML = this.statsHtml(entry);
      }
    }
    this.refreshBar();
    this.syncGuard();
  }

  private refreshBar(): void {
    const count = this.pendingCount;
    const bar = this.root.querySelector<HTMLElement>("[data-languages-pending]");
    if (bar) {
      bar.hidden = count === 0;
      const label = bar.querySelector("[data-languages-pending-count]");
      if (label) {
        label.textContent = this.words.plural("languages.pending.count", count);
      }
    }
  }

  /**
   * The question the leave guard puts up while typed cells are not applied. It says what is held
   * in the author's words (a translation), never the guard's internal subject id.
   */
  private promptHtml(controller: BuilderController): string {
    const held = controller.unsavedChangesPrompt();
    const guarded = held?.external?.id === GUARD_ID;
    if (!guarded && !this.askingImport) {
      return "";
    }
    const title = this.t("languages.leave.title");
    const action = guarded ? this.t(`confirm.unsaved.action.${held!.action}` as BuilderTextKey) : this.t("languages.leave.action.import");
    return `<dialog class="db-confirm" role="alertdialog" aria-label="${esc(title)}" data-prompt data-unsaved-prompt>
      <h3>${esc(title)}</h3>
      <p>${esc(this.words.plural("languages.leave.body", Math.max(1, this.pendingCount), { action }))}</p>
      <div class="db-confirm-actions">
        <button type="button" class="btn" data-unsaved-stay>${esc(this.t("confirm.unsaved.keep"))}</button>
        <button type="button" class="btn danger" data-unsaved-discard>${esc(this.t("common.discard"))}</button>
        <button type="button" class="btn primary" data-unsaved-save autofocus>${esc(this.t("languages.leave.save"))}</button>
      </div>
    </dialog>`;
  }

  // --- writing -----------------------------------------------------------------------

  /**
   * Applies the typed cells (the leave guard's Save and the bar's Apply): one `setTranslations`
   * call, so one undo step. Cells that differ from what the form stores nowhere are dropped
   * without a step. `false` when the controller refused, the cells kept so nothing typed is lost.
   */
  private apply(): boolean {
    const controller = this.ctrl;
    if (!controller) {
      return false;
    }
    const edits = languagesEdits(this.texts.rows, this.pending);
    this.committing = true;
    let written: number;
    try {
      written = edits.length === 0 ? 0 : controller.setTranslations(edits);
    } catch (error) {
      this.committing = false;
      this.say(this.t("languages.say.failed", { message: error instanceof Error ? error.message : String(error) }));
      return false;
    }
    this.committing = false;
    this.askingImport = false;
    this.pending.clear();
    this.releaseGuard();
    this.paint();
    if (written > 0) {
      this.say(this.words.plural("languages.say.applied", written));
    }
    return true;
  }

  private discard(): void {
    this.askingImport = false;
    this.pending.clear();
    this.releaseGuard();
    this.paint();
    this.say(this.t("languages.say.discarded"));
  }

  /**
   * Where focus goes once the pending bar (or the question about it) is gone with the button
   * pressed: the cell typed into last, else the search box when a filter or a window hides it.
   * Called by the surface's own buttons only, whether or not the click focused the button: a
   * Save asked from elsewhere (the guard's save from the shell or an agent) leaves focus where it is.
   */
  private focusSettled(): void {
    if (!this.isConnected || !this.shownValue) {
      return;
    }
    const last = this.lastTyped;
    const cell = last ? this.root.querySelector<HTMLElement>(`input[data-languages-cell="${quoteAttr(last.key)}"][data-languages-locale="${quoteAttr(last.locale)}"]`) : null;
    (cell ?? this.root.querySelector<HTMLElement>("[data-languages-search]"))?.focus();
  }

  /** Confirms a stale translation against the current default without changing what it says. */
  private confirmCell(key: string, locale: string): void {
    const controller = this.ctrl;
    const row = this.texts.rows.find((entry) => rowKey(entry.address) === key);
    if (!controller || !row) {
      return;
    }
    // The Confirm after this one, where focus goes once this one is gone: an author works down them.
    const buttons = [...this.root.querySelectorAll<HTMLElement>("[data-languages-reconcile]")];
    const at = buttons.findIndex((button) => button.dataset.languagesReconcile === key && button.dataset.languagesLocale === locale);
    const next = at >= 0 ? buttons[at + 1] : undefined;
    const nextSelector = next ? `[data-languages-reconcile="${quoteAttr(next.dataset.languagesReconcile ?? "")}"][data-languages-locale="${quoteAttr(next.dataset.languagesLocale ?? "")}"]` : undefined;
    // Marked as the surface's own write so the change it raises is not repainted over the page;
    // only the row it touched (and the cards' figures) is drawn again.
    this.committing = true;
    let confirmed: number;
    try {
      confirmed = controller.reconcileTranslations([{ locale, address: row.address }]);
    } finally {
      this.committing = false;
    }
    if (confirmed > 0) {
      this.say(this.words.plural("languages.say.confirmed", confirmed));
      this.settleRows([key]);
      // The Confirm pressed is gone (the cell is no longer stale, or the Source changed filter
      // took its row): on to the next one, else the cell it confirmed when it is still drawn, else
      // the filter that now shows nothing.
      const target =
        (nextSelector ? this.root.querySelector<HTMLElement>(nextSelector) : null) ??
        this.root.querySelector<HTMLElement>(`[data-languages-cell="${quoteAttr(key)}"][data-languages-locale="${quoteAttr(locale)}"]`) ??
        this.root.querySelector<HTMLElement>("[data-languages-status]");
      target?.focus();
    }
  }

  /** Why a language change the controller refused did not run: the form root has edits waiting, or the form refused. */
  private languageRefused(into: "add" | "rename" | "other"): void {
    const controller = this.ctrl!;
    if (controller.hasPendingChanges(controller.rootId())) {
      this.rootBlocked = true;
    } else if (into === "rename") {
      this.renameProblem = this.t("languages.refused");
    } else {
      this.languageProblem = this.t("languages.refused");
    }
    this.paint();
    this.root.querySelector<HTMLElement>(this.rootBlocked ? "[data-languages-root-discard]" : into === "rename" ? "[data-languages-rename-code]" : "[data-languages-add-code]")?.focus();
  }

  private addLanguage(): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const config = this.config();
    const issue = languageCodeIssue(this.addCode, config);
    if (issue) {
      this.languageProblem = this.codeIssueText(issue);
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-add-code]")?.focus();
      return;
    }
    const code = this.addCode.trim();
    this.languageProblem = undefined;
    // A form with no language declared names the one its strings are written in first, and stays in it.
    const first = languageEntries(config).length === 0;
    if (!controller.localizationActions.addLocale(code, this.addLabel, first ? { sourceLocale: effectiveDefaultLocale(config) } : undefined)) {
      this.languageRefused("add");
      return;
    }
    const name = supportedLocaleOptions(this.config()).find((option) => option.code === code)?.label ?? code;
    this.addCode = "";
    this.addLabel = "";
    this.paint();
    this.root.querySelector<HTMLElement>("[data-languages-add-code]")?.focus();
    this.say(this.t("languages.say.added", { name }));
  }

  /** Why a code cannot be a language, in the builder's words. */
  private codeIssueText(issue: LanguageCodeIssue): string {
    switch (issue.code) {
      case "empty":
        return this.t("languages.code.problem.empty");
      case "pattern":
        return this.t("languages.code.problem.pattern", { value: issue.value });
      case "tooLong":
        return this.t("languages.code.problem.tooLong", { value: issue.value, max: issue.max });
      case "taken":
        return this.t("languages.code.problem.taken", { value: issue.value });
    }
  }

  /** How many cells typed for `code` wait to be applied. */
  private typedCount(code: string): number {
    return changedCells(this.texts.rows, this.pending).filter((cell) => cell.locale === code).length;
  }

  /**
   * Writes the cells typed for `code` (one step), before a change makes that language's wording
   * the form's own strings: the strings must be what the author typed, not what was stored
   * before. Left alone when the form root has settings waiting, since the change that follows
   * is refused then and the cells stay typed.
   */
  private applyTypedFor(code: string): void {
    const controller = this.ctrl;
    if (!controller || controller.hasPendingChanges(controller.rootId())) {
      return;
    }
    const edits = languagesEdits(this.texts.rows, this.pending).filter((edit) => edit.locale === code);
    if (edits.length === 0) {
      return;
    }
    this.committing = true;
    try {
      controller.setTranslations(edits);
    } catch (error) {
      this.say(this.t("languages.say.failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.committing = false;
    }
  }

  /** Takes the typed cells of `code` out of the pending ones; the ones taken, to put back if the controller refuses. */
  private dropPendingFor(code: string): LanguagesPending {
    const held: LanguagesPending = new Map([...this.pending].map(([key, cells]) => [key, { ...cells }]));
    for (const [key, cells] of [...this.pending]) {
      if (code in cells) {
        const { [code]: _dropped, ...rest } = cells;
        void _dropped;
        if (Object.keys(rest).length > 0) {
          this.pending.set(key, rest);
        } else {
          this.pending.delete(key);
        }
      }
    }
    return held;
  }

  private removeLanguage(code: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const name = supportedLocaleOptions(this.config()).find((option) => option.code === code)?.label ?? code;
    this.confirmingRemoval = undefined;
    // Dropped first, so the repaint the removal raises shows the cells gone; put back when it is
    // refused, so typing for a language that stays is not lost.
    // The default that goes hands its place to the first language left: that language's typed
    // cells are applied first, as Make default applies them, and are its strings after.
    const successor = defaultAfterRemoval(this.config(), code);
    if (successor !== undefined) {
      this.applyTypedFor(successor);
    }
    const held = this.dropPendingFor(code);
    if (successor !== undefined) {
      this.dropPendingFor(successor);
    }
    if (controller.localizationActions.removeLocale(code)) {
      if (this.filter.status !== "all" && translationColumns(this.config()).length === 0) {
        this.filter.status = "all";
      }
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-add-code]")?.focus();
      this.say(this.t("languages.say.removed", { name }));
    } else {
      this.pending.clear();
      for (const [key, cells] of held) {
        this.pending.set(key, cells);
      }
      this.languageRefused("other");
    }
  }

  /** The code typed for the language, checked and handed to the controller: the translations move, one undo step. */
  private renameLanguage(from: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const to = this.renameCode.trim();
    const issue = to === from ? undefined : languageRenameIssue(from, to, this.config());
    const problem = to === from ? this.t("languages.rename.problem.same") : issue ? this.codeIssueText(issue) : undefined;
    if (problem) {
      this.renameProblem = problem;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-rename-code]")?.focus();
      return;
    }
    if (!controller.localizationActions.renameLocale(from, to)) {
      this.languageRefused("rename");
      return;
    }
    // Typed cells and the one-language view follow the code: they were written for that language.
    for (const [key, cells] of [...this.pending]) {
      if (from in cells) {
        const { [from]: moved, ...rest } = cells;
        this.pending.set(key, { ...rest, [to]: moved ?? "" });
      }
    }
    if (this.oneLanguage === from) {
      this.oneLanguage = to;
    }
    this.renaming = undefined;
    this.renameProblem = undefined;
    this.paint();
    this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(to)}"]`)?.focus();
    this.say(this.t("languages.say.renamed", { from, to }));
  }

  private makeDefault(code: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    this.confirmingDefault = undefined;
    // What was typed for the new default is applied first (the box said so), then those cells go:
    // they are its strings now, and nothing is typed into a column for it.
    this.applyTypedFor(code);
    const held = this.dropPendingFor(code);
    if (controller.localizationActions.makeDefaultLocale(code)) {
      this.paint();
      // The question went with the Make default pressed: focus goes back to the card, now the default.
      this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`)?.focus();
      this.say(this.t("languages.say.default", { name: supportedLocaleOptions(this.config()).find((option) => option.code === code)?.label ?? code }));
    } else {
      this.pending.clear();
      for (const [key, cells] of held) {
        this.pending.set(key, cells);
      }
      this.languageRefused("other");
    }
  }

  /** Names a language; blank puts its own name back. Written on the box's change, so drawn in place (`settleInPlace`). */
  private relabel(code: string, value: string): void {
    const controller = this.ctrl;
    const before = languageEntries(this.config()).find((entry) => entry.code === code)?.storedLabel ?? "";
    if (!controller || value.trim() === before.trim()) {
      return;
    }
    this.committing = true;
    let relabelled: boolean;
    try {
      relabelled = controller.localizationActions.relabelLocale(code, value);
    } finally {
      this.committing = false;
    }
    if (!relabelled) {
      this.languageRefused("other");
      return;
    }
    this.settleInPlace();
  }

  /**
   * After a write of its own that a text box's change made (a language's name, the switcher's
   * label). The browser fires that change while it moves focus (Tab, a click elsewhere), after it
   * has chosen where focus goes and before it gets there, so the page keeps its elements: each
   * card is patched where the fresh markup has the same shape (names, labels, figures), and only
   * a card whose shape changed (a row the switcher's label adds to the Texts) is drawn again.
   */
  private settleInPlace(): void {
    const controller = this.ctrl;
    if (!controller || !this.isConnected) {
      return;
    }
    if (!this.shownValue) {
      this.refresh();
      return;
    }
    const texts = this.computeTexts();
    if (this.drawKey(texts) === this.paintedKey) {
      return;
    }
    const main = this.root.querySelector<HTMLElement>("[data-languages-main]");
    const cards = main ? [...main.children] : [];
    if (!main || cards.length !== 3 || controller.unsavedChangesPrompt() !== undefined) {
      this.paint(texts);
      return;
    }
    this.texts = texts;
    this.prunePending(texts);
    const config = this.config();
    const columns = translationColumns(config);
    [this.languagesHtml(config, columns), this.switcherHtml(config, columns), this.textsHtml(config, columns)].forEach((html, index) => {
      const live = cards[index]!;
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const fresh = template.content.firstElementChild;
      if (!fresh) {
        return;
      }
      if (sameShape(live, fresh)) {
        copyOnto(live, fresh);
      } else {
        live.replaceWith(fresh);
      }
    });
    this.paintedKey = this.drawKey(texts);
    this.syncGuard();
  }

  /** The switcher moved to `place` (or taken away), written to the chrome part as one undo step. */
  private placeSwitcher(place: "header" | "footer" | "none"): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const state = this.switcher();
    const chrome = this.chromeOf();
    const next = chromeWithSwitcher(chrome, place, state.label);
    if (JSON.stringify(next ?? null) !== JSON.stringify(chrome ?? null)) {
      controller.setProperties([{ componentId: controller.rootId(), propertyPath: "chrome", value: next }]);
    }
    const where = this.t(`languages.switcher.place.${place}` as BuilderTextKey);
    this.say(this.t("languages.say.switcher", { where }));
  }

  private relabelSwitcher(value: string): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    const chrome = this.chromeOf();
    const next = chromeWithSwitcherLabel(chrome, value);
    if (JSON.stringify(next ?? null) === JSON.stringify(chrome ?? null)) {
      return;
    }
    // Written on the box's change, while focus moves on (to the Preview language, say): drawn in place.
    this.committing = true;
    try {
      controller.setProperties([{ componentId: controller.rootId(), propertyPath: "chrome", value: next }]);
    } finally {
      this.committing = false;
    }
    this.settleInPlace();
  }

  /** The canvas's language, through the controller's locale option (the Settings panel's own). */
  private setPreview(code: string): void {
    if (!code || !this.ctrl) {
      return;
    }
    this.localeValue = code;
    this.ctrl.setOptions({ locale: code });
  }

  private keepDefault(): void {
    const code = this.confirmingDefault;
    this.confirmingDefault = undefined;
    this.paint();
    if (code !== undefined) {
      this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`)?.focus();
    }
  }

  private cancelRename(): void {
    const code = this.renaming;
    this.renaming = undefined;
    this.renameProblem = undefined;
    this.paint();
    if (code !== undefined) {
      this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`)?.focus();
    }
  }

  private keepLanguage(): void {
    const code = this.confirmingRemoval;
    this.confirmingRemoval = undefined;
    this.paint();
    if (code !== undefined) {
      this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`)?.focus();
    }
  }

  // --- the one-language view ------------------------------------------------------------

  /**
   * Enter in a cell of the one-language view: on to the next cell below it that needs the author
   * (missing or source changed, and not the page's). The cell just typed in counts as answered.
   */
  private focusNextNeeded(from: HTMLInputElement): void {
    const boxes = [...this.root.querySelectorAll<HTMLInputElement>("input[data-languages-cell][data-languages-locale]")];
    const start = boxes.indexOf(from);
    for (const box of boxes.slice(start + 1)) {
      const status = box.closest("td")?.dataset.status;
      if (!box.readOnly && (status === "missing" || status === "stale")) {
        box.focus();
        box.select();
        box.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
    // Rows beyond the painted windows may still need a word: say so rather than "done". Only a
    // Show more below the cell counts; a filter hiding rows hides them on purpose.
    const unpainted = [...this.root.querySelectorAll("[data-languages-more]")].some((more) => (from.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    this.say(this.t(unpainted ? "languages.view.moreLeft" : "languages.view.done"));
  }

  /** The shell's copy of `builder-languages-goto`: the Texts narrowed to the component, every other filter cleared. */
  private onGoto(event: CustomEvent<BuilderLanguagesGotoDetail>): void {
    if (event.bubbles) {
      return;
    }
    const detail = event.detail;
    if (detail?.kind === "chrome") {
      if (detail.partId) {
        this.filterChanged();
        this.filter = { query: "", status: "all", group: "all", componentId: undefined, chromePartId: detail.partId };
        this.paint();
      }
      return;
    }
    const componentId = detail?.componentId;
    if (!componentId) {
      return;
    }
    this.filterChanged();
    this.filter = { query: "", status: "all", group: "all", componentId, chromePartId: undefined };
    this.paint();
  }

  // --- events -----------------------------------------------------------------------

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    this.root.addEventListener("change", (event) => this.onChangeEvent(event));
    this.root.addEventListener("focusout", (event) => {
      if ((event.target as HTMLElement | null)?.hasAttribute?.("data-languages-search")) {
        this.flushSearchPaint();
      }
      this.closeMenuOnLeave(event as FocusEvent);
    });
    this.root.addEventListener("keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      const target = keyboard.target as HTMLElement | null;
      // Undo and Redo are the form's, never a box's own (as on the canvas and in the inspector);
      // a modal dialog over the page (an exchange dialog, the Apply or Discard question) keeps them.
      const key = keyboard.key?.toLowerCase();
      if ((keyboard.ctrlKey || keyboard.metaKey) && !keyboard.altKey && !keyboard.isComposing && (key === "z" || key === "y") && !target?.closest?.("dialog")) {
        keyboard.preventDefault();
        this.flushTyped(target);
        this.stepHistory(key === "y" || keyboard.shiftKey ? "redo" : "undo");
        return;
      }
      // Enter that commits an input-method candidate (Safari sends it after the composition
      // has ended, with keyCode 229) is the composition's, not a command.
      if (keyboard.key === "Enter" && (keyboard.isComposing || keyboard.keyCode === 229)) {
        return;
      }
      if (keyboard.key === "Enter" && target?.hasAttribute?.("data-languages-add-code")) {
        keyboard.preventDefault();
        this.addLanguage();
      } else if (keyboard.key === "Enter" && target?.hasAttribute?.("data-languages-search")) {
        keyboard.preventDefault();
        this.flushSearchPaint();
      } else if (keyboard.key === "Enter" && target?.hasAttribute?.("data-languages-cell")) {
        keyboard.preventDefault();
        if (this.view === "one") {
          this.focusNextNeeded(target as HTMLInputElement);
        }
      } else if (keyboard.key === "Enter" && this.renaming !== undefined && target?.hasAttribute?.("data-languages-rename-code")) {
        keyboard.preventDefault();
        this.renameLanguage(this.renaming);
      } else if (keyboard.key === "Escape" && this.menuOpen !== undefined && target?.closest?.("[data-languages-menu-wrap]")) {
        keyboard.preventDefault();
        const code = this.menuOpen;
        this.menuOpen = undefined;
        this.paint();
        this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`)?.focus();
      } else if (keyboard.key === "Escape" && this.confirmingRemoval !== undefined && target?.closest?.("[data-languages-confirm]")) {
        keyboard.preventDefault();
        this.keepLanguage();
      } else if (keyboard.key === "Escape" && this.confirmingDefault !== undefined && target?.closest?.("[data-languages-default-confirm-box]")) {
        keyboard.preventDefault();
        this.keepDefault();
      } else if (keyboard.key === "Escape" && this.renaming !== undefined && target?.closest?.("[data-languages-rename-form]")) {
        keyboard.preventDefault();
        this.cancelRename();
      }
    });
    this.root.addEventListener(
      "cancel",
      (event) => {
        if ((event.target as HTMLElement | null)?.dataset?.prompt !== undefined) {
          event.preventDefault();
          this.answerPrompt("stay");
        }
      },
      true
    );
  }

  /**
   * The card menu is a disclosure: focus moving out of it (Tab past its last item) puts it away.
   * Closed in place, since focus is moving: a repaint now would take the element it is moving to.
   * A focusout with nowhere named (a click on a button Safari does not focus) leaves it to the click.
   */
  private closeMenuOnLeave(event: FocusEvent): void {
    const code = this.menuOpen;
    const wrap = (event.target as HTMLElement | null)?.closest?.("[data-languages-menu-wrap]");
    const to = event.relatedTarget as Node | null;
    if (code === undefined || !wrap || to === null || wrap.contains(to)) {
      return;
    }
    this.menuOpen = undefined;
    const button = this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code)}"]`);
    button?.setAttribute("aria-expanded", "false");
    const menu = button?.getAttribute("aria-controls");
    if (menu) {
      this.root.getElementById(menu)?.toggleAttribute("hidden", true);
    }
  }

  private emit<T>(type: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, ...(detail !== undefined ? { detail } : {}) }));
  }

  private answerPrompt(decision: "save" | "discard" | "stay"): void {
    const controller = this.ctrl;
    if (controller?.unsavedChangesPrompt()?.external?.id === GUARD_ID) {
      this.askingImport = false;
      controller.answerUnsavedChangesPrompt(decision);
      // The dialog went with the button pressed: Stay (or a refused Apply) keeps the author here.
      if (this.root.activeElement === null) {
        this.focusSettled();
      }
      return;
    }
    if (!this.askingImport) {
      return;
    }
    this.askingImport = false;
    const settled = decision === "save" ? this.apply() : decision === "discard" ? (this.discard(), true) : false;
    if (!settled) {
      // Stay, or an Apply the controller refused: the cells stay typed and Import stays shut.
      this.paint();
      this.focusSettled();
      return;
    }
    // The dialog gives focus back to its opener when it closes.
    this.root.querySelector<HTMLElement>("[data-languages-import]")?.focus();
    this.openImport();
  }

  /** Undo or Redo from the surface's keys: through {@link historyStep} when the shell set one, else on the controller. */
  private stepHistory(direction: "undo" | "redo"): void {
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    if (this.historyStep) {
      this.historyStep(controller, direction);
    } else if (direction === "undo") {
      controller.undo();
    } else {
      controller.redo();
    }
  }

  /**
   * A name typed in a box written on its change (a language's name, the switcher's label) is
   * written now, before an Undo key: the Undo then takes that typing back, as the inspector's does.
   * Typed cells are not writes: they wait for Apply and stay as they are.
   */
  private flushTyped(target: HTMLElement | null): void {
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    if (target.dataset.languagesSwitcherLabel !== undefined) {
      this.relabelSwitcher(target.value);
    } else if (target.dataset.languagesLabel !== undefined) {
      this.relabel(target.dataset.languagesLabel, target.value);
    }
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement;
    const hit = (selector: string): HTMLElement | null => target.closest<HTMLElement>(selector);
    const controller = this.ctrl;
    if (!controller) {
      return;
    }
    // A click outside an open card menu puts it away.
    if (this.menuOpen !== undefined && !hit("[data-languages-menu-wrap]")) {
      this.menuOpen = undefined;
      this.paint();
    }
    if (hit("[data-unsaved-stay]")) {
      this.answerPrompt("stay");
      return;
    }
    if (hit("[data-unsaved-discard]")) {
      this.answerPrompt("discard");
      return;
    }
    if (hit("[data-unsaved-save]")) {
      this.answerPrompt("save");
      return;
    }
    const goto = hit("[data-languages-goto]");
    if (goto) {
      this.emit<BuilderLanguagesGotoDetail>("builder-languages-goto", { componentId: goto.dataset.languagesGoto ?? "" });
      return;
    }
    if (hit("[data-languages-export]")) {
      this.openExport();
      return;
    }
    if (hit("[data-languages-import]")) {
      this.openImport();
      return;
    }
    if (hit("[data-languages-apply]")) {
      this.apply();
      this.focusSettled();
      return;
    }
    if (hit("[data-languages-discard]")) {
      this.discard();
      this.focusSettled();
      return;
    }
    const reconcile = hit("[data-languages-reconcile]");
    if (reconcile) {
      this.confirmCell(reconcile.dataset.languagesReconcile ?? "", reconcile.dataset.languagesLocale ?? "");
      return;
    }
    const more = hit("[data-languages-more]");
    if (more) {
      const id = more.dataset.languagesMore ?? "";
      this.windows.set(id, (this.windows.get(id) ?? TEXTS_WINDOW) + TEXTS_WINDOW);
      this.paintTable();
      return;
    }
    const group = hit("[data-languages-group]");
    if (group) {
      this.filterChanged();
      this.filter.group = (group.dataset.languagesGroup || "all") as LanguagesGroupId | "all";
      this.paint(this.texts);
      return;
    }
    const view = hit("[data-languages-view]");
    if (view) {
      this.filterChanged();
      this.view = view.dataset.languagesView === "one" ? "one" : "grid";
      this.paint(this.texts);
      return;
    }
    if (hit("[data-languages-component-clear]")) {
      this.filterChanged();
      this.filter.componentId = undefined;
      this.filter.chromePartId = undefined;
      this.paint(this.texts);
      return;
    }
    if (hit("[data-languages-add]")) {
      this.addLanguage();
      return;
    }
    const menu = hit("[data-languages-menu]");
    if (menu) {
      const code = menu.dataset.languagesMenu;
      this.menuOpen = this.menuOpen === code ? undefined : code;
      this.paint();
      this.root.querySelector<HTMLElement>(`[data-languages-menu="${quoteAttr(code ?? "")}"]`)?.focus();
      return;
    }
    const makeDefault = hit("[data-languages-default]");
    if (makeDefault) {
      // Asked first: the old default text moves into the old default's translations.
      this.confirmingDefault = makeDefault.dataset.languagesDefault;
      this.confirmingRemoval = undefined;
      this.renaming = undefined;
      this.menuOpen = undefined;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-default-keep]")?.focus();
      return;
    }
    if (hit("[data-languages-default-keep]")) {
      this.keepDefault();
      return;
    }
    const confirmDefault = hit("[data-languages-default-confirm]");
    if (confirmDefault) {
      this.makeDefault(confirmDefault.dataset.languagesDefaultConfirm ?? "");
      return;
    }
    const rename = hit("[data-languages-rename]");
    if (rename) {
      this.renaming = rename.dataset.languagesRename;
      this.renameCode = this.renaming ?? "";
      this.renameProblem = undefined;
      this.confirmingRemoval = undefined;
      this.confirmingDefault = undefined;
      this.menuOpen = undefined;
      this.paint();
      const input = this.root.querySelector<HTMLInputElement>("[data-languages-rename-code]");
      input?.focus();
      input?.select();
      return;
    }
    if (hit("[data-languages-rename-cancel]")) {
      this.cancelRename();
      return;
    }
    const confirmRename = hit("[data-languages-rename-confirm]");
    if (confirmRename) {
      this.renameLanguage(confirmRename.dataset.languagesRenameConfirm ?? "");
      return;
    }
    const remove = hit("[data-languages-remove]");
    if (remove) {
      this.confirmingRemoval = remove.dataset.languagesRemove;
      this.confirmingDefault = undefined;
      this.renaming = undefined;
      this.menuOpen = undefined;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-remove-keep]")?.focus();
      return;
    }
    if (hit("[data-languages-remove-keep]")) {
      this.keepLanguage();
      return;
    }
    const confirm = hit("[data-languages-remove-confirm]");
    if (confirm) {
      this.removeLanguage(confirm.dataset.languagesRemoveConfirm ?? "");
      return;
    }
    if (hit("[data-languages-root-discard]")) {
      this.rootBlocked = false;
      controller.discardDraft(controller.rootId());
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-add-code]")?.focus();
      return;
    }
    if (hit("[data-languages-root-apply]") && controller.commitDraft(controller.rootId())) {
      this.rootBlocked = false;
      this.paint();
      this.root.querySelector<HTMLElement>("[data-languages-add-code]")?.focus();
    }
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const data = target.dataset ?? {};
    if (data.languagesCell !== undefined && data.languagesLocale !== undefined) {
      const row = this.texts.rows.find((entry) => rowKey(entry.address) === data.languagesCell);
      if (!row || !cellEditable(row, data.languagesLocale) || cellStatus(row, data.languagesLocale) === "overridden") {
        return;
      }
      this.pending.set(data.languagesCell, { ...(this.pending.get(data.languagesCell) ?? {}), [data.languagesLocale]: target.value });
      this.lastTyped = { key: data.languagesCell, locale: data.languagesLocale };
      this.refreshLive(target);
      return;
    }
    if (data.languagesSearch !== undefined) {
      this.filterChanged();
      this.filter.query = target.value;
      this.schedulePaintTable();
      return;
    }
    if (data.languagesAddCode !== undefined) {
      this.addCode = target.value;
      return;
    }
    if (data.languagesRenameCode !== undefined) {
      this.renameCode = target.value;
      return;
    }
    if (data.languagesAddLabel !== undefined) {
      this.addLabel = target.value;
    }
  }

  private onChangeEvent(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const data = target.dataset ?? {};
    if (data.languagesStatus !== undefined) {
      this.filterChanged();
      this.filter.status = (target.value || "all") as "all" | CellStatus;
      this.paint(this.texts);
      return;
    }
    if (data.languagesLanguage !== undefined) {
      this.filterChanged();
      this.oneLanguage = target.value || undefined;
      this.paint(this.texts);
      return;
    }
    if (data.languagesPreview !== undefined) {
      this.setPreview(target.value);
      return;
    }
    if (data.languagesSwitcherPlace !== undefined) {
      if (target.value === "header" || target.value === "footer" || target.value === "none") {
        this.placeSwitcher(target.value);
      }
      return;
    }
    if (data.languagesSwitcherLabel !== undefined) {
      // Written on leaving the box (or Enter), not per keystroke: each rename is one undo step.
      this.relabelSwitcher(target.value);
      return;
    }
    if (data.languagesLabel !== undefined) {
      this.relabel(data.languagesLabel, target.value);
    }
  }

  private say(text: string): void {
    const live = this.root.querySelector<HTMLElement>("[data-languages-live]");
    if (live) {
      live.textContent = text;
    }
  }

  // --- focus across repaints --------------------------------------------------------

  private captureFocus(): FocusSnapshot | undefined {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active) {
      return undefined;
    }
    const attributes = active.getAttributeNames().filter((name) => name.startsWith("data-languages") || name.startsWith("data-unsaved"));
    if (attributes.length === 0) {
      return undefined;
    }
    const selector = attributes
      .map((name) => {
        const value = active.getAttribute(name);
        return `[${name}${value ? `="${quoteAttr(value)}"` : ""}]`;
      })
      .join("");
    const text = active instanceof HTMLInputElement && (active.type === "text" || active.type === "search");
    return {
      selector,
      start: text ? (active as HTMLInputElement).selectionStart : null,
      end: text ? (active as HTMLInputElement).selectionEnd : null
    };
  }

  private restoreFocus(snapshot: FocusSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    try {
      const target = this.root.querySelector<HTMLElement>(snapshot.selector);
      target?.focus();
      if (target instanceof HTMLInputElement && snapshot.start !== null && snapshot.end !== null) {
        target.setSelectionRange(snapshot.start, snapshot.end);
      }
    } catch {
      // A selector the repaint no longer matches: focus stays where the browser put it.
    }
  }
}

/** Rows painted per group before "Show more"; a Chrome repaint of 2,000 texts took most of a second. */
const TEXTS_WINDOW = 200;
/** How long the search box is still before the table repaints. */
const SEARCH_DEBOUNCE_MS = 120;

/** The chrome part properties the builder has a word for; any other is shown as written. */
const LANGUAGES_CHROME_PROPERTIES: Record<string, true> = { label: true, alt: true, src: true, href: true, html: true };

/** Whether two trees have the same nodes in the same places, whatever their attributes and text. */
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || a.childNodes.length !== b.childNodes.length) {
    return false;
  }
  for (let index = 0; index < a.childNodes.length; index++) {
    if (!sameShape(a.childNodes[index]!, b.childNodes[index]!)) {
      return false;
    }
  }
  return true;
}

/**
 * The fresh tree's attributes and text written onto the live one of the same shape, which keeps
 * its elements (and the focus moving between them). A box's typed value is its own: the `value`
 * attribute changes only what a box nobody typed in shows.
 */
function copyOnto(live: Node, fresh: Node): void {
  if (live.nodeType !== Node.ELEMENT_NODE) {
    if (live.nodeValue !== fresh.nodeValue) {
      live.nodeValue = fresh.nodeValue;
    }
    return;
  }
  const to = live as Element;
  const from = fresh as Element;
  for (const name of to.getAttributeNames()) {
    if (!from.hasAttribute(name)) {
      to.removeAttribute(name);
    }
  }
  for (const name of from.getAttributeNames()) {
    const value = from.getAttribute(name)!;
    if (to.getAttribute(name) !== value) {
      to.setAttribute(name, value);
    }
  }
  for (let index = 0; index < live.childNodes.length; index++) {
    copyOnto(live.childNodes[index]!, fresh.childNodes[index]!);
  }
}

/** A value inside a quoted attribute selector: its quotes and backslashes escaped. */
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * The surface's look, on the studio tokens: the languages, the switcher and the texts
 * stacked as cards over the backdrop, the surface scrolling as one; inside the Texts card a rail
 * of groups beside the table, which scrolls inside its card. Under 700px of surface the rail lies
 * along the top.
 */
const LANGUAGES_STYLES = `
  :host { display: block; height: 100%; min-height: 0; container-type: inline-size; }
  .languages {
    box-sizing: border-box; height: 100%; min-height: 0; padding: var(--db-gap, 12px); overflow: auto;
    display: flex; flex-direction: column; gap: var(--db-gap, 12px);
    font-family: var(--db-font); font-size: var(--db-text-md); color: var(--db-ink);
  }
  .card { flex: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .muted { color: var(--db-ink-muted); }
  .small { font-size: var(--db-text-sm); }
  p { margin: 0; }
  code { font-family: var(--db-font-mono); font-size: var(--db-text-sm); }
  .langs, .switcher { padding: var(--db-space-4); display: flex; flex-direction: column; gap: var(--db-space-3); }
  .card-head p { margin-top: var(--db-space-1); }
  .lead { color: var(--db-ink); }
  .lang-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--db-space-3); }
  /* One column that may shrink below its content: an auto track would take the name input's intrinsic width as its minimum and push the menu button past the card's edge. */
  .lang { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: var(--db-space-2); padding: var(--db-space-3); border: var(--db-border-w) solid var(--db-line-divider); border-radius: var(--db-radius-md); min-width: 0; }
  .lang-row { display: flex; align-items: center; gap: var(--db-space-2); }
  .lang-code { flex: none; min-inline-size: 3ch; }
  .lang-label { flex: 1; min-inline-size: 0; }
  .lang-stats { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); }
  .lang-stats progress { inline-size: 100%; block-size: 8px; }
  .lang-menu-wrap { position: relative; flex: none; }
  .lang-menu { position: absolute; inset-inline-end: 0; top: 100%; margin-top: var(--db-space-1); white-space: nowrap; }
  .notice { display: grid; gap: var(--db-space-2); }
  .lang-add { display: grid; gap: var(--db-space-2); padding-top: var(--db-space-3); border-top: var(--db-border-w) solid var(--db-line-divider); }
  .lang-add-row, .switcher-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--db-space-3); }
  /* A box is as wide as what is typed in it, not as the card: a code, a name, a choice of three. */
  .lang-add-row .field { flex: 1 1 110px; max-inline-size: 280px; }
  .switcher-row .field { flex: 1 1 180px; max-inline-size: 320px; }
  /* An input's intrinsic width (about 20 characters) must not push its field past the card. */
  .lang-add-row .field input, .switcher-row .field input, .switcher-row .field select { width: 100%; min-width: 0; box-sizing: border-box; }
  .texts { min-height: 480px; padding: var(--db-space-4); display: flex; flex-direction: column; gap: var(--db-space-3); flex: 1 0 auto; }
  .texts-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--db-space-3); }
  .exchange { display: flex; gap: var(--db-space-2); }
  .texts-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 190px) minmax(0, 1fr); gap: var(--db-space-4); }
  .rail ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--db-space-1); align-content: start; }
  .rail-btn {
    inline-size: 100%; display: flex; justify-content: space-between; gap: var(--db-space-2); min-block-size: var(--db-control-h); padding: 0 var(--db-space-3);
    border: var(--db-border-w) solid transparent; border-radius: var(--db-radius-md); background: none; color: var(--db-ink); font: inherit; text-align: start; cursor: pointer; align-items: center;
  }
  .rail-btn:hover { background: var(--db-surface-hover); }
  /* The group on show is the current choice among several: the strong fill, its count in the same ink. */
  .rail-btn[aria-pressed="true"] { background: var(--db-selected); color: var(--db-selected-ink); font-weight: 600; }
  .rail-btn[aria-pressed="true"] .muted { color: inherit; }
  .texts-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--db-space-3); }
  .filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--db-space-3); }
  .filters .search { flex: 1 1 200px; }
  .filters .field > .seg { justify-self: start; }
  .chip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); font-size: var(--db-text-sm); }
  .table-region { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--db-space-2); }
  /* The table lies on the card, as Data's does: its rows' dividers are the only lines. */
  .table-wrap { flex: 1; min-height: 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--db-text-md); }
  th, td { text-align: start; padding: var(--db-space-2) var(--db-space-3); border-bottom: var(--db-border-w) solid var(--db-line-divider); vertical-align: top; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--db-surface); font-size: var(--db-text-sm); font-weight: 600; color: var(--db-ink-muted); white-space: nowrap; }
  .group-row th { background: var(--db-surface-sunken); font-size: var(--db-text-sm); font-weight: 600; }
  tbody th.what { font-weight: 500; min-inline-size: 120px; }
  td.where { min-inline-size: 110px; }
  td.default { min-inline-size: 160px; max-inline-size: 280px; overflow-wrap: anywhere; color: var(--db-ink); }
  td.cell { min-inline-size: 180px; }
  td.cell input { inline-size: 100%; }
  td.cell.missing input { border-style: dashed; }
  td.cell.changed input { border-color: var(--db-warn-line); background: var(--db-warn-soft); }
  .cell-note { display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-2); margin-top: var(--db-space-1); font-size: var(--db-text-xs); }
  .cell-note:empty { display: none; }
  .marker { display: inline-flex; align-items: center; min-block-size: 20px; padding: 0 var(--db-space-2); border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); font-weight: 500; }
  .marker--stale { background: var(--db-warn-soft); border: var(--db-border-w) solid var(--db-warn-line); }
  .marker--page { background: var(--db-accent-soft); color: var(--db-accent-text); }
  tbody tr:hover td, tbody tr:hover th.what { background: var(--db-surface-hover); }
  .more-row td { padding: var(--db-gap, 12px); text-align: center; }
  .badge {
    display: inline-flex; align-items: center; padding: 0 var(--db-space-2); min-block-size: 20px;
    border-radius: var(--db-radius-pill); background: var(--db-surface-sunken); font-size: var(--db-text-xs); font-weight: 500; vertical-align: middle;
  }
  .badge--default { background: var(--db-accent-soft); color: var(--db-accent-text); }
  .badge--warn { background: var(--db-warn-soft); border: var(--db-border-w) solid var(--db-warn-line); }
  .pending {
    position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: flex-end; gap: var(--db-space-3);
    padding: var(--db-space-3); background: var(--db-surface); border: var(--db-border-w) solid var(--db-warn-line); border-radius: var(--db-radius-md); box-shadow: var(--db-shadow-card);
  }
  .pending[hidden] { display: none; }
  .pending p { margin-inline-end: auto; font-weight: 600; }
  input[type="text"], input[type="search"], select { max-width: 100%; }
  input[readonly], input:disabled { background: var(--db-surface-sunken); color: var(--db-ink-muted); }
  input[aria-invalid="true"] { border-color: var(--db-danger); }
  .problem { color: var(--db-danger); font-size: var(--db-text-sm); }
  /* Under 700px of surface the rail lies along the top of the texts. */
  @container (max-width: 699px) {
    .texts-body { grid-template-columns: minmax(0, 1fr); }
    .rail ul { display: flex; flex-wrap: wrap; }
    .rail-btn { inline-size: auto; }
    .table-wrap { max-block-size: 70vh; }
  }
  @media (pointer: coarse) {
    .rail-btn { min-block-size: 44px; }
  }
  @media (forced-colors: active) {
    td.cell.changed input { outline: 2px solid Highlight; }
    .badge, .marker { border: var(--db-border-w) solid CanvasText; }
    .rail-btn[aria-pressed="true"] { outline: 2px solid Highlight; }
  }
`;

export function defineLanguagesSurface(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_LANGUAGES_TAG)) {
    customElements.define(DATUM_BUILDER_LANGUAGES_TAG, DatumBuilderLanguagesElement);
  }
}

defineLanguagesSurface();
