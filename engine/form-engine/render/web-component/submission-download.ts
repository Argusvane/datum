import {
  SUBMISSION_FILE_MIME_TYPE,
  serializeSubmissionFile,
  submissionFileName,
  type SubmissionFileDocument
} from "../../core/submission/submission-file.js";

/**
 * Hands an accepted submission to the person as a file the browser downloads.
 *
 * This is what a `button` with `action: "download"` ends in. The renderer never calls it —
 * it reports the action and the *host* submits, because `runtime.submit(modeId,
 * versionContext)` needs arguments only the host has — so this is a function a host calls
 * once it holds a `CanonicalSubmission`, not a method on the renderer. What goes in the file
 * is decided in `core/submission/submission-file.ts`; this module only knows how to get it
 * onto the disk.
 *
 * Nothing here touches a DOM global at module scope: the render barrel is imported under
 * Node (see `custom-element-base.ts`), so the DOM is only reached inside these functions.
 */

/**
 * Detail of the cancelable `datum-download` event, dispatched from the host element before
 * the browser is handed the file: the envelope, the file name it will be saved as and the
 * exact text it will hold. A host that calls `preventDefault()` takes the file over — to
 * its own storage, a share sheet, an upload — and no download starts. The same seam shape as
 * `datum-print`.
 */
export interface DatumDownloadDetail {
  /** The envelope — or, under the wrapper signing placement, the signed document around it. */
  submission: SubmissionFileDocument;
  fileName: string;
  json: string;
}

export interface DownloadSubmissionOptions {
  /** Overrides the generated `<form id>-submission-<stamp>.json`. */
  fileName?: string;
  /** The document to stage the download in; defaults to the global one. */
  document?: Document;
}

export interface DownloadSubmissionResult extends DatumDownloadDetail {
  /**
   * `false` when a `datum-download` listener cancelled the event and took the file itself,
   * or when this environment cannot produce blob URLs — a test DOM, a page with no
   * `URL.createObjectURL`. Either way the person did not get a download from here.
   */
  downloaded: boolean;
}

/**
 * Serializes `submission`, announces it as `datum-download` from `target` (bubbling and
 * composed, so a listener on the page hears it through any shadow root), and unless the
 * event was cancelled saves it through a temporary `<a download>`.
 */
export function downloadSubmission(
  target: EventTarget,
  submission: SubmissionFileDocument,
  options: DownloadSubmissionOptions = {}
): DownloadSubmissionResult {
  const json = serializeSubmissionFile(submission);
  const fileName = options.fileName ?? submissionFileName(submission);
  const detail: DatumDownloadDetail = { submission, fileName, json };
  const proceed = target.dispatchEvent(
    new CustomEvent<DatumDownloadDetail>("datum-download", {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true
    })
  );
  const downloaded = proceed && saveTextFile(json, fileName, options.document ?? document);
  return { ...detail, downloaded };
}

/**
 * The blob-download pattern `<datum-form-renderer>` uses for an embedded attachment: an
 * object URL on an anchor that is in the document for the length of one click (Firefox will
 * not follow a detached one), revoked once the browser has had a moment to start the
 * download — not before, or the download reads an empty file.
 */
function saveTextFile(text: string, fileName: string, doc: Document): boolean {
  if (typeof URL.createObjectURL !== "function") {
    return false;
  }
  const url = URL.createObjectURL(new Blob([text], { type: SUBMISSION_FILE_MIME_TYPE }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = fileName;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
