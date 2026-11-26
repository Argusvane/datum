import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const root = (): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: { label: "a" } }] } });
const make = (identity = { id: "form-1", version: "1.0.0", schemaVersion: "1" }) =>
  new BuilderController({ initialRoot: root(), componentDefinitions: DEFS, identity });

describe("identity problems lead Save to them", () => {
  it("lists a too-long id and version under the form root, by box", () => {
    const c = make();
    c.select(c.rootId());
    expect(c.problemsOf(c.rootId())).toEqual([]);
    c.setDraftIdentity({ id: "x".repeat(129), version: "9".repeat(65), schemaVersion: "1" });
    const problems = c.problemsOf(c.rootId());
    expect(problems.map((p) => p.target)).toEqual(["identity.id", "identity.version"]);
    expect(problems[0]!.message).toMatch(/128/);
    expect(problems[1]!.message).toMatch(/64/);
    expect(c.commitDraft(c.rootId())).toBe(false);
    c.setDraftIdentity({ id: "x", version: "2", schemaVersion: "1" });
    expect(c.problemsOf(c.rootId())).toEqual([]);
    expect(c.commitDraft(c.rootId())).toBe(true);
  });

  it("names the cause when a loaded identity past the limits holds back an unrelated edit", () => {
    const c = make({ id: "y".repeat(200), version: "1", schemaVersion: "1" });
    c.select(c.rootId());
    c.setDraftProperty(c.rootId(), "title", "A title");
    expect(c.problemsOf(c.rootId()).map((p) => p.target)).toEqual(["identity.id"]);
    expect(c.commitDraft(c.rootId())).toBe(false);
  });

  it("does not list them under another component", () => {
    const c = make();
    c.setDraftIdentity({ id: "x".repeat(129), version: "1", schemaVersion: "1" });
    expect(c.problemsOf("a")).toEqual([]);
  });
});

describe("setIdentity applies the same limits as the draft", () => {
  it("refuses a field past the limit and keeps the committed identity", () => {
    const c = make();
    expect(() => c.setIdentity({ id: "y".repeat(300), version: "v".repeat(100), schemaVersion: "1" })).toThrow(/128|64/);
    expect(c.identity()).toEqual({ id: "form-1", version: "1.0.0", schemaVersion: "1" });
    c.setIdentity({ id: "y".repeat(128), version: "v".repeat(64), schemaVersion: "1" });
    expect(c.identity()?.version).toHaveLength(64);
  });
});
