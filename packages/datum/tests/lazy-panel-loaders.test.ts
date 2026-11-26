import { describe, expect, it, vi } from "vitest";

/*
 * The lazy panels' loaders against a chunk that does not load: the import's
 * rejection reaches the caller, nothing is remembered, and the next call imports again.
 */
const state = vi.hoisted(() => ({ chromeFails: true, variablesFails: true }));

vi.mock("../../../engine/form-engine/builder/web-component/builder-chrome-panel.js", async (importOriginal) => {
  if (state.chromeFails) {
    throw new Error("offline");
  }
  return importOriginal();
});

vi.mock("../../../engine/form-engine/builder/web-component/builder-variables-panel.js", async (importOriginal) => {
  if (state.variablesFails) {
    throw new Error("offline");
  }
  return importOriginal();
});

import { chromePanelLoaded, loadChromePanel } from "../../../engine/form-engine/builder/web-component/chrome-panel-loader.js";
import { loadVariablesPanel, variablesPanelLoaded } from "../../../engine/form-engine/builder/web-component/variables-panel-loader.js";

describe("the lazy panels' loaders", () => {
  it("forgets a failed Header & footer load, so the next call imports again, then keeps the module", async () => {
    await expect(loadChromePanel()).rejects.toThrow();
    expect(chromePanelLoaded()).toBeUndefined();
    state.chromeFails = false;
    const module = await loadChromePanel();
    expect(module.DATUM_BUILDER_CHROME_PANEL_TAG).toBe("datum-builder-chrome-panel");
    expect(chromePanelLoaded()).toBe(module);
    // Once per page: the same promise from here on.
    expect(loadChromePanel()).toBe(loadChromePanel());
  });

  it("forgets a failed Variables load, so the next call imports again, then keeps the module", async () => {
    await expect(loadVariablesPanel()).rejects.toThrow();
    expect(variablesPanelLoaded()).toBeUndefined();
    state.variablesFails = false;
    const module = await loadVariablesPanel();
    expect(module.DATUM_BUILDER_VARIABLES_PANEL_TAG).toBe("datum-builder-variables-panel");
    expect(variablesPanelLoaded()).toBe(module);
    expect(loadVariablesPanel()).toBe(loadVariablesPanel());
  });
});
