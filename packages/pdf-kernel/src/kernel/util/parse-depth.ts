/**
 * A bound on how deep arrays and dictionaries nest in one object of a PDF the kernel parses.
 *
 * pdf-lib's object parser reads `[ ... ]` and `<< ... >>` by recursion with no limit of its own, so
 * a few kilobytes of nested brackets in an uploaded or verified PDF would recurse until the stack
 * runs out. In QuickJS that stack is the real WebAssembly stack, which overflows below the engine's
 * own check and leaves the runtime unusable. The parser's `parseArray` and `parseDict` are wrapped
 * once, here, so the nesting past {@link MAX_PDF_OBJECT_NESTING} throws a {@link PdfNestingError}
 * instead. pdf-lib treats an indirect object that fails to parse as an invalid object and goes on;
 * a trailer or an object stream that fails fails the load, which each loader reports as an
 * unreadable PDF.
 *
 * Parsing one object is synchronous (pdf-lib yields only between objects), so one counter for the
 * module serves every parser, the kernel's own revision parser included.
 */
import { PDFDocument, PDFObjectParser } from "@cantoo/pdf-lib";

/** The deepest nesting of arrays and dictionaries in one PDF object: the limit PDFium's parser applies. */
export const MAX_PDF_OBJECT_NESTING = 64;

export class PdfNestingError extends Error {
  constructor() {
    super(`The PDF nests arrays or dictionaries more than ${MAX_PDF_OBJECT_NESTING} levels deep`);
    this.name = "PdfNestingError";
  }
}

type Parse = (this: unknown, ...args: unknown[]) => unknown;
interface ParserPrototype {
  parseArray: Parse;
  parseDict: Parse;
  __datumNestingGuard?: true;
}

let depth = 0;

/** Wraps pdf-lib's container parsers with the nesting bound. Idempotent. */
export function guardPdfObjectNesting(): void {
  const prototype = PDFObjectParser.prototype as unknown as ParserPrototype;
  if (prototype.__datumNestingGuard === true) {
    return;
  }
  for (const name of ["parseArray", "parseDict"] as const) {
    const original = prototype[name];
    prototype[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (depth >= MAX_PDF_OBJECT_NESTING) {
        throw new PdfNestingError();
      }
      depth += 1;
      try {
        return original.apply(this, args);
      } finally {
        depth -= 1;
      }
    };
  }
  Object.defineProperty(prototype, "__datumNestingGuard", { value: true });
}

/** `PDFDocument.load` with the nesting bound in place: how the kernel reads every PDF it is handed. */
export function loadPdfDocument(bytes: Uint8Array, options: Parameters<typeof PDFDocument.load>[1]): Promise<PDFDocument> {
  guardPdfObjectNesting();
  return PDFDocument.load(bytes, options);
}
