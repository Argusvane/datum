// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { checkAnswerErrors, createTryIt } from "../form-engine/builder/web-component/try-it.js";
import type { TryItServerChecks } from "../form-engine/builder/web-component/try-it-types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { basesOf, definitionKindsFor, offeredKinds } from "../form-engine/registry/kinds.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";

/**
 * A tier-2 type (`gcds-date`, base `date`) is checked as its base from the definition's `kinds`
 * map alone: the builder's Try it hands the map it would save to its own checks and to the
 * host's server checks, and the browser's runtime and the kernel give the same codes for the same
 * definition, so a host that writes the map is judged the same in the page and on a server.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [], ...extra }) as ComponentDefinition;

const tree: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "d", type: "date", configuration: { label: "Date" } },
      { id: "g", type: "gcds-date", configuration: { label: "GC date" } }
    ]
  }
};

const BAD_DAY = "2025-02-31";

describe("basesOf", () => {
  it("names each definition's string base by type, the first of a type winning, nothing for one without", () => {
    const bases = basesOf([def("gcds-date", { base: "date" }), def("gcds-date", { base: "text" }), def("plain"), def("odd", { base: 3 as never }), def("__proto__", { base: "text" })]);
    // An own entry named `__proto__`, not a prototype.
    expect(Object.entries(bases)).toEqual([["gcds-date", "date"], ["__proto__", "text"]]);
    expect(Object.getPrototypeOf(bases)).toBe(Object.prototype);
    expect(basesOf(undefined)).toEqual({});
    expect(Object.entries(offeredKinds(bases))).toEqual([["gcds-date", "date"], ["__proto__", "text"]]);
  });
});

describe("the definition's kinds map, read the same in the browser and the kernel", () => {
  const kinds = definitionKindsFor(tree, offeredKinds(basesOf([def("gcds-date", { base: "date" })])));

  it("writes an entry for the tier-2 type the tree uses", () => {
    expect(kinds).toEqual({ "gcds-date": "date" });
  });

  /** The codes a definition's browser runtime gives the two fields at the impossible day. */
  async function browserCodes(withKinds: boolean): Promise<Record<string, string[]>> {
    const runtime = new FormRuntime(
      { id: "f", version: "1", schemaVersion: "1", root: tree, ...(withKinds ? { kinds: kinds! } : {}) },
      { validationPipeline: new ValidationPipeline([createFieldConstraintsStage(tree)]), submissionModes: new SubmissionModeRegistry() }
    );
    runtime.setValue("d", BAD_DAY);
    runtime.setValue("g", BAD_DAY);
    const errors = await runtime.validate();
    return { d: errors.filter((e) => e.componentId === "d").map((e) => e.code), g: errors.filter((e) => e.componentId === "g").map((e) => e.code) };
  }

  /** The codes the portable kernel gives the same definition. */
  function kernelCodes(withKinds: boolean): Record<string, string[]> {
    const outcome = runKernel(
      { formId: "f", values: { d: BAD_DAY, g: BAD_DAY }, locale: "en", form: tree, ...(withKinds ? { kinds: kinds! } : {}) },
      [],
      undefined,
      formulaFunctionSignatures()
    );
    return { d: outcome.errors.filter((e) => e.componentId === "d").map((e) => e.code), g: outcome.errors.filter((e) => e.componentId === "g").map((e) => e.code) };
  }

  it("checks the gcds-date as a date with the map, in the runtime and the kernel alike", async () => {
    expect(await browserCodes(true)).toEqual({ d: ["date"], g: ["date"] });
    expect(kernelCodes(true)).toEqual({ d: ["date"], g: ["date"] });
  });

  it("checks it as nothing without the map, in both: the map is what a host must write", async () => {
    expect(await browserCodes(false)).toEqual({ d: ["date"], g: [] });
    expect(kernelCodes(false)).toEqual({ d: ["date"], g: [] });
  });
});

describe("Try it reads a tier-2 type through the map the builder would save", () => {
  function made(serverChecks?: TryItServerChecks, catalogue: ComponentDefinition[] = [def("gcds-date", { base: "date" })]) {
    const canvas = document.createElement("div");
    const root = canvas.attachShadow({ mode: "open" });
    root.innerHTML = `<div data-try-panel></div>`;
    document.body.append(canvas);
    const controller = new BuilderController({
      componentTypes: [{ type: "date", label: "Date" }],
      initialRoot: tree,
      componentDefinitions: [def("form", { children: { slots: [{ id: "content", multiple: true }] } } as never), def("date"), ...catalogue]
    });
    const preview = new BuilderPreviewRuntime(tree, { locale: "en" });
    preview.setValue("d", BAD_DAY);
    preview.setValue("g", BAD_DAY);
    const renderer = { notice: undefined, focusFirstError: () => undefined, revealComponent: () => undefined, setNotice: () => undefined };
    const tryIt = createTryIt({
      canvas,
      root: () => root,
      controller: () => controller,
      preview: () => preview,
      renderer: () => renderer as never,
      trySettings: () => controller,
      serverChecks: () => serverChecks,
      pdf: () => undefined,
      mode: () => "interactive",
      setMode: () => undefined
    });
    return { tryIt, controller };
  }

  it("lists the gcds-date's impossible day beside the date's", async () => {
    const { tryIt, controller } = made();
    expect(controller.definitionKinds()).toEqual({ "gcds-date": "date" });
    const outcome = await tryIt.check();
    expect(outcome.problems.map((problem) => problem.componentId).sort()).toEqual(["d", "g"]);
  });

  it("hands the server's checks the same map, so the kernel reads the type as the browser does", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const serverChecks: TryItServerChecks = {
      label: "Kernel",
      run: async ({ root, answers, locale, kinds }) => {
        seen.push(kinds);
        return { errors: runKernel({ formId: "f", values: answers, locale, form: root, ...(kinds ? { kinds } : {}) }, [], undefined, formulaFunctionSignatures()).errors };
      }
    };
    const { tryIt } = made(serverChecks);
    tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(tryIt.serverChecksOn()).toBe(true));
    const outcome = await tryIt.check();
    expect(outcome.server).toBe("ran");
    expect(seen.at(-1)).toEqual({ "gcds-date": "date" });
    expect(outcome.problems.map((problem) => problem.componentId).sort()).toEqual(["d", "g"]);
  });

  it("keeps the opened file's entry for a type the page's catalogue gives no base, locally and in the server request", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const serverChecks: TryItServerChecks = {
      label: "Kernel",
      run: async ({ root, answers, locale, kinds }) => {
        seen.push(kinds);
        return { errors: runKernel({ formId: "f", values: answers, locale, form: root, ...(kinds ? { kinds } : {}) }, [], undefined, formulaFunctionSignatures()).errors };
      }
    };
    // The page offers no gcds-date: only the file it opened names its base, as Save and the runtime keep it.
    const { tryIt, controller } = made(serverChecks, []);
    expect(controller.definitionKinds()).toBeUndefined();
    const before = await tryIt.check();
    expect(before.problems.map((problem) => problem.componentId)).toEqual(["d"]);
    controller.openedKinds = () => ({ "gcds-date": "date" });
    expect((await tryIt.check()).problems.map((problem) => problem.componentId).sort()).toEqual(["d", "g"]);
    tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(tryIt.serverChecksOn()).toBe(true));
    const outcome = await tryIt.check();
    expect(outcome.server).toBe("ran");
    expect(seen.at(-1)).toEqual({ "gcds-date": "date" });
    expect(outcome.problems.map((problem) => problem.componentId).sort()).toEqual(["d", "g"]);
  });

  it("the stage alone: the map in, the tier-2 type checked; out, not", () => {
    const options = { locale: "en", required: new Map<string, boolean>(), hidden: () => false };
    const answers = { d: BAD_DAY, g: BAD_DAY };
    expect(checkAnswerErrors(tree, answers, { ...options, kinds: { "gcds-date": "date" } }).map((e) => e.componentId)).toEqual(["d", "g"]);
    expect(checkAnswerErrors(tree, answers, options).map((e) => e.componentId)).toEqual(["d"]);
  });
});
