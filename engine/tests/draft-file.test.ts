import { describe, expect, it } from "vitest";

import {
  parseDraftFile,
  serializeDraftFile
} from "../form-engine/persistence/file-draft/draft-file.js";

describe("draft file serialization", () => {
  it("serializes deterministically", () => {
    const draft = {
      id: "d1",
      formId: "f1",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
      locale: "fr-CA",
      values: { b: 2, a: 1 },
      state: { currentStep: "s1", touched: ["a"], dirty: ["a"] },
      updatedAt: 1
    };

    const one = serializeDraftFile(draft);
    const two = serializeDraftFile(draft);
    expect(one).toBe(two);
  });

  it("parses valid draft and rejects missing identifiers", () => {
    const payload = serializeDraftFile({
      id: "d1",
      formId: "f1",
      formVersion: "1",
      runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
      locale: "fr-CA",
      values: {},
      state: { touched: [], dirty: [] },
      updatedAt: 1
    });

    const parsed = parseDraftFile(payload);
    expect(parsed.id).toBe("d1");

    expect(() => parseDraftFile(JSON.stringify({ id: "d2" }))).toThrow(/Invalid draft file/);
  });
});
