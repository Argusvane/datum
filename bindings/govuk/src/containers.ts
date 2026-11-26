/**
 * GOV.UK Frontend's containers as adapters for the engine contract: the fieldset group, tabs, a
 * data grid (one fieldset per row, GOV.UK's pattern for "several of a thing") and the button
 * group.
 *
 * Which tab shows, the arrow keys, Home and End, opening a tab for an error, the narrow view and
 * every row's bounds, focus and buttons are the renderer's; the adapters only draw. GOV.UK's tabs
 * script is not run in the form (it reads `location.hash` and a custom property from the page's
 * root, and sets the page's address), so the strip is drawn as the script leaves it (roles,
 * selection, hidden panels) and a form under the tablet breakpoint draws GOV.UK's own
 * no-JavaScript view: a list of links over stacked panels.
 */
import type {
  GridAdapter,
  GridRow,
  GridState,
  GroupAdapter,
  GroupState,
  TabsAdapter,
  TabsState,
  View
} from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";
import { cls } from "./fields.js";

/** GOV.UK's tablet breakpoint (40.0625em at 16px): under it the tabs are a list of links. */
export const TABLET_BREAKPOINT_PX = 641;

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

  /** Legend sizes by how deep the group sits: a top-level group is a medium heading. */
  const legendSize = (level: number): string => (level <= 1 ? "govuk-fieldset__legend--m" : "govuk-fieldset__legend--s");

  /** The optional marker a labelled container's legend carries; GOV.UK marks optional, never required. */
  const optionalOf = (s: Pick<GroupState, "legendMark" | "words">): string => {
    if (s.legendMark !== "optional") {
      return "";
    }
    const word = s.words("optional");
    return word === "" ? "" : ` ${word}`;
  };

  // ── Fieldset ───────────────────────────────────────────────────────────────────────────────

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "govuk-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        // No name to read out: no element of its own unless the author gave classes.
        return s.classNames.length > 0 ? html`<div class=${cls(...s.classNames)}>${children}</div>` : children;
      }
      return html`<div class=${cls("govuk-form-group", ...s.classNames)}>
        <fieldset class="govuk-fieldset" aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
          <legend id="${s.key}__group-label" class=${cls("govuk-fieldset__legend", s.hideLegend ? "govuk-visually-hidden" : legendSize(s.level))}>${s.legend + optionalOf(s)}</legend>
          ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="govuk-hint">${s.hint}</div>` : nothing}
          ${children}
        </fieldset>
      </div>`;
    }
  };

  // ── Button group ───────────────────────────────────────────────────────────────────────────

  const buttonGroup: GroupAdapter = {
    kind: "group",
    name: "govuk-button-group",
    capabilities: {},
    template: (s, children) => html`<div class=${cls("govuk-button-group", ...s.classNames)}>${children}</div>`
  };

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────

  const tabs: TabsAdapter = {
    kind: "tabs",
    name: "govuk-tabs",
    capabilities: { hideLabel: "drawn" },
    behaviour: { keyboard: "renderer" },
    template(s: TabsState): TemplateResult {
      const level = s.level + 1;
      const panelHeading = (label: string, id?: string, focusable = false): TemplateResult => heading(level, { id, className: "govuk-heading-m", focusable }, label);
      const legend = s.legend !== undefined ? html`<p class=${cls("govuk-body", s.hideLegend && "govuk-visually-hidden")}>${s.legend}</p>` : nothing;

      if (s.flat) {
        // A review or a print: every tab as a headed section.
        return html`<div class=${cls("datum-govuk-tabs", "datum-govuk-tabs--flat", ...s.classNames)}>
          ${legend}${s.tabs.map((tab) => html`<section class="datum-govuk-tabpanel" id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id} aria-labelledby="${tab.panelId}__heading">${panelHeading(tab.label, `${tab.panelId}__heading`)}${tab.content}</section>`)}
        </div>`;
      }

      if (s.narrow) {
        // GOV.UK's no-JavaScript view: a list of links to the panels, which stand one under the other.
        return html`<div class=${cls("datum-govuk-tabs", "datum-govuk-tabs--contents", ...s.classNames)} data-tabs-view="contents">
          ${legend}${heading(level, { className: "govuk-heading-s" }, s.words("tabsContents"))}
          <ul class="govuk-list govuk-list--bullet">
            ${s.tabs.map(
              (tab) => html`<li><a class="govuk-link" href="#${tab.panelId}" id=${tab.tabId} data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)} @click=${(event: Event) => {
                event.preventDefault();
                tab.select();
              }}>${tab.label}</a></li>`
            )}
          </ul>
          ${s.tabs.map((tab) => html`<div class="datum-govuk-tabpanel" id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id}>${panelHeading(tab.label, undefined, true)}${tab.content}</div>`)}
        </div>`;
      }

      // The strip, as GOV.UK's script leaves it: the selection is the renderer's, the roles and ids are what its keys read.
      return html`<div class=${cls("govuk-tabs", ...s.classNames)}>
        ${legend}${heading(level, { className: "govuk-tabs__title" }, s.words("tabsContents"))}
        <ul class="govuk-tabs__list" role="tablist">
          ${s.tabs.map(
            (tab) => html`<li class=${cls("govuk-tabs__list-item", tab.selected && "govuk-tabs__list-item--selected")} role="presentation">
              <a
                class="govuk-tabs__tab"
                href="#${tab.panelId}"
                id=${tab.tabId}
                role="tab"
                aria-controls=${tab.panelId}
                aria-selected=${tab.selected ? "true" : "false"}
                tabindex=${tab.selected ? "0" : "-1"}
                data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
                data-tab-select=${tab.slotId}
                data-tab-container=${s.id}
                @click=${(event: Event) => {
                  event.preventDefault();
                  tab.select();
                }}
              >${tab.label}${tab.errorCount > 0 ? html` <strong class="govuk-tag govuk-tag--red" data-tab-error>${s.words.plural("tabHasErrors", tab.errorCount, { count: tab.errorCount })}</strong>` : nothing}</a>
            </li>`
          )}
        </ul>
        ${s.tabs.map(
          (tab) => html`<div
            class=${cls("govuk-tabs__panel", !tab.selected && "govuk-tabs__panel--hidden")}
            id=${tab.panelId}
            role="tabpanel"
            aria-labelledby=${tab.tabId}
            data-tab-panel=${tab.slotId}
            data-tab-container=${s.id}
            ?hidden=${!tab.selected}
          >${panelHeading(tab.label)}${tab.content}</div>`
        )}
      </div>`;
    }
  };

  // ── Data grid ──────────────────────────────────────────────────────────────────────────────

  /** The id of a row's name, which describes the row's buttons. */
  const rowNameId = (gridId: string, index: number): string => `${gridId}__row-${index}`;

  const grid: GridAdapter = {
    kind: "grid",
    name: "govuk-data-grid",
    // GOV.UK has no table of inputs: rows are stacked fieldsets, numbered when the grid asks. The renderer
    // hands this adapter the stacked layout whatever the author chose, and keeps the cells' labels.
    layouts: ["stacked"],
    capabilities: { rowNumbers: "drawn", hideLabel: "drawn" },
    template(s: GridState): TemplateResult {
      const rowButton = (offered: boolean, press: (() => void) | undefined, caption: string, action: string, row: GridRow, variant?: string): View =>
        offered
          ? html`<button
              type="button"
              class=${cls("govuk-button", "govuk-button--secondary", variant)}
              data-module="govuk-button"
              data-row-action=${action}
              aria-describedby=${rowNameId(s.id, row.index)}
              ?disabled=${press === undefined}
              @click=${() => press?.()}
            >${caption}</button>`
          : nothing;

      const rows = s.eachRow(
        (row) => html`<fieldset class="govuk-fieldset datum-govuk-row" data-row-index=${row.index}>
          <legend id=${rowNameId(s.id, row.index)} class=${cls("govuk-fieldset__legend", s.showRowNumbers ? "govuk-fieldset__legend--s" : "govuk-visually-hidden")}>${row.label}</legend>
          ${row.cells.map((cell) => cell.content)}
          ${s.offers.remove || s.offers.reorder
            ? html`<div class="govuk-button-group">${rowButton(s.offers.reorder, row.moveUp, s.captions.moveUp, "up", row)}${rowButton(s.offers.reorder, row.moveDown, s.captions.moveDown, "down", row)}${rowButton(s.offers.remove, row.remove, s.captions.remove, "remove", row, "govuk-button--warning")}</div>`
            : nothing}
        </fieldset>`
      );

      const described = [s.legend !== undefined && s.hint !== undefined ? s.hintId : undefined, s.errors.length > 0 ? s.errorId : undefined].filter((id): id is string => id !== undefined);
      const errorPrefix = s.words("errorPrefix");
      return html`<div class=${cls("govuk-form-group", s.errors.length > 0 && "govuk-form-group--error", ...s.classNames)}>
        <fieldset id=${s.id} class="govuk-fieldset" aria-describedby=${ifDefined(described.length > 0 ? described.join(" ") : undefined)}>
          ${s.legend !== undefined ? html`<legend id="${s.key}__group-label" class=${cls("govuk-fieldset__legend", s.hideLegend ? "govuk-visually-hidden" : legendSize(s.level))}>${s.legend + optionalOf(s)}</legend>` : nothing}
          ${s.legend !== undefined && s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="govuk-hint">${s.hint}</div>` : nothing}
          ${s.errors.length > 0 && s.errorId !== undefined ? html`<p id=${s.errorId} class="govuk-error-message">${errorPrefix === "" ? nothing : html`<span class="govuk-visually-hidden">${errorPrefix}</span> `}${s.errors.join("; ")}</p>` : nothing}
          ${s.rows.length === 0 ? html`<p class="govuk-hint">${s.captions.empty}</p>` : rows}
          ${s.offers.add
            ? html`<button
                type="button"
                id=${s.addId}
                class=${cls("govuk-button", "govuk-button--secondary", s.add === undefined && "govuk-button--disabled")}
                data-module="govuk-button"
                data-row-action="add"
                ?disabled=${s.add === undefined}
                aria-disabled=${s.add === undefined ? "true" : nothing}
                @click=${() => s.add?.()}
              >${s.captions.add}</button>`
            : nothing}
        </fieldset>
      </div>`;
    }
  };

  return { fieldset, buttonGroup, tabs, grid };
}
