import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// The `phone` rule has no scenario, so "every rule is tested" fails and the scenario passes.
formTests(join(import.meta.dirname, "fixtures/uncovered.json"), { name: "helper project: coverage", coverage: "fail" });
