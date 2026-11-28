import { describe, expect, it } from "vitest";

import { bytesToBase64, type FileAttachment } from "../form-engine/core/schema/file-upload.js";
import type { PdfWarning } from "../form-engine/render/pdf/pdf-document.js";
import { PdfAttachmentCollector, refusedAttachmentType, sanitizeAttachmentName } from "../form-engine/render/pdf/pdf-attachments.js";

const enc = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

function file(name: string, data: string, type = "application/octet-stream"): FileAttachment & { data: string } {
  return { storage: "base64", name, type, size: Math.ceil((data.length * 3) / 4), data };
}

describe("the same file twice", () => {
  it("is told apart from another of the same name, size, opening and length", () => {
    const head = "A".repeat(200);
    const first = file("scan.bin", enc(head + "first-ending"));
    const second = file("scan.bin", enc(head + "other-ending"));
    expect(first.data.slice(0, 64)).toBe(second.data.slice(0, 64));
    expect(first.data.length).toBe(second.data.length);
    const warnings: PdfWarning[] = [];
    const collector = new PdfAttachmentCollector({ budgetBytes: 1024 * 1024, onExceeded: "skip" }, (warning) => warnings.push(warning));
    collector.add(first, "a");
    collector.add(second, "b");
    collector.add({ ...first }, "c");
    expect(collector.list().map((entry) => entry.componentId)).toEqual(["a", "b"]);
    expect(warnings).toEqual([]);
  });
});

describe("a long file name", () => {
  it("is made safe in linear time, dots and spaces at its end and before the cut removed", () => {
    const started = performance.now();
    const name = sanitizeAttachmentName(". ".repeat(100_000) + "x");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith(".") || name.endsWith(" ")).toBe(false);
    expect(sanitizeAttachmentName("report. . .")).toBe("report");
    expect(sanitizeAttachmentName(`${"a".repeat(300)} . .txt`)).toMatch(/^a+\.txt$/);
  });
});

describe("attachment type refusal: markup the sniff reads", () => {
  it("refuses XHTML under a prefix, and markup in the XHTML namespace under another root", () => {
    expect(refusedAttachmentType("text/plain", enc('<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:body><x:script>alert(1)</x:script></x:body></x:html>'))).toMatch(/XHTML/);
    expect(refusedAttachmentType("application/xml", enc('<?xml version="1.0"?><doc><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></doc>'))).toMatch(/XHTML/);
    expect(refusedAttachmentType("application/xml", enc('<doc xmlns="&#x68;ttp://www.w3.org/1999/&#x78;html"><script>alert(1)</script></doc>'))).toMatch(/XHTML/);
  });

  it("refuses SVG or XML whose internal DTD subset declares entities", () => {
    expect(refusedAttachmentType("image/svg+xml", enc('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY e "<script>alert(1)</script>">]><svg xmlns="http://www.w3.org/2000/svg">&e;</svg>'))).toMatch(/entities/);
    expect(refusedAttachmentType("image/svg+xml", enc('<!DOCTYPE svg [<!ENTITY j "javascript">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="&j;:alert(1)"><text>x</text></a></svg>'))).toMatch(/entities/);
    expect(refusedAttachmentType("application/xml", enc('<!DOCTYPE note [<!ENTITY who "Ada">]><note>&who;</note>'))).toMatch(/entities/);
    // A plain SVG, and an XML document type with no internal subset, still attach.
    expect(refusedAttachmentType("image/svg+xml", enc('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toBeUndefined();
  });

  it("refuses SVG script under a root that is not svg", () => {
    expect(refusedAttachmentType("application/xml", enc('<doc><s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg></doc>'))).toMatch(/SVG/);
  });

  it("refuses a document opening with any HTML element, and keeps prose that mentions tags", () => {
    for (const lead of ["<section>", "<main>", "<article>", "<nav>", "<template>", "<textarea>", "<select>", "<dialog>", "<noscript>", "<blockquote>"]) {
      expect(refusedAttachmentType("text/plain", enc(`${lead}<script>alert(1)</script>`)), lead).toMatch(/HTML/);
    }
    expect(refusedAttachmentType("text/plain", enc("Use <section> for a part of a page."))).toBeUndefined();
    expect(refusedAttachmentType("application/xml", enc('<?xml version="1.0"?><invoice><line>1</line></invoice>'))).toBeUndefined();
  });
});

describe("attachment type refusal: the file name", () => {
  it("refuses a program's, a script's or a web page's extension whatever the claimed type and bytes", () => {
    for (const name of ["setup.exe", "install.MSI", "run.bat", "run.cmd", "x.com", "x.ps1", "x.vbs", "x.vbe", "x.js", "x.jse", "x.wsf", "x.wsh", "x.hta", "x.scr", "page.html", "page.htm", "page.xhtml", "art.svgz", "evil.exe. ", "C:\\tmp\\evil.EXE"]) {
      expect(refusedAttachmentType("application/pdf", enc("%PDF-1.7"), name), name).toMatch(/name ends in/);
    }
    expect(refusedAttachmentType("application/pdf", enc("%PDF-1.7"), "report.pdf")).toBeUndefined();
    expect(refusedAttachmentType("image/svg+xml", enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), "logo.svg")).toBeUndefined();
    expect(refusedAttachmentType("text/plain", enc("notes"), "exe.txt")).toBeUndefined();
  });

  it("is checked by the collector", () => {
    const warnings: PdfWarning[] = [];
    const collector = new PdfAttachmentCollector({ budgetBytes: 1024 * 1024, onExceeded: "skip" }, (warning) => warnings.push(warning));
    collector.add(file("page.html", enc("plain words"), "text/plain"), "doc");
    expect(collector.list()).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["attachment.refusedType"]);
  });
});
