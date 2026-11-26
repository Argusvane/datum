import { readDraftJourney, type FormDraft } from "../core/draft-store.js";

function stableObject(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(stableObject);
  }

  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    return Object.fromEntries(entries.map(([key, value]) => [key, stableObject(value)]));
  }

  return input;
}

export function serializeDraftFile(draft: FormDraft): string {
  // Stable ordering keeps exported draft files deterministic for signing/diffing.
  return JSON.stringify(stableObject(draft));
}

export function parseDraftFile(payload: string): FormDraft {
  const parsed = JSON.parse(payload) as Partial<FormDraft>;

  if (!parsed.id || !parsed.formId || !parsed.formVersion) {
    throw new Error("Invalid draft file: missing required identifiers.");
  }

  if (!parsed.runtime?.schemaVersion || !parsed.runtime?.rendererVersion) {
    throw new Error("Invalid draft file: missing runtime version context.");
  }

  if (!parsed.locale || !parsed.values || !parsed.state) {
    throw new Error("Invalid draft file: missing locale, values, or state.");
  }

  const state = parsed.state as FormDraft["state"];
  if (state.journey !== undefined) {
    const journey = readDraftJourney(state.journey);
    if (journey) {
      state.journey = journey;
    } else {
      delete state.journey;
    }
  }

  return parsed as FormDraft;
}
