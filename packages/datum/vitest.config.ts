import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // A fast path for plain selectors, which jsdom's general matcher answers slowly; see the file.
    setupFiles: ["./tests/setup/fast-selectors.ts"],
    // A <datum-form-builder> mount costs about 2 s of CPU under jsdom (slot assignment and selector
    // matching), and vitest 5 holds a test to its timeout by the clock; cases that mount two or three
    // builders ran 4-9 s on an eight-core machine under load. 20 s keeps a hang visible and a slow
    // runner green.
    testTimeout: 20_000
  }
});
