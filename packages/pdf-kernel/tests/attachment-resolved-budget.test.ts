import { describe, expect, it } from "vitest";
import { bytesToBase64, type PdfDocumentAttachment } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { fillTemplate } from "../src/kernel/template.js";
import { ENV, fonts } from "./helpers.js";
import { FILL_OPTIONS, SUBMISSION, archivalDocument, plainTemplate, withoutClaim } from "./pdfa-fixtures.js";

/** An uploaded file of `bytes` zero bytes, as a host hands it over once its storage returned them. */
function upload(name: string, bytes: number, declaredSize?: number): PdfDocumentAttachment {
  return {
    name,
    mimeType: "application/octet-stream",
    relationship: "Supplement",
    componentId: "archive",
    data: bytesToBase64(new Uint8Array(bytes)),
    ...(declaredSize !== undefined ? { declaredSize } : {})
  };
}

describe("the kernel charges resolved uploads by their bytes", () => {
  it("leaves out a file whose bytes exceed the size its envelope declared", async () => {
    const rendered = await renderDocument(withoutClaim(archivalDocument({ attachments: [upload("lie.bin", 4096, 10), upload("ok.bin", 100, 100)] })), await fonts(), ENV);
    expect(rendered.attachments).toEqual(["ok.bin"]);
    expect(rendered.warnings).toEqual([expect.objectContaining({ code: "file.sizeMismatch", componentId: "archive" })]);
  });

  it("applies the document's budget over the decoded bytes, skipping what does not fit", async () => {
    const rendered = await renderDocument(
      withoutClaim(archivalDocument({ attachments: [upload("a.bin", 600), upload("b.bin", 600), upload("c.bin", 300)], attachmentPolicy: { budgetBytes: 1000, onExceeded: "skip" } })),
      await fonts(),
      ENV
    );
    expect(rendered.attachments).toEqual(["a.bin", "c.bin"]);
    expect(rendered.warnings.map((warning) => warning.code)).toEqual(["attachment.skipped"]);
  });

  it("refuses the document under fail, for a size mismatch and for the budget", async () => {
    const policy = { budgetBytes: 1000, onExceeded: "fail" as const };
    await expect(renderDocument(withoutClaim(archivalDocument({ attachments: [upload("lie.bin", 500, 10)], attachmentPolicy: policy })), await fonts(), ENV)).rejects.toMatchObject({
      code: "attachment_budget",
      message: expect.stringContaining("file.sizeMismatch")
    });
    await expect(renderDocument(withoutClaim(archivalDocument({ attachments: [upload("big.bin", 2000, 2000)], attachmentPolicy: policy })), await fonts(), ENV)).rejects.toMatchObject({
      code: "attachment_budget"
    });
  });

  it("does not charge the submission attachment to the uploads' budget", async () => {
    const rendered = await renderDocument(
      archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] }, attachments: [upload("a.bin", 900)], attachmentPolicy: { budgetBytes: 1000, onExceeded: "fail" } }),
      await fonts(),
      ENV
    );
    expect(rendered.attachments).toEqual(["submission.json", "a.bin"]);
  });

  it("checks a fill's uploads the same way", async () => {
    const filled = await fillTemplate(await plainTemplate(), {}, FILL_OPTIONS, await fonts(), ENV, [], undefined, [upload("lie.bin", 4096, 10), upload("b.bin", 600), upload("c.bin", 600)], {}, {
      budgetBytes: 1000,
      onExceeded: "skip"
    });
    expect(filled.attachments).toEqual(["b.bin"]);
    expect(filled.warnings.map((warning) => warning.code)).toEqual(["file.sizeMismatch", "attachment.skipped"]);
  });
});
