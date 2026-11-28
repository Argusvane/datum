import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintModel, type PrintGrid, type PrintModel } from "../form-engine/render/print/index.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { runtimeOf } from "./live-chrome-harness.js";

/*
 * A column printed only when answered (`print.show: "answered"`) is answered when any row answers
 * it: the column's own component is the rows' template, which holds no answer of its own.
 */

function definition(children: ComponentNode[]): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: children } } } as FormDefinition;
}

const items: ComponentNode = {
  id: "items",
  type: "dataGrid",
  configuration: { label: "Items" },
  collection: { collectionPath: "items" },
  children: {
    content: [
      { id: "qty", type: "number", configuration: { label: "Quantity" } },
      { id: "ref", type: "text", configuration: { label: "Reference", print: { show: "answered" } } }
    ]
  }
};

async function gridOf(runtime: FormRuntime, rendition?: "answers" | "filled" | "blank"): Promise<PrintGrid> {
  const model: PrintModel = await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit }, ...(rendition ? { rendition } : {}) });
  return model.nodes.find((node): node is PrintGrid => node.kind === "grid")!;
}

describe("a collection column printed only when answered", () => {
  it("prints when a row answers it, with every row's cell", async () => {
    const runtime = runtimeOf(definition([items]));
    runtime.setValue("items[0].qty", 3);
    runtime.addRow("items");
    runtime.setValue("items[1].qty", 5);
    runtime.setValue("items[1].ref", "R-2");
    for (const rendition of ["answers", "filled"] as const) {
      const grid = await gridOf(runtime, rendition);
      expect(grid.columns.map((column) => column.label), rendition).toEqual(["Quantity", "Reference"]);
      expect(grid.rows.map((row) => row.cells.map((cell) => cell.empty)), rendition).toEqual([
        [false, true],
        [false, false]
      ]);
    }
  });

  it("is left off when no row answers it", async () => {
    const runtime = runtimeOf(definition([items]));
    runtime.setValue("items[0].qty", 3);
    const grid = await gridOf(runtime);
    expect(grid.columns.map((column) => column.label)).toEqual(["Quantity"]);
  });

  it("prints on a blank form, as on screen", async () => {
    const runtime = runtimeOf(definition([items]));
    const grid = await gridOf(runtime, "blank");
    expect(grid.columns.map((column) => column.label)).toEqual(["Quantity", "Reference"]);
  });
});
