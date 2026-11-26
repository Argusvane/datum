import { describe, expect, it } from "vitest";

import {
  PANEL_MEMORY_VERSION,
  PROPS_MAX,
  REMEMBERED_PANEL_IDS,
  SIDE_MAX,
  SIDE_MIN,
  clearPanelMemory,
  panelMemoryKey,
  panelMemoryStore,
  readPanelMemory,
  writePanelMemory,
  type PanelMemoryStore
} from "../form-engine/builder/web-component/panel-memory.js";

function memoryStore(): PanelMemoryStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    }
  };
}

describe("panel memory", () => {
  it("round-trips the open panel, the widths and the inspector's fold under a key of its own", () => {
    const store = memoryStore();
    writePanelMemory("intake", { panel: "outline", sideWidth: 300, propsWidth: 420, propsCollapsed: true }, store);
    expect([...store.entries.keys()]).toEqual([panelMemoryKey("intake")]);
    expect(JSON.parse(store.entries.get(panelMemoryKey("intake"))!)).toEqual({
      v: PANEL_MEMORY_VERSION,
      panel: "outline",
      sideWidth: 300,
      propsWidth: 420,
      propsCollapsed: true
    });
    expect(readPanelMemory("intake", store)).toEqual({ panel: "outline", sideWidth: 300, propsWidth: 420, propsCollapsed: true });
    // Another key is another layout.
    expect(readPanelMemory("other", store)).toBeUndefined();
    clearPanelMemory("intake", store);
    expect(readPanelMemory("intake", store)).toBeUndefined();
  });

  it("reads back a record naming any of the strip's nine panels, with its widths", () => {
    expect([...REMEMBERED_PANEL_IDS]).toEqual(["form", "chrome", "components", "fields", "outline", "variables", "tests", "view", "settings"]);
    for (const panel of REMEMBERED_PANEL_IDS) {
      const store = memoryStore();
      writePanelMemory("k", { panel, sideWidth: 400, propsWidth: 420, propsCollapsed: true }, store);
      expect(readPanelMemory("k", store), panel).toEqual({ panel, sideWidth: 400, propsWidth: 420, propsCollapsed: true });
    }
  });

  it("leaves widths out until they were dragged, and clamps what it reads and writes to the columns' limits", () => {
    const store = memoryStore();
    writePanelMemory("k", { panel: null, propsCollapsed: false }, store);
    expect(readPanelMemory("k", store)).toEqual({ panel: null, propsCollapsed: false });
    writePanelMemory("k", { panel: "components", sideWidth: 20, propsWidth: 9000, propsCollapsed: false }, store);
    expect(readPanelMemory("k", store)).toEqual({ panel: "components", sideWidth: SIDE_MIN, propsWidth: PROPS_MAX, propsCollapsed: false });
    store.setItem(panelMemoryKey("k"), JSON.stringify({ v: PANEL_MEMORY_VERSION, panel: "outline", sideWidth: 1e9, propsWidth: "wide", propsCollapsed: "yes" }));
    expect(readPanelMemory("k", store)).toEqual({ panel: "outline", sideWidth: SIDE_MAX, propsCollapsed: false });
  });

  it("treats a record it cannot trust as absent: garbage, another version, an unknown panel, a store that throws", () => {
    const store = memoryStore();
    store.setItem(panelMemoryKey("k"), "{not json");
    expect(readPanelMemory("k", store)).toBeUndefined();
    store.setItem(panelMemoryKey("k"), JSON.stringify({ v: PANEL_MEMORY_VERSION + 1, panel: "outline", propsCollapsed: false }));
    expect(readPanelMemory("k", store)).toBeUndefined();
    store.setItem(panelMemoryKey("k"), JSON.stringify({ v: PANEL_MEMORY_VERSION, panel: "layers", propsCollapsed: false }));
    expect(readPanelMemory("k", store)).toBeUndefined();
    store.setItem(panelMemoryKey("k"), JSON.stringify(["outline"]));
    expect(readPanelMemory("k", store)).toBeUndefined();
    const broken: PanelMemoryStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      }
    };
    expect(readPanelMemory("k", broken)).toBeUndefined();
    expect(() => writePanelMemory("k", { panel: null, propsCollapsed: true }, broken)).not.toThrow();
    expect(() => clearPanelMemory("k", broken)).not.toThrow();
  });

  it("finds a store to remember into on any page: localStorage when a probe write works, else one for this page load", () => {
    const store = panelMemoryStore();
    expect(panelMemoryStore()).toBe(store);
    writePanelMemory("probe", { panel: "outline", propsCollapsed: true }, store);
    expect(readPanelMemory("probe", store)).toEqual({ panel: "outline", propsCollapsed: true });
    clearPanelMemory("probe", store);
    expect(readPanelMemory("probe", store)).toBeUndefined();
  });
});
