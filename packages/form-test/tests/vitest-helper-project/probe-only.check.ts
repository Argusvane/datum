import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// A program that answers the bind-time probe but defines no sandbox entry point: the host binds,
// the runtime side passes and the kernel side errors on a step with no scenario reason, and the
// failure must still say why.
formTests(join(import.meta.dirname, "fixtures/main.json"), {
  name: "helper project: probe only",
  program: join(import.meta.dirname, "fixtures/probe-only-program.js"),
  sources: ['test "needs the kernel"\n  expect applicant_name visible']
});
