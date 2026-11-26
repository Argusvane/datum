import { describe, expect, it } from "vitest";

import { assertValidComponentId, componentIdProblem, isValidComponentId } from "../form-engine/core/tree/component-id.js";
import { readComponentJson } from "../form-engine/builder/property-editor/component-json.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { agentBuilder, contactRequestController, contactRequestRoot, okOf, refusalOf } from "./fixtures/agent-builder.js";

/**
 * `component`, `host`, `row` and `ancestor` are names a rule reads as its own (the rule's own
 * value, the host's values, a grid row, an enclosing scope), so a component named one of them
 * could never be read by its id. They are reserved like `constructor` and `prototype`, and every
 * route that names an id refuses them with one message naming the word.
 */

const RESERVED = ["component", "host", "row", "ancestor", "constructor", "prototype"];

describe("reserved component ids", () => {
  it("are not component ids, and the refusal names the word", () => {
    for (const word of RESERVED) {
      expect(isValidComponentId(word)).toBe(false);
      expect(componentIdProblem(word)).toBe(`"${word}" cannot be a component id: it is a reserved word (component, host, row, ancestor, constructor and prototype are).`);
      expect(() => assertValidComponentId(word)).toThrow(`"${word}" cannot be a component id: it is a reserved word`);
    }
    // Lookalikes stay ids.
    for (const id of ["rows", "row_1", "hostName", "components", "Row"]) {
      expect(isValidComponentId(id)).toBe(true);
    }
    expect(componentIdProblem("2fa")).toBe('"2fa" cannot be a component id: start with a letter, then letters, digits, _ or -.');
  });

  it("are refused by the inspector's id box and by a rename", () => {
    const ctrl = contactRequestController();
    ctrl.select("email");
    ctrl.setDraftId("email", "row");
    expect(ctrl.problemsOf("email")).toEqual([{ target: "id", message: expect.stringContaining('"row" cannot be a component id: it is a reserved word') }]);
    expect(ctrl.commitDraft("email")).toBe(false);
    ctrl.renameId("email", "host");
    expect(ctrl.idError).toContain('"host" cannot be a component id: it is a reserved word');
  });

  it("are refused when a component is added under one", () => {
    const ctrl = contactRequestController();
    const result = ctrl.insertComponents([{ node: { id: "ancestor", type: "text", configuration: {} }, parentId: "root", slotId: "content" }]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('"ancestor" cannot be a component id: it is a reserved word') });
  });

  it("are refused by the JSON tab, pointing at the id", () => {
    const field: ComponentNode = { id: "a", type: "text", configuration: {} };
    const result = readComponentJson('{"id":"component","type":"text","configuration":{}}', field, { idEditable: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.message).toBe('"component" cannot be a component id: it is a reserved word (component, host, row, ancestor, constructor and prototype are).');
    }
  });

  it("are refused by the agent's add and rename, and flagged by check_form", async () => {
    const builder = agentBuilder();
    const added = refusalOf(await builder.execute("add_components", { components: [{ type: "text", id: "row", label: "Row" }] }));
    expect(added).toMatchObject({ code: "invalid-id", message: expect.stringContaining('"row" cannot be a component id: it is a reserved word') });
    const renamed = refusalOf(await builder.execute("rename_component", { componentId: "email", newId: "host" }));
    expect(renamed).toMatchObject({ code: "invalid-id", message: expect.stringContaining('"host" cannot be a component id: it is a reserved word') });

    const root = contactRequestRoot();
    root.children!.content!.push({ id: "component", type: "text", configuration: { label: "Odd" } });
    const loaded = agentBuilder({ root });
    const checked = okOf<{ findings: Array<{ code: string; componentId: string; message: string }> }>(await loaded.execute("check_form", {}));
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: "invalid-id", componentId: "component", message: expect.stringContaining('"component" cannot be a component id: it is a reserved word') }));
  });
});
