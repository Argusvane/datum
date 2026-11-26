import { describe, expect, it } from "vitest";

import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { runInspect, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { WASM_ABI_VERSION } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * A field `pattern` that does not compile (`(?i)abc`: inline flags are not JavaScript) can never
 * be shown to match. Under the default policy the server refuses every non-empty answer to it
 * (`pattern`, `parameters.invalid: true`); the browser's stage now says the same, so the person
 * is told before they send, and `check` reports the pattern so a host refuses the form at Save.
 * Under `warn` both sides skip the check.
 */

function form(pattern: string, configuration: Record<string, unknown> = {}): ComponentNode {
  return { id: "form", type: "form", configuration, children: { content: [{ id: "code", type: "text", configuration: { pattern } }] } } as unknown as ComponentNode;
}

type Seen = Array<{ code: string; parameters: Record<string, unknown> | undefined }>;

function browser(root: ComponentNode, value: string, options: Parameters<typeof createFieldConstraintsStage>[1] = {}): Seen {
  const result = createFieldConstraintsStage(root, options).validate({ formId: "f", values: { code: value }, locale: "en" } as never);
  return (result as { errors: Array<{ code: string; parameters?: Record<string, unknown> }> }).errors.map((error) => (error.parameters === undefined ? { code: error.code } : { code: error.code, parameters: error.parameters }) as Seen[number]);
}

function server(root: ComponentNode, value: string): Seen {
  return runKernel({ formId: "f", values: { code: value }, locale: "en", form: root }, [], undefined, formulaFunctionSignatures()).errors.map((error) => ({
    code: error.code,
    parameters: error.parameters
  }));
}

describe("an uncompilable pattern", () => {
  it("check reports it as a structure problem: the verdict fails", () => {
    const answer = runInspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: form("(?i)abc") } }, formulaFunctionSignatures(), [
      ...FORMULA_FUNCTION_NAMES
    ]) as { verdict: string; structure: Array<{ code: string; where: string }> };
    expect(answer.structure.map((problem) => `${problem.code}@${problem.where}`)).toEqual(["component.pattern.invalid@root > content > code"]);
    expect(answer.verdict).toBe("fail");
    const fine = runInspect({ abi: WASM_ABI_VERSION, op: "check", definition: { id: "f", version: "1", schemaVersion: "1", root: form("[A-Z]{3}") } }, formulaFunctionSignatures(), [
      ...FORMULA_FUNCTION_NAMES
    ]) as { verdict: string };
    expect(fine.verdict).toBe("ok");
  });

  it("under the default policy the browser refuses a non-empty answer as the server does", () => {
    const root = form("(?i)abc");
    expect(browser(root, "abc")).toEqual([{ code: "pattern", parameters: { pattern: "(?i)abc", invalid: true } }]);
    expect(server(root, "abc").map((error) => [error.code, error.parameters?.invalid])).toEqual([["pattern", true]]);
    expect(browser(root, "")).toEqual([]);
  });

  it("a refused risky pattern is that same definition problem, marked risky", () => {
    const root = form("(a+)+$");
    expect(browser(root, "aaa")).toEqual([{ code: "pattern", parameters: { pattern: "(a+)+$", invalid: true, risky: true } }]);
    expect(server(root, "aaa").map((error) => [error.code, error.parameters?.invalid, error.parameters?.risky])).toEqual([["pattern", true, true]]);
  });

  it("under warn, from the form or the stage's option, both sides skip the check", () => {
    const warned = form("(?i)abc", { formulaErrors: "warn" });
    expect(browser(warned, "abc")).toEqual([]);
    expect(server(warned, "abc")).toEqual([]);
    expect(browser(form("(?i)abc"), "abc", { formulaErrors: "warn" })).toEqual([]);
  });

  it("a pattern that compiles is judged as before", () => {
    const root = form("[A-Z]{3}");
    expect(browser(root, "ABC")).toEqual([]);
    expect(browser(root, "abc")).toEqual([{ code: "pattern", parameters: { pattern: "[A-Z]{3}" } }]);
  });
});
