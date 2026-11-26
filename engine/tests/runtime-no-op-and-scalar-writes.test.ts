import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormEvent } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime, NonScalarAnswerError } from "../form-engine/runtime/browser/form-runtime.js";
import { isScalarAnswer } from "../form-engine/core/state/answer-shape.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: {} },
        { id: "bio", type: "textarea", configuration: {} },
        { id: "age", type: "number", configuration: {} },
        { id: "born", type: "date", configuration: {} },
        { id: "colour", type: "select", configuration: { options: [{ value: "red", label: "Red" }] } },
        { id: "size", type: "radio", configuration: { options: [{ value: "s", label: "S" }] } },
        { id: "agree", type: "checkbox", configuration: {} },
        { id: "pets", type: "checkboxes", configuration: { options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }] } },
        {
          id: "items",
          type: "dataGrid",
          configuration: {},
          children: { content: [{ id: "sku", type: "text", configuration: {} }] }
        }
      ]
    }
  };
  return { id: "f", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } } as FormDefinition;
}

function build(): { runtime: FormRuntime; seen: FormEvent[] } {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form(), { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  const seen: FormEvent[] = [];
  runtime.events().subscribe("*", (event) => seen.push(event));
  return { runtime, seen };
}

const changes = (seen: FormEvent[]): FormEvent[] => seen.filter((event) => event.type === FormEventType.COMPONENT_CHANGED);
const recomputes = (seen: FormEvent[]): number => seen.filter((event) => event.type === FormEventType.RECOMPUTE_COMPLETED).length;

describe("a write of the value already stored is silent", () => {
  it("publishes no change and recomputes nothing for the same scalar, final or interim", () => {
    const { runtime, seen } = build();
    runtime.setValue("name", "Ada");
    seen.length = 0;

    expect(() => runtime.setValue("name", "Ada")).not.toThrow();
    runtime.setValue("name", "Ada", { interim: true });

    expect(changes(seen)).toEqual([]);
    expect(recomputes(seen)).toBe(0);
    expect(runtime.state().values.name).toBe("Ada");
  });

  it("still publishes a write of another value, or of the same text as another type", () => {
    const { runtime, seen } = build();
    runtime.setValue("age", 12);
    seen.length = 0;

    runtime.setValue("age", "12");
    runtime.setValue("age", 13);

    expect(changes(seen).map((event) => event.data)).toEqual([{ value: "12" }, { value: 13 }]);
  });

  it("lets a listener that writes back a normalised value settle instead of recursing", () => {
    const { runtime } = build();
    let writes = 0;
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => {
      const value = (event.data as { value?: unknown }).value;
      if (typeof value === "string") {
        writes += 1;
        runtime.setValue("name", value.toUpperCase());
      }
    });

    expect(() => runtime.setValue("name", "ada")).not.toThrow();
    expect(runtime.state().values.name).toBe("ADA");
    // The page's write, the normalised one, and the normalised value written again (silent).
    expect(writes).toBe(2);
  });

  it("compares a list or a record by its content", () => {
    const { runtime, seen } = build();
    runtime.setValue("pets", { cat: true, dog: false });
    seen.length = 0;

    runtime.setValue("pets", { cat: true, dog: false });
    expect(changes(seen)).toEqual([]);

    runtime.setValue("pets", { cat: true, dog: true });
    expect(changes(seen)).toHaveLength(1);
  });

  it("compares an object that is not plain data by identity", () => {
    const { runtime, seen } = build();
    class Upload {
      constructor(public readonly name: string) {}
    }
    runtime.setValue("bio", "x");
    const first = new Map([["a", 1]]);
    runtime.setValues({ pets: first });
    seen.length = 0;

    // Two maps (or two uploads) JSON would both carry as `{}` are still two values.
    runtime.setValues({ pets: new Map([["b", 2]]) });
    expect(changes(seen)).toHaveLength(1);
    runtime.setValues({ pets: new Upload("a") });
    runtime.setValues({ pets: new Upload("a") });
    expect(changes(seen)).toHaveLength(3);
  });

  it("writes an answer for a key the answers do not hold yet, empty included", () => {
    const { runtime, seen } = build();
    runtime.setValue("name", undefined);
    runtime.setValue("bio", "");
    expect(changes(seen)).toHaveLength(2);
    seen.length = 0;
    runtime.setValue("name", undefined);
    runtime.setValue("bio", "");
    expect(changes(seen)).toEqual([]);
  });

  it("still writes when the control says something the stored answer cannot", () => {
    const { runtime, seen } = build();
    runtime.setValue("age", "");
    runtime.setInputState("age", { badInput: true });
    seen.length = 0;

    // The page's empty answer replaces what the box said, though the stored answer is the same.
    runtime.setValue("age", "");
    expect(changes(seen)).toHaveLength(1);
    expect(runtime.inputState("age")).toBeUndefined();
  });

  it("leaves an unchanged answer out of setValues' recompute and reports no failure for it", () => {
    const { runtime, seen } = build();
    runtime.setValues({ name: "Ada", bio: "Hi" });
    seen.length = 0;

    expect(runtime.setValues({ name: "Ada", bio: "Hi" })).toEqual([]);
    expect(changes(seen)).toEqual([]);
    expect(recomputes(seen)).toBe(0);

    expect(runtime.setValues({ name: "Ada", bio: "Hello" })).toEqual([]);
    expect(changes(seen).map((event) => event.data)).toEqual([{ value: "Hello" }]);
    expect(recomputes(seen)).toBe(1);
  });
});

describe("a non-scalar answer for a field that holds one value is refused when written", () => {
  const poisoned: unknown[] = [{ toString: "x" }, { valueOf: 1, toString: 2 }, [{ toString: "x" }], Object.create(null), { a: 1 }, ["a"], () => "x", Symbol("s")];

  it("throws a typed failure from setValue for every scalar field type, and writes nothing", () => {
    const { runtime, seen } = build();
    for (const path of ["name", "bio", "age", "born", "colour", "size", "agree"]) {
      for (const value of poisoned) {
        let thrown: unknown;
        try {
          runtime.setValue(path, value);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(NonScalarAnswerError);
        expect(thrown).toMatchObject({ code: "value.notScalar", path });
      }
    }
    expect(changes(seen)).toEqual([]);
    for (const path of ["name", "bio", "age", "born", "colour", "size", "agree"]) {
      expect(runtime.state().values).not.toHaveProperty(path);
    }
  });

  it("refuses a bigint, which has no JSON form, like a list or a record", () => {
    const { runtime, seen } = build();
    for (const path of ["name", "age", "agree", "items[0].sku"]) {
      expect(() => runtime.setValue(path, 10n)).toThrow(NonScalarAnswerError);
    }
    expect(isScalarAnswer(10n)).toBe(false);
    expect(isScalarAnswer(10)).toBe(true);
    expect(changes(seen)).toEqual([]);
    expect(runtime.state().values).not.toHaveProperty("age");
  });

  it("keeps scalars, empties and the many-valued fields' own shapes", () => {
    const { runtime } = build();
    runtime.setValue("name", "Ada");
    runtime.setValue("age", 12);
    runtime.setValue("agree", true);
    runtime.setValue("born", null);
    runtime.setValue("bio", undefined);
    runtime.setValue("pets", { cat: true });
    runtime.setValue("pets", ["cat"]);
    // A key no component owns is the host's own (an extra kept beside the answers).
    runtime.setValue("extra", { anything: [1, 2] });
    expect(runtime.state().values).toMatchObject({ name: "Ada", age: 12, agree: true, born: null, pets: ["cat"], extra: { anything: [1, 2] } });
  });

  it("refuses one in a row's field too, whether written by key or with the rows whole", () => {
    const { runtime } = build();
    expect(() => runtime.setValue("items[0].sku", { toString: "x" })).toThrow(NonScalarAnswerError);
    expect(() => runtime.setValue("items", [{ sku: "A" }, { sku: ["B"] }])).toThrow(NonScalarAnswerError);
    expect(runtime.state().values["items[0].sku"]).toBeUndefined();
    runtime.setValue("items", [{ sku: "A" }]);
    expect(runtime.state().values["items[0].sku"]).toBe("A");
  });

  it("lists it in setValues' failures and writes the rest", () => {
    const { runtime } = build();
    const failed = runtime.setValues({ name: "Ada", age: { valueOf: 1 }, bio: "Hi" });
    expect(failed.map((entry) => entry.path)).toEqual(["age"]);
    expect(failed[0]!.error).toBeInstanceOf(NonScalarAnswerError);
    expect(runtime.state().values).toMatchObject({ name: "Ada", bio: "Hi" });
    expect(runtime.state().values).not.toHaveProperty("age");
  });

  it("restores a draft's other answers and reports the dropped one", async () => {
    const { runtime, seen } = build();
    const draft = {
      id: "d",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1" },
      locale: "en",
      values: { name: "Ada", age: { toString: "x" }, "items[0].sku": [{ toString: "x" }], "items[1].sku": "B", extra: { kept: true } },
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
      updatedAt: 1
    } as unknown as FormDraft;

    const restored = await runtime.hydrateFromDraft(draft);

    expect(restored.dropped.map((entry) => entry.path)).toEqual(["age", "items[0].sku"]);
    expect(restored.dropped.every((entry) => entry.error instanceof NonScalarAnswerError)).toBe(true);
    const values = runtime.state().values;
    expect(values.name).toBe("Ada");
    expect(values["items[1].sku"]).toBe("B");
    expect(values.extra).toEqual({ kept: true });
    expect(values).not.toHaveProperty("age");
    expect(values["items[0].sku"]).toBeUndefined();
    const loaded = seen.find((event) => event.type === FormEventType.DRAFT_LOADED);
    expect(loaded?.data).toEqual({ draftId: "d", dropped: ["age", "items[0].sku"] });
  });

  it("reports nothing dropped for a clean draft", async () => {
    const { runtime, seen } = build();
    const restored = await runtime.hydrateFromDraft({
      id: "d",
      formId: "f",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1" },
      locale: "en",
      values: { name: "Ada" },
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
      updatedAt: 1
    } as unknown as FormDraft);
    expect(restored).toEqual({ dropped: [] });
    expect(seen.find((event) => event.type === FormEventType.DRAFT_LOADED)?.data).toEqual({ draftId: "d" });
  });
});

describe("a collection's rows written whole, unchanged, are silent too", () => {
  const collectionEvents = (seen: FormEvent[]): FormEvent[] => seen.filter((event) => event.type === FormEventType.COLLECTION_CHANGED);

  it("publishes no change and recomputes nothing for the same rows", () => {
    const { runtime, seen } = build();
    runtime.setValue("items", [{ sku: "A" }]);
    seen.length = 0;

    expect(() => runtime.setValue("items", [{ sku: "A" }])).not.toThrow();
    expect(runtime.setValues({ items: [{ sku: "A" }] })).toEqual([]);

    expect(changes(seen)).toEqual([]);
    expect(collectionEvents(seen)).toEqual([]);
    expect(recomputes(seen)).toBe(0);
    expect(runtime.state().values["items[0].sku"]).toBe("A");
  });

  it("still publishes rows that differ, by a cell or by their count", () => {
    const { runtime, seen } = build();
    runtime.setValue("items", [{ sku: "A" }]);
    seen.length = 0;

    runtime.setValue("items", [{ sku: "B" }]);
    runtime.setValue("items", [{ sku: "B" }, {}]);
    runtime.setValue("items", []);

    expect(changes(seen)).toHaveLength(3);
    expect(runtime.state().values).not.toHaveProperty("items[0].sku");
  });

  it("lets a listener that writes the rows back normalised settle instead of recursing", () => {
    const { runtime } = build();
    let writes = 0;
    runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => {
      const value = (event.data as { value?: unknown }).value;
      if (!Array.isArray(value) || writes > 50) {
        return;
      }
      writes += 1;
      runtime.setValue(
        "items",
        value.map((row: Record<string, unknown>) => ({ ...row, sku: typeof row.sku === "string" ? row.sku.toUpperCase() : row.sku }))
      );
    });

    expect(() => runtime.setValue("items", [{ sku: "a" }])).not.toThrow();
    expect(runtime.state().values["items[0].sku"]).toBe("A");
    // The page's write, the normalised one, and the normalised rows written again (silent).
    expect(writes).toBe(2);
  });

  it("still writes when a control in the rows says something its stored answer cannot", () => {
    const { runtime, seen } = build();
    runtime.setValue("items", [{ sku: "" }]);
    runtime.setInputState("items[0].sku", { badInput: true });
    seen.length = 0;

    runtime.setValue("items", [{ sku: "" }]);
    expect(changes(seen)).toHaveLength(1);
    expect(runtime.inputState("items[0].sku")).toBeUndefined();
  });
});

describe("a row added with a non-scalar cell is refused", () => {
  it("throws a typed failure from addRow naming the cell, and adds no row", () => {
    const { runtime, seen } = build();
    // The grid opens with its one starting row; a second is added, so the refused one is the third.
    expect(runtime.addRow("items", { sku: "A" })).toBe(1);
    seen.length = 0;

    let thrown: unknown;
    try {
      runtime.addRow("items", { sku: ["a", "b"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NonScalarAnswerError);
    expect(thrown).toMatchObject({ code: "value.notScalar", path: "items[2].sku", componentId: "sku", componentType: "text" });
    expect(runtime.rows("items")).toHaveLength(2);
    expect(seen.filter((event) => event.type === FormEventType.COLLECTION_CHANGED)).toEqual([]);
  });

  it("refuses addRows whole when any row carries one, naming that row's cell", () => {
    const { runtime } = build();
    // After the grid's one starting row: the second row given would be the third.
    expect(() => runtime.addRows("items", [{ sku: "A" }, { sku: { toString: "x" } }])).toThrow(
      expect.objectContaining({ code: "value.notScalar", path: "items[2].sku" })
    );
    expect(runtime.rows("items")).toHaveLength(1);
    expect(runtime.addRows("items", [{ sku: "A" }, { sku: null }])).toEqual([1, 2]);
  });
});
