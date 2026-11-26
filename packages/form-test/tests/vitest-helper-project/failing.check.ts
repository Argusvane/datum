import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// One `.datum-test` file added through `tests`, whose single scenario is wrong on purpose: the
// parent test reads its failure message out of the child's JSON report. A text added through
// `sources` that does not parse shows the "<source> parses" test.
formTests(join(import.meta.dirname, "fixtures/main.json"), {
  name: "helper project: failing",
  tests: [join(import.meta.dirname, "fixtures/failing.datum-test")],
  sources: ['test "never closed\n  expect applicant_name visible', 'test "half read"\n  expect applicant_name visible\n  this is not a statement']
});
