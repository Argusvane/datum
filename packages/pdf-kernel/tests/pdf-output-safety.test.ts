/**
 * Safety of the PDFs the kernel makes from filler answers: answers stay
 * string data (no active content, no links), a file name or a bidi control cannot corrupt or
 * reorder the document, and what cannot be drawn is reported. Runs the in-process provider.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@argusvane/datum-engine/core";
import { PDF_ABI_VERSION, base64ToBytes, buildPdfFillRequest, bytesToBase64, deriveDefaultPdfLayout, type PdfDocumentRequest } from "@argusvane/datum-engine/render";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { readEmbeddedFiles } from "../src/kernel/embedded-files.js";
import { completeSignature, prepareSignature } from "../src/kernel/signature/sign.js";
import { verifySignatures } from "../src/kernel/signature/verify.js";
import { ENV, extractText, fonts, widgetsShown } from "./helpers.js";
import { hostSign, identity } from "./signing-fixtures.js";

const provider = createInProcessPdfProvider();
const ACTIVE_KEYS = ["/JS", "/JavaScript", "/Launch", "/OpenAction", "/AA", "/SubmitForm", "/GoToR", "/GoToE", "/RichMedia", "/URI", "/ImportData", "/ResetForm", "/Movie", "/Sound", "/Rendition", "/XFA"];

function formWith(children: unknown[]): ComponentNode {
  return { id: "f", type: "form", configuration: { title: "Audit" }, children: { content: children } } as never;
}
async function docRequest(form: ComponentNode, values: Record<string, unknown>, extra: Partial<PdfDocumentRequest> = {}): Promise<PdfDocumentRequest> {
  return { abi: PDF_ABI_VERSION, op: "document", form, values, locale: "en", fonts: await fonts(), env: ENV, ...extra };
}
function activeContent(raw: string): string[] {
  return ACTIVE_KEYS.filter((key) => new RegExp(`${key.replace("/", "\\/")}(?![A-Za-z])`).test(raw));
}
/** Every object serialised through pdf-lib and every stream decoded: independent of the writer. */
async function dump(bytes: Uint8Array): Promise<{ text: string; objects: number }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const parts: string[] = [];
  const entries = pdf.context.enumerateIndirectObjects();
  for (const [ref, obj] of entries) {
    parts.push(`${ref.toString()} ${obj instanceof PDFRawStream || obj instanceof PDFStream ? obj.dict.toString() : String(obj)}`);
    if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
      try {
        const decoded = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents();
        parts.push(Buffer.from(decoded).toString("latin1"));
      } catch {
        // an undecodable stream carries no readable keys
      }
    }
  }
  return { text: parts.join("\n"), objects: entries.length };
}
async function pdfjsAttachments(bytes: Uint8Array): Promise<Map<string, unknown> | Record<string, unknown> | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    return await (await task.promise).getAttachments();
  } finally {
    await task.destroy();
  }
}
const upload = (name: string, type = "text/plain", body = "hello") => ({ storage: "base64", name, type, size: body.length, data: Buffer.from(body).toString("base64") });
const fileForm = formWith([{ id: "doc", type: "file", configuration: { label: "Doc", storage: "base64", pdf: { attach: true } } }]);

function findVeraPdf(): string | undefined {
  const named = process.env.VERAPDF;
  const candidate = named && existsSync(named) ? named : join(homedir(), "verapdf", "verapdf");
  return existsSync(candidate) ? candidate : undefined;
}
function veraPdf(cli: string, file: string, flavour: string): { compliant: boolean; failed: string[] } {
  let xml: string;
  try {
    xml = execFileSync(cli, ["--flavour", flavour, "--format", "xml", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    xml = String((error as { stdout?: string }).stdout ?? "");
  }
  return { compliant: /isCompliant="true"/.test(xml), failed: [...new Set([...xml.matchAll(/<rule specification="[^"]+" clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((m) => `${m[1]}-${m[2]}`))] };
}

const HOSTILE: Record<string, string> = {
  paren: "a) Tj ET /Evil gs (b",
  backslash: "x\\) \\( \\n \\000 \\\\",
  dict: ">> /S /JavaScript /JS (app.alert(1)) >> <<",
  stream: "endstream\nendobj\n99 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (x) >> >>\nendobj",
  nul: "a\u0000b",
  surrogate: "lone\uD800hi\uDC00lo",
  bidi: "\u202Eevil\u202C and \u2067x",
  zerowidth: "a\u200Bb\u200Dc\uFEFFd\u2060e",
  tokens: "{{page}} of {{pages}} {{host.x}} {{f}}",
  eof: "%PDF-1.7 %%EOF startxref 0"
};

describe("hostile answers stay string data", () => {
  const form = formWith(Object.keys(HOSTILE).map((id) => ({ id, type: "text", configuration: { label: id } })));
  const benign = Object.fromEntries(Object.keys(HOSTILE).map((id) => [id, "benign"]));
  for (const [name, withFonts] of [["embedded DejaVu", true], ["standard-14", false]] as const) {
    it(`adds no objects and no active content (${name})`, async () => {
      const request = async (values: Record<string, unknown>) => ({ ...(await docRequest(form, values)), fonts: withFonts ? await fonts() : [] });
      const bad = await provider.document!(await request(HOSTILE));
      const good = await provider.document!(await request(benign));
      const badDump = await dump(bad.bytes);
      expect(badDump.objects).toBe((await dump(good.bytes)).objects);
      expect(activeContent(badDump.text)).toEqual([]);
      const text = (await extractText(bad.bytes)).join(" ");
      for (const key of ["paren", "backslash", "dict", "tokens", "eof"]) {
        expect(text, key).toContain(HOSTILE[key]!.split(/\s+/)[0]!);
      }
    }, 60_000);
  }

  it("URL-looking answers stay text: no link annotations, no actions", async () => {
    const urlForm = formWith([
      { id: "u", type: "url", configuration: { label: "Site" } },
      { id: "t", type: "text", configuration: { label: "T" } },
      { id: "ta", type: "textarea", configuration: { label: "TA" } },
      { id: "e", type: "email", configuration: { label: "E" } }
    ]);
    const values = { u: "https://evil.example/phish?x=1", t: "javascript:alert(1)", ta: "<a href=\"https://evil.example\">click</a> file:///etc/passwd", e: "mailto:a@b.c?cc=x" };
    for (const rendition of [undefined, "field"]) {
      const request = await docRequest(urlForm, values);
      const r = await provider.document!((rendition ? { ...request, pdf: { renditionDefaults: { "*": rendition } } } : request) as never);
      const { text } = await dump(r.bytes);
      expect(activeContent(text)).toEqual([]);
      expect(text).not.toContain("/Subtype /Link");
    }
  }, 60_000);

  it("hostile widget values, option values and labels stay data", async () => {
    const evil = "x) >> /AA << /S /JavaScript /JS (app.alert(1)) >> (";
    const evilOpt = "o/ ) /AA << /JS (1) >> #";
    const { buildPdfRenderRequest } = await import("@argusvane/datum-engine/render");
    const { document } = await import("./helpers.js");
    const blocks = [
      { id: "w1", kind: "widget" as const, label: evil, field: { name: "t", kind: "text" as const, value: evil, tooltip: evil } },
      { id: "w2", kind: "widget" as const, label: "r", field: { name: "r", kind: "radio" as const, value: evilOpt, options: [{ value: evilOpt, label: evil }, { value: "b", label: "B" }] } },
      { id: "w3", kind: "widget" as const, label: "d", field: { name: "d", kind: "dropdown" as const, value: evilOpt, options: [{ value: evilOpt, label: evil }] } },
      { id: "w4", kind: "widget" as const, label: "m", field: { name: "m", kind: "multiline" as const, value: "a\u0000b\r\n)\\\u202E" } }
    ];
    const r = await provider.render!(buildPdfRenderRequest(document(blocks as never), await fonts(), ENV));
    expect(activeContent((await dump(r.bytes)).text)).toEqual([]);
    expect((await widgetsShown(r.bytes)).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("attachment names", () => {
  it("a name with unbalanced parentheses leaves a well-formed file whose attachment reads back", async () => {
    for (const name of ["resume (final.pdf", "resume) final.pdf", "a) (( endobj", "ok.txt"]) {
      const r = await provider.document!(await docRequest(fileForm, { doc: [upload(name)] }));
      const attachments = await pdfjsAttachments(r.bytes);
      expect(attachments instanceof Map ? [...attachments.keys()] : Object.keys(attachments ?? {}), name).toEqual([name]);
      expect(activeContent((await dump(r.bytes)).text)).toEqual([]);
    }
  }, 60_000);

  it("control, bidi and zero-width characters, overlong names and dot runs are cleaned; the type claim is kept only when well formed", async () => {
    const files = [
      upload("../../etc/passwd"),
      upload("C:\\Users\\a\\evil.bin", "application/octet-stream"),
      upload("invoice\u202Etxt.bin", "application/octet-stream"),
      upload("a\u0000b\nc\u0007.txt"),
      upload("n".repeat(4000) + ".txt"),
      upload(".."),
      // A program's or a page's extension is refused whatever the claim (attachment-type-refusal.test.ts).
      upload("dup.md", "text/plain"),
      upload("dup.md", "text/plain", "plain "),
      upload("h.dat", "a/b#c%2F")
    ];
    const r = await provider.document!(await docRequest(fileForm, { doc: files }));
    const pdf = await PDFDocument.load(r.bytes, { updateMetadata: false });
    const embedded = readEmbeddedFiles(pdf, [], { data: false });
    const names = embedded.map((file) => file.name);
    expect(names).toContain("passwd");
    expect(names).toContain("evil.bin");
    expect(names).toContain("invoicetxt.bin");
    expect(names).toContain("abc.txt");
    expect(names).toContain("file");
    expect(names).toContain("dup.md");
    expect(names).toContain("dup-2.md");
    for (const name of names) {
      expect(name.length, name).toBeLessThanOrEqual(255);
      expect(name, name).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E]/);
    }
    expect(names.find((n) => n.endsWith(".txt") && n.length > 100)).toMatch(/^n+\.txt$/);
    const types = new Map(embedded.map((file) => [file.name, file.mimeType]));
    expect(types.get("h.dat")).toBe("application/octet-stream");
    expect(activeContent((await dump(r.bytes)).text)).toEqual([]);
  }, 60_000);
});

describe("text layout", () => {
  const layout = {
    id: "l", kind: "generated" as const,
    root: { id: "d", type: "pdf-document", configuration: {}, children: { header: [], footer: [], body: [
      { id: "t", type: "pdf-text", configuration: { text: "Ref {{ref}} - page {{page}} of {{pages}} - DENIED" } }
    ] } }
  };
  const refForm = formWith([{ id: "ref", type: "text", configuration: { label: "Ref" } }]);
  const render = async (ref: string) => provider.document!(await docRequest(refForm, { ref }, { pdf: { layouts: [layout as never], defaultLayoutId: "l" } }));

  it("an override typed into one answer cannot reorder the author's text; the removal is reported", async () => {
    const good = await render("A-100");
    const bad = await render("\u202EA-100");
    expect((await extractText(bad.bytes)).join(" ")).toEqual((await extractText(good.bytes)).join(" "));
    expect(bad.warnings.map((w) => w.code)).toContain("text.bidiStripped");
    expect(good.warnings.map((w) => w.code)).not.toContain("text.bidiStripped");
  }, 60_000);

  // An isolate left open in an answer would run on over the author's text after it.
  it("an isolate opened in an answer and never closed cannot reorder the text after it", async () => {
    const good = await render("A-100");
    const bad = await render("\u2067A-100");
    expect((await extractText(bad.bytes)).join(" ")).toEqual((await extractText(good.bytes)).join(" "));
    expect(bad.warnings.map((w) => w.code)).toContain("text.bidiStripped");
  }, 60_000);

  it("characters the embedded font lacks are reported", async () => {
    const r = await render("\u65E5\u672C\u8A9E");
    expect(r.warnings.map((w) => w.code)).toContain("text.glyphMissing");
    expect((await render("plain")).warnings.map((w) => w.code)).not.toContain("text.glyphMissing");
  }, 60_000);

  it("a long unbroken answer is broken at the column edge and stays on the page", async () => {
    const form = formWith([{ id: "id", type: "text", configuration: { label: "Reference" } }, { id: "n", type: "text", configuration: { label: "Next" } }]);
    const value = Array.from({ length: 12 }, (_, i) => `SEG${i}`.padEnd(10, "0")).join("") + "-TAIL-HIDDEN-PAST-EDGE";
    const r = await provider.document!(await docRequest(form, { id: value, n: "after" }));
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items as Array<{ str: string; transform: number[]; width: number }>;
    const pageWidth = page.view[2]!;
    expect(items.filter((i) => i.str.trim() !== "").every((i) => i.transform[4]! + i.width <= pageWidth)).toBe(true);
    expect((await extractText(r.bytes)).join("").replace(/\s/g, "")).toContain(value);
    await task.destroy();
  }, 60_000);
});

describe("template fill with appearances left to the viewer", () => {
  it("drops the old appearance of a filled field and asks the viewer to draw", async () => {
    const template = await PDFDocument.create({ updateMetadata: false });
    const font = await template.embedFont(StandardFonts.Helvetica);
    const page = template.addPage([400, 200]);
    const form = template.getForm();
    const pre = form.createTextField("Pre");
    pre.setText("OLDVALUE-FROM-TEMPLATE");
    pre.addToPage(page, { x: 20, y: 150, width: 300, height: 20, font });
    form.createTextField("Other").addToPage(page, { x: 20, y: 100, width: 300, height: 20, font });
    const bytes = await template.save({ useObjectStreams: false, objectsPerTick: Infinity });
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Pre: "NEW-VALUE" }, areas: [], options: { flatten: false, readOnly: false, appearances: "viewer" } };
    const res = await provider.fill!(buildPdfFillRequest(plan as never, bytes, [], ENV));
    const filled = await PDFDocument.load(res.bytes, { updateMetadata: false });
    const widgetOf = (name: string) => filled.getForm().getTextField(name).acroField.getWidgets()[0]!.dict;
    expect(widgetOf("Pre").has(PDFName.of("AP"))).toBe(false);
    expect(filled.getForm().getTextField("Pre").getText()).toBe("NEW-VALUE");
    expect(filled.getForm().acroForm.dict.get(PDFName.of("NeedAppearances"))?.toString()).toBe("true");
    // The field the answers did not touch keeps its appearance.
    expect(widgetOf("Other")).toBeInstanceOf(PDFDict);
    expect(widgetOf("Other").has(PDFName.of("AP"))).toBe(true);
  }, 60_000);
});

describe.skipIf(!findVeraPdf())("PDF/A-3b and a seal over hostile answers", () => {
  it("stays veraPDF-compliant, verifies, and the data attachment round-trips the answers", async () => {
    const cli = findVeraPdf()!;
    const dir = mkdtempSync(join(tmpdir(), "datum-f8-"));
    const values: Record<string, unknown> = { ...HOSTILE, nul: "a\u0000b\u0001\u007f\u0085", doc: [upload("resume (final.pdf")] };
    const form = formWith([...Object.keys(HOSTILE).map((id) => ({ id, type: "text", configuration: { label: id } })), { id: "doc", type: "file", configuration: { label: "Doc", storage: "base64", pdf: { attach: true } } }]);
    const layout = deriveDefaultPdfLayout(form, {});
    const result = await provider.document!(await docRequest(form, values, { layout: { ...layout, conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json" } } } as never }));
    const file = join(dir, "doc.pdf");
    writeFileSync(file, result.bytes);
    const verdict = veraPdf(cli, file, "3b");
    expect(verdict.failed).toEqual([]);
    expect(verdict.compliant).toBe(true);

    const pdf = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const answers = readEmbeddedFiles(pdf, [], { data: true }).find((f) => f.name === "answers.json")!;
    const parsed = JSON.parse(Buffer.from(base64ToBytes(answers.data!)).toString("utf8")) as { values: Record<string, string> };
    expect(parsed.values.dict).toBe(HOSTILE.dict);
    expect(parsed.values.nul).toBe("a\u0000b\u0001\u007f\u0085");
    expect(parsed.values.surrogate).toBe(HOSTILE.surrogate);

    const who = identity("rsa2048");
    const options = { certificates: who.certificates, certify: "noChanges", reason: "Archived" } as never;
    const prepared = await prepareSignature(result.bytes, options, await fonts(), ENV);
    const sealed = await completeSignature(prepared.bytes, { certificates: who.certificates, certify: "noChanges", reason: "Archived", value: hostSign(who, prepared.signing.toBeSigned) } as never);
    const report = await verifySignatures(sealed.bytes);
    expect(report.signatures[0]?.digestMatches).toBe(true);
    expect(report.signatures[0]?.coversDocument).toBe(true);
    const sealedFile = join(dir, "sealed.pdf");
    writeFileSync(sealedFile, sealed.bytes);
    expect(veraPdf(cli, sealedFile, "3b").compliant).toBe(true);
  }, 240_000);
});
