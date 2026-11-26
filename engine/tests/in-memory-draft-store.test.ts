import { describe, expect, it } from "vitest";

import { DraftError } from "../form-engine/persistence/core/draft-store.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";

describe("in-memory draft store", () => {
  it("saves, loads, lists, and deletes drafts", async () => {
    const store = new InMemoryDraftStore();

    await store.save({
      id: "d1",
      formId: "customer-onboarding",
      formVersion: "42",
      runtime: { schemaVersion: "3", rendererVersion: "5.8.1" },
      locale: "fr-CA",
      values: { firstName: "Ada" },
      state: { currentStep: "address", touched: ["firstName"], dirty: ["firstName"] },
      updatedAt: 2
    });

    await store.save({
      id: "d2",
      formId: "customer-onboarding",
      formVersion: "42",
      runtime: { schemaVersion: "3", rendererVersion: "5.8.1" },
      locale: "en-CA",
      values: { firstName: "Grace" },
      state: { currentStep: "address", touched: [], dirty: [] },
      updatedAt: 3
    });

    const loaded = await store.load("d1");
    expect(loaded.values.firstName).toBe("Ada");

    const list = await store.list();
    expect(list.map((d) => d.id)).toEqual(["d2", "d1"]);

    await store.delete("d1");
    await expect(store.load("d1")).rejects.toThrow(/Draft not found/);
  });

  it("refuses a key with nothing under it as a DraftError draft.notFound, with the message it always had", async () => {
    const store = new InMemoryDraftStore();
    const refusal = await store.load("nothing-here").then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(DraftError);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as DraftError).code).toBe("draft.notFound");
    expect((refusal as DraftError).message).toBe("Draft not found: nothing-here");
    expect((refusal as DraftError).name).toBe("DraftError");
  });
});
