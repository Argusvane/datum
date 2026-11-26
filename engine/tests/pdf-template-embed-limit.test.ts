// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createPdfBuilderMode, type PdfBuilderModeOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import { createAddPopover } from "../form-engine/builder/pdf-designer/pdf-designer-panels.js";
import { embeddedTemplateProblem } from "../form-engine/builder/pdf-designer/pdf-template-source.js";
import type { PdfConfiguration, PdfGeneratedLayout, PdfTemplateSource } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";

/**
 * An uploaded template is stored inside the definition as base64, and a definition past the load
 * limit saves and never opens again. The PDF side asks what the form would weigh before it embeds
 * one, and changes nothing when the answer is "too much". A template from the host's store keeps
 * its bytes out of the definition and is never asked about.
 */

const FORM: ComponentNode = { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } };

function generated(id: string, name: string): PdfGeneratedLayout {
  return { id, kind: "generated", name, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
}

function base64Of(bytes: number): string {
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

/** An upload of `bytes` bytes: its base64 is a third larger inside the definition. */
function upload(bytes: number, name = "intake.pdf"): PdfTemplateSource {
  return { storage: "base64", name, type: "application/pdf", size: bytes, data: base64Of(bytes) };
}

const HOST: PdfTemplateSource = { storage: "asset", name: "intake.pdf", type: "application/pdf", size: 20_000_000, ref: { id: "intake" } };

/** What the wrapper measures: the UTF-8 bytes of the definition's JSON with `pdf` as its block. */
function weigh(limit: number): NonNullable<PdfBuilderModeOptions["definitionBytes"]> {
  return (pdf) => ({ size: new TextEncoder().encode(JSON.stringify({ id: "intake", root: FORM, pdf })).length, limit });
}

function mode(limit: number | undefined, pdf: PdfConfiguration = { layouts: [generated("a", "A")] }) {
  return createPdfBuilderMode({
    formRoot: () => FORM,
    runtime: () => ({}) as RenderableRuntime,
    pdf,
    ...(limit === undefined ? {} : { definitionBytes: weigh(limit) })
  });
}

describe("an uploaded template and the load limit", () => {
  it("refuses a template that would push the form past the limit, and changes nothing", () => {
    const m = mode(1_000_000);
    const before = JSON.stringify(m.pdfConfiguration);
    // 600 000 bytes of PDF are 800 000 of base64, which fits; 800 000 are 1 066 668, which does not.
    expect(() => m.addTemplateLayout(upload(800_000, "big.pdf"), "Big")).toThrowError(/"big\.pdf" \(782 KB\) would make this form 1\.02 MB\. A form opens only up to 976 KB/);
    expect(JSON.stringify(m.pdfConfiguration)).toBe(before);
    expect(m.layouts.map((layout) => layout.id)).toEqual(["a"]);
  });

  it("takes a template that fits, counting the base64 growth", () => {
    const m = mode(1_000_000);
    expect(m.addTemplateLayout(upload(600_000), "Fits").template.storage).toBe("base64");
    expect(m.layouts.map((layout) => layout.id)).toEqual(["a", "fits"]);
  });

  it("holds the form to the limit in force: a raised one takes what a default one refuses", () => {
    const template = upload(1_600_000);
    expect(() => mode(2 * 1024 * 1024).addTemplateLayout(template, "Paper")).toThrowError(/would make this form 2\.0\d MB/);
    expect(() => mode(4 * 1024 * 1024).addTemplateLayout(template, "Paper")).not.toThrow();
  });

  it("never refuses a template from the host's store, whatever its size", () => {
    const m = mode(1_000);
    expect(() => m.addTemplateLayout(HOST, "Hosted")).not.toThrow();
    expect(m.layouts.map((layout) => layout.id)).toEqual(["a", "hosted"]);
  });

  it("asks nothing when the host says nothing about the limit", () => {
    expect(() => mode(undefined).addTemplateLayout(upload(30_000_000), "Anything")).not.toThrow();
  });

  it("refuses a copy of an embedded template that would embed it twice, leaving the original", () => {
    const m = mode(1_500_000, { layouts: [{ id: "paper", kind: "template", name: "Paper", template: upload(600_000), fields: [] }] });
    expect(() => m.duplicateLayout("paper")).toThrowError(/would make this form/);
    expect(m.layouts.map((layout) => layout.id)).toEqual(["paper"]);
  });

  it("refuses a replacement template that is too heavy, and keeps a rename of the one it holds", () => {
    const m = mode(1_500_000, { layouts: [{ id: "paper", kind: "template", name: "Paper", template: upload(600_000), fields: [] }] });
    const current = m.layouts[0]!;
    if (current.kind !== "template") {
      throw new Error("expected a template layout");
    }
    expect(() => m.replaceLayout("paper", { ...current, template: upload(1_400_000, "bigger.pdf") })).toThrowError(/"bigger\.pdf"/);
    expect((m.layouts[0] as typeof current).template.name).toBe("intake.pdf");
    // The same upload under another name is not counted a second time.
    expect(() => m.renameLayout("paper", "Renamed")).not.toThrow();
    // A host template takes its place without a question.
    expect(() => m.replaceLayout("paper", { ...current, template: HOST })).not.toThrow();
  });

  it("refuses an embedded template handed to addLayout", () => {
    const m = mode(1_000_000);
    expect(() => m.addLayout({ id: "x", kind: "template", name: "X", template: upload(900_000), fields: [] })).toThrowError(/would make this form/);
    expect(m.layouts).toHaveLength(1);
  });
});

describe("the message", () => {
  const budget = { size: 2_150_000, limit: 2 * 1024 * 1024 };

  it("says the template's size, what the form would weigh and the limit", () => {
    const message = embeddedTemplateProblem(upload(1_600_000, "form.pdf"), "form.pdf", budget);
    expect(message).toBe(
      '"form.pdf" (1.53 MB) would make this form 2.06 MB. A form opens only up to 2 MB, so it could be saved here and never opened again. Nothing was changed. Use a smaller PDF, or have your host offer this one as a template to choose from.'
    );
  });

  it("is silent for a form that fits, a host template, and no budget", () => {
    expect(embeddedTemplateProblem(upload(10), "a.pdf", { size: 100, limit: 200 })).toBeUndefined();
    expect(embeddedTemplateProblem(HOST, "a.pdf", budget)).toBeUndefined();
    expect(embeddedTemplateProblem(upload(10), "a.pdf", undefined)).toBeUndefined();
  });

  it("rounds so a weight over its limit never reads as equal to it", () => {
    const message = embeddedTemplateProblem(upload(10), "a.pdf", { size: 2 * 1024 * 1024 + 1, limit: 2 * 1024 * 1024 })!;
    expect(message).toContain("would make this form 2.01 MB");
    expect(message).toContain("only up to 2 MB");
  });
});

describe("the Add popover", () => {
  it("says so under the picker and does not ask for a name when the upload is too heavy", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const taken: string[] = [];
    const pop = createAddPopover(host, {
      templates: async () => [],
      canPopulate: () => true,
      locale: () => "en",
      onCustom: () => undefined,
      onTemplate: (source) => taken.push(source.name),
      templateProblem: (source) => embeddedTemplateProblem(source, source.name, { size: 3_000_000, limit: 2 * 1024 * 1024 })
    });
    pop.open(undefined);
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const file = new File([bytes], "heavy.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    const input = host.querySelector<HTMLInputElement>("[data-add-file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.querySelector("[data-add-error]")?.textContent).toContain('"heavy.pdf"');
    expect(host.querySelector("[data-add-error]")?.textContent).toContain("never opened again");
    expect(host.querySelector("[data-add-name-step]")).toBeNull();
    expect(taken).toEqual([]);
  });
});
