import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// The program is refused at bind, so no scenario ran: "every rule is tested" must say that, not
// list the rules as untested.
formTests(join(import.meta.dirname, "fixtures/uncovered.json"), {
  name: "helper project: coverage fail, bind failure",
  coverage: "fail",
  program: join(import.meta.dirname, "fixtures/noop-program.js")
});
