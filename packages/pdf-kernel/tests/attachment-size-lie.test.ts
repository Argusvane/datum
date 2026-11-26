import { describe, expect, it } from "vitest";
import { PdfAttachmentCollector, bytesToBase64 } from "@argusvane/datum-engine/render";
import { DEFAULT_PDF_ATTACHMENT_POLICY } from "@argusvane/datum-engine/core";
import { kernelBase64DecodedLength, kernelRunFieldConstraints } from "@argusvane/datum-engine";

// A file's declared `size` is not trusted by the budget or maxFileSizeMb.
describe("a file envelope that understates its size", () => {
  it("is charged by its decoded bytes against the attachment budget", () => {
    const warnings: Array<{ code: string }> = [];
    const collector = new PdfAttachmentCollector(DEFAULT_PDF_ATTACHMENT_POLICY, (w) => warnings.push(w));
    const data = bytesToBase64(new Uint8Array(Math.round(2.02 * 1024 * 1024)));
    const size = 2 * 1024 * 1024;
    collector.add({ storage: "base64", name: "a.bin", type: "application/octet-stream", size, data } as never, "doc");
    collector.add({ storage: "base64", name: "b.bin", type: "application/octet-stream", size, data } as never, "doc");
    expect(collector.list()).toHaveLength(1);
    expect(warnings.map((w) => w.code)).toEqual(["attachment.skipped"]);
  });

  it("is refused by maxFileSizeMb on its decoded bytes", () => {
    const root = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "doc", type: "file", configuration: { maxFileSizeMb: 0.001 } }] } } as never;
    const data = Buffer.alloc(4096).toString("base64");
    const lie = kernelRunFieldConstraints(root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 4000, data } }, "en");
    expect(lie.map((e) => e.code)).toEqual(["maxFileSize"]);
  });

  // Bytes well past the declared size are refused, not just charged.
  it("is refused as file.sizeMismatch when the bytes exceed the declared size by more than 1% + 1 KiB", () => {
    const root = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "doc", type: "file", configuration: {} }] } } as never;
    const data = Buffer.alloc(4096).toString("base64");
    const lie = kernelRunFieldConstraints(root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 10, data } }, "en");
    expect(lie.map((e) => e.code)).toEqual(["file.sizeMismatch"]);
    const honest = kernelRunFieldConstraints(root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 4000, data } }, "en");
    expect(honest).toEqual([]);
  });

  it("is skipped by the PDF collector with file.sizeMismatch, or refuses under the fail policy", () => {
    const data = bytesToBase64(new Uint8Array(4096));
    const file = { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 0, data } as never;
    const warnings: Array<{ code: string }> = [];
    const collector = new PdfAttachmentCollector(DEFAULT_PDF_ATTACHMENT_POLICY, (w) => warnings.push(w));
    collector.add(file, "doc");
    expect(collector.list()).toHaveLength(0);
    expect(warnings.map((w) => w.code)).toEqual(["file.sizeMismatch"]);
    const strict = new PdfAttachmentCollector({ ...DEFAULT_PDF_ATTACHMENT_POLICY, onExceeded: "fail" }, () => undefined);
    expect(() => strict.add(file, "doc")).toThrow(/sizeMismatch/);
  });
});

// Wrapped base64 from an honest client is not a size lie.
describe("a file envelope with line-wrapped base64", () => {
  const wrap = (data: string, width: number, eol: string): string => (data.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join(eol) + eol;
  const root = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "doc", type: "file", configuration: {} }] } } as never;
  const bytes = 1024 * 1024;
  const plain = Buffer.alloc(bytes, 7).toString("base64");

  for (const [name, eol, width] of [["LF at 76", "\n", 76], ["CRLF at 64", "\r\n", 64], ["CRLF at 76", "\r\n", 76]] as const) {
    it(`is accepted by the kernel check (${name}) and the PDF collector`, () => {
      const data = wrap(plain, width, eol);
      expect(data.length).toBeGreaterThan(bytes * 1.33 * 1.01 + 1024);
      const ok = kernelRunFieldConstraints(root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: bytes, data } }, "en");
      expect(ok).toEqual([]);
      const warnings: Array<{ code: string }> = [];
      const collector = new PdfAttachmentCollector({ ...DEFAULT_PDF_ATTACHMENT_POLICY, budgetBytes: 8 * 1024 * 1024 }, (w) => warnings.push(w));
      collector.add({ storage: "base64", name: "a.bin", type: "application/octet-stream", size: bytes, data } as never, "doc");
      expect(warnings).toEqual([]);
      expect(collector.list()).toHaveLength(1);
    });
  }

  it("still counts wrapped bytes against a lie", () => {
    const data = wrap(plain, 76, "\n");
    const lie = kernelRunFieldConstraints(root, { doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 1000, data } }, "en");
    expect(lie.map((e) => e.code)).toEqual(["file.sizeMismatch"]);
    expect(lie[0]!.parameters).toMatchObject({ actual: bytes });
  });

  it("counts a data URL's payload, not its prefix, and unpadded text", () => {
    expect(kernelBase64DecodedLength("data:application/octet-stream;base64," + plain)).toBe(bytes);
    expect(kernelBase64DecodedLength(plain.replace(/=+$/, ""))).toBe(bytes);
    expect(kernelBase64DecodedLength("QUJD\nREVG\r\nRw==")).toBe(7);
    expect(kernelBase64DecodedLength("")).toBe(0);
  });
});
