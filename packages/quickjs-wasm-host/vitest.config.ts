import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Registers the eager journey engine as the runtimes' default; see the file.
    setupFiles: ["./tests/setup/journey-engine.ts"]
  }
});
