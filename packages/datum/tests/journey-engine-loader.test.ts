import { afterEach, describe, expect, it, vi } from "vitest";

import { EagerJourneyEngine, EagerJourneyRenderKit, EagerJourneyReviewKit, createJourneyRenderKit } from "@argusvane/datum-engine";

// The journeys runtime chunk's loader: one memoised load that answers the engine and
// the render kit, forgets a failed import, and rejects as a ChunkLoadError. The failure-path
// cases of the whole absent-code set live in absent-code-journey-engine.test.ts;
// these pin the loader's own contract.

afterEach(() => {
  vi.doUnmock("../src/journey-engine-chunk.js");
  vi.doUnmock("../src/journey-review-chunk.js");
  vi.resetModules();
});

describe("loadJourneyEngine", () => {
  it("answers the eager engine and the render kit with no Check answers kit, and the chunk's sentinel", async () => {
    const { loadJourneyEngine } = await import("../src/journey-engine-loader.js");
    const bundle = await loadJourneyEngine();
    expect(bundle.engine).toBe(EagerJourneyEngine);
    expect(bundle.renderKit).toBe(createJourneyRenderKit());
    expect(bundle.renderKit).not.toBe(EagerJourneyRenderKit);
    expect(bundle.renderKit.id).toBe("datum-journey-render-kit-eager");
    expect(bundle.sentinel).toBe("datum-journey-engine-chunk");
  });

  it("answers, for a definition, the kit with no list unless a journey has a Check answers page, then the kit over the Check answers chunk's", async () => {
    const { loadJourneyEngine } = await import("../src/journey-engine-loader.js");
    const bundle = await loadJourneyEngine();
    const definition = (kind?: "review") => ({
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: { id: "root", type: "form", children: { content: [{ id: "name", type: "text" }] } },
      journey: { journeys: [{ id: "j", pages: [{ id: "a", components: ["name"] }, { id: "b", ...(kind ? { kind } : { components: [] }) }] }] }
    });
    // The module graph was reset by the tests before, so this graph's kits are its own: told apart by behaviour.
    const plain = await bundle.forDefinition(definition() as never);
    expect(plain.engine).toBe(bundle.engine);
    expect(plain.renderKit).toBe(bundle.renderKit);
    expect(plain.renderKit.pageFeature?.().summaryTarget).toBeUndefined();
    const reviewing = await bundle.forDefinition(definition("review") as never);
    expect(reviewing.engine).toBe(bundle.engine);
    // Built over the Check answers chunk's kit: its page module routes summary entries to the rows.
    expect(reviewing.renderKit).not.toBe(bundle.renderKit);
    expect(reviewing.renderKit.id).toBe(EagerJourneyRenderKit.id);
    expect(typeof reviewing.renderKit.pageFeature?.().summaryTarget).toBe("function");
    // One kit per Check answers kit: a second form with one shares it.
    expect((await bundle.forDefinition(definition("review") as never)).renderKit).toBe(reviewing.renderKit);
  });

  it("loads once: every call shares the one promise", async () => {
    const { loadJourneyEngine } = await import("../src/journey-engine-loader.js");
    const first = loadJourneyEngine();
    expect(loadJourneyEngine()).toBe(first);
    await first;
    expect(loadJourneyEngine()).toBe(first);
  });

  it("rejects as a ChunkLoadError naming the journeys runtime, with the browser's error as cause, and asks again next time", async () => {
    const failure = new TypeError("Failed to fetch dynamically imported module");
    vi.resetModules();
    vi.doMock("../src/journey-engine-chunk.js", () => {
      throw failure;
    });
    const { loadJourneyEngine } = await import("../src/journey-engine-loader.js");
    // The graph was reset, so the class to test against is the one this graph loaded.
    const { ChunkLoadError } = await import("../src/chunk-load-error.js");
    const first = loadJourneyEngine();
    await expect(first).rejects.toBeInstanceOf(ChunkLoadError);
    await first.catch((error: InstanceType<typeof ChunkLoadError>) => {
      expect(error.message).toContain("The journeys runtime");
      // Vitest wraps a mock factory's throw, so the cause is the import's own error, whatever its wording.
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.message).toContain((error.cause as Error).message);
    });
    // The rejected promise is not kept: the next call is a new load.
    await Promise.resolve();
    const second = loadJourneyEngine();
    expect(second).not.toBe(first);
    second.catch(() => undefined);
  });
});

describe("loadedJourneyEngine", () => {
  it("is nothing until the chunk has arrived, then the same bundle, read without loading", async () => {
    const { loadJourneyEngine, loadedJourneyEngine } = await import("../src/journey-engine-loader.js");
    expect(loadedJourneyEngine()).toBeUndefined();
    const load = loadJourneyEngine();
    expect(loadedJourneyEngine()).toBeUndefined();
    const bundle = await load;
    expect(loadedJourneyEngine()).toBe(bundle);
  });

  it("stays nothing after a failed load (a failure is not remembered as a bundle)", async () => {
    vi.resetModules();
    vi.doMock("../src/journey-engine-chunk.js", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const { loadJourneyEngine, loadedJourneyEngine } = await import("../src/journey-engine-loader.js");
    await loadJourneyEngine().catch(() => undefined);
    expect(loadedJourneyEngine()).toBeUndefined();
  });
});

// The Check answers chunk's loader, the same contract: answered once, a failure forgotten and
// rejected as a ChunkLoadError naming the Check answers page.
describe("loadJourneyReview", () => {
  it("answers the Check answers kit and the chunk's sentinel, once", async () => {
    const { loadJourneyReview } = await import("../src/journey-review-loader.js");
    const first = loadJourneyReview();
    expect(loadJourneyReview()).toBe(first);
    const bundle = await first;
    // The earlier tests reset the module graph, so the kit is told by its id, not its identity.
    expect(bundle.review.id).toBe(EagerJourneyReviewKit.id);
    expect(typeof bundle.review.view).toBe("function");
    expect(bundle.sentinel).toBe("datum-journey-review-chunk");
    expect(loadJourneyReview()).toBe(first);
  });

  it("rejects as a ChunkLoadError naming the Check answers page, and asks again next time", async () => {
    vi.resetModules();
    vi.doMock("../src/journey-review-chunk.js", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const { loadJourneyReview } = await import("../src/journey-review-loader.js");
    const { ChunkLoadError } = await import("../src/chunk-load-error.js");
    const first = loadJourneyReview();
    await expect(first).rejects.toBeInstanceOf(ChunkLoadError);
    await first.catch((error: Error) => expect(error.message).toContain("The Check answers page"));
    await Promise.resolve();
    const second = loadJourneyReview();
    expect(second).not.toBe(first);
    second.catch(() => undefined);
  });
});
