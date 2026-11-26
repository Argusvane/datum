import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// A name used by two sources: the command fails the run (a `duplicateName` problem), so the
// helper must too. Both scenarios still run.
formTests(join(import.meta.dirname, "fixtures/main.json"), {
  name: "helper project: repeats",
  sources: ['test "twice"\n  expect applicant_name visible', 'test "twice"\n  expect applicant_name required']
});
