import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { rowModelsByValuePath } from "../form-engine/render/core/error-wording.js";

/*
 * Three small runtime calls the renderer reads: a collection entry's stable key, the date a
 * set of boxes composes, and what a journey page's action comes to.
 */

function runtimeOf(content: ComponentNode[], extra: Partial<FormDefinition> = {}): FormRuntime {
  const form: FormDefinition = {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content } },
    ...extra
  };
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(form.root))])
  });
}

const grid = (configuration: Record<string, unknown> = {}): ComponentNode => ({
  id: "items",
  type: "dataGrid",
  configuration: { label: "Items", initialRows: 0, canReorder: true, ...configuration },
  collection: { collectionPath: "items" },
  children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
});

describe("collection entry keys", () => {
  it("gives each added row its own key and keeps it while the rows around it change", () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRow("items", { sku: "A" });
    runtime.addRow("items", { sku: "B" });
    runtime.addRow("items", { sku: "C" });
    const [a, b, c] = runtime.entryKeys("items");
    expect(new Set([a, b, c]).size).toBe(3);

    runtime.removeRow("items", 0);
    expect(runtime.entryKeys("items")).toEqual([b, c]);

    runtime.addRow("items", { sku: "D" });
    const keys = runtime.entryKeys("items");
    expect(keys.slice(0, 2)).toEqual([b, c]);
    expect([a, b, c]).not.toContain(keys[2]);
  });

  it("moves a key with its row", () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }, { sku: "C" }]);
    const [a, b, c] = runtime.entryKeys("items");
    runtime.reorderRow("items", 0, 2);
    expect(runtime.entryKeys("items")).toEqual([b, c, a]);
    expect(runtime.rows("items").map((row) => row.sku)).toEqual(["B", "C", "A"]);
    runtime.reorderRow("items", 2, 0);
    expect(runtime.entryKeys("items")).toEqual([a, b, c]);
  });

  it("keeps a row's key when one of its answers is edited", () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }]);
    const before = runtime.entryKeys("items");
    runtime.setValue("items[1].sku", "Z");
    expect(runtime.entryKeys("items")).toEqual(before);
  });

  it("keys again a list put in whole, and a draft put back", async () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }]);
    const first = runtime.entryKeys("items");
    runtime.setValues({ items: [{ sku: "X" }, { sku: "Y" }] });
    const second = runtime.entryKeys("items");
    expect(second).toHaveLength(2);
    expect(second.some((key) => first.includes(key))).toBe(false);

    await runtime.hydrateFromDraft({
      id: "d",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "0.1.0" },
      values: { "items[0].sku": "P", "items[1].sku": "Q", "items[2].sku": "R" },
      locale: "en",
      state: { touched: [], dirty: [] },
      updatedAt: 0
    });
    const third = runtime.entryKeys("items");
    expect(third).toHaveLength(3);
    expect(third.some((key) => first.includes(key) || second.includes(key))).toBe(false);
  });

  it("never puts a key in the answers", () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }]);
    const keys = runtime.entryKeys("items");
    const stored = JSON.stringify([runtime.state().values, runtime.rows("items"), runtime.submittableValues()]);
    for (const key of keys) {
      expect(stored).not.toContain(key);
    }
  });

  it("reports the keys of every collection, and none for a form without one", () => {
    expect(runtimeOf([{ id: "name", type: "text", configuration: {} }]).entryKeysByCollection().size).toBe(0);
    const runtime = runtimeOf([grid()]);
    runtime.addRow("items");
    expect([...runtime.entryKeysByCollection().keys()]).toEqual(["items"]);
    expect(runtime.entryKeysByCollection().get("items")).toEqual(runtime.entryKeys("items"));
  });

  it("carries the key on the row models, the same for every model of one entry", async () => {
    const runtime = runtimeOf([grid()]);
    runtime.addRows("items", [{ sku: "A" }, { sku: "B" }]);
    const keysBefore = runtime.entryKeys("items");
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    const owner = output.components.find((model) => model.id === "items");
    expect(owner?.rows?.entries.map((entry) => entry.map((model) => model.row?.rowKey))).toEqual([
      [keysBefore[0]],
      [keysBefore[1]]
    ]);
    expect(rowModelsByValuePath(output).get("items[1].sku")?.row?.rowKey).toBe(keysBefore[1]);

    // The row that was second is first after the first is removed, and keeps its key.
    runtime.removeRow("items", 0);
    const after = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(rowModelsByValuePath(after).get("items[0].sku")?.row).toMatchObject({ index: 0, rowKey: keysBefore[1] });
    // The template children outside the rows carry no scope.
    expect(after.components.find((model) => model.id === "sku")?.row).toBeUndefined();
  });
});

describe("setDateParts", () => {
  const born = (): FormRuntime => runtimeOf([{ id: "born", type: "date", configuration: {} }]);

  it("composes a whole date as YYYY-MM-DD, padding the month and day, and stores no year typed short", () => {
    const runtime = born();
    expect(runtime.setDateParts("born", { year: "2026", month: "2", day: "5" })).toBe("2026-02-05");
    expect(runtime.state().values.born).toBe("2026-02-05");
    expect(runtime.inputState("born")).toBeUndefined();
    // A year of fewer than four digits is not padded: nothing is stored and the state says so.
    runtime.setDateParts("born", { year: "987", month: "12", day: "31" });
    expect(runtime.state().values.born).toBe("");
    expect(runtime.inputState("born")).toEqual({ shortYear: true });
    runtime.setDateParts("born", { year: "0987", month: "12", day: "31" });
    expect(runtime.state().values.born).toBe("0987-12-31");
    expect(runtime.inputState("born")).toBeUndefined();
  });

  it("stores the empty string for a date in part and records the parts still missing", () => {
    const runtime = born();
    runtime.setDateParts("born", { year: "2026", month: "", day: "" });
    expect(runtime.state().values.born ?? "").toBe("");
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["day", "month"] } });
    runtime.setDateParts("born", { year: "2026", month: "2", day: "" });
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["day"] } });
    // Whole again: stored, and nothing recorded.
    runtime.setDateParts("born", { year: "2026", month: "2", day: "9" });
    expect(runtime.state().values.born).toBe("2026-02-09");
    expect(runtime.inputState("born")).toBeUndefined();
  });

  it("clears an answer when a part is emptied, and records nothing for all three empty", () => {
    const runtime = born();
    runtime.setDateParts("born", { year: "2026", month: "2", day: "9" });
    runtime.setDateParts("born", { year: "2026", month: "2", day: "  " });
    expect(runtime.state().values.born).toBe("");
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["day"] } });
    runtime.setDateParts("born", { year: "", month: "", day: "" });
    expect(runtime.inputState("born")).toBeUndefined();
  });

  it("reads a month typed as a name, in English and in the form's language", () => {
    const runtime = born();
    runtime.setDateParts("born", { year: "2026", month: "Feb", day: "5" });
    expect(runtime.state().values.born).toBe("2026-02-05");
    runtime.setDateParts("born", { year: "2026", month: "September", day: "5" });
    expect(runtime.state().values.born).toBe("2026-09-05");

    const french = runtimeOf([{ id: "born", type: "date", configuration: {} }], {
      localization: { defaultLocale: "fr", supportedLocales: [{ code: "fr", label: "Français" }] }
    });
    french.setDateParts("born", { year: "2026", month: "février", day: "5" });
    expect(french.state().values.born).toBe("2026-02-05");
  });

  it("keeps a month name it cannot read as typed, for validation to refuse", () => {
    const runtime = born();
    runtime.setDateParts("born", { year: "2026", month: "Smarch", day: "5" });
    expect(runtime.state().values.born).toBe("2026-Smarch-05");
  });

  it("writes only when the answer changes", () => {
    const runtime = born();
    let changes = 0;
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, () => {
      changes += 1;
    });
    runtime.setDateParts("born", { year: "2026", month: "2", day: "5" });
    const written = changes;
    expect(written).toBeGreaterThan(0);
    runtime.setDateParts("born", { year: "2026", month: "02", day: "05" });
    expect(changes).toBe(written);
  });

  it("composes a date in a row of a collection", () => {
    const runtime = runtimeOf([
      {
        id: "people",
        type: "dataGrid",
        configuration: { label: "People", initialRows: 0 },
        collection: { collectionPath: "people" },
        children: { content: [{ id: "dob", type: "date", configuration: {} }] }
      }
    ]);
    runtime.addRows("people", [{}, {}]);
    runtime.setDateParts("people[1].dob", { year: "2001", month: "3", day: "4" });
    expect(runtime.rows("people").map((row) => row.dob)).toEqual([undefined, "2001-03-04"]);
  });

  it("makes validation name the missing parts of a date typed in part", async () => {
    const runtime = born();
    runtime.setDateParts("born", { year: "2026", month: "", day: "4" });
    const errors = await runtime.validate();
    expect(errors.map((error) => error.code)).toContain("dateIncomplete");
  });
});

describe("journeyAction", () => {
  const journey: Journey = { id: "apply", validation: { continue: "page" }, pages: [{ id: "one", components: ["a"] }, { id: "two", components: ["b"] }] };
  const pageOf = (runtime: FormRuntime) => {
    const view = runtime.journeyView();
    if (!view) throw new Error("no journey page");
    return { ...view, kind: view.kind as string, final: view.final, hasOwnSubmit: false, pending: undefined };
  };

  function started(content?: ComponentNode[], extraJourney: Journey = journey): FormRuntime {
    const runtime = runtimeOf(
      content ?? [
        { id: "a", type: "text", configuration: { required: true } },
        { id: "b", type: "text", configuration: {} }
      ],
      { journey: { journeys: [extraJourney] } }
    );
    runtime.startJourney("apply");
    return runtime;
  }

  it("moves on with Continue and says what stopped it", async () => {
    const runtime = started();
    const refused = await runtime.journeyAction({ journeyId: "apply", pageId: "one", kind: "questions", final: false, hasOwnSubmit: false, pending: undefined });
    expect(refused.kind).toBe("moved");
    expect(refused.kind === "moved" && refused.result.ok).toBe(false);
    expect(runtime.journeyView()?.pageId).toBe("one");

    runtime.setValue("a", "x");
    const moved = await runtime.journeyAction({ journeyId: "apply", pageId: "one", kind: "questions", final: false, hasOwnSubmit: false, pending: undefined });
    expect(moved.kind === "moved" && moved.result.ok).toBe(true);
    expect(runtime.journeyView()?.pageId).toBe("two");
  });

  it("on the last page names the journey, the page and the submittable answers", async () => {
    const runtime = started([
      { id: "a", type: "text", configuration: {} },
      { id: "b", type: "text", configuration: {} }
    ]);
    runtime.setValue("a", "x");
    runtime.setValue("b", "y");
    await runtime.nextPage();
    const outcome = await runtime.journeyAction(pageOf(runtime));
    expect(outcome).toEqual({ kind: "submit", journeyId: "apply", pageId: "two", values: runtime.submittableValues() });
    expect(outcome.kind === "submit" && outcome.values).toMatchObject({ a: "x", b: "y" });
  });

  it("on a last page with a submit or download button of its own, leaves the press to it", async () => {
    const runtime = started();
    runtime.setValue("a", "x");
    await runtime.nextPage();
    expect(await runtime.journeyAction({ ...pageOf(runtime), hasOwnSubmit: true })).toEqual({ kind: "own-submit" });
  });

  it("does nothing on an exit page or while a server check is out", async () => {
    const runtime = started();
    expect(await runtime.journeyAction({ journeyId: "apply", pageId: "one", kind: "exit", final: true, hasOwnSubmit: false, pending: undefined })).toEqual({ kind: "idle" });
    expect(await runtime.journeyAction({ journeyId: "apply", pageId: "one", kind: "questions", final: false, hasOwnSubmit: false, pending: "page" })).toEqual({ kind: "idle" });
    expect(runtime.journeyView()?.pageId).toBe("one");
  });
});
