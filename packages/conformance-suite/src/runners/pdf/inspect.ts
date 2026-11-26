import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadPdfLib, openPdfjs } from "./libs.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Keys whose presence in an output makes a document do something when it is opened or clicked. */
export const ACTIVE_KEYS = ["/JS", "/JavaScript", "/Launch", "/OpenAction", "/AA", "/SubmitForm", "/GoToR", "/GoToE", "/RichMedia", "/URI", "/ImportData", "/ResetForm", "/Movie", "/Sound", "/Rendition", "/XFA"] as const;

/** The active keys found in a text (a dump of objects, or the raw file), name escapes undone. */
export function activeContent(text: string, declared: readonly string[] = []): string[] {
  const unescaped = text.replace(/#([0-9A-Fa-f]{2})/g, (_: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return ACTIVE_KEYS.filter((key) => !declared.includes(key) && new RegExp(`${key.replace("/", "\\/")}(?![A-Za-z0-9])`).test(unescaped));
}

/** The raw file as latin1 text: what a byte scan sees. */
export const rawText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** The raw file without stream payloads: the object syntax a byte scan should judge (an attachment's own bytes are opaque to the document). */
export const rawStructure = (bytes: Uint8Array): string => rawText(bytes).replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");

export interface Dump {
  /** Every object serialised through pdf-lib, plus every readable stream decoded. */
  text: string;
  objects: number;
  /** Just the decoded page content streams. */
  contents: string;
}

/** Binary stream payloads (fonts, images, attachments) are not scanned: random bytes make random matches. */
const BINARY_STREAM = /Length1|Length2|FontFile|\/EmbeddedFile|\/Subtype\s*\/Image|\/CIDFontType0C|\/OpenType|\/ICCBased|\/N\s+[134]\b/;

/** Every object serialised through pdf-lib and every text stream decoded: independent of the writer under test. */
export async function dumpPdf(bytes: Uint8Array): Promise<Dump> {
  const lib = await loadPdfLib();
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const parts: string[] = [];
  const contents: string[] = [];
  const entries = pdf.context.enumerateIndirectObjects() as Array<[any, any]>;
  for (const [ref, obj] of entries) {
    const isStream = obj instanceof lib.PDFRawStream || obj instanceof lib.PDFStream;
    const head = isStream ? obj.dict.toString() : String(obj);
    parts.push(`${ref.toString()} ${head}`);
    if (isStream && !BINARY_STREAM.test(head)) {
      try {
        const decoded = obj instanceof lib.PDFRawStream ? lib.decodePDFRawStream(obj).decode() : obj.getContents();
        const text = Buffer.from(decoded).toString("latin1");
        parts.push(text);
        if (!/\/Type\s*\/(?:XObject|Metadata|EmbeddedFile)/.test(head)) {
          contents.push(text);
        }
      } catch {
        // an undecodable stream carries no readable keys
      }
    }
  }
  return { text: parts.join("\n"), objects: entries.length, contents: contents.join("\n") };
}

/** Text per page through pdf.js: the reader's view. */
export async function extractText(bytes: Uint8Array): Promise<string[]> {
  const { doc, done } = await openPdfjs(bytes);
  try {
    const pages: string[] = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item: any) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      );
    }
    return pages;
  } finally {
    await done();
  }
}

/** The embedded files pdf.js can read, by file name. An unreadable Filespec is simply absent. */
export async function pdfjsAttachments(bytes: Uint8Array): Promise<string[]> {
  const { doc, done } = await openPdfjs(bytes);
  try {
    // pdf.js 6 answers a Map; older versions an object.
    const found = (await doc.getAttachments()) as Map<string, { filename?: string }> | Record<string, { filename?: string }> | null;
    if (found === null || found === undefined) {
      return [];
    }
    const entries = found instanceof Map ? [...found.entries()] : Object.entries(found);
    return entries.map(([key, entry]) => String(entry.filename ?? key));
  } finally {
    await done();
  }
}

/** Annotation subtypes per page (pdf.js), for the no-link check. */
export async function annotationSubtypes(bytes: Uint8Array): Promise<string[]> {
  const { doc, done } = await openPdfjs(bytes);
  try {
    const out: string[] = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      for (const annotation of (await page.getAnnotations()) as Array<{ subtype: string }>) {
        out.push(annotation.subtype);
      }
    }
    return out;
  } finally {
    await done();
  }
}

/** The right edge of every drawn text item that has glyphs, against the page width. */
export async function overflowingItems(bytes: Uint8Array): Promise<{ pageWidth: number; over: string[]; text: string }> {
  const { doc, done } = await openPdfjs(bytes);
  try {
    const over: string[] = [];
    let text = "";
    let pageWidth = 0;
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      pageWidth = page.view[2] as number;
      const items = (await page.getTextContent()).items as Array<{ str: string; transform: number[]; width: number }>;
      for (const item of items) {
        text += item.str;
        if (item.str.trim() !== "" && item.transform[4]! + item.width > pageWidth) {
          over.push(item.str.slice(0, 24));
        }
      }
    }
    return { pageWidth, over, text };
  } finally {
    await done();
  }
}

/** The MIME `/Subtype` of every embedded-file stream, `#2F` escapes undone. */
export async function embeddedSubtypes(bytes: Uint8Array): Promise<string[]> {
  const lib = await loadPdfLib();
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const out: string[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects() as Array<[any, any]>) {
    const dict = obj instanceof lib.PDFRawStream || obj instanceof lib.PDFStream ? obj.dict : undefined;
    if (dict === undefined || dict.get(lib.PDFName.of("Type"))?.toString() !== "/EmbeddedFile") {
      continue;
    }
    const subtype = dict.get(lib.PDFName.of("Subtype"))?.toString();
    if (subtype !== undefined) {
      out.push(subtype.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
    }
  }
  return out;
}

/** Document information as pdf-lib reads it, and the XMP packet text when there is one. */
export async function metadataOf(bytes: Uint8Array): Promise<{ title: string | undefined; subject: string | undefined; author: string | undefined; keywords: string | undefined; xmp: string | undefined }> {
  const lib = await loadPdfLib();
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  let xmp: string | undefined;
  const ref = pdf.catalog.get(lib.PDFName.of("Metadata"));
  const stream = ref === undefined ? undefined : pdf.context.lookup(ref);
  if (stream instanceof lib.PDFRawStream || stream instanceof lib.PDFStream) {
    const decoded = stream instanceof lib.PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getContents();
    xmp = Buffer.from(decoded).toString("utf8");
  }
  return { title: pdf.getTitle(), subject: pdf.getSubject(), author: pdf.getAuthor(), keywords: pdf.getKeywords(), xmp };
}

/** Well-formedness of an XML packet: every `&` starts an entity, tags nest. Enough to catch an unescaped answer, not a full parser. */
export function xmlProblem(xml: string): string | undefined {
  const withoutDeclarations = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack: string[] = [];
  const parts = withoutDeclarations.split(/(<[^>]*>)/);
  for (const part of parts) {
    if (part.startsWith("<")) {
      const closing = /^<\/([^\s>]+)\s*>$/.exec(part);
      const opening = /^<([^\s/>]+)[^>]*?(\/?)>$/.exec(part);
      if (closing !== null) {
        if (stack.pop() !== closing[1]) {
          return `mismatched closing tag ${part}`;
        }
      } else if (opening !== null) {
        if (opening[2] !== "/") {
          stack.push(opening[1]!);
        }
      } else {
        return `malformed tag ${part.slice(0, 40)}`;
      }
      continue;
    }
    if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/.test(part)) {
      return `unescaped & in text ${part.slice(0, 40)}`;
    }
    if (part.includes("<")) {
      return `stray < in text ${part.slice(0, 40)}`;
    }
  }
  return stack.length > 0 ? `unclosed tag ${stack[stack.length - 1]}` : undefined;
}

export function findVeraPdf(): string | undefined {
  const named = process.env["VERAPDF"];
  const candidate = named !== undefined && existsSync(named) ? named : join(homedir(), "verapdf", "verapdf");
  return existsSync(candidate) ? candidate : undefined;
}

export function veraPdf(cli: string, file: string, flavour: string): { compliant: boolean; failed: string[] } {
  let xml: string;
  try {
    xml = execFileSync(cli, ["--flavour", flavour, "--format", "xml", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 170_000 });
  } catch (error) {
    xml = String((error as { stdout?: string }).stdout ?? "");
  }
  return { compliant: /isCompliant="true"/.test(xml), failed: [...new Set([...xml.matchAll(/<rule specification="[^"]+" clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((m) => `${m[1]}-${m[2]}`))] };
}
