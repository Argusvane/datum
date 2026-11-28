import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftError, type DraftStore, type FormDraft } from "../form-engine/persistence/core/draft-store.js";
import { assertDraftCompatible } from "../form-engine/persistence/core/draft-compatibility.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { BrowserLocalDraftStore, type StorageLike } from "../form-engine/persistence/local-storage/browser-local-draft-store.js";
import { IndexedDbDraftStore } from "../form-engine/persistence/indexeddb/indexeddb-draft-store.js";
import { ServerDraftStore } from "../form-engine/persistence/server/server-draft-store.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

// The web components package is outside this package's compile root: its `server:<url>` store
// is loaded by path, not by import (its own `@argusvane/datum-engine` import resolves to this engine).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { createUrlDraftStore } = (await import(/* @vite-ignore */ resolve(repo, "packages/datum/src/draft-store-url.ts"))) as {
  createUrlDraftStore(url: string): DraftStore;
};

/*
 * `DraftError`: every place that refuses to bring a draft back throws it,
 * with a code a caller branches on (the agent's `drafts { restore }` answers `no-draft` and
 * `draft-incompatible` from it) and the message the place always threw, so a host that reads
 * `message` sees no change. Seven places: the five stores' `load` (the four in the engine and
 * the `server:<url>` store of the web components), the compatibility check, and the runtime's
 * check that the draft is this form's.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What a rejection was, read off the error itself. */
async function failure(promise: Promise<unknown>): Promise<{ error: unknown; code?: string; message?: string; name?: string }> {
  try {
    await promise;
  } catch (error) {
    const fields = error instanceof Error ? { message: error.message, name: error.name } : {};
    return { error, ...fields, ...(error instanceof DraftError ? { code: error.code } : {}) };
  }
  throw new Error("expected a rejection");
}

function draft(overrides: Partial<FormDraft> = {}): FormDraft {
  return {
    id: "d1",
    formId: "f",
    formVersion: "1",
    runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
    locale: "en",
    values: { name: "Ada" },
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
    updatedAt: 1,
    ...overrides
  };
}

function runtime(withVersions = false): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const definition = {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
  };
  return new FormRuntime(definition as never, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([]),
    ...(withVersions ? { versionContext: { formVersion: "1", schemaVersion: "1", rendererVersion: "1.0.0" } } : {})
  });
}

describe("DraftError at every place a draft is refused", () => {
  it("is an Error with a name and a code, and keeps the message it was given", () => {
    const error = new DraftError("draft.notFound", "Draft not found: x");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DraftError);
    expect(error.name).toBe("DraftError");
    expect(error.code).toBe("draft.notFound");
    expect(error.message).toBe("Draft not found: x");
  });

  it("the in-memory store: draft.notFound, 'Draft not found: <id>'", async () => {
    const seen = await failure(new InMemoryDraftStore().load("missing"));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.notFound", message: "Draft not found: missing", name: "DraftError" });
  });

  it("the browser's local storage store: draft.notFound, 'Draft not found: <id>'", async () => {
    const storage: StorageLike = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const seen = await failure(new BrowserLocalDraftStore(storage).load("missing"));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.notFound", message: "Draft not found: missing" });
  });

  it("the IndexedDB store: draft.notFound, 'Draft not found: <id>'", async () => {
    const repository = { put: async () => undefined, get: async () => undefined, list: async () => [], delete: async () => undefined };
    const seen = await failure(new IndexedDbDraftStore(repository).load("missing"));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.notFound", message: "Draft not found: missing" });
  });

  it("the server store over a host's API: draft.notFound, 'Draft not found: <id>'", async () => {
    const api = { saveDraft: async () => undefined, loadDraft: async () => undefined, listDrafts: async () => [], deleteDraft: async () => undefined };
    const seen = await failure(new ServerDraftStore(api).load("missing"));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.notFound", message: "Draft not found: missing" });
  });

  it("the web components' server:<url> store on a 404: draft.notFound, 'Draft not found: <id>'", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" }) as Response);
    vi.stubGlobal("fetch", fetch);
    const seen = await failure(createUrlDraftStore("https://forms.example/api/drafts").load("missing"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.notFound", message: "Draft not found: missing" });
  });

  it("the web components' server:<url> store: any other failing status stays a plain Error (not a draft verdict)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, statusText: "Server Error" }) as Response));
    const seen = await failure(createUrlDraftStore("https://forms.example/api/drafts").load("d1"));
    expect(seen.error).toBeInstanceOf(Error);
    expect(seen.error).not.toBeInstanceOf(DraftError);
    expect(seen.message).toBe("Loading the draft failed: 500 Server Error");
  });

  it("the compatibility check: draft.incompatible, 'Draft is incompatible: <issues>'", () => {
    let thrown: unknown;
    try {
      assertDraftCompatible(draft({ runtime: { schemaVersion: "2", rendererVersion: "1.0.0" } }), { formVersion: "1", schemaVersion: "1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DraftError);
    expect((thrown as DraftError).code).toBe("draft.incompatible");
    expect((thrown as DraftError).message).toBe("Draft is incompatible: draft schema version 2 is incompatible with runtime schema 1");
    // A compatible draft passes as before.
    expect(() => assertDraftCompatible(draft(), { formVersion: "1", schemaVersion: "1" })).not.toThrow();
  });

  it("the runtime, for a draft of another form: draft.formMismatch, 'Draft form mismatch: <draft> != <form>', nothing restored", async () => {
    const form = runtime();
    form.setValue("name", "Grace");
    const seen = await failure(form.hydrateFromDraft(draft({ formId: "other" })));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen).toMatchObject({ code: "draft.formMismatch", message: "Draft form mismatch: other != f" });
    expect(form.state().values.name).toBe("Grace");
  });

  it("the runtime, for a version its policy refuses: draft.incompatible through the check, nothing restored", async () => {
    const form = runtime(true);
    form.setValue("name", "Grace");
    const seen = await failure(form.hydrateFromDraft(draft({ runtime: { schemaVersion: "9", rendererVersion: "1.0.0" } })));
    expect(seen.error).toBeInstanceOf(DraftError);
    expect(seen.code).toBe("draft.incompatible");
    expect(seen.message).toMatch(/^Draft is incompatible: draft schema version 9 /);
    expect(form.state().values.name).toBe("Grace");
    // And a draft it accepts is brought back.
    await form.hydrateFromDraft(draft());
    expect(form.state().values.name).toBe("Ada");
  });
});
