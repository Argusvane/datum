import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import type { PdfKernelRequest } from "../form-engine/render/pdf/pdf-abi.js";
import { walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { renderFormPdf } from "../form-engine/render/pdf/pdf-service.js";

function provider(): PdfRenderProvider & { requests: PdfKernelRequest[] } {
  const requests: PdfKernelRequest[] = [];
  return {
    id: "fake",
    abiVersion: "1.0.0",
    requests,
    render: async (request) => {
      requests.push(request);
      return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
    }
  };
}

const environment = { now: () => "2026-09-05T10:11:12.345Z", newDocumentId: () => "doc-1" };

describe("the browser PDF and the definition's kinds map", () => {
  it("prints a type the map names as its base engine type, with no unknown-component warning", async () => {
    const definition: FormDefinition = {
      id: "kinds",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      kinds: { "gcds-checkbox": "checkbox" },
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "agree", type: "gcds-checkbox", configuration: { label: "I agree" } }] }
      }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "standard", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.setValue("agree", true);
    const kernel = provider();
    const result = await renderFormPdf(runtime, { provider: kernel, environment }, { unknownComponents: "fail" });
    const request = kernel.requests[0];
    const blocks: PdfBlock[] = [];
    if (request?.op === "render") {
      walkPdfBlocks(request.document.blocks, (block) => blocks.push(block));
    }
    const agree = blocks.find((block) => "componentId" in block && block.componentId === "agree");
    expect(agree?.kind).toBe("checkmark");
    expect(agree && agree.kind === "checkmark" ? agree.checked : undefined).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("component.unknown");
  });
});
