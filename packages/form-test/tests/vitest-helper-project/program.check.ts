import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// A program that is not a validation program: the host refuses it when it binds, and every
// scenario of the file fails with that reason instead of vitest showing them as skipped.
formTests(join(import.meta.dirname, "fixtures/main.json"), {
  name: "helper project: program",
  program: join(import.meta.dirname, "fixtures/noop-program.js"),
  sources: ['test "needs the kernel"\n  expect applicant_name visible']
});
