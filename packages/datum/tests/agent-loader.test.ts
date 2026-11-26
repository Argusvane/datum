import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The agent chunk's loader (resilient to absent code): one import per page,
 * a failed import rejected as a ChunkLoadError naming the agent tools with the import error as
 * its cause, forgotten so the next call asks again, and `loadedAgent()` answering the module once
 * it is there and `undefined` before. The REAL loader runs; what fails is the module it imports
 * (the mock below makes its factory throw, which is how a missing file looks to `import()`).
 */
const chunk = vi.hoisted(() => ({ fail: 0, asked: 0, builderFail: 0, builderAsked: 0 }));
vi.mock("../src/agent.ts", async (importActual) => {
  chunk.asked += 1;
  if (chunk.fail > 0) {
    chunk.fail -= 1;
    throw new Error("agent chunk gone");
  }
  return importActual();
});
vi.mock("../src/builder/agent.ts", async (importActual) => {
  chunk.builderAsked += 1;
  if (chunk.builderFail > 0) {
    chunk.builderFail -= 1;
    throw new Error("builder agent chunk gone");
  }
  return importActual();
});

import { loadAgent, loadBuilderAgent, loadedAgent, loadedBuilderAgent } from "../src/agent-loader.js";
import { ChunkLoadError } from "../src/chunk-load-error.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await settle();
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The import's rejection reached the caller as the cause (vitest words a throwing mock factory its own way, with the original as its cause). */
function causeChain(error: unknown): string {
  const texts: string[] = [];
  for (let at: unknown = error; at instanceof Error && texts.length < 5; at = (at as { cause?: unknown }).cause) {
    texts.push(at.message);
  }
  return texts.join(" | ");
}

describe("loadAgent", () => {
  it("rejects a missing chunk as a ChunkLoadError naming the agent tools, forgets it, and answers the module the next time", async () => {
    chunk.fail = 1;
    expect(loadedAgent()).toBeUndefined();
    const first = loadAgent();
    const error = await first.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toContain("The agent tools (datum-form-agent-*.js / datum-builder-agent-*.js) could not be loaded");
    expect(causeChain((error as ChunkLoadError).cause)).toContain("agent chunk gone");
    expect(loadedAgent()).toBeUndefined();
    expect(chunk.asked).toBe(1);

    const second = loadAgent();
    expect(second).not.toBe(first);
    const module = await second;
    expect(typeof module.attachFormAgent).toBe("function");
    // The builder's attach is the builder chunk's alone (the chunk split per bundle),
    // and so is its catalogue: the form module names the form side only.
    expect("attachBuilderAgent" in module).toBe(false);
    expect("createBuilderTools" in module).toBe(false);
    expect("createControllerHost" in module).toBe(false);
    expect("shellLoaders" in module).toBe(false);
    expect("BUILDER_AGENT_TOOL_NAMES" in module).toBe(false);
    expect("AGENT_EN" in module).toBe(false);
    // Still none of the builder's values, its words included, while the form
    // side gains its two tools.
    expect("agentText" in module).toBe(false);
    expect("agentWords" in module).toBe(false);
    expect("agentPlural" in module).toBe(false);
    expect(module.FORM_AGENT_TOOL_NAMES).toEqual(expect.arrayContaining(["drafts", "download_pdf"]));
    expect(typeof module.createAgentRegistrar).toBe("function");
    expect(chunk.asked).toBe(2);
    expect(loadedAgent()).toBe(module);
    // A cold import of the whole form agent chunk: about 4 s on an idle machine, past vitest's
    // default 5 s once other workers share the CPU.
  }, 30_000);

  it("memoises a landed load: every later call shares the one import", async () => {
    const asked = chunk.asked;
    const again = loadAgent();
    expect(again).toBe(loadAgent());
    expect(await again).toBe(loadedAgent());
    expect(chunk.asked).toBe(asked);
  });
});

describe("loadBuilderAgent", () => {
  it("loads the builder's own chunk: the same ChunkLoadError, forget and memo, no stub catalogue and no renderer catalogue in its module", async () => {
    chunk.builderFail = 1;
    expect(loadedBuilderAgent()).toBeUndefined();
    const error = await loadBuilderAgent().then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toContain("The agent tools (datum-form-agent-*.js / datum-builder-agent-*.js) could not be loaded");
    expect(causeChain((error as ChunkLoadError).cause)).toContain("builder agent chunk gone");
    expect(loadedBuilderAgent()).toBeUndefined();
    expect(chunk.builderAsked).toBe(1);

    const module = await loadBuilderAgent();
    expect(typeof module.attachBuilderAgent).toBe("function");
    // The stub is gone: the chunk registers the builder's own catalogue.
    expect("stubBuilderCatalogue" in module).toBe(false);
    expect("attachFormAgent" in module).toBe(false);
    expect("createFormAgentTools" in module).toBe(false);
    expect(chunk.builderAsked).toBe(2);
    expect(loadedBuilderAgent()).toBe(module);
    expect(loadBuilderAgent()).toBe(loadBuilderAgent());
    // A cold import of the builder agent chunk, as above.
  }, 30_000);
});

describe("loadAgent in the builder bundle", () => {
  /**
   * The loader as `vite build --mode builder` makes it: vite replaces the `import.meta.env` read
   * with the build's mode. vitest fixes `import.meta.env.MODE` to "test" (an object literal per
   * module, which `vi.stubEnv` does not reach), so the test builds that variant itself: a copy of
   * the real source with the mode read replaced by "builder" and its relative imports pointed at
   * the same src modules (the mocks above still apply to them).
   */
  const MODE_READ = "(import.meta as unknown as { env?: { MODE?: string } }).env?.MODE";
  let copyDir: string | undefined;

  afterEach(() => {
    if (copyDir !== undefined) {
      rmSync(copyDir, { recursive: true, force: true });
      copyDir = undefined;
    }
  });

  async function builderBundleLoader(): Promise<typeof import("../src/agent-loader.js")> {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const source = readFileSync(join(src, "agent-loader.ts"), "utf8");
    // The read the build replaces, spelled once: a change to it must change this test too.
    expect(source.split(MODE_READ)).toHaveLength(2);
    const built = source.replace(MODE_READ, JSON.stringify("builder")).replace(/(["'])\.\//g, `$1${src}/`);
    // Inside the package, not the OS temp folder: under jsdom vitest serves only files its
    // workspace allows (vite's fs.allow). Removed after the test.
    copyDir = mkdtempSync(join(src, "../tests/.agent-loader-builder-"));
    const file = join(copyDir, "agent-loader.ts");
    writeFileSync(file, built);
    return (await import(/* @vite-ignore */ file)) as typeof import("../src/agent-loader.js");
  }

  it("rejects with BUILDER_BUNDLE_FORM_AGENT_MESSAGE on every call, imports nothing, and leaves loadBuilderAgent working", async () => {
    const loader = await builderBundleLoader();
    const asked = chunk.asked;
    const builderAsked = chunk.builderAsked;

    const first = loader.loadAgent();
    const second = loader.loadAgent();
    // A fresh rejection per call, never a memoised one: asking again answers the same.
    expect(second).not.toBe(first);
    for (const call of [first, second]) {
      const error = await call.then(
        () => undefined,
        (reason: unknown) => reason
      );
      // A plain Error, not a ChunkLoadError: nothing failed to load.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChunkLoadError);
      expect((error as Error).message).toBe(loader.BUILDER_BUNDLE_FORM_AGENT_MESSAGE);
    }
    expect(chunk.asked).toBe(asked);
    expect(loader.loadedAgent()).toBeUndefined();

    const builder = await loader.loadBuilderAgent();
    expect(typeof builder.attachBuilderAgent).toBe("function");
    expect(loader.loadedBuilderAgent()).toBe(builder);
    expect(chunk.builderAsked).toBeGreaterThanOrEqual(builderAsked);
    expect(chunk.asked).toBe(asked);
  });
});
