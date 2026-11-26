/**
 * The Québec design system's containers on the engine's contract.
 *
 * - `fieldset`: the toolkit's `fieldset.qc-fieldset` with its label text as the legend and its
 *   `.qc-description` as the help. A group with no name is Datum's plain group; the layouts the
 *   author chose (stack, row, columns) are Datum's group's, wrapped and not copied.
 * - `button group`: the toolkit's `.qc-button-group`.
 * - `dataGrid`: the toolkit has a table (`qc-table`) but it clones and moves its rows for the small
 *   screen, which a table of live inputs cannot survive, and no layout of inputs in a table. So the
 *   rows are stacked: a `fieldset.qc-fieldset` per row, the cells keeping their labels, the row
 *   buttons the toolkit's `button.qc-button`. Rows, bounds and focus after a button are the
 *   renderer's.
 *
 * No tabs and no steps: the toolkit has neither. Datum's own draw them in the toolkit's tokens
 * (`fallbackTokens`, index.ts) and `unsupported()` reports it.
 */
import type { AdapterEntry, GridAdapter, GridRow, GroupAdapter, LiveBinding, View } from "../../../engine/form-engine/render/live/contract.js";
import { cls, formError, labelText, type Lit } from "./shared.js";

export function createContainers(lit: Lit, datum: LiveBinding): { fieldset: GroupAdapter; buttonGroup: GroupAdapter; dataGrid: GridAdapter; withGrid(entry: GroupAdapter): AdapterEntry } {
  const { html, nothing, ifDefined } = lit;

  /** Datum's generic group: its layouts (stack, row, columns) around the children. */
  const datumEntry = datum.components["fieldset"];
  const datumGroup = (Array.isArray(datumEntry) ? datumEntry : datumEntry === undefined ? [] : [datumEntry]).find((adapter): adapter is GroupAdapter => adapter.kind === "group");

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "qc-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        return datumGroup?.template(s, children) ?? children;
      }
      // Datum's layouts around the children, drawn as a group with no name: the legend and the hint are this fieldset's.
      const { legend: _legend, hint: _hint, hintId: _hintId, ...unnamed } = s;
      const inner = datumGroup?.template(unnamed, children) ?? children;
      return html`<fieldset class=${cls("qc-fieldset", ...s.classNames)} aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
        <legend class=${s.hideLegend ? "qc-sr-only" : nothing}>${labelText(lit, s.legend, s.legendMark === "required")}</legend>
        ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="qc-description datum-qc-group-hint">${s.hint}</div>` : nothing}
        ${inner}
      </fieldset>`;
    }
  };

  const buttonGroup: GroupAdapter = {
    kind: "group",
    name: "qc-button-group",
    capabilities: {},
    template: (s) => html`<div class=${cls("qc-button-group", ...s.classNames)}>${s.eachItem((item) => item.content)}</div>`
  };

  const dataGrid: GridAdapter = {
    kind: "grid",
    name: "qc-data-grid",
    capabilities: { hideLabel: "drawn", rowNumbers: "drawn" },
    // The toolkit draws no table of inputs: rows are stacked whatever the author chose, the cells keeping their labels.
    layouts: ["stacked"],
    template: (s) => {
      const button = (offered: boolean, press: (() => void) | undefined, caption: string, row: Pick<GridRow, "label">, action: string): View =>
        offered
          ? html`<button
              type="button"
              class=${cls("qc-button", action === "remove" ? "qc-danger" : "qc-tertiary", "qc-compact")}
              data-row-action=${action}
              aria-label=${`${caption}, ${row.label}`}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
              >${caption}</button
            >`
          : nothing;
      const buttons = (row: GridRow): View => html`<div class="qc-button-group qc-compact datum-qc-row-actions">
        ${button(s.offers.reorder, row.moveUp, s.captions.moveUp, row, "up")}${button(s.offers.reorder, row.moveDown, s.captions.moveDown, row, "down")}${button(s.offers.remove, row.remove, s.captions.remove, row, "remove")}
      </div>`;
      const add = s.offers.add
        ? html`<button type="button" id=${s.addId} class="qc-button qc-secondary qc-compact" data-row-action="add" ?disabled=${s.add === undefined} @click=${() => s.add?.()}>${s.captions.add}</button>`
        : nothing;
      const described = [s.legend !== undefined && s.hint !== undefined ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);
      return html`<fieldset id=${s.id} class=${cls("qc-fieldset", "datum-qc-grid", ...s.classNames)} aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}>
        ${s.legend !== undefined ? html`<legend class=${s.hideLegend ? "qc-sr-only" : nothing}>${labelText(lit, s.legend, s.legendMark === "required")}</legend>` : nothing}
        ${s.legend !== undefined && s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="qc-description datum-qc-group-hint">${s.hint}</div>` : nothing}
        ${formError(lit, { errors: s.errors, errorId: s.errorId })}
        ${s.rows.length === 0 ? html`<p class="qc-description">${s.captions.empty}</p>` : nothing}
        ${s.eachRow(
          (row) => html`<fieldset class="qc-fieldset datum-qc-row" data-row-index=${row.index}>
            <legend class=${s.showRowNumbers ? nothing : "qc-sr-only"}>${labelText(lit, row.label, false)}</legend>
            ${row.cells.map((cell) => cell.content)}${buttons(row)}
          </fieldset>`
        )}
        <div class="datum-qc-grid-add">${add}</div>
      </fieldset>`;
    }
  };

  /** A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind. */
  const withGrid = (entry: GroupAdapter): AdapterEntry => [entry, dataGrid];

  return { fieldset, buttonGroup, dataGrid, withGrid };
}
