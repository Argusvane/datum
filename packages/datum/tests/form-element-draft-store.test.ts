import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { DraftStore, FormDraft, FormDefinition } from "@argusvane/datum-engine";

import { createUrlDraftStore, parseDraftStoreSpec } from "../src/draft-store-url.js";
import { sampleDefinition, until } from "./helpers.js";
import { control } from "./live-dom.js";

/*
 * The `draft-store` attribute: "server:<url>" keeps the `draft` key's draft on the page's
 * own service over four requests; "local" is the browser's storage; an assigned `draftStore` object
 * wins over both; a word it cannot read is reported and drafts stay in the browser as without it.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function plainDefinition(): FormDefinition {
  const sample = sampleDefinition();
  const content = (sample.root.children?.content ?? []).filter((node) => node.id !== "country");
  return { ...sample, root: { ...sample.root, children: { content } } };
}

function mount(attributes: Record<string, string>, setup?: (element: DatumFormElement) => void) {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: string[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail.message));
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  setup?.(element);
  element.definition = plainDefinition();
  document.body.append(element);
  return { element, errors };
}

async function painted(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return element.renderer!.shadowRoot!;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

interface Call {
  method: string;
  url: string;
  body?: FormDraft;
}

/** A fetch that is a tiny draft service: PUT stores, GET reads or 404s, DELETE removes, GET of the collection lists. */
function stubService(): { calls: Call[]; drafts: Map<string, FormDraft> } {
  const calls: Call[] = [];
  const drafts = new Map<string, FormDraft>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as FormDraft) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      if (method === "PUT" && body) {
        drafts.set(id, body);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        drafts.delete(id);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/drafts")) {
        return new Response(JSON.stringify([...drafts.values()].map(({ id: draftId, formId, formVersion, locale, updatedAt }) => ({ id: draftId, formId, formVersion, locale, updatedAt }))), { status: 200 });
      }
      const found = drafts.get(id);
      return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response("missing", { status: 404, statusText: "Not Found" });
    })
  );
  return { calls, drafts };
}

describe("parseDraftStoreSpec", () => {
  it("reads server:<url> against the page and local, and refuses anything else", () => {
    expect(parseDraftStoreSpec("server:/api/drafts")).toEqual({ kind: "server", url: new URL("/api/drafts", document.baseURI).href });
    expect(parseDraftStoreSpec("  server: https://example.test/d ")).toEqual({ kind: "server", url: "https://example.test/d" });
    expect(parseDraftStoreSpec("local")).toEqual({ kind: "local" });
    expect(() => parseDraftStoreSpec("server:")).toThrow(/server:<url>/);
    expect(() => parseDraftStoreSpec("indexeddb")).toThrow(/"server:<url>" or "local"/);
  });
});

describe("createUrlDraftStore", () => {
  const draft = (id: string, updatedAt: number): FormDraft =>
    ({ id, formId: "f", formVersion: "1", runtime: { schemaVersion: "1", rendererVersion: "1" }, locale: "en", values: {}, state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] }, updatedAt });

  it("saves with PUT, loads with GET (a 404 is not found), lists newest first, deletes with DELETE (a 404 is fine)", async () => {
    const { calls, drafts } = stubService();
    const store = createUrlDraftStore("https://example.test/api/drafts/");
    await store.save(draft("a b", 1));
    await store.save(draft("c", 5));
    expect(calls[0]).toMatchObject({ method: "PUT", url: "https://example.test/api/drafts/a%20b" });
    expect(calls[0]?.body?.id).toBe("a b");
    expect((await store.load("c")).updatedAt).toBe(5);
    await expect(store.load("nope")).rejects.toThrow("Draft not found: nope");
    drafts.clear();
    await expect(store.delete("gone")).resolves.toBeUndefined();
  });

  it("puts the id on the path and keeps the base's query, for relative and absolute bases", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      })
    );
    const page = (path: string) => new URL(path, document.baseURI).href;
    const query = createUrlDraftStore(page("/api/drafts?form=a"));
    await query.save(draft("k1", 1));
    await query.list();
    await query.save(draft("a/b c", 1));
    const absolute = createUrlDraftStore("https://x.test/base/?t=1#h");
    await absolute.load("x y");
    await absolute.list();
    const relative = createUrlDraftStore(parseDraftStoreSpec("server:api/drafts?form=a").kind === "server" ? (parseDraftStoreSpec("server:api/drafts?form=a") as { url: string }).url : "");
    await relative.delete("z/1");
    expect(urls).toEqual([
      page("/api/drafts/k1?form=a"),
      page("/api/drafts?form=a"),
      page("/api/drafts/a%2Fb%20c?form=a"),
      "https://x.test/base/x%20y?t=1#h",
      "https://x.test/base?t=1#h",
      new URL("api/drafts/z%2F1?form=a", document.baseURI).href
    ]);
  });

  it("lists newest first and fails with the status on anything else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/d")
          ? new Response(JSON.stringify([{ id: "old", updatedAt: 1 }, { id: "new", updatedAt: 9 }]), { status: 200 })
          : new Response("boom", { status: 500, statusText: "Server Error" })
      )
    );
    const store = createUrlDraftStore("https://example.test/d");
    expect((await store.list()).map((entry) => entry.id)).toEqual(["new", "old"]);
    await expect(createUrlDraftStore("https://example.test/x").save(draft("a", 1))).rejects.toThrow("Saving the draft failed: 500 Server Error");
  });
});

describe("<datum-form draft-store>", () => {
  it("keeps the draft on the service the attribute names: autosave, hasDraft, restore and clear", async () => {
    const { calls, drafts } = stubService();
    const { element } = mount({ draft: "k1", "draft-store": "server:/api/drafts" });
    const root = await painted(element);
    expect(await element.hasDraft()).toBe(false);
    type(control(root, "fullName")!, "Grace");
    await until(() => drafts.has("k1"));
    expect(drafts.get("k1")?.values.fullName).toBe("Grace");
    expect(calls.find((call) => call.method === "PUT")?.url).toBe(new URL("/api/drafts/k1", document.baseURI).href);
    expect(await element.hasDraft()).toBe(true);
    await element.clearDraft();
    expect(drafts.has("k1")).toBe(false);

    // A fresh element restores what the service holds.
    drafts.set("k2", { id: "k2", formId: "sample-form", formVersion: "2.0.0", runtime: { schemaVersion: "1", rendererVersion: "1.0.0" }, locale: "en", values: { fullName: "Ada" }, state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] }, updatedAt: 1 });
    const again = mount({ draft: "k2", "draft-store": "server:/api/drafts" });
    await painted(again.element);
    await again.element.restoreDraft();
    await until(() => again.element.values.fullName === "Ada");
  });

  it("an assigned draftStore object wins over the attribute", async () => {
    const { calls } = stubService();
    const saved: string[] = [];
    const store: DraftStore = {
      save: async (draft) => void saved.push(draft.id),
      load: async () => {
        throw new Error("none");
      },
      list: async () => [],
      delete: async () => undefined
    };
    const { element } = mount({ draft: "own", "draft-store": "server:/api/drafts" }, (el) => {
      el.draftStore = store;
    });
    const root = await painted(element);
    type(control(root, "fullName")!, "Grace");
    await until(() => saved.includes("own"));
    expect(calls).toEqual([]);
  });

  it("local is the browser's storage, and a word it cannot read is reported and leaves drafts in the browser", async () => {
    const { calls } = stubService();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const local = mount({ draft: "k3", "draft-store": "local" });
    await painted(local.element);
    expect(local.errors).toEqual([]);
    const bad = mount({ draft: "k4", "draft-store": "ftp://nope" });
    await painted(bad.element);
    expect(bad.errors).toEqual(['draft-store must be "server:<url>" or "local", not "ftp://nope"']);
    expect(calls).toEqual([]);
  });

  it("an unreadable value clears the earlier server: drafts no longer go to the old service", async () => {
    const { calls, drafts } = stubService();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element, errors } = mount({ draft: "k6", "draft-store": "server:/api/drafts" });
    const root = await painted(element);
    element.setAttribute("draft-store", "ftp://nope");
    await until(() => errors.length > 0);
    expect(errors[0]).toMatch(/draft-store must be/);
    type(control(root, "fullName")!, "Grace");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
    expect(drafts.size).toBe(0);
  });

  it("is ignored when the features list leaves drafts out: no request is made", async () => {
    const { calls } = stubService();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { element } = mount({ draft: "k5", "draft-store": "server:/api/drafts", features: "minimal" });
    const root = await painted(element);
    type(control(root, "fullName")!, "Grace");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls).toEqual([]);
    await expect(element.hasDraft()).rejects.toThrow(/"drafts"/);
  });
});
