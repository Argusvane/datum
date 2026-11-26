import { join } from "node:path";

import { afterAll, beforeAll, expect, vi } from "vitest";

import { formTests } from "../../src/vitest.js";

// As coverage-bind-fail.check.ts, with the warning: nothing ran, so no untested-rule list is
// printed after the run. The hook below runs after the helper's own afterAll and fails the file
// when a warning went out.
const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
beforeAll(() => {
  warn.mockClear();
});
formTests(join(import.meta.dirname, "fixtures/uncovered.json"), {
  name: "helper project: coverage warn, bind failure",
  coverage: "warn",
  program: join(import.meta.dirname, "fixtures/noop-program.js")
});
afterAll(() => {
  expect(warn.mock.calls.map((call) => call.join(" ")), "no untested-rule warning").toEqual([]);
});
