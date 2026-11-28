// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { FormError } from "../form-engine/core/errors/form-error.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { stringifyComponentPath } from "../form-engine/core/tree/component-path.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/datum/options.js";
import { cleanUp, definitionOf, mounted, quiet, runtimeOf, settled } from "./live-extras-kit.js";

/*
 * Continue in a steps container drawn in a data grid's row checks the step in that row alone
 * (`validate({ scope, entry })`): only that row's answers are checked, only its stored errors are
 * replaced, and the errors shown in the other rows stay as they were.
 */

afterEach(cleanUp);

const steps: ComponentNode = {
  id: "wizard",
  type: "steps",
  configuration: { label: "Steps" },
  children: {
    content: [
      { id: "s1", type: "step", configuration: { label: "One" }, children: { content: [{ id: "x", type: "text", configuration: { label: "X", required: true } }] } },
      { id: "s2", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "y", type: "text", configuration: { label: "Y", required: true } }] } }
    ]
  }
};

function definition() {
  return definitionOf([
    { id: "title", type: "text", configuration: { label: "Title", required: true } },
    {
      id: "orders",
      type: "dataGrid",
      configuration: { label: "Orders", initialRows: 0, layout: "stacked" },
      collection: { collectionPath: "orders" },
      children: { content: [{ id: "ref", type: "text", configuration: { label: "Ref" } }, steps] }
    } as ComponentNode
  ]);
}

const pathsOf = (errors: readonly FormError[]): string[] => errors.map((error) => (error.path !== undefined ? stringifyComponentPath(error.path) : `#${error.componentId ?? ""}`));

async function mountGrid() {
  quiet();
  const form = definition();
  const runtime = runtimeOf(form);
  runtime.addRows("orders", [{ ref: "A" }, { ref: "B" }]);
  const binding = createDatumBinding();
  const m = await mounted(form, { runtime, binding, datum: binding, features: createDatumFeatures() });
  await settled(m.form);
  const rows = (): HTMLElement[] => Array.from(m.root.querySelectorAll<HTMLElement>("[data-row-index]"));
  const invalidIn = (row: HTMLElement): string[] =>
    Array.from(row.querySelectorAll<HTMLElement>(".datum-live-field"))
      .filter((field) => field.querySelector('[aria-invalid="true"]') !== null)
      .map((field) => field.getAttribute("data-component-id") ?? "");
  const proceed = async (index: number): Promise<void> => {
    (rows()[index]?.querySelector("[data-step-next]") as HTMLElement).click();
    for (let round = 0; round < 3; round += 1) {
      await settled(m.form);
    }
  };
  return { ...m, runtime, rows, invalidIn, proceed };
}

describe("Continue in a steps container in a data grid row", () => {
  it("shows only its own row's errors", async () => {
    const { runtime, rows, invalidIn, proceed } = await mountGrid();
    await proceed(1);
    expect(pathsOf(runtime.errors())).toEqual(["orders[1].x"]);
    expect(invalidIn(rows()[1] as HTMLElement)).toEqual(["x"]);
    expect(invalidIn(rows()[0] as HTMLElement)).toEqual([]);
  });

  it("leaves the errors already shown in another row as they were", async () => {
    const { form, runtime, rows, invalidIn, proceed } = await mountGrid();
    await proceed(0);
    expect(pathsOf(runtime.errors())).toEqual(["orders[0].x"]);
    expect(invalidIn(rows()[0] as HTMLElement)).toEqual(["x"]);
    runtime.setValue("orders[1].x", "filled");
    await settled(form);
    await proceed(1);
    // Row 1 is clean and moves on; row 0's error stays shown.
    expect(pathsOf(runtime.errors())).toEqual(["orders[0].x"]);
    expect(invalidIn(rows()[0] as HTMLElement)).toEqual(["x"]);
    expect(invalidIn(rows()[1] as HTMLElement)).toEqual([]);
    expect(Array.from((rows()[1] as HTMLElement).querySelectorAll<HTMLElement>("[data-step-panel]")).filter((panel) => !panel.hidden).map((panel) => panel.getAttribute("data-step-panel"))).toEqual(["s2"]);
  });
});

describe("validate({ scope, entry })", () => {
  it("checks the scope's answers in that entry alone and replaces only the stored errors there", async () => {
    const runtime = runtimeOf(definition());
    runtime.addRows("orders", [{ ref: "A" }, { ref: "B" }]);
    await runtime.validate();
    const before = pathsOf(runtime.errors());
    expect([...before].sort()).toEqual(["orders[0].x", "orders[0].y", "orders[1].x", "orders[1].y", "title"]);

    expect(pathsOf(await runtime.validate({ scope: "s1", entry: "orders[1]" }))).toEqual(before);
    // Nothing changed: the entry's error is found again in its place.
    expect(pathsOf(runtime.errors())).toEqual(before);

    runtime.setValue("orders[1].x", "filled");
    // Row 1's x is clean; the title, row 0's x and both rows' y (another step) are left as they were.
    expect(pathsOf(await runtime.validate({ scope: "s1", entry: "orders[1]" }))).toEqual(before.filter((path) => path !== "orders[1].x"));
  });

  it("does not take `orders[10]` for an answer of `orders[1]`", async () => {
    const runtime = runtimeOf(definition());
    runtime.addRows("orders", Array.from({ length: 11 }, () => ({})));
    await runtime.validate({ scope: "s1", entry: "orders[1]" });
    expect(pathsOf(runtime.errors())).toEqual(["orders[1].x"]);
  });

  it("counts the entry's answers in the scope as continued from, and not the same answers in other entries", async () => {
    const runtime = runtimeOf(definition());
    runtime.addRows("orders", [{ x: "a" }, { x: "b" }]);
    await runtime.validate({ scope: "s1", entry: "orders[1]" });
    expect(runtime.errors()).toEqual([]);
    runtime.setValue("orders[1].x", "");
    runtime.setValue("orders[0].x", "");
    // A field left after its answer changed is checked when it counts as continued from.
    await runtime.validatePath("orders[1].x");
    await runtime.validatePath("orders[0].x");
    expect(pathsOf(runtime.errors())).toEqual(["orders[1].x"]);
  });

  it("leaves a form-level scoped run replacing the whole store", async () => {
    const runtime = runtimeOf(definition());
    runtime.addRows("orders", [{}, {}]);
    await runtime.validate();
    expect(runtime.errors().length).toBeGreaterThan(2);
    await runtime.validate({ scope: "s1" });
    expect(pathsOf(runtime.errors())).toEqual(["orders[0].x", "orders[1].x"]);
  });
});
