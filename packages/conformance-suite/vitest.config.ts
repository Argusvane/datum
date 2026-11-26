import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Registers the eager journey engine as the runtimes' default; see the file.
    setupFiles: ["./tests/setup/journey-engine.ts"],
    // A suite run starts several QuickJS sandboxes; the default 5 s is tight on a loaded machine.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // On a CI runner two workers: the tests start QuickJS sandboxes and spawn the bundled command, and a
    // runner with every core busy starves vitest's own heartbeat.
    ...(process.env["CI"] ? { minWorkers: 1, maxWorkers: 2 } : {})
  }
});
