/**
 * The option an answer names: an option's value first, else exactly one option whose label equals the answer
 * after trim and NFC (case kept), in the language the model's labels were resolved in; else
 * the answer itself when the field takes free text. Hint-free: the problems carry
 * the details the renderer's refusals carry and the caller words them.
 */

import type { RenderComponentModel } from "../../render/core/component-model.js";
import { optionsOf, type Option } from "./kinds.js";
import { invalidValueProblem, type AnswerResult } from "./problems.js";

/** How many options a `no-such-option` problem lists (its `total` counts them all). */
export const OPTIONS_IN_PROBLEM = 10;

/** Trim and NFC, the normalisation a label match applies to both sides (case kept). */
export function normalizeLabel(text: string): string {
  return text.trim().normalize("NFC");
}

export interface MatchOptions {
  /** The field takes an answer outside its options (`data.answersFree`). */
  acceptsFreeText: boolean;
  /**
   * The language the caller reads in. The model's labels are already resolved in it (the
   * memo or the preview runtime drew them), so the match compares them as they are and never
   * reads another language's label.
   */
  locale: string;
}

function sourceDetails(model: RenderComponentModel, path: string): Record<string, unknown> {
  const details: Record<string, unknown> = { path };
  if (model.optionState.sourceId !== undefined) {
    details.sourceId = model.optionState.sourceId;
  }
  return details;
}

/** The option a scalar names: by value first, else by exactly one label; a problem otherwise. */
export function matchOption(model: RenderComponentModel, raw: unknown, path: string, options: MatchOptions): AnswerResult {
  if (model.optionState.status === "loading") {
    return { ok: false, problem: { code: "options-loading", path, details: sourceDetails(model, path) } };
  }
  if (model.optionState.status === "error") {
    return { ok: false, problem: { code: "options-failed", path, details: { ...sourceDetails(model, path), what: "data-source" } } };
  }
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return invalidValueProblem(path, "choice", "an option value or exact label", raw);
  }
  const text = String(raw);
  const items = model.optionState.items;
  const byValue = items.find((item) => item.value === text);
  if (byValue !== undefined) {
    return { ok: true, value: byValue.value, matched: "value" };
  }
  const wanted = normalizeLabel(text);
  const byLabel = items.filter((item) => normalizeLabel(item.label) === wanted);
  if (byLabel.length === 1) {
    return { ok: true, value: (byLabel[0] as { value: string }).value, matched: "label" };
  }
  if (byLabel.length > 1) {
    return {
      ok: false,
      problem: { code: "option-ambiguous", path, got: text, details: { path, got: text, candidates: byLabel.map((item) => ({ value: item.value, label: item.label }) as Option) } }
    };
  }
  if (options.acceptsFreeText) {
    return { ok: true, value: text, matched: "free" };
  }
  const all = optionsOf(model);
  return {
    ok: false,
    problem: {
      code: "no-such-option",
      path,
      got: text,
      details: { path, got: text, options: all.slice(0, OPTIONS_IN_PROBLEM), total: all.length, acceptsFreeText: options.acceptsFreeText }
    }
  };
}
