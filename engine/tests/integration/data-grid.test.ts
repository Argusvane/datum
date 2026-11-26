import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import type { FormDraft } from "../../form-engine/persistence/core/draft-store.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { runKernel } from "../../form-engine/validation/wasm/portable-kernel.js";
import { normalizeDataGrids } from "../../form-engine/core/schema/data-grid.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { ServerValidationRunner } from "../../form-engine/validation/server/server-validation.js";
import { createEnginePreviewRuntime } from "../../form-engine/builder/journey-designer/journey-preview.js";
import { checkAnswerErrors, previewCheckedAnswers, previewSubmissionAnswers } from "../../form-engine/builder/web-component/try-it.js";

/**
 * A data grid at the runtime: its rows are a collection's entries —
 * seeded, kept across a draft, added, removed and moved through the runtime, worked out per row
 * and counted alike in the browser and in the kernel.
 */

const grid = (configuration: Record<string, unknown> = {}, children?: ComponentNode[]): ComponentNode => ({
  id: "items",
  type: "dataGrid",
  configuration: { label: "Items", ...configuration },
  collection: { collectionPath: "items" },
  children: {
    content: children ?? [
      { id: "qty", type: "number", configuration: { label: "Quantity" } },
      { id: "price", type: "number", configuration: { label: "Price" } },
      { id: "total", type: "number", configuration: { label: "Total", readOnly: true }, rules: { value: "row.qty * row.price" } }
    ]
  }
});

function form(node: ComponentNode): FormDefinition {
  const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [node] } };
  return { id: "f1", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

function runtime(node: ComponentNode, validate = false): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate, sign: false, serverValidation: false });
  const definition = form(node);
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline(validate ? [createFieldConstraintsStage(normalizeDataGrids(definition.root))] : []),
    versionContext: { formVersion: "1", schemaVersion: "1", rendererVersion: "1" }
  });
}

const clientCtx = () => ({
  form: { id: "f1", version: "1" },
  client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
});

const keysOf = (rt: FormRuntime, prefix: string) => Object.keys(rt.state().values).filter((key) => key.startsWith(prefix)).sort();

describe("a data grid's rows in the runtime", () => {
  it("opens with its starting rows: empty entries holding a key per field, not marked as typed in", () => {
    const rt = runtime(grid({ initialRows: 2 }));
    expect(rt.rows("items")).toHaveLength(2);
    expect(keysOf(rt, "items[")).toEqual(["items[0].price", "items[0].qty", "items[0].total", "items[1].price", "items[1].qty", "items[1].total"]);
    expect(rt.state().values["items[0].qty"]).toBeUndefined();
    expect(rt.state().dirty.size).toBe(0);
    // A grid that starts with none, and a repeating section (not a grid), open empty.
    expect(runtime(grid({ initialRows: 0 })).rows("items")).toHaveLength(0);
    expect(
      runtime({ id: "s", type: "fieldset", configuration: {}, collection: { collectionPath: "s" }, children: { content: [{ id: "n", type: "text", configuration: {} }] } }).rows("s")
    ).toHaveLength(0);
  });

  it("offers the operations its configuration allows, and nothing else", () => {
    const plain = runtime(grid());
    expect(() => plain.reorderRow("items", 0, 0)).toThrow(/does not allow reordering/);
    const locked = runtime(grid({ canAdd: false, canRemove: false, canReorder: true }));
    expect(() => locked.addRow("items")).toThrow(/does not allow adding/);
    expect(() => locked.removeRow("items", 0)).toThrow(/does not allow removing/);
    locked.setValue("items[0].qty", 1);
    expect(() => locked.reorderRow("items", 0, 0)).not.toThrow();
  });

  it("adds, removes and moves rows, keeping every row's keys and reporting each as one settled change", () => {
    const rt = runtime(grid({ canReorder: true }));
    const changes: Array<{ path: string; value: unknown }> = [];
    const order: string[] = [];
    rt.events().subscribe("COMPONENT_CHANGED", (event) => {
      changes.push({ path: event.path?.segments.map((segment) => segment.key).join(".") ?? "", value: (event.data as { value?: unknown }).value });
      order.push("changed");
    });
    rt.events().subscribe("RECOMPUTE_COMPLETED", () => order.push("recomputed"));
    expect(rt.addRow("items")).toBe(1);
    expect(changes).toEqual([{ path: "items", value: [{ qty: undefined, price: undefined, total: undefined }, { qty: undefined, price: undefined, total: undefined }] }]);
    // Published once the recompute after it has worked the rows out.
    expect(order).toEqual(["recomputed", "changed"]);
    rt.setValues({ "items[0].qty": 1, "items[1].qty": 2 });
    rt.reorderRow("items", 1, 0);
    expect([rt.state().values["items[0].qty"], rt.state().values["items[1].qty"]]).toEqual([2, 1]);
    rt.removeRow("items", 0);
    expect(rt.rows("items")).toHaveLength(1);
    expect(rt.state().values["items[0].qty"]).toBe(1);
    expect(keysOf(rt, "items[1]")).toEqual([]);
  });

  it("works a calculation out once per row, with the row's answers, its place and the row count, at the row's key", () => {
    const rt = runtime(
      grid({}, [
        { id: "qty", type: "number", configuration: {} },
        { id: "price", type: "number", configuration: {} },
        { id: "total", type: "number", configuration: {}, rules: { value: "row.qty * row.price" } },
        { id: "place", type: "text", configuration: {}, rules: { value: 'concat(rowIndex(), " of ", rowCount())' } }
      ])
    );
    rt.addRow("items");
    rt.setValues({ "items[0].qty": 2, "items[0].price": 3, "items[1].qty": 4, "items[1].price": 5 });
    const values = rt.state().values;
    expect(values["items[0].total"]).toBe(6);
    expect(values["items[1].total"]).toBe(20);
    expect(values["items[0].place"]).toBe("1 of 2");
    expect(values["items[1].place"]).toBe("2 of 2");
    // Nothing lands at the bare path a row field has: row fields live at their row's path.
    expect("total" in values).toBe(false);
    rt.removeRow("items", 0);
    expect(rt.state().values["items[0].total"]).toBe(20);
    expect(rt.state().values["items[0].place"]).toBe("1 of 1");
  });

  it("holds the row count to its bounds in the browser, an empty row counted", async () => {
    const rt = runtime(grid({ minRows: 2, maxRows: 3 }, [{ id: "note", type: "text", configuration: {} }]), true);
    // The starting rows are kept within the bounds: two, empty.
    expect(rt.rows("items")).toHaveLength(2);
    expect(await rt.validate()).toEqual([]);
    rt.removeRow("items", 1);
    let errors = await rt.validate();
    expect(errors.map((error) => [error.code, error.componentId, error.parameters])).toEqual([["rows.min", "items", { min: 2, count: 1 }]]);
    rt.addRow("items");
    rt.addRow("items");
    expect(await rt.validate()).toEqual([]);
    // Add stops at the maximum, as the button does; a prefill may still write past it.
    expect(() => rt.addRow("items")).toThrow(/holds the most rows it may \(3\)/);
    expect(() => rt.addRows("items", [{}])).toThrow(/most rows/);
    rt.setValues({ "items[3].note": "fourth" });
    errors = await rt.validate();
    expect(errors.map((error) => [error.code, error.parameters])).toEqual([["rows.max", { max: 3, count: 4 }]]);
  });

  it("stops Add at the most rows any collection holds, a repeating section too", () => {
    const section = runtime({ id: "s", type: "fieldset", configuration: {}, collection: { collectionPath: "s" }, children: { content: [{ id: "n", type: "text", configuration: {} }] } });
    section.addRows("s", Array.from({ length: 500 }, () => ({})));
    expect(() => section.addRow("s")).toThrow(/most rows it may \(500\)/);
  });

  it("sends every drawn row, an empty one posted whole, so the kernel counts what the browser did", async () => {
    const node = grid({ minRows: 3 }, [{ id: "note", type: "text", configuration: {} }]);
    const rt = runtime(node);
    // Three starting rows (the minimum); the person removes one and fills the second.
    rt.removeRow("items", 2);
    rt.setValue("items[1].note", "second");
    const result = await rt.submit("m", clientCtx());
    expect(result.accepted).toBe(true);
    const values = result.canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(values.items).toEqual([{}, { note: "second" }]);
    expect(Object.keys(values).filter((key) => key.startsWith("items["))).toEqual([]);
    // The kernel reads the same two rows, and refuses them against a minimum of three as the browser does.
    const outcome = runKernel({ formId: "f1", values, locale: "en", form: form(node).root }, []);
    expect(outcome.errors.filter((error) => error.code === "rows.min").map((error) => error.parameters)).toEqual([{ min: 3, count: 2 }]);

    // Rows that all hold an answer travel as a list too: one shape for every collection.
    const full = runtime(grid({}, [{ id: "note", type: "text", configuration: {} }]));
    full.setValue("items[0].note", "only");
    const sent = (await full.submit("m", clientCtx())).canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(sent).toEqual({ items: [{ note: "only" }] });
  });

  it("keeps the rows a draft holds, and opens a grid the draft left empty with its starting rows", async () => {
    const rt = runtime(grid({ initialRows: 1 }, [{ id: "note", type: "text", configuration: {} }]));
    const draft = (values: Record<string, unknown>): FormDraft => ({
      id: "d",
      formId: "f1",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1" },
      locale: "en",
      values,
      state: { touched: [], dirty: [] },
      updatedAt: 0
    });
    await rt.hydrateFromDraft(draft({ "items[0].note": "a", "items[2].note": "c" }));
    expect(rt.rows("items").map((row) => row.note)).toEqual(["a", undefined, "c"]);
    expect(keysOf(rt, "items[1]")).toEqual(["items[1].note"]);
    await rt.hydrateFromDraft(draft({}));
    expect(rt.rows("items")).toHaveLength(1);
    expect(keysOf(rt, "items[")).toEqual(["items[0].note"]);
  });

  it("gives rows a prefill writes past the last one a key per field", () => {
    const rt = runtime(grid({ initialRows: 1 }, [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {} }]));
    rt.setValues({ "items[2].a": "x" });
    expect(rt.rows("items")).toHaveLength(3);
    expect(keysOf(rt, "items[")).toEqual(["items[0].a", "items[0].b", "items[1].a", "items[1].b", "items[2].a", "items[2].b"]);
  });

  it("posts a plain repeating section's entries as one list too, and the kernel reads the same entries", async () => {
    const section: ComponentNode = {
      id: "contacts",
      type: "fieldset",
      configuration: {},
      collection: { collectionPath: "contacts" },
      children: { content: [{ id: "name", type: "text", configuration: { required: true } }, { id: "phone", type: "text", configuration: {} }] }
    };
    const rt = runtime(section, true);
    rt.addRow("contacts", { name: "Ada" });
    rt.addRow("contacts", { name: "Grace", phone: "555" });
    const result = await rt.submit("m", clientCtx());
    expect(result.accepted).toBe(true);
    const values = result.canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(values).toEqual({ contacts: [{ name: "Ada" }, { name: "Grace", phone: "555" }] });
    const outcome = runKernel({ formId: "f1", values, locale: "en", form: form(section).root }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ "contacts[0].name": "Ada", "contacts[1].name": "Grace", "contacts[1].phone": "555" });
  });

  it("posts an empty list for a collection with no row drawn, which the kernel reads as no rows", async () => {
    const node = grid({ initialRows: 0 }, [{ id: "note", type: "text", configuration: {} }]);
    const rt = runtime(node);
    const result = await rt.submit("m", clientCtx());
    const values = result.canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(values).toEqual({ items: [] });
    // The kernel takes the empty list (no rows, no key), refusing nothing for it.
    const outcome = runKernel({ formId: "f1", values, locale: "en", form: form(node).root }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({});
    // And counts it against a minimum as the browser does.
    const bounded = grid({ initialRows: 0, minRows: 1 }, [{ id: "note", type: "text", configuration: {} }]);
    const counted = runKernel({ formId: "f1", values: { items: [] }, locale: "en", form: form(bounded).root }, []);
    expect(counted.errors.map((error) => [error.code, error.parameters])).toEqual([["rows.min", { min: 1, count: 0 }]]);
  });

  it("leaves the answers of a form with no collection as they always were", async () => {
    const rt = runtime({ id: "name", type: "text", configuration: {} });
    rt.setValue("name", "Ada");
    const values = (await rt.submit("m", clientCtx())).canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(values).toEqual({ name: "Ada" });
  });

  it("takes rows written whole at the collection path as its entries, before anything is drawn and from a draft", async () => {
    const rt = runtime(grid({ initialRows: 1 }, [{ id: "note", type: "text", configuration: {} }, { id: "n", type: "number", configuration: {} }]));
    expect(rt.setValues({ items: [{ note: "a" }, { note: "b", n: 2 }] })).toEqual([]);
    expect(rt.rows("items")).toEqual([
      { note: "a", n: undefined },
      { note: "b", n: 2 }
    ]);
    expect("items" in rt.state().values).toBe(false);
    expect(keysOf(rt, "items[")).toEqual(["items[0].n", "items[0].note", "items[1].n", "items[1].note"]);
    const sent = (await rt.submit("m", clientCtx())).canonicalSubmission!.submission.values as Record<string, unknown>;
    expect(sent).toEqual({ items: [{ note: "a" }, { note: "b", n: 2 }] });

    // A draft holding the rows whole puts them back the same way; flat keys beside a list win.
    const drafted = runtime(grid({ initialRows: 1 }, [{ id: "note", type: "text", configuration: {} }]));
    const draft = (values: Record<string, unknown>): FormDraft => ({
      id: "d",
      formId: "f1",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1" },
      locale: "en",
      values,
      state: { touched: [], dirty: [] },
      updatedAt: 0
    });
    await drafted.hydrateFromDraft(draft({ items: [{ note: "x" }, {}, { note: "z" }] }));
    expect(drafted.rows("items").map((row) => row.note)).toEqual(["x", undefined, "z"]);
    expect("items" in drafted.state().values).toBe(false);
    await drafted.hydrateFromDraft(draft({ items: [{ note: "list" }], "items[0].note": "flat" }));
    expect(drafted.rows("items").map((row) => row.note)).toEqual(["flat"]);
  });

  it("reports each row's calculated values in rows() and in the settled change after a row operation", () => {
    const rt = runtime(grid());
    rt.setValues({ "items[0].qty": 2, "items[0].price": 3 });
    expect(rt.rows("items")).toEqual([{ qty: 2, price: 3, total: 6 }]);
    const changes: unknown[] = [];
    rt.events().subscribe("COMPONENT_CHANGED", (event) => changes.push((event.data as { value?: unknown }).value));
    rt.addRow("items", { qty: 1, price: 4 });
    expect(changes).toEqual([
      [
        { qty: 2, price: 3, total: 6 },
        { qty: 1, price: 4, total: 4 }
      ]
    ]);
    // A row moved or removed carries its worked-out value with it.
    rt.removeRow("items", 0);
    expect(rt.rows("items")).toEqual([{ qty: 1, price: 4, total: 4 }]);
  });

  it("sends the sandbox, a server check and the envelope the same rows, read once", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "s", validate: false, sign: false, serverValidation: true });
    const seen: Array<Record<string, unknown>> = [];
    const node = grid({ initialRows: 2 }, [{ id: "note", type: "text", configuration: {} }]);
    const rt = new FormRuntime(form(node), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      serverValidationRunner: new ServerValidationRunner([
        {
          id: "capture",
          version: "1.0.0",
          validate: async (context) => {
            seen.push({ ...context.values }, { ...context.validationContext.values });
            return { errors: [] };
          }
        }
      ]),
      versionContext: { formVersion: "1", schemaVersion: "1", rendererVersion: "1" }
    });
    rt.setValue("items[1].note", "second");
    await rt.submit("s", clientCtx());
    expect(seen).toEqual([{ items: [{}, { note: "second" }] }, { items: [{}, { note: "second" }] }]);
  });

  it("works a grid's bound formulas out form-scoped, for the buttons, Add and the row count, as the kernel does", async () => {
    const people: ComponentNode = { id: "people", type: "number", configuration: {} };
    const bounded = grid({ minRows: 0, maxRows: 5, initialRows: 1 }, [{ id: "note", type: "text", configuration: {} }]);
    bounded.rules = { minRows: "people", maxRows: "people + 1" };
    const definition: FormDefinition = {
      ...form(bounded),
      root: { id: "root", type: "form", configuration: {}, children: { content: [people, bounded] } }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const rt = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(definition.root))]),
      versionContext: { formVersion: "1", schemaVersion: "1", rendererVersion: "1" }
    });
    // No answer yet: the fixed bounds stand.
    expect(rt.dataGridRowBounds()).toEqual({ items: { minRows: 0, maxRows: 5 } });
    rt.setValue("people", 2);
    expect(rt.dataGridRowBounds()).toEqual({ items: { minRows: 2, maxRows: 3 } });
    let errors = await rt.validate();
    expect(errors.map((error) => [error.code, error.parameters])).toEqual([["rows.min", { min: 2, count: 1 }]]);
    rt.addRow("items");
    rt.addRow("items");
    expect(() => rt.addRow("items")).toThrow(/most rows it may \(3\)/);
    expect(await rt.validate()).toEqual([]);
    // A fraction is no whole number: the fixed bound stands again.
    rt.setValue("people", 1.5);
    expect(rt.dataGridRowBounds()).toEqual({ items: { minRows: 0, maxRows: 5 } });
    // The kernel reaches the same count over the same answers.
    rt.setValue("people", 4);
    errors = await rt.validate();
    expect(errors.map((error) => [error.code, error.parameters])).toEqual([["rows.min", { min: 4, count: 3 }]]);
    const outcome = runKernel(
      { formId: "f1", values: { people: 4, items: [{}, {}, {}] }, locale: "en", form: definition.root },
      []
    );
    expect(outcome.errors.filter((error) => error.code.startsWith("rows.")).map((error) => [error.code, error.parameters])).toEqual([
      ["rows.min", { min: 4, count: 3 }]
    ]);
  });

  it("never works out a bound formula that reads a row: the fixed bound stands", () => {
    const bounded = grid({ minRows: 1, initialRows: 1 }, [{ id: "note", type: "text", configuration: {} }]);
    bounded.rules = { minRows: "row.note" };
    const rt = runtime(bounded);
    rt.setValue("items[0].note", "3");
    expect(rt.dataGridRowBounds()).toEqual({ items: { minRows: 1, maxRows: undefined } });
  });

  it("opens a grid with its starting rows in the journeys' preview runtime too, whatever builds it", () => {
    const definition = form(grid({ minRows: 1 }));
    const rt = createEnginePreviewRuntime({
      journeyConfiguration: () => undefined,
      journeyId: "j",
      locale: "en",
      root: definition.root,
      localization: definition.localization
    });
    expect(rt.rows("items")).toHaveLength(1);
    expect(Object.keys(rt.state().values).filter((key) => key.startsWith("items["))).toHaveLength(3);
  });

  it("gives Try it the preview's rows as the form posts them, and checks them from their keys, an empty drawn row counted", () => {
    const root = form(grid({ minRows: 2 }, [{ id: "name", type: "text", configuration: { label: "Name", required: true } }])).root;
    // What the canvas's preview holds for two drawn rows, the second with nothing typed in.
    const values = { "items[0].name": "Ada", "items[1].name": undefined, note: "x" };
    expect(previewSubmissionAnswers(root, values, () => true)).toEqual({ note: "x", items: [{ name: "Ada" }, {}] });
    // No row drawn: an empty list when the grid's answers are sent, else nothing.
    expect(previewSubmissionAnswers(root, {}, () => true)).toEqual({ items: [] });
    expect(previewSubmissionAnswers(root, {}, () => false)).toEqual({});
    const checked = previewCheckedAnswers(root, values);
    expect(Object.prototype.hasOwnProperty.call(checked, "items[1].name")).toBe(true);
    const errors = checkAnswerErrors(root, checked, { locale: "en", required: new Map([["name", true]]), hidden: () => false });
    // Two rows drawn: the minimum holds; the empty row's required cell is reported at its key.
    expect(errors.map((error) => [error.code, error.path])).toEqual([["required", "items[1].name"]]);
    // The kernel reads the posted list the same way: two rows, the second's cell required.
    const kernel = runKernel({ formId: "f1", values: previewSubmissionAnswers(root, values, () => true), locale: "en", form: root }, []);
    expect(kernel.errors.map((error) => [error.code, error.path])).toEqual([["required", "items[1].name"]]);
  });
});
