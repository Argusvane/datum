import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { dataKeyProblemOf, isValidDataKey } from "../form-engine/core/tree/data-scope.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const root = (): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: { label: "a" } }] } });
const make = () => new BuilderController({ initialRoot: root(), componentDefinitions: DEFS, identity: { id: "form-1", version: "1.0.0", schemaVersion: "1" } });

describe("the Identity section keeps within what Open takes", () => {
  it("refuses a version over 64 characters and an id over 128, naming the box", () => {
    const c = make();
    c.select(c.rootId());
    c.setDraftIdentity({ id: "form-1", version: "9".repeat(65), schemaVersion: "1" });
    expect(c.identityProblems().version).toMatch(/64/);
    expect(c.identityProblems().id).toBeUndefined();
    expect(c.commitDraft(c.rootId())).toBe(false);
    expect(c.identity()?.version).toBe("1.0.0");
    c.setDraftIdentity({ id: "x".repeat(129), version: "2", schemaVersion: "1" });
    expect(c.identityProblems().id).toMatch(/128/);
    expect(c.commitDraft(c.rootId())).toBe(false);
    expect(c.identity()?.id).toBe("form-1");
  });
  it("commits the limits themselves and clears the problem once the box is fixed", () => {
    const c = make();
    c.select(c.rootId());
    c.setDraftIdentity({ id: "x".repeat(128), version: "9".repeat(64), schemaVersion: "1" });
    expect(c.identityProblems()).toEqual({});
    expect(c.commitDraft(c.rootId())).toBe(true);
    expect(c.identity()?.version).toHaveLength(64);
    c.setDraftIdentity({ id: "x", version: "9".repeat(80), schemaVersion: "1" });
    expect(Object.keys(c.identityProblems())).toEqual(["version"]);
    c.setDraftIdentity({ id: "x", version: "3", schemaVersion: "1" });
    expect(c.identityProblems()).toEqual({});
  });
});

describe("a data key that is __proto__", () => {
  it("is not a data key, with the kernel's words", () => {
    expect(isValidDataKey("__proto__")).toBe(false);
    expect(dataKeyProblemOf("__proto__")).toBe("The name __proto__ is not allowed as a data key or a path.");
    expect(isValidDataKey("__proto")).toBe(true);
    expect(isValidDataKey("constructor")).toBe(true);
  });
  it("is refused where it is set: Save keeps the draft and says so", () => {
    const c = make();
    c.select("a");
    c.setDraftProperty("a", "dataKey", "__proto__");
    expect(c.dataKeyError).toMatch(/__proto__/);
    expect(c.commitDraft("a")).toBe(false);
    expect(c.getProperty("a", "dataKey")).toBeUndefined();
  });
});
