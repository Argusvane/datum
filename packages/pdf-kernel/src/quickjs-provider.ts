/**
 * The PDF provider over QuickJS-WASM: the bundled program evaluated once in a
 * sandboxed runtime under the document profile, every request crossing as ABI-canonical
 * JSON. What a browser or Node host uses to prove, in its own process, exactly what a JVM
 * or .NET host will get from the same program — the parity suite holds the two providers to
 * identical bytes.
 */
import { kernelStableStringify } from "@argusvane/datum-engine";
import {
  PDF_ABI_VERSION,
  PdfKernelError,
  base64ToBytes,
  unwrapPdfResponse,
  type PdfCapabilities,
  type PdfCompleteRequest,
  type PdfCompleteResult,
  type PdfDocumentRequest,
  type PdfFillRequest,
  type PdfFillResult,
  type PdfInspectRequest,
  type PdfKernelRequest,
  type PdfKernelResponse,
  type PdfLayoutRequest,
  type PdfLayoutResult,
  type PdfRenderProvider,
  type PdfRenderRequest,
  type PdfRenderResult,
  type PdfSignRequest,
  type PdfSignResult,
  type PdfTemplateInfo,
  type PdfTimestampRequest,
  type PdfVerifyRequest,
  type PdfVerifyResult
} from "@argusvane/datum-engine/render";
import {
  DOCUMENT_PROFILE,
  QuickJsExecutionError,
  createQuickJsProgramHost,
  type QuickJsProgramHost,
  type QuickJsProgramLimits
} from "@argusvane/datum-quickjs-wasm-host";

export const QUICKJS_PDF_PROVIDER_ID = "datum-pdf-kernel-quickjs";

export interface QuickJsPdfProviderOptions {
  /** The program's text. Default: `dist/datum-pdf.program.js` beside this package. */
  program?: string;
  /** Where to read the program from when `program` is not given (a path in Node, a URL elsewhere). */
  programUrl?: string;
  limits?: Partial<QuickJsProgramLimits>;
  /** Plugin modules (ES2020 expressions evaluating to `{ pdfRenditions: [...] }`), registered at startup. */
  modules?: string[];
}

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === "string";
}

/** The bundled program's text, read from disk in Node or fetched elsewhere. */
export async function loadPdfProgram(location?: string): Promise<string> {
  if (isNode() && (!location || !/^https?:/.test(location))) {
    const fs = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // The href, not the URL object: under a DOM test environment `URL` is the DOM's class, which Node's path conversion refuses.
    const path = location ? (location.startsWith("file:") ? fileURLToPath(location) : location) : fileURLToPath(new URL("../dist/datum-pdf.program.js", import.meta.url).href);
    return fs.readFile(path, "utf8");
  }
  const url = location ?? new URL("../dist/datum-pdf.program.js", import.meta.url).href;
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!fetchImpl) {
    throw new Error("Cannot load the PDF program: no file system and no fetch");
  }
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Cannot load the PDF program from ${url}: ${response.status}`);
  }
  return response.text();
}

function toKernelError(error: unknown): never {
  if (error instanceof QuickJsExecutionError) {
    const code = error.code === "interrupted" ? "internal" : "internal";
    throw new PdfKernelError(code, `QuickJS ${error.code}: ${error.message}`);
  }
  throw error;
}

export class QuickJsPdfProvider implements PdfRenderProvider {
  public readonly id = QUICKJS_PDF_PROVIDER_ID;
  public readonly abiVersion = PDF_ABI_VERSION;

  private constructor(private readonly host: QuickJsProgramHost) {}

  public static async create(options: QuickJsPdfProviderOptions = {}): Promise<QuickJsPdfProvider> {
    const program = options.program ?? (await loadPdfProgram(options.programUrl));
    const host = await createQuickJsProgramHost({ limits: { ...DOCUMENT_PROFILE, ...(options.limits ?? {}) } });
    try {
      host.evaluate(program, "datum-pdf.program.js");
      for (const [index, module] of (options.modules ?? []).entries()) {
        host.evaluate(`globalThis.__datum_pdf_register((${module}));`, `pdf-module-${index + 1}`);
      }
      return new QuickJsPdfProvider(host);
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  private exchange(request: PdfKernelRequest): PdfKernelResponse {
    try {
      return JSON.parse(this.host.call("__datum_pdf", kernelStableStringify(request))) as PdfKernelResponse;
    } catch (error) {
      return toKernelError(error);
    }
  }

  public async render(request: PdfRenderRequest): Promise<PdfRenderResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "render") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return {
      bytes: base64ToBytes(response.bytes),
      pageCount: response.pageCount,
      pages: response.pages,
      warnings: response.warnings,
      providerId: this.id,
      ...(response.pdfa ? { pdfa: response.pdfa } : {}),
      ...(response.attachments ? { attachments: response.attachments } : {}),
      ...(response.signing ? { signing: response.signing } : {})
    };
  }

  public async layout(request: PdfLayoutRequest): Promise<PdfLayoutResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "layout") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return { pages: response.pages, warnings: response.warnings };
  }

  public async fill(request: PdfFillRequest): Promise<PdfFillResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "fill") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return {
      bytes: base64ToBytes(response.bytes),
      pageCount: response.pageCount,
      pages: [],
      fields: response.fields,
      ...(response.areas ? { areas: response.areas } : {}),
      warnings: response.warnings,
      providerId: this.id,
      ...(response.pdfa ? { pdfa: response.pdfa } : {}),
      ...(response.attachments ? { attachments: response.attachments } : {}),
      ...(response.signing ? { signing: response.signing } : {})
    };
  }

  public async inspect(request: PdfInspectRequest): Promise<PdfTemplateInfo> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "inspect") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return response.info;
  }

  public async document(request: PdfDocumentRequest) {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "document") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return {
      bytes: base64ToBytes(response.bytes),
      pageCount: response.pageCount,
      pages: response.pages,
      warnings: response.warnings,
      providerId: this.id,
      ...(response.fields ? { fields: response.fields } : {}),
      ...(response.areas ? { areas: response.areas } : {}),
      ...(response.pdfa ? { pdfa: response.pdfa } : {}),
      ...(response.attachments ? { attachments: response.attachments } : {}),
      ...(response.signing ? { signing: response.signing } : {}),
      // Which layout printed and how it was chosen.
      ...(response.layoutId !== undefined ? { layoutId: response.layoutId } : {}),
      ...(response.layoutKind ? { layoutKind: response.layoutKind } : {}),
      ...(response.layoutChoice ? { layoutChoice: response.layoutChoice } : {})
    };
  }

  public async sign(request: PdfSignRequest): Promise<PdfSignResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "sign") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return { bytes: base64ToBytes(response.bytes), signing: response.signing, warnings: response.warnings, providerId: this.id };
  }

  public async complete(request: PdfCompleteRequest): Promise<PdfCompleteResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "complete") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return { bytes: base64ToBytes(response.bytes), field: response.field, cms: response.cms, timestamped: response.timestamped, providerId: this.id };
  }

  public async timestampRequest(request: PdfTimestampRequest): Promise<Uint8Array> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "timestampRequest") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return base64ToBytes(response.request);
  }

  public async verify(request: PdfVerifyRequest): Promise<PdfVerifyResult> {
    const response = unwrapPdfResponse(this.exchange(request));
    if (response.op !== "verify") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return { signatures: response.signatures, attachments: response.attachments, warnings: response.warnings, ...(response.documentId !== undefined ? { documentId: response.documentId } : {}), providerId: this.id };
  }

  public async capabilities(): Promise<PdfCapabilities> {
    const response = unwrapPdfResponse(this.exchange({ abi: PDF_ABI_VERSION, op: "capabilities" }));
    if (response.op !== "capabilities") {
      throw new Error(`Unexpected response op ${response.op}`);
    }
    return { abi: response.abi, features: response.features, ...(response.kernelVersion ? { kernelVersion: response.kernelVersion } : {}) };
  }

  public dispose(): void {
    this.host.dispose();
  }
}

export function createQuickJsPdfProvider(options: QuickJsPdfProviderOptions = {}): Promise<QuickJsPdfProvider> {
  return QuickJsPdfProvider.create(options);
}
