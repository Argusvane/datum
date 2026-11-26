// The load check (definitionLoadProblem) refuses nothing the repo ships (a corpus of valid definitions that must not be flagged).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { definitionLoadProblem, definitionTreeProblem, formDefinitionProblem } from "../src/support.js";

const repo = resolve(__dirname, "../../..");
const corpus: Array<[string, any]> = [];
for (const f of [
  "packages/datum/a11y/form.json",
  "packages/datum/demo/intake-form.json",
  "packages/datum/visual/builder-form.json",
  "packages/datum/eval/forms/declaration.json",
  "packages/datum/eval/forms/empty.json",
  "packages/datum/eval/forms/travel-claim.json",
  "packages/conformance-suite/fixtures/endpoint-fixture.definition.json",
  "packages/form-test/fixtures/clock.json",
  "packages/form-test/fixtures/main.json",
  "packages/form-test/tests/vitest-helper-project/fixtures/main.json",
  "packages/form-test/tests/vitest-helper-project/fixtures/uncovered.json",
  "engine/tests/fixtures/customer-intake.translations.json"
]) corpus.push([f, JSON.parse(readFileSync(resolve(repo, f), "utf8"))]);
describe("the load check over the shipped definitions", () => {
  it("counts", () => { console.log("corpus size", corpus.length); expect(corpus.length).toBeGreaterThan(10); });
  it.each(corpus)("%s", (_n, def) => {
    expect(definitionLoadProblem(def)).toBeUndefined();
    // The gate the definition setter, the attribute and src run also refuses node shapes and a root that is not the form.
    expect(definitionTreeProblem(def)).toBeUndefined();
    // And what Open adds (languages, chrome part ids, the sides).
    expect(formDefinitionProblem(def)).toBeUndefined();
  });
});
