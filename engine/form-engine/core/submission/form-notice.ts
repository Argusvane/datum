import type { LocalizedText } from "../schema/contracts.js";

/**
 * What a host shows the person once a submission was delivered: the server's receipt — a
 * confirmation number, a date, a word of thanks. The counterpart of `HostError`:
 * `setErrors` carries the server's verdict against the form, `setNotice` its outcome for the
 * person. Every text is a `LocalizedText` (the host's data: the words in each
 * language travel with it), resolved for the form's locale, so the receipt follows the language
 * switcher; the renderer draws it where the error summary goes and the printed form carries it too.
 */
export interface FormNotice {
  /**
   * The tone the renderer styles it in: `"success"` (the default), `"info"`, `"warning"` or
   * `"error"`. An error is announced assertively (`role="alert"` on the paint that first shows it, as the error summary is, a status region on later paints of the same notice);
   * the other three are polite status regions.
   */
  kind?: FormNoticeKind | undefined;
  /**
   * The ends of the form it goes at: `"top"`, where the error summary goes, and/or
   * `"bottom"`, after the fields beside the button the person just pressed. Missing or empty
   * means `["top"]`; order and repeats do not matter. Listed at both ends, the top copy is
   * the status region — announced, focusable — and the bottom one its visual echo, hidden
   * from assistive technology so the receipt is read once.
   */
  placement?: FormNoticePlacement[] | undefined;
  title?: LocalizedText | undefined;
  message?: LocalizedText | undefined;
  /** Labelled values worth keeping: `[{ label: "Confirmation number", value: "GC-48213" }]`. */
  details?: FormNoticeDetail[] | undefined;
  /**
   * The receipt as plain JSON (`{ reference: "GC-48213", receivedAt: "2026-03-15" }`): read by a
   * printed form's header and footer as `{{receipt.<path>}}`, never drawn by itself. A notice
   * with only `data` draws nothing on screen or on paper.
   */
  data?: Record<string, unknown> | undefined;
}

export interface FormNoticeDetail {
  label: LocalizedText;
  value: string;
}

/** The tone of a notice. */
export type FormNoticeKind = "success" | "info" | "warning" | "error";

/** One end of the form a notice can go at. */
export type FormNoticePlacement = "top" | "bottom";
