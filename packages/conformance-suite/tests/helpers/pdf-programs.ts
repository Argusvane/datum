import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createInProcessPdfProvider } from "@argusvane/datum-pdf-kernel";
import { createQuickJsPdfProvider, type QuickJsPdfProvider } from "@argusvane/datum-pdf-kernel/quickjs";

import type { PdfProvider } from "../../src/runners/pdf/checks.js";
import { loadPdfLib } from "../../src/runners/pdf/libs.js";
import { REPO_ROOT } from "./paths.js";

/** The built PDF program in the checkout, or undefined when it has not been built. */
export const PDF_PROGRAM_PATH = join(REPO_ROOT, "packages", "pdf-kernel", "dist", "datum-pdf.program.js");
export const pdfProgramText = (): string | undefined => (existsSync(PDF_PROGRAM_PATH) ? readFileSync(PDF_PROGRAM_PATH, "utf8") : undefined);

/** The current kernel source as a provider: the positive control when no 3.17 program is built. */
export const currentKernel = (): PdfProvider => createInProcessPdfProvider() as unknown as PdfProvider;

/**
 * A mutant: the program with the attachment budget trusting the envelope's declared size (the
 * unsafe behaviour). Patches the minified `a=Nc(e)?Math.max(s,gM(e.data)):s`; undefined when
 * that shape is not found (the program changed), so the test says so instead of passing blind.
 */
export function sizeTrustingMutant(text: string): string | undefined {
  // Current shape: `l=fa(e)?b9(e.data):0,c=Math.max(a,l)` — charge only the declared size again.
  const current = /(\w+)=(\w+)\((\w+)\)\?(\w+)\(\3\.data\):0,(\w+)=Math\.max\((\w+),\1\)/;
  if (current.test(text)) {
    // ...and the lie check `if(l>a*1.01+1024)` (file.sizeMismatch) is switched off too, else the program still refuses the file.
    const [, decodedVar, , , , , declaredVar] = current.exec(text) as RegExpExecArray;
    const lie = new RegExp(`if\\(${decodedVar}>${declaredVar}\\*1\\.01\\+1024\\)`);
    return text.replace(current, "$1=$2($3)?$4($3.data):0,$5=$6").replace(lie, "if(!1)");
  }
  // 3.17: `a=Nc(e)?Math.max(s,gM(e.data)):s`.
  const pattern = /(\w+)=(\w+)\((\w+)\)\?Math\.max\((\w+),(\w+)\(\3\.data\)\):\4/;
  return pattern.test(text) ? text.replace(pattern, "$1=$4") : undefined;
}

/**
 * A mutant: the Filespec `/F` written as a literal string again (the unsafe behaviour), so a
 * file name with an unbalanced parenthesis corrupts the object. The class that builds the
 * literal is found from the embedded-file helper (`F:X.of(this.fileName)`).
 */
export function literalFilespecMutant(text: string): string | undefined {
  const literal = /F:(\w+)\.of\(this\.fileName\)/.exec(text)?.[1];
  const pattern = /(Type:"Filespec",F:)(\w+)\.fromText\((\w+)\)(,UF:)/;
  return literal !== undefined && pattern.test(text) ? text.replace(pattern, `$1${literal}.of($3)$4`) : undefined;
}

/**
 * A mutant that keeps bidi override controls in drawn text: the engine's `stripAnswerBidi`
 * (pdf-values.ts, bundled and minified) returns its input at once. Anchored on its stable
 * first statement, the control-character test, not on the minified names.
 */
export function bidiKeepingMutant(text: string): string | undefined {
  const pattern = /function (\w+)\((\w+)\)\{if\(!\/\[\\u202A-\\u202E\\u2066-\\u2069\]\/\.test\(\2\)\)return \2;/;
  return pattern.test(text) ? text.replace(pattern, (_m, fn: string, arg: string) => `function ${fn}(${arg}){return ${arg};`) : undefined;
}

/**
 * A provider whose documents carry an /OpenAction that runs script: what the OUT-02 scan must
 * catch. The wrapped provider is the real program; only the bytes it returns are tampered with.
 */
export async function activeContentMutant(text: string): Promise<{ provider: PdfProvider; dispose(): void }> {
  const inner: QuickJsPdfProvider = await createQuickJsPdfProvider({ program: text });
  const lib = await loadPdfLib();
  const tamper = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const action = pdf.context.obj({ S: "JavaScript", JS: lib.PDFString.of("app.alert(1)") });
    pdf.catalog.set(lib.PDFName.of("OpenAction"), action);
    return new Uint8Array(await pdf.save({ useObjectStreams: false }));
  };
  const provider = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "document") {
        return async (request: never) => {
          const result = await target.document(request);
          return { ...result, bytes: await tamper(result.bytes) };
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  }) as PdfProvider;
  return { provider, dispose: () => inner.dispose() };
}
