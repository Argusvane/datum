import { describe, expect, it } from "vitest";

import { kernelComponentTreeFault } from "../form-engine/core/expressions/compile.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { kernelTreeIndex, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/**
 * A component tree no run can walk is refused at the run's entry with a typed `stage:
 * "definition"` error, as a tree nested too deep is: a node that is not a record or a slot that is
 * not a list (a raw `TypeError` before), and ids whose parents loop (an ancestor walk that never
 * ended, gigabytes and eleven seconds later). Repeated ids that make no loop are left alone: the
 * form draws them with a notice and they share one value.
 */

const text = (id: string): Record<string, unknown> => ({ id, type: "text", configuration: {} });
const box = (id: string, content: unknown[]): Record<string, unknown> => ({ id, type: "container", configuration: {}, children: { content } });
const form = (content: unknown[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } }) as unknown as ComponentNode;

function run(root: ComponentNode, values: Record<string, unknown> = {}): ReturnType<typeof runKernel> {
  return runKernel({ formId: "f", values, locale: "en", form: root }, [], undefined, formulaFunctionSignatures());
}

describe("kernelComponentTreeFault", () => {
  it.each([
    ["a null entry", form([text("a"), null]), { code: "definition.malformed", where: "root > content > #1" }],
    ["a number entry", form([5]), { code: "definition.malformed", where: "root > content > #0" }],
    ["a null slot", form([{ id: "g", type: "group", configuration: {}, collection: {}, children: { default: null } }]), { code: "definition.malformed", where: "root > content > g > default" }],
    ["a record slot", form([{ id: "g", type: "container", configuration: {}, children: { default: text("x") } }]), { code: "definition.malformed", where: "root > content > g > default" }],
    ["children that are a list", form([{ id: "g", type: "container", configuration: {}, children: [text("x")] }]), { code: "definition.malformed", where: "root > content > g" }],
    ["a child with its parent's id", form([box("a", [text("a")])]), { code: "definition.idCycle", where: "root > content > a" }],
    ["a child with the form's id", form([text("form")]), { code: "definition.idCycle", where: "root" }],
    ["a grandchild with its grandparent's id", form([box("a", [box("b", [text("a")])])]), { code: "definition.idCycle", where: "root > content > a" }],
    ["an id on its own chain under crossing cousins", form([box("x", [text("y")]), box("y", [box("z", [text("y")])])]), { code: "definition.idCycle", where: "root > content > y" }]
  ])("%s", (_name, root, expected) => {
    expect(kernelComponentTreeFault(root)).toEqual(expected);
  });

  it("a repeated sibling or cousin id that makes no loop is not its to judge", () => {
    expect(kernelComponentTreeFault(form([text("a"), text("a")]))).toBeUndefined();
    expect(kernelComponentTreeFault(form([box("x", [text("a")]), box("y", [text("a")])]))).toBeUndefined();
    expect(kernelComponentTreeFault(form([box("x", [text("a")]), text("x")]))).toBeUndefined();
    expect(kernelComponentTreeFault(form([{ id: "n", type: "text", configuration: {}, children: null }]))).toBeUndefined();
  });

  it("two cousins crossing ids put no id on its own ancestor chain, so they are cousins, not a loop", () => {
    expect(kernelComponentTreeFault(form([box("x", [text("y")]), box("y", [text("x")])]))).toBeUndefined();
    expect(kernelComponentTreeFault(form([box("p", [text("q")]), box("q", [text("r")]), box("r", [text("p")])]))).toBeUndefined();
  });
});

describe("a run refuses such a tree typed, in good time", () => {
  it.each([
    ["a null entry", form([text("a"), null]), "definition.malformed"],
    ["a data grid with a null row cell", form([{ id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "g" }, children: { content: [5, null] } }]), "definition.malformed"],
    ["a null slot on a section", form([{ id: "g", type: "group", configuration: {}, collection: {}, children: { default: null } }]), "definition.malformed"],
    ["a child with its parent's id", form([box("a", [text("a")])]), "definition.idCycle"],
    ["a child with the form's id", form([text("form")]), "definition.idCycle"],
    ["a grandchild with its grandparent's id", form([box("a", [box("b", [text("a")])])]), "definition.idCycle"]
  ])("%s", (_name, root, code) => {
    const started = Date.now();
    const outcome = run(root, { a: "x" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.errors.map((error) => [error.code, error.stage])).toEqual([[code, "definition"]]);
    expect(typeof outcome.errors[0]?.parameters?.where).toBe("string");
  });

  it("a sibling duplicate still runs and the outcome is judged as before", () => {
    const outcome = run(form([text("a"), text("a")]), { a: "x" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ a: "x" });
  });

  it("two cousins crossing ids run as repeated ids do, in good time", () => {
    const started = Date.now();
    const outcome = run(form([box("x", [text("y")]), box("y", [text("x")])]), { x: "1", y: "2" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.errors.filter((error) => error.stage === "definition")).toEqual([]);
  });

  it("the index never records a parent that closes a loop, and skips what is not a node", () => {
    const index = kernelTreeIndex(form([box("a", [text("a"), null]), box("x", [text("y")]), box("y", [text("x")])]));
    const walk = (id: string): string[] => {
      const chain: string[] = [];
      for (let at: string | undefined = id; at !== undefined; at = index.parentOf[at]) {
        chain.push(at);
        expect(chain.length).toBeLessThan(10);
      }
      return chain;
    };
    for (const id of index.order) {
      expect(walk(id).at(-1)).toBe("form");
    }
  });
});

describe("the browser runtime meets the same trees as the run", () => {
  function runtime(root: ComponentNode): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime({ id: "f", version: "1", schemaVersion: "1", root } as never, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      journeyEngine: EagerJourneyEngine,
      wasmValidationHost: createInProcessWasmValidationHost([])
    } as never);
  }

  it.each([
    ["a child with its parent's id", form([box("a", [text("a")])])],
    ["a child with the form's id", form([text("form")])],
    ["a grandchild with its grandparent's id", form([box("a", [box("b", [text("a")])])])]
  ])("%s: refused when the runtime is made, in good time", (_name, root) => {
    const started = Date.now();
    expect(() => runtime(root)).toThrow(/own ancestors/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("two cousins crossing ids: the runtime is made and validates, as the run judges them", async () => {
    const started = Date.now();
    const made = runtime(form([box("x", [text("y")]), box("y", [text("x")])]));
    made.setValue("x", "1");
    await made.validate();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a journey page's own nodes", () => {
  const journeyRun = (own: unknown): ReturnType<typeof runKernel> =>
    runKernel(
      { formId: "f", locale: "en", form: form([text("a")]), journey: { id: "j", pages: [{ id: "p", title: "P", components: ["a", own] }] } as never, values: { a: "x" } },
      [],
      undefined,
      formulaFunctionSignatures()
    );

  it.each([
    ["a container with a null child", box("box", [null])],
    ["a container with a null slot", { id: "box", type: "container", configuration: {}, children: { content: null } }]
  ])("%s: the journey is refused typed", (_name, own) => {
    expect(journeyRun(own).errors.map((error) => error.code)).toEqual(["journey.invalid"]);
  });

  it.each([
    ["a child sharing its container's id", box("box", [text("box")])],
    ["a child holding the form's id", box("box", [text("form")])]
  ])("%s: the run ends in good time", (_name, own) => {
    const started = Date.now();
    journeyRun(own);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
