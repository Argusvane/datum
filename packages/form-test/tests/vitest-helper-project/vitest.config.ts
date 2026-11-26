import { defineConfig } from "vitest/config";

// A project inside the package that the helper's own test runs as a child vitest, so the reports
// it reads are the ones a user's project would get. The files end in `.check.ts` rather than
// `.test.ts` so the package's own `vitest run` does not pick up the deliberately failing ones.
export default defineConfig({
  test: {
    include: ["*.check.ts"],
    // Room for every test of a concurrent describe to start at once: concurrent.check.ts needs
    // "every rule is tested" to start before the scenarios finish, which is what it must survive.
    maxConcurrency: 50,
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
});
