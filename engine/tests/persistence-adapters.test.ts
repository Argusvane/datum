import { describe, expect, it } from "vitest";

import { BrowserLocalDraftStore } from "../form-engine/persistence/local-storage/browser-local-draft-store.js";
import { IndexedDbDraftStore } from "../form-engine/persistence/indexeddb/indexeddb-draft-store.js";
import { ServerDraftStore } from "../form-engine/persistence/server/server-draft-store.js";
import type { FormDraft } from "../form-engine/persistence/core/draft-store.js";

function draft(id: string, updatedAt: number): FormDraft {
  return {
    id,
    formId: "f1",
    formVersion: "1",
    runtime: {
      schemaVersion: "1",
      rendererVersion: "1.0.0"
    },
    locale: "en-CA",
    values: { firstName: "Ada" },
    state: {
      mode: "normal",
      touched: ["firstName"],
      dirty: ["firstName"],
      visitedSteps: [],
      completedSteps: []
    },
    updatedAt
  };
}

describe("persistence adapters", () => {
  it("supports browser local draft store index/list/load/delete", async () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      }
    };

    const store = new BrowserLocalDraftStore(storage);
    await store.save(draft("d1", 10));
    await store.save(draft("d2", 20));
    await store.rebuildIndex(["d1", "d2"]);

    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(["d2", "d1"]);

    const loaded = await store.load("d1");
    expect(loaded.id).toBe("d1");

    await store.delete("d1");
    await expect(store.load("d1")).rejects.toThrow(/not found/);
  });

  it("supports indexeddb-style repository adapter", async () => {
    const memory = new Map<string, FormDraft>();
    const repository = {
      put: async (entry: FormDraft) => {
        memory.set(entry.id, entry);
      },
      get: async (id: string) => memory.get(id),
      list: async () => [...memory.values()],
      delete: async (id: string) => {
        memory.delete(id);
      }
    };

    const store = new IndexedDbDraftStore(repository);
    await store.save(draft("d1", 10));
    await store.save(draft("d2", 20));

    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(["d2", "d1"]);

    await store.delete("d2");
    await expect(store.load("d2")).rejects.toThrow(/not found/);
  });

  it("supports server-backed draft adapter", async () => {
    const memory = new Map<string, FormDraft>();
    const store = new ServerDraftStore({
      saveDraft: async (entry) => {
        memory.set(entry.id, entry);
      },
      loadDraft: async (id) => memory.get(id),
      listDrafts: async () =>
        [...memory.values()].map((entry) => ({
          id: entry.id,
          formId: entry.formId,
          formVersion: entry.formVersion,
          locale: entry.locale,
          updatedAt: entry.updatedAt
        })),
      deleteDraft: async (id) => {
        memory.delete(id);
      }
    });

    await store.save(draft("d1", 10));
    await store.save(draft("d2", 20));

    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(["d2", "d1"]);

    const loaded = await store.load("d1");
    expect(loaded.values.firstName).toBe("Ada");
  });
});
