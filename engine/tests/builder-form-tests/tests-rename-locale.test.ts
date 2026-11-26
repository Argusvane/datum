import { describe, expect, it } from "vitest";

import { renameLocaleInTests, testsNamingLocale } from "../../form-engine/builder/form-tests/tests-rename.js";
import type { FormTestConfiguration } from "../../form-engine/core/form-tests/form-test-types.js";

// A language renamed in the Languages workspace is followed into the scenarios that set it
// with `given locale`, which the driver would otherwise refuse as a language the form lacks.

function tests(...sources: string[]): FormTestConfiguration {
  return { scenarios: sources.map((source, index) => ({ id: `test-${index + 1}`, source })) };
}

const block = (...lines: string[]): string => lines.join("\n");

function renamed(source: string, from: string, to: string): string | undefined {
  return renameLocaleInTests(tests(source), from, to, [])?.scenarios[0]!.source;
}

describe("a renamed language in the scenarios", () => {
  it("rewrites the quoted code of a given locale and nothing else", () => {
    const source = block('test "french"', '  given locale = "fr"', '  set name = "fr"', '  expect name = "fr"');
    expect(renamed(source, "fr", "fr-CA")).toBe(block('test "french"', '  given locale = "fr-CA"', '  set name = "fr"', '  expect name = "fr"'));
  });

  it("keeps single quotes", () => {
    expect(renamed(block('test "t"', "  given locale = 'fr'", "  submit"), "fr", "fr-CA")).toBe(block('test "t"', "  given locale = 'fr-CA'", "  submit"));
  });

  it("leaves a scenario that sets another language, and a comment that mentions the code", () => {
    const source = block('test "t"', "  # given locale = \"fr\"", '  given locale = "de"', "  submit");
    expect(renamed(source, "fr", "fr-CA")).toBeUndefined();
  });

  it("rewrites every scenario that names it and reports no change when none does", () => {
    const next = renameLocaleInTests(tests(block('test "a"', '  given locale = "fr"', "  submit"), block('test "b"', "  submit"), block('test "c"', '  given locale = "fr"', "  submit")), "fr", "fr-CA", []);
    expect(next?.scenarios.map((entry) => entry.source.includes("fr-CA"))).toEqual([true, false, true]);
    expect(renameLocaleInTests(tests(block('test "b"', "  submit")), "fr", "fr-CA", [])).toBeUndefined();
  });

  it("leaves a source that does not parse, and a new code the language could not read back", () => {
    expect(renamed(block('test "t"', '  given locale = "fr"', "  frobnicate"), "fr", "fr-CA")).toBeUndefined();
    expect(renamed(block('test "t"', '  given locale = "fr"', "  submit"), "fr", 'f"r')).toBeUndefined();
  });

  it("counts the scenarios that set a language", () => {
    const block1 = tests(block('test "a"', '  given locale = "fr"', "  submit"), block('test "b"', "  submit"), block('test "c"', '  given locale = "fr"', "  submit"));
    expect(testsNamingLocale(block1, "fr")).toBe(2);
    expect(testsNamingLocale(block1, "de")).toBe(0);
    expect(testsNamingLocale(undefined, "fr")).toBe(0);
  });
});
