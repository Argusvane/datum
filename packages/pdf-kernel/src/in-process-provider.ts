/**
 * The provider a JS host uses: the program's own modules, called directly with
 * objects — no JSON, no sandbox. Byte-identical to the QuickJS provider by construction, which
 * the parity suite holds it to.
 */
import {
  PDF_ABI_VERSION,
  base64ToBytes,
  unwrapPdfResponse,
  type PdfCapabilities,
  type PdfCompleteRequest,
  type PdfCompleteResult,
  type PdfDocumentRequest,
  type PdfFillRequest,
  type PdfFillResult,
  type PdfInspectRequest,
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
import { handlePdfRequest, registerPdfProgramModule } from "./program/entry.js";
import { installPdfProgramPolyfills } from "./program/polyfills.js";

export const IN_PROCESS_PDF_PROVIDER_ID = "datum-pdf-kernel";

export interface InProcessPdfProviderOptions {
  /** Plugin modules carrying `pdfRenditions`, registered before the first request. */
  modules?: unknown[];
}

export function createInProcessPdfProvider(options: InProcessPdfProviderOptions = {}): PdfRenderProvider {
  installPdfProgramPolyfills();
  for (const module of options.modules ?? []) {
    registerPdfProgramModule(module);
  }
  const id = IN_PROCESS_PDF_PROVIDER_ID;
  return {
    id,
    abiVersion: PDF_ABI_VERSION,
    async render(request: PdfRenderRequest): Promise<PdfRenderResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "render") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return {
        bytes: base64ToBytes(response.bytes),
        pageCount: response.pageCount,
        pages: response.pages,
        warnings: response.warnings,
        providerId: id,
        ...(response.pdfa ? { pdfa: response.pdfa } : {}),
        ...(response.attachments ? { attachments: response.attachments } : {}),
        ...(response.signing ? { signing: response.signing } : {})
      };
    },
    async layout(request: PdfLayoutRequest): Promise<PdfLayoutResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "layout") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return { pages: response.pages, warnings: response.warnings };
    },
    async fill(request: PdfFillRequest): Promise<PdfFillResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
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
        providerId: id,
        ...(response.pdfa ? { pdfa: response.pdfa } : {}),
        ...(response.attachments ? { attachments: response.attachments } : {}),
        ...(response.signing ? { signing: response.signing } : {})
      };
    },
    async inspect(request: PdfInspectRequest): Promise<PdfTemplateInfo> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "inspect") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return response.info;
    },
    async document(request: PdfDocumentRequest) {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "document") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return {
        bytes: base64ToBytes(response.bytes),
        pageCount: response.pageCount,
        pages: response.pages,
        warnings: response.warnings,
        providerId: id,
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
    },
    async sign(request: PdfSignRequest): Promise<PdfSignResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "sign") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return { bytes: base64ToBytes(response.bytes), signing: response.signing, warnings: response.warnings, providerId: id };
    },
    async complete(request: PdfCompleteRequest): Promise<PdfCompleteResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "complete") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return { bytes: base64ToBytes(response.bytes), field: response.field, cms: response.cms, timestamped: response.timestamped, providerId: id };
    },
    async timestampRequest(request: PdfTimestampRequest): Promise<Uint8Array> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "timestampRequest") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return base64ToBytes(response.request);
    },
    async verify(request: PdfVerifyRequest): Promise<PdfVerifyResult> {
      const response = unwrapPdfResponse(await handlePdfRequest(request));
      if (response.op !== "verify") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return { signatures: response.signatures, attachments: response.attachments, warnings: response.warnings, ...(response.documentId !== undefined ? { documentId: response.documentId } : {}), providerId: id };
    },
    async capabilities(): Promise<PdfCapabilities> {
      const response = unwrapPdfResponse(await handlePdfRequest({ abi: PDF_ABI_VERSION, op: "capabilities" }));
      if (response.op !== "capabilities") {
        throw new Error(`Unexpected response op ${response.op}`);
      }
      return { abi: response.abi, kernelVersion: response.kernelVersion };
    }
  };
}
