import "../src/builder.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatumFormBuilderElement } from "../src/builder.js";
import { sampleDefinition, until } from "./helpers.js";

const B = "../../../engine/form-engine/builder";

afterEach(() => {
  document.body.innerHTML = "";
  vi.doUnmock(`${B}/palette/command-palette.js`);
  vi.doUnmock(`${B}/web-component/json-viewer.js`);
  vi.resetModules();
});

async function mount(max?: number): Promise<DatumFormBuilderElement> {
  const definition = sampleDefinition();
  if (max !== undefined) {
    (definition.root.children!.content![0]!.configuration as Record<string, unknown>).maxLength = max;
  }
  const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  el.setAttribute("pdf", "off");
  el.definition = definition;
  document.body.append(el);
  await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return el;
}

async function select(el: DatumFormBuilderElement, id: string): Promise<ShadowRoot> {
  el.controller!.select(id);
  const inspector = (): ShadowRoot => el.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
  await until(() => inspector().querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
  return inspector();
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

describe("the number box in the inspector (a cleared or half-typed box is unset, never 0)", () => {
  it("keeps what was typed after the draft round-trip", async () => {
    const el = await mount(20);
    try {
      const root = await select(el, "fullName");
      const input = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[data-prop="maxLength"]')!;
      input().focus();
      for (const typed of ["007", "0.10", "1.50", "-3"]) {
        typeInto(input(), typed);
        await new Promise((r) => setTimeout(r, 30));
        expect(input().value).toBe(typed);
      }
    } finally {
      el.remove();
    }
  });

  it("a cleared or half-typed box drafts no value, not 0", async () => {
    const el = await mount(20);
    try {
      const root = await select(el, "fullName");
      const input = root.querySelector<HTMLInputElement>('input[data-prop="maxLength"]')!;
      input.focus();
      typeInto(input, "5");
      expect(el.controller!.draftProperty("fullName", "maxLength")).toBe(5);
      // A browser reports "" for "-", "1e" and "1.": simulated as "".
      typeInto(input, "");
      expect(el.controller!.draftProperty("fullName", "maxLength")).toBeUndefined();
    } finally {
      el.remove();
    }
  });

  it("clearing the box and committing removes the limit instead of storing 0", async () => {
    const el = await mount(20);
    try {
      const root = await select(el, "fullName");
      typeInto(root.querySelector<HTMLInputElement>('input[data-prop="maxLength"]')!, "");
      expect(el.controller!.commitDraft("fullName")).toBe(true);
      const node = el.controller!.snapshot().children!.content!.find((n) => n.id === "fullName")!;
      expect((node.configuration as Record<string, unknown>).maxLength).toBeUndefined();
    } finally {
      el.remove();
    }
  });
});

describe("lazy chunk failures in the builder", () => {
  it("the JSON viewer loader forgets a failed load, so the next call imports again", async () => {
    vi.resetModules();
    vi.doMock(`${B}/web-component/json-viewer.js`, () => {
      throw new Error("chunk missing");
    });
    const { loadJsonViewer } = await import("../../../engine/form-engine/builder/web-component/json-viewer-loader.js");
    await expect(loadJsonViewer()).rejects.toThrow();
    vi.doUnmock(`${B}/web-component/json-viewer.js`);
    await new Promise((r) => setTimeout(r, 50));
    await expect(loadJsonViewer()).resolves.toBeDefined();
  }, 60_000);

  it("a palette chunk that fails to load is reported as datum-error and openPalette resolves", async () => {
    vi.doMock(`${B}/palette/command-palette.js`, () => {
      throw new Error("chunk missing");
    });
    const el = await mount();
    try {
      const errors: unknown[] = [];
      el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
      await expect(el.builder!.openPalette()).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0])).toContain("command palette");
    } finally {
      el.remove();
    }
  });
});

describe("element.dirty and an open draft", () => {
  it("a pending inspector draft makes dirty true, and committing or discarding it clears it", async () => {
    const el = await mount();
    try {
      await select(el, "fullName");
      el.markSaved();
      expect(el.dirty).toBe(false);
      const events: boolean[] = [];
      el.addEventListener("datum-builder-dirty-change", (event) => events.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));
      el.controller!.setDraftProperty("fullName", "label", "Pending");
      expect(JSON.stringify(el.definition)).not.toContain("Pending");
      expect(el.hasUnsavedChanges()).toBe(true);
      expect(el.dirty).toBe(true);
      expect(events).toEqual([true]);
      el.controller!.discardDraft("fullName");
      expect(el.hasUnsavedChanges()).toBe(false);
      expect(el.dirty).toBe(false);
    } finally {
      el.remove();
    }
  });
});
