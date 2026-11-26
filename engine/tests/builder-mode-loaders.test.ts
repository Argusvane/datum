import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The PDF and Journeys modes as chunks: one load per page, the module handed back
 * synchronously once in, and a failed load tried again on the next call rather than remembered.
 * Each case starts from a fresh module registry so the loaders' memos start empty.
 */

const PDF_MODE = "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
const PDF_LOADER = "../form-engine/builder/pdf-designer/pdf-mode-loader.js";
const JOURNEY_MODE = "../form-engine/builder/journey-designer/journey-builder-mode.js";
const JOURNEY_LOADER = "../form-engine/builder/journey-designer/journey-mode-loader.js";

afterEach(() => {
  vi.doUnmock(PDF_MODE);
  vi.doUnmock(JOURNEY_MODE);
  vi.resetModules();
});

describe("loadPdfBuilderMode", () => {
  it("resolves the mode's module once, then hands it back synchronously", async () => {
    vi.resetModules();
    const loader = (await import(PDF_LOADER)) as typeof import("../form-engine/builder/pdf-designer/pdf-mode-loader.js");
    expect(loader.loadedPdfBuilderMode()).toBeUndefined();
    const first = loader.loadPdfBuilderMode();
    expect(loader.loadPdfBuilderMode()).toBe(first);
    const module = await first;
    expect(typeof module.createPdfBuilderMode).toBe("function");
    expect(module.PDF_BUILDER_MODE).toBe("pdf");
    expect(loader.loadedPdfBuilderMode()).toBe(module);
    await expect(loader.loadPdfBuilderMode()).resolves.toBe(module);
  });

  it("forgets a failed load, so the next call loads again", async () => {
    vi.resetModules();
    vi.doMock(PDF_MODE, () => {
      throw new Error("chunk missing");
    });
    const loader = (await import(PDF_LOADER)) as typeof import("../form-engine/builder/pdf-designer/pdf-mode-loader.js");
    await expect(loader.loadPdfBuilderMode()).rejects.toThrow();
    expect(loader.loadedPdfBuilderMode()).toBeUndefined();
    vi.doUnmock(PDF_MODE);
    const module = await loader.loadPdfBuilderMode();
    expect(typeof module.createPdfBuilderMode).toBe("function");
    expect(loader.loadedPdfBuilderMode()).toBe(module);
  });
});

describe("loadJourneyBuilderMode", () => {
  it("resolves the mode's module once, then hands it back synchronously", async () => {
    vi.resetModules();
    const loader = (await import(JOURNEY_LOADER)) as typeof import("../form-engine/builder/journey-designer/journey-mode-loader.js");
    expect(loader.loadedJourneyBuilderMode()).toBeUndefined();
    const first = loader.loadJourneyBuilderMode();
    expect(loader.loadJourneyBuilderMode()).toBe(first);
    const module = await first;
    expect(typeof module.createJourneyBuilderMode).toBe("function");
    expect(loader.loadedJourneyBuilderMode()).toBe(module);
  });

  it("names the mode without loading it: the module's id is the loader's", async () => {
    vi.resetModules();
    const loader = (await import(JOURNEY_LOADER)) as typeof import("../form-engine/builder/journey-designer/journey-mode-loader.js");
    expect(loader.JOURNEY_BUILDER_MODE).toBe("journeys");
    expect(loader.loadedJourneyBuilderMode()).toBeUndefined();
    const module = await loader.loadJourneyBuilderMode();
    expect(module.JOURNEY_BUILDER_MODE).toBe(loader.JOURNEY_BUILDER_MODE);
  });

  it("forgets a failed load, so the next call loads again", async () => {
    vi.resetModules();
    vi.doMock(JOURNEY_MODE, () => {
      throw new Error("chunk missing");
    });
    const loader = (await import(JOURNEY_LOADER)) as typeof import("../form-engine/builder/journey-designer/journey-mode-loader.js");
    await expect(loader.loadJourneyBuilderMode()).rejects.toThrow();
    expect(loader.loadedJourneyBuilderMode()).toBeUndefined();
    vi.doUnmock(JOURNEY_MODE);
    const module = await loader.loadJourneyBuilderMode();
    expect(typeof module.createJourneyBuilderMode).toBe("function");
  });
});

describe("the builder's exports", () => {
  it("keeps the factories for engine hosts beside the loaders", async () => {
    const builder = await import("../form-engine/builder/index.js");
    expect(typeof builder.createPdfBuilderMode).toBe("function");
    expect(typeof builder.createJourneyBuilderMode).toBe("function");
    expect(typeof builder.loadPdfBuilderMode).toBe("function");
    expect(typeof builder.loadJourneyBuilderMode).toBe("function");
    expect(builder.JOURNEY_BUILDER_MODE).toBe("journeys");
  });
});
