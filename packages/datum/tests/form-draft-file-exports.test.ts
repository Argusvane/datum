import { describe, expect, it } from "vitest";

import { parseDraftFile, serializeDraftFile, type FormDraft } from "../src/form.js";

/*
 * The draft file helpers are exported by the form bundle: the docs teach a page to keep a draft
 * as a file with these two, so they come from `datum-form.js` and not from the engine package.
 */

function draft(): FormDraft {
  return {
    id: "intake-2026",
    formId: "intake",
    formVersion: "1.0.0",
    runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
    locale: "en",
    values: { name: "Ada", age: 36 },
    state: { mode: "embed", touched: {}, dirty: {}, visitedSteps: [], completedSteps: [] },
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as unknown as FormDraft;
}

describe("the draft file helpers of the form bundle", () => {
  it("write a draft in a stable key order and read it back", () => {
    const text = serializeDraftFile(draft());
    expect(text).toBe(serializeDraftFile({ ...draft(), values: { age: 36, name: "Ada" } }));
    expect(parseDraftFile(text)).toEqual(draft());
  });

  it("refuse a file that is not a draft with a plain error", () => {
    expect(() => parseDraftFile(JSON.stringify({ id: "x" }))).toThrow(/Invalid draft file/);
  });
});
