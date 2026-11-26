import type { FormTextCatalog } from "../../core/localization/form-texts.js";
import type { PrintContent, PrintField, PrintGrid, PrintGroup, PrintModel, PrintNode, PrintNotice, PrintRendition, PrintSection } from "./model.js";
import type { PrintHtmlValue, SafeHtml } from "./safe-html.js";

/**
 * A print theme: what a printed form looks like, apart from the form's live look.
 * Print never runs a design system's JavaScript (its components would not have hydrated when the
 * dialog opens, and hydrated ones clip long answers and split across pages): a print theme is a
 * pure function of the {@link PrintModel} to static markup, styled by its own sheet, which may lean
 * on the design system's stylesheet and fonts the host links (never its scripts).
 *
 * The renderer owns everything else: what prints (`print.show`, rules), the wording, the structure
 * (groups, grids as table rows, tabs, steps and journey pages as headed sections in order), the
 * page set-up (`@page` size, margins, margin boxes), the breaks that keep a field whole, waiting
 * for the sheets and fonts, the self-check and the fallback.
 */

/**
 * What each drawer is handed beside its node. A theme draws with {@link html}, the renderer's own
 * `printHtml` tag: markup is branded by the copy of the engine that drew the form, so a theme built
 * as a package of its own (bundling no engine code, like a binding) draws through the tag it is
 * handed here, never one it imports. Markup made by another copy of the tag is refused.
 */
export interface PrintContext {
  model: PrintModel;
  /** The `printHtml` template tag: every value escaped unless it is markup this tag made. */
  html: (strings: TemplateStringsArray, ...values: readonly PrintHtmlValue[]) => SafeHtml;
  /** Markup joined in order. */
  join(parts: readonly SafeHtml[]): SafeHtml;
  /** A heading for a node `level` deep (the title is the h1, a group directly in the form an h2), as the basic theme draws one. */
  heading(level: number, className: string, content: SafeHtml | string): SafeHtml;
  /** Draws nodes with the theme's drawers (and the basic theme's for those it leaves out), each in the renderer's wrapper. */
  drawAll(nodes: readonly PrintNode[]): SafeHtml;
}

/** One drawer per node kind; each returns markup made by `printHtml`. */
export interface PrintDrawers {
  /** The form's title at the top of the first page (`configuration.print.titleOnFirstPage`). */
  title(title: string, context: PrintContext): SafeHtml;
  /** The host's receipt (`<datum-form-renderer>.notice`), printed above the fields. */
  notice(notice: PrintNotice, context: PrintContext): SafeHtml;
  field(field: PrintField, context: PrintContext): SafeHtml;
  /** `children` is the group's nodes, already drawn. */
  group(group: PrintGroup, children: SafeHtml, context: PrintContext): SafeHtml;
  grid(grid: PrintGrid, context: PrintContext): SafeHtml;
  /** A tab's panel, a step or a journey page: a headed run of nodes. `children` is already drawn. */
  section(section: PrintSection, children: SafeHtml, context: PrintContext): SafeHtml;
  content(node: PrintContent, context: PrintContext): SafeHtml;
}

export interface PrintTheme {
  id: string;
  label: string;
  /** The theme's sheet: after the host's stylesheets (and after the basic theme's, which draws what this one leaves out). */
  css: string;
  /** Declarations for the page-margin boxes (running header, footer, page numbers): they inherit nothing from the page. */
  marginBox?: string;
  /** The theme's words, under the page's texts and the form's translations, over the binding's language pack and the engine's English. */
  texts?: FormTextCatalog;
  /**
   * The renditions the theme draws: `answers` (a record), `blank` (a paper form to fill in) and
   * `filled` (that form with the answers in it) each hand a drawer different shapes (a filled text
   * has no joined affixes, a filled date is boxes with values, a filled select lists every option).
   * Absent, the theme draws `answers` and `blank`. Asked for another, the whole document is
   * printed with the basic theme and `fellBack` says why.
   */
  renditions?: readonly PrintRendition[];
  /** Partial: a node kind the theme leaves out is drawn by the basic theme. */
  draw: Partial<PrintDrawers>;
  /**
   * Once the document has loaded in the print frame (its sheets and fonts in): what keeps the
   * theme from printing as it should (its design system's tokens absent because the host gave no
   * stylesheet, a font that never arrived). Any problem and the whole document is printed with the
   * basic theme instead, with a console warning and `fellBack` on `datum-print`.
   */
  selfCheck?(doc: Document): readonly string[];
}

/** What the host hands print: the same files it gives the binding. Stylesheets and fonts are linked; scripts never are. */
export interface PrintAssets {
  stylesheets?: ReadonlyArray<{ url: string; integrity?: string | undefined }>;
  fonts?: ReadonlyArray<{ url: string; integrity?: string | undefined }>;
  /** Ignored: a print document runs no script (accepted so the binding's list can be passed as it is). */
  scripts?: readonly unknown[];
}
