/**
 * The AcroForm side of a signature: the `/FT /Sig` fields a document has and what
 * state each is in, the field and widget a new signature gets, the signature dictionary with
 * its placeholders, `SigFlags`, and the DocMDP reference that makes a signature certify the
 * document. Everything is done on pdf-lib's object model so an incremental save carries
 * exactly the objects touched — and never through `getForm()` (it strips XFA) or
 * `addAnnot()` (its normalisation rewrites the page's content streams).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFPage } from "@cantoo/pdf-lib";
import { PdfKernelError, type PdfSignatureCertify, type PdfSignatureSubFilter } from "@argusvane/datum-engine/render";
import { pdfDateString } from "../writer.js";
import { placeholderObjects } from "./placeholder.js";

export type SignatureFieldState = "unsigned" | "prepared" | "signed";

export interface SignatureFieldEntry {
  name: string;
  dict: PDFDict;
  ref: PDFRef;
  /** The `/V` signature dictionary, when there is one. */
  value?: PDFDict;
  state: SignatureFieldState;
  /** The field's widgets: the field itself when merged, else the kids without a `/T`. */
  widgets: Array<{ dict: PDFDict; ref: PDFRef }>;
}

function textOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return undefined;
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : undefined;
}

/**
 * A read that may meet an object of the wrong type (pdf-lib's `lookupMaybe` throws then), as
 * `undefined`: one malformed object must not stop a reader from seeing the rest of the form.
 */
function maybe<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function fieldType(dict: PDFDict): string | undefined {
  let cursor: PDFDict | undefined = dict;
  for (let depth = 0; cursor && depth < 32; depth += 1) {
    const type = nameOf(cursor, "FT");
    if (type) {
      return type;
    }
    const current: PDFDict = cursor;
    cursor = maybe(() => current.lookupMaybe(PDFName.of("Parent"), PDFDict));
  }
  return undefined;
}

function isWidget(dict: PDFDict): boolean {
  return nameOf(dict, "Subtype") === "Widget";
}

/** Whether a signature value's `/Contents` is still the zeros `sign` wrote. */
function valueState(value: PDFDict | undefined): SignatureFieldState {
  if (!value) {
    return "unsigned";
  }
  const contents = value.lookup(PDFName.of("Contents"));
  if (!value.has(PDFName.of("ByteRange")) || !(contents instanceof PDFHexString)) {
    return "unsigned";
  }
  return /^0*$/.test(contents.asString()) ? "prepared" : "signed";
}

/**
 * Every terminal signature field, walking `/Fields` and `/Kids`, names joined with dots. An
 * object of the wrong type (a `/Kids` that is not an array, a `/V` that is not a dictionary) is
 * skipped and reported through `onProblem`, never thrown: a later revision must not be able to
 * hide every signature by breaking one object.
 */
export function findSignatureFields(pdf: PDFDocument, onProblem?: (message: string) => void): SignatureFieldEntry[] {
  const context = pdf.context;
  const problem = (message: string): void => onProblem?.(message);
  const acroForm = maybe(() => pdf.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict));
  const fields = acroForm ? maybe(() => acroForm.lookupMaybe(PDFName.of("Fields"), PDFArray)) : undefined;
  if (acroForm && !fields && acroForm.has(PDFName.of("Fields"))) {
    problem("The AcroForm's /Fields is not an array; no field is read.");
  }
  const out: SignatureFieldEntry[] = [];
  const visit = (ref: PDFRef, prefix: string, depth: number): void => {
    if (depth > 32) {
      return;
    }
    const dict = maybe(() => context.lookupMaybe(ref, PDFDict));
    if (!dict) {
      return;
    }
    const partial = textOf(dict, "T");
    const name = partial !== undefined ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    const kids = maybe(() => dict.lookupMaybe(PDFName.of("Kids"), PDFArray));
    if (!kids && dict.has(PDFName.of("Kids"))) {
      problem(`The field "${name}" has a /Kids that is not an array; it is read as if it had none.`);
    }
    const kidRefs: PDFRef[] = [];
    if (kids) {
      for (let i = 0; i < kids.size(); i += 1) {
        const kid = kids.get(i);
        if (kid instanceof PDFRef) {
          kidRefs.push(kid);
        }
      }
    }
    const subfields = kidRefs.filter((kid) => {
      const kidDict = maybe(() => context.lookupMaybe(kid, PDFDict));
      return kidDict !== undefined && kidDict.has(PDFName.of("T"));
    });
    if (subfields.length > 0) {
      for (const kid of subfields) {
        visit(kid, name, depth + 1);
      }
      return;
    }
    if (fieldType(dict) !== "Sig") {
      return;
    }
    const widgets: SignatureFieldEntry["widgets"] = [];
    if (isWidget(dict)) {
      widgets.push({ dict, ref });
    }
    for (const kid of kidRefs) {
      const kidDict = maybe(() => context.lookupMaybe(kid, PDFDict));
      if (kidDict && isWidget(kidDict)) {
        widgets.push({ dict: kidDict, ref: kid });
      }
    }
    const value = maybe(() => dict.lookupMaybe(PDFName.of("V"), PDFDict));
    if (!value && dict.has(PDFName.of("V"))) {
      problem(`The signature field "${name}" has a /V that is not a dictionary; it is read as unsigned.`);
    }
    out.push({ name, dict, ref, ...(value ? { value } : {}), state: valueState(value), widgets });
  };
  if (fields) {
    for (let i = 0; i < fields.size(); i += 1) {
      const ref = fields.get(i);
      if (ref instanceof PDFRef) {
        visit(ref, "", 0);
      }
    }
  }
  return out;
}

/** `Signature1`, `Signature2`, … — the first name no field has. */
export function uniqueFieldName(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const candidate = `Signature${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** The DocMDP permissions a certification signature in the file declares, if any. */
export function certificationPermissions(pdf: PDFDocument): 1 | 2 | 3 | undefined {
  return docMdpPermissionsOf(certificationSignature(pdf));
}

/** The signature dictionary the catalog's `/Perms /DocMDP` names, if it is one. */
export function certificationSignature(pdf: PDFDocument): PDFDict | undefined {
  const perms = maybe(() => pdf.catalog.lookupMaybe(PDFName.of("Perms"), PDFDict));
  return perms ? maybe(() => perms.lookupMaybe(PDFName.of("DocMDP"), PDFDict)) : undefined;
}

/**
 * The `/P` of a signature dictionary's DocMDP transform, if it has one. A DocMDP transform
 * whose parameters cannot be read is taken as P=1, the strictest, rather than as none.
 */
export function docMdpPermissionsOf(signature: PDFDict | undefined): 1 | 2 | 3 | undefined {
  const references = signature ? maybe(() => signature.lookupMaybe(PDFName.of("Reference"), PDFArray)) : undefined;
  if (!references) {
    return undefined;
  }
  for (let i = 0; i < references.size(); i += 1) {
    const reference = maybe(() => references.lookupMaybe(i, PDFDict));
    if (!reference || nameOf(reference, "TransformMethod") !== "DocMDP") {
      continue;
    }
    try {
      const parameters = reference.lookupMaybe(PDFName.of("TransformParams"), PDFDict);
      const p = parameters?.lookupMaybe(PDFName.of("P"), PDFNumber);
      const value = p ? p.asNumber() : 2;
      return value === 1 || value === 3 ? value : 2;
    } catch {
      return 1;
    }
  }
  return undefined;
}

export interface PdfRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AcquiredField {
  name: string;
  fieldDict: PDFDict;
  fieldRef: PDFRef;
  widgetDict: PDFDict;
  widgetRef: PDFRef;
  page: PDFPage;
  /** In PDF space (y from the bottom). */
  rect: PdfRectangle;
  created: boolean;
}

function pageOfWidget(pdf: PDFDocument, widgetRef: PDFRef, widget: PDFDict): PDFPage | undefined {
  const pages = pdf.getPages();
  const p = widget.get(PDFName.of("P"));
  if (p instanceof PDFRef) {
    const byRef = pages.find((page) => page.ref === p);
    if (byRef) {
      return byRef;
    }
  }
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }
    for (let i = 0; i < annots.size(); i += 1) {
      if (annots.get(i) === widgetRef) {
        return page;
      }
    }
  }
  return undefined;
}

function rectOf(dict: PDFDict): PdfRectangle {
  const rect = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
  const numbers = rect ? rect.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : 0)) : [0, 0, 0, 0];
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = numbers;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** An existing unsigned signature field, by name, with its first widget. */
export function existingField(pdf: PDFDocument, entries: readonly SignatureFieldEntry[], name: string): AcquiredField {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new PdfKernelError("signature", `The document has no signature field named "${name}"`);
  }
  if (entry.state !== "unsigned") {
    throw new PdfKernelError("signature", `The signature field "${name}" is already ${entry.state === "signed" ? "signed" : "prepared"}`);
  }
  const widget = entry.widgets[0];
  if (!widget) {
    throw new PdfKernelError("signature", `The signature field "${name}" has no widget to draw in`);
  }
  const page = pageOfWidget(pdf, widget.ref, widget.dict);
  if (!page) {
    throw new PdfKernelError("signature", `The signature field "${name}" is on no page`);
  }
  return { name, fieldDict: entry.dict, fieldRef: entry.ref, widgetDict: widget.dict, widgetRef: widget.ref, page, rect: rectOf(widget.dict), created: false };
}

/** A new merged field-and-widget on `page`, listed in the AcroForm and the page's `/Annots`. */
export function createField(pdf: PDFDocument, name: string, page: PDFPage, rect: PdfRectangle, tooltip: string | undefined): AcquiredField {
  const context = pdf.context;
  const dict = context.obj({
    FT: "Sig",
    T: PDFHexString.fromText(name),
    Type: "Annot",
    Subtype: "Widget",
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    F: 4,
    P: page.ref,
    ...(tooltip ? { TU: PDFHexString.fromText(tooltip) } : {})
  });
  const ref = context.register(dict);
  pdf.catalog.getOrCreateAcroForm().addField(ref);
  let annots = page.node.Annots();
  if (!annots) {
    annots = context.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(ref);
  return { name, fieldDict: dict, fieldRef: ref, widgetDict: dict, widgetRef: ref, page, rect, created: true };
}

export interface SignatureValueOptions {
  subFilter: PdfSignatureSubFilter;
  capacity: number;
  createdAt: string;
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  certify: PdfSignatureCertify;
}

const PERMISSIONS: Record<Exclude<PdfSignatureCertify, false>, 1 | 2 | 3> = { noChanges: 1, formFilling: 2, annotations: 3 };

/**
 * The signature dictionary as the field's `/V`, with its placeholders; `SigFlags` on the
 * AcroForm; and, for a certification, the DocMDP reference and the catalog's `/Perms`.
 */
export function attachSignatureValue(pdf: PDFDocument, field: AcquiredField, options: SignatureValueOptions): PDFRef {
  const context = pdf.context;
  const placeholders = placeholderObjects(options.capacity);
  const value = context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: options.subFilter,
    ByteRange: placeholders.ByteRange,
    Contents: placeholders.Contents,
    M: PDFString.of(pdfDateString(options.createdAt)),
    ...(options.name ? { Name: PDFHexString.fromText(options.name) } : {}),
    ...(options.reason ? { Reason: PDFHexString.fromText(options.reason) } : {}),
    ...(options.location ? { Location: PDFHexString.fromText(options.location) } : {}),
    ...(options.contactInfo ? { ContactInfo: PDFHexString.fromText(options.contactInfo) } : {})
  });
  if (options.certify) {
    value.set(
      PDFName.of("Reference"),
      context.obj([
        // No DigestMethod / DigestValue: ISO 32000-2 deprecated them and PDF/A (19005-3 §6.1.12) forbids them under DocMDP.
        context.obj({
          Type: "SigRef",
          TransformMethod: "DocMDP",
          TransformParams: context.obj({ Type: "TransformParams", P: PERMISSIONS[options.certify], V: "1.2" })
        })
      ])
    );
  }
  const valueRef = context.register(value);
  field.fieldDict.set(PDFName.of("V"), valueRef);
  const acroForm = pdf.catalog.getOrCreateAcroForm();
  // SignaturesExist | AppendOnly: viewers save further changes as increments only.
  acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  if (options.certify) {
    pdf.catalog.set(PDFName.of("Perms"), context.obj({ DocMDP: valueRef }));
  }
  return valueRef;
}

/** ISO 32000-1 files carry the ESIC extension so PAdES readers know `ETSI.CAdES.detached` is meant. */
export function declareEsicExtension(pdf: PDFDocument): void {
  const [major] = pdf.context.header.getVersionString().split(".").map(Number);
  if (major !== undefined && major >= 2) {
    return;
  }
  const catalog = pdf.catalog;
  let extensions = catalog.lookupMaybe(PDFName.of("Extensions"), PDFDict);
  if (!extensions) {
    extensions = pdf.context.obj({});
    catalog.set(PDFName.of("Extensions"), extensions);
  }
  if (!extensions.has(PDFName.of("ESIC"))) {
    extensions.set(PDFName.of("ESIC"), pdf.context.obj({ BaseVersion: "1.7", ExtensionLevel: 2 }));
  }
}
