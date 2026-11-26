import { ComponentTree, buildValuePaths, readPdfValueMap, type ComponentNode, type PdfTemplateFieldInfo, type PdfTemplateInfo, type PdfTemplateLayout } from "@argusvane/datum-engine";

import type { DeliveredDocument, FormCatalogEntry } from "../types.js";
import { SUBMISSION_ATTACHMENT_NAME, base64ToBytes, parseSubmissionAttachment } from "./submission-attachment.js";

/**
 * The way back from a PDF to its record. Two readings, in order of
 * trust: the `record.json` a server PDF carries gives the exact delivered document, digest and
 * all; a template-layout PDF without one gives its AcroForm values, mapped back through the
 * layout's `fields` — the component-sourced mappings only, the rest noted. A designed layout
 * without the attachment is not extractable: its pages are drawn text, not fields.
 */
export interface ExtractedSubmission {
  method: "attachment" | "template-fields";
  /** The delivered document, for the attachment reading. */
  document?: DeliveredDocument;
  /** The digest of that document — what the record will have. */
  digest?: string;
  /** For the template reading: the answers by value path, and the form they belong to. */
  values?: Record<string, unknown>;
  formId: string;
  formVersion: string;
  locale?: string;
  /** What could not be read back, in words. */
  notes: string[];
}

/** The `record.json` inside the PDF, read back — or nothing when the PDF carries none or it will not parse. */
export function extractFromAttachment(info: PdfTemplateInfo): ExtractedSubmission | undefined {
  const file = info.attachments?.find((entry) => entry.name === SUBMISSION_ATTACHMENT_NAME);
  if (!file) {
    return undefined;
  }
  if (!file.data) {
    return { method: "attachment", formId: "", formVersion: "", notes: [`${SUBMISSION_ATTACHMENT_NAME} is present but the kernel handed back no bytes (ask inspect for attachments: "data")`] };
  }
  try {
    const { document, digest } = parseSubmissionAttachment(base64ToBytes(file.data));
    const envelope = "payload" in document ? document.payload : document;
    return {
      method: "attachment",
      document,
      digest,
      formId: envelope.versionContext.form.id,
      formVersion: envelope.versionContext.form.version,
      locale: envelope.submission.locale,
      notes: []
    };
  } catch (error) {
    return { method: "attachment", formId: "", formVersion: "", notes: [`${SUBMISSION_ATTACHMENT_NAME} could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** How many of a layout's mapped fields the PDF has: the measure that picks the layout, and the form, for a PDF with no `record.json`. */
export function templateMatchScore(info: PdfTemplateInfo, layout: PdfTemplateLayout): number {
  const names = new Set(info.fields.map((field) => field.name));
  return layout.fields.filter((mapping) => names.has(mapping.pdfField)).length;
}

export function templateLayoutsOf(entry: FormCatalogEntry): PdfTemplateLayout[] {
  return (entry.definition.pdf?.layouts ?? []).filter((layout): layout is PdfTemplateLayout => layout.kind === "template");
}

/** The best template layout of an entry for this PDF, when any of its mapped fields are there. */
export function bestTemplateLayout(info: PdfTemplateInfo, entry: FormCatalogEntry): { layout: PdfTemplateLayout; score: number } | undefined {
  let best: { layout: PdfTemplateLayout; score: number } | undefined;
  for (const layout of templateLayoutsOf(entry)) {
    const score = templateMatchScore(info, layout);
    if (score > 0 && (!best || score > best.score)) {
      best = { layout, score };
    }
  }
  return best;
}

function valueOf(field: PdfTemplateFieldInfo, checkedValue: string | undefined): unknown {
  switch (field.kind) {
    case "checkbox":
      if (checkedValue !== undefined) {
        return field.value === true ? checkedValue : undefined;
      }
      return field.value === true;
    case "listbox":
      return Array.isArray(field.value) ? field.value : field.value !== undefined ? [field.value] : undefined;
    case "signature":
    case "button":
      return undefined;
    default:
      return typeof field.value === "string" && field.value !== "" ? field.value : undefined;
  }
}

/**
 * A choice's inline options as label → value: a PDF reader reports a dropdown's or list box's
 * selection by its display text, and the form keeps the export value behind it.
 */
function labelToValue(node: ComponentNode | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const options = (node?.configuration as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(options)) {
    return map;
  }
  for (const option of options) {
    if (!option || typeof option !== "object" || typeof (option as { value?: unknown }).value !== "string") {
      continue;
    }
    const { value, label } = option as { value: string; label?: unknown };
    const text = typeof label === "string" ? label : label && typeof label === "object" && typeof (label as { default?: unknown }).default === "string" ? (label as { default: string }).default : undefined;
    if (text !== undefined) {
      map.set(text, value);
    }
  }
  return map;
}

function throughOptions(value: unknown, labels: Map<string, string>): unknown {
  if (labels.size === 0) {
    return value;
  }
  if (typeof value === "string") {
    return labels.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? (labels.get(entry) ?? entry) : entry));
  }
  return value;
}

/**
 * The answers a value map (`values`) turned into the PDF's words, turned back: the
 * map inverted, target → answer, for a string or each element of an array. A boolean component's
 * `"true"` / `"false"` keys come back as booleans. `undefined` when the map cannot be inverted —
 * two answers share a target, so the PDF's word does not say which was meant — and the caller
 * keeps the value as read.
 */
function inverseOf(values: ReadonlyMap<string, string>): Map<string, string> | undefined {
  const inverse = new Map<string, string>();
  for (const [answer, target] of values) {
    if (inverse.has(target)) {
      return undefined;
    }
    inverse.set(target, answer);
  }
  return inverse;
}

function throughMap(value: unknown, inverse: Map<string, string>, boolean: boolean): unknown {
  const back = (entry: string): unknown => {
    const answer = inverse.get(entry);
    if (answer === undefined) {
      return entry;
    }
    return boolean && (answer === "true" || answer === "false") ? answer === "true" : answer;
  };
  if (typeof value === "string") {
    return back(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? back(entry) : entry));
  }
  return value;
}

/** The PDF's field values as the form's answers, through the layout's component-sourced mappings. */
export function extractFromTemplateFields(info: PdfTemplateInfo, entry: FormCatalogEntry, layout: PdfTemplateLayout): ExtractedSubmission {
  const paths = buildValuePaths(entry.definition.root);
  const nodes = new Map(new ComponentTree(entry.definition.root).descendantsOf(entry.definition.root.id).map((node) => [node.id, node]));
  const byName = new Map(info.fields.map((field) => [field.name, field]));
  const values: Record<string, unknown> = {};
  const notes: string[] = [];
  let read = 0;
  for (const mapping of layout.fields) {
    const field = byName.get(mapping.pdfField);
    if (!field) {
      notes.push(`the PDF has no field "${mapping.pdfField}"`);
      continue;
    }
    if (mapping.source.kind !== "component") {
      notes.push(`"${mapping.pdfField}" is filled from ${mapping.source.kind === "literal" ? "a literal" : mapping.source.kind === "template" ? "a text template" : mapping.source.kind === "expression" ? "an expression" : "a value path"}, not a component; skipped`);
      continue;
    }
    const raw = valueOf(field, mapping.checkedValue);
    if (raw === undefined) {
      continue;
    }
    const node = nodes.get(mapping.source.componentId);
    let value = throughOptions(raw, labelToValue(node));
    // A value map was applied on the way out: the PDF's word is the mapped one, and the answer is the key.
    const map = readPdfValueMap(mapping.values);
    if (map) {
      const inverse = inverseOf(map);
      if (inverse) {
        value = throughMap(value, inverse, node?.type === "checkbox");
      } else {
        notes.push(`"${mapping.pdfField}" has a value map in which two answers share a PDF value, so it is ambiguous; the value is kept as the PDF holds it`);
      }
    }
    const path = paths.get(mapping.source.componentId) ?? mapping.source.componentId;
    if (mapping.format?.kind === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      values[path] = Number(value);
    } else if (mapping.format?.kind === "boolean" && typeof value === "string") {
      const [yes] = (mapping.format.pattern ?? "yes|no").split("|");
      values[path] = value === yes;
    } else {
      values[path] = value;
    }
    read += 1;
  }
  if (read === 0) {
    notes.push("none of the layout's mapped fields carried a value");
  }
  return { method: "template-fields", values, formId: entry.formId, formVersion: entry.formVersion, notes };
}
