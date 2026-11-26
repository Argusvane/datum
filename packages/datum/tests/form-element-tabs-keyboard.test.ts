import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function tabsForm(): FormDefinition {
  return {
    id: "tabs-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "period",
            type: "tabs",
            configuration: { tabs: [{ id: "day", label: "Past day" }, { id: "week", label: "Past week" }, { id: "month", label: "Past month" }] },
            children: {
              day: [{ id: "dayNote", type: "text", configuration: { label: "Day note" } }],
              week: [{ id: "weekNote", type: "text", configuration: { label: "Week note" } }],
              month: [{ id: "monthNote", type: "text", configuration: { label: "Month note" } }]
            }
          }
        ]
      }
    }
  };
}

/**
 * The tab strip's keyboard (the WAI-ARIA tabs pattern, as a design system's tabs have it): the
 * selected tab alone is in the tab order, so the arrow keys, Home and End are how a keyboard
 * reaches the others — for every theme, since the roving tabindex is the engine's.
 */
describe("<datum-form> tabs by keyboard", () => {
  it("moves to and selects the next or previous tab with the arrow keys, wrapping, and the first and last with Home and End", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = tabsForm();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector('[role="tab"][data-tab-select="week"]'));
    const root = element.renderer!.shadowRoot!;
    const tab = (slot: string) => root.querySelector<HTMLElement>(`[role="tab"][data-tab-select="${slot}"]`)!;
    const press = (key: string) => root.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
    const selected = () => ["day", "week", "month"].filter((slot) => tab(slot).getAttribute("aria-selected") === "true");

    expect(tab("week").getAttribute("tabindex")).toBe("-1");
    tab("day").focus();
    press("ArrowRight");
    expect(root.activeElement).toBe(tab("week"));
    expect(selected()).toEqual(["week"]);
    expect(tab("week").getAttribute("tabindex")).toBe("0");
    expect(tab("day").getAttribute("tabindex")).toBe("-1");
    press("ArrowRight");
    press("ArrowRight");
    // Past the last, back to the first.
    expect(root.activeElement).toBe(tab("day"));
    press("ArrowLeft");
    expect(root.activeElement).toBe(tab("month"));
    expect(selected()).toEqual(["month"]);
    press("Home");
    expect(selected()).toEqual(["day"]);
    press("End");
    expect(root.activeElement).toBe(tab("month"));
    // Another key does nothing; the panel shown follows the tab.
    press("ArrowDown");
    expect(selected()).toEqual(["month"]);
    expect(root.querySelector<HTMLElement>('[data-tab-panel="month"]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-tab-panel="day"]')!.hidden).toBe(true);
  });
});
