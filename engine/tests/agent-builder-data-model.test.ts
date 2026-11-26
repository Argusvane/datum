import { describe, expect, it, vi } from "vitest";

import { BuilderController, type InsertComponentEntry } from "../form-engine/builder/controller/builder-controller.js";
import { DataModelImporter } from "../form-engine/builder/data/data-model-import.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { agentBuilder, contactRequestController, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * `fromData` on `add_components` and `replace_form`: a JSON sample or schema, as an object or as text, read and planned by the Data
 * workspace's own planner (loaded through the host's `loadDataModelKit`) and placed in one undo
 * step, with the report of what it read; neither or both of `components` and `fromData` is
 * `bad-input`; an unreadable text is `data-unreadable` with its line and column; a risky
 * pattern is dropped with a warning; the caps of a hand-written list apply; a dry run writes
 * nothing and reports the ids a write would use.
 */

const SAMPLE = {
  full_name: "Ana",
  phone: "555-0100",
  visits: 3,
  subscribed: true,
  address: { street: "1 Main St", city: "London" },
  items: [{ sku: "A-1", qty: 2 }],
  tags: ["a", "b"]
};

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string", enum: ["Dr", "Mr", "Ms"] },
    guests: { type: "integer", minimum: 0 },
    when: { type: "string", format: "date" },
    contact: { type: "object", properties: { phone: { type: "string" } } }
  }
};

function find(root: ComponentNode, id: string): ComponentNode | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (node.id === id) {
      return node;
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return undefined;
}

function contentIds(controller: BuilderController): string[] {
  return (controller.snapshot().children?.content ?? []).map((node) => node.id);
}

/** The Data workspace's import driven as its buttons drive it, over a controller of its own. */
function importerRun(target: BuilderController, value: unknown, action: "add" | "replace"): { entries?: readonly InsertComponentEntry[]; nodes?: readonly ComponentNode[] } {
  const captured: { entries?: readonly InsertComponentEntry[]; nodes?: readonly ComponentNode[] } = {};
  const insert = target.requestInsertComponents.bind(target);
  target.requestInsertComponents = (entries, options) =>
    insert(() => {
      const planned = typeof entries === "function" ? entries() : entries;
      captured.entries = structuredClone(planned);
      return planned;
    }, options);
  const replace = target.requestReplaceContent.bind(target);
  target.requestReplaceContent = (nodes, options) =>
    replace(() => {
      const planned = typeof nodes === "function" ? nodes() : nodes;
      captured.nodes = structuredClone(planned);
      return planned;
    }, options);
  const importer = new DataModelImporter({
    controller: () => target,
    canBuild: () => true,
    selectsRows: () => false,
    scope: () => undefined,
    paint: () => undefined,
    announce: () => undefined,
    built: () => undefined
  });
  importer.setText(JSON.stringify(value));
  const button = (name: string): HTMLElement => ({ dataset: { [name]: "" } }) as unknown as HTMLElement;
  if (action === "add") {
    importer.click(button("modelAdd"));
  } else {
    importer.click(button("modelReplace"));
    importer.click(button("modelReplaceConfirm"));
  }
  return captured;
}

describe("fromData: the input", () => {
  it("takes the data as an object or as JSON text, and both build the same fields", async () => {
    const asObject = agentBuilder();
    const asText = agentBuilder();
    const first = okOf(await asObject.execute("add_components", { fromData: SAMPLE }));
    const second = okOf(await asText.execute("add_components", { fromData: JSON.stringify(SAMPLE) }));
    // `address` is a place no component of this fixture's palette can hold (it has no container type): skipped, with the planner's reason.
    expect(first.ids).toEqual(["phone", "visits", "subscribed", "items", "tags"]);
    expect((first.dataModel as { skipped: Array<{ path: string }> }).skipped.map((row) => row.path)).toContain("address");
    expect(second.ids).toEqual(first.ids);
    expect(asText.controller.snapshot()).toEqual(asObject.controller.snapshot());
    expect(first.dataModel).toMatchObject({ readAs: "sample", detected: "sample", alreadyInForm: 1 });
    expect(first.changed).toBe(true);
    expect(first.undo).toMatchObject({ steps: 1 });
  });

  it("says the missing places were skipped, not that the form has them, when nothing was added", async () => {
    const builder = agentBuilder();
    const box = { type: "object", properties: { box: { type: "object", properties: { code: { type: "string" } } } } };
    const result = okOf(await builder.execute("add_components", { fromData: box, readAs: "schema" }));
    expect(result).toMatchObject({ changed: false, ids: [], undo: { steps: 0 } });
    expect((result.dataModel as { alreadyInForm: number; skipped: unknown[] }).alreadyInForm).toBe(0);
    expect((result.dataModel as { skipped: unknown[] }).skipped).not.toHaveLength(0);
    expect(result.note).toEqual(["Nothing was added: the places the form lacks were skipped; see dataModel.skipped."]);
    // A form that does hold every place keeps the original sentence.
    const held = okOf(await builder.execute("add_components", { fromData: { email: "a@b.c" } }));
    expect(held.note).toEqual(["The form already has a field for every place in the data; nothing was added."]);
  });

  it("refuses neither and both of components and fromData as bad-input, on both tools", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    for (const name of ["add_components", "replace_form"]) {
      for (const input of [{}, { components: [{ type: "text", label: "A" }], fromData: { a: 1 } }]) {
        const refused = refusalOf(await builder.execute(name, input));
        expect(refused, name).toMatchObject({ code: "bad-input", details: { problems: [{ key: "components", expected: "components or fromData, not both and not neither" }] } });
      }
    }
    expect(builder.controller.snapshot()).toEqual(before);
  });

  it("reads `readAs` over the detection, both ways", async () => {
    const builder = agentBuilder();
    const asSchema = okOf(await builder.execute("add_components", { fromData: SCHEMA, readAs: "schema", dryRun: true }));
    expect(asSchema.dataModel).toMatchObject({ readAs: "schema", detected: "schema" });
    // Auto detection takes this for a schema; readAs "sample" reads its keys as answers instead.
    const looksLikeSchema = { type: "object", properties: { guests: { type: "integer" } } };
    const auto = okOf(await builder.execute("add_components", { fromData: looksLikeSchema, dryRun: true }));
    expect(auto.dataModel).toMatchObject({ readAs: "schema", detected: "schema" });
    const forced = okOf(await builder.execute("add_components", { fromData: looksLikeSchema, readAs: "sample", dryRun: true }));
    expect(forced.dataModel).toMatchObject({ readAs: "sample", detected: "schema" });
    expect(forced.ids).toEqual(["type"]);
    // And the other way: the reader is told to read a schema whatever the detection says.
    const mixed = { properties: { a: { type: "string" }, b: "x" } };
    const detected = okOf(await builder.execute("add_components", { fromData: mixed, dryRun: true }));
    expect(detected.dataModel).toMatchObject({ readAs: "sample", detected: "sample" });
    const plain = okOf(await builder.execute("add_components", { fromData: mixed, readAs: "schema", dryRun: true }));
    expect(plain.dataModel).toMatchObject({ readAs: "schema", detected: "sample" });
    expect(plain.ids).toContain("a");
    expect(plain.ids).not.toEqual(detected.ids);
  });

  it("answers data-unreadable with the line and column of a JSON error, and for empty text", async () => {
    const builder = agentBuilder();
    const bad = refusalOf(await builder.execute("add_components", { fromData: '{\n  "a": 1,\n  "b": \n}' }));
    expect(bad).toMatchObject({ code: "data-unreadable", retryable: false, details: { line: 4, column: 1 } });
    expect(bad.hint).toBe("Send a JSON object (a sample of the answers) or a JSON Schema whose top level is an object; fix the JSON at the line and column given.");
    expect(typeof (bad.details as { error: string }).error).toBe("string");
    const empty = refusalOf(await builder.execute("replace_form", { fromData: "   " }));
    expect(empty).toMatchObject({ code: "data-unreadable", details: { empty: true } });
  });
});

describe("add_components { fromData }", () => {
  it("adds what the Data workspace's Add missing fields adds, field for field", async () => {
    for (const value of [SAMPLE, SCHEMA]) {
      const tool = agentBuilder();
      const imported = contactRequestController();
      const captured = importerRun(imported, value, "add");
      const result = okOf(await tool.execute("add_components", { fromData: value }));
      expect((captured.entries ?? []).length).toBeGreaterThan(0);
      expect(tool.controller.snapshot()).toEqual(imported.snapshot());
      expect(result.ids).toEqual((captured.entries ?? []).map((entry) => entry.node.id));
    }
  });

  it("reports the read: places, what it added with fit, what the form already holds, kinds that differ and what it skipped", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("add_components", { fromData: { full_name: "Ana", email: "a@b.c", topic: { x: 1 }, visits: 3 } }));
    expect(result.ids).toEqual(["visits"]);
    expect(result.dataModel).toEqual({
      readAs: "sample",
      detected: "sample",
      places: 4,
      added: [{ path: "visits", componentId: "visits", type: "number", fit: "exact" }],
      alreadyInForm: 2,
      kindDiffers: [{ path: "topic", form: "string", incoming: "object" }],
      skipped: [],
      notes: []
    });
    expect(result.next).toEqual(["Review the generated labels, required flags and options with get_form, then adjust with set_properties.", "Run check_form before you say the form is done."]);
    expect(find(builder.controller.snapshot(), "visits")?.type).toBe("number");
  });

  it("is ok and changed false with the note when the form already has a field for every place", async () => {
    const builder = agentBuilder();
    const revision = builder.registration.revision();
    const result = okOf(await builder.execute("add_components", { fromData: { full_name: "Ana", email: "a@b.c" } }));
    expect(result).toMatchObject({ changed: false, ids: [], undo: { steps: 0 }, note: ["The form already has a field for every place in the data; nothing was added."] });
    expect(builder.registration.revision()).toBe(revision);
    expect(contentIds(builder.controller)).toEqual(["full_name", "email", "topic", "details", "submit"]);
  });

  it("with dryRun writes nothing, moves no revision, and reports the ids a write would use", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const revision = builder.registration.revision();
    const insert = vi.spyOn(builder.controller, "requestInsertComponents");
    const dry = okOf(await builder.execute("add_components", { fromData: SAMPLE, dryRun: true }));
    expect(insert).not.toHaveBeenCalled();
    expect(builder.controller.snapshot()).toEqual(before);
    expect(builder.registration.revision()).toBe(revision);
    expect(dry).toMatchObject({ dryRun: true, changed: false, undo: { steps: 0 } });
    expect((dry.dataModel as { added: Array<{ componentId: string }> }).added.map((row) => row.componentId)).toEqual(dry.ids);
    const real = okOf(await builder.execute("add_components", { fromData: SAMPLE }));
    expect(real.ids).toEqual(dry.ids);
    expect((real.dataModel as { added: unknown }).added).toEqual((dry.dataModel as { added: unknown }).added);
    expect(contentIds(builder.controller).slice(-2)).toEqual(["tags", "submit"]);
  });

  it("is one undo step and undoes with history", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    okOf(await builder.execute("add_components", { fromData: SAMPLE }));
    const undone = okOf(await builder.execute("history", { action: "undo" }));
    expect(undone.undo).toMatchObject({ steps: 1 });
    expect(builder.controller.snapshot()).toEqual(before);
  });

  it("places through the guarded request with the importer's thunk, selects none, and selects the first field on a page", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const request = vi.spyOn(builder.controller, "requestInsertComponents");
    const result = okOf(await builder.execute("add_components", { fromData: { phone: "1", visits: 2 } }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(typeof request.mock.calls[0]?.[0]).toBe("function");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ select: "none" });
    expect(result.shown).toEqual({ componentId: "phone" });
    expect(builder.controller.selectedComponentId()).toBe("phone");
    expect(stub.callsOf("announce")).toEqual([["Assistant added 2 components"]]);
  });

  it("refuses with unsaved-draft when the person has an unapplied edit, raising no prompt", async () => {
    const builder = agentBuilder();
    builder.controller.select("email");
    builder.controller.setDraftProperty("email", "label", "Mail");
    const refused = refusalOf(await builder.execute("add_components", { fromData: { phone: "1" } }));
    expect(refused.code).toBe("unsaved-draft");
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(contentIds(builder.controller)).not.toContain("phone");
  });
});

describe("replace_form { fromData }", () => {
  it("rebuilds with the Data workspace's Replace form contents, closing buttons kept", async () => {
    for (const value of [SAMPLE, SCHEMA]) {
      const tool = agentBuilder();
      const imported = contactRequestController();
      const captured = importerRun(imported, value, "replace");
      const result = okOf(await tool.execute("replace_form", { fromData: value }));
      expect(tool.controller.snapshot()).toEqual(imported.snapshot());
      expect(result.ids).toEqual((captured.nodes ?? []).map((node) => node.id));
      expect(result.kept).toEqual(["submit"]);
      expect(contentIds(tool.controller).at(-1)).toBe("submit");
      expect(result.removedCount).toBeGreaterThan(0);
      expect(result.testsAffected).toEqual([{ id: "test-1", name: "Other topic needs a message", refs: expect.any(Array) }]);
      expect(result.next).toEqual(["Review the generated labels, required flags and options with get_form, then adjust with set_properties.", "Run check_form before you say the form is done."]);
    }
  });

  it("stays consequential, one step, and a dry run only checks", async () => {
    const builder = agentBuilder();
    const tool = builder.catalogue.tools.find((entry) => entry.name === "replace_form");
    expect(tool?.annotations).toEqual({ consequentialHint: true, untrustedContentHint: true });
    const before = builder.controller.snapshot();
    const dry = okOf(await builder.execute("replace_form", { fromData: SCHEMA, dryRun: true }));
    expect(builder.controller.snapshot()).toEqual(before);
    expect(dry).toMatchObject({ dryRun: true, kept: ["submit"], undo: { steps: 0 } });
    const real = okOf(await builder.execute("replace_form", { fromData: SCHEMA }));
    expect(real.ids).toEqual(dry.ids);
    expect(real.undo).toMatchObject({ steps: 1 });
    expect(real.dataModel).toMatchObject({ readAs: "schema", alreadyInForm: 0, kindDiffers: [] });
  });

  it("ignores keep with a warning, and takes only the content slot", async () => {
    const builder = agentBuilder();
    const kept = okOf(await builder.execute("replace_form", { fromData: { a: 1 }, keep: ["email"] }));
    expect(kept.kept).toEqual(["submit"]);
    expect(kept.warnings).toEqual(["ignored-keep: keep is not read with fromData; the form's closing buttons stay."]);
    const slot = refusalOf(await builder.execute("replace_form", { fromData: { a: 1 }, slotId: "header" }));
    expect(slot.code).toBe("bad-input");
  });

  it("does not check a keep list it ignores: an unknown id or over 100 ids still rebuilds with the warning", async () => {
    const builder = agentBuilder();
    const unknown = okOf(await builder.execute("replace_form", { fromData: { a: 1 }, keep: ["ghost"] }));
    expect(unknown.kept).toEqual(["submit"]);
    expect(unknown.warnings).toEqual(["ignored-keep: keep is not read with fromData; the form's closing buttons stay."]);
    const many = okOf(await builder.execute("replace_form", { fromData: { b: 1 }, keep: Array.from({ length: 101 }, (_, index) => `k${index}`), dryRun: true }));
    expect(many.warnings).toEqual(["ignored-keep: keep is not read with fromData; the form's closing buttons stay."]);
    // Without fromData the same lists are still refused.
    expect(refusalOf(await builder.execute("replace_form", { components: [{ type: "text", label: "A" }], keep: ["ghost"] })).code).toBe("unknown-component");
    expect(refusalOf(await builder.execute("replace_form", { components: [{ type: "text", label: "A" }], keep: Array.from({ length: 101 }, (_, index) => `k${index}`) })).code).toBe("too-large");
  });

  it("leaves the form as it is when the data describes no place a field can hold", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const result = okOf(await builder.execute("replace_form", { fromData: {} }));
    expect(result).toMatchObject({ changed: false, ids: [], removedCount: 0, undo: { steps: 0 }, note: ["The data describes no place a field can hold; the form was left as it is."] });
    expect(builder.controller.snapshot()).toEqual(before);
  });
});

describe("what fromData drops and caps", () => {
  const RISKY = { type: "object", properties: { id: { type: "string", pattern: "^(a+)+$" }, code: { type: "string", pattern: "^[A-Z]{3}$" } } };

  it("drops a risky generated pattern with a warning and a note, and keeps a safe one", async () => {
    const builder = agentBuilder();
    const dry = okOf(await builder.execute("replace_form", { fromData: JSON.stringify(RISKY), readAs: "schema", dryRun: true }));
    expect(dry.warnings).toEqual(["pattern dropped on id: the risky-pattern check refuses it"]);
    expect((dry.dataModel as { notes: string[] }).notes).toEqual(["pattern dropped on id: the risky-pattern check refuses it"]);
    const real = okOf(await builder.execute("replace_form", { fromData: JSON.stringify(RISKY), readAs: "schema" }));
    expect(real.warnings).toEqual(["pattern dropped on id: the risky-pattern check refuses it"]);
    const snapshot = builder.controller.snapshot();
    expect((find(snapshot, "id")?.configuration as Record<string, unknown>).pattern).toBeUndefined();
    expect((find(snapshot, "code")?.configuration as Record<string, unknown>).pattern).toBe("[A-Z]{3}");
  });

  it("drops a risky pattern in add_components too, through the thunk a write runs", async () => {
    const builder = agentBuilder();
    const real = okOf(await builder.execute("add_components", { fromData: JSON.stringify(RISKY), readAs: "schema" }));
    expect(real.warnings).toEqual(["pattern dropped on id: the risky-pattern check refuses it"]);
    const snapshot = builder.controller.snapshot();
    expect(find(snapshot, "id")).toBeDefined();
    expect((find(snapshot, "id")?.configuration as Record<string, unknown>).pattern).toBeUndefined();
    expect((find(snapshot, "code")?.configuration as Record<string, unknown>).pattern).toBe("[A-Z]{3}");
  });

  it("reports an approximate fit with its notes, and the model's own notes", async () => {
    const builder = agentBuilder();
    const dry = okOf(await builder.execute("add_components", { fromData: { type: "object", properties: { guests: { type: "integer" }, when: { type: "string", format: "date-time" } } }, dryRun: true }));
    const rows = (dry.dataModel as { added: Array<{ path: string; fit: string; notes?: string[] }> }).added;
    expect(rows.map((row) => row.fit)).toContain("approximate");
    for (const row of rows.filter((candidate) => candidate.fit === "approximate")) {
      expect(row.notes?.length ?? 0).toBeGreaterThan(0);
    }
    expect(rows.filter((row) => row.fit === "exact").every((row) => row.notes === undefined)).toBe(true);
    // A keyword the planner does not read, and a pattern the form cannot use, are the model's notes.
    const noted = okOf(
      await builder.execute("add_components", {
        fromData: { type: "object", properties: { name: { type: "string", not: { const: "x" } }, code: { type: "string", pattern: "(" } } },
        dryRun: true
      })
    );
    expect((noted.dataModel as { notes: string[] }).notes.length).toBeGreaterThan(0);
  });

  it("refuses an add that would leave the form over the server's limits with structure-limit", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const options = Array.from({ length: 2001 }, (_, index) => `v${index}`);
    const refused = refusalOf(await builder.execute("add_components", { fromData: { type: "object", properties: { pick: { type: "string", enum: options } } }, readAs: "schema" }));
    expect(refused.code).toBe("structure-limit");
    expect(builder.controller.snapshot()).toEqual(before);
  });

  it("leaves the selection where it was with select none", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const selected = builder.controller.selectedComponentId();
    okOf(await builder.execute("add_components", { fromData: { phone: "1" }, select: "none" }));
    expect(builder.controller.selectedComponentId()).toBe(selected);
    okOf(await builder.execute("add_components", { fromData: { fax: "1" } }));
    expect(builder.controller.selectedComponentId()).toBe("fax");
  });

  // The MAX_NODES cap (2 000 nodes in one plan) is not reached here: a plan this large needs a
  // palette with a container type, and this fixture's palette has none for the planner to nest.

  it("cuts the added list at 200 places and says so in the notes", async () => {
    const builder = agentBuilder();
    const sample = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`k${index}`, "x"]));
    const result = okOf<{ dataModel: { added: unknown[]; notes: string[] } }>(await builder.execute("add_components", { fromData: sample, dryRun: true }));
    expect(result.dataModel.added).toHaveLength(200);
    expect(result.dataModel.notes.at(-1)).toBe("added lists the first 200 of 250 places");
  });

  it("refuses a plan over the node caps with too-large, and over the server's limits with structure-limit", async () => {
    const builder = agentBuilder();
    const before = builder.controller.snapshot();
    const wide = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`k${index}`, "x"]));
    const tooMany = refusalOf(await builder.execute("add_components", { fromData: wide }));
    expect(tooMany).toMatchObject({ code: "too-large", details: { what: "input", limit: 500, got: 501, key: "fromData" } });
    const options = Array.from({ length: 2001 }, (_, index) => `v${index}`);
    const deep = refusalOf(await builder.execute("replace_form", { fromData: { type: "object", properties: { pick: { type: "string", enum: options } } }, readAs: "schema" }));
    expect(deep.code).toBe("structure-limit");
    expect(builder.controller.snapshot()).toEqual(before);
  });
});

describe("fromData and the page", () => {
  it("needs the data-model feature", async () => {
    const builder = agentBuilder({ featureOn: { "data-model": false } });
    const refused = refusalOf(await builder.execute("add_components", { fromData: { a: 1 } }));
    expect(refused).toMatchObject({ code: "feature-off", details: { feature: "data-model" } });
    // Hand-written components do not need it.
    okOf(await builder.execute("add_components", { components: [{ type: "text", id: "free", label: "Free" }] }));
  });

  it("loads the planner through the host once, only when a call needs it, and answers chunk-unavailable when it cannot", async () => {
    const real = (await import("../form-engine/builder/data/data-model-plan-loader.js")).loadDataModelPlan;
    const load = vi.fn(real);
    const builder = agentBuilder({ host: { loadDataModelKit: load } });
    okOf(await builder.execute("add_components", { components: [{ type: "text", id: "free", label: "Free" }] }));
    expect(load).not.toHaveBeenCalled();
    okOf(await builder.execute("add_components", { fromData: { phone: "1" }, dryRun: true }));
    okOf(await builder.execute("replace_form", { fromData: { phone: "1" }, dryRun: true }));
    expect(load).toHaveBeenCalledTimes(2);

    const failing = agentBuilder({ host: { loadDataModelKit: () => Promise.reject(new Error("offline")) } });
    const refused = refusalOf(await failing.execute("add_components", { fromData: { phone: "1" } }));
    expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "data-model", state: "failed" } });
  });
});

describe("the author's switch and fromData", () => {
  it("leaves the root's agentTools JSON-equal across replace_form and add_components with fromData", async () => {
    for (const value of [SAMPLE, SCHEMA]) {
      const root = structuredClone(contactRequestController().snapshot());
      root.configuration = { ...(root.configuration as Record<string, unknown>), agentTools: "off" };
      const builder = agentBuilder({ root });
      const switchOf = (): string => JSON.stringify((builder.controller.snapshot().configuration as Record<string, unknown>).agentTools);
      expect(switchOf()).toBe('"off"');
      okOf(await builder.execute("add_components", { fromData: value }));
      expect(switchOf()).toBe('"off"');
      okOf(await builder.execute("replace_form", { fromData: value }));
      expect(switchOf()).toBe('"off"');
    }
  });
});
