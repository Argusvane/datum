import { describe, expect, it } from "vitest";

import { readComponentJson } from "../form-engine/builder/property-editor/component-json.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { agentBuilder, contactRequestRoot, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * A setting the site manages (`managed-settings`) is bound on every route that writes a
 * component's settings, not only set_properties: an assistant's add, rebuild and copy, and the
 * inspector's JSON tab refuse it with the same words, and write nothing.
 */

const MANAGED = "data.answersFree";
const refusedWith = { code: "protected-setting", message: `${MANAGED} is managed by the site; nothing was written.`, details: { propertyPath: MANAGED, by: "host" } };

const withManaged = (root?: ComponentNode) => agentBuilder({ ...(root ? { root } : {}), ui: uiStub({ managed: [MANAGED] }) });
const idsOf = (root: ComponentNode): string[] => [root.id, ...Object.values(root.children ?? {}).flat().flatMap(idsOf)];

describe("managed settings on every write route", () => {
  it("add_components refuses a component (or one nested in it) that sets a managed path", async () => {
    const builder = withManaged();
    const before = JSON.stringify(builder.controller.snapshot());
    const top = refusalOf(await builder.execute("add_components", { components: [{ type: "select", id: "colour", label: "Colour", options: ["Red"], configuration: { data: { answersFree: true } } }] }));
    expect(top).toMatchObject(refusedWith);
    const nested = refusalOf(await builder.execute("add_components", { components: [{ type: "fieldset", label: "Box", children: [{ type: "select", label: "Colour", options: ["Red"], configuration: { data: { answersFree: true } } }] }] }));
    expect(nested).toMatchObject(refusedWith);
    expect(JSON.stringify(builder.controller.snapshot())).toBe(before);
    // A component that leaves the managed path alone is added as before.
    const plain = await builder.execute("add_components", { components: [{ type: "text", id: "note", label: "Note" }] });
    expect(plain.ok).toBe(true);
  });

  it("replace_form refuses new content that sets a managed path", async () => {
    const builder = withManaged();
    const before = JSON.stringify(builder.controller.snapshot());
    const refused = refusalOf(await builder.execute("replace_form", { components: [{ type: "select", label: "Colour", options: ["Red"], configuration: { data: { answersFree: true } } }] }));
    expect(refused).toMatchObject(refusedWith);
    expect(JSON.stringify(builder.controller.snapshot())).toBe(before);
  });

  it("duplicate_component refuses to copy a component that carries a managed setting", async () => {
    const root = contactRequestRoot();
    (root.children!.content![2]!.configuration as Record<string, unknown>).data = { answersFree: true };
    const builder = withManaged(root);
    const before = idsOf(builder.controller.snapshot());
    const refused = refusalOf(await builder.execute("duplicate_component", { componentId: "topic" }));
    expect(refused).toMatchObject(refusedWith);
    expect(idsOf(builder.controller.snapshot())).toEqual(before);
  });

  it("the JSON tab refuses a change to a managed path, at the key, and keeps one that leaves it as it is", () => {
    const node: ComponentNode = { id: "topic", type: "select", configuration: { label: "Topic", data: { answersFree: false } } };
    const changed = readComponentJson('{"id":"topic","type":"select","configuration":{"label":"Topic","data":{"answersFree":true}}}', node, { idEditable: false, managed: [MANAGED] });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.problem.message).toBe(`${MANAGED} is managed by the site; nothing was written.`);
    }
    const removed = readComponentJson('{"id":"topic","type":"select","configuration":{"label":"Topic"}}', node, { idEditable: false, managed: [MANAGED] });
    expect(removed.ok).toBe(false);
    const kept = readComponentJson('{"id":"topic","type":"select","configuration":{"label":"Subject","data":{"answersFree":false}}}', node, { idEditable: false, managed: [MANAGED] });
    expect(kept.ok).toBe(true);
    const rules = readComponentJson('{"id":"topic","type":"select","configuration":{"label":"Topic","data":{"answersFree":false}},"rules":{"visibleWhen":"true"}}', node, { idEditable: false, managed: ["rules.visibleWhen"] });
    expect(rules.ok).toBe(false);
  });
});
