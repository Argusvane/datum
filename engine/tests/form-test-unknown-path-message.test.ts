import { describe, expect, it } from "vitest";

import { kernelFormTestMessage } from "../form-engine/core/form-tests/form-test-parse.js";
import { TESTS_EN } from "../form-engine/builder/form-tests/tests-texts-en.js";

/** The sentence of the lint that names a path no field stores: one wording for the kernel and the Tests panel. */
describe("the unknown-path lint's sentence", () => {
  it("the kernel's English is the catalog's, word for word", () => {
    expect(kernelFormTestMessage("tests.set.unknownPath", { path: "items[0].qty" })).toBe(TESTS_EN["tests.lint.unknownPath"]!.replace("{path}", "items[0].qty"));
  });

  it("names the path as written", () => {
    expect(kernelFormTestMessage("tests.set.unknownPath", { path: "nope" })).toBe("No field stores an answer at nope, so the form keeps nothing there; the step still runs.");
  });
});
