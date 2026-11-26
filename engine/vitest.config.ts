import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Registers the eager journey engine as the runtimes' default; see the file.
    setupFiles: ["./tests/setup/journey-engine.ts"],
    // The default 5 s is tight for the jsdom builder tests and the large-form ones when the
    // suite runs on all cores of a busy or small machine, and which file times out then differs
    // from run to run. A test that really hangs still fails, only later.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
