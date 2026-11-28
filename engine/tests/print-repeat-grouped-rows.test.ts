// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintDocument, buildPrintModel, type PrintGroup, type PrintModel, type PrintNode } from "../form-engine/render/print/index.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { runtimeOf } from "./live-chrome-harness.js";

/*
 * A repeating section whose rows hold groups prints each row as a group headed by its name. A
 * blank form gives it room to write as a table's blank form does (three rows, more when the form
 * needs them, never past its limit), each row its groups with empty fields; a print of answers
 * with no rows says so in words, as a table with no rows does.
 */

function definition(children: ComponentNode[]): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: children } } } as FormDefinition;
}

const kids = (type = "panel", bounds: Record<string, unknown> = {}): ComponentNode =>
  ({
    id: "kids",
    type,
    configuration: { label: "Children", rowLabel: "Child {{n}}", ...bounds },
    collection: { collectionPath: "kids" },
    children: { content: [{ id: "who", type: "fieldset", configuration: { label: "Child" }, children: { content: [{ id: "nm", type: "text", configuration: { label: "Name" } }] } }] }
  }) as ComponentNode;

async function modelOf(runtime: FormRuntime, rendition: "answers" | "filled" | "blank"): Promise<PrintModel> {
  return buildPrintModel(runtime, { rendition, render: { journeyKit: EagerJourneyRenderKit } });
}

const kidsOf = (model: PrintModel): PrintNode | undefined => model.nodes.find((node) => node.id === "kids");

function all(nodes: readonly PrintNode[]): PrintNode[] {
  return nodes.flatMap((node) => [node, ...(node.kind === "group" || node.kind === "section" || node.kind === "run" ? all(node.children) : [])]);
}

describe("a repeating section whose rows hold groups", () => {
  it("prints blank rows to fill in on a blank form, each its groups and empty fields", async () => {
    const model = await modelOf(runtimeOf(definition([kids()])), "blank");
    const group = kidsOf(model) as PrintGroup;
    expect(group.kind).toBe("group");
    expect(group.children.map((child) => (child.kind === "group" ? child.legend : child.kind))).toEqual(["Child 1", "Child 2", "Child 3"]);
    const names = all(group.children).filter((node) => node.kind === "field" && node.id === "nm");
    expect(names).toHaveLength(3);
    expect(names.every((node) => node.kind === "field" && node.empty)).toBe(true);
    const doc = new DOMParser().parseFromString(buildPrintDocument(model), "text/html");
    expect(doc.querySelector('[data-component-id="kids"]')?.textContent).toContain("Child 3");
  });

  it("follows a data grid's row limits on a blank form", async () => {
    const more = kidsOf(await modelOf(runtimeOf(definition([kids("dataGrid", { minRows: 5 })])), "blank")) as PrintGroup;
    expect(more.children).toHaveLength(5);
    const fewer = kidsOf(await modelOf(runtimeOf(definition([kids("dataGrid", { maxRows: 2 })])), "blank")) as PrintGroup;
    expect(fewer.children).toHaveLength(2);
  });

  it("says Not answered on a print of answers with no rows", async () => {
    const model = await modelOf(runtimeOf(definition([kids()])), "answers");
    const doc = new DOMParser().parseFromString(buildPrintDocument(model), "text/html");
    const printed = doc.querySelector('[data-component-id="kids"]');
    expect(printed?.textContent).toContain("Children");
    expect(printed?.querySelector(".dp-empty")?.textContent).toBe("Not answered");
  });

  it("prints the rows given on a print of answers", async () => {
    const runtime = runtimeOf(definition([kids()]));
    runtime.setValue("kids[0].nm", "Ada");
    const group = kidsOf(await modelOf(runtime, "answers")) as PrintGroup;
    expect(group.children.map((child) => (child.kind === "group" ? child.legend : child.kind))).toEqual(["Child 1"]);
  });
});
