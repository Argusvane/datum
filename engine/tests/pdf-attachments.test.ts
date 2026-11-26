import { describe, expect, it } from "vitest";

import type { FileAttachment } from "../form-engine/core/schema/file-upload.js";
import { PdfKernelError } from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfWarning } from "../form-engine/render/pdf/pdf-document.js";
import { PDF_ATTACHMENT_MIME_FALLBACK, PdfAttachmentCollector, attachmentMimeType, sanitizeAttachmentName, uploadedAttachment } from "../form-engine/render/pdf/pdf-attachments.js";

const photo: FileAttachment & { data: string } = { storage: "base64", name: "photo.png", type: "image/png", size: 68, data: "iVBORw0KGgo=" };
const scan: FileAttachment & { data: string } = { storage: "base64", name: "scan.pdf", type: "application/pdf", size: 4, data: "JVBERg==" };
const hosted: FileAttachment & { ref: unknown } = { storage: "s3", name: "big.zip", type: "application/zip", size: 1024, ref: { key: "u/1" } };

function collector(budgetBytes: number, onExceeded: "skip" | "fail" = "skip"): { collector: PdfAttachmentCollector; warnings: PdfWarning[] } {
  const warnings: PdfWarning[] = [];
  return { collector: new PdfAttachmentCollector({ budgetBytes, onExceeded }, (warning) => warnings.push(warning)), warnings };
}

describe("attachmentMimeType", () => {
  it("keeps a well-formed type, lower-cased and trimmed, and falls back to octet-stream otherwise", () => {
    expect(attachmentMimeType("image/png")).toBe("image/png");
    expect(attachmentMimeType(" IMAGE/PNG ")).toBe("image/png");
    expect(attachmentMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(attachmentMimeType("image/svg+xml")).toBe("image/svg+xml");
    expect(attachmentMimeType("")).toBe(PDF_ATTACHMENT_MIME_FALLBACK);
    expect(attachmentMimeType("bogus")).toBe(PDF_ATTACHMENT_MIME_FALLBACK);
    expect(attachmentMimeType("image/")).toBe(PDF_ATTACHMENT_MIME_FALLBACK);
    expect(attachmentMimeType("image png")).toBe(PDF_ATTACHMENT_MIME_FALLBACK);
    expect(attachmentMimeType(undefined)).toBe(PDF_ATTACHMENT_MIME_FALLBACK);
  });
});

describe("sanitizeAttachmentName", () => {
    it("keeps a bare printable name and strips paths, controls, bidi and zero-width characters", () => {
    expect(sanitizeAttachmentName("photo.png")).toBe("photo.png");
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("C:\\Users\\a\\evil.exe")).toBe("evil.exe");
    expect(sanitizeAttachmentName("invoice\u202Etxt.exe")).toBe("invoicetxt.exe");
    expect(sanitizeAttachmentName("a\u0000b\nc\u0007\u200B.txt")).toBe("abc.txt");
    expect(sanitizeAttachmentName("lone\uD800.txt")).toBe("lone.txt");
    expect(sanitizeAttachmentName("\u{1F600}.txt")).toBe("\u{1F600}.txt");
  });
  // Joiners and direction marks belong to real names; device names, streams and trailing dots do not.
  it("keeps the joiners and direction marks real names use, and still strips what reorders or hides", () => {
    expect(sanitizeAttachmentName("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.pdf")).toBe("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.pdf");
    expect(sanitizeAttachmentName("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.png")).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.png");
    expect(sanitizeAttachmentName("\u0915\u094D\u200D\u0937.txt")).toBe("\u0915\u094D\u200D\u0937.txt");
    expect(sanitizeAttachmentName("\u05E9\u05DC\u05D5\u05DD\u200F123.txt")).toBe("\u05E9\u05DC\u05D5\u05DD\u200F123.txt");
    expect(sanitizeAttachmentName("a\u200Bb\u2060c\uFEFFd\u061Ce\u2066f\u2069g.txt")).toBe("abcdefg.txt");
  });
  it("makes a Windows device name, an alternate data stream and a trailing dot or space harmless", () => {
    expect(sanitizeAttachmentName("CON")).toBe("_CON");
    expect(sanitizeAttachmentName("nul.txt")).toBe("_nul.txt");
    expect(sanitizeAttachmentName("COM1.pdf")).toBe("_COM1.pdf");
    expect(sanitizeAttachmentName("lpt9")).toBe("_lpt9");
    expect(sanitizeAttachmentName("console.txt")).toBe("console.txt");
    expect(sanitizeAttachmentName("com10.txt")).toBe("com10.txt");
    expect(sanitizeAttachmentName("file.txt:evil.exe")).toBe("file.txt_evil.exe");
    expect(sanitizeAttachmentName('a<b>c"d|e?f*g.txt')).toBe("a_b_c_d_e_f_g.txt");
    expect(sanitizeAttachmentName("file.")).toBe("file");
    expect(sanitizeAttachmentName("report.pdf . ")).toBe("report.pdf");
    expect(sanitizeAttachmentName(". .")).toBe("file");
    expect(sanitizeAttachmentName("CON. ")).toBe("_CON");
  });
  // Spaces before the dot, superscript digits, the console devices, line separators, a cut that ends in a dot.
  it("treats nul .txt, COM1 with a superscript, CONIN$ and a cut ending in a dot as the hazards they are", () => {
    expect(sanitizeAttachmentName("nul .txt")).toBe("_nul .txt");
    expect(sanitizeAttachmentName("CON  .tar.gz")).toBe("_CON  .tar.gz");
    expect(sanitizeAttachmentName("COM\u00B9")).toBe("_COM\u00B9");
    expect(sanitizeAttachmentName("lpt\u00B2.txt")).toBe("_lpt\u00B2.txt");
    expect(sanitizeAttachmentName("CONIN$")).toBe("_CONIN$");
    expect(sanitizeAttachmentName("conout$.log")).toBe("_conout$.log");
    expect(sanitizeAttachmentName("CONSOLE.txt")).toBe("CONSOLE.txt");
    expect(sanitizeAttachmentName("a\u2028b\u2029c.txt")).toBe("abc.txt");
    const cut = sanitizeAttachmentName("a".repeat(254) + "." + "b".repeat(50));
    expect(cut).toBe("a".repeat(254));
    expect(sanitizeAttachmentName("a".repeat(250) + " " + "b".repeat(50) + ".txt")).toBe("a".repeat(250) + ".txt");
  });
  it("collapses dot runs, falls back to file, and caps the length keeping the extension", () => {
    expect(sanitizeAttachmentName("a...b")).toBe("a.b");
    expect(sanitizeAttachmentName("..")).toBe("file");
    expect(sanitizeAttachmentName("   ")).toBe("file");
    expect(sanitizeAttachmentName(undefined)).toBe("file");
    const long = sanitizeAttachmentName("n".repeat(4000) + ".txt");
    expect(long).toHaveLength(255);
    expect(long.endsWith(".txt")).toBe(true);
  });
});

describe("uploadedAttachment", () => {
  it("carries the bytes of a base64 upload and the envelope of a hosted one", () => {
    expect(uploadedAttachment(photo, "doc", "Supporting document")).toEqual({
      name: "photo.png",
      mimeType: "image/png",
      description: "Supporting document",
      relationship: "Supplement",
      componentId: "doc",
      data: "iVBORw0KGgo="
    });
    expect(uploadedAttachment(hosted, "doc")).toEqual({
      name: "big.zip",
      mimeType: "application/zip",
      relationship: "Supplement",
      componentId: "doc",
      source: hosted
    });
  });

  it("strips any path from the name, names a nameless file, and takes another relationship when asked", () => {
    expect(uploadedAttachment({ ...photo, name: "C:\\Users\\ada\\photo.png" }, "doc").name).toBe("photo.png");
    expect(uploadedAttachment({ ...photo, name: "  " }, "doc").name).toBe("file");
    expect(uploadedAttachment(photo, "doc", "", "Source").relationship).toBe("Source");
    expect(uploadedAttachment(photo, "doc", "")).not.toHaveProperty("description");
  });
});

describe("PdfAttachmentCollector", () => {
  it("lists what was added once each, the same file from two places counted once", () => {
    const { collector: files, warnings } = collector(1024 * 1024);
    files.add(photo, "doc", "Supporting document");
    files.add(scan, "doc", "Supporting document");
    files.add(photo, "photos", "Photos");
    files.add({ ...photo }, "again");
    files.add(hosted, "archive");
    files.add({ ...hosted, ref: { key: "u/1" } } as FileAttachment, "archive-again");
    expect(files.list().map((entry) => [entry.name, entry.componentId])).toEqual([
      ["photo.png", "doc"],
      ["scan.pdf", "doc"],
      ["big.zip", "archive"]
    ]);
    expect(warnings).toEqual([]);
  });

  it("skips a file past the budget with a warning naming the component, and lets a smaller one after it fit", () => {
    const { collector: files, warnings } = collector(100);
    files.add({ ...photo, size: 68 }, "doc");
    files.add({ ...scan, size: 40 }, "doc");
    files.add({ ...hosted, size: 30 }, "archive");
    expect(files.list().map((entry) => entry.name)).toEqual(["photo.png", "big.zip"]);
    expect(warnings).toEqual([
      { code: "attachment.skipped", componentId: "doc", message: expect.stringContaining('"scan.pdf" (40 B) from "doc" was not attached') }
    ]);
    expect(warnings[0]!.message).toContain("100 B attachment budget");
  });

  it("refuses the document under the fail policy, with the kernel's attachment_budget code", () => {
    const { collector: files } = collector(100, "fail");
    files.add({ ...photo, size: 68 }, "doc");
    let caught: unknown;
    try {
      files.add({ ...scan, size: 40 }, "doc");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfKernelError);
    expect((caught as PdfKernelError).code).toBe("attachment_budget");
    expect((caught as PdfKernelError).message).toContain('"scan.pdf" (40 B) from "doc"');
    expect(files.list().map((entry) => entry.name)).toEqual(["photo.png"]);
  });

  it("counts a size that is no size as nothing", () => {
    const { collector: files, warnings } = collector(10);
    files.add({ ...photo, size: -5 }, "doc");
    files.add({ ...scan, size: Number.NaN }, "doc");
    expect(files.list()).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
