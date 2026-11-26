import { negotiateLocale } from "../../core/localization/supported-locales.js";
import type { FormValues } from "../../core/state/form-state.js";
import { DraftError, readDraftJourney, type FormDraft, type FormDraftJourney } from "../../persistence/core/draft-store.js";

/** A draft as {@link readDraft} hands it to `FormRuntime.hydrateFromDraft`: every member of the type it says it is. */
export interface ReadDraft {
  values: FormValues;
  locale: string;
  touched: string[];
  dirty: string[];
  mode: "normal" | "wizard";
  currentStep: string | undefined;
  visitedSteps: string[];
  completedSteps: string[];
  journey: FormDraftJourney | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/**
 * A draft read in full before anything is put back, so a malformed one either restores what it
 * can or changes nothing. Every store hands the runtime what it holds as it holds it (a page's
 * own store, a tampered `localStorage`, a draft saved before a language was removed), so the
 * type is not taken on trust.
 *
 * Only a draft with no answers to give is refused (`values` not a record, or no `state`). The
 * rest falls back rather than lose the answers: a locale the form no longer offers reads as the
 * one in force (`current`), matched as a tag is (case, `_` for `-`, the primary subtag), and a
 * form that declares no locales takes any tag; a malformed `touched`, `dirty`, steps or journey
 * block is dropped (the journey block read as a draft file's is).
 */
export function readDraft(draft: FormDraft, supported: readonly string[], current: string): ReadDraft {
  const raw = draft as unknown as Record<string, unknown>;
  if (!isPlainRecord(raw.values) || !isPlainRecord(raw.state)) {
    throw new DraftError(
      "draft.malformed",
      `Draft is malformed: ${!isPlainRecord(raw.values) ? "its values are not a record" : "it has no state"}`
    );
  }
  const state = raw.state;
  const requested = typeof raw.locale === "string" && raw.locale !== "" ? raw.locale : undefined;
  const locale =
    requested === undefined ? current : supported.length === 0 ? requested : (negotiateLocale(requested, supported) ?? current);
  const currentStep = typeof state.currentStep === "string" && state.currentStep !== "" ? state.currentStep : undefined;
  const mode = state.mode === "normal" || state.mode === "wizard" ? state.mode : currentStep !== undefined ? "wizard" : "normal";
  return {
    values: raw.values as FormValues,
    locale,
    touched: strings(state.touched) ?? [],
    dirty: strings(state.dirty) ?? [],
    mode,
    currentStep,
    visitedSteps: strings(state.visitedSteps) ?? (currentStep !== undefined ? [currentStep] : []),
    completedSteps: strings(state.completedSteps) ?? [],
    journey: state.journey === undefined ? undefined : readDraftJourney(state.journey)
  };
}
