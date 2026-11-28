// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildReviewModel, type ReviewRow } from "../form-engine/render/core/journey-review.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { answerTextOf } from "../form-engine/render/print/field-answer.js";
import { buildPrintDocument, buildPrintModel, printAnswerText, type PrintField, type PrintModel, type PrintNode } from "../form-engine/render/print/index.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { definitionOf, runtimeOf } from "./live-chrome-harness.js";

/*
 * Answers print and Check answers word alike (`answerTextOf` is print's own wording): a value no
 * option lists still reads as stored, text of spaces alone is no answer, only `true` ticks a lone
 * checkbox, and a secret's answer is a mask.
 */

function definition(children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: children } }, ...extra } as FormDefinition;
}

async function printOf(runtime: FormRuntime, rendition: "answers" | "filled" = "answers"): Promise<PrintModel> {
  return buildPrintModel(runtime, { rendition, render: { journeyKit: EagerJourneyRenderKit } });
}

function fieldOf(model: PrintModel, id: string): PrintField {
  const walk = (nodes: readonly PrintNode[]): PrintNode[] => nodes.flatMap((node) => [node, ...("children" in node ? walk(node.children) : [])]);
  return walk(model.nodes).find((node): node is PrintField => node.kind === "field" && node.id === id)!;
}

async function answerOf(runtime: FormRuntime, id: string, base: string, value?: { stored: unknown }) {
  const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
  const model = output.components.find((candidate) => candidate.id === id)!;
  return answerTextOf(value ? { ...model, value: value.stored } : model, base, "en");
}

const colours = [
  { value: "r", label: "Red" },
  { value: "g", label: "Green" }
];

describe("a choice no option lists", () => {
  const form = () =>
    definition([
      { id: "colour", type: "radio", configuration: { label: "Colour", options: colours } },
      { id: "extras", type: "checkboxes", configuration: { label: "Extras", options: colours } }
    ]);

  it("prints as stored, as a chosen option of its own", async () => {
    const runtime = runtimeOf(form());
    runtime.setValue("colour", "violet");
    runtime.setValue("extras", ["r", "blue"]);
    for (const rendition of ["answers", "filled"] as const) {
      const model = await printOf(runtime, rendition);
      expect(printAnswerText(fieldOf(model, "colour")), rendition).toBe("violet");
      expect(printAnswerText(fieldOf(model, "extras")), rendition).toBe("Red, blue");
    }
    expect(await answerOf(runtime, "colour", "radio")).toEqual({ text: "violet", empty: false });
    expect(await answerOf(runtime, "extras", "checkboxes")).toEqual({ text: "Red, blue", empty: false });
  });

  it("adds nothing for a listed answer", async () => {
    const runtime = runtimeOf(form());
    runtime.setValue("colour", "g");
    const model = await printOf(runtime);
    const answer = fieldOf(model, "colour").answer;
    expect(answer.shape === "choices" ? answer.options.map((option) => [option.label, option.chosen]) : []).toEqual([
      ["Red", false],
      ["Green", true]
    ]);
  });
});

describe("an answer of spaces alone", () => {
  it("prints Not answered", async () => {
    const runtime = runtimeOf(definition([{ id: "name", type: "text", configuration: { label: "Name" } }, { id: "notes", type: "textarea", configuration: { label: "Notes" } }]));
    runtime.setValue("name", "   ");
    runtime.setValue("notes", " \n\t ");
    const model = await printOf(runtime);
    expect(fieldOf(model, "name").empty).toBe(true);
    expect(fieldOf(model, "notes").empty).toBe(true);
    const doc = new DOMParser().parseFromString(buildPrintDocument(model), "text/html");
    expect(doc.querySelector('[data-component-id="name"] .dp-empty')?.textContent).toBe("Not answered");
    expect((await answerOf(runtime, "name", "text"))?.empty).toBe(true);
  });

  it("is a required answer missing on Check answers, with an Enter link", async () => {
    const journey = { id: "apply", pages: [{ id: "one", title: "You", components: ["name"] }, { id: "check", kind: "review", title: "Check", components: [] }] } as Journey;
    const runtime = runtimeOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name", required: true } }], { journey: { journeys: [journey] } }));
    runtime.startJourney("apply");
    runtime.setValue("name", "Ada");
    expect((await runtime.nextPage()).pageId).toBe("check");
    runtime.setValue("name", "   ");
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    const review = buildReviewModel({ view: runtime.journeyView()!, components: output.components, locale: "en", sources: {}, text: createFormTextResolver("en") })!;
    const row = review.sections.flatMap((section) => section.items).find((item): item is ReviewRow => item.kind === "row" && item.componentId === "name");
    expect(row).toMatchObject({ status: "missing", value: "" });
    expect(row?.enter?.pageId).toBe("one");
  });
});

describe("a lone checkbox", () => {
  it("is ticked by true alone", async () => {
    const runtime = runtimeOf(definition([{ id: "agree", type: "checkbox", configuration: { label: "I agree" } }]));
    // The value as read, whatever writing it would have made of it.
    for (const stored of ["true", 1, "on", "yes", false, "false"]) {
      expect(await answerOf(runtime, "agree", "checkbox", { stored }), String(stored)).toEqual({ text: "", empty: true });
    }
    runtime.setValue("agree", true);
    expect(fieldOf(await printOf(runtime), "agree").empty).toBe(false);
    expect(await answerOf(runtime, "agree", "checkbox")).toEqual({ text: "I agree", empty: false });
  });
});

describe("a secret's answer", () => {
  for (const [name, node, kinds] of [
    ["a password type", { id: "pw", type: "password", configuration: { label: "Password" } }, undefined],
    ["a password type read as text", { id: "pw", type: "password", configuration: { label: "Password" } }, { password: "text" }]
  ] as Array<[string, ComponentNode, Record<string, string> | undefined]>) {
    it(`prints as a mask: ${name}`, async () => {
      const runtime = runtimeOf(definition([node], kinds ? { kinds } : {}));
      runtime.setValue("pw", "hunter2");
      for (const rendition of ["answers", "filled"] as const) {
        const model = await printOf(runtime, rendition);
        expect(printAnswerText(fieldOf(model, "pw")), rendition).toBe("••••••••");
        expect(buildPrintDocument(model), rendition).not.toContain("hunter2");
      }
      expect((await answerOf(runtime, "pw", kinds?.[node.type] ?? node.type))?.text).toBe("••••••••");
    });
  }
});
