import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import type { DraftStore, FormDefinition, FormDraft } from "@argusvane/datum-engine";
import type { DatumWarningDetail } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * A draft that carries an answer a field cannot hold (an object or a list in a single-valued
 * field) restores the rest and tells the page once, as `datum-warning`, which answers were left
 * out. An accepted submit's `datum-submit` carries the attempt's `submissionKey`, the key the
 * page sends beside the document to the receiving service.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const definition = (): FormDefinition => ({
  id: "d",
  version: "1.0.0",
  schemaVersion: "1",
  root: {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "city", type: "text", configuration: { label: "City" } },
        { id: "go", type: "button", configuration: { label: "Send", action: "submit" } }
      ]
    }
  }
});

function memoryStore(draft: FormDraft): DraftStore {
  return {
    save: async () => undefined,
    load: async () => draft,
    list: async () => [],
    delete: async () => undefined
  };
}

async function mounted(setup?: (el: DatumFormElement) => void): Promise<{ el: DatumFormElement; warnings: DatumWarningDetail[] }> {
  const el = document.createElement("datum-form") as DatumFormElement;
  const warnings: DatumWarningDetail[] = [];
  el.addEventListener("datum-warning", (event) => warnings.push((event as CustomEvent<DatumWarningDetail>).detail));
  setup?.(el);
  el.definition = definition();
  document.body.append(el);
  await el.ready;
  return { el, warnings };
}

describe("restoreDraft with an answer the form cannot hold", () => {
  it("restores the rest, says which were left out as datum-warning, and hands them back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const draft: FormDraft = {
      id: "k",
      formId: "d",
      formVersion: "1.0.0",
      runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
      locale: "en",
      values: { name: { toString: "x" }, city: "Ottawa" } as never,
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
      updatedAt: 7
    };
    const { el, warnings } = await mounted((element) => {
      element.draft = "k";
      element.draftStore = memoryStore(draft);
    });
    const restored = await el.restoreDraft();
    expect(restored.updatedAt).toBe(7);
    expect(restored.dropped).toEqual(["name"]);
    await until(() => el.values.city === "Ottawa");
    expect(el.values.name).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "draft.dropped", count: 1, addresses: ["name"] });
    expect(warnings[0]!.message).toMatch(/1 answer/);
  });

  it("says nothing for a draft restored whole", async () => {
    const draft: FormDraft = {
      id: "k",
      formId: "d",
      formVersion: "1.0.0",
      runtime: { schemaVersion: "1", rendererVersion: "1.0.0" },
      locale: "en",
      values: { name: "Ada", city: "Ottawa" },
      state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
      updatedAt: 3
    };
    const { el, warnings } = await mounted((element) => {
      element.draft = "k";
      element.draftStore = memoryStore(draft);
    });
    const restored = await el.restoreDraft();
    expect(restored.dropped).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("datum-submit's submissionKey", () => {
  it("carries the attempt's key on an accepted submit, a new one per attempt", async () => {
    const { el } = await mounted();
    const heard: DatumFormSubmitDetail[] = [];
    el.addEventListener("datum-submit", (event) => heard.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    el.values = { name: "Ada", city: "Ottawa" };
    const first = await el.submit();
    const second = await el.submit();
    expect(first.accepted).toBe(true);
    expect(first.submissionKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.submissionKey).toBe(first.result.submissionKey);
    expect(second.submissionKey).not.toBe(first.submissionKey);
    expect(heard.map((detail) => detail.submissionKey)).toEqual([first.submissionKey, second.submissionKey]);
  });
});
