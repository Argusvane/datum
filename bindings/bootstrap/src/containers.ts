/**
 * Bootstrap's containers as adapters for the engine contract: the fieldset group, tabs (`nav-tabs`),
 * a data grid (`table`, or one `card` per row), the steps container (`nav-pills` as the indicator)
 * and the button group.
 *
 * Bootstrap's tabs, and its collapse and the like, are driven by its script from `data-bs-*`
 * attributes it finds through `document`, which a shadow root hides, so the markup here carries
 * none: the strip is `nav nav-tabs` of `role=tab` buttons and the renderer
 * shows the tab, runs the arrow keys, Home and End and opens a tab for an error
 * (`behaviour.keyboard: "renderer"`). Every row's bounds, focus and buttons are the renderer's
 * too. Bootstrap has no stepper: the indicator is `nav-pills` (the shown step the active pill),
 * and the panel under it keeps the heading the renderer moves focus to.
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
  TabsAdapter,
  TabsState,
  View
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { cls } from "./fields.js";

export function createContainers(lit: Lit) {
  const { html, ifDefined, nothing } = lit;

  /** A heading of `level`, clamped to what HTML has. */
  const heading = (level: number, props: { id?: string | undefined; className: string; focusable?: boolean }, content: View | string): TemplateResult => {
    const id = ifDefined(props.id);
    const tabindex = props.focusable === true ? "-1" : nothing;
    switch (Math.min(6, Math.max(1, Math.round(level)))) {
      case 1:
        return html`<h1 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h1>`;
      case 2:
        return html`<h2 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h2>`;
      case 3:
        return html`<h3 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h3>`;
      case 4:
        return html`<h4 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h4>`;
      case 5:
        return html`<h5 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h5>`;
      default:
        return html`<h6 id=${id} class=${props.className} tabindex=${tabindex}>${content}</h6>`;
    }
  };

  /** The mark a labelled container's legend carries when it is required (the form's word, `text-danger`). */
  const requiredOf = (s: Pick<GroupState, "legendMark" | "words">): View => {
    const mark = s.legendMark === "required" ? s.words("required") : "";
    return mark === "" ? nothing : html` <span class="text-danger" aria-hidden="true">${mark}</span>`;
  };

  /** Legend sizes by how deep the group sits: a top-level group is a heading size, a nested one a bold line. */
  const legendSize = (level: number): string => (level <= 1 ? "fs-5 mb-1" : "fs-6 fw-semibold mb-1");

  // ── Fieldset ───────────────────────────────────────────────────────────────────────────────

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "bootstrap-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        // No name to read out: no element of its own unless the author gave classes.
        return s.classNames.length > 0 ? html`<div class=${cls(...s.classNames)}>${children}</div>` : children;
      }
      return html`<fieldset class=${cls("mb-3", ...s.classNames)} aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
        <legend id="${s.key}__group-label" class=${s.hideLegend ? "visually-hidden" : legendSize(s.level)}>${s.legend}${requiredOf(s)}</legend>
        ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="form-text mt-0 mb-3">${s.hint}</div>` : nothing}
        ${children}
      </fieldset>`;
    }
  };

  // ── Button group ───────────────────────────────────────────────────────────────────────────
  // Bootstrap's `btn-group` joins buttons and expects them as its direct children; each button here
  // is the renderer's field, so the buttons stand apart in a spaced row, as a form's actions do.

  const buttonGroup: GroupAdapter = {
    kind: "group",
    name: "bootstrap-button-group",
    capabilities: {},
    template: (s) => html`<ul class=${cls("list-unstyled", "d-flex", "flex-wrap", "gap-2", "mb-3", ...s.classNames)}>${s.eachItem((item) => html`<li>${item.content}</li>`)}</ul>`
  };

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────

  const tabs: TabsAdapter = {
    kind: "tabs",
    name: "bootstrap-tabs",
    capabilities: { hideLabel: "drawn" },
    behaviour: { keyboard: "renderer" },
    template(s: TabsState): TemplateResult {
      const legendId = `${s.key}__name`;
      const legend = s.legend !== undefined ? html`<p id=${legendId} class=${cls("fw-semibold", "mb-2", s.hideLegend && "visually-hidden")}>${s.legend}</p>` : nothing;

      if (s.flat) {
        // A review or a print: every tab as a headed section.
        return html`<div class=${cls("datum-bs-tabs", ...s.classNames)}>
          ${legend}${s.tabs.map((tab) => html`<section id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id} aria-labelledby="${tab.panelId}__heading">${heading(s.level + 1, { id: `${tab.panelId}__heading`, className: "h5" }, tab.label)}${tab.content}</section>`)}
        </div>`;
      }

      return html`<div class=${cls("datum-bs-tabs", ...s.classNames)}>
        ${legend}
        <ul class="nav nav-tabs" role="tablist" aria-labelledby=${ifDefined(s.legend !== undefined ? legendId : undefined)}>
          ${s.tabs.map(
            (tab) => html`<li class="nav-item" role="presentation">
              <button
                type="button"
                role="tab"
                class=${cls("nav-link", tab.selected && "active")}
                id=${tab.tabId}
                aria-controls=${tab.panelId}
                aria-selected=${tab.selected ? "true" : "false"}
                tabindex=${tab.selected ? "0" : "-1"}
                data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
                data-tab-select=${tab.slotId}
                data-tab-container=${s.id}
                @click=${() => tab.select()}
              >${tab.label}${tab.errorCount > 0 ? html` <span class="badge rounded-pill text-bg-danger" data-tab-error>${s.words.plural("tabHasErrors", tab.errorCount, { count: tab.errorCount })}</span>` : nothing}</button>
            </li>`
          )}
        </ul>
        <div class="tab-content pt-3">
          ${s.tabs.map(
            (tab) => html`<div
              class=${cls("tab-pane", tab.selected && "active")}
              id=${tab.panelId}
              role="tabpanel"
              aria-labelledby=${tab.tabId}
              data-tab-panel=${tab.slotId}
              data-tab-container=${s.id}
              ?hidden=${!tab.selected}
            >${tab.content}</div>`
          )}
        </div>
      </div>`;
    }
  };

  // ── Data grid ──────────────────────────────────────────────────────────────────────────────

  /** The id of a row's name, which describes the row's buttons. */
  const rowNameId = (gridId: string, index: number): string => `${gridId}__row-${index}`;

  /**
   * Bootstrap's `table` (in `table-responsive`, its own answer to a narrow screen) with the fields
   * in its cells under the column headings; the stacked layout is one `card` per row, the cells
   * keeping the labels of their own fields.
   */
  const grid: GridAdapter = {
    kind: "grid",
    name: "bootstrap-data-grid",
    capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
    template(s: GridState): TemplateResult {
      const stacked = s.layout === "stacked";
      const actions = s.offers.remove || s.offers.reorder;
      const rowButton = (offered: boolean, press: (() => void) | undefined, caption: string, action: string, row: GridRow, tone: string): View =>
        offered
          ? html`<button
              type="button"
              class=${`btn btn-sm ${tone}`}
              data-row-action=${action}
              aria-describedby=${rowNameId(s.id, row.index)}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
            >${caption}</button>`
          : nothing;
      const buttons = (row: GridRow): View =>
        html`${rowButton(s.offers.reorder, row.moveUp, s.captions.moveUp, "up", row, "btn-outline-secondary")}${rowButton(s.offers.reorder, row.moveDown, s.captions.moveDown, "down", row, "btn-outline-secondary")}${rowButton(s.offers.remove, row.remove, s.captions.remove, "remove", row, "btn-outline-danger")}`;

      const rows = s.eachRow((row) => {
        const nameId = rowNameId(s.id, row.index);
        if (stacked) {
          return html`<fieldset class="card card-body mb-3" data-row-index=${row.index}>
            <legend id=${nameId} class=${s.showRowNumbers ? "fs-6 fw-semibold mb-2" : "visually-hidden"}>${row.label}</legend>
            ${row.cells.map((cell) => cell.content)}
            ${actions ? html`<div class="d-flex flex-wrap gap-2 datum-bs-grid-actions">${buttons(row)}</div>` : nothing}
          </fieldset>`;
        }
        return html`<tr data-row-index=${row.index}>
          ${s.showRowNumbers ? html`<th scope="row" id=${nameId} class="fw-normal">${row.label}</th>` : nothing}
          ${row.cells.map((cell, at) => html`<td data-column-id=${cell.columnId}>${at === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="visually-hidden">${row.label}</span>` : nothing}${cell.content}</td>`)}
          ${actions
            ? html`<td class="text-nowrap datum-bs-grid-actions">${row.cells.length === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="visually-hidden">${row.label}</span>` : nothing}<div class="d-flex gap-2">${buttons(row)}</div></td>`
            : nothing}
        </tr>`;
      });

      const head = s.showHeader
        ? html`<thead><tr>
            ${s.showRowNumbers ? html`<td></td>` : nothing}
            ${s.columns.map((column) => html`<th scope="col" class="fw-normal" data-column-id=${column.id}>${column.label}${column.required ? requiredOf({ legendMark: "required", words: s.words }) : nothing}</th>`)}
            ${actions ? html`<th scope="col" class="fw-normal">${s.captions.actions}</th>` : nothing}
          </tr></thead>`
        : nothing;

      const described = [s.legend !== undefined && s.hint !== undefined ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);
      return html`<fieldset id=${s.id} class=${cls("mb-3", ...s.classNames)} aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}>
        ${s.legend !== undefined ? html`<legend id="${s.key}__group-label" class=${s.hideLegend ? "visually-hidden" : legendSize(s.level)}>${s.legend}${requiredOf(s)}</legend>` : nothing}
        ${s.legend !== undefined && s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="form-text mt-0 mb-3">${s.hint}</div>` : nothing}
        ${s.rows.length === 0
          ? html`<p class="form-text">${s.captions.empty}</p>`
          : stacked
            ? rows
            : html`<div class="table-responsive"><table class="table align-top datum-bs-grid">${head}<tbody>${rows}</tbody></table></div>`}
        ${s.errors.length > 0 && s.errorId !== undefined ? html`<div id=${s.errorId} class="invalid-feedback d-block mb-2">${s.errors.join("; ")}</div>` : nothing}
        ${s.offers.add
          ? html`<button
              type="button"
              id=${s.addId}
              class="btn btn-outline-primary btn-sm"
              data-row-action="add"
              ?disabled=${s.add === undefined}
              @click=${() => s.add?.()}
            >${s.captions.add}</button>`
          : nothing}
      </fieldset>`;
    }
  };

  // ── Steps ──────────────────────────────────────────────────────────────────────────────────

  const steps: StepsAdapter = {
    kind: "steps",
    name: "bootstrap-steps",
    capabilities: { hideLabel: "drawn" },
    template(s: StepsState): TemplateResult {
      const heading_ = (step: StepState, index: number): TemplateResult =>
        s.flat
          ? heading(s.level + 1, { id: step.headingId, className: "h5", focusable: true }, step.label)
          : heading(s.level + 1, { id: step.headingId, className: "visually-hidden", focusable: true }, `${s.words("stepOf", { n: index + 1, total: s.steps.length })}${s.words("stepTagSeparator")}${step.label}`);
      const panel = (step: StepState, index: number): TemplateResult => html`<section
        class=${cls("datum-bs-step-panel", ...step.classNames)}
        data-step-panel=${step.id}
        data-step-container=${s.id}
        aria-labelledby=${step.headingId}
        ?hidden=${!step.shown}
      >${heading_(step, index)}${step.content}</section>`;
      const panels = html`<div class="datum-bs-step-panels">${s.eachStep((step) => panel(step, s.steps.indexOf(step)))}${s.others}</div>`;
      const root = cls("datum-bs-steps", ...s.classNames);
      if (s.flat || s.steps.length === 0) {
        return html`<div class=${root} data-step-container=${s.id}>${panels}</div>`;
      }
      // Pills: the shown step the active one, a step the person can open (a button), one not yet reached disabled.
      const pill = (step: StepState, index: number): TemplateResult => {
        const current = step.status === "active";
        const label = html`${index + 1}. ${step.label}${step.statusText !== "" ? html` <span class="visually-hidden">${step.statusText}</span>` : nothing}`;
        return html`<li class="nav-item" data-step-status=${step.status}>${step.select !== undefined && !current
          ? html`<button type="button" class="nav-link" @click=${() => step.select?.()}>${label}</button>`
          : html`<span class=${cls("nav-link", current && "active", !current && "disabled")} aria-current=${current ? "step" : nothing} aria-disabled=${current ? nothing : "true"}>${label}</span>`}</li>`;
      };
      return html`<div class=${root} data-step-container=${s.id} data-step-active=${ifDefined(s.activeStepId ?? "")}>
        <ol class="nav nav-pills mb-3" data-step-indicator>${s.steps.map(pill)}</ol>
        ${panels}
        <div class="d-flex gap-2 mt-3 datum-bs-step-actions">
          ${s.back ? html`<button type="button" class=${cls("btn", "btn-outline-secondary", s.busy && "disabled")} data-step-prev data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.back?.go()}>${s.back.label}</button>` : nothing}
          ${s.next ? html`<button type="button" class=${cls("btn", "btn-primary", s.busy && "disabled")} data-step-next data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.next?.go()}>${s.next.label}</button>` : nothing}
        </div>
      </div>`;
    }
  };

  return { fieldset, buttonGroup, tabs, grid, steps };
}
