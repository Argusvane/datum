import { describe, expect, it, vi } from "vitest";

/*
 * The journey designer's three lazy chunks (flow map, try session, page-only fields) against a
 * file that is not there (absent-code resilience): each real loader rejects, forgets
 * the failure, and imports again on the next call. What fails is the module each loader imports.
 */
const { gone, gate } = vi.hoisted(() => {
  const state = {
    fail: { map: 1, preview: 1, authoring: 1 } as Record<string, number>,
    asked: { map: 0, preview: 0, authoring: 0 } as Record<string, number>
  };
  const gateFor =
    (key: string) =>
    async (importOriginal: () => Promise<unknown>): Promise<unknown> => {
      state.asked[key] = (state.asked[key] ?? 0) + 1;
      if ((state.fail[key] ?? 0) > 0) {
        state.fail[key] = (state.fail[key] ?? 0) - 1;
        throw new Error(`${key}: chunk gone`);
      }
      return importOriginal();
    };
  return { gone: state, gate: gateFor };
});
vi.mock("../../../engine/form-engine/builder/journey-map/journey-map.ts", async (importOriginal) => gate("map")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/journey-designer/journey-preview.ts", async (importOriginal) => gate("preview")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/journey-designer/journey-authoring.ts", async (importOriginal) => gate("authoring")(importOriginal as never) as never);

import { loadJourneyAuthoring, loadJourneyMap, loadJourneyPreview } from "../../../engine/form-engine/builder/journey-designer/journey-designer.js";

describe("the journey designer's lazy chunks", () => {
  const loaders = [
    { name: "flow map", key: "map", load: loadJourneyMap },
    { name: "try session", key: "preview", load: loadJourneyPreview },
    { name: "page-only fields", key: "authoring", load: loadJourneyAuthoring }
  ] as const;
  for (const { name, key, load } of loaders) {
    it(`${name}: a missing chunk rejects, is forgotten, and the next call imports again then keeps it`, async () => {
      await expect(load()).rejects.toThrow();
      expect(gone.asked[key]).toBe(1);
      const module = await load();
      expect(module).toBeTruthy();
      expect(gone.asked[key]).toBe(2);
      // Once per page from here on.
      expect(load()).toBe(load());
      expect(gone.asked[key]).toBe(2);
    });
  }
});
