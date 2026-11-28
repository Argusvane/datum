// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/datum/options.js";
import { cleanUp, definitionOf, mounted, quiet, runtimeOf, settled } from "./live-extras-kit.js";

/*
 * A tabs or steps container drawn in each row of a data grid (render/live/tabs.ts, steps.ts,
 * datum/tabs.ts): every row's copy has its own ids, its own open tab or step, and opens for a
 * field of its own row only.
 */

afterEach(cleanUp);

function duplicateIds(root: ShadowRoot): string[] {
  const seen = new Map<string, number>();
  for (const element of Array.from(root.querySelectorAll("[id]"))) {
    seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
}

function danglingReferences(root: ShadowRoot): string[] {
  const out: string[] = [];
  for (const element of Array.from(root.querySelectorAll("[aria-controls],[aria-labelledby],[aria-describedby]"))) {
    for (const attribute of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
      for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
        if (root.getElementById(id) === null) {
          out.push(`${attribute}->${id}`);
        }
      }
    }
  }
  return out;
}

async function mountGrid(inner: ComponentNode) {
  quiet();
  const definition = definitionOf([
    {
      id: "orders",
      type: "dataGrid",
      configuration: { label: "Orders", initialRows: 0, layout: "stacked" },
      collection: { collectionPath: "orders" },
      children: { content: [{ id: "ref", type: "text", configuration: { label: "Ref" } }, inner] }
    } as ComponentNode
  ]);
  const runtime = runtimeOf(definition);
  runtime.addRows("orders", [{ ref: "A" }, { ref: "B" }]);
  const binding = createDatumBinding();
  const m = await mounted(definition, { runtime, binding, datum: binding, features: createDatumFeatures() });
  await settled(m.form);
  const rows = (): HTMLElement[] => Array.from(m.root.querySelectorAll<HTMLElement>("[data-row-index]"));
  return { ...m, rows };
}

describe("live tabs in data grid rows", () => {
  const tabs: ComponentNode = {
    id: "sections",
    type: "tabs",
    configuration: { label: "Sections", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
    children: { one: [{ id: "a", type: "text", configuration: { label: "A" } }], two: [{ id: "b", type: "text", configuration: { label: "B" } }] }
  };

  const tabsIn = (row: HTMLElement): HTMLElement[] => Array.from(row.querySelectorAll<HTMLElement>('[role="tab"]'));
  const selected = (row: HTMLElement): string[] => tabsIn(row).map((tab) => tab.getAttribute("aria-selected") ?? "");

  it("gives every row's tabs and panels their own ids, each tab controlling its own row's panel", async () => {
    const { root, rows } = await mountGrid(tabs);
    expect(rows()).toHaveLength(2);
    expect(duplicateIds(root)).toEqual([]);
    expect(danglingReferences(root)).toEqual([]);
    for (const row of rows()) {
      for (const tab of tabsIn(row)) {
        expect(row.contains(root.getElementById(tab.getAttribute("aria-controls") ?? ""))).toBe(true);
      }
    }
  });

  it("keeps the tab chosen in one row to that row", async () => {
    const { form, rows } = await mountGrid(tabs);
    tabsIn(rows()[1] as HTMLElement)[1]?.click();
    await settled(form);
    expect(selected(rows()[0] as HTMLElement)).toEqual(["true", "false"]);
    expect(selected(rows()[1] as HTMLElement)).toEqual(["false", "true"]);
  });

  it("moves between a row's own tabs with the arrow keys", async () => {
    const { root, form, rows } = await mountGrid(tabs);
    const first = tabsIn(rows()[1] as HTMLElement)[0] as HTMLElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true, cancelable: true }));
    await settled(form);
    expect(selected(rows()[0] as HTMLElement)).toEqual(["true", "false"]);
    expect(selected(rows()[1] as HTMLElement)).toEqual(["false", "true"]);
    expect(root.activeElement).toBe(tabsIn(rows()[1] as HTMLElement)[1]);
  });

  it("opens only the row's own tab for a field in it", async () => {
    const { root, form, rows } = await mountGrid(tabs);
    const field = Array.from(root.querySelectorAll<HTMLElement>('.datum-live-field[data-component-id="b"]')).find((wrapper) => (rows()[1] as HTMLElement).contains(wrapper));
    const key = field?.getAttribute("data-instance") ?? "";
    expect(form.focusField(key)).toBe(true);
    await settled(form);
    expect(selected(rows()[0] as HTMLElement)).toEqual(["true", "false"]);
    expect(selected(rows()[1] as HTMLElement)).toEqual(["false", "true"]);
  });
});

describe("live steps in data grid rows", () => {
  const steps: ComponentNode = {
    id: "wizard",
    type: "steps",
    configuration: { label: "Steps" },
    children: {
      content: [
        { id: "s1", type: "step", configuration: { label: "One" }, children: { content: [{ id: "x", type: "text", configuration: { label: "X" } }] } },
        { id: "s2", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "y", type: "text", configuration: { label: "Y" } }] } }
      ]
    }
  };

  const shown = (row: HTMLElement): string[] => Array.from(row.querySelectorAll<HTMLElement>("[data-step-panel]")).filter((panel) => !panel.hidden).map((panel) => panel.getAttribute("data-step-panel") ?? "");

  it("gives every row's steps their own ids", async () => {
    const { root } = await mountGrid(steps);
    expect(duplicateIds(root)).toEqual([]);
    expect(danglingReferences(root)).toEqual([]);
  });

  it("moves only the row whose Continue was pressed, and focuses that row's step heading", async () => {
    const { root, form, runtime, rows } = await mountGrid(steps);
    (rows()[1]?.querySelector("[data-step-next]") as HTMLElement).click();
    for (let round = 0; round < 3; round += 1) {
      await settled(form);
    }
    expect(shown(rows()[0] as HTMLElement)).toEqual(["s1"]);
    expect(shown(rows()[1] as HTMLElement)).toEqual(["s2"]);
    const active = root.activeElement as HTMLElement | null;
    expect(active?.classList.contains("datum-form__step-heading")).toBe(true);
    expect((rows()[1] as HTMLElement).contains(active)).toBe(true);
    // The form's own step sequence is not moved by a row's container.
    expect(runtime.state().navigation.currentStepId).not.toBe("s2");
    (rows()[1]?.querySelector("[data-step-prev]") as HTMLElement).click();
    for (let round = 0; round < 3; round += 1) {
      await settled(form);
    }
    expect(shown(rows()[1] as HTMLElement)).toEqual(["s1"]);
  });

  it("holds a row's Continue on that row's errors alone", async () => {
    const required: ComponentNode = {
      ...steps,
      children: {
        content: [
          { id: "s1", type: "step", configuration: { label: "One" }, children: { content: [{ id: "x", type: "text", configuration: { label: "X", required: true } }] } },
          { id: "s2", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "y", type: "text", configuration: { label: "Y" } }] } }
        ]
      }
    };
    const { form, runtime, rows } = await mountGrid(required);
    runtime.setValue("orders[0].x", "filled");
    await settled(form);
    (rows()[1]?.querySelector("[data-step-next]") as HTMLElement).click();
    for (let round = 0; round < 3; round += 1) {
      await settled(form);
    }
    expect(shown(rows()[1] as HTMLElement)).toEqual(["s1"]);
    (rows()[0]?.querySelector("[data-step-next]") as HTMLElement).click();
    for (let round = 0; round < 3; round += 1) {
      await settled(form);
    }
    expect(shown(rows()[0] as HTMLElement)).toEqual(["s2"]);
    expect(shown(rows()[1] as HTMLElement)).toEqual(["s1"]);
  });
});
