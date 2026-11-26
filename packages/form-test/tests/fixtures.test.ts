import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fixtureFiles } from "./helpers/fixture-files.js";
import { FIXTURES, fixture } from "./helpers/paths.js";

// fixtures/ is written from the engine's form-tests corpus (`npm run fixtures:write`); this keeps the
// files on disk the ones the corpus makes today, so the CI job's two calls run what the engine pins.
describe("the package's fixture files", () => {
  const expected = fixtureFiles();

  it.each(Object.keys(expected))("%s is current (npm run fixtures:write)", (name) => {
    expect(readFileSync(fixture(name), "utf8")).toBe(expected[name]);
  });

  it("holds no file the writer does not make", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(expected).sort());
  });

  it("keeps the deliberate failure out of the passing forms", () => {
    const main = JSON.parse(expected["main.json"] as string) as { tests: { scenarios: Array<{ source: string }> } };
    expect(main.tests.scenarios.length).toBeGreaterThan(10);
    expect(main.tests.scenarios.some((entry) => entry.source.includes("a deliberate failure"))).toBe(false);
    expect(expected["failing.datum-test"]).toMatch(/^test "a deliberate failure/);
  });
});
