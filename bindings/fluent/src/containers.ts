/**
 * The Fluent UI containers: the fieldset group and tabs.
 *
 * - `fieldset` (tier 2): Fluent UI has no group component, so a named group is a native `<fieldset>`
 *   whose legend is set in Fluent's label tokens (css.ts). The layouts and the children are Datum's
 *   group's (wrapped, not copied): the children stay in Datum's shadow root, so every id, label and
 *   summary link inside reaches them as before. A group with no name is Datum's plain group.
 * - `tabs` (tier 1): `fluent-tablist` of `fluent-tab`, the panels the binding's own (Fluent draws
 *   none: `fluent-tablist` shows and hides a panel only through the tab's `aria-controls`). The
 *   renderer owns which tab shows, the arrow keys, Home and End and opening a tab for an error
 *   (`behaviour.keyboard: "renderer"`). The tablist is driven from the renderer's state through its
 *   `activeid`; a click, an arrow key and a summary link each end with the renderer redrawing the
 *   same tab Fluent has already marked, so the two agree after every draw.
 *
 * `dataGrid` and `steps` are not drawn here: Datum's own draw them, tinted with `fallbackTokens`,
 * and `unsupported()` reports them.
 */
import type { AdapterEntry, GroupAdapter, GroupState, LiveBinding, TabsAdapter, TabsState } from "../../../engine/form-engine/render/live/contract.js";
import { createHeading } from "./heading.js";
import { VISUALLY_HIDDEN, type Lit } from "./shared.js";

export function createContainers(lit: Lit, datum?: LiveBinding): Record<string, AdapterEntry> {
  const { html, ifDefined, nothing } = lit;

  const datumEntry = datum?.components["fieldset"];
  const datumGroup = (Array.isArray(datumEntry) ? datumEntry : datumEntry === undefined ? [] : [datumEntry]).find((adapter): adapter is GroupAdapter => adapter.kind === "group");
  const datumTabsEntry = datum?.components["tabs"];
  const datumTabs = (Array.isArray(datumTabsEntry) ? datumTabsEntry : datumTabsEntry === undefined ? [] : [datumTabsEntry]).find((adapter): adapter is TabsAdapter => adapter.kind === "tabs");

  const headingIn = createHeading(lit);

  /** The mark a labelled container's legend carries: the form's word for required or optional. */
  const markOf = (s: Pick<GroupState, "legendMark" | "words">) => {
    if (s.legendMark === undefined) {
      return nothing;
    }
    const word = s.words(s.legendMark);
    return word === "" ? nothing : html` <span class=${s.legendMark === "required" ? "datum-fluent-legend-required" : "datum-fluent-legend-optional"}>${word}</span>`;
  };

  // ── Fieldset ───────────────────────────────────────────────────────────────────────────────

  const fieldset: GroupAdapter = {
    kind: "group",
    name: "fluent-fieldset",
    capabilities: { hideLabel: "drawn" },
    template(s, children) {
      if (s.legend === undefined) {
        return datumGroup?.template(s, children) ?? children;
      }
      // Datum's layouts around the children, drawn as a group with no name: the legend and the hint are this fieldset's.
      const { legend: _legend, hint: _hint, hintId: _hintId, ...unnamed } = s;
      const inner = datumGroup?.template(unnamed, children) ?? children;
      return html`<fieldset class="datum-fluent-fieldset" aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}>
        <legend class=${s.hideLegend ? `datum-fluent-legend ${VISUALLY_HIDDEN}` : "datum-fluent-legend"}>${s.legend}${markOf(s)}</legend>
        ${s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="datum-fluent-fieldset-hint">${s.hint}</div>` : nothing}
        ${inner}
      </fieldset>`;
    }
  };

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────

  const tabs: TabsAdapter = {
    kind: "tabs",
    name: "fluent-tablist",
    capabilities: { hideLabel: "drawn" },
    behaviour: { keyboard: "renderer" },
    template(s: TabsState) {
      const legendId = `${s.key}__name`;
      const legend =
        s.legend !== undefined
          ? html`<div id=${legendId} class=${s.hideLegend ? `datum-fluent-tabs-legend ${VISUALLY_HIDDEN}` : "datum-fluent-tabs-legend"}>${s.legend}</div>`
          : nothing;
      const hint = s.hint !== undefined ? html`<div id=${ifDefined(s.hintId)} class="datum-fluent-fieldset-hint">${s.hint}</div>` : nothing;

      if (s.flat) {
        // A review or a print: every tab as a headed section.
        return html`<div class=${["datum-fluent-tabs", ...s.classNames].join(" ")}>
          ${legend}${hint}${s.tabs.map(
            (tab) => html`<section id=${tab.panelId} data-tab-panel=${tab.slotId} data-tab-container=${s.id} aria-labelledby="${tab.panelId}__heading">${headingIn(s.level + 1, { id: `${tab.panelId}__heading`, size: "500" }, tab.label)}${tab.content}</section>`
          )}
        </div>`;
      }
      if (s.narrow && datumTabs !== undefined) {
        // Below the width a host asked for: Datum's contents list over the stacked panels.
        return datumTabs.template(s);
      }

      const active = s.tabs.find((tab) => tab.selected) ?? s.tabs[0];
      return html`<div class=${["datum-fluent-tabs", ...s.classNames].join(" ")}>
        ${legend}${hint}
        <fluent-tablist
          appearance="transparent"
          activeid=${ifDefined(active?.tabId)}
          aria-labelledby=${ifDefined(s.legend !== undefined ? legendId : undefined)}
          aria-describedby=${ifDefined(s.hint !== undefined ? s.hintId : undefined)}
        >
          ${s.tabs.map(
            (tab) => html`<fluent-tab
              id=${tab.tabId}
              role="tab"
              aria-controls=${tab.panelId}
              data-tab-select=${tab.slotId}
              data-tab-container=${s.id}
              data-has-errors=${ifDefined(tab.errorCount > 0 ? "true" : undefined)}
              @click=${() => tab.select()}
            >${tab.label}${tab.errorCount > 0
              ? html`<fluent-badge slot="end" appearance="filled" color="danger" shape="rounded" size="small" data-tab-error>${s.words.plural("tabHasErrors", tab.errorCount, { count: tab.errorCount })}</fluent-badge>`
              : nothing}</fluent-tab>`
          )}
        </fluent-tablist>
        ${s.tabs.map(
          // The panel is named by the tab's words alone: labelled by the tab it would read the error badge too ("One 1 error").
          (tab) => html`<div
            class="datum-fluent-tabpanel"
            id=${tab.panelId}
            role="tabpanel"
            aria-label=${tab.label}
            data-tab-panel=${tab.slotId}
            data-tab-container=${s.id}
            ?hidden=${!tab.selected}
          >${tab.content}</div>`
        )}
      </div>`;
    }
  };

  return { fieldset, tabs };
}
