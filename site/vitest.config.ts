import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Registers the eager journey engine as the runtimes' default; see the file.
    setupFiles: ["./test/setup/journey-engine.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
