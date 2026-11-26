import { basicPrintTheme, BASIC_PRINT_DRAWERS, printHeading } from "./basic.js";
import { datumPrintTheme } from "./datum.js";
import { printModelOf, type PrintModel, type PrintNode, type PrintRendition, type PrintSlotPiece, type PrintSource } from "./model.js";
import { escapePrintText, isSafeHtml, joinPrintHtml, printHtml, type SafeHtml } from "./safe-html.js";
import type { PrintAssets, PrintContext, PrintDrawers, PrintTheme } from "./theme.js";

/**
 * The print document: a complete, self-contained HTML document drawn from a
 * {@link PrintModel} by a print theme, with the renderer's own sheet (page set-up, breaks) last.
 * It carries no script and says so (`Content-Security-Policy: script-src 'none'`), links the
 * host's stylesheets and fonts for a theme that leans on them, and nothing else. Pure: a host can
 * build one under Node and hand it to a server's headless browser.
 */

/** A drawer of a print theme threw, or handed back anything but `printHtml` markup: the theme is set aside. */
export class PrintThemeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintThemeRefusal";
  }
}

/** Datum's own print themes: they need nothing from the host, so the host's files are never linked for them. */
const OWN_THEMES: ReadonlySet<PrintTheme> = new Set([basicPrintTheme, datumPrintTheme]);

/**
 * `value` as a double-quoted CSS string: quotes and backslashes escaped, every newline `\a`, every
 * other control character by its hex code, and `<` as `\3c ` so nothing in it reads as markup to
 * the HTML parser around the `<style>` (a title's `</style>` closes nothing).
 */
function cssString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|[\n\r\f]/g, "\\a ")
    .replace(/[\u0000-\u001f\u007f]/g, (control) => `\\${control.charCodeAt(0).toString(16)} `)
    .replace(/</g, "\\3c ");
  return `"${escaped}"`;
}

/** A slot's pieces as margin-box content: each text a CSS string, each counter `counter(page)` or `counter(pages)`. */
function slotContent(pieces: readonly PrintSlotPiece[]): string {
  return pieces.map((piece) => ("counter" in piece ? `counter(${piece.counter === "pages" ? "pages" : "page"})` : cssString(piece.text))).join(" ");
}

/** Declarations only: a theme's margin-box rules may not close the box they sit in. */
function declarationsOnly(css: string): string {
  return css.replace(/[{}<]/g, "");
}

/**
 * The renderer's sheet, last in the document: the page box (size, margins, the running header and
 * footer slots) and the breaks: what keeps a field whole, the author's breaks before a component
 * and the containers kept on one sheet. It names only the renderer's wrappers
 * (`.datum-print__*`), so it holds under every theme.
 *
 * Chromium draws the margin boxes; Firefox and Safari ignore them and offer their own header and
 * footer in the print dialog. The scale is CSS `zoom`, which changes layout, so page breaks fall
 * where the scaled form needs them.
 */
export function printPageCss(model: PrintModel, marginBox: string): string {
  const start = model.dir === "rtl" ? "right" : "left";
  const end = model.dir === "rtl" ? "left" : "right";
  const box = declarationsOnly(marginBox);
  const boxes: string[] = [];
  const marginBoxRule = (at: string, pieces: readonly PrintSlotPiece[] | undefined): void => {
    if (!pieces || pieces.length === 0) {
      return;
    }
    // A line of text alone stays on one line; one with a counter keeps the box's own wrapping.
    const textOnly = pieces.every((piece) => !("counter" in piece));
    boxes.push(`@${at} { content: ${slotContent(pieces)}; ${box}${textOnly ? " white-space: nowrap;" : ""} }`);
  };
  marginBoxRule(`top-${start}`, model.page.header?.start);
  marginBoxRule(`top-${end}`, model.page.header?.end);
  marginBoxRule(`bottom-${start}`, model.page.footer?.start);
  marginBoxRule(`bottom-${end}`, model.page.footer?.end);
  const size = model.page.size === "auto" ? "" : `size: ${model.page.size}; `;
  const scale = Number.isFinite(model.page.scale) && model.page.scale > 0 && model.page.scale !== 1 ? `.datum-print { zoom: ${model.page.scale}; }` : "";
  return `
@page { ${size}margin: ${model.page.margin}; ${boxes.join(" ")} }
html, body { margin: 0; padding: 0; background: #fff; color-scheme: light; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* On screen (a host that cancels datum-print and shows the document) the page margin is padding. */
@media screen { body { padding: ${model.page.margin}; } }
${scale}
/* A field never splits from its label or across a page. */
.datum-print__field, .datum-print__content, .datum-print__notice, .datum-print__grid tr { break-inside: avoid; page-break-inside: avoid; }
/* A heading, and what a theme marks .datum-print__keep (a group's heading and hint), stay with what follows. */
.datum-print h1, .datum-print h2, .datum-print h3, .datum-print h4, .datum-print h5, .datum-print h6, .datum-print__keep { break-after: avoid; page-break-after: avoid; }
/* A long answer wraps: never clipped, never one line past the margin. */
.datum-print__answer { white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
/* A table's head repeats on every page it runs onto; its columns share the page width. */
.datum-print__grid table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.datum-print__grid thead { display: table-header-group; }
.datum-print img { max-width: 100%; }
/* The author's breaks: a component that starts a new sheet (never a blank first one), a container kept on one sheet. */
.datum-print__break-before { break-before: page; page-break-before: always; }
.datum-print > .datum-print__break-before:first-child { break-before: auto; page-break-before: auto; }
.datum-print__keep-together { break-inside: avoid; page-break-inside: avoid; }
`;
}

/** The theme's markup for the whole form, each node in the renderer's wrapper. Throws {@link PrintThemeRefusal}. */
export function drawPrintBody(theme: PrintTheme, model: PrintModel): SafeHtml {
  const drawer = <K extends keyof PrintDrawers>(key: K): { draw: PrintDrawers[K]; by: string } => {
    const own = theme.draw[key];
    return own ? { draw: own as PrintDrawers[K], by: theme.id } : { draw: BASIC_PRINT_DRAWERS[key], by: basicPrintTheme.id };
  };
  const call = <K extends keyof PrintDrawers>(key: K, args: Parameters<PrintDrawers[K]>): SafeHtml => {
    const { draw, by } = drawer(key);
    let out: unknown;
    try {
      out = (draw as (...given: Parameters<PrintDrawers[K]>) => unknown)(...args);
    } catch (thrown) {
      if (thrown instanceof PrintThemeRefusal) {
        throw thrown;
      }
      throw new PrintThemeRefusal(`the "${key}" drawer of the "${by}" print theme threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    if (!isSafeHtml(out)) {
      throw new PrintThemeRefusal(
        `the "${key}" drawer of the "${by}" print theme returned ${typeof out === "string" ? "a raw string" : typeof out}, not printHtml markup`
      );
    }
    return out;
  };
  // The breaks go on the wrapper, which every theme draws inside, so every theme honours them.
  const wrap = (kind: string, node: PrintNode, inner: SafeHtml): SafeHtml => {
    const breaks = `${node.breakBefore ? " datum-print__break-before" : ""}${"keepTogether" in node && node.keepTogether ? " datum-print__keep-together" : ""}`;
    return printHtml`<div class="datum-print__${kind}${breaks}" data-component-id="${node.id}">${inner}</div>`;
  };
  const context: PrintContext = {
    model,
    html: printHtml,
    join: joinPrintHtml,
    heading: printHeading,
    drawAll: (nodes) => joinPrintHtml(nodes.map(drawNode))
  };
  function drawNode(node: PrintNode): SafeHtml {
    switch (node.kind) {
      case "field":
        return wrap("field", node, call("field", [node, context]));
      case "group":
        return wrap("group", node, call("group", [node, context.drawAll(node.children), context]));
      case "grid":
        return wrap("grid", node, call("grid", [node, context]));
      case "section":
        return wrap("section", node, call("section", [node, context.drawAll(node.children), context]));
      case "content":
        return wrap("content", node, call("content", [node, context]));
      case "run":
        // An unnamed group kept together: the renderer's wrapper alone, its nodes drawn by the theme.
        return wrap("run", node, context.drawAll(node.children));
    }
  }
  const title = model.title !== undefined && model.page.titleOnFirstPage ? call("title", [model.title, context]) : undefined;
  const notice = model.notice ? printHtml`<div class="datum-print__notice">${call("notice", [model.notice, context])}</div>` : undefined;
  return printHtml`<div class="datum-print datum-print--${model.rendition}">${title}${notice}${context.drawAll(model.nodes)}</div>`;
}

export interface PrintDocumentBuildOptions {
  /** The print theme; the basic one when absent. */
  theme?: PrintTheme | undefined;
  /** The host's files; linked only for a theme other than Datum's own. */
  assets?: PrintAssets | undefined;
  /** The base the host's relative URLs resolve against (the page's `baseURI`); they are linked absolute. */
  base?: string | undefined;
}

function absoluteUrl(url: string, base: string | undefined): string | undefined {
  try {
    const resolved = base ? new URL(url, base) : new URL(url);
    return resolved.protocol === "http:" || resolved.protocol === "https:" || resolved.protocol === "file:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function linksFor(assets: PrintAssets | undefined, base: string | undefined): string {
  const sources = [...(assets?.fonts ?? []), ...(assets?.stylesheets ?? [])];
  return sources
    .flatMap((source) => {
      const href = typeof source?.url === "string" ? absoluteUrl(source.url, base) : undefined;
      if (href === undefined) {
        return [];
      }
      const integrity = typeof source.integrity === "string" && source.integrity !== "" ? ` integrity="${escapePrintText(source.integrity)}" crossorigin="anonymous"` : "";
      return [`<link rel="stylesheet" href="${escapePrintText(href)}"${integrity}>`];
    })
    .join("");
}

const sheet = (css: string): string => (css.trim() === "" ? "" : `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`);

/**
 * The print document for `model`, drawn by `theme` (the basic theme for what it leaves out).
 * Throws {@link PrintThemeRefusal} when one of the theme's drawers refuses; {@link preparePrint}
 * catches that and prints with the basic theme.
 */
export function buildPrintDocument(model: PrintModel, options: PrintDocumentBuildOptions = {}): string {
  const theme = options.theme ?? basicPrintTheme;
  const body = drawPrintBody(theme, model);
  const links = OWN_THEMES.has(theme) ? "" : linksFor(options.assets, options.base);
  const basicCss = theme === basicPrintTheme ? "" : basicPrintTheme.css;
  const marginBox = theme.marginBox ?? basicPrintTheme.marginBox ?? "";
  return (
    `<!doctype html><html lang="${escapePrintText(model.lang)}" dir="${model.dir}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">` +
    `<title>${escapePrintText(model.title ?? "")}</title>${links}${sheet(basicCss)}${sheet(theme.css)}${sheet(printPageCss(model, marginBox))}</head>` +
    `<body data-print-theme="${escapePrintText(theme.id)}">${body.html}</body></html>`
  );
}

/** What a theme that does not declare its `renditions` draws. */
const DEFAULT_RENDITIONS: readonly PrintRendition[] = ["answers", "blank"];

/** A print ready to present: the document, the model it is drawn from, the theme it is drawn with, and what to do if the theme's self-check fails. */
export interface PreparedPrint {
  html: string;
  /** The print model the document is drawn from (the basic theme's when the chosen one was set aside): its rendition, page set-up, running bands and nodes. */
  model: PrintModel;
  /** The id of the theme the document is drawn with. */
  theme: string;
  /** Why the chosen theme was set aside for the basic one, when it was. */
  fellBack?: string[];
  /** The chosen theme's self-check, for the print frame to run once the document has loaded. */
  selfCheck?: (doc: Document) => readonly string[];
  /** The basic theme's document, and the model it is drawn from, for when the self-check finds problems. */
  fallback?: () => { html: string; model: PrintModel; theme: string };
}

/**
 * The document for `source` in `theme`, set aside for the basic theme when one of its drawers
 * refuses (with the reason in `fellBack`). A theme with a self-check hands it back with the basic
 * theme's document, for the print frame to check once the sheets and fonts are in.
 */
export function preparePrint(source: PrintSource, options: PrintDocumentBuildOptions = {}): PreparedPrint {
  const theme = options.theme ?? basicPrintTheme;
  const basic = (): { html: string; model: PrintModel; theme: string } => {
    const model = printModelOf(source, basicPrintTheme.texts);
    return { html: buildPrintDocument(model, { theme: basicPrintTheme }), model, theme: basicPrintTheme.id };
  };
  if (theme === basicPrintTheme) {
    return basic();
  }
  // A theme that does not declare the rendition would draw its `answers` shapes over `filled` ones.
  const renditions = theme.renditions ?? DEFAULT_RENDITIONS;
  if (!renditions.includes(source.rendition)) {
    return { ...basic(), fellBack: [`the "${theme.id}" print theme does not draw the "${source.rendition}" rendition (it declares ${renditions.map((rendition) => `"${rendition}"`).join(", ")})`] };
  }
  let html: string;
  let model: PrintModel;
  try {
    model = printModelOf(source, theme.texts);
    html = buildPrintDocument(model, { ...options, theme });
  } catch (thrown) {
    if (!(thrown instanceof PrintThemeRefusal)) {
      throw thrown;
    }
    return { ...basic(), fellBack: [thrown.message] };
  }
  const selfCheck = theme.selfCheck;
  return {
    html,
    model,
    theme: theme.id,
    ...(selfCheck
      ? {
          selfCheck: (doc: Document): readonly string[] => {
            try {
              const problems = selfCheck.call(theme, doc);
              return Array.isArray(problems) ? problems.filter((problem): problem is string => typeof problem === "string") : [];
            } catch (thrown) {
              return [`the self-check of the "${theme.id}" print theme threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`];
            }
          },
          fallback: basic
        }
      : {})
  };
}
