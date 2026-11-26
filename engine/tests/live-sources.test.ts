// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataSourceSet } from "../form-engine/core/schema/contracts.js";
import type { FieldState } from "../form-engine/render/live/contract.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { createSourcesFeature, sourceNoteIdOf } from "../form-engine/render/live/sources.js";
import { cleanUp, definitionOf, mounted, settled, wrapper } from "./live-extras-kit.js";

/*
 * A choice field's data source, said where the person is looking (render/live/sources.ts):
 * a status line while loading, the reason under a failed source (which also describes the
 * control), how many of a cut list are shown, and one `datum-error` per failure for the host.
 */

afterEach(cleanUp);

const definition = () => definitionOf([{ id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } }]);

function sourcesOf(load: DataSourceSet["load"]): DataSourceSet {
  return { has: (id) => id === "cities", ids: () => ["cities"], load };
}

const note = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("[data-source-note]");

describe("live sources", () => {
  it("says nothing for a source that answered plainly", async () => {
    const { root } = await mounted(definition(), {
      dataSources: sourcesOf(async () => ({ items: [{ value: "a", label: "A" }] })),
      features: [createSourcesFeature()]
    });
    expect(note(root)).toBeNull();
    expect(wrapper(root, "city").hasAttribute("data-source")).toBe(false);
    expect(wrapper(root, "city").hasAttribute("aria-busy")).toBe(false);
  });

  it("gives a failed source's reason under the field and describes the control by it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root } = await mounted(definition(), { dataSources: sourcesOf(async () => Promise.reject(new Error("down"))), features: [createSourcesFeature()] });
    const line = note(root) as HTMLElement;
    expect(line.id).toBe(sourceNoteIdOf("city"));
    expect(line.textContent).toBe("The choices could not be loaded.");
    expect(line.hasAttribute("data-source-error")).toBe(true);
    expect(wrapper(root, "city").getAttribute("data-source")).toBe("error");
    expect(wrapper(root, "city").querySelector("select")?.getAttribute("aria-describedby")).toBe("city__source-note");
    // The raw reason is the host's, never the person's.
    expect(root.textContent).not.toContain("down");
  });

  it("reports the failure to the host exactly once with the source, the component and the reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const heard: Array<Record<string, unknown>> = [];
    const host = document.createElement("div");
    host.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<Record<string, unknown>>).detail));
    document.body.append(host);
    const m = await mounted(definition(), { host, dataSources: sourcesOf(async () => Promise.reject(new Error("down"))), features: [createSourcesFeature()] });
    m.runtime.setValue("note", "x");
    await settled(m.form);
    expect(heard).toEqual([{ code: "data-source.failed", message: "down", sourceId: "cities", componentId: "city" }]);
  });

  it("says how many of a list cut to the cap are shown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = Array.from({ length: 5001 }, (_, index) => ({ value: String(index), label: `City ${index}` }));
    const { root } = await mounted(definition(), { dataSources: sourcesOf(async () => ({ items })), features: [createSourcesFeature()] });
    expect(note(root)?.textContent).toBe("Showing the first 5000 of 5001 choices.");
    expect(wrapper(root, "city").getAttribute("data-source")).toBe("truncated");
    // A cut list is no failure: the control is not described by the note.
    expect(wrapper(root, "city").querySelector("select")?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows a status line and marks the field busy while the choices have not arrived", async () => {
    const loading: LiveFeature = { id: "loading", fieldState: (state: FieldState) => (state.componentId === "city" ? { ...state, source: "loading" as const } : undefined) };
    const { root } = await mounted(definition(), { features: [loading, createSourcesFeature()] });
    const line = note(root) as HTMLElement;
    expect(line.textContent).toBe("Loading the choices…");
    expect(line.getAttribute("role")).toBe("status");
    expect(wrapper(root, "city").getAttribute("aria-busy")).toBe("true");
    expect(wrapper(root, "city").getAttribute("data-source")).toBe("loading");
  });

  it("draws the note inside the field's wrapper, after the adapter's drawing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root } = await mounted(definition(), { dataSources: sourcesOf(async () => Promise.reject(new Error("down"))), features: [createSourcesFeature()] });
    const box = wrapper(root, "city");
    expect(note(root)?.parentElement).toBe(box);
    expect(box.lastElementChild).toBe(note(root));
  });
});
