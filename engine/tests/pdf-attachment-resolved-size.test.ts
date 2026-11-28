import { describe, expect, it } from "vitest";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfConfiguration } from "../form-engine/core/schema/pdf-layout.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfKernelRequest } from "../form-engine/render/pdf/pdf-abi.js";
import { enforceAttachmentBudget, resolvedSizeMismatch } from "../form-engine/render/pdf/pdf-attachments.js";
import type { PdfDocumentAttachment, PdfWarning } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { renderFormPdf } from "../form-engine/render/pdf/pdf-service.js";

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const MIB = 1024 * 1024;
const environment = { now: () => "2026-09-05T10:11:12.345Z", newDocumentId: () => "doc-1" };

/** An envelope that declares ten bytes for a file the storage holds more of. */
const hosted = { storage: "s3", name: "scan.bin", type: "application/octet-stream", size: 10, ref: "u/1" };

function filesRuntime(values: Record<string, unknown>, pdf?: PdfConfiguration): RenderableRuntime {
  const form: ComponentNode = {
    id: "claim",
    type: "form",
    configuration: { title: "Claim" },
    children: { content: [{ id: "archive", type: "file", configuration: { label: "Archive", storage: "s3", pdf: { attach: true } } }] }
  };
  const state: FormState = {
    values,
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
  return {
    formRoot: () => form,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(form),
    resolveDataSource: async () => undefined,
    pdfConfiguration: () => pdf
  };
}

function provider(): PdfRenderProvider & { requests: PdfKernelRequest[] } {
  const requests: PdfKernelRequest[] = [];
  const names = (attachments: Array<{ name: string }> | undefined) => (attachments ? { attachments: attachments.map((entry) => entry.name) } : {});
  return {
    id: "fake",
    abiVersion: "4.0.0",
    requests,
    render: async (request) => {
      requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", ...names(request.document.attachments) };
    },
    fill: async (request) => {
      requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [], ...names(request.attachments) };
    }
  };
}

const returning = (length: number) => ({ resolve: async () => new Uint8Array(length) });

const template: PdfConfiguration = {
  layouts: [{ id: "gov", kind: "template", template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" }, fields: [] }]
};

describe("resolved uploads are checked against their declared size and the budget over their bytes", () => {
  it("leaves out a stored file whose bytes exceed its declared size, within the budget", async () => {
    const fake = provider();
    const result = await renderFormPdf(filesRuntime({ archive: hosted }), { provider: fake, environment, templates: returning(2048) }, { attachments: { budgetBytes: MIB } });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "file.sizeMismatch", componentId: "archive" })]);
    const request = fake.requests[0]!;
    expect(request.op === "render" ? request.document.attachments ?? [] : undefined).toEqual([]);
  });

  it("refuses the document under fail when an under-declared file would take it past the budget", async () => {
    await expect(
      renderFormPdf(filesRuntime({ archive: hosted }), { provider: provider(), environment, templates: returning(2 * MIB) }, { attachments: { budgetBytes: MIB, onExceeded: "fail" } })
    ).rejects.toMatchObject({ name: "PdfKernelError", code: "attachment_budget" });
  });

  it("refuses the document under fail for a size mismatch inside the budget", async () => {
    await expect(
      renderFormPdf(filesRuntime({ archive: hosted }), { provider: provider(), environment, templates: returning(11) }, { attachments: { budgetBytes: MIB, onExceeded: "fail" } })
    ).rejects.toMatchObject({ name: "PdfKernelError", code: "attachment_budget", message: expect.stringContaining("file.sizeMismatch") });
  });

  it("leaves out an under-declared file past the budget under skip", async () => {
    const result = await renderFormPdf(filesRuntime({ archive: hosted }), { provider: provider(), environment, templates: returning(2 * MIB) }, { attachments: { budgetBytes: MIB } });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["file.sizeMismatch"]);
    expect(result.attachments).toEqual([]);
  });

  it("attaches an honest file, keeping its declared size and sending the policy to the kernel", async () => {
    const fake = provider();
    const honest = { ...hosted, size: 2048 };
    const result = await renderFormPdf(filesRuntime({ archive: honest }), { provider: fake, environment, templates: returning(2048) }, { attachments: { budgetBytes: MIB } });
    expect(result.warnings).toEqual([]);
    expect(result.attachments).toEqual(["scan.bin"]);
    const request = fake.requests[0]!;
    if (request.op !== "render") {
      throw new Error("expected a render request");
    }
    expect(request.document.attachments).toEqual([expect.objectContaining({ name: "scan.bin", declaredSize: 2048 })]);
    expect(request.document.attachmentPolicy).toEqual({ budgetBytes: MIB, onExceeded: "skip" });
  });

  it("checks a template fill's resolved files the same way and sends it the policy", async () => {
    const storage = (length: number) => ({ resolve: async (source: { ref?: unknown }) => (source.ref === "u/1" ? new Uint8Array(length) : new Uint8Array(PDF_MAGIC)) });
    const lying = await renderFormPdf(filesRuntime({ archive: hosted }, template), { provider: provider(), environment, templates: storage(4096) }, { layoutId: "gov" });
    expect(lying.warnings.map((warning) => warning.code)).toEqual(["file.sizeMismatch"]);
    expect(lying.attachments ?? []).toEqual([]);

    const fake = provider();
    const honest = await renderFormPdf(filesRuntime({ archive: { ...hosted, size: 4096 } }, template), { provider: fake, environment, templates: storage(4096) }, { layoutId: "gov", attachments: { budgetBytes: MIB } });
    expect(honest.attachments).toEqual(["scan.bin"]);
    const request = fake.requests[0]!;
    if (request.op !== "fill") {
      throw new Error("expected a fill request");
    }
    expect(request.attachments).toEqual([expect.objectContaining({ name: "scan.bin", declaredSize: 4096 })]);
    expect(request.attachmentPolicy).toEqual({ budgetBytes: MIB, onExceeded: "skip" });
  });
});

describe("enforceAttachmentBudget", () => {
  const entry = (name: string, bytes: number, declaredSize?: number): PdfDocumentAttachment => ({
    name,
    mimeType: "application/octet-stream",
    relationship: "Supplement",
    componentId: "archive",
    data: Buffer.alloc(bytes).toString("base64"),
    ...(declaredSize !== undefined ? { declaredSize } : {})
  });

  it("charges the decoded bytes of files that carry no declared size, skipping what does not fit", () => {
    const warnings: PdfWarning[] = [];
    const kept = enforceAttachmentBudget([entry("a.bin", 600), entry("b.bin", 600), entry("c.bin", 300)], { budgetBytes: 1000, onExceeded: "skip" }, (warning) => warnings.push(warning));
    expect(kept.map((file) => file.name)).toEqual(["a.bin", "c.bin"]);
    expect(warnings).toEqual([expect.objectContaining({ code: "attachment.skipped", componentId: "archive" })]);
  });

  it("refuses under fail when the bytes pass the budget", () => {
    expect(() => enforceAttachmentBudget([entry("a.bin", 1200)], { budgetBytes: 1000, onExceeded: "fail" }, () => {})).toThrow(
      expect.objectContaining({ name: "PdfKernelError", code: "attachment_budget" })
    );
  });

  it("keeps entries still waiting for their bytes", () => {
    const pending: PdfDocumentAttachment = { name: "x", mimeType: "application/zip", relationship: "Supplement", componentId: "archive", source: hosted };
    expect(enforceAttachmentBudget([pending], { budgetBytes: 0, onExceeded: "fail" }, () => {})).toEqual([pending]);
  });

  it("treats any byte past the declared size as a mismatch, and a shortfall only past 1 % and 1 KiB", () => {
    expect(resolvedSizeMismatch(1000, 1001)).toBe(true);
    expect(resolvedSizeMismatch(1000, 1000)).toBe(false);
    expect(resolvedSizeMismatch(1000, 0)).toBe(false);
    expect(resolvedSizeMismatch(100_000, 98_000)).toBe(false);
    expect(resolvedSizeMismatch(100_000, 97_000)).toBe(true);
    expect(resolvedSizeMismatch(undefined, 1)).toBe(true);
  });
});
