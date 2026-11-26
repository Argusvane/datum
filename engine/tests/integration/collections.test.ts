import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";

function form(collectionNode: ComponentNode): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [collectionNode] }
  };
  return { id: "f1", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

function runtime(collectionNode: ComponentNode): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
  return new FormRuntime(form(collectionNode), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([])
  });
}

const contacts: ComponentNode = {
  id: "contacts",
  type: "repeatingSection",
  configuration: {},
  collection: { collectionPath: "contacts", itemFields: ["name", "email"] }
};

describe("collections ↔ runtime bridge", () => {
  it("adds rows into form state and emits COLLECTION_CHANGED", () => {
    const rt = runtime(contacts);
    const events: unknown[] = [];
    rt.events().subscribe("COLLECTION_CHANGED", (event) => events.push(event.data));

    const index = rt.addRow("contacts", { name: "Ada", email: "ada@x.co" });
    expect(index).toBe(0);
    expect(rt.state().values["contacts[0].name"]).toBe("Ada");
    expect(rt.state().values["contacts[0].email"]).toBe("ada@x.co");
    expect(events).toEqual([{ collectionPath: "contacts", action: "add", rowCount: 1 }]);
  });

  it("mirrors setValue on an indexed path into the collection runtime", () => {
    const rt = runtime(contacts);
    rt.addRow("contacts", {});
    rt.setValue("contacts[0].name", "Grace");
    expect(rt.rows("contacts")[0]).toEqual({ name: "Grace" });
  });

  it("reindexes state values when a middle row is removed", () => {
    const rt = runtime(contacts);
    rt.addRow("contacts", { name: "a" });
    rt.addRow("contacts", { name: "b" });
    rt.addRow("contacts", { name: "c" });

    rt.removeRow("contacts", 1);

    expect(rt.rows("contacts").map((r) => r.name)).toEqual(["a", "c"]);
    expect(rt.state().values["contacts[0].name"]).toBe("a");
    expect(rt.state().values["contacts[1].name"]).toBe("c");
    expect("contacts[2].name" in rt.state().values).toBe(false);
  });

  it("reorders rows and keeps state consistent", () => {
    // Reorder is offered only when the binding says so.
    const rt = runtime({ ...contacts, collection: { ...contacts.collection!, operations: { reorder: true } } });
    rt.addRow("contacts", { name: "first" });
    rt.addRow("contacts", { name: "second" });

    rt.reorderRow("contacts", 0, 1);

    expect(rt.state().values["contacts[0].name"]).toBe("second");
    expect(rt.state().values["contacts[1].name"]).toBe("first");
  });

  it("enforces collection operation flags", () => {
    const locked: ComponentNode = {
      id: "locked",
      type: "repeatingSection",
      configuration: {},
      collection: { collectionPath: "locked", operations: { add: false, remove: false, reorder: false } }
    };
    const rt = runtime(locked);
    expect(() => rt.addRow("locked", {})).toThrow(/does not allow adding/i);
  });

  it("offers add and remove but not reorder when the binding names no operations", () => {
    const rt = runtime(contacts);
    rt.addRow("contacts", { name: "a" });
    rt.addRow("contacts", { name: "b" });
    expect(() => rt.reorderRow("contacts", 0, 1)).toThrow(/does not allow reordering/i);
    rt.removeRow("contacts", 0);
    expect(rt.rows("contacts").map((row) => row.name)).toEqual(["b"]);
  });

  it("gives a row added with some fields a key for every field the binding lists", () => {
    const rt = runtime(contacts);
    rt.addRow("contacts", { name: "Ada" });
    expect(Object.keys(rt.state().values).sort()).toEqual(["contacts[0].email", "contacts[0].name"]);
    expect(rt.state().values["contacts[0].email"]).toBeUndefined();
  });

  it("derives a section's fields from its children when the binding lists none", () => {
    const section: ComponentNode = {
      id: "people",
      type: "fieldset",
      configuration: {},
      collection: { collectionPath: "people" },
      children: { content: [{ id: "first", type: "text", configuration: {} }, { id: "age", type: "number", configuration: { dataKey: "years" } }] }
    };
    const rt = runtime(section);
    rt.addRow("people");
    expect(Object.keys(rt.state().values).sort()).toEqual(["people[0].first", "people[0].years"]);
  });

  it("rejects operations on an unregistered collection path", () => {
    const rt = runtime(contacts);
    expect(() => rt.addRow("unknown", {})).toThrow(/no collection registered/i);
  });
});
