/**
 * What Submit does while the author tries the form (the Settings panel's "Submitting in Try it"): a stand-in for the page's server, held by the controller for the session like the
 * simulated data sources. The definition never holds any of it.
 */
import type { FormNoticePlacement } from "../../core/submission/form-notice.js";

/** The receipt an accepted submit shows, with a reference made up from a pattern. */
export interface TrySubmissionReceipt {
  kind: "success" | "info";
  title: string;
  message: string;
  /** The label of the one detail line, the reference ("Confirmation number"). */
  detailLabel: string;
  /** The reference, each `{n}` six random digits ("DT-{n}"). Blank, the receipt has no detail line. */
  referencePattern: string;
  placement: FormNoticePlacement[];
}

export interface TrySubmissionSettings {
  /** What the stand-in server answers once the answers pass the checks. */
  outcome: "accept" | "refuse" | "fail";
  /** How long it takes to answer, in milliseconds (0 to 10000). */
  delayMs: number;
  /** The ends of the form the "Submitting…" line goes at. */
  statusPlacement: FormNoticePlacement[];
  /** The line's wording; blank, the engine's "Submitting…". */
  statusText: string;
  receipt: TrySubmissionReceipt;
  /** The form-level error a refusal puts on the form. */
  refusalMessage: string;
  /** After an accepted submit, the answers stay editable or show read only. */
  afterAccept: "editable" | "readonly";
}

/** A change to some of the settings, the receipt's included. */
export type TrySubmissionUpdate = Partial<Omit<TrySubmissionSettings, "receipt">> & { receipt?: Partial<TrySubmissionReceipt> | undefined };

export const TRY_SUBMISSION_DELAY_MAX = 10_000;

export const DEFAULT_TRY_SUBMISSION: TrySubmissionSettings = Object.freeze({
  outcome: "accept",
  delayMs: 800,
  statusPlacement: ["top"],
  statusText: "",
  receipt: Object.freeze({
    kind: "success",
    title: "Thank you",
    message: "We have your answers.",
    detailLabel: "Confirmation number",
    referencePattern: "DT-{n}",
    placement: ["top"]
  }) as TrySubmissionReceipt,
  refusalMessage: "The server refused the form.",
  afterAccept: "editable"
}) as TrySubmissionSettings;

/** What a refusal says when the author blanked its message, and what a failed send says. */
export const TRY_SUBMISSION_FAILED_MESSAGE = "The form could not be sent. Try again.";

/** Top, bottom or both, top first; anything else (or nothing) is the top. */
export function normalizeTryPlacement(value: unknown, fallback: FormNoticePlacement[] = ["top"]): FormNoticePlacement[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const kept = (["top", "bottom"] as const).filter((end) => value.includes(end));
  return kept.length > 0 ? kept : ["top"];
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** `update` laid over `base` (the defaults when none), each value kept to what it may be. */
export function normalizeTrySubmission(update: TrySubmissionUpdate | undefined, base: TrySubmissionSettings = DEFAULT_TRY_SUBMISSION): TrySubmissionSettings {
  const next = update ?? {};
  const receipt = next.receipt ?? {};
  const outcome = next.outcome === "accept" || next.outcome === "refuse" || next.outcome === "fail" ? next.outcome : base.outcome;
  const delay = next.delayMs === undefined ? base.delayMs : Number(next.delayMs);
  return {
    outcome,
    delayMs: Number.isFinite(delay) ? Math.min(TRY_SUBMISSION_DELAY_MAX, Math.max(0, Math.round(delay))) : base.delayMs,
    statusPlacement: next.statusPlacement === undefined ? [...base.statusPlacement] : normalizeTryPlacement(next.statusPlacement),
    statusText: text(next.statusText, base.statusText),
    receipt: {
      kind: receipt.kind === "success" || receipt.kind === "info" ? receipt.kind : base.receipt.kind,
      title: text(receipt.title, base.receipt.title),
      message: text(receipt.message, base.receipt.message),
      detailLabel: text(receipt.detailLabel, base.receipt.detailLabel),
      referencePattern: text(receipt.referencePattern, base.receipt.referencePattern),
      placement: receipt.placement === undefined ? [...base.receipt.placement] : normalizeTryPlacement(receipt.placement)
    },
    refusalMessage: text(next.refusalMessage, base.refusalMessage),
    afterAccept: next.afterAccept === "editable" || next.afterAccept === "readonly" ? next.afterAccept : base.afterAccept
  };
}

/** A reference from the pattern: each `{n}` six random digits. Blank, none. */
export function trySubmissionReference(pattern: string, random: () => number = Math.random): string | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\{n\}/g, () =>
    String(Math.min(999_999, Math.floor(random() * 1_000_000))).padStart(6, "0")
  );
}
