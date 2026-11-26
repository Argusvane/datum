import { describe, expect, it } from "vitest";

import {
  formulaFunctionSignatures,
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WasmValidationHost,
  createFieldConstraintsStage,
  kernelIsDateAnswer,
  kernelIsNumberAnswer,
  runKernel,
  type ComponentNode
} from "@argusvane/datum-engine";
import { APPLY_BELOW, applyJourney, presentationRoot } from "@argusvane/datum-engine/tests/fixtures/presentation-form";

import { QuickJsWasmHostAdapter, buildSandboxProgram } from "../src/index.js";

/**
 * The number and date validity checks behind the real sandbox: the number and date predicates are spliced into the
 * program, and QuickJS judges a number or a date answer byte for byte as the in-process kernel
 * does — and as the browser's stage does, through the same functions.
 */

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "age", type: "number", configuration: { required: true } },
      { id: "born", type: "date", configuration: {} },
      { id: "note", type: "text", configuration: {} }
    ]
  }
};

/**
 * The rounding midpoint above the largest double, as a 309-digit numeral: V8 reads it as
 * `Infinity`, QuickJS as the largest finite double. The predicate judges its spelling, so both
 * engines give one verdict.
 */
const MIDPOINT =
  "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";

const ANSWERS: Array<Record<string, unknown>> = [
  { age: MIDPOINT },
  { age: `-${MIDPOINT}` },
  { age: `${MIDPOINT}.0000000001` },
  { age: "1e999" },
  { age: "1e309" },
  {},
  { age: 12, born: "2024-02-29" },
  { age: "12", born: "2000-02-29" },
  { age: " 7 ", born: "0005-01-01" },
  { age: "abc", born: "2026-02-31" },
  { age: "1,000", born: "2026-13-01" },
  { age: "0x10", born: "2026-2-3" },
  { age: "Infinity", born: "0000-01-01" },
  { age: true, born: "2026-02-03T00:00:00Z" },
  { age: [], born: 20260203 },
  { age: {}, born: "2023-02-29" },
  { age: "", born: "" },
  { age: 3, born: "1900-02-29", note: "abc" }
];

describe("QuickJS: number and date answers", () => {
  it("splices the predicates into the program", () => {
    const program = buildSandboxProgram();
    expect(program).toContain(`function ${kernelIsNumberAnswer.name}(`);
    expect(program).toContain(`function ${kernelIsDateAnswer.name}(`);
  });

  it("judges every answer byte for byte as the in-process kernel, and as the browser's stage by code", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const stage = createFieldConstraintsStage(root);
    try {
      for (const values of ANSWERS) {
        const payload = abi.serializeContext({ formId: "f", values, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
        const sandboxed = await quickJs.run(payload);
        expect(sandboxed, JSON.stringify(values)).toBe(inProcess.run(payload));
        const outcome = abi.deserializeOutcome(sandboxed);
        const client = (await stage.validate({ formId: "f", values, locale: "en" })) as { errors: Array<{ componentId?: string; code: string }> };
        expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`), JSON.stringify(values)).toEqual(
          client.errors.map((error) => `${error.componentId}:${error.code}`)
        );
      }
      // Two cases the host must match: refused with the same codes; numeric strings accepted as sent.
      const refused = abi.deserializeOutcome(
        await quickJs.run(abi.serializeContext({ formId: "f", values: { age: "abc", born: "2026-02-31" }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY))
      );
      expect(refused.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["age:number", "born:date"]);
      expect(refused.values).toBeUndefined();
      const accepted = abi.deserializeOutcome(
        await quickJs.run(abi.serializeContext({ formId: "f", values: { age: "12", born: "2024-02-29" }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY))
      );
      expect(accepted).toEqual({
        errors: [],
        values: { age: "12", born: "2024-02-29" },
        index: [
          { path: "age", delta: "", value: "12" },
          { path: "born", delta: "", value: "2024-02-29" }
        ]
      });
      // The midpoint numeral: V8 and QuickJS parse it apart, but both accept it, byte for byte.
      expect(Number.isFinite(Number(MIDPOINT))).toBe(false);
      const midpointPayload = abi.serializeContext({ formId: "f", values: { age: MIDPOINT }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
      const midpoint = await quickJs.run(midpointPayload);
      expect(midpoint).toBe(inProcess.run(midpointPayload));
      expect(abi.deserializeOutcome(midpoint)).toEqual({ errors: [], values: { age: MIDPOINT }, index: [{ path: "age", delta: "", value: MIDPOINT }] });
    } finally {
      quickJs.dispose?.();
    }
  });

  it("refuses a forged non-numeric worked-out total, as the in-process kernel does", async () => {
    const abi = new JsonWasmAbi();
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      const context = { formId: "presentation", values: { ...APPLY_BELOW, annual_income: "lots" }, locale: "en", form: presentationRoot(), journey: applyJourney() };
      const payload = abi.serializeContext(context, WasmValidationHost.STRICT_POLICY);
      const sandboxed = await quickJs.run(payload);
      expect(sandboxed).toBe(new InProcessWasmHostAdapter().instantiate([], abi).run(payload));
      const outcome = abi.deserializeOutcome(sandboxed);
      expect(outcome.errors).toEqual([{ code: "number", componentId: "annual_income", path: "annual_income", stage: "field-constraints", source: "wasm" }]);
      // The kernel as a host runs it: with the function table's signatures, which a tree's calls are checked against.
      expect(outcome).toEqual(JSON.parse(JSON.stringify(runKernel(context, [], undefined, formulaFunctionSignatures()))));
    } finally {
      quickJs.dispose?.();
    }
  });
});
