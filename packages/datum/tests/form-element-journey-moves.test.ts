import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/form.js";
import { BrowserLocalDraftStore, type FormDraft } from "@argusvane/datum-engine";
import { createUrlDraftStore } from "../src/draft-store-url.js";
import { control } from "./live-dom.js";
import { branchingJourneyForm, mountForm, onJourneyPage, pickRadio, typeInto, until } from "./helpers.js";

// Journeys in the element and its draft stores: moves, change reporting and draft-store keys.

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const draft = (id: string): FormDraft => ({ id, formId: "f", formVersion: "1", locale: "en", updatedAt: 1, values: {} }) as never;

describe("journeys in the element: moves, change reports and draft stores", () => {
  it("the element offers no 'error' move, so a jump past the frontier stays refused and hooks guard it", async () => {
    const calls: string[] = [];
    const el = mountForm((e) => {
      e.definition = branchingJourneyForm();
      e.plugins = [{ id: "gate", version: "1.0.0", hooks: { beforePageChange: [({ toPageId }: { toPageId: string }) => { calls.push(toPageId); throw new Error("no"); }] } }] as never;
    });
    await onJourneyPage(el, "About you");
    el.runtime!.setValue("resident", "yes");
    await until(() => el.values.resident === "yes");
    // The element's own goToPage takes a page id and nothing else: a direction it is handed is not read.
    const jump = await (el as unknown as { goToPage(page: string, options?: unknown): Promise<{ ok: boolean }> }).goToPage("contact", { direction: "error" });
    expect(jump.ok).toBe(false);
    expect(el.page).toBe("about");
    expect(calls).toEqual([]);
  });

  it("what was typed on a page is reported before the page change is", async () => {
    const saved: any[] = [];
    const store = { async save(d: any) { saved.push(JSON.parse(JSON.stringify(d))); }, async load() { throw new Error("none"); }, async list() { return []; }, async delete() {} };
    const el = mountForm((e) => { e.draftStore = store as never; e.draft = "gj3-draft"; e.definition = branchingJourneyForm(); });
    const order: string[] = [];
    el.addEventListener("datum-change", (e) => order.push("change:" + String((e as CustomEvent).detail.path)));
    el.addEventListener("datum-page-change", (e) => order.push("page:" + String((e as CustomEvent).detail.to ?? (e as CustomEvent).detail.toPageId)));
    let root = await onJourneyPage(el, "About you");
    pickRadio(root, "resident", "yes");
    await until(() => el.values.resident === "yes");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    root = await onJourneyPage(el, "Where you live");
    order.length = 0;
    typeInto(control(root, "province"), "ON");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await onJourneyPage(el, "How to reach you");
    await new Promise((r) => setTimeout(r, 600));
    expect(order.indexOf("change:province")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("change:province")).toBeLessThan(order.findIndex((x) => x.startsWith("page:")));
    expect(saved.some((d) => d.values.province === "ON")).toBe(true);
  });

  it("the server draft store keeps every request one segment under its base", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => { urls.push(`${init?.method ?? "GET"} ${u}`); return new Response("{}", { status: 200 }); }));
    const store = createUrlDraftStore("https://app.example/api/drafts");
    for (const key of ["..", ".", ""]) {
      await expect(store.save(draft(key)), JSON.stringify(key)).rejects.toThrow(/cannot name a draft/);
      await expect(store.delete(key), JSON.stringify(key)).rejects.toThrow(/cannot name a draft/);
      await expect(store.load(key), JSON.stringify(key)).rejects.toThrow(/cannot name a draft/);
    }
    expect(urls).toEqual([]);
    for (const key of ["../x", "%2e%2e", "a/b", "%2E%2E", "plain"]) {
      await store.save(draft(key));
      await store.delete(key);
    }
    const bad = urls.filter((line) => {
      const rest = new URL(line.split(" ")[1] as string).pathname;
      return !rest.startsWith("/api/drafts/") || rest.slice("/api/drafts/".length).includes("/");
    });
    expect(bad).toEqual([]);
  });

  it("the local draft store refuses a key the store keeps for itself, with a typed error", async () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    const store = new BrowserLocalDraftStore(storage, "datum-form:");
    await store.save(draft("real"));
    await store.rebuildIndex(["real"]);
    for (const key of ["__index__", "__other"]) {
      await expect(store.save(draft(key))).rejects.toMatchObject({ code: "draft.reservedKey", name: "ReservedDraftKeyError" });
      await expect(store.load(key)).rejects.toMatchObject({ code: "draft.reservedKey" });
      await expect(store.delete(key)).rejects.toMatchObject({ code: "draft.reservedKey" });
    }
    expect((await store.list()).map((d) => d.id)).toEqual(["real"]);
  });
});
