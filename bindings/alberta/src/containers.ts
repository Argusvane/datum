/**
 * The Alberta Design System group and data grid on the engine's contract.
 *
 * - `fieldset`: Alberta has no group component for a form (`goa-fieldset` is the public-form page
 *   container), so a named group is a native fieldset whose legend and help text are set in the
 *   design system's heading and help-text tokens (css.ts). The children, and the layout the author
 *   chose, are Datum's group's (wrapped, not copied): the children stay in Datum's shadow root, so
 *   every id, label and summary link inside reaches them as before. A group with no name is Datum's
 *   plain group.
 * - `dataGrid`: `goa-table` for the table layout (the cells' fields keep no label of their own, the
 *   column headings name them), a fieldset per row for the stacked one. The row buttons are real
 *   `goa-button`s. Rows, bounds and focus after a button are the renderer's.
 *
 * No tabs and no steps: `goa-tabs` keeps its own selection and arrow keys, and `goa-form-stepper`
 * initialises once from its children and keeps its own current step, neither of which a renderer
 * that owns the selection can drive from state. Datum's own draw them in Alberta's tokens
 * (`fallbackTokens`, css.ts), and `unsupported()` reports it.
 */
import type { AdapterEntry, GridAdapter, GridRow, GroupAdapter, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { bool, type Lit } from "./shared.js";

export function createContainers(lit: Lit, datum: LiveBinding): { fieldset: GroupAdapter; dataGrid: GridAdapter; withGrid(entry: GroupAdapter): AdapterEntry } {
  const { html, nothing, ifDefined } = lit;

  /** Datum's generic group: its layouts (stack, row, columns) around the children. */
  const datumEntry = datum.components["fieldset"];
  const datumGroup = (Array.isArray(datumEntry) ? datumEntry : datumEntry === undefined ? [] : [datumEntry]).find((adapter): adapter is GroupAdapter => adapter.kind === "group");

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "goa-fieldset-group",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        return datumGroup?.template(s, children) ?? children;
      }
      // Datum's layouts around the children, drawn as a group with no name: the legend and the hint are this fieldset's.
      const { legend: _legend, hint: _hint, hintId: _hintId, ...unnamed } = s;
      const inner = datumGroup?.template(unnamed, children) ?? children;
      const hintId = s.hint !== undefined ? s.hintId : undefined;
      const mark = s.legendMark === undefined ? "" : s.words(s.legendMark);
      return html`<fieldset class="datum-goa-group" aria-describedby=${ifDefined(hintId)}>
        <legend class=${s.hideLegend ? "datum-goa-sr-only" : "datum-goa-legend"}>${s.legend}${mark === "" ? nothing : html` <span class="datum-goa-requirement">${mark}</span>`}</legend>
        ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="datum-goa-hint">${s.hint}</div>` : nothing}
        ${inner}
      </fieldset>`;
    }
  };

  const dataGrid: GridAdapter = {
    kind: "grid",
    name: "goa-table",
    capabilities: { hideLabel: "drawn", rowNumbers: "drawn" },
    template: (s) => {
      const button = (offered: boolean, press: (() => void) | undefined, caption: string, row: Pick<GridRow, "label">, action: string) =>
        offered
          ? html`<goa-button
              type="tertiary"
              size="compact"
              variant=${action === "remove" ? "destructive" : "normal"}
              data-row-action=${action}
              disabled=${bool(press === undefined)}
              arialabel=${`${caption}, ${row.label}`}
              @click=${() => press?.()}
              >${caption}</goa-button
            >`
          : nothing;
      const buttons = (row: GridRow) => html`<div class="datum-goa-row-actions">
        ${button(s.offers.reorder, row.moveUp, s.captions.moveUp, row, "up")}${button(s.offers.reorder, row.moveDown, s.captions.moveDown, row, "down")}${button(s.offers.remove, row.remove, s.captions.remove, row, "remove")}
      </div>`;
      const add = s.offers.add
        ? html`<goa-button type="secondary" id=${s.addId} data-row-action="add" disabled=${bool(s.add === undefined)} @click=${() => s.add?.()}>${s.captions.add}</goa-button>`
        : nothing;
      const empty = s.rows.length === 0 ? html`<div class="datum-goa-hint">${s.captions.empty}</div>` : nothing;
      const error = s.errors.length > 0 ? html`<div id=${ifDefined(s.errorId)} class="datum-goa-error"><goa-icon type="warning" theme="filled" size="small"></goa-icon><span>${s.errors.join("; ")}</span></div>` : nothing;
      const legend = (hidden: boolean) =>
        s.legend === undefined ? nothing : html`<legend class=${hidden ? "datum-goa-sr-only" : "datum-goa-legend"}>${s.legend}</legend>${s.hint ? html`<div class="datum-goa-hint">${s.hint}</div>` : nothing}`;
      // `auto` leaves the layout to the form (a table while wide, stacked when narrow): goa-table cannot change with the width, and the
      // cells' labels are kept when the author left it to the form, so it is drawn stacked. A table is drawn when the author asked for one.
      if (s.layout === "table" && !s.responsive) {
        const head = s.showHeader
          ? html`<thead><tr>${s.showRowNumbers ? html`<th><span class="datum-goa-sr-only">${s.captions.actions}</span></th>` : nothing}${s.columns.map((column) => html`<th>${column.label}</th>`)}<th><span class="datum-goa-sr-only">${s.captions.actions}</span></th></tr></thead>`
          : nothing;
        return html`<fieldset class="datum-goa-group datum-goa-grid">
          ${legend(s.hideLegend)}${error}
          <goa-table width="100%">
            <table>
              ${head}
              <tbody>
                ${s.eachRow((row) => html`<tr>${s.showRowNumbers ? html`<td class="datum-goa-rownum">${row.label}</td>` : nothing}${row.cells.map((cell) => html`<td>${cell.content}</td>`)}<td>${buttons(row)}</td></tr>`)}
              </tbody>
            </table>
          </goa-table>
          ${empty}
          <div class="datum-goa-grid-add">${add}</div>
        </fieldset>`;
      }
      return html`<fieldset class="datum-goa-group datum-goa-grid datum-goa-grid--stacked">
        ${legend(s.hideLegend)}${error}${empty}
        ${s.eachRow(
          (row) => html`<fieldset class="datum-goa-group datum-goa-row"><legend class=${s.showRowNumbers ? "datum-goa-legend" : "datum-goa-sr-only"}>${row.label}</legend>${row.cells.map((cell) => cell.content)}${buttons(row)}</fieldset>`
        )}
        <div class="datum-goa-grid-add">${add}</div>
      </fieldset>`;
    }
  };

  /** A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind. */
  const withGrid = (entry: GroupAdapter): AdapterEntry => [entry, dataGrid];

  return { fieldset, dataGrid, withGrid };
}
