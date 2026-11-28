import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { holdsPrintAnswer } from "../form-engine/render/core/print-options.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintModel } from "../form-engine/render/print/index.js";
import { runtimeOf } from "./live-chrome-harness.js";

/*
 * A component printed only when answered (`print.show: "answered"`) reads an answer as the printed
 * field and validation do: text of spaces alone is none, so it is not printed to read "Not answered".
 */

const definition = {
  id: "f",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "root",
    type: "form",
    configuration: { title: "T" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "note", type: "text", configuration: { label: "Note", print: { show: "answered" } } }
      ] satisfies ComponentNode[]
    }
  }
} as FormDefinition;

describe("a component printed only when answered", () => {
  it("is left off when its text is spaces alone", async () => {
    const runtime = runtimeOf(definition);
    runtime.setValue("name", "Ada");
    runtime.setValue("note", "   ");
    const printed = JSON.stringify(await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } }));
    expect(printed).toContain("Name");
    expect(printed).not.toContain("Note");
  });

  it("prints when its text holds more than spaces", async () => {
    const runtime = runtimeOf(definition);
    runtime.setValue("note", "  seen  ");
    const printed = JSON.stringify(await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } }));
    expect(printed).toContain("Note");
  });

  it("reads blank text, a number that is not finite and an unticked group as no answer", () => {
    expect(holdsPrintAnswer(" \t\n")).toBe(false);
    expect(holdsPrintAnswer(Number.NaN)).toBe(false);
    expect(holdsPrintAnswer(Number.POSITIVE_INFINITY)).toBe(false);
    expect(holdsPrintAnswer({ a: false, b: undefined })).toBe(false);
    expect(holdsPrintAnswer(false)).toBe(false);
    expect(holdsPrintAnswer(0)).toBe(true);
    expect(holdsPrintAnswer("x")).toBe(true);
    expect(holdsPrintAnswer({ a: true })).toBe(true);
    expect(holdsPrintAnswer(["a"])).toBe(true);
  });
});
