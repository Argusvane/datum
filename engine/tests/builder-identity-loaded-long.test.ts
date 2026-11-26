import { describe, expect, it } from "vitest";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A stored form may carry an id or version past the limits (it opens, and the Identity section
 * says so). setIdentity refuses only what it is asked to write: a field it changes past the
 * limit, never the over-long field the form was loaded with.
 */

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } }
];
const root = (): ComponentNode => ({ id: "root", type: "form", configuration: {}, children: { content: [] } });
const LONG_ID = "y".repeat(200);
const LONG_VERSION = "9".repeat(80);
const make = (identity: { id: string; version: string; schemaVersion: string }) =>
  new BuilderController({ initialRoot: root(), componentDefinitions: DEFS, identity });

describe("setIdentity on a form loaded with an over-long field", () => {
  it("writes a new version and keeps the long id it was loaded with", () => {
    const c = make({ id: LONG_ID, version: "1", schemaVersion: "1" });
    c.setIdentity({ ...c.identity()!, version: "2" });
    expect(c.identity()).toEqual({ id: LONG_ID, version: "2", schemaVersion: "1" });
    // Still reported where the author edits it.
    expect(c.identityProblems().id).toMatch(/128/);
  });

  it("writes a new id and keeps the long version it was loaded with", () => {
    const c = make({ id: "form-1", version: LONG_VERSION, schemaVersion: "1" });
    c.setIdentity({ id: "form-2", version: LONG_VERSION, schemaVersion: "1" });
    expect(c.identity()).toEqual({ id: "form-2", version: LONG_VERSION, schemaVersion: "1" });
  });

  it("still refuses a field it changes past the limit, keeping the committed identity", () => {
    const c = make({ id: LONG_ID, version: "1", schemaVersion: "1" });
    expect(() => c.setIdentity({ id: "z".repeat(129), version: "2", schemaVersion: "1" })).toThrow(/128/);
    expect(() => c.setIdentity({ id: LONG_ID, version: "v".repeat(65), schemaVersion: "1" })).toThrow(/64/);
    expect(c.identity()).toEqual({ id: LONG_ID, version: "1", schemaVersion: "1" });
  });
});
