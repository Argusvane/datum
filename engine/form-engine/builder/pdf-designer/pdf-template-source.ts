/**
 * Which PDF a template layout stands on, and where its bytes come from, in words: what the mode
 * needs on the page before the designer's chunk is in (a layout switch compares sources), so it
 * lives apart from the panels (`pdf-designer-panels.ts`) that load with the chunk.
 */
import type { PdfTemplateSource } from "../../core/schema/pdf-layout.js";
import { builderText, type BuilderTextOptions } from "../logic/builder-texts.js";
import { embeddedBytesProblem, type DefinitionBudget } from "../definition-budget.js";

export type { DefinitionBudget };

/** Whether two sources name the same host-provided PDF: same storage and reference. An upload never matches. */
export function sameTemplateSource(a: PdfTemplateSource, b: PdfTemplateSource): boolean {
  return a.storage !== "base64" && a.storage === b.storage && JSON.stringify(a.ref ?? null) === JSON.stringify(b.ref ?? null);
}

/** Whether two sources are one PDF: the same object, the same host reference, or an upload of the same bytes. */
export function sameTemplate(a: PdfTemplateSource, b: PdfTemplateSource): boolean {
  return a === b || sameTemplateSource(a, b) || (a.storage === "base64" && b.storage === "base64" && a.size === b.size && a.name === b.name && a.data === b.data);
}

/**
 * Why a template stored inside the definition cannot be added: the form would weigh more than a
 * load accepts, so it would save and never open again. Only an upload (`storage: "base64"`) is
 * embedded; a template the host keeps in its store leaves its bytes out of the definition and
 * is never refused here. `undefined` when it fits, or when nothing says what the form would weigh.
 */
export function embeddedTemplateProblem(source: PdfTemplateSource, name: string, budget: DefinitionBudget | undefined, text?: BuilderTextOptions): string | undefined {
  return source.storage === "base64" ? embeddedBytesProblem("pdf.add.error.heavy", name, source.size, budget, text) : undefined;
}

/** Where a template's bytes come from, in words. */
export function templateProvenance(source: PdfTemplateSource, text?: BuilderTextOptions): string {
  return builderText(source.storage === "base64" ? "pdf.provenance.uploaded" : "pdf.provenance.host", undefined, text);
}

