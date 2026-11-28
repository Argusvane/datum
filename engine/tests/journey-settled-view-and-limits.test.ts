import { describe, expect, it } from "vitest";

import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { journeyOwnership, journeyPath } from "../form-engine/core/journey/journey-path.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";

/** Journey runtime and kernel: calculations over the settled view, the linear walk, run-time caps and a clock-reading page condition. */

const neq = (name: string, value: unknown): string => `${name} != ${JSON.stringify(value)}`;
const lt = (name: string, value: number): string => `${name} < ${value}`;

describe("a calculation reads the settled view, in the browser and on the server alike", () => {
  const root: ComponentNode = {
    id: "form", type: "form", configuration: {},
    children: { content: [
      { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "y" }, { value: "no", label: "n" }] } },
      { id: "income", type: "number", configuration: { required: true } },
      { id: "eligible", type: "checkbox", configuration: {}, rules: { value: lt("income", 30000) } },
      { id: "bonus", type: "text", configuration: { required: true } }
    ] }
  } as never;
  const journey: Journey = { id: "j", pages: [
    { id: "who", components: ["resident"], routes: [{ when: neq("resident", "yes"), to: "result" }] },
    { id: "money", components: ["income"] },
    { id: "result", components: ["eligible"], routes: [{ when: neq("eligible", true), to: "$end" }] },
    { id: "extra", components: ["bonus"] }
  ] } as never;
  const definition = { id: "f", version: "1", schemaVersion: "1", root, journey: { journeys: [journey] } } as unknown as FormDefinition;

  function browser(steps: (runtime: FormRuntime) => void): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
      wasmValidationHost: createInProcessWasmValidationHost([])
    });
    steps(runtime);
    return runtime;
  }
  const server = (values: Record<string, unknown>) => runKernel({ formId: "f", values, locale: "en", form: root, journey }, []);

  it("an answer the person gave and then took the path away from is no input to the calculation", () => {
    const runtime = browser((r) => {
      r.setValue("resident", "yes");
      r.setValue("income", 0);
      r.setValue("bonus", "x");
      r.setValue("resident", "no");
    });
    // income and bonus stay in the browser's state for the person; neither is submitted, and nothing is derived from income.
    const sent = runtime.submittableValues();
    expect(sent.income).toBeUndefined();
    expect(sent.bonus).toBeUndefined();
    expect(sent.eligible).not.toBe(true);
    expect(runtime.journeyView()?.path).not.toContain("extra");
    // The server, handed the envelope, lands on the same answers; handed the forged lot, it drops the same ones.
    const fromEnvelope = server(sent);
    expect(fromEnvelope.errors).toEqual([]);
    expect(fromEnvelope.values).toEqual(Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined)));
    const forged = server({ resident: "no", income: 0, bonus: "x" });
    expect(forged.errors).toEqual([]);
    expect(forged.values).toEqual(fromEnvelope.values);
  });

  it("with the figure on the path, both sides derive from it", () => {
    const runtime = browser((r) => {
      r.setValue("resident", "yes");
      r.setValue("income", 0);
      r.setValue("bonus", "x");
    });
    const sent = runtime.submittableValues();
    expect(sent.eligible).toBe(true);
    expect(runtime.journeyView()?.path).toContain("extra");
    const outcome = server(sent);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ resident: "yes", income: 0, eligible: true, bonus: "x" });
  });
});

describe("the path walk is linear in the pages", () => {
  function reads(pageCount: number): number {
    const content: ComponentNode[] = [];
    const pages: Array<{ id: string; components: string[] }> = [];
    const values: Record<string, unknown> = {};
    for (let i = 0; i < pageCount; i += 1) {
      content.push({ id: "f" + i, type: "text", configuration: {} } as never);
      pages.push({ id: "p" + i, components: ["f" + i] });
      values["f" + i] = "a";
    }
    const form = { id: "form", type: "form", configuration: {}, children: { content } } as unknown as ComponentNode;
    const journey = { id: "j", pages } as unknown as Journey;
    const ownership = journeyOwnership(form, journey);
    // Counts every look the walk takes at the ownership map: a walk that asks each pending key's
    // owners on every page (the quadratic one) grows with pages x keys.
    let looks = 0;
    const counted = new Proxy(ownership.pagesOf, {
      get(target, key, receiver) { looks += 1; return Reflect.get(target, key, receiver); },
      has(target, key) { looks += 1; return Reflect.has(target, key); },
      getOwnPropertyDescriptor(target, key) { looks += 1; return Reflect.getOwnPropertyDescriptor(target, key); }
    });
    const trace = journeyPath(journey, { values, ownership: { ...ownership, pagesOf: counted }, evaluate: () => true, visible: undefined } as never);
    expect(trace.pages).toHaveLength(pageCount);
    return looks;
  }

  it("doubling the pages doubles the looks at who owns what (it was four times)", () => {
    const small = reads(250);
    const large = reads(1000);
    expect(large / small).toBeLessThan(6);
  });
});

describe("the structure caps hold on the journey a host hands the run", () => {
  const root = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }] } } as unknown as ComponentNode;

  it("more pages than the definition may hold is journey.page.tooMany, with no values", () => {
    const pages = Array.from({ length: 1001 }, (_, i) => ({ id: "p" + i, components: i === 0 ? ["a"] : [] }));
    const outcome = runKernel({ formId: "f", values: { a: "x" }, locale: "en", form: root, journey: { id: "j", pages } as never }, []);
    expect(outcome.errors.map((e) => e.code)).toContain("journey.page.tooMany");
    expect(outcome.errors.map((e) => e.code)).not.toContain("journey.invalid");
    expect(outcome.values).toBeUndefined();
    const atCap = runKernel({ formId: "f", values: { a: "x" }, locale: "en", form: root, journey: { id: "j", pages: pages.slice(0, 1000) } as never }, []);
    expect(atCap.errors).toEqual([]);
  });

  it("more routes on a page than the definition may hold is journey.route.tooMany", () => {
    const routes = Array.from({ length: 65 }, () => ({ to: "$end" }));
    const outcome = runKernel({ formId: "f", values: { a: "x" }, locale: "en", form: root, journey: { id: "j", pages: [{ id: "p", components: ["a"], routes }] } as never }, []);
    expect(outcome.errors.map((e) => e.code)).toContain("journey.route.tooMany");
    expect(outcome.values).toBeUndefined();
    // Exactly the cap runs.
    const atCap = runKernel({ formId: "f", values: { a: "x" }, locale: "en", form: root, journey: { id: "j", pages: [{ id: "p", components: ["a"], routes: routes.slice(0, 64) }] } as never }, []);
    expect(atCap.errors).toEqual([]);
  });
});

describe("the settle loop re-decides each round, and an omitted on-path input is the person's own empty answer", () => {
  const gt = (name: string, value: number): string => `${name} > ${value}`;
  const add = (a: string, b: string): string => `${a} + ${b}`;

  function build(nodes: ComponentNode[], journey: Journey) {
    const root = { id: "form", type: "form", configuration: {}, children: { content: nodes } } as unknown as ComponentNode;
    const definition = { id: "f", version: "1", schemaVersion: "1", root, journey: { journeys: [journey] } } as unknown as FormDefinition;
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]),
      wasmValidationHost: createInProcessWasmValidationHost([])
    });
    return { root, runtime, server: (values: Record<string, unknown>) => runKernel({ formId: "f", values, locale: "en", form: root, journey }, []) };
  }

  // A calculation on page p0 reads an answer on p1 that the calculation's own route can skip.
  const oscillating = () =>
    build(
      [
        { id: "n0", type: "number", configuration: {} },
        { id: "n1", type: "number", configuration: {} },
        { id: "c0", type: "number", configuration: {}, rules: { value: add("n1", "n0") } }
      ] as never,
      { id: "j", pages: [{ id: "p0", components: ["n0", "c0"], routes: [{ when: gt("c0", 3), to: "$end" }] }, { id: "p1", components: ["n1"] }] } as never
    );

  it("a calculation that moves the page that feeds it is not settled, on both sides", async () => {
    const { runtime, server } = oscillating();
    runtime.setValue("n0", 4);
    runtime.setValue("n1", 5);
    const envelope = { form: { id: "f", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } } as never;
    const submitted = await runtime.submit("submit", envelope);
    expect(submitted.accepted).toBe(false);
    expect(submitted.errors.map((e) => e.code)).toContain("fold.unsettled");
    const outcome = server({ n0: 4, n1: 5 });
    expect(outcome.errors.map((e) => e.code)).toContain("fold.unsettled");
    expect(outcome.values).toBeUndefined();
  });

  it("a calculation over a later page's answer that the path really skips settles and drops the forgery", () => {
    const { server } = build(
      [
        { id: "n0", type: "number", configuration: {} },
        { id: "n1", type: "number", configuration: {} },
        { id: "c0", type: "number", configuration: {}, rules: { value: add("n1", "n0") } }
      ] as never,
      { id: "j", pages: [{ id: "p0", components: ["n0", "c0"], routes: [{ when: "n0 <= 10", to: "$end" }] }, { id: "p1", components: ["n1"] }] } as never
    );
    const outcome = server({ n0: 4, n1: 5, c0: 99 });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ n0: 4 });
  });

  it("an optional on-path input that is omitted is empty, not a reason to trust the forged result", () => {
    const { server } = build(
      [
        { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "y" }] } },
        { id: "income", type: "number", configuration: {} },
        { id: "eligible", type: "checkbox", configuration: {}, rules: { value: lt("income", 30000) } },
        { id: "bonus", type: "text", configuration: { required: true } }
      ] as never,
      { id: "j", pages: [
        { id: "who", components: ["resident"], routes: [{ when: neq("resident", "yes"), to: "result" }] },
        { id: "money", components: ["income"] },
        { id: "result", components: ["eligible"], routes: [{ when: neq("eligible", true), to: "$end" }] },
        { id: "extra", components: ["bonus"] }
      ] } as never
    );
    const forged = server({ resident: "yes", eligible: true, bonus: "x" });
    const honest = server({ resident: "yes" });
    expect(honest.errors).toEqual([]);
    expect(forged.errors).toEqual([]);
    expect(forged.values).toEqual(honest.values);
    expect(forged.clientDerived).toBeUndefined();
  });
});
