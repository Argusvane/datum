/**
 * Uploaded files on their way into a PDF. A `file` component's value is the
 * attachment envelope — the bytes inline when its storage is `base64`, a reference
 * the host resolves otherwise. This module turns those envelopes into the document's
 * `attachments`: one entry per distinct file, the layout's budget applied from the envelope's
 * declared size or its inline bytes' length, whichever is larger, before any bytes are copied, and every decision reported as a warning a host
 * can act on — or, under the `fail` policy, as the `attachment_budget` refusal.
 */
import {
  FILE_COMPONENT_TYPE,
  formatFileSize,
  base64ToBytes,
  isBase64FileAttachment,
  readFileAttachments,
  type FileAttachment
} from "../../core/schema/file-upload.js";
import { readComponentPdfOptions, type PdfAssetSource, type PdfAttachmentPolicy } from "../../core/schema/pdf-layout.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { collectionPathOf } from "../../core/tree/data-scope.js";
import { kernelBase64DecodedLength, kernelStableStringify } from "../../validation/wasm/portable-kernel.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { PdfKernelError } from "./pdf-abi.js";
import type { PdfAttachmentRelationship, PdfDocumentAttachment, PdfWarning } from "./pdf-document.js";
import { readCollectionRows } from "./pdf-values.js";

/** What an embedded file is called when the browser gave its type as nothing usable. */
export const PDF_ATTACHMENT_MIME_FALLBACK = "application/octet-stream";

/** The relationship an uploaded file declares to the document: supporting material, not its data. */
export const PDF_UPLOAD_RELATIONSHIP: PdfAttachmentRelationship = "Supplement";

const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+$/;

/**
 * The MIME type an embedded file's `Subtype` carries: the upload's, lower-cased, or
 * `application/octet-stream` when the browser gave none or something that is not `type/subtype`
 * — PDF/A-3 requires a valid one, and an ordinary reader shows the icon for it.
 */
export function attachmentMimeType(type: unknown): string {
  if (typeof type !== "string") {
    return PDF_ATTACHMENT_MIME_FALLBACK;
  }
  const trimmed = type.trim().toLowerCase();
  return MIME_TYPE.test(trimmed) ? trimmed : PDF_ATTACHMENT_MIME_FALLBACK;
}

/** The longest file name an embedded file carries, extension included. */
const ATTACHMENT_NAME_MAX = 255;
/**
 * Control characters, the bidi controls that reorder (embeddings, overrides, isolates, the Arabic
 * letter mark) and the zero-width characters that hide (space, word joiner, byte order mark):
 * never part of a name a reader should show. U+200C and U+200D (the
 * joiners) and the two direction marks U+200E and U+200F stay: real names need them (Persian and
 * Indic scripts, emoji sequences) and they cannot reorder anything.
 */
const ATTACHMENT_NAME_STRIP = /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF\uD800-\uDFFF]/gu;
/** The characters a file system reads as more than a name: `:` opens a stream on NTFS and macOS, the rest are wildcards and redirects. */
const ATTACHMENT_NAME_RESERVED_CHARS = /[:<>"|?*]/g;
/** The device names Windows opens whatever the extension (`CON.txt`). */
const ATTACHMENT_NAME_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])$/i;

/** `text` without the dots and spaces at its end, in one pass from the end. */
function trimTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 0x2e || text.charCodeAt(end - 1) === 0x20)) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * A bare, printable file name for an embedded file: no path, no control or hiding characters and
 * no bidi controls (a right-to-left override cannot make `txt.exe` read as another type), the
 * joiners kept, `: < > " | ? *` replaced by `_`, `..` runs collapsed to one dot, no trailing dot
 * or space (also after a cut to length), a Windows device name (`CON`, `nul.txt`, `nul .txt`,
 * `COM1`, `COM¹`, `CONIN$`) prefixed with `_`, at most 255
 * characters with the extension kept, and `file` when nothing is left. Lone surrogates go too, so
 * the name is always well-formed text.
 */
export function sanitizeAttachmentName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  let bare = trimTrailingDotsAndSpaces(
    (raw.split(/[\\/]/).pop() ?? "")
      .replace(ATTACHMENT_NAME_STRIP, "")
      .replace(ATTACHMENT_NAME_RESERVED_CHARS, "_")
      .replace(/\.{2,}/g, ".")
      .trim()
  );
  if (bare.length > ATTACHMENT_NAME_MAX) {
    const dot = bare.lastIndexOf(".");
    const extension = dot > 0 && bare.length - dot <= 16 ? bare.slice(dot) : "";
    // The cut may end on half a pair, a dot or a space: none may be left at the end of the stem.
    bare = trimTrailingDotsAndSpaces(bare.slice(0, ATTACHMENT_NAME_MAX - extension.length).replace(/[\uD800-\uDBFF]$/, "")) + extension;
  }
  if (bare === "") {
    return "file";
  }
  const firstDot = bare.indexOf(".");
  // Windows drops the spaces and dots before the extension, so `nul .txt` opens the device too.
  return ATTACHMENT_NAME_DEVICE.test(trimTrailingDotsAndSpaces(firstDot < 0 ? bare : bare.slice(0, firstDot))) ? "_" + bare : bare;
}

/**
 * The document entry for one uploaded file: its bytes when the value holds them, else the
 * envelope for the host to resolve (`resolvePdfAttachments`) — the same envelope a template or
 * an ICC profile travels in, so the host's template resolver serves it.
 */
export function uploadedAttachment(
  file: FileAttachment,
  componentId: string,
  description?: string,
  relationship: PdfAttachmentRelationship = PDF_UPLOAD_RELATIONSHIP
): PdfDocumentAttachment {
  const common = {
    name: sanitizeAttachmentName(file.name),
    mimeType: attachmentMimeType(file.type),
    ...(description !== undefined && description !== "" ? { description } : {}),
    relationship,
    componentId
  };
  if (isBase64FileAttachment(file)) {
    return { ...common, data: file.data };
  }
  return { ...common, source: file as PdfAssetSource };
}

/** Types a reader opens as a program or as active content: refused whatever the bytes. */
const REFUSED_MIME = /^(?:application\/(?:x-msdownload|x-msdos-program|x-dosexec|x-executable|x-elf|x-mach-binary|x-sharedlib|x-sh|x-shellscript|x-csh|x-bat|x-msi|x-ms-installer|vnd\.microsoft\.portable-executable|java-archive|x-java-archive|javascript|x-javascript|ecmascript|x-ecmascript|x-vbs|x-vbscript|x-msdos-batch|xhtml\+xml|hta|x-hta|x-powershell)|text\/(?:html|javascript|x-javascript|ecmascript|vbscript|x-vbscript|x-shellscript|x-sh))$/;

/**
 * File extensions a reader's system opens as a program, a script or a web page: refused whatever
 * the claimed type and the bytes. An `.svg` is not among them: it is judged by the script it
 * carries; a compressed `.svgz` cannot be read for script, so it is refused.
 */
const REFUSED_EXTENSION =
  /\.(?:exe|dll|msi|msp|com|scr|pif|cpl|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|wsc|hta|lnk|reg|jar|jnlp|sh|html|htm|xhtml|xht|shtml|mht|mhtml|svgz)$/i;

/** How many leading bytes the binary-header sniff reads. */
const SNIFF_BYTES = 65536;
/** How many bytes of a markup-looking upload the HTML / SVG scan reads (it scans the whole file up to this). */
const MARKUP_SCAN_BYTES = 16 * 1024 * 1024;

/** The media type a claim names: parameters (`; charset=utf-8`) dropped, whitespace and controls removed, lower-cased. */
export function claimedMediaType(claimed: unknown): string {
  if (typeof claimed !== "string") {
    return "";
  }
  const semicolon = claimed.indexOf(";");
  return (semicolon < 0 ? claimed : claimed.slice(0, semicolon)).replace(/[\u0000- \u007f]/g, "").toLowerCase();
}

/** HTML elements a document may open with (a lead of one of these is a page, whatever the claim). */
const HTML_LEAD =
  /^<(?:!doctype\s+html|(?:html|head|body|script|noscript|template|iframe|frame|frameset|noframes|meta|link|base|basefont|style|title|div|span|p|a|img|picture|table|caption|thead|tbody|tfoot|tr|td|th|colgroup|form|input|button|select|optgroup|textarea|fieldset|legend|dialog|object|embed|applet|param|canvas|video|audio|source|details|summary|marquee|blink|center|font|big|small|tt|strike|s|em|strong|code|pre|kbd|samp|var|dfn|abbr|acronym|cite|q|sub|sup|mark|ins|del|bdi|bdo|ruby|rt|rp|wbr|nobr|xmp|plaintext|listing|isindex|keygen|bgsound|blockquote|figure|figcaption|section|main|article|aside|nav|header|footer|hgroup|h[1-6]|ul|ol|li|dl|dt|dd|br|hr|b|i|u)(?=[\s/>]))/;
const SVG_ROOT = /^<(?:[a-z][\w.-]*:)?svg(?=[\s/>])/;
const JAVASCRIPT_URL = new RegExp("^[\\u0000-\\u0020]*" + "javascript".split("").join("[\\u0000-\\u0020]*") + "[\\u0000-\\u0020]*:");

/** The characters of a byte run as text: UTF-16 when it has a byte order mark or reads as ASCII widened, else one char per byte (NUL as a space). */
function sniffText(bytes: Uint8Array): string {
  let utf16: "le" | "be" | undefined;
  let from = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    utf16 = "le";
    from = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    utf16 = "be";
    from = 2;
  } else if (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) {
    utf16 = "le";
  } else if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] !== 0 && bytes[2] === 0 && bytes[3] !== 0) {
    utf16 = "be";
  }
  const units: number[] = [];
  const parts: string[] = [];
  const flush = (): void => {
    if (units.length > 0) {
      parts.push(String.fromCharCode.apply(null, units));
      units.length = 0;
    }
  };
  if (utf16 === undefined) {
    for (let i = 0; i < bytes.length; i += 1) {
      units.push(bytes[i] === 0 ? 32 : bytes[i]!);
      if (units.length >= 4096) {
        flush();
      }
    }
  } else {
    for (let i = from; i + 1 < bytes.length; i += 2) {
      const unit = utf16 === "le" ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
      units.push(unit === 0 ? 32 : unit);
      if (units.length >= 4096) {
        flush();
      }
    }
  }
  flush();
  return parts.join("");
}

/** Numeric and the few named character references a browser decodes in an attribute value. */
function decodeReferences(value: string): string {
  if (value.indexOf("&") < 0) {
    return value;
  }
  const named: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** The first thing in an SVG document that runs script, or `undefined`: scripts, foreignObject, `on*` handlers and `javascript:` values, over the whole file. */
function svgScript(text: string, from: number): string | undefined {
  const n = text.length;
  let i = from;
  while (i < n) {
    const open = text.indexOf("<", i);
    if (open < 0) {
      return undefined;
    }
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      i = end < 0 ? n : end + 3;
      continue;
    }
    let j = open + 1;
    if (text.charAt(j) === "/" || text.charAt(j) === "?" || text.charAt(j) === "!") {
      const end = text.indexOf(">", j);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const nameStart = j;
    while (j < n && !/[\s/>]/.test(text.charAt(j))) {
      j += 1;
    }
    const element = text.slice(nameStart, j).toLowerCase();
    const local = element.slice(element.lastIndexOf(":") + 1);
    if (local === "script" || local === "foreignobject") {
      return "its bytes are an SVG that carries script";
    }
    // The attributes: name, optional `=` and a quoted or bare value, until the tag's `>`.
    for (;;) {
      while (j < n && /[\s/]/.test(text.charAt(j))) {
        j += 1;
      }
      if (j >= n || text.charAt(j) === ">") {
        break;
      }
      const attrStart = j;
      while (j < n && !/[\s=/>]/.test(text.charAt(j))) {
        j += 1;
      }
      const attribute = text.slice(attrStart, j).toLowerCase();
      while (j < n && /\s/.test(text.charAt(j))) {
        j += 1;
      }
      let value = "";
      if (text.charAt(j) === "=") {
        j += 1;
        while (j < n && /\s/.test(text.charAt(j))) {
          j += 1;
        }
        const quote = text.charAt(j);
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, j + 1);
          value = text.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const valueStart = j;
          while (j < n && !/[\s>]/.test(text.charAt(j))) {
            j += 1;
          }
          value = text.slice(valueStart, j);
        }
      } else if (j === attrStart) {
        j += 1;
      }
      if (/^on[a-z]+$/.test(attribute) || JAVASCRIPT_URL.test(decodeReferences(value))) {
        return "its bytes are an SVG that carries script";
      }
    }
    i = j + 1;
  }
  return undefined;
}

/** The XHTML namespace: an element in it is HTML whatever its prefix, and whatever the root says. */
const XHTML_NAMESPACE = "www.w3.org/1999/xhtml";
/** The SVG namespace: an element in it can run script anywhere in an XML document. */
const SVG_NAMESPACE = "w3.org/2000/svg";

/**
 * Why a markup document (decoded text) must not be embedded: HTML by its opening tag, an internal
 * DTD subset that declares entities (an entity can hold the markup or the `javascript:` the scan
 * would otherwise see), XHTML-namespaced markup under any prefix or root, or SVG carrying script.
 */
function markupRefusal(text: string): string | undefined {
  let pos = 0;
  const n = text.length;
  const space = /\s+/y;
  for (let guard = 0; guard < 100000; guard += 1) {
    space.lastIndex = pos;
    if (space.test(text)) {
      pos = space.lastIndex;
    }
    if (text.startsWith("<?", pos)) {
      const end = text.indexOf("?>", pos + 2);
      if (end < 0) {
        return undefined;
      }
      pos = end + 2;
    } else if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end < 0) {
        return undefined;
      }
      pos = end + 3;
    } else if (/^<!doctype\s+(?!html)/i.test(text.slice(pos, pos + 64))) {
      let end = text.indexOf(">", pos);
      const bracket = text.indexOf("[", pos);
      if (bracket >= 0 && (end < 0 || bracket < end)) {
        if (/<!(?:entity|attlist)[\s>]/i.test(text.slice(bracket))) {
          return "its bytes are XML whose document type declares entities or attributes";
        }
        const close = text.indexOf("]", bracket);
        end = close < 0 ? -1 : text.indexOf(">", close);
      }
      if (end < 0) {
        return undefined;
      }
      pos = end + 1;
    } else {
      break;
    }
  }
  if (pos >= n) {
    return undefined;
  }
  const lead = text.slice(pos, pos + 512).toLowerCase();
  if (HTML_LEAD.test(lead)) {
    return "its bytes are an HTML document";
  }
  if (!/^<[a-z_]/.test(lead)) {
    return undefined;
  }
  // A namespace is an attribute value, which may be written with character references.
  const lower = decodeReferences(text).toLowerCase();
  if (lower.indexOf(XHTML_NAMESPACE) >= 0) {
    return "its bytes are markup in the XHTML namespace";
  }
  if (SVG_ROOT.test(lead) || lower.indexOf(SVG_NAMESPACE) >= 0) {
    return svgScript(text.toLowerCase(), pos);
  }
  return undefined;
}

/**
 * Why an attachment must not be embedded, or `undefined` when it may be: its claimed type (the
 * media type alone, parameters dropped) is a program or active content (executables, scripts,
 * HTML), or its bytes say so whatever it claims — a PE (MZ with the `PE\0\0` header where the DOS
 * header points), an ELF, Mach-O or Java class header, a shebang naming a path, a document that
 * opens with an HTML element (after a byte order mark, XML prolog or comments; UTF-16 read), an
 * SVG carrying script anywhere in the file, XML in the XHTML namespace under any prefix, XML whose
 * internal DTD subset declares entities — or its file name ends in a program's, a script's or a web
 * page's extension ({@link REFUSED_EXTENSION}). Prose that merely mentions tags is not HTML. `data`
 * is the inline base64 when there is some; `name` the file name the reader would save it under.
 */
export function refusedAttachmentType(claimed: unknown, data?: string, name?: unknown): string | undefined {
  const type = claimedMediaType(claimed);
  if (REFUSED_MIME.test(type)) {
    return `its type ${type} is executable or active content`;
  }
  if (name !== undefined) {
    const extension = REFUSED_EXTENSION.exec(sanitizeAttachmentName(name));
    if (extension) {
      return `its name ends in ${extension[0].toLowerCase()}, which opens as a program, a script or a web page`;
    }
  }
  if (typeof data !== "string" || data === "") {
    return undefined;
  }
  let head: Uint8Array;
  try {
    head = base64ToBytes(data.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4));
  } catch {
    return undefined;
  }
  const at = (i: number): number => head[i] ?? -1;
  if (at(0) === 0x4d && at(1) === 0x5a && head.length >= 0x40) {
    // The DOS header's e_lfanew (offset 0x3C) points at "PE\0\0"; a text that merely starts "MZ" points nowhere.
    const lfanew = (at(0x3c) | (at(0x3d) << 8) | (at(0x3e) << 16) | (at(0x3f) << 24)) >>> 0;
    const total = kernelBase64DecodedLength(data);
    if (lfanew >= 0x40 && lfanew + 4 <= total) {
      if (lfanew + 4 > head.length || (at(lfanew) === 0x50 && at(lfanew + 1) === 0x45 && at(lfanew + 2) === 0 && at(lfanew + 3) === 0)) {
        return "its bytes are a Windows executable";
      }
    }
  }
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) {
    return "its bytes are an ELF executable";
  }
  const magic = ((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
    return "its bytes are a Mach-O or Java class executable";
  }
  if (at(0) === 0x23 && at(1) === 0x21) {
    let line = "";
    for (let i = 2; i < Math.min(head.length, 256) && head[i] !== 10 && head[i] !== 13; i += 1) {
      line += String.fromCharCode(head[i]!);
    }
    if (/^[ \t]*\/\S/.test(line)) {
      return "its bytes are a script (shebang)";
    }
  }
  // Markup: look at the document opening only when the first thing is a tag (UTF-16 and a byte order mark read through).
  const probe = sniffText(head.subarray(0, 64));
  if (!/^[\sï»¿﻿]*</.test(probe)) {
    return undefined;
  }
  let bytes = head;
  if (kernelBase64DecodedLength(data) > head.length) {
    try {
      bytes = base64ToBytes(data.slice(0, Math.ceil(MARKUP_SCAN_BYTES / 3) * 4));
    } catch {
      return undefined;
    }
  }
  return markupRefusal(sniffText(bytes).replace(/^[ï»¿]{3}/, ""));
}

/** The byte length a base64 string decodes to, without decoding it: whitespace and padding are not counted. */
export function base64DecodedLength(data: string): number {
  return kernelBase64DecodedLength(data);
}

/**
 * The same file picked twice — bound twice in a layout, or once per row of an unchanged repeat — is
 * embedded once. Two keys tell files apart: the whole content (the inline base64 itself, or the
 * storage reference), and the name and size. The content key is the string as it is, so files
 * that differ anywhere in their bytes never meet.
 */
function dedupeKey(file: FileAttachment): { content: string; meta: string } {
  if (isBase64FileAttachment(file)) {
    return { content: file.data, meta: `data:${file.name}:${file.size}` };
  }
  const ref = (file as { ref?: unknown }).ref;
  return { content: `ref:${file.storage}:${ref === undefined ? "" : kernelStableStringify(ref)}`, meta: `ref:${file.name}:${file.size}` };
}

/**
 * Gathers the uploaded files one document embeds. The budget is the sum of the envelopes'
 * declared sizes; a file that would take the total past it is skipped with a warning (a later,
 * smaller one may still fit) or, under `fail`, refuses the document.
 */
export class PdfAttachmentCollector {
  private readonly entries: PdfDocumentAttachment[] = [];
  /** Content key -> the name-and-size keys seen with it. */
  private readonly seen = new Map<string, Set<string>>();
  private used = 0;

  public constructor(
    private readonly policy: PdfAttachmentPolicy,
    private readonly warn: (warning: PdfWarning) => void
  ) {}

  public add(file: FileAttachment, componentId: string, description?: string, relationship?: PdfAttachmentRelationship): void {
    const key = dedupeKey(file);
    if (this.seen.get(key.content)?.has(key.meta)) {
      return;
    }
    // Executable, script and HTML content is never embedded.
    const refusedWhy = refusedAttachmentType(file.type, isBase64FileAttachment(file) ? file.data : undefined, file.name);
    if (refusedWhy !== undefined) {
      const message = `"${file.name}" from "${componentId}" is not attached: ${refusedWhy} (attachment.refusedType).`;
      if (this.policy.onExceeded === "fail") {
        throw new PdfKernelError("attachment_budget", message);
      }
      this.warn({ code: "attachment.refusedType", message, componentId });
      return;
    }
    // Charge the larger of the declared size and the inline bytes' decoded length, so a
    // lying envelope cannot slip past the budget.
    const declared = Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
    const decoded = isBase64FileAttachment(file) ? base64DecodedLength(file.data) : 0;
    const size = Math.max(declared, decoded);
    // Inline bytes well past the declared size are a lie, not rounding: refused like an over-budget file.
    if (decoded > declared * 1.01 + 1024) {
      const message = `"${file.name}" from "${componentId}" holds ${formatFileSize(decoded)} but declares ${formatFileSize(declared)} (file.sizeMismatch).`;
      if (this.policy.onExceeded === "fail") {
        throw new PdfKernelError("attachment_budget", message);
      }
      this.warn({ code: "file.sizeMismatch", message: message + " It was not attached.", componentId });
      return;
    }
    if (this.used + size > this.policy.budgetBytes) {
      const budget = formatFileSize(this.policy.budgetBytes);
      if (this.policy.onExceeded === "fail") {
        throw new PdfKernelError(
          "attachment_budget",
          `Attaching "${file.name}" (${formatFileSize(size)}) from "${componentId}" takes the document past its ${budget} attachment budget; raise attachments.budgetMb or set attachments.onExceeded to "skip".`
        );
      }
      this.warn({
        code: "attachment.skipped",
        message: `"${file.name}" (${formatFileSize(size)}) from "${componentId}" was not attached: the document's ${budget} attachment budget is used up.`,
        componentId
      });
      return;
    }
    const metas = this.seen.get(key.content) ?? new Set<string>();
    metas.add(key.meta);
    this.seen.set(key.content, metas);
    this.used += size;
    this.entries.push(uploadedAttachment(file, componentId, description, relationship));
  }

  /** The entries so far, in the order they were added. */
  public list(): PdfDocumentAttachment[] {
    return [...this.entries];
  }
}

/**
 * The uploaded files a template layout embeds: every visible, non-excluded `file` component
 * with `pdf.attach` on — a template layout has no `pdf-field` bindings, so the instance rung
 * decides alone. Inside a collection, each row's files; a nested collection follows its own
 * rows only through the outermost path the state keys them under.
 */
export function collectFormAttachments(
  root: ComponentNode,
  modelsById: ReadonlyMap<string, RenderComponentModel>,
  values: Record<string, unknown>,
  collector: PdfAttachmentCollector
): void {
  const visit = (node: ComponentNode, collectionPath: string | undefined): void => {
    if (node.type === FILE_COMPONENT_TYPE) {
      const model = modelsById.get(node.id);
      const options = readComponentPdfOptions(node.configuration);
      if (model && model.visible && options.attach === true && !options.exclude) {
        // An entry names the field by its key within the entry.
        const rowKey = model.rowKey ?? node.id;
        const files = collectionPath
          ? readCollectionRows(values, collectionPath).flatMap((row) => readFileAttachments(row[rowKey]))
          : model.file?.attachments ?? [];
        for (const file of files) {
          collector.add(file, model.id, model.label);
        }
      }
    }
    const nextPath = collectionPathOf(node) ?? collectionPath;
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children) {
        visit(child, nextPath);
      }
    }
  };
  visit(root, undefined);
}
