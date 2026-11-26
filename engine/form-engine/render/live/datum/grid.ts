/**
 * Datum's data grid and repeating section: a fieldset holding a table, whichever layout.
 * One DOM serves both: a header row naming the template's children, one row per entry with its
 * number as a row header, a cell per column and the row's buttons, then the Add button; an empty
 * grid shows its empty line in place of the table. `data-layout` says how the stylesheet draws it:
 * `table`, `stacked` (each row a card, the headings hidden), or `auto` (a table while the grid is
 * wide, stacked under the width its column count needs).
 *
 * The renderer owns the rows (keyed by the runtime's row identity), the buttons' presses, the
 * bounds, the focus after a button and the cells' labels (hidden in a table, where the column
 * heading names a cell's control); the adapter draws them. A button the grid offers but cannot
 * press now is drawn disabled; one it does not offer is not drawn. Row numbers off, the row's name
 * stays as a visually hidden span in its first cell: the buttons are described by it.
 */
import type { GridAdapter, GridColumn, GridRow, GridState } from "../contract.js";
import { html, ifDefined, nothing, ref, type TemplateResult } from "../lit.js";
import { classes, containerErrorView, legendMarkView, resolveContainerControls, styleProperty, type DatumContainerControls, type DatumContainerParts } from "./container-kit.js";

export interface DatumGridOptions {
  controls?: Partial<DatumContainerControls> | undefined;
  /** The host's part templates: the legend's mark (`labelMarks`) and the grid's own error (`errorMessage`). */
  parts?: Pick<DatumContainerParts, "labelMarks" | "errorMessage"> | undefined;
}

/** The id of a row's name, which describes the row's buttons. */
export const rowNameId = (gridId: string, index: number): string => `${gridId}__row-${index}`;

/** A column heading's required or optional marker, announced (a table heading names its column). */
function columnMark(s: GridState, column: GridColumn): TemplateResult | typeof nothing {
  const marker = s.words(column.required ? "required" : "optional");
  return marker === "" ? nothing : html` <span class=${column.required ? "datum-form__required" : "datum-form__optional"}>${marker}</span>`;
}

const ACTION_CLASS = "datum-form__button datum-form__button--secondary datum-form__button--sm datum-form__datagrid-action";

export function createDatumGridAdapter(options: DatumGridOptions = {}): GridAdapter {
  const inlineErrors = resolveContainerControls(options.controls).inlineErrors;
  return {
    kind: "grid",
    name: "datum-grid",
    // Both layouts (`layouts` left out): the table under column headings and the stacked rows.
    capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
    template(s: GridState): TemplateResult {
      const rowActions = s.offers.remove || s.offers.reorder;
      const labelId = `${s.key}__group-label`;
      const hasLegend = s.legend !== undefined;
      const described = [hasLegend ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);

      /** A row's button where the grid offers it: disabled when it cannot be pressed now. */
      const rowButton = (offered: boolean, press: (() => void) | undefined, caption: string, action: string, row: GridRow): TemplateResult | typeof nothing =>
        offered
          ? html`<button
              type="button"
              class=${ACTION_CLASS}
              part="datagrid-action"
              data-row-action=${action}
              aria-describedby=${rowNameId(s.id, row.index)}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
            >${caption}</button>`
          : nothing;

      const heads = s.columns.map(
        (column) => html`<th scope="col" class="datum-form__datagrid-colhead" data-column-id=${column.id} ${ref(styleProperty("width", column.width))}>${column.label}${columnMark(s, column)}</th>`
      );
      const head = s.showHeader
        ? html`<thead class="datum-form__datagrid-head" part="datagrid-head"
            ><tr>${s.showRowNumbers ? html`<td class="datum-form__datagrid-rownum"></td>` : nothing}${heads}${rowActions ? html`<th scope="col" class="datum-form__datagrid-colhead">${s.captions.actions}</th>` : nothing}</tr></thead
          >`
        : nothing;

      const body = s.eachRow((row) => {
        const nameId = rowNameId(s.id, row.index);
        // Row numbers off: no header cell (a hidden one would still hold a column open); the name is
        // a visually hidden span in the first cell, the buttons' description.
        const hiddenName = s.showRowNumbers ? nothing : html`<span id=${nameId} class="datum-form__datagrid-rowname">${row.label}</span>`;
        return html`<tr class="datum-form__datagrid-row" part="datagrid-row" data-row-index=${row.index}>
          ${s.showRowNumbers ? html`<th scope="row" id=${nameId} class="datum-form__datagrid-rownum" part="datagrid-rownum">${row.label}</th>` : nothing}
          ${row.cells.map(
            (cell, at) => html`<td class="datum-form__datagrid-cell" part="datagrid-cell" data-column-id=${cell.columnId} ?data-cell-group=${cell.group === true}>${at === 0 ? hiddenName : nothing}${cell.content}</td>`
          )}
          ${rowActions
            ? html`<td class="datum-form__datagrid-actions" part="datagrid-actions">${row.cells.length === 0 ? hiddenName : nothing}${rowButton(s.offers.reorder, row.moveUp, s.captions.moveUp, "up", row)}${rowButton(s.offers.reorder, row.moveDown, s.captions.moveDown, "down", row)}${rowButton(s.offers.remove, row.remove, s.captions.remove, "remove", row)}</td>`
            : nothing}
        </tr>`;
      });

      // A table forced wider than the form scrolls in its own box rather than running past the form's edge.
      const table =
        s.rows.length === 0
          ? html`<p class="datum-form__datagrid-empty" part="datagrid-empty">${s.captions.empty}</p>`
          : html`<div class="datum-form__datagrid-scroll" part="datagrid-scroll"><table class="datum-form__datagrid-table" part="datagrid-table">${head}<tbody>${body}</tbody></table></div>`;

      const add = s.offers.add
        ? html`<button
            type="button"
            id=${s.addId}
            class="datum-form__button datum-form__button--secondary datum-form__datagrid-add"
            part="datagrid-add"
            data-row-action="add"
            ?disabled=${s.add === undefined}
            @click=${() => s.add?.()}
          >${s.captions.add}</button>`
        : nothing;

      return html`<fieldset
        id=${s.id}
        class=${classes("datum-form__group", "datum-form__datagrid", ...s.classNames)}
        part="datagrid"
        data-layout=${s.responsive ? "auto" : s.layout}
        data-columns=${ifDefined(s.columns.length > 0 ? s.columns.length : undefined)}
        data-row-numbers=${s.showRowNumbers ? nothing : "hidden"}
        aria-labelledby=${hasLegend ? labelId : nothing}
        aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}
      >
        ${hasLegend ? html`<legend id=${labelId} class=${classes("datum-form__group-label", s.hideLegend && "datum-form__visually-hidden")}>${s.legend}${legendMarkView(s, options.parts)}</legend>` : nothing}
        ${hasLegend && s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="datum-form__group-description">${s.hint}</p>` : nothing}
        ${containerErrorView(s, inlineErrors, options.parts)}
        ${table}${add}
      </fieldset>`;
    }
  };
}

/** Datum's data grid. */
export const datumGridAdapter: GridAdapter = createDatumGridAdapter();
