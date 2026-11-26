/**
 * The U.S. Web Design System's containers as adapters for the engine contract: the fieldset group,
 * tabs, a data grid (usa-table), the steps container (usa-step-indicator) and the button group.
 *
 * USWDS has no tabs component. Its nearest piece is the segmented button group (one choice of a
 * few, drawn as joined buttons), so the strip is built from it: the shown tab a filled `usa-button`,
 * the others outlined. Which tab shows, the arrow keys, Home and End, and opening a tab for an
 * error are the renderer's (`behaviour.keyboard: "renderer"`); the adapter only draws.
 *
 * Every row's bounds, focus and buttons are the renderer's too. USWDS's step indicator is static
 * (segments, a counter and a heading): the indicator is drawn from it and the panel under it keeps
 * the heading the renderer moves focus to.
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

/** Stands in for the step's number while the `stepOf` words are split around it. */
const STEP_NUMBER_MARK = "";

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

  /** The asterisk a labelled container's legend carries when its mark is required (USWDS marks the required ones). */
  const requiredOf = (s: Pick<GroupState, "legendMark" | "words">): View => {
    const mark = s.legendMark === "required" ? s.words("required") : "";
    return mark === "" ? nothing : html` <abbr title=${s.words("requiredTitle")} class="usa-hint usa-hint--required">${mark}</abbr>`;
  };

  // ── Fieldset ───────────────────────────────────────────────────────────────────────────────

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "uswds-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        // No name to read out: no element of its own unless the author gave classes.
        return s.classNames.length > 0 ? html`<div class=${cls(...s.classNames)}>${children}</div>` : children;
      }
      return html`<fieldset class=${cls("usa-fieldset", ...s.classNames)} aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
        <legend id="${s.key}__group-label" class=${cls("usa-legend", s.hideLegend ? "usa-sr-only" : s.level <= 1 && "usa-legend--large")}>${s.legend}${requiredOf(s)}</legend>
        ${s.hint !== undefined ? html`<span id=${ifDefined(s.hintId)} class="usa-hint">${s.hint}</span>` : nothing}
        ${children}
      </fieldset>`;
    }
  };

  // ── Button group ───────────────────────────────────────────────────────────────────────────

  const buttonGroup: GroupAdapter = {
    kind: "group",
    name: "uswds-button-group",
    capabilities: {},
    template: (s) => html`<ul class=${cls("usa-button-group", ...s.classNames)}>${s.eachItem((item) => html`<li class="usa-button-group__item">${item.content}</li>`)}</ul>`
  };

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────

  const tabs: TabsAdapter = {
    kind: "tabs",
    name: "uswds-tabs",
    capabilities: { hideLabel: "drawn" },
    behaviour: { keyboard: "renderer" },
    template(s: TabsState): TemplateResult {
      const legendId = `${s.key}__name`;
      const legend = s.legend !== undefined ? html`<p id=${legendId} class=${cls("usa-legend", s.hideLegend && "usa-sr-only")}>${s.legend}</p>` : nothing;

      if (s.flat) {
        // A review or a print: every tab as a headed section.
        return html`<div class=${cls("datum-usa-tabs", "datum-usa-tabs--flat", ...s.classNames)}>
          ${legend}${s.tabs.map((tab) => html`<section class="datum-usa-tabpanel" id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id} aria-labelledby="${tab.panelId}__heading">${heading(s.level + 1, { id: `${tab.panelId}__heading`, className: "datum-usa-heading" }, tab.label)}${tab.content}</section>`)}
        </div>`;
      }

      return html`<div class=${cls("datum-usa-tabs", ...s.classNames)}>
        ${legend}
        <ul class="usa-button-group usa-button-group--segmented datum-usa-tablist" role="tablist" aria-labelledby=${ifDefined(s.legend !== undefined ? legendId : undefined)}>
          ${s.tabs.map(
            (tab) => html`<li class="usa-button-group__item" role="presentation">
              <button
                type="button"
                role="tab"
                class=${cls("usa-button", !tab.selected && "usa-button--outline")}
                id=${tab.tabId}
                aria-controls=${tab.panelId}
                aria-selected=${tab.selected ? "true" : "false"}
                tabindex=${tab.selected ? "0" : "-1"}
                data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
                data-tab-select=${tab.slotId}
                data-tab-container=${s.id}
                @click=${() => tab.select()}
              >${tab.label}${tab.errorCount > 0 ? html` <span class="usa-tag datum-usa-tab-errors" data-tab-error>${s.words.plural("tabHasErrors", tab.errorCount, { count: tab.errorCount })}</span>` : nothing}</button>
            </li>`
          )}
        </ul>
        ${s.tabs.map(
          (tab) => html`<div
            class="datum-usa-tabpanel"
            id=${tab.panelId}
            role="tabpanel"
            aria-labelledby=${tab.tabId}
            data-tab-panel=${tab.slotId}
            data-tab-container=${s.id}
            ?hidden=${!tab.selected}
          >${tab.content}</div>`
        )}
      </div>`;
    }
  };

  // ── Data grid ──────────────────────────────────────────────────────────────────────────────

  /** The id of a row's name, which describes the row's buttons. */
  const rowNameId = (gridId: string, index: number): string => `${gridId}__row-${index}`;

  /**
   * usa-table with the fields in its cells. `usa-table--stacked` is USWDS's own narrow-screen
   * layout (each cell headed by its column's `data-label`), so a table that turns into stacked rows
   * is the same table; the stacked layout the author asks for is that table held stacked at every
   * width by the binding's css.
   */
  const grid: GridAdapter = {
    kind: "grid",
    name: "uswds-data-grid",
    capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
    template(s: GridState): TemplateResult {
      const stacked = s.layout === "stacked";
      const actions = s.offers.remove || s.offers.reorder;
      const rowButton = (offered: boolean, press: (() => void) | undefined, caption: string, action: string, row: GridRow, extra?: string): View =>
        offered
          ? html`<li class="usa-button-group__item"><button
              type="button"
              class=${cls("usa-button", "usa-button--unstyled", extra)}
              data-row-action=${action}
              aria-describedby=${rowNameId(s.id, row.index)}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
            >${caption}</button></li>`
          : nothing;

      const rows = s.eachRow((row) => {
        const nameId = rowNameId(s.id, row.index);
        const labelOf = (columnId: string): string => s.columns.find((column) => column.id === columnId)?.label ?? "";
        return html`<tr data-row-index=${row.index}>
          ${s.showRowNumbers ? html`<th scope="row" id=${nameId} data-label=${row.label}>${row.label}</th>` : nothing}
          ${row.cells.map((cell, at) => html`<td data-label=${labelOf(cell.columnId)} data-column-id=${cell.columnId}>${at === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="usa-sr-only">${row.label}</span>` : nothing}${cell.content}</td>`)}
          ${actions
            ? html`<td class="datum-usa-grid-actions">${row.cells.length === 0 && !s.showRowNumbers ? html`<span id=${nameId} class="usa-sr-only">${row.label}</span>` : nothing}<ul class="usa-button-group">${rowButton(s.offers.reorder, row.moveUp, s.captions.moveUp, "up", row)}${rowButton(s.offers.reorder, row.moveDown, s.captions.moveDown, "down", row)}${rowButton(s.offers.remove, row.remove, s.captions.remove, "remove", row, "datum-usa-remove")}</ul></td>`
            : nothing}
        </tr>`;
      });

      const head =
        s.showHeader
          ? html`<thead><tr>
              ${s.showRowNumbers ? html`<td class="datum-usa-grid-number"></td>` : nothing}
              ${s.columns.map((column) => html`<th scope="col" data-column-id=${column.id}>${column.label}${column.required ? requiredOf({ legendMark: "required", words: s.words }) : nothing}</th>`)}
              ${actions ? html`<th scope="col">${s.captions.actions}</th>` : nothing}
            </tr></thead>`
          : nothing;

      const described = [s.legend !== undefined && s.hint !== undefined ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);
      const invalid = s.errors.length > 0;
      return html`<div class=${cls("usa-form-group", invalid && "usa-form-group--error", ...s.classNames)}>
        <fieldset id=${s.id} class="usa-fieldset" aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}>
          ${s.legend !== undefined ? html`<legend id="${s.key}__group-label" class=${cls("usa-legend", s.hideLegend ? "usa-sr-only" : s.level <= 1 && "usa-legend--large")}>${s.legend}${requiredOf(s)}</legend>` : nothing}
          ${s.legend !== undefined && s.hint !== undefined ? html`<span id=${ifDefined(s.hintId)} class="usa-hint">${s.hint}</span>` : nothing}
          ${invalid && s.errorId !== undefined ? html`<span id=${s.errorId} class="usa-error-message" role="alert">${s.errors.join("; ")}</span>` : nothing}
          ${s.rows.length === 0
            ? html`<p class="usa-hint">${s.captions.empty}</p>`
            : html`<table class=${cls("usa-table", "usa-table--borderless", !stacked && "usa-table--stacked", stacked && "datum-usa-grid--stacked", "datum-usa-grid")}>${head}<tbody>${rows}</tbody></table>`}
          ${s.offers.add
            ? html`<button
                type="button"
                id=${s.addId}
                class="usa-button usa-button--outline"
                data-row-action="add"
                ?disabled=${s.add === undefined}
                @click=${() => s.add?.()}
              >${s.captions.add}</button>`
            : nothing}
        </fieldset>
      </div>`;
    }
  };

  // ── Steps ──────────────────────────────────────────────────────────────────────────────────

  /** The step counter as usa-step-indicator writes it: "Step" (read), the number, "of 4", from the `stepOf` words split around the number. */
  const counter = (s: StepsState, n: number): View => {
    const worded = s.words("stepOf", { n: STEP_NUMBER_MARK, total: s.steps.length });
    const at = worded.indexOf(STEP_NUMBER_MARK);
    if (at < 0) {
      return html`<span class="usa-step-indicator__heading-counter">${worded}</span>`;
    }
    const lead = worded.slice(0, at).trim();
    const rest = worded.slice(at + STEP_NUMBER_MARK.length).trim();
    return html`<span class="usa-step-indicator__heading-counter">${lead !== "" ? html`<span class="usa-sr-only">${lead}</span> ` : nothing}<span class="usa-step-indicator__current-step">${n}</span>${rest !== "" ? html` <span class="usa-step-indicator__total-steps">${rest}</span>` : nothing}</span>`;
  };

  const steps: StepsAdapter = {
    kind: "steps",
    name: "uswds-steps",
    capabilities: { hideLabel: "drawn" },
    template(s: StepsState): TemplateResult {
      const panel = (step: StepState, index: number): TemplateResult => html`<section
        class=${cls("datum-usa-step-panel", ...step.classNames)}
        data-step-panel=${step.id}
        data-step-container=${s.id}
        aria-labelledby=${step.headingId}
        ?hidden=${!step.shown}
      >${heading(s.level + 1, { id: step.headingId, className: "usa-sr-only", focusable: true }, `${s.words("stepOf", { n: index + 1, total: s.steps.length })}${s.words("stepTagSeparator")}${step.label}`)}${step.content}</section>`;
      const panels = html`<div class="datum-usa-step-panels">${s.eachStep((step) => panel(step, s.steps.indexOf(step)))}${s.others}</div>`;
      const root = cls("datum-usa-steps", ...s.classNames);
      if (s.flat || s.steps.length === 0) {
        return html`<div class=${root} data-step-container=${s.id}>${panels}</div>`;
      }
      const at = Math.max(0, s.steps.findIndex((step) => step.shown));
      const current = s.steps[at];
      // complete / current / incomplete are usa-step-indicator's three; a step visited and not completed is still to do.
      const segment = (step: StepState): TemplateResult => html`<li
        class=${cls("usa-step-indicator__segment", step.status === "completed" && "usa-step-indicator__segment--complete", step.status === "active" && "usa-step-indicator__segment--current")}
        aria-current=${step.status === "active" ? "true" : nothing}
        data-step-status=${step.status}
      ><span class="usa-step-indicator__segment-label">${step.label}${step.statusText !== "" ? html` <span class="usa-sr-only">${step.statusText}</span>` : nothing}</span></li>`;
      return html`<div class=${root} data-step-container=${s.id} data-step-active=${ifDefined(s.activeStepId ?? "")}>
        <div class="usa-step-indicator" data-step-indicator>
          <ol class="usa-step-indicator__segments">${s.steps.map(segment)}</ol>
          <div class="usa-step-indicator__header" aria-hidden="true">
            <div class="usa-step-indicator__heading">${counter(s, at + 1)}<span class="usa-step-indicator__heading-text">${current?.label ?? ""}</span></div>
          </div>
        </div>
        ${panels}
        <ul class="usa-button-group datum-usa-step-actions">
          ${s.back ? html`<li class="usa-button-group__item"><button type="button" class="usa-button usa-button--outline" data-step-prev data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.back?.go()}>${s.back.label}</button></li>` : nothing}
          ${s.next ? html`<li class="usa-button-group__item"><button type="button" class="usa-button" data-step-next data-step-container=${s.id} aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.next?.go()}>${s.next.label}</button></li>` : nothing}
        </ul>
      </div>`;
    }
  };

  return { fieldset, buttonGroup, tabs, grid, steps };
}
