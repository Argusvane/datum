import type { FormTestScenarioEntry } from "./form-test-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The definition's form tests, read tolerantly as `readJourneys` reads
 * journeys (`core/schema/journey.ts`): a missing or malformed `tests` is none, an entry without
 * a string `id` (non-empty: the builder's handle) and a string `source` is dropped, and an id
 * the list already has is dropped too, so the first wins. Only the two known keys are copied,
 * so a stray key on a stored entry never travels on.
 */
export function readFormTests(definition: { tests?: unknown } | undefined): FormTestScenarioEntry[] {
  const configuration = definition?.tests;
  if (!isRecord(configuration) || !Array.isArray(configuration.scenarios)) {
    return [];
  }
  const seen = new Set<string>();
  const entries: FormTestScenarioEntry[] = [];
  for (const entry of configuration.scenarios as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "" || typeof entry.source !== "string") {
      continue;
    }
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    entries.push({ id: entry.id, source: entry.source });
  }
  return entries;
}
