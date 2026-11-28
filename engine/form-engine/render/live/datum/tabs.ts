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
 * The tab list is named by the container's legend (visually hidden under `hideLegend`, still its
 * name) and described by its description. Each panel of the strip carries its tab's label
 * (`data-tab-label`), which the print stylesheet writes over the panel, since the strip is not
 * printed. The author's classes go on the root. A tab holding blocking errors carries `data-has-errors`.
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
            // By instance: the same tabs drawn in each row of a grid has its own headings.
            const headingId = `${s.key}__heading-${tab.slotId}`;
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
      // The legend names the tab list (visually hidden under hideLegend, still its name); the hint describes it.
      const legendId = `${s.key}__name`;
      const legend =
        s.legend !== undefined
          ? html`<p id=${legendId} class=${classes("datum-form__tabs-legend", s.hideLegend && "datum-form__visually-hidden")}>${s.legend}</p>`
          : nothing;
      const hint = s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="datum-form__group-description datum-form__tabs-description">${s.hint}</p>` : nothing;
      if (s.narrow) {
        return html`<div class=${classes("datum-form__tabs", "datum-form__tabs--responsive", ...s.classNames)} data-tabs-view="contents">
          ${legend}${hint}${heading(level, { className: "datum-form__tabs-title" }, s.words("tabsContents"))}
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
        ${legend}${hint}
        <div
          class="datum-form__tablist"
          role="tablist"
          aria-labelledby=${ifDefined(s.legend !== undefined ? legendId : undefined)}
          aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}
        >
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
            data-tab-label=${tab.label}
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
