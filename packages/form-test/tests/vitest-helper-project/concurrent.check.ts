import { join } from "node:path";

import { describe } from "vitest";

import { formTests } from "../../src/vitest.js";

// Every rule of main.json is tested (the command's --fail-on untested exits 0 on it). Run
// concurrently, with room for every test to start at once (maxConcurrency in this project's
// config), "every rule is tested" must not read the results before the scenarios have finished and
// fail.
describe.concurrent("concurrent", () => {
  formTests(join(import.meta.dirname, "fixtures/main.json"), { name: "helper project: concurrent coverage", coverage: "fail" });
});
