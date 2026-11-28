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
 * A draft that is not one is refused (`draft.malformed`): `values` not a record, no `state`, or
 * a `state` without its navigation — a `mode` of `normal` or `wizard` and the `visitedSteps` and
 * `completedSteps` lists. The rest falls back rather than lose the answers: a locale the form no
 * longer offers reads as the one in force (`current`), matched as a tag is (case, `_` for `-`,
 * the primary subtag), and a form that declares no locales takes any tag; a malformed `touched`
 * or `dirty` list or journey block is dropped (the journey block read as a draft file's is), and
 * so is an entry of a list that is no string.
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
  const mode = state.mode;
  const visitedSteps = strings(state.visitedSteps);
  const completedSteps = strings(state.completedSteps);
  if ((mode !== "normal" && mode !== "wizard") || visitedSteps === undefined || completedSteps === undefined) {
    throw new DraftError("draft.malformed", "Draft is malformed: its state has no navigation mode, visited steps or completed steps");
  }
  const requested = typeof raw.locale === "string" && raw.locale !== "" ? raw.locale : undefined;
  const locale =
    requested === undefined ? current : supported.length === 0 ? requested : (negotiateLocale(requested, supported) ?? current);
  const currentStep = typeof state.currentStep === "string" && state.currentStep !== "" ? state.currentStep : undefined;
  return {
    values: raw.values as FormValues,
    locale,
    touched: strings(state.touched) ?? [],
    dirty: strings(state.dirty) ?? [],
    mode,
    currentStep,
    visitedSteps,
    completedSteps,
    journey: state.journey === undefined ? undefined : readDraftJourney(state.journey)
  };
}
