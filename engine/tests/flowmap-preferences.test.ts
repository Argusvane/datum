import { describe, expect, it } from "vitest";

import {
  JOURNEY_MAP_PREFERENCES_PREFIX,
  normalizeJourneyMapLayout,
  readJourneyMapLayout,
  writeJourneyMapLayout
} from "../form-engine/builder/journey-map/journey-map-preferences.js";
import { normalizeJourneyMapLayout as fromModel } from "../form-engine/builder/journey-map/journey-map-model.js";
import type { PanelMemoryStore } from "../form-engine/builder/web-component/panel-memory.js";

/**
 * The flow map's layout as a viewer's preference: kept beside the shell's panels
 * under `datum-builder:journey-map:<persist-panels key>`, read strictly, never the definition's.
 */

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

describe("the flow map's layout preference", () => {
  it("round-trips a layout under its own key beside the panels'", () => {
    const store = memoryStore();
    expect(readJourneyMapLayout("studio", store)).toBeUndefined();
    writeJourneyMapLayout("studio", { direction: "right" }, store);
    expect([...store.entries.keys()]).toEqual([`${JOURNEY_MAP_PREFERENCES_PREFIX}studio`]);
    expect(JOURNEY_MAP_PREFERENCES_PREFIX).toBe("datum-builder:journey-map:");
    expect(JSON.parse(store.entries.get("datum-builder:journey-map:studio")!)).toEqual({ version: 1, direction: "right" });
    expect(readJourneyMapLayout("studio", store)).toEqual({ direction: "right" });
    // Another key is another viewer's layout.
    expect(readJourneyMapLayout("other", store)).toBeUndefined();
    // A record written while the map had an arrangement as well keeps its direction.
    store.entries.set(`${JOURNEY_MAP_PREFERENCES_PREFIX}older`, JSON.stringify({ version: 1, direction: "right", arrange: "list" }));
    expect(readJourneyMapLayout("older", store)).toEqual({ direction: "right" });
  });

  it("reads a record that is not exactly a layout of this version as none", () => {
    const store = memoryStore();
    const key = `${JOURNEY_MAP_PREFERENCES_PREFIX}k`;
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ version: 2, direction: "right" }),
      JSON.stringify({ direction: "right" }),
      JSON.stringify({ version: 1, direction: "up" }),
      JSON.stringify({ version: 1, direction: 3 }),
      JSON.stringify({ version: 1 })
    ]) {
      store.entries.set(key, raw);
      expect(readJourneyMapLayout("k", store), raw).toBeUndefined();
    }
  });

  it("keeps nothing, and throws nothing, where the store refuses", () => {
    const refusing: PanelMemoryStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => undefined
    };
    expect(() => writeJourneyMapLayout("k", { direction: "down" }, refusing)).not.toThrow();
    expect(readJourneyMapLayout("k", refusing)).toBeUndefined();
  });

  it("normalises anything else to the default, and is the model's own normaliser", () => {
    expect(normalizeJourneyMapLayout(undefined)).toEqual({ direction: "down" });
    expect(normalizeJourneyMapLayout({ direction: "right" })).toEqual({ direction: "right" });
    // An arrangement is no longer the map's to choose: it is dropped.
    expect(normalizeJourneyMapLayout({ direction: "right", arrange: "list" })).toEqual({ direction: "right" });
    expect(fromModel).toBe(normalizeJourneyMapLayout);
  });
});
