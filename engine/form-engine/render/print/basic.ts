import { printAnswerText } from "./answer-text.js";
import type { PrintField } from "./model.js";
import { printHtml, type SafeHtml } from "./safe-html.js";
import type { PrintContext, PrintDrawers, PrintTheme } from "./theme.js";

/**
 * Datum's basic print theme: the fallback behind every other. It needs nothing from the host
 * (system fonts, black on white, drawn marks for choices). A theme that leaves a node kind out
 * gets this one's drawer for it, and when a theme's self-check fails, or one of its drawers hands
 * back anything but `printHtml` markup, the whole document is printed with this theme.
 */

/** A heading level for a node `level` deep: the title is the h1, a group directly in the form an h2. */
export function printHeadingTag(level: number): "h2" | "h3" | "h4" | "h5" | "h6" {
  return `h${Math.min(6, Math.max(2, Math.round(level) + 1))}` as "h2" | "h3" | "h4" | "h5" | "h6";
}

/** `printHtml` cannot take a tag name as a value (it would be escaped text): one template per level. */
function heading(level: number, className: string, content: SafeHtml | string): SafeHtml {
  switch (printHeadingTag(level)) {
    case "h2":
      return printHtml`<h2 class="${className}">${content}</h2>`;
    case "h3":
      return printHtml`<h3 class="${className}">${content}</h3>`;
    case "h4":
      return printHtml`<h4 class="${className}">${content}</h4>`;
    case "h5":
      return printHtml`<h5 class="${className}">${content}</h5>`;
    default:
      return printHtml`<h6 class="${className}">${content}</h6>`;
  }
}

/** A heading for a node, as a theme draws one: exported for a theme that keeps Datum's outline. */
export const printHeading = heading;

/**
 * A filled box: the paper form's box with the answer written in. It grows with its answer
 * (`min-height`, never a fixed height; a long word breaks rather than runs off) and keeps the
 * room a blank box leaves (`lines`), so an empty one is the blank form's box.
 */
function filledBox(lines: number, content: SafeHtml | string | undefined): SafeHtml {
  return printHtml`<div class="dp-lines dp-lines--filled"><div class="dp-line dp-line--filled datum-print__answer" style="--lines:${Math.max(1, Math.round(lines))}">${content}</div></div>`;
}

/** A table cell's answer; a filled cell keeps its affixes beside the value. */
function cellHtml(cell: PrintField, filled: boolean): SafeHtml | string {
  const answer = cell.answer;
  if (filled && answer.shape === "text" && !cell.empty && (answer.prefix || answer.suffix)) {
    return printHtml`${answer.prefix && printHtml`<span class="dp-affix dp-affix--before">${answer.prefix}</span>`}${answer.text}${answer.suffix && printHtml`<span class="dp-affix dp-affix--after">${answer.suffix}</span>`}`;
  }
  return cell.empty ? "" : printAnswerText(cell);
}

function answerHtml(field: PrintField, context: PrintContext): SafeHtml {
  const { model } = context;
  const blank = model.rendition === "blank";
  const filled = model.rendition === "filled";
  const answer = field.answer;
  if (answer.shape === "choices") {
    const items = answer.options.map(
      (option) =>
        printHtml`<li class="dp-choice${option.chosen ? " is-chosen" : ""}"><span class="dp-mark dp-mark--${answer.multiple ? "box" : "circle"}" aria-hidden="true"></span><span class="dp-choice__text"><span class="dp-choice__label">${option.label}</span>${option.chosen && printHtml`<span class="dp-sr"> (${model.words.chosen})</span>`}${option.hint !== undefined && printHtml`<span class="dp-hint">${option.hint}</span>`}</span></li>`
    );
    // A summary of answers says an unanswered question in words alone, without its options. Every
    // option stands on a paper form, and a lone checkbox is its own empty state: no words there.
    if (!blank && !filled && field.empty && !answer.single) {
      return printHtml`<p class="dp-answer dp-empty">${model.words.notAnswered}</p>`;
    }
    return printHtml`<ul class="dp-choices">${items}</ul>`;
  }
  if (answer.shape === "date-parts") {
    return printHtml`<div class="dp-date">${answer.parts.map(
      (part) =>
        printHtml`<span class="dp-date__part"><span class="dp-date__label">${part.label}</span><span class="dp-box dp-box--${part.size}${part.value !== undefined ? " dp-box--filled" : ""}">${part.value}</span></span>`
    )}</div>`;
  }
  if (blank) {
    const lines = answer.shape === "text" ? answer.lines : 1;
    // One element per line to write on: a ruled background renders unevenly in a PDF.
    const box = printHtml`<div class="dp-lines">${Array.from({ length: Math.max(1, lines) }, () => printHtml`<span class="dp-line"></span>`)}</div>`;
    return answer.shape === "text" && (answer.prefix || answer.suffix)
      ? printHtml`<div class="dp-affixed">${answer.prefix && printHtml`<span>${answer.prefix}</span>`}${box}${answer.suffix && printHtml`<span>${answer.suffix}</span>`}</div>`
      : box;
  }
  if (filled) {
    if (answer.shape === "files") {
      return filledBox(1, answer.names.length > 0 ? printHtml`<ul class="dp-files">${answer.names.map((name) => printHtml`<li>${name}</li>`)}</ul>` : undefined);
    }
    // An affix stays beside the box, as on the blank form; a long value never squeezes it.
    const box = filledBox(answer.shape === "text" ? answer.lines : 1, answer.shape === "text" ? answer.text : undefined);
    return answer.shape === "text" && (answer.prefix || answer.suffix)
      ? printHtml`<div class="dp-affixed">${answer.prefix && printHtml`<span>${answer.prefix}</span>`}${box}${answer.suffix && printHtml`<span>${answer.suffix}</span>`}</div>`
      : box;
  }
  if (field.empty) {
    return printHtml`<p class="dp-answer dp-empty">${model.words.notAnswered}</p>`;
  }
  if (answer.shape === "files") {
    return printHtml`<ul class="dp-files">${answer.names.map((name) => printHtml`<li>${name}</li>`)}</ul>`;
  }
  return printHtml`<p class="dp-answer datum-print__answer">${printAnswerText(field)}</p>`;
}

const drawers: PrintDrawers = {
  title: (title) => printHtml`<h1 class="dp-title">${title}</h1>`,
  notice: (notice) =>
    printHtml`<div class="dp-notice dp-notice--${notice.kind}">${
      notice.title !== undefined && printHtml`<p class="dp-notice__title"><span class="dp-sr">${notice.kindWord}</span>${notice.title}</p>`
    }${notice.message !== undefined && printHtml`<p class="dp-notice__message">${notice.message}</p>`}${
      notice.details.length > 0 && printHtml`<dl class="dp-notice__details">${notice.details.map((detail) => printHtml`<dt>${detail.label}</dt><dd>${detail.value}</dd>`)}</dl>`
    }</div>`,
  field: (field, context) => {
    const { model } = context;
    const required = field.required && model.rendition === "blank" ? printHtml`<span class="dp-req">${model.words.required}</span>` : undefined;
    const hint = field.hint !== undefined ? printHtml`<span class="dp-hint">${field.hint}</span>` : undefined;
    const note = field.note !== undefined ? printHtml`<span class="dp-hint dp-note">${field.note}</span>` : undefined;
    // A lone checkbox is its own label: the box and the words beside it.
    const label = field.answer.shape === "choices" && field.answer.single ? undefined : printHtml`<p class="dp-label">${field.label}${required}</p>`;
    return printHtml`<div class="dp-field">${label}${hint}${note}${answerHtml(field, context)}</div>`;
  },
  group: (group, children) =>
    printHtml`<section class="${group.look !== undefined ? `dp-group dp-group--${group.look}` : "dp-group"}">${group.legend !== undefined && heading(group.level, "dp-heading datum-print__keep", group.legend)}${
      group.hint !== undefined && printHtml`<p class="dp-hint datum-print__keep">${group.hint}</p>`
    }${group.note !== undefined && printHtml`<p class="dp-hint dp-note datum-print__keep">${group.note}</p>`}${children}</section>`,
  section: (section, children) =>
    printHtml`<section class="dp-section dp-section--${section.from}">${section.title !== "" && heading(section.level, "dp-heading datum-print__keep", section.title)}${
      section.description !== undefined && printHtml`<p class="dp-hint datum-print__keep">${section.description}</p>`
    }${children}</section>`,
  grid: (grid, { model }) => {
    const blank = model.rendition === "blank";
    const filled = model.rendition === "filled";
    const head = printHtml`<tr>${grid.showRowNumbers && printHtml`<th class="dp-rownum" scope="col">${model.words.rowNumber}</th>`}${grid.columns.map(
      (column) => printHtml`<th scope="col">${column.label}</th>`
    )}</tr>`;
    const body = grid.rows.map(
      (row, index) =>
        printHtml`<tr>${grid.showRowNumbers && printHtml`<th scope="row" class="dp-rownum" title="${row.label}">${index + 1}</th>`}${row.cells.map((cell) =>
          blank ? printHtml`<td class="dp-cell--blank"></td>` : printHtml`<td class="datum-print__answer">${cellHtml(cell, filled)}</td>`
        )}</tr>`
    );
    // No rows given: words on an answers print, an empty box on a filled one.
    const none = grid.rows.length > 0 ? undefined : filled ? filledBox(1, undefined) : !blank ? printHtml`<p class="dp-empty">${model.words.notAnswered}</p>` : undefined;
    return printHtml`<div class="dp-grid">${grid.legend !== undefined && heading(grid.level, "dp-heading dp-grid-title datum-print__keep", grid.legend)}${
      grid.hint !== undefined && printHtml`<p class="dp-hint datum-print__keep">${grid.hint}</p>`
    }${grid.note !== undefined && printHtml`<p class="dp-hint dp-note datum-print__keep">${grid.note}</p>`}${grid.rows.length > 0 && printHtml`<table><thead>${head}</thead><tbody>${body}</tbody></table>`}${none}</div>`;
  },
  content: (node) => printHtml`<div class="dp-content">${node.html}</div>`
};

export const basicPrintTheme: PrintTheme = Object.freeze({
  id: "basic",
  label: "Basic print",
  renditions: ["answers", "blank", "filled"] as const,
  marginBox: 'font: 9pt/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #555;',
  css: `
.datum-print { font: 11pt/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; }
.dp-title { font-size: 18pt; margin: 0 0 14pt; }
.dp-field { margin: 0 0 12pt; }
.dp-label { font-weight: 600; margin: 0 0 2pt; }
.dp-req { font-weight: 400; margin-inline-start: 4pt; }
.dp-hint { display: block; color: #444; font-size: 10pt; margin: 0 0 3pt; }
.dp-note { font-style: italic; }
.dp-answer { margin: 0; padding: 2pt 0 3pt; border-bottom: 1px solid #333; min-height: 1.2em; overflow-wrap: anywhere; }
.dp-empty { color: #555; font-style: italic; margin: 0; }
.dp-answer.dp-empty { border-bottom-style: dotted; }
.dp-lines { display: block; }
.dp-line { display: block; height: 2.2em; border-bottom: 1px solid #333; box-sizing: border-box; }
.dp-affixed { display: flex; align-items: flex-end; gap: 3pt; }
.dp-affixed .dp-lines { flex: 1; }
/* A filled form: a long value never squeezes the box below a width worth writing in, and a long affix wraps inside its share of the line rather than running off the page. A blank form keeps the plain rules above. */
.datum-print--filled .dp-affixed .dp-lines { flex: 1 1 auto; min-width: 8em; }
.datum-print--filled .dp-affixed > span { flex: 0 0 auto; max-width: 40%; overflow-wrap: break-word; }
/* A filled box grows with its answer: a minimum of the blank box's room, never a fixed height, and a long unbroken word breaks. */
.dp-line--filled { height: auto; min-height: calc(var(--lines, 1) * 2.2em); padding: 0.45em 0 0.2em; overflow-wrap: anywhere; white-space: pre-wrap; }
.dp-line--filled .dp-files { margin: 0; }
.dp-choices { list-style: none; margin: 2pt 0 0; padding: 0; }
.dp-choice { display: flex; gap: 6pt; align-items: flex-start; margin: 0 0 3pt; }
.dp-mark { flex: none; width: 10pt; height: 10pt; border: 1.2pt solid #000; margin-top: 2pt; position: relative; box-sizing: border-box; }
.dp-mark--circle { border-radius: 50%; }
.is-chosen .dp-mark--circle::after { content: ""; position: absolute; inset: 1.6pt; border-radius: 50%; background: #000; }
.is-chosen .dp-mark--box::after { content: ""; position: absolute; left: 2.6pt; top: 0.2pt; width: 3pt; height: 6pt; border: solid #000; border-width: 0 1.6pt 1.6pt 0; transform: rotate(40deg); }
.dp-choice__text { display: flex; flex-direction: column; }
.is-chosen .dp-choice__label { font-weight: 600; }
/* Not drawn, but kept in a PDF's text (a clipped box drops out of it): what a reader of the PDF hears. */
.dp-sr { position: absolute; color: transparent; white-space: nowrap; font-size: 1px; line-height: 1px; }
.dp-date { display: flex; gap: 10pt; }
.dp-date__part { display: flex; flex-direction: column; font-size: 10pt; }
.dp-box { display: block; height: 1.8em; border: 1px solid #333; width: 3.5em; }
.dp-box--4 { width: 5.5em; }
.dp-box--filled { height: auto; min-height: 1.8em; width: auto; min-width: 3.5em; padding: 0.2em 0.4em; box-sizing: border-box; overflow-wrap: anywhere; }
.dp-box--filled.dp-box--4 { min-width: 5.5em; }
.dp-affix--before { margin-inline-end: 0.15em; }
.dp-affix--after { margin-inline-start: 0.25em; }
.dp-files { margin: 0; padding-inline-start: 14pt; }
.dp-group { margin: 6pt 0 12pt; }
.dp-heading { margin: 0 0 6pt; font-size: 13pt; }
.dp-group > .dp-hint { margin-top: -3pt; margin-bottom: 8pt; }
/* A panel's look: plain is the group above. A box that splits across pages keeps its border, fill and padding on both (clone). */
.dp-group--outlined, .dp-group--shaded, .dp-group--card { padding: 8pt 10pt 2pt; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.dp-group--outlined, .dp-group--card { border: 1px solid #555; }
.dp-group--shaded { background: #eee; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.dp-group--card > .dp-heading { margin: -8pt -10pt 6pt; padding: 6pt 10pt; background: #eee; border-bottom: 1px solid #555; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.dp-section { margin: 0 0 12pt; padding-top: 6pt; border-top: 1px solid #999; }
.dp-grid { margin: 0 0 12pt; }
.dp-grid th, .dp-grid td { border: 1px solid #555; padding: 3pt 5pt; text-align: start; vertical-align: top; font-size: 10pt; }
.dp-grid th { background: #eee; }
.dp-grid td.dp-cell--blank { height: 1.8em; }
.dp-grid .dp-rownum { width: 2.5em; }
.dp-notice { border: 1px solid #333; padding: 6pt 8pt; margin: 0 0 14pt; }
.dp-notice__title { font-weight: 600; margin: 0 0 3pt; }
.dp-notice__message { margin: 0 0 3pt; }
.dp-notice__details { display: grid; grid-template-columns: max-content 1fr; gap: 2pt 10pt; margin: 0; }
.dp-notice__details dt { font-weight: 600; }
.dp-notice__details dd { margin: 0; }
`,
  draw: drawers
});

/** The basic theme's drawers, whole: what fills in for a drawer another theme leaves out. */
export const BASIC_PRINT_DRAWERS: Readonly<PrintDrawers> = drawers;
