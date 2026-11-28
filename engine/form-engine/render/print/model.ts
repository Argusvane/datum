import type { FormTextCatalog, FormTextResolver } from "../../core/localization/form-texts.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { addressOf, resolveText, type LanguagePack, type TextSources } from "../../core/localization/translations.js";
import type { LocalizedText } from "../../core/schema/contracts.js";
import { dataGridSettingsOf } from "../../core/schema/data-grid.js";
import { PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE } from "../../core/schema/journey.js";
import { isPrintRendition, readPrintConfiguration, type PrintRendition } from "../../core/schema/print.js";
import { sanitizeStaticHtml } from "../../core/schema/static-html.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { FormNotice } from "../../core/submission/form-notice.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { rowHeadingOf } from "../core/error-wording.js";
import { baseTypeOf } from "../../registry/kinds.js";
import type { JourneyRenderKit } from "../core/journey-render-kit.js";
import { defaultJourneyRenderKit } from "../core/journey-render-kit-default.js";
import { foldPresentation, type PresentationField, type PresentationGrid, type PresentationNode } from "../core/presentation-tree.js";
import { holdsPrintAnswer, keepTogetherApplies, livePrintPlan, readComponentPrintNote, readComponentPrintSettings, readComponentPrintShow } from "../core/print-options.js";
import type { RenderOutput } from "../core/render-orchestrator.js";
import { panelLookOf, type PanelLook } from "../live/look-classes.js";
import { buildRuntimeRenderOutput, type RenderableRuntime, type RuntimeRenderOptions } from "../core/runtime-render-bridge.js";
import { trustedPrintHtml, type SafeHtml } from "./safe-html.js";
import { fieldOf, formatPrintDate, signGapOf, type FieldContext } from "./field-answer.js";
import { localPrintDay, resolvePrintSlot, type PrintSlotPiece, type PrintSlotScope } from "./slot-text.js";

// A field's answer is worded in its own module, which a journey's Check answers page shares (field-answer.ts).
export { answerTextOf, fieldOf, formatPrintDate, formatPrintNumber, type AnswerText } from "./field-answer.js";

/**
 * The print model: the form's print as data, every word chosen. Built by the renderer
 * from the presentation fold (`foldPresentation`) of the read-only render output, the one walk the
 * live renderer draws from too, so paper and screen agree on what a group, a tab, a step, a row
 * and a page are called. A print theme draws from it and decides nothing else.
 */

export type { PrintRendition } from "../../core/schema/print.js";
export type { PrintSlotPiece, PrintSlotScope } from "./slot-text.js";

/** The paper size `@page` asks for; `auto` leaves it to the print dialog (the person's printer). */
export type PrintPageSize = "auto" | "A4" | "letter" | "legal" | "A5";

/** One choice of a radio group, a checkboxes group, a single checkbox or (on a paper form, blank or filled) a select. */
export interface PrintOption {
  label: string;
  hint?: string;
  chosen: boolean;
}

/** An answer, already worded: a theme only draws it. */
export type PrintAnswer =
  /**
   * A text box's answer with its affixes joined ("$1250", "70 kg"), a select's chosen label, a
   * date in the locale's words. `lines`: room to leave on a paper form; `prefix`/`suffix` are
   * kept for a paper box, which draws them beside it. On a filled form `text` is the value alone
   * (a number still in the locale's words), its affixes only in `prefix`/`suffix`.
   */
  | { shape: "text"; text: string; lines: number; multiline: boolean; prefix?: string; suffix?: string }
  /**
   * Every option with the chosen ones marked: paper keeps what was not chosen too. `single`: a
   * lone checkbox, whose one option carries the field's own label.
   */
  | { shape: "choices"; multiple: boolean; single: boolean; options: PrintOption[] }
  /**
   * A date as boxes: its parts in the order the locale writes them, with their words. A filled
   * date's parts carry their `value` (the month as the locale's name when it words dates so, else
   * digits); a blank date's, and a filled date left unanswered or unreadable, carry none. `text` is
   * a filled date as the locale words it on one line ("March 15, 2026"), for a table cell.
   */
  | { shape: "date-parts"; parts: Array<{ part: "day" | "month" | "year"; label: string; size: number; value?: string }>; text?: string }
  /** A file field: the attachments by name. */
  | { shape: "files"; names: string[] };

export interface PrintField {
  kind: "field";
  /** The component id. */
  id: string;
  /** The component type as written (a theme that draws one type its own way reads it). */
  type: string;
  /** The engine type it is read as (its base in the definition's `kinds` map). */
  base: string;
  label: string;
  hint?: string;
  required: boolean;
  /** Nothing given (always on a blank form). A filled form draws an empty box for it. */
  empty: boolean;
  answer: PrintAnswer;
  /** The author's note for paper while a rule hides the field (`print.show: "always"`). */
  note?: string;
  /** It starts a new sheet (`print.breakBefore`). */
  breakBefore?: true;
}

export interface PrintGroup {
  kind: "group";
  id: string;
  legend?: string;
  hint?: string;
  /** Nesting depth: 1 for a group directly in the form (the title is level 0). A theme heads it at `h{level + 1}`. */
  level: number;
  /** The author's note for paper while a rule hides the group (`print.show: "always"`). */
  note?: string;
  /**
   * The look the author gave a `panel` (its `panel-plain|outlined|shaded|card` class):
   * paper draws it from its own tokens. Only a panel carries one; none means the theme's own
   * group, which a `plain` look draws too.
   */
  look?: PanelLook;
  /** It starts a new sheet (`print.breakBefore`). */
  breakBefore?: true;
  /** It is not split across sheets where it fits on one (`print.keepTogether`). */
  keepTogether?: true;
  children: PrintNode[];
}

export interface PrintGridColumn {
  id: string;
  label: string;
  required: boolean;
}

export interface PrintGridRow {
  /** The row's name ("Row 2", or the grid's own `rowLabel` with `{{n}}` filled). */
  label: string;
  cells: PrintField[];
}

/** A data grid or a repeating section of fields: a table on paper, its rows from the answers (or, on a blank form, empty rows to fill in). */
export interface PrintGrid {
  kind: "grid";
  id: string;
  legend?: string;
  hint?: string;
  level: number;
  /** The author's note for paper while a rule hides the grid (`print.show: "always"`). */
  note?: string;
  columns: PrintGridColumn[];
  showRowNumbers: boolean;
  rows: PrintGridRow[];
  /** It starts a new sheet (`print.breakBefore`). */
  breakBefore?: true;
  /** It is not split across sheets where it fits on one (`print.keepTogether`). */
  keepTogether?: true;
}

/** A tab's panel, a step or a journey page: a headed run of nodes, in order. */
export interface PrintSection {
  kind: "section";
  id: string;
  /** The heading; empty for an untitled journey page, which a theme draws without one. */
  title: string;
  description?: string;
  from: "tab" | "step" | "page";
  /** The steps container a step section belongs to: the container draws no wrapper, so this is how the builder's sheet finds it. */
  container?: string;
  level: number;
  /** It starts a new sheet: its component's `print.breakBefore`, or a journey page under `journeyPageBreaks`. */
  breakBefore?: true;
  /** It is not split across sheets where it fits on one (`print.keepTogether`). */
  keepTogether?: true;
  children: PrintNode[];
}

/** An `html` component's content: markup the engine sanitized (`sanitizeStaticHtml`). */
export interface PrintContent {
  kind: "content";
  id: string;
  html: SafeHtml;
  /** It starts a new sheet (`print.breakBefore`). */
  breakBefore?: true;
}

/**
 * A group the author left unnamed and asked to keep together (`print.keepTogether`): no heading
 * and no box on paper, its nodes in the run around it. The renderer draws it itself, as a wrapper
 * around its nodes that carries the break classes; a theme draws only the nodes inside.
 */
export interface PrintRun {
  kind: "run";
  id: string;
  /** It starts a new sheet (`print.breakBefore`). */
  breakBefore?: true;
  keepTogether: true;
  children: PrintNode[];
}

export type PrintNode = PrintField | PrintGroup | PrintGrid | PrintSection | PrintContent | PrintRun;

/** The host's receipt, worded for the locale. */
export interface PrintNotice {
  kind: "success" | "info" | "warning" | "error";
  /** What the notice is, in words ("Success: "), for a theme that writes it out. */
  kindWord: string;
  title?: string;
  message?: string;
  details: Array<{ label: string; value: string }>;
}

/** A running band's two slots, resolved: what each margin box draws; an absent slot draws nothing. */
export interface PrintPageSlots {
  start?: PrintSlotPiece[];
  end?: PrintSlotPiece[];
}

/** The paper set-up before the running header and footer are resolved: what a {@link PrintSource} carries. */
export interface PrintPageSetup {
  size: PrintPageSize;
  /** The page box's margin, CSS lengths. */
  margin: string;
  titleOnFirstPage: boolean;
  scale: number;
  /** Each journey page starts a new sheet. */
  journeyPageBreaks: boolean;
}

/** The paper: size and margins are the host's; what the paper carries is the form's (`configuration.print`). */
export interface PrintPage extends PrintPageSetup {
  header: PrintPageSlots;
  footer: PrintPageSlots;
}

/** Print's own words, resolved: "Not answered", "Chosen", the row number heading, the required mark, the page number line. */
export interface PrintWords {
  notAnswered: string;
  chosen: string;
  rowNumber: string;
  required: string;
  /** "Page {{page}} of {{pages}}", its placeholders left for the page counters. */
  pageNumber: string;
}

/** Everything a theme draws from. Pure data; built once per print (again for the basic theme on a fallback). */
export interface PrintModel {
  rendition: PrintRendition;
  title?: string;
  /** The locale the form prints in. */
  locale: string;
  /** What `<html lang>` says. */
  lang: string;
  dir: "ltr" | "rtl";
  page: PrintPage;
  notice?: PrintNotice;
  nodes: PrintNode[];
  words: PrintWords;
  /**
   * The form's words for a theme's own keys: the page's texts, the form's `texts` translations, the
   * print theme's texts, the binding's language pack, the engine's English.
   */
  text: FormTextResolver;
}

/** The runtime print reads: what the render bridge reads, the definition's `kinds` map, the journey being run. */
export type PrintableRuntime = RenderableRuntime & {
  definition?(): { kinds?: Readonly<Record<string, string>> | undefined } | undefined;
};

export interface PrintSourceOptions {
  /** The rendition to print; absent, the form's `configuration.print.defaultRendition`. */
  rendition?: PrintRendition | undefined;
  /**
   * What the form shows: a read-only form prints what it shows; a live one follows each
   * component's `print.show`. Default `interactive`.
   */
  mode?: "interactive" | "readonly" | undefined;
  /** Print in another locale than the form shows. */
  locale?: string | undefined;
  /** The data sources, the journey kit and the wording the render output is built with. */
  render?: RuntimeRenderOptions | undefined;
  /** The page's form texts (the top layer of wording). */
  texts?: FormTextCatalog | undefined;
  /** The binding's language pack. */
  pack?: LanguagePack | undefined;
  /** The host's paper. */
  page?: { size?: PrintPageSize | undefined; margin?: string | undefined } | undefined;
  /** The host's receipt, printed with the form; its `data` is what `{{receipt.<path>}}` reads. */
  notice?: FormNotice | undefined;
  /**
   * The day of printing, `YYYY-MM-DD`, that `{{date}}` prints; absent, the runtime's
   * `today()`, else the calendar day where the code runs.
   */
  today?: string | undefined;
}

/** One journey page of a print. */
export interface PrintSourcePage {
  pageId: string;
  title: string;
  description?: string | undefined;
  members: string[];
  /** Not on the person's path: only its components printed whatever the rules say print, with their notes. */
  offPath?: true;
}

/** What a print is made from: the read-only render output and what was read off the runtime with it. */
export interface PrintSource {
  output: RenderOutput;
  rendition: PrintRendition;
  mode: "interactive" | "readonly";
  locale: string;
  sources: TextSources;
  texts: FormTextCatalog | undefined;
  pack: LanguagePack | undefined;
  kinds: Readonly<Record<string, string>> | undefined;
  journeyKit: JourneyRenderKit;
  root: ComponentNode;
  /**
   * A journey's pages, when the runtime runs one and the kit can pick a page's components: the
   * person's path in order, and (for a live print) each page off it that holds a component
   * printed whatever the rules say, placed by the journey's own order and marked `offPath`.
   */
  pages: PrintSourcePage[] | undefined;
  title: string | undefined;
  page: PrintPageSetup;
  /**
   * The running header's and footer's slot texts, in the print's locale, placeholders not yet
   * read. `footer.end` is `undefined` for the engine's page number line, worded by {@link printModelOf}.
   */
  slots: { header: { start: string; end: string }; footer: { start: string; end: string | undefined } };
  /** What the slots' placeholders read. */
  slotScope: PrintSlotScope;
  notice: FormNotice | undefined;
}

const PAGE_SIZES: ReadonlySet<string> = new Set(["auto", "A4", "letter", "legal", "A5"]);
const DEFAULT_MARGIN = "16mm";

/** A host's margin, if it is one to four CSS lengths (it goes into the print document's `@page`). */
function marginOf(value: string | undefined): string {
  if (typeof value !== "string") {
    return DEFAULT_MARGIN;
  }
  const trimmed = value.trim();
  return /^(?:(?:0|\d+(?:\.\d+)?(?:mm|cm|in|pt|pc|px))(?:\s+|$)){1,4}$/.test(trimmed) ? trimmed : DEFAULT_MARGIN;
}

/** A configuration as a record (never `null`, never an array). */
function configurationOf(node: ComponentNode | undefined): Record<string, unknown> {
  const configuration = node?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasConfiguredLabel(node: ComponentNode): boolean {
  const raw = configurationOf(node)["label"];
  return (typeof raw === "string" && raw.length > 0) || (raw !== null && typeof raw === "object" && !Array.isArray(raw));
}

/**
 * The form components a journey page holds, in its order: a listed id; the component
 * a reference names; the form field an alias fills or a worked-out value works out. A node the
 * presentation owns otherwise holds an answer that is never printed; its children are read for
 * the references inside it.
 */
export function journeyPagePrintMembers(entries: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      out.push(entry);
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return;
    }
    const node = entry as { type?: unknown; configuration?: unknown; children?: unknown };
    const configuration = node.configuration && typeof node.configuration === "object" ? (node.configuration as Record<string, unknown>) : {};
    const named =
      node.type === PRESENTATION_REFERENCE_TYPE
        ? configuration["componentId"]
        : node.type === PRESENTATION_VALUE_TYPE
          ? configuration["to"]
          : configuration["fills"];
    if (typeof named === "string" && named !== "") {
      out.push(named);
    }
    if (node.children && typeof node.children === "object") {
      for (const list of Object.values(node.children as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          list.forEach(visit);
        }
      }
    }
  };
  (entries ?? []).forEach(visit);
  return out;
}

/**
 * Reads what a print is made from off a runtime as it stands: the read-only render output (never a
 * journey's current page: a review, a printed copy and a PDF show every answer), the
 * title, the page set-up and, for a journey, the pages on the person's path.
 */
export async function readPrintSource(runtime: PrintableRuntime, options: PrintSourceOptions = {}): Promise<PrintSource> {
  const state = runtime.state();
  const locale = options.locale ?? state.locale;
  const output = await buildRuntimeRenderOutput(runtime, "readonly", { ...(options.render ?? {}), locale });
  const sources: TextSources = { translations: runtime.translations?.(), catalog: runtime.translationCatalog?.() };
  const root = runtime.formRoot();
  const configuration = configurationOf(root);
  const rawTitle = configuration["title"];
  const title = typeof rawTitle === "string" ? resolveText(rawTitle, addressOf.form("title"), locale, sources) : undefined;
  const print = readPrintConfiguration(root.configuration);
  const journeyKit = options.render?.journeyKit ?? defaultJourneyRenderKit();
  const view = runtime.journeyView?.();
  // A kit that cannot pick a page's components (the Noop) prints the form whole.
  const byId = new Map(output.components.map((model) => [model.id, model]));
  let pages: PrintSourcePage[] | undefined;
  if (view && journeyKit.id !== "noop") {
    type JourneyPage = (typeof view.journey.pages)[number];
    const entryOf = (page: JourneyPage, members: string[]): PrintSourcePage => {
      const worded = (property: "title" | "description"): string | undefined => {
        const authored = page[property];
        const text = typeof authored === "string" ? resolveText(authored, addressOf.journeyPage(view.journeyId, page.id, property), locale, sources) : undefined;
        return text !== undefined && text.trim() !== "" ? text : undefined;
      };
      // Untitled, a page is headed by its first labelled component, as on screen; never by its id.
      const labelled = members.map((id) => byId.get(id)).find((model) => model !== undefined && hasConfiguredLabel(model.node));
      const description = worded("description");
      return { pageId: page.id, title: worded("title") ?? labelled?.label ?? "", ...(description !== undefined ? { description } : {}), members };
    };
    const onPath = new Set(view.path);
    pages = view.path.flatMap((pageId) => {
      const page = view.journey.pages.find((candidate) => candidate.id === pageId);
      return page ? [entryOf(page, journeyPagePrintMembers(page.components))] : [];
    });
    if (options.mode !== "readonly") {
      // A page off the path is a page a rule left out: like a field a rule hides, only what
      // prints whatever the rules say comes with it (`print.show: "always"`, its note beside it).
      // Each goes after the page the journey lists before it, so paper keeps the journey's order.
      const printed = new Set(pages.flatMap((entry) => entry.members));
      let after = -1;
      for (const page of view.journey.pages) {
        if (onPath.has(page.id)) {
          after = pages.findIndex((entry) => entry.pageId === page.id && entry.offPath === undefined);
          continue;
        }
        const members = journeyPagePrintMembers(page.components).filter((id) => !printed.has(id));
        if (members.length === 0) {
          continue;
        }
        pages.splice(after + 1, 0, { ...entryOf(page, members), offPath: true });
        after += 1;
      }
    }
  }
  const size = options.page?.size;
  const rendition = isPrintRendition(options.rendition) ? options.rendition : print.defaultRendition;
  // Only words the author wrote are translated: a slot left to its default, or emptied, takes no
  // stored translation (one left behind by an earlier wording would print words the slot no longer has).
  const storedPrint = isRecord(configuration["print"]) ? configuration["print"] : {};
  const written = (band: "header" | "footer", key: "start" | "end"): boolean => {
    const region = storedPrint[band];
    const text = isRecord(region) ? region[key] : undefined;
    return typeof text === "string" && text !== "";
  };
  const slot = (band: "header" | "footer", key: "start" | "end", text: string): string =>
    written(band, key) ? resolveText(text, addressOf.printSlot(band, key), locale, sources) : text;
  const footerEnd = print.footer.end;
  const resolvedTitle = title !== undefined && title.trim() !== "" ? title : undefined;
  const fromRuntime = runtime.today?.();
  const day = options.today ?? (fromRuntime !== undefined && fromRuntime !== "" ? fromRuntime : localPrintDay());
  const hostContext = runtime.hostContext?.();
  const receipt = options.notice?.data;
  // The answers as a printed copy reads them (after the hidden-value policy); a blank form holds none.
  const values = rendition === "blank" ? {} : (runtime.printableValues?.() ?? runtime.formValues?.() ?? state.values);
  return {
    output,
    rendition,
    mode: options.mode === "readonly" ? "readonly" : "interactive",
    locale,
    sources,
    texts: options.texts,
    pack: options.pack,
    kinds: runtime.definition?.()?.kinds,
    journeyKit,
    root,
    pages,
    title: resolvedTitle,
    page: {
      size: size !== undefined && PAGE_SIZES.has(size) ? size : "auto",
      margin: marginOf(options.page?.margin),
      titleOnFirstPage: print.titleOnFirstPage,
      scale: print.scale,
      journeyPageBreaks: print.journeyPageBreaks
    },
    slots: {
      header: { start: slot("header", "start", print.header.start), end: slot("header", "end", print.header.end) },
      footer: { start: slot("footer", "start", print.footer.start), end: footerEnd === undefined ? undefined : slot("footer", "end", footerEnd) }
    },
    slotScope: {
      ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
      date: formatPrintDate(day, locale),
      values,
      ...(isRecord(hostContext) ? { hostContext } : {}),
      ...(isRecord(receipt) ? { receipt } : {})
    },
    notice: options.notice
  };
}

// ── The model ───────────────────────────────────────────────────────────────────────────────

/**
 * Whether a component prints, and the note it prints with. `hidden`: it prints while hidden (a
 * rule hides it, or a journey left its page off the path), so its contents are read as hidden too.
 */
type PrintDecision = { prints: false } | { prints: true; hidden: boolean; note?: string };

/**
 * The print model of `source`, worded with `bindingTexts` (the binding's) under the page's texts
 * and the form's translations. Synchronous and pure: the renderer builds it again for the basic
 * theme when the chosen one falls back.
 */
export function printModelOf(source: PrintSource, bindingTexts?: FormTextCatalog): PrintModel {
  const { output, locale, rendition } = source;
  const blank = rendition === "blank";
  // Two prints. A read-only form prints what it shows, bar the components set to
  // `on: "screen"`, which every print leaves off with their contents. A live form prints what each
  // component's `print.show` asks: as on screen, always (with a note while a rule hides it), only
  // when answered, or never. A blank form follows the same settings, but a field "printed only
  // when answered" prints as on screen (nothing on a blank form is answered). A filled form
  // follows the answers' rules exactly: it holds the answers.
  const readOnly = source.mode === "readonly";
  const plan = livePrintPlan(source.root, readOnly);
  const tree = foldPresentation(output, {
    locale,
    ...(source.texts ? { texts: source.texts } : {}),
    ...(bindingTexts ? { bindingTexts } : {}),
    ...(source.pack ? { bindingPack: source.pack } : {}),
    translations: source.sources.translations,
    translationCatalog: source.sources.catalog,
    kinds: source.kinds,
    journeyKit: source.journeyKit,
    ...(readOnly ? {} : { includeHidden: true }),
    // Paper: a component drawn on paper only is folded with the rest.
    surface: "paper",
    // The printed form's outline is its own: the title is its h1.
    headingLevel: 1,
    // A blank form draws every collection from its template, padded to the rows it gives room for.
    ...(blank ? { dataGridRows: "template" as const } : {}),
    ...(source.pages ? { pages: source.pages } : {})
  });
  const text = tree.text;
  const context: FieldContext = { rendition, locale, text, signGap: signGapOf(locale) };
  const models = new Map(output.components.map((model) => [model.id, model]));
  const offPath = new Set((source.pages ?? []).flatMap((entry) => (entry.offPath ? [entry.pageId] : [])));

  /** Whether `model` holds an answer; a container (a fieldset, whose own value is nothing) when a field inside it does. */
  const answered = (model: RenderComponentModel): boolean => {
    const inside = (node: ComponentNode): boolean =>
      Object.values(node.children ?? {}).some((list) => list.some((child) => holdsPrintAnswer(models.get(child.id)?.value) || inside(child)));
    return holdsPrintAnswer(model.value) || inside(model.node);
  };
  /** Whether a folded node holds an answer: its own value, or one of the nodes folded inside it. */
  const holdsAnswer = (node: PresentationNode): boolean => {
    if (holdsPrintAnswer(node.model?.value)) {
      return true;
    }
    switch (node.kind) {
      case "field":
        return false;
      case "grid":
        return node.rows.some((row) => row.cells.some((cell) => cell.children.some(holdsAnswer)));
      case "tabs":
        return node.tabs.some((tab) => tab.children.some(holdsAnswer));
      case "steps":
        return node.steps.some((step) => step.children.some(holdsAnswer)) || node.others.some(holdsAnswer);
      default:
        return node.children.some(holdsAnswer);
    }
  };

  /** `visible`: the component shows, and nothing around it is printed hidden. */
  const decide = (model: RenderComponentModel | undefined, visible: boolean, isAnswered: (model: RenderComponentModel) => boolean = answered): PrintDecision => {
    if (!model) {
      return visible ? { prints: true, hidden: false } : { prints: false };
    }
    const show = readComponentPrintShow(model.node.configuration);
    let decision = plan.decide(model.id, !blank && show === "answered" && isAnswered(model));
    // An `answered` field on a blank form prints as on screen, unless it is left off for good
    // (screen-only, or inside a screen-only component): that drop holds whatever it answers.
    if (blank && decision === "drop" && show === "answered" && plan.decide(model.id, true) !== "drop") {
      decision = undefined;
    }
    if (decision === "drop") {
      return { prints: false };
    }
    if (visible) {
      return { prints: true, hidden: false };
    }
    if (decision === "keep") {
      return plan.hasNote(model.id)
        ? { prints: true, hidden: true, note: readComponentPrintNote(model.id, model.node.configuration, locale, source.sources) ?? text("printOnlyIf") }
        : { prints: true, hidden: true };
    }
    // Hidden and following the screen: printed only as the way to an `always` component inside it.
    return plan.holdsKept(model.id) ? { prints: true, hidden: true } : { prints: false };
  };

  /**
   * A component's breaks on paper (`print.breakBefore`, `print.keepTogether`), as the keys a node
   * carries: keep together only where {@link keepTogetherApplies}, the inspector's own reading.
   */
  const breaksOf = (model: RenderComponentModel | undefined): { breakBefore?: true; keepTogether?: true } => {
    const settings = readComponentPrintSettings(model?.node.configuration);
    const keep = settings.keepTogether && keepTogetherApplies(model?.node, source.kinds);
    return { ...(settings.breakBefore ? { breakBefore: true as const } : {}), ...(keep ? { keepTogether: true as const } : {}) };
  };
  /** `nodes` with the first one starting a new sheet when `breakBefore` asks: a component drawn as a run of nodes breaks before the run. */
  const breakFirst = (nodes: PrintNode[], breakBefore: true | undefined): PrintNode[] => {
    const first = nodes[0];
    if (breakBefore && first) {
      first.breakBefore = true;
    }
    return nodes;
  };

  /**
   * A container whose first printed child starts a new sheet starts it itself: the heading (a
   * legend, a tab's, a step's or a page's title) is drawn inside the container before that child,
   * so a break left on the child would leave the heading alone at the foot of the sheet before.
   * Children are converted before their container, so a chain of first children rises to the outermost.
   */
  const hoistBreak = <T extends { breakBefore?: true; children: PrintNode[] }>(container: T): T => {
    const first = container.children[0];
    if (first?.breakBefore) {
      delete first.breakBefore;
      container.breakBefore = true;
    }
    return container;
  };

  const fieldNode = (node: PresentationField, note?: string): PrintNode[] => {
    const { breakBefore } = breaksOf(node.model);
    const marks = breakBefore ? { breakBefore } : {};
    if (node.base === "html") {
      // Read through the sanitizer once more, which leaves its own output as it is: every block is
      // balanced on its own, so nothing one opens can wrap the labels and answers printed after it.
      const html = node.model.staticHtml ? sanitizeStaticHtml(node.model.staticHtml) : "";
      return html !== "" ? [{ kind: "content", id: node.id, html: trustedPrintHtml(html), ...marks }] : [];
    }
    const field = fieldOf(node.model, node.base, context, note);
    return field ? [{ ...field, ...marks }] : [];
  };

  const grid = (node: PresentationGrid, decision: { hidden: boolean; note?: string }): PrintNode[] => {
    // A column is answered when any row answers it: the column's own model is the template, which holds no value.
    const columnAnswered = (column: PresentationGrid["columns"][number]) => (): boolean =>
      node.rows.some((row) => row.cells.some((cell) => cell.columnId === column.id && cell.children.some(holdsAnswer)));
    const columns = node.columns.filter((column) => decide(column.model, column.model.visible && !decision.hidden, columnAnswered(column)).prints);
    if (columns.length === 0) {
      return [];
    }
    const leafColumns = columns.every((column) => column.model.node.children === undefined && column.model.rows === undefined);
    const cellsOf = (row: PresentationGrid["rows"][number]): Array<PrintField | undefined> =>
      columns.map((column) => {
        const drawn = row.cells.find((cell) => cell.columnId === column.id)?.children[0];
        return drawn && drawn.kind === "field" ? fieldOf(drawn.model, drawn.base, context) : undefined;
      });
    const emptyCell = (column: PresentationGrid["columns"][number]): PrintField =>
      fieldOf(column.model, baseTypeOf(column.model.type, source.kinds), { ...context, rendition: "blank" }) ?? {
        kind: "field",
        id: column.id,
        type: column.model.type,
        base: baseTypeOf(column.model.type, source.kinds),
        label: column.label,
        required: column.required,
        empty: true,
        answer: { shape: "text", text: "", lines: 1, multiline: false }
      };
    const header = {
      ...(node.legend !== undefined ? { legend: node.legend } : {}),
      ...(node.hint !== undefined ? { hint: node.hint } : {}),
      ...(decision.note !== undefined ? { note: decision.note } : {})
    };
    const breaks = breaksOf(node.model);
    /**
     * A blank form's room to write: the rows the form opens with, at least three (eight at most,
     * unless the form asks for more), never fewer than it needs and never past its limit.
     */
    const blankRows = (): number => {
      const settings = node.base === "dataGrid" ? dataGridSettingsOf(node.model.node) : undefined;
      const room = Math.min(8, Math.max(3, settings?.initialRows ?? 0));
      return Math.max(1, Math.min(node.maxRows ?? Number.POSITIVE_INFINITY, Math.max(room, node.minRows)));
    };
    if (leafColumns) {
      let rows: PrintGridRow[];
      if (blank) {
        rows = Array.from({ length: blankRows() }, (_, index) => ({
          label: rowHeadingOf(node.model.node, index + 1, locale, source.sources, text),
          cells: columns.map((column) => emptyCell(column))
        }));
      } else {
        // Answers and filled alike: the rows the person gave, no padding rows.
        rows = node.rows.map((row) => ({
          label: row.label,
          cells: cellsOf(row).map((cell, index) => cell ?? emptyCell(columns[index] as PresentationGrid["columns"][number]))
        }));
      }
      return [
        {
          kind: "grid",
          id: node.id,
          ...header,
          level: node.level,
          columns: columns.map((column) => ({ id: column.id, label: column.label, required: column.required })),
          showRowNumbers: node.showRowNumbers,
          rows,
          ...breaks
        }
      ];
    }
    // A repeating section whose rows hold groups: each row a group of its own, headed by its name.
    // No rows given: the heading and the words a table without rows draws (a grid of no rows).
    if (!blank && node.rows.length === 0) {
      return [{ kind: "grid", id: node.id, ...header, level: node.level, columns: columns.map((column) => ({ id: column.id, label: column.label, required: column.required })), showRowNumbers: node.showRowNumbers, rows: [], ...breaks }];
    }
    const rowGroup = (row: PresentationGrid["rows"][number], index: number, label: string): PrintNode[] => {
      const children = row.cells.flatMap((cell) => cell.children.flatMap((child) => convert(child, decision.hidden)));
      return children.length > 0 ? [hoistBreak<PrintGroup>({ kind: "group", id: `${node.id}#${index}`, legend: label, level: node.level + 1, children })] : [];
    };
    let rowGroups: PrintNode[];
    const template = node.rows[0];
    if (blank && template) {
      // Room to write, as many rows as a table's blank form gives: each row the template's groups, empty.
      rowGroups = Array.from({ length: blankRows() }, (_, index) => rowGroup(template, index, rowHeadingOf(node.model.node, index + 1, locale, source.sources, text))).flat();
    } else {
      rowGroups = node.rows.flatMap((row) => rowGroup(row, row.index, row.label));
    }
    return [hoistBreak<PrintGroup>({ kind: "group", id: node.id, ...header, level: node.level, ...breaks, children: rowGroups })];
  };

  /** `hiddenAbove`: a container around the node prints hidden, so the node is read as hidden. */
  function convert(node: PresentationNode, hiddenAbove = false): PrintNode[] {
    if (node.kind === "page") {
      // A page off the person's path prints only what prints whatever the rules say.
      const hidden = hiddenAbove || offPath.has(node.id);
      const children = node.children.flatMap((child) => convert(child, hidden));
      return children.length > 0
        ? [hoistBreak<PrintSection>({ kind: "section", id: `page:${node.id}`, title: node.title, ...(node.description !== undefined ? { description: node.description } : {}), from: "page", level: 1, children })]
        : [];
    }
    const decision = decide(node.model, node.visible && !hiddenAbove);
    if (!decision.prints) {
      return [];
    }
    const within = (child: PresentationNode): PrintNode[] => convert(child, decision.hidden);
    switch (node.kind) {
      case "field":
        return fieldNode(node, decision.note);
      case "grid":
        return grid(node, decision);
      case "tabs":
        // Every tab is a headed section, in tab order: nothing sits behind a tab on paper.
        return breakFirst(
          node.tabs.flatMap((tab) => {
            const children = tab.children.flatMap(within);
            return children.length > 0 ? [hoistBreak<PrintSection>({ kind: "section", id: `${node.id}:${tab.slotId}`, title: tab.label, from: "tab", level: node.level, children })] : [];
          }),
          breaksOf(node.model).breakBefore
        );
      case "steps": {
        // Every step, in order, a headed section.
        const steps = node.steps.flatMap((step) => {
          const stepDecision = decide(step.model, step.visible && !decision.hidden);
          if (!stepDecision.prints) {
            return [];
          }
          const children = step.children.flatMap((child) => convert(child, stepDecision.hidden));
          return children.length > 0 ? [hoistBreak<PrintSection>({ kind: "section", id: step.id, title: step.label, from: "step", container: node.id, level: node.level, ...breaksOf(step.model), children })] : [];
        });
        return breakFirst([...steps, ...node.others.flatMap(within)], breaksOf(node.model).breakBefore);
      }
      case "group": {
        const children = node.children.flatMap(within);
        if (children.length === 0) {
          return [];
        }
        // A group the author left unnamed is no heading on paper: its fields join the run around it
        // (and its note, with nothing to stand under, goes on its first field that has none).
        // Kept together, its nodes go in a run of their own, which carries its breaks; else its
        // break before goes on its first node.
        if (node.legend === undefined) {
          const first = children[0];
          if (decision.note !== undefined && first?.kind === "field" && first.note === undefined) {
            first.note = decision.note;
          }
          const breaks = breaksOf(node.model);
          return breaks.keepTogether ? [{ kind: "run", id: node.id, ...breaks, keepTogether: true, children }] : breakFirst(children, breaks.breakBefore);
        }
        const look = node.base === "panel" ? panelLookOf(node.model.node.configuration) : undefined;
        return [
          hoistBreak<PrintGroup>({
            kind: "group",
            id: node.id,
            legend: node.legend,
            ...(node.hint !== undefined ? { hint: node.hint } : {}),
            ...(decision.note !== undefined ? { note: decision.note } : {}),
            ...(look !== undefined ? { look } : {}),
            level: node.level,
            ...breaksOf(node.model),
            children
          })
        ];
      }
    }
  }

  const nodes = tree.nodes.flatMap((node) => convert(node));
  if (source.page.journeyPageBreaks) {
    // Each journey page after the first starts a new sheet.
    nodes.filter((node): node is PrintSection => node.kind === "section" && node.from === "page").forEach((section, index) => {
      if (index > 0) {
        section.breakBefore = true;
      }
    });
  }
  // Nothing printed comes before the form's first node but the title, the receipt and headings:
  // a break there would leave the first sheet holding those alone. The node that leads the form,
  // and the first node inside it at every depth, never starts a new sheet.
  for (let lead: PrintNode | undefined = nodes[0]; lead !== undefined; lead = "children" in lead ? lead.children[0] : undefined) {
    delete lead.breakBefore;
  }

  const pageNumber = text("printPageNumber");
  const slot = (template: string): PrintSlotPiece[] | undefined => resolvePrintSlot(template, source.slotScope);
  // The engine's page number line, in the print's words; worded as nothing, the bare counters.
  const pageNumberLine = (): PrintSlotPiece[] | undefined => slot(pageNumber) ?? slot("{{page}} / {{pages}}");
  const slots = (start: PrintSlotPiece[] | undefined, end: PrintSlotPiece[] | undefined): PrintPageSlots => ({
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {})
  });
  const { header, footer } = source.slots;

  const notice = noticeOf(source.notice, locale, text);
  return {
    rendition,
    ...(source.title !== undefined ? { title: source.title } : {}),
    locale,
    lang: locale.replace(/_/g, "-"),
    dir: output.meta.textDirection === "rtl" ? "rtl" : "ltr",
    page: {
      ...source.page,
      header: slots(slot(header.start), slot(header.end)),
      footer: slots(slot(footer.start), footer.end === undefined ? pageNumberLine() : slot(footer.end))
    },
    ...(notice ? { notice } : {}),
    nodes,
    words: {
      notAnswered: text("printEmpty"),
      chosen: text("printChosen"),
      rowNumber: text("printRowNumber"),
      required: text("required"),
      pageNumber
    },
    text
  };
}

function noticeOf(notice: FormNotice | undefined, locale: string, text: FormTextResolver): PrintNotice | undefined {
  if (!notice) {
    return undefined;
  }
  const worded = (value: LocalizedText | undefined): string | undefined => {
    const resolved = value === undefined || value === null ? undefined : resolveLocalizedText(value, locale);
    return resolved !== undefined && resolved.trim() !== "" ? resolved : undefined;
  };
  const kind = notice.kind === "info" || notice.kind === "warning" || notice.kind === "error" ? notice.kind : "success";
  const title = worded(notice.title);
  const message = worded(notice.message);
  const details = (notice.details ?? []).flatMap((detail) => {
    const label = worded(detail.label);
    return label !== undefined && typeof detail.value === "string" ? [{ label, value: detail.value }] : [];
  });
  if (title === undefined && message === undefined && details.length === 0) {
    return undefined;
  }
  const kindKey = kind === "success" ? "noticeSuccess" : kind === "info" ? "noticeInfo" : kind === "warning" ? "noticeWarning" : "noticeError";
  return {
    kind,
    kindWord: text(kindKey),
    ...(title !== undefined ? { title } : {}),
    ...(message !== undefined ? { message } : {}),
    details
  };
}

/** The print model for a runtime as it stands. */
export async function buildPrintModel(runtime: PrintableRuntime, options: PrintSourceOptions & { bindingTexts?: FormTextCatalog | undefined } = {}): Promise<PrintModel> {
  return printModelOf(await readPrintSource(runtime, options), options.bindingTexts);
}
