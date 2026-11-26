import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { PdfProgramInput } from "./pdf-runner.js";

export class PdfProgramLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfProgramLoadError";
  }
}

/** packages/pdf-kernel's built `dist/datum-pdf.program.js` when a checkout (or an installed @argusvane/datum-pdf-kernel) has one. */
export function defaultPdfProgramPath(): string | undefined {
  const candidates: string[] = [];
  try {
    const entry = createRequire(import.meta.url).resolve("@argusvane/datum-pdf-kernel/quickjs");
    candidates.push(join(dirname(dirname(entry)), "dist", "datum-pdf.program.js"));
  } catch {
    // not installed beside the suite
  }
  candidates.push(resolve(process.cwd(), "packages", "pdf-kernel", "dist", "datum-pdf.program.js"), resolve(process.cwd(), "..", "pdf-kernel", "dist", "datum-pdf.program.js"));
  return candidates.find((path) => existsSync(path));
}

/** Reads a PDF program file; `undefined` means the default location. */
export function loadPdfProgramFile(path: string | undefined): PdfProgramInput {
  const chosen = path ?? defaultPdfProgramPath();
  if (chosen === undefined) {
    throw new PdfProgramLoadError("no PDF program: give --pdf-program <datum-pdf.program.js> (the default, packages/pdf-kernel/dist/datum-pdf.program.js, is not built here)");
  }
  let text: string;
  try {
    if (!statSync(chosen).isFile()) {
      throw new Error("not a file");
    }
    text = readFileSync(chosen, "utf8");
  } catch (error) {
    throw new PdfProgramLoadError(`cannot read the PDF program ${chosen}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!/__datum_pdf/.test(text)) {
    throw new PdfProgramLoadError(`${chosen} is not a PDF program (no __datum_pdf entry point)`);
  }
  return { text, path: chosen };
}
