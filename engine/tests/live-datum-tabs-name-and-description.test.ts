// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/datum/options.js";
import { cleanUp, definitionOf, mounted, quiet, settled } from "./live-extras-kit.js";

/*
 * Datum's tabs (render/live/datum/tabs.ts): the tab list named by the container's legend, a
 * hidden legend still its name, the description drawn and describing the list, and each panel
 * carrying its tab's label for the print stylesheet to write over it.
 */

afterEach(cleanUp);

async function mountTabs(configuration: Record<string, unknown>) {
  quiet();
  const definition = definitionOf([
    {
      id: "sections",
      type: "tabs",
      configuration: { tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }], ...configuration },
      children: { one: [{ id: "a", type: "text", configuration: { label: "A" } }], two: [{ id: "b", type: "text", configuration: { label: "B" } }] }
    } as ComponentNode
  ]);
  const binding = createDatumBinding();
  const m = await mounted(definition, { binding, datum: binding, features: createDatumFeatures() });
  await settled(m.form);
  return m;
}

const referenced = (root: ShadowRoot, element: Element | null, attribute: string): string =>
  (element?.getAttribute(attribute) ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById(id)?.textContent?.trim() ?? `<missing ${id}>`)
    .join(" ");

describe("live Datum tabs: the tab list's name and description", () => {
  it("names the tab list by the legend and describes it by the description", async () => {
    const { root } = await mountTabs({ label: "Sections", description: "Fill in each section." });
    const list = root.querySelector('[role="tablist"]');
    expect(referenced(root, list, "aria-labelledby")).toBe("Sections");
    expect(referenced(root, list, "aria-describedby")).toBe("Fill in each section.");
  });

  it("keeps a hidden legend as the tab list's name, hidden only from sight", async () => {
    const { root } = await mountTabs({ label: "Sections", hideLabel: true });
    const list = root.querySelector('[role="tablist"]');
    const legend = root.querySelector(".datum-form__tabs-legend") as HTMLElement;
    expect(legend.hidden).toBe(false);
    expect(legend.classList.contains("datum-form__visually-hidden")).toBe(true);
    expect(referenced(root, list, "aria-labelledby")).toBe("Sections");
  });

  it("labels each panel with its tab's name for print, where the strip is not drawn", async () => {
    const { root } = await mountTabs({ label: "Sections" });
    const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'), (panel) => panel.getAttribute("data-tab-label"));
    expect(panels).toEqual(["One", "Two"]);
  });
});
