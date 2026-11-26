import type { AgentProvenance } from "../../core/events/hooks.js";
import type { PdfLayoutChoice } from "../../core/schema/pdf-layout.js";
import type { PdfWarning } from "../pdf/pdf-document.js";
import type { RenderFormPdfOptions, RenderFormPdfSignature } from "../pdf/pdf-service.js";

/**
 * Hands a rendered PDF to the person as a file the browser downloads — the PDF counterpart of
 * `downloadSubmission`, and the same seam shape as `datum-print` and
 * `datum-download`: announce first, save unless a listener took over.
 *
 * Nothing here touches a DOM global at module scope: the render barrel is imported under
 * Node, so the DOM is only reached inside these functions.
 */

export const PDF_MIME_TYPE = "application/pdf";

/**
 * Detail of the cancelable `datum-pdf` event, dispatched from the renderer before the browser
 * is handed the file: the bytes, the file name, which layout produced it, and what the kernel
 * had to say. A host that calls `preventDefault()` takes the bytes over — to its own storage,
 * an upload, a viewer of its own — and no download starts.
 */
export interface DatumPdfDetail {
  bytes: Uint8Array;
  fileName: string;
  layoutId: string;
  /**
   * How that layout was chosen: `condition` when a download that named none printed
   * the first layout whose `when` held on the answers. Absent from a caller's own detail.
   */
  layoutChoice?: PdfLayoutChoice;
  pageCount: number;
  warnings: PdfWarning[];
  /** Present when the file was signed (a `pdfSigner`, or the call's own `signature`): what was signed. */
  signature?: RenderFormPdfSignature;
  /**
   * `"agent"` when the agent tools' `download_pdf` asked for this file, the
   * same fact as `agent.submittedBy === "agent"`; absent for the person's button and a host's
   * own call.
   */
  trigger?: "agent";
  /**
   * The page's account of the answers the agent tools wrote, on every
   * download from a form element the tools were registered for since it loaded, the person's
   * button included; absent when they never were. Client-side and advisory.
   */
  agent?: AgentProvenance;
}

/**
 * What a download is asked: the render options (`renderFormPdf`'s), the document the file is
 * staged in, and who asked. `trigger` and `agent` go on the `datum-pdf` detail and never into
 * the render: the render options are the PDF service chunk's and reach the
 * kernel, so the renderer's `downloadPdf` takes these two off before it renders. That method
 * takes the options without `document`: it always stages the file in its own document.
 */
export interface DownloadPdfOptions extends RenderFormPdfOptions {
  /** The document to stage the download in (this function's option only); defaults to the global one. */
  document?: Document;
  /** Put on the detail as `trigger`: `"agent"` when the agent tools' `download_pdf` asked. */
  trigger?: "agent";
  /** Put on the detail as `agent`: the page's account of the agent-written answers. */
  agent?: AgentProvenance;
}

export interface DownloadPdfResult extends DatumPdfDetail {
  /** `false` when a listener cancelled the event, or when this environment cannot produce blob URLs. */
  downloaded: boolean;
  /**
   * `true` when a `datum-pdf` listener cancelled the event and so took the file over: with `downloaded`, it tells a page that has the file from one where nothing
   * reached anybody (`downloaded` and `cancelled` both `false`: no blob URLs here).
   */
  cancelled: boolean;
}

/**
 * Announces `datum-pdf` with the detail (plus `options.trigger` / `options.agent` when given)
 * and, unless a listener cancelled it, saves the bytes as a file. Of the options it reads only
 * `document`, `trigger` and `agent`; the render options are the renderer's business.
 */
export function downloadPdf(
  target: EventTarget,
  detail: DatumPdfDetail,
  options: Pick<DownloadPdfOptions, "document" | "trigger" | "agent"> = {}
): DownloadPdfResult {
  const announced: DatumPdfDetail = {
    ...detail,
    ...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
    ...(options.agent !== undefined ? { agent: options.agent } : {})
  };
  const proceed = target.dispatchEvent(
    new CustomEvent<DatumPdfDetail>("datum-pdf", {
      detail: announced,
      bubbles: true,
      composed: true,
      cancelable: true
    })
  );
  const downloaded = proceed && savePdfFile(announced.bytes, announced.fileName, options.document ?? document);
  return { ...announced, downloaded, cancelled: !proceed };
}

/** The same blob-anchor pattern as `submission-download.ts`; see there for why the anchor is attached and the revoke deferred. */
function savePdfFile(bytes: Uint8Array, fileName: string, doc: Document): boolean {
  if (typeof URL.createObjectURL !== "function") {
    return false;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: PDF_MIME_TYPE }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = fileName;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
