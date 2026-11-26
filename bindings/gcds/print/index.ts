/**
 * The GC Design System print theme: the worked example of a design system's paper.
 *
 * Print never runs a design system's JavaScript. GC Design System's components are Stencil
 * elements whose styles live in their shadow roots, so a page that printed them would have to load
 * the components and wait for each to hydrate inside the print frame (measured: none of five had
 * hydrated when `print()` fires), and a hydrated gcds-textarea cuts a long answer off and a
 * gcds-radios splits across pages. What GC Design System ships without script is its stylesheet
 * (gcds.css): every token (`--gcds-*`) and its fonts. This theme is a pure function of the print
 * model to static markup that restates what each component draws (label, hint, input, radio,
 * checkbox, fieldset legend, heading, table) from those tokens, the way each component's own
 * shadow CSS does, so a host that moves to a new release moves the paper with it.
 *
 * The host gives print the same stylesheet it gives the binding (gcds.css): the renderer links
 * stylesheets and fonts into the print document and never scripts. The self-check requires every
 * token `tokens.json` lists; when one is absent (no stylesheet given) the whole document prints
 * with the basic theme and `datum-print` reports `fellBack`.
 *
 * Not drawn by this theme (the basic theme's drawers stand in): the host's receipt. GC Design
 * System publishes no print tokens: `html { font-size: 75% }` scales its rem tokens for paper, a
 * choice of Datum's. Ten of the model's twelve parts equal the real components; the legend and
 * the chosen radio's dot differ (GC Design System inherits the page's black there, this theme
 * uses its secondary text token).
 */
import type { FormTextCatalog } from "../../../engine/form-engine/core/localization/form-texts.js";
import type { PrintContext, PrintField, PrintHtmlValue, PrintTheme } from "../../../engine/form-engine/render/print/index.js";
import contract from "../tokens.json" with { type: "json" };

/** GC Design System sizes a group's legend by heading level (the live binding: legend-size h{level+1}). */
const size = (level: number): number => Math.min(6, Math.max(2, Math.round(level) + 1));

/** A field's answer as one line, for a table cell. */
function answerText(field: PrintField): string {
  const answer = field.answer;
  if (answer.shape === "text") {
    return answer.text;
  }
  if (answer.shape === "choices") {
    return answer.options.filter((option) => option.chosen).map((option) => option.label).join(", ");
  }
  if (answer.shape === "files") {
    return answer.names.join(", ");
  }
  // A filled date as the language words it on one line (its parts are the boxes' words).
  return answer.text ?? "";
}

/** A filled box: GC Design System's input with the answer written in, grown to it (never a fixed height). */
function filledBox(context: PrintContext, lines: number, content: PrintHtmlValue) {
  const { html } = context;
  return html`<div class="gp-box gp-box--filled datum-print__answer" style="${`--lines:${Math.max(1, Math.round(lines))}`}">${content}</div>`;
}

/** A table cell's answer; a filled cell keeps its affixes beside the value. */
function cellHtml(cell: PrintField, context: PrintContext, filled: boolean) {
  const { html } = context;
  const answer = cell.answer;
  if (filled) {
    if (cell.empty) {
      return "";
    }
    if (answer.shape === "text" && (answer.prefix || answer.suffix)) {
      return html`${answer.prefix && html`<span class="gp-affix-inline gp-affix-inline--before">${answer.prefix}</span>`}${answer.text}${answer.suffix && html`<span class="gp-affix-inline gp-affix-inline--after">${answer.suffix}</span>`}`;
    }
    return answerText(cell);
  }
  return cell.empty ? html`<span class="gp-empty">—</span>` : answerText(cell);
}

function answerHtml(field: PrintField, context: PrintContext) {
  const { html, model } = context;
  const blank = model.rendition === "blank";
  const filled = model.rendition === "filled";
  const answer = field.answer;
  if (answer.shape === "choices") {
    const kind = answer.multiple ? "checkbox" : "radio";
    const items = answer.options.map(
      (option) =>
        html`<li class="${`gp-choice gp-choice--${kind}${option.chosen ? " is-chosen" : ""}`}"><span class="gp-choice__label">${option.label}</span>${option.chosen && html`<span class="gp-sr"> (${model.words.chosen})</span>`}${option.hint !== undefined && html`<span class="gp-choice__hint">${option.hint}</span>`}</li>`
    );
    // A summary of answers says an unanswered question in words alone, without its options. Every
    // option stands on a paper form, and a lone checkbox is its own empty state: no words there.
    if (!blank && !filled && field.empty && !answer.single) {
      return html`<div class="gp-answer gp-answer--empty">${model.words.notAnswered}</div>`;
    }
    return html`<ul class="gp-choices">${items}</ul>`;
  }
  if (answer.shape === "date-parts") {
    return html`<div class="gp-date">${answer.parts.map((part) => html`<div class="${`gp-date__part gp-date__part--${part.part}`}"><span class="gp-date__label">${part.label}</span><span class="${`gp-box${part.value !== undefined ? " gp-box--filled" : ""}`}">${part.value}</span></div>`)}</div>`;
  }
  if (blank) {
    const lines = answer.shape === "text" ? answer.lines : 1;
    const box = html`<div class="gp-box gp-box--write" style="${`--lines:${Math.max(1, Math.round(lines))}`}"></div>`;
    // A sign or a unit beside the box, as the live field draws it.
    return answer.shape === "text" && (answer.prefix || answer.suffix)
      ? html`<div class="gp-affixed">${answer.prefix && html`<span class="gp-affix">${answer.prefix}</span>`}${box}${answer.suffix && html`<span class="gp-affix">${answer.suffix}</span>`}</div>`
      : box;
  }
  if (filled) {
    if (answer.shape === "files") {
      return filledBox(context, 1, answer.names.length > 0 ? html`<ul class="gp-files">${answer.names.map((name) => html`<li>${name}</li>`)}</ul>` : undefined);
    }
    const box = filledBox(context, answer.shape === "text" ? answer.lines : 1, answer.shape === "text" ? answer.text : undefined);
    // A sign or a unit beside the box, as the blank form draws it; a long value never squeezes it.
    return answer.shape === "text" && (answer.prefix || answer.suffix)
      ? html`<div class="gp-affixed">${answer.prefix && html`<span class="gp-affix">${answer.prefix}</span>`}${box}${answer.suffix && html`<span class="gp-affix">${answer.suffix}</span>`}</div>`
      : box;
  }
  if (field.empty) {
    return html`<div class="gp-answer gp-answer--empty">${model.words.notAnswered}</div>`;
  }
  if (answer.shape === "files") {
    return html`<ul class="gp-answer gp-files">${answer.names.map((name) => html`<li>${name}</li>`)}</ul>`;
  }
  return html`<div class="gp-answer datum-print__answer">${answerText(field)}</div>`;
}

export const gcdsPrintTheme: PrintTheme = {
  id: "gcds-print",
  label: "GC Design System (print)",
  renditions: ["answers", "blank", "filled"] as const,
  // The page-margin boxes inherit nothing from the page: GC Design System's body face.
  // A custom property does not reach a margin box, so the colour is GC Design System's secondary text (#333 on white, #595959 for the running line), restated.
  marginBox: 'font: 400 8pt/1.2 "Noto Sans", sans-serif; color: #595959;',
  texts: {
    // GC Design System marks the required fields, in words, after the label (gcds-label).
    required: { default: "(required)", locales: { fr: "(obligatoire)" } }
  } satisfies FormTextCatalog as FormTextCatalog,
  css: `
/* Paper scale: every GC Design System token is in rem, so one root size scales them all together
   (text 1.25rem prints at 15px, the h1 at 31px). The tokens' desktop values are what print media
   gets anyway: the components' mobile rules are "only screen". */
html { font-size: 75%; }
/* gcds.css fades the body in from transparent; paper must not start mid-fade. */
body { animation: none !important; opacity: 1 !important; }
.datum-print { color: var(--gcds-text-primary); font: var(--gcds-font-text); max-width: 100%; }
/* Not drawn, but kept in the PDF's text (a clipped box is dropped from it): what a reader of the PDF hears for a chosen option. */
.gp-sr { position: absolute; color: transparent; white-space: nowrap; font-size: 1px; line-height: 1px; }

/* gcds-heading h1: Lato, its red bar under it. */
.gp-title { font: var(--gcds-heading-h1-desktop); color: var(--gcds-heading-default-text); margin: 0 0 var(--gcds-heading-spacing-400); text-wrap: balance; max-width: var(--gcds-heading-character-limit-h1); }
.gp-title::after { content: ""; display: block; background-color: var(--gcds-heading-h1-border-background); height: var(--gcds-heading-h1-border-height); width: var(--gcds-heading-h1-border-width); margin-block-start: var(--gcds-heading-h1-border-margin); }
.gp-heading { color: var(--gcds-heading-default-text); margin: var(--gcds-heading-spacing-300) 0 var(--gcds-spacing-300); text-wrap: balance; }
.gp-heading--2 { font: var(--gcds-heading-h2-desktop); }
.gp-heading--3 { font: var(--gcds-heading-h3-desktop); }
.gp-heading--4 { font: var(--gcds-heading-h4-desktop); }
.gp-heading--5 { font: var(--gcds-heading-h5-desktop); }
.gp-heading--6 { font: var(--gcds-heading-h6-desktop); }

/* gcds-label and gcds-hint. */
.gp-label { color: var(--gcds-label-text); font: var(--gcds-label-font-desktop); margin: var(--gcds-label-margin); }
.gp-req { font-weight: var(--gcds-label-required-font-weight); margin: var(--gcds-label-required-margin); }
.gp-hint { color: var(--gcds-hint-text); font: var(--gcds-text-size-body-desktop); margin: var(--gcds-hint-margin); }
.gp-note { font-style: italic; }

/* gcds-input / gcds-textarea, read: the box as the component draws it, grown to its answer. */
.gp-answer, .gp-box { box-sizing: border-box; display: block; color: var(--gcds-input-default-text); background: var(--gcds-input-default-background);
  border: var(--gcds-input-border-width) solid; border-radius: var(--gcds-input-border-radius); font: var(--gcds-input-font-desktop);
  padding: var(--gcds-input-padding); min-height: var(--gcds-input-min-width-and-height); max-width: 75ch; width: 100%; margin: var(--gcds-input-margin); overflow-wrap: anywhere; }
/* Filled: the write-in box with the answer in it. It grows with the answer (a minimum of the room the blank box leaves, never a fixed height), keeps its line breaks, and a long unbroken word breaks. */
.gp-box--filled { min-height: calc(var(--lines, 1) * 1.6em + 2 * var(--gcds-input-padding) + 2 * var(--gcds-input-border-width)); white-space: pre-wrap; }
.gp-box--filled .gp-files { list-style: none; margin: 0; padding: 0; }
.gp-answer--empty, .gp-empty { color: var(--gcds-text-secondary); }
.gp-box--write { height: calc(var(--lines) * 1.6em + 2 * var(--gcds-input-padding) + 2 * var(--gcds-input-border-width)); }
.gp-files { list-style: none; }
.gp-affixed { display: flex; align-items: stretch; max-width: 75ch; margin: var(--gcds-input-margin); }
.gp-affixed .gp-box { margin: 0; flex: 1; }
/* A filled form: a long value never squeezes the box below a width worth writing in, and a long affix wraps inside its share of the line rather than running off the page. A blank form keeps the plain rules above. */
.datum-print--filled .gp-affixed .gp-box { flex: 1 1 auto; min-width: 8em; }
.datum-print--filled .gp-affix { flex: 0 0 auto; max-width: 40%; overflow-wrap: break-word; }
.gp-affix-inline--before { margin-inline-end: 0.15em; }
.gp-affix-inline--after { margin-inline-start: 0.25em; }
.gp-affix { display: flex; align-items: center; padding: 0 var(--gcds-spacing-100); font: var(--gcds-input-font-desktop); border: var(--gcds-input-border-width) solid; background: var(--gcds-color-grayscale-100); }
.gp-affix:first-child { border-inline-end: 0; }
.gp-affix:last-child { border-inline-start: 0; }
.gp-empty { font: var(--gcds-text-size-body-desktop); margin: 0 0 var(--gcds-spacing-200); }

/* gcds-radios / gcds-checkboxes: the legend, then each choice with its drawn mark. */
.gp-field--choices > .gp-label { font: var(--gcds-radio-legend-font-desktop); margin: var(--gcds-radio-legend-margin); }
.gp-field--choices > .gp-label:not(:has(+ .gp-hint)) { margin: var(--gcds-radio-legend-hint-margin); }
.gp-field--choices > .gp-hint { margin: var(--gcds-radio-hint-margin); }
.gp-choices { list-style: none; margin: 0 0 var(--gcds-spacing-300); padding: 0; }
.gp-choice { position: relative; color: var(--gcds-radio-default-text); font: var(--gcds-radio-font); margin: var(--gcds-radio-margin);
  max-width: var(--gcds-radio-max-width); min-height: calc(var(--gcds-radio-input-height-and-width) - var(--gcds-radio-padding));
  padding: var(--gcds-radio-padding) 0 0 3.75rem; }
.gp-choice__label { display: block; font: var(--gcds-radio-label-font-desktop); }
.gp-choice__hint { display: block; color: var(--gcds-hint-text); }
.gp-choice::before, .gp-choice::after { content: ""; position: absolute; box-sizing: border-box; }
.gp-choice::before { left: 0; top: 0; width: var(--gcds-radio-input-height-and-width); height: var(--gcds-radio-input-height-and-width);
  background-color: var(--gcds-radio-default-background); border: var(--gcds-radio-input-border-width) solid; }
.gp-choice--radio::before { border-radius: var(--gcds-radio-border-radius); }
.gp-choice--checkbox::before { border-radius: var(--gcds-checkbox-input-border-radius); border-width: var(--gcds-checkbox-input-border-width);
  width: var(--gcds-checkbox-input-height-and-width); height: var(--gcds-checkbox-input-height-and-width); }
.gp-choice--radio.is-chosen::after { border-radius: var(--gcds-radio-border-radius); background-color: currentcolor;
  width: var(--gcds-radio-check-height-and-width); height: var(--gcds-radio-check-height-and-width); left: var(--gcds-radio-check-left); top: var(--gcds-radio-check-top); }
.gp-choice--checkbox.is-chosen::after { border: var(--gcds-checkbox-check-border-width) solid; border-block-start: 0; border-inline-start: 0;
  width: var(--gcds-checkbox-check-width); height: var(--gcds-checkbox-check-height); left: var(--gcds-checkbox-check-left); top: var(--gcds-checkbox-check-top); transform: rotate(40deg); }

/* gcds-date-input, blank: the parts in the order the language writes them, labelled. */
.gp-date { display: flex; gap: var(--gcds-date-input-margin); margin: 0 0 var(--gcds-spacing-300); }
.gp-date__part { display: flex; flex-direction: column; }
.gp-date__label { font: var(--gcds-date-input-label-font-desktop); margin: var(--gcds-label-margin); }
.gp-date .gp-box { margin: 0; width: 4.5rem; }
.gp-date__part--year .gp-box { width: 6.5rem; }
.gp-date__part--month .gp-box { width: 6.5rem; }
/* Filled: a month's name, a long part, widens its box; the box is never narrower than the blank one. */
.gp-date .gp-box--filled { width: auto; min-width: 4.5rem; min-height: var(--gcds-input-min-width-and-height); }
.gp-date__part--year .gp-box--filled, .gp-date__part--month .gp-box--filled { min-width: 6.5rem; }

/* gcds-fieldset: Lato legend sized by nesting. */
.gp-group { margin: 0 0 var(--gcds-spacing-300); color: var(--gcds-fieldset-default-text); }
.gp-legend { margin: var(--gcds-fieldset-legend-margin); }
.gp-legend--2 { font: var(--gcds-fieldset-legend-size-h2-desktop); }
.gp-legend--3 { font: var(--gcds-fieldset-legend-size-h3-desktop); }
.gp-legend--4 { font: var(--gcds-fieldset-legend-size-h4-desktop); }
.gp-legend--5 { font: var(--gcds-fieldset-legend-size-h5-desktop); }
.gp-legend--6 { font: var(--gcds-fieldset-legend-size-h6-desktop); }
.gp-group > .gp-hint { margin: var(--gcds-spacing-50) 0 var(--gcds-spacing-300); }
/* A panel's look, from the tokens the live binding's looks use. Plain is the group above. A box that splits across pages keeps its border, fill and padding on both (clone). */
.gp-group--outlined, .gp-group--shaded, .gp-group--card { padding: var(--gcds-spacing-300) var(--gcds-spacing-400) var(--gcds-spacing-100); border-radius: var(--gcds-border-radius-md); -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.gp-group--outlined, .gp-group--card { border: var(--gcds-border-width-sm) solid var(--gcds-border-default); }
.gp-group--shaded { background: var(--gcds-bg-light); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.gp-group--card > .gp-legend { margin: calc(-1 * var(--gcds-spacing-300)) calc(-1 * var(--gcds-spacing-400)) var(--gcds-spacing-300); padding: var(--gcds-spacing-200) var(--gcds-spacing-400); background: var(--gcds-bg-light); border-bottom: var(--gcds-border-width-sm) solid var(--gcds-border-default); border-radius: var(--gcds-border-radius-md) var(--gcds-border-radius-md) 0 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* A journey page, a step or a tab: a heading, as the live binding's page heading (gcds-heading). */
.gp-section { margin: 0 0 var(--gcds-spacing-400); }
.gp-section + .gp-section { border-top: var(--gcds-border-width-sm) solid var(--gcds-border-default); padding-top: var(--gcds-spacing-100); }

/* gcds-table: its tokens (GC Design System has no table of inputs; on paper a grid is a table). */
.gp-table { font: var(--gcds-table-font); color: var(--gcds-text-primary); margin: 0 0 var(--gcds-spacing-300); }
.gp-table th, .gp-table td { text-align: start; vertical-align: top; padding: var(--gcds-table-cell-padding-desktop); border-bottom: var(--gcds-table-border-width) solid var(--gcds-table-cell-border-color); }
.gp-table thead th { font-weight: var(--gcds-table-header-cell-font-weight); border-bottom: var(--gcds-table-header-cell-border-width) solid var(--gcds-table-header-cell-border-color); }
.gp-table tbody th { font-weight: var(--gcds-table-header-cell-font-weight); }
/* A fixed table takes its widths from the head row: the number column is set there. */
.gp-table .gp-rownum { width: 3rem; }
.gp-table td.gp-cell--blank { height: 2.5rem; border: var(--gcds-table-border-width) solid var(--gcds-table-cell-border-color); }
`,
  draw: {
    title: (title, { html }) => html`<h1 class="gp-title">${title}</h1>`,
    field: (field, context) => {
      const { html, model } = context;
      const required = field.required && model.rendition === "blank" ? html`<span class="gp-req">${model.words.required}</span>` : undefined;
      const choices = field.answer.shape === "choices" || field.answer.shape === "date-parts";
      // A lone checkbox is its own label: the mark and the words beside it.
      const lone = field.answer.shape === "choices" && field.answer.single;
      const label = lone ? undefined : html`<p class="gp-label">${field.label}${required}</p>`;
      return html`<div class="${`gp-field${choices ? " gp-field--choices" : ""}`}">${label}${field.hint !== undefined && html`<p class="gp-hint">${field.hint}</p>`}${field.note !== undefined && html`<p class="gp-hint gp-note">${field.note}</p>`}${answerHtml(field, context)}</div>`;
    },
    group: (group, children, { html, heading }) => {
      const n = size(group.level);
      return html`<section class="${group.look !== undefined ? `gp-group gp-group--${group.look}` : "gp-group"}">${group.legend !== undefined && heading(group.level, `gp-legend gp-legend--${n} datum-print__keep`, group.legend)}${group.hint !== undefined && html`<p class="gp-hint datum-print__keep">${group.hint}</p>`}${group.note !== undefined && html`<p class="gp-hint gp-note datum-print__keep">${group.note}</p>`}${children}</section>`;
    },
    section: (section, children, { html, heading }) => {
      const n = size(section.level);
      return html`<section class="gp-section">${section.title !== "" && heading(section.level, `gp-heading gp-heading--${n} datum-print__keep`, section.title)}${section.description !== undefined && html`<p class="gp-hint datum-print__keep">${section.description}</p>`}${children}</section>`;
    },
    grid: (grid, context) => {
      const { html, model, heading } = context;
      const n = size(grid.level);
      const blank = model.rendition === "blank";
      const filled = model.rendition === "filled";
      const head = html`<tr>${grid.showRowNumbers && html`<th scope="col" class="gp-rownum"><span class="gp-sr">${model.words.rowNumber}</span></th>`}${grid.columns.map((column) => html`<th scope="col">${column.label}${blank && column.required && html` <span class="gp-req">${model.words.required}</span>`}</th>`)}</tr>`;
      const rows = grid.rows.map(
        (row, index) =>
          html`<tr>${grid.showRowNumbers && html`<th scope="row" class="gp-rownum" title="${row.label}">${index + 1}</th>`}${row.cells.map((cell) => (blank ? html`<td class="gp-cell--blank"></td>` : html`<td class="datum-print__answer">${cellHtml(cell, context, filled)}</td>`))}</tr>`
      );
      // No rows given: words on an answers print, an empty box on a filled one.
      const none = grid.rows.length > 0 ? undefined : filled ? filledBox(context, 1, undefined) : !blank ? html`<p class="gp-empty">${model.words.notAnswered}</p>` : undefined;
      return html`<section class="gp-group">${grid.legend !== undefined && heading(grid.level, `gp-legend gp-legend--${n} datum-print__keep`, grid.legend)}${grid.hint !== undefined && html`<p class="gp-hint datum-print__keep">${grid.hint}</p>`}${grid.note !== undefined && html`<p class="gp-hint gp-note datum-print__keep">${grid.note}</p>`}${grid.rows.length > 0 && html`<table class="gp-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`}${none}</section>`;
    },
    content: (node, { html }) => html`<div class="gp-content">${node.html}</div>`
  },
  selfCheck(doc) {
    const style = doc.defaultView?.getComputedStyle(doc.documentElement);
    // The token contract: every token tokens.json lists must be defined where the document is drawn.
    const missing = style ? contract.tokens.filter((entry) => style.getPropertyValue(entry.name).trim() === "").map((entry) => entry.name) : contract.tokens.map((entry) => entry.name);
    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(`GC Design System's tokens are not in the document (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? `, and ${missing.length - 3} more` : ""}): give the print theme the stylesheet the binding has (gcds.css)`);
    }
    // Fonts are a warning, not a fallback: the look holds in the fallback faces, only the type changes.
    for (const face of ['600 15px "Noto Sans"', '700 15px "Lato"']) {
      if (doc.fonts && !doc.fonts.check(face)) {
        console.warn(`[gcds-print] ${face} did not load; printing in a fallback face.`);
      }
    }
    return problems;
  }
};
