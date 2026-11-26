import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@argusvane/datum-engine/core";
import { PDF_ABI_VERSION, type PdfDocumentRequest } from "@argusvane/datum-engine/render";
import { buildFromInputs } from "../src/model/build-document.js";
import { ENV, fonts } from "./helpers.js";

/**
 * The definition's `kinds` map in the PDF program's inputs: a design-system type
 * mapped to `date` prints as the engine's date does, with no binding code, and is no unknown
 * component; without the map it is one.
 */

const form: ComponentNode = {
  id: "f",
  type: "form",
  configuration: { title: "Kinds" },
  children: { content: [{ id: "born", type: "gcds-date", configuration: { label: "Born" } }] }
} as never;

async function request(extra: Partial<PdfDocumentRequest> = {}): Promise<PdfDocumentRequest> {
  return { abi: PDF_ABI_VERSION, op: "document", form, values: { born: "2024-02-29" }, locale: "en", fonts: await fonts(), env: ENV, ...extra } as PdfDocumentRequest;
}

describe("the definition's kinds map in the PDF inputs", () => {
  it("reads a mapped type as its base: drawn as a date, no component.unknown", async () => {
    const mapped = await buildFromInputs((await request({ kinds: { "gcds-date": "date" } } as never)) as never);
    expect(mapped.components.find((model) => model.id === "born")?.type).toBe("date");
    expect(mapped.warnings.map((warning) => warning.code)).not.toContain("component.unknown");
  });

  it("reports the type as unknown without the map", async () => {
    const bare = await buildFromInputs((await request()) as never);
    expect(bare.components.find((model) => model.id === "born")?.type).toBe("gcds-date");
    expect(bare.warnings.map((warning) => warning.code)).toContain("component.unknown");
  });
});
