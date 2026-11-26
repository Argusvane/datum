// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { checkAnswerErrors, previewCheckedAnswers, previewSubmissionAnswers } from "../form-engine/builder/web-component/try-it.js";
import { definitionOf, drawDatum, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

const root = (configuration: Record<string, unknown> = {}): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      {
        id: "dependants",
        type: "dataGrid",
        configuration: { label: "Dependants", minRows: 1, canReorder: true, ...configuration },
        collection: { collectionPath: "dependants" },
        children: { content: [{ id: "dependantName", type: "text", configuration: { label: "Name", required: true } }, { id: "dependantBorn", type: "date", configuration: { label: "Born" } }] }
      }
    ]
  }
});

/** The preview runtime drawn by the Datum binding, as the canvas of a form draws it. */
async function draw(rt: BuilderPreviewRuntime): Promise<ShadowRoot> {
  unmountAll();
  return (await drawDatum(definitionOf([]), {}, { runtime: rt as never })).root;
}

describe("the builder's preview runtime draws a grid's rows", () => {
  it("opens a grid with its starting rows, not typed in, and Try it's checks count them", async () => {
    const rt = new BuilderPreviewRuntime(root());
    const values = rt.state().values;
    expect(Object.keys(values).sort()).toEqual(["dependants[0].dependantBorn", "dependants[0].dependantName"]);
    expect(rt.state().dirty.size).toBe(0);
    const host = await draw(rt);
    expect(host.querySelectorAll(".datum-form__datagrid-row")).toHaveLength(1);
    expect(host.querySelector(".datum-form__datagrid-empty")).toBeNull();
    expect(host.querySelector(".datum-form__datagrid > .datum-form__error")).toBeNull();
    // Try it's answers and checks: one row, no rows.min; its required cell reported.
    expect(previewSubmissionAnswers(rt.formRoot(), values as Record<string, unknown>, () => true)).toEqual({ dependants: [{}] });
    const errors = checkAnswerErrors(rt.formRoot(), previewCheckedAnswers(rt.formRoot(), values as Record<string, unknown>), {
      locale: "en",
      required: rt.requiredMap(),
      hidden: () => false
    });
    expect(errors.map((error) => [error.code, error.path])).toEqual([["required", "dependants[0].dependantName"]]);
  });

  it("adds, moves and removes rows through the renderer's buttons, publishing a repaint", async () => {
    const rt = new BuilderPreviewRuntime(root({ maxRows: 2 }));
    const seen: string[] = [];
    for (const type of [FormEventType.COLLECTION_CHANGED, FormEventType.COMPONENT_CHANGED]) {
      rt.events().subscribe(type, () => seen.push(type));
    }
    rt.setValue("dependants[0].dependantName", "Ada");
    expect(rt.addRow("dependants")).toBe(1);
    expect(() => rt.addRow("dependants")).toThrow(/most rows/);
    rt.setValue("dependants[1].dependantName", "Bea");
    rt.reorderRow("dependants", 1, 0);
    expect(rt.state().values["dependants[0].dependantName"]).toBe("Bea");
    expect(rt.state().values["dependants[1].dependantName"]).toBe("Ada");
    rt.removeRow("dependants", 0);
    expect(Object.keys(rt.state().values).filter((key) => key.startsWith("dependants[")).sort()).toEqual(["dependants[0].dependantBorn", "dependants[0].dependantName"]);
    expect(rt.state().values["dependants[0].dependantName"]).toBe("Ada");
    expect(seen.filter((type) => type === FormEventType.COLLECTION_CHANGED)).toHaveLength(3);
    expect(rt.state().dirty.has("dependants")).toBe(true);
    // Remove down to none (the bound is the buttons'), then Clear answers opens it as it first was.
    rt.removeRow("dependants", 0);
    expect((await draw(rt)).querySelector(".datum-form__datagrid-empty")).not.toBeNull();
    rt.clearValues();
    expect((await draw(rt)).querySelectorAll(".datum-form__datagrid-row")).toHaveLength(1);
  });

  it("drops Try it's errors about the grid when its rows change, and seeds a grid an edit brings", () => {
    const rt = new BuilderPreviewRuntime({ id: "root", type: "form", configuration: {}, children: { content: [] } });
    expect(rt.state().values).toEqual({});
    rt.setFormRoot(root());
    expect(Object.keys(rt.state().values)).toHaveLength(2);
    rt.setErrors([
      { id: "a", code: "rows.min", componentId: "dependants", stage: "x", source: "client", severity: "error" } as never,
      { id: "b", code: "required", componentId: "dependantName", stage: "x", source: "client", severity: "error" } as never,
      { id: "c", code: "required", componentId: "other", stage: "x", source: "client", severity: "error" } as never
    ]);
    rt.addRow("dependants");
    expect(rt.errors().map((error) => error.id)).toEqual(["c"]);
  });
});
