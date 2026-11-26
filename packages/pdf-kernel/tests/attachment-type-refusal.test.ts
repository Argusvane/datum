import { describe, expect, it } from "vitest";
import { PdfAttachmentCollector, bytesToBase64, refusedAttachmentType } from "@argusvane/datum-engine/render";
import { DEFAULT_PDF_ATTACHMENT_POLICY } from "@argusvane/datum-engine/core";

const enc = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

/** A minimal DOS header pointing at a PE signature. */
function peFile(lfanew = 0x80): string {
  const b = new Uint8Array(lfanew + 64);
  b[0] = 0x4d;
  b[1] = 0x5a;
  b[0x3c] = lfanew & 0xff;
  b[0x3d] = (lfanew >> 8) & 0xff;
  b[0x3e] = (lfanew >> 16) & 0xff;
  b.set([0x50, 0x45, 0, 0], lfanew);
  return bytesToBase64(b);
}

// Executable, script and HTML attachments are refused by claimed type and by magic bytes.
describe("attachment type refusal", () => {
  it("refuses executable and active content types by claim", () => {
    for (const type of ["application/x-msdownload", "application/javascript", "text/html", "application/x-sh", "application/java-archive", "text/vbscript"]) {
      expect(refusedAttachmentType(type, undefined), type).toBeDefined();
    }
    expect(refusedAttachmentType("application/pdf", enc("%PDF-1.7"))).toBeUndefined();
    expect(refusedAttachmentType("image/svg+xml", enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toBeUndefined();
  });

  it("refuses by magic bytes whatever the claim", () => {
    const bytes = (...b: number[]): string => bytesToBase64(new Uint8Array([...b, 0, 0, 0, 0]));
    expect(refusedAttachmentType("application/octet-stream", peFile())).toMatch(/Windows/);
    expect(refusedAttachmentType("text/plain", bytes(0x7f, 0x45, 0x4c, 0x46))).toMatch(/ELF/);
    expect(refusedAttachmentType("text/plain", bytes(0xcf, 0xfa, 0xed, 0xfe))).toMatch(/Mach-O/);
    expect(refusedAttachmentType("text/plain", enc("#!/bin/sh\nrm -rf /"))).toMatch(/shebang/);
    expect(refusedAttachmentType("text/plain", enc("  <!DOCTYPE html><p>x"))).toMatch(/HTML/);
    expect(refusedAttachmentType("image/png", enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toMatch(/SVG/);
    expect(refusedAttachmentType("text/plain", enc("plain words"))).toBeUndefined();
  });

  it("is skipped by the collector with attachment.refusedType, or refuses under the fail policy", () => {
    const file = { storage: "base64", name: "a.txt", type: "text/plain", size: 20, data: enc("#!/bin/sh\necho hi") } as never;
    const warnings: Array<{ code: string }> = [];
    const collector = new PdfAttachmentCollector(DEFAULT_PDF_ATTACHMENT_POLICY, (w) => warnings.push(w));
    collector.add(file, "doc");
    expect(collector.list()).toHaveLength(0);
    expect(warnings.map((w) => w.code)).toEqual(["attachment.refusedType"]);
    const strict = new PdfAttachmentCollector({ ...DEFAULT_PDF_ATTACHMENT_POLICY, onExceeded: "fail" }, () => undefined);
    expect(() => strict.add(file, "doc")).toThrow(/refusedType/);
  });

  it("is backed by the kernel for a host's own attachments", async () => {
    const { buildPdfRenderRequest } = await import("@argusvane/datum-engine/render");
    const { document, fonts, ENV } = await import("./helpers.js");
    const { createInProcessPdfProvider } = await import("../src/in-process-provider.js");
    const doc = { ...document([{ id: "p", kind: "paragraph", runs: [{ text: "x" }] }] as never), attachments: [{ name: "run.sh", mimeType: "application/x-sh", data: enc("echo"), relationship: "Supplement" }] };
    const r = await createInProcessPdfProvider().render(buildPdfRenderRequest(doc as never, await fonts(), ENV));
    expect(r.warnings.map((w) => w.code)).toContain("attachment.refusedType");
    expect(r.attachments ?? []).toEqual([]);
  });
});

// The claim is read as a media type, the sniffer wants structure.
describe("attachment type refusal: claims with parameters", () => {
  it("reads the media type before the parameters, case-insensitively", () => {
    for (const type of ["text/html; charset=utf-8", "text/html;charset=utf-8", "TEXT/HTML ; x=y", " Application/X-MSDownload; foo=bar", "application/javascript;charset=UTF-8"]) {
      expect(refusedAttachmentType(type, undefined), type).toBeDefined();
    }
    expect(refusedAttachmentType("text/plain; charset=utf-8", enc("hello"))).toBeUndefined();
    expect(refusedAttachmentType("application/pdf;version=1", undefined)).toBeUndefined();
  });
});

describe("attachment type refusal: executables need structure", () => {
  it("refuses an MZ file only with the PE header where the DOS header points", () => {
    expect(refusedAttachmentType("text/plain", peFile(0x80))).toMatch(/Windows/);
    // The signature lies past the sniffed 64 KiB: still a PE.
    expect(refusedAttachmentType("text/plain", peFile(70000))).toMatch(/Windows/);
  });

  it("allows text and CSV that merely begin with MZ", () => {
    expect(refusedAttachmentType("text/plain", enc("MZ Corporation annual report: revenue rose by a good margin this quarter, as did costs."))).toBeUndefined();
    expect(refusedAttachmentType("text/csv", enc("MZ,count\nA,1\nB,2\nC,3 and some more text to pass 64 bytes"))).toBeUndefined();
    expect(refusedAttachmentType("text/plain", bytesToBase64(new Uint8Array([0x4d, 0x5a, 0, 0])))).toBeUndefined();
    // A DOS header whose e_lfanew points past the end of the file.
    const b = new Uint8Array(200);
    b[0] = 0x4d;
    b[1] = 0x5a;
    b[0x3c] = 0xff;
    b[0x3d] = 0xff;
    expect(refusedAttachmentType("text/plain", bytesToBase64(b))).toBeUndefined();
  });

  it("refuses a shebang that names a path, not a note that starts #!", () => {
    expect(refusedAttachmentType("text/plain", enc("#!/usr/bin/env python3\nprint(1)"))).toMatch(/shebang/);
    expect(refusedAttachmentType("text/plain", enc("#! /bin/sh\n"))).toMatch(/shebang/);
    expect(refusedAttachmentType("text/plain", enc("#!important: read this first"))).toBeUndefined();
    expect(refusedAttachmentType("text/plain", enc("#!"))).toBeUndefined();
  });
});

describe("attachment type refusal: HTML and SVG", () => {
  const refused = (text: string, type = "text/plain"): string | undefined => refusedAttachmentType(type, enc(text));

  it("finds an HTML document by its opening element", () => {
    for (const html of [
      "<!-- x --><html><body>",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">',
      "<div><script>alert(1)</script></div>",
      '<a href="javascript:alert(1)">x</a>',
      "<img src=x onerror=alert(1)>",
      "<table><tr><td>x",
      "<style>body{}</style>",
      "\n\n<HTML>",
      "\ufeff<!DOCTYPE HTML><p>x",
      "<!-- a --> <!-- b -->\n<iframe src=x>"
    ]) {
      expect(refused(html), html).toMatch(/HTML/);
    }
  });

  it("reads UTF-16 text, with or without a byte order mark", () => {
    const utf16 = (text: string, bom: "le" | "be" | "none"): string => {
      const out: number[] = bom === "le" ? [0xff, 0xfe] : bom === "be" ? [0xfe, 0xff] : [];
      for (const ch of text) {
        const c = ch.charCodeAt(0);
        out.push(...(bom === "be" ? [c >> 8, c & 0xff] : [c & 0xff, c >> 8]));
      }
      return bytesToBase64(new Uint8Array(out));
    };
    expect(refusedAttachmentType("text/plain", utf16("<html><body>hi", "le"))).toMatch(/HTML/);
    expect(refusedAttachmentType("text/plain", utf16("<html><body>hi", "be"))).toMatch(/HTML/);
    expect(refusedAttachmentType("text/plain", utf16("<div>hi</div>", "none"))).toMatch(/HTML/);
    expect(refusedAttachmentType("text/plain", utf16("plain words in sixteen bits", "le"))).toBeUndefined();
  });

  it("allows prose that mentions tags", () => {
    expect(refused("Avoid <script> tags and <svg width=1> in your notes; <html> is a page.")).toBeUndefined();
    expect(refused("The <div> element and the <a href> element are common.")).toBeUndefined();
    expect(refused("<note>hello</note>", "application/xml")).toBeUndefined();
    expect(refused("<patient onset=\"2020\"><name>x</name></patient>", "application/xml")).toBeUndefined();
    expect(refused("<!-- unterminated comment <script>")).toBeUndefined();
  });

  it("scans a whole SVG for script, handlers and javascript: values", () => {
    const wrap = (inner: string): string => `<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    expect(refused(wrap("<rect/><circle/>"), "image/svg+xml")).toBeUndefined();
    expect(refused(wrap('<text>one=1 and onward = 2</text><text title="click on x = y">k</text>'), "image/svg+xml")).toBeUndefined();
    for (const inner of [
      "<script>alert(1)</script>",
      "<svg:script>alert(1)</svg:script>",
      '<rect onload="x()"/>',
      "<rect ONCLICK=x()/>",
      '<a href="javascript:alert(1)"><text>x</text></a>',
      '<a xlink:href="&#106;avascript:alert(1)"><text>x</text></a>',
      '<a href="&#x6A;&#x61;vascript&colon;alert(1)"><text>x</text></a>',
      '<a href="java&Tab;script:alert(1)"/>',
      '<set attributeName="href" to="javascript:alert(1)"/>',
      "<foreignObject><div/></foreignObject>"
    ]) {
      expect(refused(wrap(inner), "image/svg+xml"), inner).toMatch(/SVG/);
    }
    // A script far past the first 64 KiB, behind a long comment.
    expect(refused(wrap(`<!--${"x".repeat(200000)}--><script>alert(1)</script>`), "image/svg+xml")).toMatch(/SVG/);
    // An svg root through a doctype with an internal subset.
    expect(refused('<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg><script>1</script></svg>', "image/svg+xml")).toMatch(/SVG/);
    // An SVG in the SVG namespace under another root.
    expect(refused('<doc xmlns="http://www.w3.org/2000/svg"><script>1</script></doc>', "image/svg+xml")).toMatch(/SVG/);
    // Commented-out script is inert.
    expect(refused(wrap("<!-- <script>x</script> --><rect/>"), "image/svg+xml")).toBeUndefined();
  });
});
