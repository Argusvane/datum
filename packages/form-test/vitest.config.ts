import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The runtime driver builds FormRuntime instances with journeys and passes the eager journey
    // engine explicitly (src/drivers.ts), so this file names no setup file.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    ...(process.env["CI"] ? { minWorkers: 1, maxWorkers: 2 } : {})
  }
});
