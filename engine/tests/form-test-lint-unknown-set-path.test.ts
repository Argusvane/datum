import { describe, expect, it } from "vitest";

import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { formTestLints } from "../form-engine/core/form-tests/form-test-lint.js";
import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenario } from "../form-engine/core/form-tests/form-test-run.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { createFormTestKernelDriver } from "../form-engine/validation/wasm/form-test-kernel-driver.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";

/**
 * A form test's `set` on a path the form does not have still runs (a test may send an unknown
 * key on purpose, to see it stripped), but the scenario is linted: `tests.set.unknownPath`,
 * with the path and its span, for the Tests panel and check_form to show beside it.
 */

const ROOT = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "name", type: "text", configuration: {} },
      { id: "applicant", type: "container", configuration: { scopeData: true }, children: { content: [{ id: "email", type: "text", configuration: { dataKey: "mail" } }] } },
      { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "age", type: "number", configuration: {} }] } },
      {
        id: "lines",
        type: "dataGrid",
        configuration: {},
        collection: { collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: {} }, { id: "inner", type: "dataGrid", configuration: {}, collection: {}, children: { content: [{ id: "qty", type: "number", configuration: {} }] } }] }
      },
      { id: "go", type: "button", configuration: {} }
    ]
  }
} as unknown as ComponentNode;

function lints(source: string) {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  return formTestLints(parsed.scenarios, ROOT);
}

describe("tests.set.unknownPath", () => {
  it("says nothing for a set on a field, a scoped field, a row field or a nested grid's row field", () => {
    expect(lints(['test "known"', "  set name = \"a\"", "  set applicant.mail = \"a@b.c\"", "  set age = 3", "  set items[0].sku = \"x\"", "  set inner[2].qty = 1"].join("\n"))).toEqual([]);
  });

  it("names each set on a path the form does not have, with its line and span, once per step", () => {
    const source = ['test "typos"', "  set nmae = \"a\"", "  set applicant.email = \"a\"", "  set items[0].sk = 1", "  set box = 1", "  set go = 1", "  set nmae = \"b\""].join("\n");
    const found = lints(source);
    expect(found.map((lint) => [lint.code, lint.line, lint.params.path])).toEqual([
      ["tests.set.unknownPath", 2, "nmae"],
      ["tests.set.unknownPath", 3, "applicant.email"],
      ["tests.set.unknownPath", 4, "items[0].sk"],
      ["tests.set.unknownPath", 5, "box"],
      ["tests.set.unknownPath", 6, "go"],
      ["tests.set.unknownPath", 7, "nmae"]
    ]);
    for (const lint of found) {
      expect(source.slice(lint.start, lint.end)).toBe(lint.params.path);
    }
  });

  it("reads prototype names as unknown, never as a member every object has", () => {
    expect(lints(['test "proto"', "  set constructor = 1", "  set __proto__ = 1", "  set toString = 1"].join("\n")).map((lint) => lint.params.path)).toEqual(["constructor", "__proto__", "toString"]);
  });

  it("lints a set only: an expectation on an unknown path is the run's to fail", () => {
    expect(lints(['test "reads"', "  clear nmae", "  expect nmae = \"a\""].join("\n"))).toEqual([]);
  });

  it("leaves the scenario to run: the linted step runs and the scenario passes", async () => {
    const source = ['test "runs"', "  given journey = none", "  set nmae = \"a\"", "  set name = \"b\"", "  expect name = \"b\""].join("\n");
    expect(lints(source).length).toBe(1);
    const definition = { id: "f", version: "1.0.0", schemaVersion: "1.0.0", root: ROOT } as unknown as FormDefinition;
    const [scenario] = kernelParseFormTests(source, formulaFunctionSignatures()).scenarios;
    const result = await runFormTestScenario(scenario!, createFormTestKernelDriver(definition, { host: createInProcessWasmValidationHost([]) }));
    expect(result.status).toBe("passed");
    expect(result.steps[0]).toMatchObject({ line: 3, status: "ran" });
  });
});

describe("tests.change.unknownPath", () => {
  it("names a change on a path the form does not have, and says nothing for one it has", () => {
    const found = lints(['test "change"', "  change name", "  change nope", "  set nope = 1"].join("\n"));
    expect(found.map((lint) => [lint.code, lint.line, lint.params.path])).toEqual([
      ["tests.change.unknownPath", 3, "nope"],
      ["tests.set.unknownPath", 4, "nope"]
    ]);
    const source = ['test "change"', "  change name", "  change nope", "  set nope = 1"].join("\n");
    expect(source.slice(found[0]!.start, found[0]!.end)).toBe("nope");
  });
});
