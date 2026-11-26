/**
 * Datum's tabs: a strip of tab buttons over panels, drawn as the ARIA tabs pattern has it. Which
 * tab shows, the arrow keys, Home and End, opening a tab for an error and the narrow view are the
 * renderer's (`render/live/tabs.ts`); this adapter draws the three views it hands over:
 *
 * - the strip: a `tablist` of buttons (`TabState.tabId`, `aria-controls` the panel), every panel
 *   drawn and all but the selected one `hidden`, so a field keeps its nodes and its answer while
 *   its tab is shut;
 * - the narrow view (`TabsState.narrow`): a "Contents" heading over a plain list of in-page links
 *   to the stacked panels, each headed by its tab's label;
 * - the flat view (`TabsState.flat`, a review or a print): every tab as a headed section.
 *
 * The author's classes go on the root. A tab holding blocking errors carries `data-has-errors`.
 */
import type { TabsAdapter, TabsState } from "../contract.js";
import { html, ifDefined, nothing, type TemplateResult } from "../lit.js";
import { classes, heading, resolveContainerControls, type DatumContainerControls } from "./container-kit.js";

export interface DatumTabsOptions {
  /** `panelRegion`: whether a flat section is a named region. */
  controls?: Partial<DatumContainerControls> | undefined;
}

export function createDatumTabsAdapter(options: DatumTabsOptions = {}): TabsAdapter {
  const controls = resolveContainerControls(options.controls);
  return {
    kind: "tabs",
    name: "datum-tabs",
    capabilities: { hideLabel: "drawn" },
    behaviour: { keyboard: "renderer" },
    template(s: TabsState): TemplateResult {
      const level = s.level + 1;
      if (s.flat) {
        return html`<div class=${classes("datum-form__tabs", "datum-form__tabs--stacked", ...s.classNames)}>
          ${s.tabs.map((tab) => {
            const headingId = `${s.id}__heading-${tab.slotId}`;
            return html`<section
              class="datum-form__panel datum-form__tabs-section"
              id=${tab.panelId}
              data-tab-panel=${tab.slotId}
              data-tab-container=${s.id}
              aria-labelledby=${controls.panelRegion === "none" ? nothing : headingId}
            >
              <div class="datum-form__panel-header">${heading(level, { id: headingId, className: "datum-form__panel-title" }, tab.label)}</div>
              <div class="datum-form__panel-body">${tab.content}</div>
            </section>`;
          })}
        </div>`;
      }
      const legend = s.legend !== undefined ? html`<p class="datum-form__tabs-legend" ?hidden=${s.hideLegend}>${s.legend}</p>` : nothing;
      if (s.narrow) {
        return html`<div class=${classes("datum-form__tabs", "datum-form__tabs--responsive", ...s.classNames)} data-tabs-view="contents">
          ${legend}${heading(level, { className: "datum-form__tabs-title" }, s.words("tabsContents"))}
          <ul class="datum-form__tablist">
            ${s.tabs.map(
              (tab) => html`<li class="datum-form__tab-item"><a
                href=${`#${tab.panelId}`}
                id=${tab.tabId}
                data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
                @click=${(event: Event) => {
                  event.preventDefault();
                  tab.select();
                }}
              >${tab.label}</a></li>`
            )}
          </ul>
          ${s.tabs.map(
            (tab) => html`<div class="datum-form__tabpanel" id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id}>${heading(level, { className: "datum-form__tabpanel-heading", focusable: true }, tab.label)}${tab.content}</div>`
          )}
        </div>`;
      }
      return html`<div class=${classes("datum-form__tabs", ...s.classNames)}>
        ${legend}
        <div class="datum-form__tablist" role="tablist">
          ${s.tabs.map(
            (tab) => html`<button
              type="button"
              role="tab"
              class=${tab.selected ? "datum-form__tab is-active" : "datum-form__tab"}
              id=${tab.tabId}
              aria-controls=${tab.panelId}
              aria-selected=${tab.selected ? "true" : "false"}
              tabindex=${tab.selected ? "0" : "-1"}
              data-tab-select=${tab.slotId}
              data-tab-container=${s.id}
              data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
              @click=${tab.select}
            ><span class="datum-form__tab-label">${tab.label}</span></button>`
          )}
        </div>
        ${s.tabs.map(
          (tab) => html`<div
            role="tabpanel"
            class="datum-form__tabpanel"
            id=${tab.panelId}
            aria-labelledby=${tab.tabId}
            data-tab-panel=${tab.slotId}
            data-tab-container=${s.id}
            ?hidden=${!tab.selected}
          >${tab.content}</div>`
        )}
      </div>`;
    }
  };
}

/** Datum's tabs with the engine's own choices. */
export const datumTabsAdapter: TabsAdapter = createDatumTabsAdapter();
