import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { FIXTURE_FORM } from "../form-engine/testing/fixture-form.js";
import { runInspect } from "../form-engine/validation/wasm/portable-kernel.js";
import { WASM_ABI_VERSION } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { presentationForm } from "./fixtures/presentation-form.js";

/**
 * Calibration and regression guard for the kernel's structural check: every
 * definition the repository ships must come back from `check` with no structure refusal and no
 * structure warning. If a rule refuses one of these, the rule is wrong or the rule's severity
 * (`kernelStructureSeverity`, `core/expressions/definition-structure.ts`) must become "warn" until the
 * definition is fixed. The site's demo forms (`site/src/demo-forms.ts`) are in the corpus below.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function jsonFiles(): Array<[string, unknown]> {
  const files = [
    "packages/datum/a11y/form.json",
    "packages/datum/demo/intake-form.json",
    "packages/datum/visual/builder-form.json",
    "packages/conformance-suite/fixtures/endpoint-fixture.definition.json"
  ];
  const found: Array<[string, unknown]> = [];
  for (const file of files) {
    if (existsSync(resolve(repo, file))) {
      found.push([file, JSON.parse(readFileSync(resolve(repo, file), "utf8"))]);
    }
  }
  return found;
}

// The site package is outside this package's compile root: loaded by path, not by import.
const siteDemos = (await import(/* @vite-ignore */ resolve(repo, "site/src/demo-forms.ts"))) as { examples: Array<{ id: string; definition: unknown }> };

const corpus: Array<[string, unknown]> = [
  ["engine FIXTURE_FORM", FIXTURE_FORM],
  ["engine presentationForm", presentationForm()],
  ...siteDemos.examples.map((example): [string, unknown] => [`site demo ${example.id}`, example.definition]),
  ...jsonFiles()
];

describe("the shipped definitions pass the kernel's structural check", () => {
  it("finds the corpus it expects", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    expect(corpus.map(([name]) => name)).toEqual(expect.arrayContaining(["engine FIXTURE_FORM", "site demo callback"]));
  });

  it.each(corpus)("%s", (_name, definition) => {
    const answer = runInspect({ abi: WASM_ABI_VERSION, op: "check", definition }, formulaFunctionSignatures(), [...FORMULA_FUNCTION_NAMES]);
    expect(answer).toMatchObject({ ok: true, op: "check", structure: [], structureWarnings: [] });
  });
});
