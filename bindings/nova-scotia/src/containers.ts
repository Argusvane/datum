/**
 * The Nova Scotia UI Pattern Library's containers as adapters for the engine contract: the
 * fieldset group, a data grid (the library's table), the steps container (its progress tracker,
 * navigation/progress-tracker.html) and the button group.
 *
 * The library has no tabs, so a tabs container is drawn by Datum's adapter, tinted with the
 * library's colours, and reported by `unsupported()`. Every row's bounds, focus and buttons are the
 * renderer's; the adapters only draw.
 */
import type {
  GridAdapter,
  GridRow,
  GridState,
  GroupAdapter,
  GroupState,
  StepsAdapter,
  StepsState,
  StepState,
  View
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { cls, headingAt } from "./shared.js";

export function createContainers(lit: Lit) {
  const { html, ifDefined, nothing } = lit;

  /** The asterisk a labelled container's legend carries when its mark is required. */
  const requiredOf = (s: Pick<GroupState, "legendMark" | "words">): View => {
    const mark = s.legendMark === "required" ? s.words("required") : "";
    return mark === "" ? nothing : html` <abbr title=${s.words("requiredTitle")} class="datum-ns-required">${mark}</abbr>`;
  };

  // ── Fieldset ───────────────────────────────────────────────────────────────────────────────

  /** The library's fieldset (forms/form-fieldset.html): a legend over the items, a help block for the hint. */
  const fieldset: GroupAdapter = {
    kind: "group",
    name: "nova-scotia-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        // No name to read out: no element of its own unless the author gave classes.
        return s.classNames.length > 0 ? html`<div class=${cls(...s.classNames)}>${children}</div>` : children;
      }
      return html`<fieldset class=${cls("form-group", ...s.classNames)} aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
        <legend id="${s.key}__group-label" class=${s.hideLegend ? "sr-only" : nothing}>${s.legend}${requiredOf(s)}</legend>
        ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="help-block">${s.hint}</div>` : nothing}
        ${children}
      </fieldset>`;
    }
  };

  // ── Button group ───────────────────────────────────────────────────────────────────────────

  const buttonGroup: GroupAdapter = {
    kind: "group",
    name: "nova-scotia-button-group",
    capabilities: {},
    template: (s, children) => html`<div class=${cls("datum-ns-button-group", ...s.classNames)}>${children}</div>`
  };

  // ── Data grid ──────────────────────────────────────────────────────────────────────────────

  /** The id of a row's name, which describes the row's buttons. */
  const rowNameId = (gridId: string, index: number): string => `${gridId}__row-${index}`;

  /**
   * The library's table (`table table-condensed`) with the fields in its cells. The stacked layout
   * the author asks for is the same table held as blocks by the binding's css, the cells keeping the
   * labels of their own fields; a table left to the form (`responsive`) is held as blocks, with the
   * labels shown, when its box is narrow (a container query in the binding's css).
   */
  const grid: GridAdapter = {
    kind: "grid",
    name: "nova-scotia-data-grid",
    capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
    template(s: GridState): TemplateResult {
      const stacked = s.layout === "stacked";
      const actions = s.offers.remove || s.offers.reorder;
      const rowButton = (offered: boolean, press: (() => void) | undefined, caption: string, action: string, row: GridRow, variant: string): View =>
        offered
          ? html`<button
              type="button"
              class=${cls("btn", "btn-sm", variant)}
              data-row-action=${action}
              aria-describedby=${rowNameId(s.id, row.index)}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
            >${caption}</button>`
          : nothing;

      const rows = s.eachRow((row) => {
        const nameId = rowNameId(s.id, row.index);
        const labelOf = (columnId: string): string => s.columns.find((column) => column.id === columnId)?.label ?? "";
        return html`<tr data-row-index=${row.index}>
          ${s.showRowNumbers ? html`<th scope="row" id=${nameId}>${row.label}</th>` : nothing}
          ${row.cells.map((cell, at) => html`<td data-label=${labelOf(cell.columnId)} data-column-id=${cell.columnId}>${at === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="sr-only">${row.label}</span>` : nothing}${cell.content}</td>`)}
          ${actions
            ? html`<td class="datum-ns-grid-actions">${row.cells.length === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="sr-only">${row.label}</span>` : nothing}${rowButton(s.offers.reorder, row.moveUp, s.captions.moveUp, "up", row, "btn-clear")}${rowButton(s.offers.reorder, row.moveDown, s.captions.moveDown, "down", row, "btn-clear")}${rowButton(s.offers.remove, row.remove, s.captions.remove, "remove", row, "btn-danger")}</td>`
            : nothing}
        </tr>`;
      });

      const head = s.showHeader
        ? html`<thead><tr>
            ${s.showRowNumbers ? html`<td></td>` : nothing}
            ${s.columns.map((column) => html`<th scope="col" data-column-id=${column.id}>${column.label}${column.required ? requiredOf({ legendMark: "required", words: s.words }) : nothing}</th>`)}
            ${actions ? html`<th scope="col">${s.captions.actions}</th>` : nothing}
          </tr></thead>`
        : nothing;

      const described = [s.legend !== undefined && s.hint !== undefined ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);
      const invalid = s.errors.length > 0;
      // `has-error` wraps the grid's own message only: on the fieldset, saltire.css's inherited colour and its descendant rules would draw every valid cell field as an error.
      return html`<fieldset id=${s.id} class=${cls("form-group", ...s.classNames)} aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}>
        ${s.legend !== undefined ? html`<legend id="${s.key}__group-label" class=${s.hideLegend ? "sr-only" : nothing}>${s.legend}${requiredOf(s)}</legend>` : nothing}
        ${s.legend !== undefined && s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="help-block">${s.hint}</div>` : nothing}
        ${invalid && s.errorId !== undefined ? html`<div class="has-error"><div id=${s.errorId} class="help-block datum-ns-choice-error"><i class="fa fa-exclamation-circle" aria-hidden="true"></i>${s.errors.join("; ")}</div></div>` : nothing}
        ${s.rows.length === 0
          ? html`<div class="help-block">${s.captions.empty}</div>`
          : html`<div class="datum-ns-grid-box"><table class=${cls("table", "table-condensed", "datum-ns-grid", stacked && "datum-ns-grid--stacked", s.responsive && "datum-ns-grid--auto")}>${head}<tbody>${rows}</tbody></table></div>`}
        ${s.offers.add
          ? html`<button
              type="button"
              id=${s.addId}
              class="btn btn-clear"
              data-row-action="add"
              ?disabled=${s.add === undefined}
              @click=${() => s.add?.()}
            >${s.captions.add}</button>`
          : nothing}
      </fieldset>`;
    }
  };

  // ── Steps ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The library's progress tracker (navigation/progress-tracker.html), a pagination list: the step
   * shown is `active`, one that can be opened a link, the others `disabled`. The panel under it
   * keeps the heading the renderer moves focus to, read in full ("Step 2 of 3: Name").
   */
  const steps: StepsAdapter = {
    kind: "steps",
    name: "nova-scotia-steps",
    capabilities: { hideLabel: "drawn" },
    template(s: StepsState): TemplateResult {
      const panel = (step: StepState, index: number): TemplateResult => html`<section
        class=${cls("datum-ns-step-panel", ...step.classNames)}
        data-step-panel=${step.id}
        data-step-container=${s.id}
        aria-labelledby=${step.headingId}
        ?hidden=${!step.shown}
      >${headingAt(lit, s.level + 1, { id: step.headingId, className: step.hideLabel ? "sr-only" : "", focusable: true }, `${s.words("stepOf", { n: index + 1, total: s.steps.length })}${s.words("stepTagSeparator")}${step.label}`)}${step.content}</section>`;
      const panels = html`<div class="datum-ns-step-panels">${s.eachStep((step) => panel(step, s.steps.indexOf(step)))}${s.others}</div>`;
      const root = cls("datum-ns-steps", ...s.classNames);
      if (s.flat || s.steps.length === 0) {
        return html`<div class=${root} data-step-container=${s.id}>${panels}</div>`;
      }
      const item = (step: StepState): TemplateResult => {
        const word = step.statusText !== "" ? html` <span class="sr-only">${step.statusText}</span>` : nothing;
        if (step.status === "active") {
          return html`<li class="active" data-step-status=${step.status}><span aria-current="step">${step.label}${word}</span></li>`;
        }
        if (step.select !== undefined) {
          return html`<li data-step-status=${step.status}><a href="#${step.headingId}" @click=${(event: Event) => {
            event.preventDefault();
            step.select?.();
          }}>${step.label}${word}</a></li>`;
        }
        return html`<li class="disabled" data-step-status=${step.status}><span>${step.label}${word}</span></li>`;
      };
      return html`<div class=${root} data-step-container=${s.id} data-step-active=${ifDefined(s.activeStepId ?? "")}>
        <nav class="datum-ns-steps-indicator" data-step-indicator aria-label=${s.progress}>
          <ul class="pagination">${s.steps.map(item)}</ul>
        </nav>
        ${panels}
        <div class="datum-ns-actions">
          ${s.back ? html`<button type="button" class="btn btn-clear" data-step-prev data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.back?.go()}>${s.back.label}</button>` : nothing}
          ${s.next ? html`<button type="button" class="btn btn-default" data-step-next data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.next?.go()}>${s.next.label}</button>` : nothing}
        </div>
      </div>`;
    }
  };

  return { fieldset, buttonGroup, grid, steps };
}
