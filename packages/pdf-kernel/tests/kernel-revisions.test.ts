import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from "@cantoo/pdf-lib";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, type PdfSignatureSpec } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { analyzeLaterRevisions, permittedUnder, type LaterChange, type LaterChangeKind } from "../src/kernel/signature/revisions.js";
import { buildSignedData, normalizeSignatureValue, signedAttributes } from "../src/kernel/signature/cms.js";
import { digestOverRanges, locatePlaceholder, patchByteRange, writeContents, type ByteRange } from "../src/kernel/signature/placeholder.js";
import { completeSignature, prepareSignature } from "../src/kernel/signature/sign.js";
import { parseCertificate, signatureAlgorithmFor } from "../src/kernel/signature/x509.js";
import { verifySignatures } from "../src/kernel/signature/verify.js";
import { ENV, document, fonts, paragraph, reload } from "./helpers.js";
import { hostSign, identity, type FixtureName } from "./signing-fixtures.js";

async function signWith(name: FixtureName, input: Uint8Array, spec: Partial<PdfSignatureSpec> = {}): Promise<Uint8Array> {
  const who = identity(name);
  const prepared = await prepareSignature(input, { certificates: who.certificates, ...spec }, await fonts(), ENV);
  const value = hostSign(who, prepared.signing.toBeSigned);
  const { timestamp: _reserve, ...completion } = spec;
  const completed = await completeSignature(prepared.bytes, { certificates: who.certificates, ...completion, value, toBeSignedDigest: prepared.signing.toBeSignedDigest });
  return completed.bytes;
}

async function record(withField = false, compact = false): Promise<Uint8Array> {
  const blocks = [paragraph("p1", "An application, as submitted.")];
  if (withField) {
    blocks.push({ id: "w1", kind: "widget", label: "Applicant", field: { name: "applicant", kind: "text", value: "Ada" } });
  }
  return (await renderDocument(document(blocks), await fonts(), ENV, { compact })).bytes;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

interface AppendedObject {
  number: number;
  generation?: number;
  body: string;
}

interface Update {
  objects?: AppendedObject[];
  /** A new Info dictionary's object number for the trailer; otherwise the previous /Info carries over. */
  info?: number;
  free?: Array<{ number: number; generation: number }>;
  /** Entries that point at bytes already in the file. */
  pointers?: Array<{ number: number; generation: number; offset: number }>;
  /** Another catalog for the trailer's /Root, as `n g R`. */
  root?: string;
}

/** An incremental update written by hand: the objects, one cross-reference subsection each, a trailer with `/Prev`. */
function appendUpdate(pdf: Uint8Array, update: Update): Uint8Array {
  const text = latin1(pdf);
  const root = update.root ?? [...text.matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
  const info = [...text.matchAll(/\/Info (\d+ \d+ R)/g)].at(-1)?.[1];
  const size = Math.max(...[...text.matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
  const previous = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1];
  const id = [...text.matchAll(/\/ID\s*\[[^\]]*\]/g)].at(-1)?.[0];
  let body = `${text}\n`;
  const rows: Array<{ number: number; line: string }> = [];
  for (const object of update.objects ?? []) {
    const generation = object.generation ?? 0;
    rows.push({ number: object.number, line: `${String(body.length).padStart(10, "0")} ${String(generation).padStart(5, "0")} n ` });
    body += `${object.number} ${generation} obj\n${object.body}\nendobj\n`;
  }
  for (const freed of update.free ?? []) {
    rows.push({ number: freed.number, line: `0000000000 ${String(freed.generation + 1).padStart(5, "0")} f ` });
  }
  for (const pointer of update.pointers ?? []) {
    rows.push({ number: pointer.number, line: `${String(pointer.offset).padStart(10, "0")} ${String(pointer.generation).padStart(5, "0")} n ` });
  }
  const xref = body.length;
  body += "xref\n0 1\n0000000000 65535 f \n";
  for (const row of rows.sort((a, b) => a.number - b.number)) {
    body += `${row.number} 1\n${row.line}\n`;
  }
  const newSize = Math.max(size, ...rows.map((row) => row.number + 1));
  const infoEntry = update.info !== undefined ? ` /Info ${update.info} 0 R` : info ? ` /Info ${info}` : "";
  body += `trailer\n<< /Size ${newSize} /Root ${root}${infoEntry} /Prev ${previous}${id ? ` ${id}` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** The next free object number. */
function nextNumber(pdf: Uint8Array): number {
  return Math.max(...[...latin1(pdf).matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1])));
}

function refOf(pdf: PDFDocument, object: PDFObject): PDFRef {
  const found = pdf.context.enumerateIndirectObjects().find(([, candidate]) => candidate === object);
  if (!found) {
    throw new Error("not an indirect object");
  }
  return found[0];
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

/** The page's (first) content stream reference. */
function contentRef(pdf: PDFDocument): PDFRef {
  const contents = pdf.getPage(0).node.get(PDFName.of("Contents"));
  const ref = contents instanceof PDFArray ? contents.get(0) : contents;
  if (!(ref instanceof PDFRef)) {
    throw new Error("the fixture's page content is expected indirect");
  }
  return ref;
}

const BLANK = "<< /Length 3 >>\nstream\nq Q\nendstream";

/** An incremental update with a cross-reference stream: plain objects, and objects in object stream slots. */
function streamUpdate(base: Uint8Array, objects: AppendedObject[], slots: Array<{ number: number; stream: number; index: number }>, info?: string): Uint8Array {
  const text = latin1(base);
  const root = [...text.matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
  const previous = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1];
  let body = `${text}\n`;
  const rows: Array<[number, number, number, number]> = [];
  for (const object of objects) {
    rows.push([object.number, 1, body.length, 0]);
    body += `${object.number} 0 obj\n${object.body}\nendobj\n`;
  }
  for (const slot of slots) {
    rows.push([slot.number, 2, slot.stream, slot.index]);
  }
  const xrefNumber = Math.max(nextNumber(base), ...rows.map((row) => row[0] + 1));
  const xrefAt = body.length;
  rows.push([xrefNumber, 1, xrefAt, 0]);
  rows.sort((a, b) => a[0] - b[0]);
  const field = (type: number, a: number, b: number) => String.fromCharCode(type, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255);
  const data = rows.map(([, type, a, b]) => field(type, a, b)).join("");
  const index = rows.map(([number]) => `${number} 1`).join(" ");
  body += `${xrefNumber} 0 obj\n<< /Type /XRef /Size ${xrefNumber + 1} /Root ${root}${info ? ` /Info ${info}` : ""} /Prev ${previous} /W [1 4 2] /Index [${index}] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`;
  return bytesOf(body);
}

function hexOf(text: string): string {
  return Buffer.from(text, "latin1").toString("hex").toUpperCase();
}

/** PNG-predicted rows (Up after the first), `columns` wide, deflated: an object stream's bytes. */
function predicted(content: string, columns: number, dropLast = false): string {
  const padded = content.padEnd(Math.ceil(content.length / columns) * columns, " ");
  const raw = Buffer.from(padded, "latin1");
  const rows: number[] = [];
  for (let row = 0; row * columns < raw.length; row += 1) {
    rows.push(row === 0 ? 0 : 2);
    for (let i = 0; i < columns; i += 1) {
      const value = raw[row * columns + i]!;
      rows.push(row === 0 ? value : (value - raw[(row - 1) * columns + i]! + 256) & 255);
    }
  }
  const bytes = Buffer.from(dropLast ? rows.slice(0, -1) : rows);
  return deflateSync(bytes).toString("latin1");
}

function kinds(changes: readonly LaterChange[]): Set<LaterChangeKind> {
  return new Set(changes.map((change) => change.kind));
}

/** A P=2 certified record (with a text field when asked), the bytes and where its signature ends. */
async function certified(withField = false, certify: PdfSignatureSpec["certify"] = "formFilling") {
  const bytes = await signWith("rsa2048", await record(withField), { certify, name: "Forms office" });
  return { bytes, signedEnd: bytes.length, pdf: await reload(bytes) };
}

/** The page with an extra `/Text` annotation, as the objects of an update. */
function textAnnotationUpdate(signed: Uint8Array, pdf: PDFDocument): Update {
  const page = pdf.getPage(0);
  const number = nextNumber(signed);
  const annotation = `<< /Type /Annot /Subtype /Text /Rect [100 100 120 120] /Contents (A reviewer's note) /P ${page.ref.toString()} >>`;
  const clone = page.node.clone();
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? [];
  clone.set(PDFName.of("Annots"), pdf.context.obj([...existing, PDFRef.of(number)]));
  if (page.node.get(PDFName.of("Annots")) instanceof PDFRef) {
    throw new Error("the fixture's /Annots is expected inline");
  }
  return {
    objects: [
      { number, body: annotation },
      { number: page.ref.objectNumber, generation: page.ref.generationNumber, body: clone.toString() }
    ]
  };
}

describe("later revisions after a signature", () => {
  it("finds nothing when nothing follows the signature", async () => {
    const { bytes, signedEnd } = await certified();
    expect(await analyzeLaterRevisions(bytes, signedEnd, { permissions: "formFilling", fieldName: "Signature1" })).toEqual({ revisions: 0, changes: [], permitted: true, reliedOnSignatures: [] });
    expect(await analyzeLaterRevisions(bytes, signedEnd, { fieldName: "Signature1" })).toEqual({ revisions: 0, changes: [], permitted: null, reliedOnSignatures: [] });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    padded.set([0x0a, 0x20, 0x0a], bytes.length);
    expect(await analyzeLaterRevisions(padded, signedEnd, { permissions: "noChanges" })).toEqual({ revisions: 0, changes: [], permitted: true, reliedOnSignatures: [] });
    // Bytes appended that make no revision change nothing a reader sees.
    const junk = new Uint8Array(bytes.length + 8);
    junk.set(bytes);
    expect(await analyzeLaterRevisions(junk, signedEnd, { permissions: "noChanges" })).toEqual({ revisions: 0, changes: [], permitted: true, reliedOnSignatures: [] });
  });

  it("allows a second signature the kernel adds under P=2, and not under P=1", async () => {
    const { bytes, signedEnd } = await certified();
    const second = await signWith("p256", bytes, { reason: "Countersigned" });
    const verified = await verifySignatures(second);
    const first = verified.signatures[0]!;
    expect(first.byteRange[2] + first.byteRange[3]).toBe(signedEnd);
    const report = await analyzeLaterRevisions(second, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(report.revisions).toBe(1);
    expect(report.changes.length).toBeGreaterThan(0);
    for (const kind of kinds(report.changes)) {
      expect(["signature-field", "acroform", "page-annots", "field-value"]).toContain(kind);
    }
    expect(kinds(report.changes)).toContain("signature-field");
    expect(report.permitted).toBe(true);
    expect(permittedUnder(report.changes, "noChanges")).toBe(false);
    expect(permittedUnder(report.changes, "annotations")).toBe(true);
    // The verdict leans on the second signature; the host must find it valid too.
    const secondValue = (await reload(second)).getForm().getField("Signature2").acroField.dict.get(PDFName.of("V")) as PDFRef;
    expect(report.reliedOnSignatures).toEqual([{ ref: secondValue.toString(), byteRange: verified.signatures[1]!.byteRange, contentsHex: expect.stringMatching(/^30[0-9a-f]+$/) }]);
    // The approval signature itself is not certified: no verdict.
    const approval = await analyzeLaterRevisions(second, signedEnd, { fieldName: "Signature1" });
    expect(approval.permitted).toBeNull();
    expect(approval.changes).toEqual(report.changes);
    // The second signature covers the whole file: nothing follows it.
    const last = verified.signatures[1]!;
    expect(await analyzeLaterRevisions(second, last.byteRange[2] + last.byteRange[3], { fieldName: last.field })).toEqual({ revisions: 0, changes: [], permitted: null, reliedOnSignatures: [] });
  });

  it("reads updates written with object streams and a cross-reference stream", async () => {
    const input = await record(false, true);
    expect(latin1(input)).toContain("/XRef");
    const bytes = await signWith("rsa2048", input, { certify: "formFilling" });
    const second = await signWith("p256", bytes, { reason: "Countersigned" });
    const report = await analyzeLaterRevisions(second, bytes.length, { permissions: "formFilling", fieldName: "Signature1" });
    expect(report.revisions).toBe(1);
    expect(kinds(report.changes)).toContain("signature-field");
    expect(report.permitted).toBe(true);
  });

  it("allows DSS material (PAdES LTV) under P=2, and nothing under P=1", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const number = nextNumber(bytes);
    const catalogRef = pdf.context.trailerInfo.Root as PDFRef;
    const catalog = pdf.catalog.clone();
    catalog.set(PDFName.of("DSS"), pdf.context.obj({ Certs: [PDFRef.of(number)] }));
    const updated = appendUpdate(bytes, {
      objects: [
        { number, body: "<< /Length 4 >>\nstream\n0000\nendstream" },
        { number: catalogRef.objectNumber, body: catalog.toString() }
      ]
    });
    const report = await analyzeLaterRevisions(updated, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(report.changes).toEqual([
      { ref: catalogRef.toString(), kind: "dss" },
      { ref: `${number} 0 R`, kind: "dss" }
    ]);
    expect(report.permitted).toBe(true);
    expect(permittedUnder(report.changes, "noChanges")).toBe(false);
  });

  it("never allows the signature dictionary to be defined again", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const field = pdf.getForm().getField("Signature1").acroField.dict;
    const valueRef = field.get(PDFName.of("V")) as PDFRef;
    const value = pdf.context.lookup(valueRef, PDFDict);
    const contents = (value.get(PDFName.of("Contents")) as PDFHexString).asString();
    const redefined = value.clone();
    redefined.set(PDFName.of("Reason"), PDFHexString.fromText("Approved after all"));
    const updated = appendUpdate(bytes, { objects: [{ number: valueRef.objectNumber, body: redefined.toString() }] });
    for (const options of [{ fieldName: "Signature1" }, { signatureContentsHex: contents.toUpperCase() }]) {
      const report = await analyzeLaterRevisions(updated, signedEnd, { ...options, permissions: "formFilling" });
      expect(report.revisions).toBe(1);
      expect(report.changes).toEqual([{ ref: valueRef.toString(), kind: "signature-dictionary" }]);
      expect(report.permitted).toBe(false);
      expect(permittedUnder(report.changes, "annotations")).toBe(false);
      expect(permittedUnder(report.changes, "noChanges")).toBe(false);
    }
    // Without saying which signature it is, the change is still never allowed.
    const anonymous = await analyzeLaterRevisions(updated, signedEnd, { permissions: "annotations" });
    expect(anonymous.changes).toEqual([{ ref: valueRef.toString(), kind: "other", detail: "an earlier signature changed" }]);
    expect(anonymous.permitted).toBe(false);
  });

  it("reports a new Info dictionary as info, never allowed", async () => {
    const { bytes, signedEnd } = await certified();
    const number = nextNumber(bytes);
    const updated = appendUpdate(bytes, { objects: [{ number, body: "<< /Title (Edited later) >>" }], info: number });
    const report = await analyzeLaterRevisions(updated, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(kinds(report.changes)).toEqual(new Set(["info"]));
    expect(report.changes).toContainEqual({ ref: `${number} 0 R`, kind: "info" });
    expect(report.permitted).toBe(false);
    expect(permittedUnder(report.changes, "annotations")).toBe(false);
  });

  it("allows a text annotation under P=3 and not under P=2", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const updated = appendUpdate(bytes, textAnnotationUpdate(bytes, pdf));
    const report = await analyzeLaterRevisions(updated, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(kinds(report.changes)).toEqual(new Set(["annotation", "page-annots"]));
    expect(report.permitted).toBe(false);
    expect(permittedUnder(report.changes, "annotations")).toBe(true);
    expect(report.revisions).toBe(1);
  });

  it("allows a text field's new value under P=2, with or without a new appearance", async () => {
    const { bytes, signedEnd, pdf } = await certified(true);
    const field = pdf.getForm().getTextField("applicant").acroField;
    const fieldRef = refOf(pdf, field.dict);
    const filled = field.dict.clone();
    filled.set(PDFName.of("V"), PDFString.of("Grace"));
    const valueOnly = appendUpdate(bytes, { objects: [{ number: fieldRef.objectNumber, body: filled.toString() }] });
    const report = await analyzeLaterRevisions(valueOnly, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(report.changes).toEqual([{ ref: fieldRef.toString(), kind: "field-value" }]);
    expect(report.permitted).toBe(true);
    expect(permittedUnder(report.changes, "noChanges")).toBe(false);

    // A new appearance stream for the widget, with the value.
    const widget = field.getWidgets()[0]!;
    const widgetRef = refOf(pdf, widget.dict);
    const number = nextNumber(bytes);
    const stream = "<< /Type /XObject /Subtype /Form /BBox [0 0 100 20] /Resources << >> /Length 2 >>\nstream\n% \nendstream";
    const objects: AppendedObject[] = [{ number, body: stream }];
    const redrawn = (widgetRef === fieldRef ? filled : widget.dict).clone();
    redrawn.set(PDFName.of("AP"), pdf.context.obj({ N: PDFRef.of(number) }));
    objects.push({ number: widgetRef.objectNumber, body: redrawn.toString() });
    if (widgetRef !== fieldRef) {
      objects.push({ number: fieldRef.objectNumber, body: filled.toString() });
    }
    const withAppearance = await analyzeLaterRevisions(appendUpdate(bytes, { objects }), signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(kinds(withAppearance.changes)).toEqual(new Set(["field-value"]));
    expect(withAppearance.permitted).toBe(true);

    // The same appearance without a new value shows something the field does not hold.
    const shadow = widget.dict.clone();
    shadow.set(PDFName.of("AP"), pdf.context.obj({ N: PDFRef.of(number) }));
    const hidden = await analyzeLaterRevisions(
      appendUpdate(bytes, {
        objects: [
          { number, body: stream },
          { number: widgetRef.objectNumber, body: shadow.toString() }
        ]
      }),
      signedEnd,
      { permissions: "formFilling", fieldName: "Signature1" }
    );
    expect(hidden.changes).toContainEqual({ ref: widgetRef.toString(), kind: "other", detail: "an appearance changed without a new value" });
    expect(hidden.permitted).toBe(false);
  });

  it("never allows a page's content to be replaced", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const page = pdf.getPage(0);
    const number = nextNumber(bytes);
    const content = "BT /F1 24 Tf 72 700 Td (Rewritten) Tj ET";
    const clone = page.node.clone();
    clone.set(PDFName.of("Contents"), PDFRef.of(number));
    const updated = appendUpdate(bytes, {
      objects: [
        { number, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` },
        { number: page.ref.objectNumber, body: clone.toString() }
      ]
    });
    const report = await analyzeLaterRevisions(updated, signedEnd, { permissions: "annotations", fieldName: "Signature1" });
    expect(report.changes).toContainEqual({ ref: page.ref.toString(), kind: "other", detail: "page /Contents" });
    expect(report.permitted).toBe(false);
    expect(permittedUnder(report.changes, "formFilling")).toBe(false);
  });

  it("counts chained revisions", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const number = nextNumber(bytes);
    const once = appendUpdate(bytes, { objects: [{ number, body: "<< /Title (Edited later) >>" }], info: number });
    expect((await analyzeLaterRevisions(once, signedEnd, {})).revisions).toBe(1);
    const twice = appendUpdate(once, textAnnotationUpdate(once, pdf));
    const report = await analyzeLaterRevisions(twice, signedEnd, { permissions: "annotations", fieldName: "Signature1" });
    expect(report.revisions).toBe(2);
    expect(kinds(report.changes)).toEqual(new Set(["info", "annotation", "page-annots"]));
    expect(report.permitted).toBe(false);
  });

  it("reads the later cross-reference sections: a freed widget, an entry pointing back at an older page", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const widgetRef = refOf(pdf, pdf.getForm().getField("Signature1").acroField.dict);
    const freed = appendUpdate(bytes, { free: [{ number: widgetRef.objectNumber, generation: widgetRef.generationNumber }] });
    const freedReport = await analyzeLaterRevisions(freed, signedEnd, { permissions: "annotations", fieldName: "Signature1" });
    expect(freedReport.changes).toEqual([{ ref: widgetRef.toString(), kind: "other", detail: "freed while still referenced" }]);
    expect(freedReport.permitted).toBe(false);

    // Signing rewrote the page to list the widget; the rendered page without it is still in the file.
    const page = pdf.getPage(0).ref;
    const older = latin1(bytes).indexOf(`\n${page.objectNumber} ${page.generationNumber} obj`) + 1;
    const latest = latin1(bytes).lastIndexOf(`\n${page.objectNumber} ${page.generationNumber} obj`) + 1;
    expect(older).toBeLessThan(latest);
    const pointed = appendUpdate(bytes, { pointers: [{ number: page.objectNumber, generation: page.generationNumber, offset: older }] });
    const pointedReport = await analyzeLaterRevisions(pointed, signedEnd, { permissions: "formFilling", fieldName: "Signature1" });
    expect(pointedReport.changes).toContainEqual({ ref: page.toString(), kind: "other", detail: "a widget removed from a page" });
    expect(pointedReport.permitted).toBe(false);
  });

  it("refuses an end outside the file", async () => {
    const { bytes } = await certified();
    await expect(analyzeLaterRevisions(bytes, bytes.length + 1, {})).rejects.toThrow(/not inside the file/);
    await expect(analyzeLaterRevisions(bytes, 0, {})).rejects.toThrow(/not inside the file/);
  });
});

describe("updates made to deceive", () => {
  const options = { permissions: "formFilling", fieldName: "Signature1" } as const;

  /** The page with its content swapped for a blank stream: an honest update the analysis must refuse. */
  function blankedPage(bytes: Uint8Array, pdf: PDFDocument): Uint8Array {
    const page = pdf.getPage(0);
    const number = nextNumber(bytes);
    const clone = page.node.clone();
    clone.set(PDFName.of("Contents"), PDFRef.of(number));
    return appendUpdate(bytes, {
      objects: [
        { number, body: BLANK },
        { number: page.ref.objectNumber, body: clone.toString() }
      ]
    });
  }

  it("ignores a decoy cross-reference table after the last %%EOF", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const page = pdf.getPage(0).ref;
    const signedPageAt = latin1(bytes).lastIndexOf(`\n${page.objectNumber} 0 obj`) + 1;
    const decoy = `%junk\nxref\n${page.objectNumber} 1\n${String(signedPageAt).padStart(10, "0")} 00000 n \n`;
    const attacked = bytesOf(latin1(blankedPage(bytes, pdf)) + decoy);
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: page.toString(), kind: "other", detail: "page /Contents" });
    expect(report.revisions).toBe(1);
    expect(report.permitted).toBe(false);
  });

  it("takes the trailer startxref names, not a decoy trailer after it", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const number = nextNumber(bytes);
    const rootRef = pdf.context.trailerInfo.Root as PDFRef;
    const catalog = pdf.catalog.clone();
    catalog.set(PDFName.of("OpenAction"), pdf.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") }));
    const updated = appendUpdate(bytes, { objects: [{ number, body: catalog.toString() }], root: `${number} 0 R` });
    const attacked = bytesOf(`${latin1(updated)}trailer\n<< /Root ${rootRef.toString()} >>\n`);
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: "trailer", kind: "other", detail: "/Root replaced" });
    expect(report.changes).toContainEqual({ ref: `${number} 0 R`, kind: "other", detail: "catalog /OpenAction" });
    expect(report.permitted).toBe(false);
  });

  it("reads an object from the object stream its entry names, not a plain copy after it", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const text = latin1(bytes);
    const page = pdf.getPage(0);
    const root = [...text.matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
    const n = nextNumber(bytes);
    const prev = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1];
    const p = page.ref.objectNumber;
    let body = `${text}\n`;
    const blankAt = body.length;
    body += `${n} 0 obj\n${BLANK}\nendobj\n`;
    const clone = page.node.clone();
    clone.set(PDFName.of("Contents"), PDFRef.of(n));
    const head = `${p} 0 `;
    const objects = head + clone.toString();
    const streamAt = body.length;
    body += `${n + 1} 0 obj\n<< /Type /ObjStm /N 1 /First ${head.length} /Length ${objects.length} >>\nstream\n${objects}\nendstream\nendobj\n`;
    // The decoy: the page as signed, defined plainly after the object stream; no entry points here.
    body += `${p} 0 obj\n${page.node.toString()}\nendobj\n`;
    const xrefAt = body.length;
    const row = (type: number, a: number, b: number) => String.fromCharCode(type, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255);
    const data = row(2, n + 1, 0) + row(1, blankAt, 0) + row(1, streamAt, 0) + row(1, xrefAt, 0);
    body += `${n + 2} 0 obj\n<< /Type /XRef /Size ${n + 3} /Root ${root} /Prev ${prev} /W [1 4 2] /Index [${p} 1 ${n} 3] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`;
    const report = await analyzeLaterRevisions(bytesOf(body), signedEnd, options);
    expect(report.changes).toContainEqual({ ref: page.ref.toString(), kind: "other", detail: "page /Contents" });
    expect(report.permitted).toBe(false);
  });

  it("sees an update activate a copy hidden in the signed bytes that no entry listed", async () => {
    const original = await record();
    const content = contentRef(await reload(original));
    const size = nextNumber(original);
    // The attacker's file before signing: an unlisted blank copy of the page content, then an update listing something else.
    const shadowText = `${latin1(original)}\n${content.objectNumber} 0 obj\n${BLANK}\nendobj\n`;
    const shadowAt = shadowText.lastIndexOf(`\n${content.objectNumber} 0 obj`) + 1;
    const prepared = appendUpdate(bytesOf(shadowText), { objects: [{ number: size, body: "<< /Dummy true >>" }] });
    const signed = await signWith("rsa2048", prepared, { certify: "formFilling" });
    expect(await analyzeLaterRevisions(signed, signed.length, options)).toEqual({ revisions: 0, changes: [], permitted: true, reliedOnSignatures: [] });
    const attacked = appendUpdate(signed, { pointers: [{ number: content.objectNumber, generation: 0, offset: shadowAt }] });
    const report = await analyzeLaterRevisions(attacked, signed.length, options);
    expect(report.changes).toEqual([{ ref: content.toString(), kind: "other", detail: "stream" }]);
    expect(report.permitted).toBe(false);
  });

  it("keeps the signed revision's roles: page content named as /Extensions stays page content", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const content = contentRef(pdf);
    const rootRef = pdf.context.trailerInfo.Root as PDFRef;
    const catalog = pdf.catalog.clone();
    catalog.set(PDFName.of("Extensions"), content);
    const attacked = appendUpdate(bytes, {
      objects: [
        { number: rootRef.objectNumber, body: catalog.toString() },
        { number: content.objectNumber, body: BLANK }
      ]
    });
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: rootRef.toString(), kind: "other", detail: "catalog /Extensions" });
    expect(report.changes).toContainEqual({ ref: content.toString(), kind: "other", detail: "stream" });
    expect(report.permitted).toBe(false);
  });

  it("never takes a stream for a field, nor existing content for a new field's widgets", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const content = contentRef(pdf);
    const formRef = pdf.catalog.get(PDFName.of("AcroForm")) as PDFRef;
    const form = pdf.context.lookup(formRef, PDFDict);
    const fields = form.lookup(PDFName.of("Fields"), PDFArray).asArray();
    const n = nextNumber(bytes);
    const listing = (extra: PDFRef) => {
      const clone = form.clone();
      clone.set(PDFName.of("Fields"), pdf.context.obj([...fields, extra]));
      return { number: formRef.objectNumber, body: clone.toString() };
    };
    // A stream that says it is a signature field.
    const streamField = appendUpdate(bytes, {
      objects: [{ number: n, body: "<< /FT /Sig /T (Extra) /Subtype /Widget /Rect [0 0 612 792] /Length 3 >>\nstream\nq Q\nendstream" }, listing(PDFRef.of(n))]
    });
    const streamReport = await analyzeLaterRevisions(streamField, signedEnd, options);
    expect(streamReport.changes).toContainEqual({ ref: `${n} 0 R`, kind: "other", detail: "stream" });
    expect(streamReport.permitted).toBe(false);
    // A new signature field whose /Kids is the page content, redefined.
    const kidsField = appendUpdate(bytes, {
      objects: [{ number: n, body: `<< /FT /Sig /T (Extra) /Kids ${content.toString()} >>` }, listing(PDFRef.of(n)), { number: content.objectNumber, body: BLANK }]
    });
    const kidsReport = await analyzeLaterRevisions(kidsField, signedEnd, options);
    expect(kidsReport.changes).toContainEqual({ ref: `${n} 0 R`, kind: "other", detail: "a new signature field's /Kids" });
    expect(kidsReport.changes).toContainEqual({ ref: content.toString(), kind: "other", detail: "stream" });
    expect(kidsReport.permitted).toBe(false);
  });

  it("refuses a new signature widget no signature seals, and one that carries an action", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const page = pdf.getPage(0);
    const formRef = pdf.catalog.get(PDFName.of("AcroForm")) as PDFRef;
    const form = pdf.context.lookup(formRef, PDFDict);
    const n = nextNumber(bytes);
    const overlay = (widget: string) => {
      const pageClone = page.node.clone();
      pageClone.set(PDFName.of("Annots"), pdf.context.obj([...(page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []), PDFRef.of(n + 1)]));
      const formClone = form.clone();
      formClone.set(PDFName.of("Fields"), pdf.context.obj([...form.lookup(PDFName.of("Fields"), PDFArray).asArray(), PDFRef.of(n + 1)]));
      return appendUpdate(bytes, {
        objects: [
          // A page-sized white box over the signed content.
          { number: n, body: "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length 24 >>\nstream\n1 g 0 0 612 792 re f 0 g\nendstream" },
          { number: n + 1, body: widget },
          { number: page.ref.objectNumber, body: pageClone.toString() },
          { number: formRef.objectNumber, body: formClone.toString() }
        ]
      });
    };
    const unsigned = await analyzeLaterRevisions(overlay(`<< /Type /Annot /Subtype /Widget /FT /Sig /T (Overlay) /Rect [0 0 612 792] /F 4 /P ${page.ref.toString()} /AP << /N ${n} 0 R >> >>`), signedEnd, options);
    expect(unsigned.changes).toContainEqual({ ref: `${n + 1} 0 R`, kind: "other", detail: "a signature field without a new signature sealing its update" });
    expect(unsigned.permitted).toBe(false);
    const scripted = await analyzeLaterRevisions(
      overlay(`<< /Type /Annot /Subtype /Widget /FT /Sig /T (Overlay) /Rect [0 0 10 10] /F 4 /P ${page.ref.toString()} /AA << /PO << /S /JavaScript /JS (app.alert(1)) >> >> >>`),
      signedEnd,
      options
    );
    expect(scripted.changes).toContainEqual({ ref: `${n + 1} 0 R`, kind: "other", detail: "an action on a field or widget" });
    expect(scripted.permitted).toBe(false);
  });

  it("refuses a widget hidden in the same update as its new value", async () => {
    const { bytes, signedEnd, pdf } = await certified(true);
    const field = pdf.getForm().getTextField("applicant").acroField;
    const fieldRef = refOf(pdf, field.dict);
    const widget = field.getWidgets()[0]!;
    const widgetRef = refOf(pdf, widget.dict);
    expect(widgetRef).not.toBe(fieldRef);
    const filled = field.dict.clone();
    filled.set(PDFName.of("V"), PDFString.of("Grace"));
    const hidden = widget.dict.clone();
    hidden.set(PDFName.of("F"), PDFNumber.of(2));
    const attacked = appendUpdate(bytes, {
      objects: [
        { number: fieldRef.objectNumber, body: filled.toString() },
        { number: widgetRef.objectNumber, body: hidden.toString() }
      ]
    });
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toEqual([
      { ref: fieldRef.toString(), kind: "field-value" },
      { ref: widgetRef.toString(), kind: "other", detail: "field /F" }
    ]);
    expect(report.permitted).toBe(false);
  });

  it("refuses a value for a field a signature's FieldMDP /Lock covers", async () => {
    const rendered = await renderDocument(
      document([
        paragraph("p1", "An application, as submitted."),
        { id: "w1", kind: "widget", label: "Applicant", field: { name: "applicant", kind: "text", value: "Ada" } },
        { id: "w2", kind: "widget", label: "Signed by", field: { name: "server-signature", kind: "signature" } }
      ]),
      await fonts(),
      ENV
    );
    const unsigned = await reload(rendered.bytes);
    const signatureField = unsigned.getForm().getField("server-signature").acroField.dict;
    const locked = signatureField.clone();
    locked.set(PDFName.of("Lock"), unsigned.context.obj({ Type: "SigFieldLock", Action: "Include", Fields: [PDFString.of("applicant")] }));
    const withLock = appendUpdate(rendered.bytes, { objects: [{ number: refOf(unsigned, signatureField).objectNumber, body: locked.toString() }] });
    const bytes = await signWith("rsa2048", withLock, { field: "server-signature", certify: "formFilling" });
    const pdf = await reload(bytes);
    const field = pdf.getForm().getTextField("applicant").acroField;
    const filled = field.dict.clone();
    filled.set(PDFName.of("V"), PDFString.of("Grace"));
    const attacked = appendUpdate(bytes, { objects: [{ number: refOf(pdf, field.dict).objectNumber, body: filled.toString() }] });
    const report = await analyzeLaterRevisions(attacked, bytes.length, { permissions: "formFilling", fieldName: "server-signature" });
    expect(report.changes).toEqual([{ ref: refOf(pdf, field.dict).toString(), kind: "other", detail: "a locked field's value" }]);
    expect(report.permitted).toBe(false);
  });

  it("takes /Info from the newest trailer, not a decoy trailer after it", async () => {
    const { bytes, signedEnd } = await certified();
    const oldInfo = [...latin1(bytes).matchAll(/\/Info (\d+ \d+ R)/g)].at(-1)?.[1];
    expect(oldInfo).toBeDefined();
    const number = nextNumber(bytes);
    const updated = appendUpdate(bytes, { objects: [{ number, body: "<< /Title (Edited later) >>" }], info: number });
    const root = [...latin1(bytes).matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
    const attacked = bytesOf(`${latin1(updated)}trailer\n<< /Root ${root} /Info ${oldInfo} >>\n`);
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: "trailer", kind: "info", detail: "/Info" });
    expect(report.permitted).toBe(false);
  });

  it("calls a broken chain undecidable instead of answering", async () => {
    const { bytes, signedEnd } = await certified();
    const looped = bytesOf(`${latin1(bytes)}\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev ${bytes.length + 1} >>\nstartxref\n${bytes.length + 1}\n%%EOF\n`);
    await expect(analyzeLaterRevisions(looped, signedEnd, options)).rejects.toThrow(/loops/);
    const outside = bytesOf(`${latin1(bytes)}\nstartxref\n${bytes.length * 2}\n%%EOF\n`);
    await expect(analyzeLaterRevisions(outside, signedEnd, options)).rejects.toThrow(/outside the file/);
    const wrong = String(latin1(bytes).indexOf("endobj")).padStart(10, "0");
    const missing = bytesOf(`${latin1(bytes)}\nxref\n0 1\n0000000000 65535 f \n1 1\n${wrong} 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R /Prev ${[...latin1(bytes).matchAll(/startxref\s+(\d+)/g)].at(-1)![1]} >>\nstartxref\n${bytes.length + 1}\n%%EOF\n`);
    await expect(analyzeLaterRevisions(missing, signedEnd, options)).rejects.toThrow(/holds no object|cannot be read/);
  });
});

describe("signatures the classification relies on, and streams read as a reader reads them", () => {
  const options = { permissions: "formFilling", fieldName: "Signature1" } as const;
  const SIG = `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents <${"01".repeat(16)}> >>`;

  /** Writes the real /ByteRange over the last placeholder: from 0, around the hex, to the end. */
  function seal(bytes: Uint8Array): Uint8Array {
    const text = latin1(bytes);
    const placeholder = "/ByteRange [0 0000000000 0000000000 0000000000]";
    const at = text.lastIndexOf(placeholder);
    const open = text.indexOf("<", at);
    const close = text.indexOf(">", open);
    const pad = (value: number) => String(value).padStart(10, "0");
    return bytesOf(`${text.slice(0, at)}/ByteRange [0 ${pad(open)} ${pad(close + 1)} ${pad(text.length - close - 1)}]${text.slice(at + placeholder.length)}`);
  }

  /** A page-sized white overlay: a /FT /Sig widget naming signature dictionary `value`, on the page and in the form. */
  function overlayObjects(pdf: PDFDocument, n: number, value: number): AppendedObject[] {
    const page = pdf.getPage(0);
    const formRef = pdf.catalog.get(PDFName.of("AcroForm")) as PDFRef;
    const form = pdf.context.lookup(formRef, PDFDict);
    const pageClone = page.node.clone();
    pageClone.set(PDFName.of("Annots"), pdf.context.obj([...(page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []), PDFRef.of(n + 1)]));
    const formClone = form.clone();
    formClone.set(PDFName.of("Fields"), pdf.context.obj([...form.lookup(PDFName.of("Fields"), PDFArray).asArray(), PDFRef.of(n + 1)]));
    return [
      { number: n, body: "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length 24 >>\nstream\n1 g 0 0 612 792 re f 0 g\nendstream" },
      { number: n + 1, body: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Overlay) /Rect [0 0 612 792] /F 4 /P ${page.ref.toString()} /V ${value} 0 R /AP << /N ${n} 0 R >> >>` },
      { number: page.ref.objectNumber, body: pageClone.toString() },
      { number: formRef.objectNumber, body: formClone.toString() }
    ];
  }

  it("a signature dictionary whose /Contents is no CMS over the range seals nothing", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const n = nextNumber(bytes);
    const attacked = seal(appendUpdate(bytes, { objects: [...overlayObjects(pdf, n, n + 2), { number: n + 2, body: SIG }] }));
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: `${n + 2} 0 R`, kind: "other", detail: "a signature dictionary that seals nothing" });
    expect(report.changes).toContainEqual({ ref: `${n + 1} 0 R`, kind: "other", detail: "a signature field without a new signature sealing its update" });
    expect(report.permitted).toBe(false);
    expect(report.reliedOnSignatures).toEqual([]);
  });

  it("a signature sealing an earlier update cannot vouch for a field a later one adds", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const n = nextNumber(bytes);
    const first = seal(appendUpdate(bytes, { objects: [{ number: n + 2, body: SIG }] }));
    const attacked = appendUpdate(first, { objects: overlayObjects(pdf, n, n + 2) });
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.revisions).toBe(2);
    expect(report.changes).toContainEqual({ ref: `${n + 2} 0 R`, kind: "other", detail: "a signature dictionary that seals nothing" });
    expect(report.permitted).toBe(false);
    // A genuine signature over the first update is still no signature over the second.
    const genuine = await signWith("p256", bytes, { reason: "Countersigned" });
    const genuinePdf = await reload(genuine);
    const value = genuinePdf.getForm().getField("Signature2").acroField.dict.get(PDFName.of("V")) as PDFRef;
    const m = nextNumber(genuine);
    const later = appendUpdate(genuine, { objects: overlayObjects(genuinePdf, m, value.objectNumber) });
    const laterReport = await analyzeLaterRevisions(later, signedEnd, options);
    expect(laterReport.changes).toContainEqual({ ref: `${m + 1} 0 R`, kind: "other", detail: "a signature field without a new signature sealing its update" });
    expect(laterReport.permitted).toBe(false);
  });

  it("marks every slot of an object stream whose indirect /Length moved", async () => {
    const base = await record();
    const n = nextNumber(base);
    const [length, stream, slot, info] = [n, n + 1, n + 2, n + 3];
    const head = `${slot} 0 `;
    const short = hexOf(`${head}/A`);
    // The same stream bytes read two ways: up to the first endstream, or past it to the second.
    const tail = "\nendstream\n42>";
    const signed = streamUpdate(
      base,
      [
        { number: length, body: String(short.length) },
        { number: stream, body: `<< /Type /ObjStm /N 1 /First ${head.length} /Filter /ASCIIHexDecode /Length ${length} 0 R >>\nstream\n${short}${tail}\nendstream` },
        { number: info, body: `<< /Title ${slot} 0 R >>` }
      ],
      [{ number: slot, stream, index: 0 }],
      `${info} 0 R`
    );
    expect(await analyzeLaterRevisions(signed, signed.length, options)).toEqual({ revisions: 0, changes: [], permitted: true, reliedOnSignatures: [] });
    const attacked = appendUpdate(signed, { objects: [{ number: length, body: String(short.length + tail.length) }] });
    const report = await analyzeLaterRevisions(attacked, signed.length, options);
    expect(report.changes).toEqual([{ ref: `${slot} 0 R`, kind: "info" }]);
    expect(report.permitted).toBe(false);
  });

  it("resolves an indirect /DecodeParms and refuses a partial predictor row", async () => {
    const base = await record();
    const n = nextNumber(base);
    const [parms, stream, info, predictor] = [n, n + 1, n + 2, n + 3];
    const head = `${info} 0 `;
    const update = (dropLast: boolean, indirectPredictor = false) => {
      const data = predicted(`${head}<< /Title (Predicted) >>`, 4, dropLast);
      return streamUpdate(
        base,
        [
          { number: parms, body: indirectPredictor ? `<< /Predictor ${predictor} 0 R /Columns 4 >>` : "<< /Predictor 12 /Columns 4 >>" },
          ...(indirectPredictor ? [{ number: predictor, body: "12" }] : []),
          { number: stream, body: `<< /Type /ObjStm /N 1 /First ${head.length} /Filter /FlateDecode /DecodeParms ${parms} 0 R /Length ${data.length} >>\nstream\n${data}\nendstream` }
        ],
        [{ number: info, stream, index: 0 }],
        `${info} 0 R`
      );
    };
    const report = await analyzeLaterRevisions(update(false), base.length, options);
    expect(report.changes).toEqual([
      { ref: "trailer", kind: "info", detail: "/Info" },
      { ref: `${info} 0 R`, kind: "info" }
    ]);
    await expect(analyzeLaterRevisions(update(true), base.length, options)).rejects.toThrow(/whole number of rows/);
    // An indirect /Predictor is applied as a reader applies it.
    const indirect = await analyzeLaterRevisions(update(false, true), base.length, options);
    expect(indirect.changes).toContainEqual({ ref: `${info} 0 R`, kind: "info" });
  });
});

describe("a later signature vouches only for what it covers", () => {
  const options = { permissions: "formFilling", fieldName: "Signature1" } as const;
  const WHITE = "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length 24 >>\nstream\n1 g 0 0 612 792 re f 0 g\nendstream";

  /** Signs a hand-written update the way `complete` does: range, digest, attributes, the fixture key, the CMS into the hex. */
  function handSign(prepared: Uint8Array, from: number): Uint8Array {
    const bytes = new Uint8Array(prepared);
    const located = locatePlaceholder(bytes, from);
    const byteRange: ByteRange = [0, located.contentsStart, located.contentsEnd, bytes.length - located.contentsEnd];
    patchByteRange(bytes, located.byteRangeAt, byteRange);
    const who = identity("p256");
    const chain = who.certificates.map((certificate) => parseCertificate(base64ToBytes(certificate)));
    const leaf = chain[0]!;
    const algorithm = signatureAlgorithmFor(leaf);
    const attributes = signedAttributes({ digest: digestOverRanges(bytes, byteRange), leaf, subFilter: "ETSI.CAdES.detached", signingTime: ENV.createdAt });
    const value = normalizeSignatureValue(base64ToBytes(hostSign(who, bytesToBase64(attributes.toBeSigned))), algorithm);
    writeContents(bytes, located, buildSignedData({ certificates: chain.map((certificate) => certificate.der), leaf, signedAttrsImplicit: attributes.implicitSet, algorithm, signature: value }));
    return bytes;
  }

  it("a widget a later unsigned update hangs on a signed field through /Parent is not that signature's", async () => {
    const { bytes, signedEnd } = await certified();
    const second = await signWith("p256", bytes, { reason: "Countersigned" });
    const pdf = await reload(second);
    const field = pdf.getForm().getField("Signature2").acroField.dict;
    const fieldRef = refOf(pdf, field);
    const value = field.get(PDFName.of("V")) as PDFRef;
    const page = pdf.getPage(0);
    const n = nextNumber(second);
    const pageClone = page.node.clone();
    pageClone.set(PDFName.of("Annots"), pdf.context.obj([...(page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []), PDFRef.of(n + 1)]));
    const widget = `<< /Type /Annot /Subtype /Widget /Rect [0 0 612 792] /F 4 /P ${page.ref.toString()} /Parent ${fieldRef.toString()} /AP << /N ${n} 0 R >> >>`;
    const attacked = appendUpdate(second, {
      objects: [
        { number: n, body: WHITE },
        { number: n + 1, body: widget },
        { number: page.ref.objectNumber, body: pageClone.toString() }
      ]
    });
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: `${n + 1} 0 R`, kind: "other", detail: "a widget attached only through /Parent" });
    expect(report.changes).toContainEqual({ ref: `${n} 0 R`, kind: "other", detail: "a widget attached only through /Parent" });
    expect(report.permitted).toBe(false);
    // Signature2 still vouches for its own revision, so it stays listed; the verdict no longer leans on it for the overlay.
    expect(report.reliedOnSignatures.map((signature) => signature.ref)).toEqual([value.toString()]);

    // Listing the widget in the field's /Kids takes rewriting the field after its signature: then nothing seals it.
    const withKids = field.clone();
    withKids.set(PDFName.of("Kids"), pdf.context.obj([PDFRef.of(n + 1)]));
    const relisted = appendUpdate(second, {
      objects: [
        { number: n, body: WHITE },
        { number: n + 1, body: widget },
        { number: page.ref.objectNumber, body: pageClone.toString() },
        { number: fieldRef.objectNumber, body: withKids.toString() }
      ]
    });
    const relistedReport = await analyzeLaterRevisions(relisted, signedEnd, options);
    expect(relistedReport.permitted).toBe(false);
    expect(relistedReport.reliedOnSignatures).toEqual([]);
  });

  it("an object a sealed appearance names but a later unsigned update defines is outside the seal", async () => {
    const { bytes, signedEnd, pdf } = await certified();
    const page = pdf.getPage(0);
    const formRef = pdf.catalog.get(PDFName.of("AcroForm")) as PDFRef;
    const form = pdf.context.lookup(formRef, PDFDict);
    const n = nextNumber(bytes);
    const pageClone = page.node.clone();
    pageClone.set(PDFName.of("Annots"), pdf.context.obj([...(page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []), PDFRef.of(n + 1)]));
    const formClone = form.clone();
    formClone.set(PDFName.of("Fields"), pdf.context.obj([...form.lookup(PDFName.of("Fields"), PDFArray).asArray(), PDFRef.of(n + 1)]));
    const prepared = appendUpdate(bytes, {
      objects: [
        { number: n, body: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents <${"0".repeat(16384)}> /M (D:20260905101112Z) >>` },
        { number: n + 1, body: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Hand) /Rect [36 100 216 148] /F 4 /P ${page.ref.toString()} /V ${n} 0 R /AP << /N ${n + 2} 0 R >> >>` },
        // The appearance draws /X1, an object number nothing defines yet.
        { number: n + 2, body: `<< /Type /XObject /Subtype /Form /BBox [0 0 180 48] /Resources << /XObject << /X1 ${n + 3} 0 R >> >> /Length 6 >>\nstream\n/X1 Do\nendstream` },
        { number: page.ref.objectNumber, body: pageClone.toString() },
        { number: formRef.objectNumber, body: formClone.toString() }
      ]
    });
    const sealed = handSign(prepared, bytes.length);
    const honest = await analyzeLaterRevisions(sealed, signedEnd, options);
    expect(honest.permitted).toBe(true);
    expect(honest.reliedOnSignatures.map((signature) => signature.ref)).toEqual([`${n} 0 R`]);
    const attacked = appendUpdate(sealed, { objects: [{ number: n + 3, body: WHITE }] });
    const report = await analyzeLaterRevisions(attacked, signedEnd, options);
    expect(report.changes).toContainEqual({ ref: `${n + 3} 0 R`, kind: "other", detail: "outside the signature that would vouch for it" });
    expect(report.permitted).toBe(false);
  });
});

describe("permittedUnder", () => {
  const change = (kind: LaterChangeKind): LaterChange => ({ ref: "1 0 R", kind });

  it("follows the DocMDP table", () => {
    expect(permittedUnder([], undefined)).toBeNull();
    expect(permittedUnder([], "noChanges")).toBe(true);
    expect(permittedUnder([change("dss")], "noChanges")).toBe(false);
    for (const kind of ["field-value", "signature-field", "acroform", "page-annots", "dss"] as const) {
      expect(permittedUnder([change(kind)], "formFilling")).toBe(true);
      expect(permittedUnder([change(kind)], "annotations")).toBe(true);
    }
    expect(permittedUnder([change("annotation")], "formFilling")).toBe(false);
    expect(permittedUnder([change("annotation")], "annotations")).toBe(true);
    for (const kind of ["signature-dictionary", "info", "other"] as const) {
      expect(permittedUnder([change(kind)], "formFilling")).toBe(false);
      expect(permittedUnder([change(kind)], "annotations")).toBe(false);
    }
  });
});
