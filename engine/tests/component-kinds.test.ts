import { describe, expect, it } from "vitest";

import { kindOfNode } from "../form-engine/agent/answers/kinds.js";
import { kernelStructureCheck } from "../form-engine/core/expressions/definition-structure.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelAnswerBounds, kernelAnswerKindCode, kernelIsEmptyValue } from "../form-engine/core/schema/answer-kinds.js";
import { COMPONENT_KIND_FUNCTIONS, kernelContainerBase, kernelIsEngineType, kernelKindBase } from "../form-engine/core/schema/component-kinds.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { baseTypeOf, containerBaseOf, drawnBaseOf, kindOf, withBaseTypes } from "../form-engine/registry/kinds.js";
import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import { foldPresentation } from "../form-engine/render/core/presentation-tree.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { ENGINE_COMPONENT_TYPES } from "../form-engine/registry/engine-component-types.js";
import { compilePdfDefinition } from "../form-engine/render/pdf/pdf-render-model.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage, validationCodesRaisedBy } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter } from "../form-engine/validation/wasm/in-process-host.js";
import { PORTABLE_KERNEL_FUNCTIONS, kernelCreatePreparedCache, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelOptionQuestions } from "../form-engine/validation/wasm/portable-options.js";
import { JsonWasmAbi, WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The kind registry and the definition's `kinds` map: a type that is not the
 * engine's is read as the base the map gives it, in the browser's field-constraints stage, in
 * the portable kernel, in the option check, in the agent's field kinds and in the PDF; the
 * structure check refuses a map whose base is not an engine type.
 */

const KINDS = { "gcds-date": "date", "gcds-radios": "radio", "acme-amount": "number", "x-text": "text" } as const;

function rootOf(children: ComponentNode[]): ComponentNode {
  return { id: "form", type: "form", configuration: {}, children: { content: children } };
}

const ROOT = rootOf([
  { id: "born", type: "gcds-date", configuration: { label: "Born", required: true, min: "1900-01-01", max: "2026-12-31" } },
  { id: "amount", type: "acme-amount", configuration: { label: "Amount" } },
  {
    id: "colour",
    type: "gcds-radios",
    configuration: { label: "Colour", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] }
  },
  // A text box that carries stray options: a choice of a plugin's while its type is unknown, free text once read as `text`.
  { id: "nick", type: "x-text", configuration: { label: "Nickname", options: [{ value: "a", label: "A" }] } }
]);

const DEFINITION: FormDefinition = { id: "kinds", version: "1.0.0", schemaVersion: "1.0.0", root: ROOT, kinds: { ...KINDS } };

function codes(errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
}

function modes(): SubmissionModeRegistry {
  const registry = new SubmissionModeRegistry();
  registry.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return registry;
}

const run = (context: Parameters<typeof runKernel>[0], cache?: Parameters<typeof runKernel>[4]) =>
  runKernel(context, [], undefined, formulaFunctionSignatures(), cache);

describe("the kind registry", () => {
  it("knows exactly the engine's component types, and the reserved signature type", () => {
    for (const type of ENGINE_COMPONENT_TYPES) {
      expect(kernelIsEngineType(type), type).toBe(true);
    }
    expect(kernelIsEngineType("signature")).toBe(true);
    expect(kernelIsEngineType("gcds-date")).toBe(false);
    expect(kernelIsEngineType("multiselect")).toBe(false);
  });

  it("reads an engine type as itself and a mapped type as its base, through any map", () => {
    expect(kindOf("date")).toEqual({ type: "date", base: "date", kind: "date" });
    expect(kindOf("gcds-date", KINDS)).toEqual({ type: "gcds-date", base: "date", kind: "date" });
    expect(kindOf("gcds-radios", KINDS)).toEqual({ type: "gcds-radios", base: "radio", kind: "choice" });
    expect(kindOf("html")).toEqual({ type: "html", base: "html" });
    expect(kindOf("fieldset")?.kind).toBe("group");
    expect(kindOf("dataGrid")?.kind).toBe("collection");
    // Unknown stays unknown, mapped or not.
    expect(kindOf("gcds-date")).toBeUndefined();
    expect(kindOf("mystery", KINDS)).toBeUndefined();
    // A map cannot re-base an engine type, name a base that is no engine type, or name `form`.
    expect(baseTypeOf("date", { date: "number" })).toBe("date");
    expect(baseTypeOf("x-a", { "x-a": "gcds-date" })).toBe("x-a");
    expect(baseTypeOf("x-a", { "x-a": "form" })).toBe("x-a");
    // Read tolerantly: no own entry, a prototype name, a list or a non-string base map nothing.
    expect(kernelKindBase("toString", {})).toBe("toString");
    expect(kernelKindBase("x-a", ["date"])).toBe("x-a");
    expect(kernelKindBase("x-a", { "x-a": 3 })).toBe("x-a");
    expect(kernelKindBase("x-a", null)).toBe("x-a");
  });

  it("is spliced into the sandbox program: every function is a top-level kernel function the kernel lists", () => {
    for (const fn of COMPONENT_KIND_FUNCTIONS) {
      expect(PORTABLE_KERNEL_FUNCTIONS).toContain(fn);
      expect(fn.name.startsWith("kernel")).toBe(true);
      expect(fn.toString().startsWith("function ")).toBe(true);
    }
  });

  it("reads the shared predicates through the map", () => {
    expect(kernelAnswerKindCode("gcds-date", "2026-02-30")).toBeNull();
    expect(kernelAnswerKindCode("gcds-date", "2026-02-30", KINDS)).toBe("date");
    expect(kernelAnswerKindCode("acme-amount", "12 kg", KINDS)).toBe("number");
    expect(kernelAnswerBounds("gcds-date", { min: "2000-01-01" }, KINDS)).toEqual({ min: "2000-01-01", max: null });
    expect(kernelIsEmptyValue({ a: false }, "x-boxes", { "x-boxes": "checkboxes" })).toBe(true);
    expect(kernelIsEmptyValue(false, "x-tick", { "x-tick": "checkbox" })).toBe(true);
    expect(kernelIsEmptyValue(false, "x-tick")).toBe(false);
  });
});

describe("a kinds-mapped date in the browser runtime", () => {
  function browser(definition: FormDefinition): FormRuntime {
    // The host builds its stage from the root alone, as every host does: the runtime hands the
    // definition's map to the stage through the context.
    return new FormRuntime(definition, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)])
    });
  }

  it("gets date validity, date bounds and the number check of its base", async () => {
    const runtime = browser(DEFINITION);
    runtime.setValue("born", "2026-02-30");
    runtime.setValue("amount", "12 kg");
    expect(codes(await runtime.validate())).toEqual(["amount:number", "born:date"]);
    runtime.setValue("born", "1899-12-31");
    runtime.setValue("amount", "12");
    expect(codes(await runtime.validate())).toEqual(["born:date.min"]);
    runtime.setValue("born", "2024-02-29");
    expect(codes(await runtime.validate())).toEqual([]);
  });

  it("gets dateIncomplete for a date typed in part, in place of required", async () => {
    const runtime = browser(DEFINITION);
    expect(codes(await runtime.validate())).toEqual(["born:required"]);
    runtime.setInputState("born", { incomplete: { missing: ["day"] } });
    const errors = await runtime.validate();
    expect(codes(errors)).toEqual(["born:dateIncomplete"]);
    expect(errors[0]?.parameters).toMatchObject({ missing: "day", missingKey: "day", missingParts: ["day"] });
  });

  it("is checked as nothing without the map, as an unknown type", async () => {
    const { kinds: _kinds, ...bare } = DEFINITION;
    const runtime = browser(bare);
    runtime.setValue("born", "2026-02-30");
    runtime.setValue("amount", "12 kg");
    expect(codes(await runtime.validate())).toEqual([]);
  });

  it("takes the stage's own kinds option over the context's, and lists the base's codes", async () => {
    const stage = createFieldConstraintsStage(ROOT, { kinds: KINDS });
    const result = await stage.validate({ formId: "f", values: { born: "2026-13-01" }, locale: "en" });
    expect(codes(result.errors)).toEqual(["born:date"]);
    expect(validationCodesRaisedBy(ROOT, KINDS)).toEqual(["required", "number", "date", "date.min", "date.max", "dateIncomplete"]);
    expect(validationCodesRaisedBy(ROOT)).toEqual(["required"]);
  });
});

describe("a kinds-mapped date in the portable kernel", () => {
  it("gets date validity and bounds from the run context's map, and nothing without it", () => {
    const values = { born: "2026-02-30", amount: "12 kg" };
    expect(codes(run({ formId: "f", values, locale: "en", form: ROOT, kinds: KINDS }).errors)).toEqual(["amount:number", "born:date"]);
    expect(codes(run({ formId: "f", values: { born: "1899-12-31" }, locale: "en", form: ROOT, kinds: KINDS }).errors)).toEqual(["born:date.min"]);
    expect(codes(run({ formId: "f", values, locale: "en", form: ROOT }).errors)).toEqual([]);
  });

  it("holds a type mapped to radio to its options, as a choice of one", () => {
    expect(kernelOptionQuestions(ROOT, (type) => kernelKindBase(type, KINDS)).questions.map((question) => [question.componentId, question.kind])).toEqual([["colour", "one"]]);
    expect(kernelOptionQuestions(ROOT).questions.map((question) => [question.componentId, question.kind])).toEqual([
      ["colour", "plugin"],
      ["nick", "plugin"]
    ]);
    const refused = run({ formId: "f", values: { born: "2024-02-29", colour: "green" }, locale: "en", form: ROOT, kinds: KINDS });
    expect(codes(refused.errors)).toEqual(["colour:option.notAllowed"]);
  });

  it("carries the map across the ABI to the in-process host, which judges as the browser's stage", async () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext({ formId: "f", values: { born: "2026-02-30" }, locale: "en", form: ROOT, kinds: { ...KINDS } }, WasmValidationHost.STRICT_POLICY);
    expect(JSON.parse(payload).kinds).toEqual(KINDS);
    const outcome = abi.deserializeOutcome(await instance.run(payload));
    expect(codes(outcome.errors)).toEqual(["born:date"]);
  });

  it("keeps prepared indexes apart per map: a cached definition run with and without one answers each alone", () => {
    const cache = kernelCreatePreparedCache(4, 1_000_000);
    const cached = (kinds: Record<string, string> | undefined) =>
      codes(run({ formId: "f", values: { born: "2024-02-29", nick: "zed" }, locale: "en", form: ROOT, ...(kinds ? { kinds } : {}) }, cache).errors);
    expect(cached({ ...KINDS })).toEqual([]);
    expect(cached(undefined)).toEqual(["nick:option.notAllowed"]);
    expect(cached({ ...KINDS })).toEqual([]);
    expect(cache.hits).toBeGreaterThan(0);
  });

  it("is refused by the browser's sandbox run the same way when the runtime submits", async () => {
    const requests: string[] = [];
    const inner = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
    const runtime = new FormRuntime(DEFINITION, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      wasmValidationHost: new WasmValidationHost([], {
        instance: { abiVersion: inner.abiVersion, run: (payload: string) => (requests.push(payload), inner.run(payload)) }
      })
    });
    runtime.setValue("born", "2026-02-30");
    const result = await runtime.submit("submit", {
      form: { id: "kinds", version: "1.0.0" },
      client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
    });
    expect(codes(result.errors)).toEqual(["born:date"]);
    expect(JSON.parse(requests[0]!).kinds).toEqual(KINDS);
  });
});

describe("the definition's kinds in the structure check", () => {
  const check = (kinds: unknown, types?: string[]) =>
    kernelStructureCheck({ id: "f", version: "1", schemaVersion: "1", root: ROOT, ...(kinds !== undefined ? { kinds } : {}) } as Record<string, unknown>, types);
  const refusals = (answer: ReturnType<typeof check>) => answer.structure.map((problem) => `${problem.code}@${problem.where}`);

  it("accepts a map of non-engine types to engine bases, and counts them as known types", () => {
    const answer = check({ ...KINDS }, ["form", "text"]);
    expect(answer.structure).toEqual([]);
    expect(answer.structureWarnings.map((problem) => problem.code)).not.toContain("definition.key.unknown");
    expect(answer.structureWarnings.map((problem) => problem.code)).not.toContain("component.type.unknown");
    // Without the map the host's list does not know them.
    expect(check(undefined, ["form", "text"]).structureWarnings.map((problem) => problem.code)).toContain("component.type.unknown");
  });

  it("refuses a base that is no engine type, an engine type re-based, a bad type name and a map that is no record", () => {
    expect(refusals(check({ "x-a": "gcds-date" }))).toEqual(["kinds.base.invalid@definition.kinds"]);
    expect(refusals(check({ "x-a": "form" }))).toEqual(["kinds.base.invalid@definition.kinds"]);
    expect(refusals(check({ "x-a": 3 }))).toEqual(["kinds.base.invalid@definition.kinds"]);
    expect(refusals(check({ date: "number" }))).toEqual(["kinds.type.engine@definition.kinds"]);
    expect(refusals(check({ "": "date" }))).toEqual(["kinds.type.invalid@definition.kinds"]);
    expect(refusals(check(["date"]))).toEqual(["kinds.invalid@definition.kinds"]);
    // Each refusal once, however many entries share it.
    expect(refusals(check({ "x-a": "nope", "x-b": "nope" }))).toEqual(["kinds.base.invalid@definition.kinds"]);
    expect(check({ "x-a": "nope" }).structure[0]?.message).not.toContain("nope");
  });
});

describe("the definition's kinds: answer bases and plain container bases only", () => {
  const check = (kinds: unknown, root = ROOT) =>
    kernelStructureCheck({ id: "f", version: "1", schemaVersion: "1", root, kinds } as Record<string, unknown>, ["form", "text"]);

  it("refuses a base that holds no answer or holds data in a tree, and accepts every value base and plain container", () => {
    for (const base of ["html", "image", "button", "container", "dataGrid", "steps", "step", "grid", "button-group", "form"]) {
      expect(check({ "x-a": base }).structure.map((problem) => problem.code), base).toEqual(["kinds.base.invalid"]);
    }
    for (const base of ["text", "textarea", "number", "date", "checkbox", "select", "radio", "checkboxes", "file", "signature", "fieldset", "panel", "tabs"]) {
      expect(check({ "x-a": base }).structure, base).toEqual([]);
    }
  });

  it("reads a mapped type as its base for the other kernel reads", () => {
    expect(kernelKindBase("x-a", { "x-a": "html" })).toBe("x-a");
    expect(kernelKindBase("x-a", { "x-a": "dataGrid" })).toBe("x-a");
    expect(kernelKindBase("x-a", { "x-a": "date" })).toBe("date");
  });

  it("reports a mapped date whose min is above its max, as it does a date", () => {
    const rootWith = (type: string) => rootOf([{ id: "d", type, configuration: { label: "D", min: "2026-12-31", max: "2026-01-01" } } as ComponentNode]);
    const codes = (answer: ReturnType<typeof check>) => answer.structureWarnings.map((problem) => problem.code);
    expect(codes(check({ "x-a": "date" }, rootWith("x-a")))).toContain("component.limits.inverted");
    expect(codes(check(undefined, rootWith("date")))).toContain("component.limits.inverted");
  });
});

describe("the definition's kinds in the agent and the PDF", () => {
  it("answers a mapped type with its base's field kind", () => {
    const model = { id: "born", type: "gcds-date", node: ROOT.children!.content![0], optionState: { items: [] }, value: null } as unknown as RenderComponentModel;
    expect(kindOfNode(model)).toBe("text");
    expect(kindOfNode(model, KINDS)).toBe("date");
  });

  it("prints a mapped type as its base, leaving the author's tree as it was", () => {
    const compiled = compilePdfDefinition(ROOT, undefined, undefined, { kinds: KINDS, formulaErrors: "warn" });
    expect(compiled.root.children!.content!.map((node) => node.type)).toEqual(["date", "number", "radio", "text"]);
    expect(ROOT.children!.content![0]!.type).toBe("gcds-date");
    expect(withBaseTypes(ROOT, {})).toBe(ROOT);
    expect(withBaseTypes(ROOT, { other: "date" })).toBe(ROOT);
  });
});

describe("a type mapped to a container base (a design system's own tabs or fieldset)", () => {
  const CONTAINER_KINDS = { "gcds-tabs": "tabs", "gcds-fieldset": "fieldset" } as const;
  const TABBED = rootOf([
    {
      id: "sections",
      type: "gcds-tabs",
      configuration: { tabs: [{ id: "you", label: "You" }, { id: "when", label: "When" }] },
      children: {
        you: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }],
        when: [{ id: "born", type: "date", configuration: { label: "Born" } }]
      }
    },
    { id: "box", type: "gcds-fieldset", configuration: { label: "Box" }, children: { content: [{ id: "note", type: "text", configuration: { label: "Note" } }] } },
    // The type with no children: a leaf of its own type, never an empty container.
    { id: "stray", type: "gcds-tabs", configuration: {} }
  ]);
  const TABBED_DEFINITION: FormDefinition = { id: "tabbed", version: "1.0.0", schemaVersion: "1.0.0", root: TABBED, kinds: { ...CONTAINER_KINDS } };

  it("is followed by the drawing alone, and only for a component that holds children", () => {
    // The answer reads read the type as itself.
    expect(kernelKindBase("gcds-tabs", CONTAINER_KINDS)).toBe("gcds-tabs");
    expect(baseTypeOf("gcds-tabs", CONTAINER_KINDS)).toBe("gcds-tabs");
    expect(kindOf("gcds-tabs", CONTAINER_KINDS)).toBeUndefined();
    expect(kernelAnswerKindCode("gcds-tabs", 3, CONTAINER_KINDS)).toBeNull();
    expect(kernelIsEmptyValue(false, "gcds-tabs", CONTAINER_KINDS)).toBe(kernelIsEmptyValue(false, "gcds-tabs"));
    // The drawing reads its container base; an answer base is no container base, nor the other way round.
    expect(kernelContainerBase("gcds-tabs", CONTAINER_KINDS)).toBe("tabs");
    expect(containerBaseOf("gcds-fieldset", CONTAINER_KINDS)).toBe("fieldset");
    expect(containerBaseOf("gcds-date", KINDS)).toBe("gcds-date");
    expect(kernelContainerBase("x-a", { "x-a": "container" })).toBe("x-a");
    expect(drawnBaseOf({ type: "gcds-tabs", children: {} }, CONTAINER_KINDS)).toBe("tabs");
    expect(drawnBaseOf({ type: "gcds-tabs" }, CONTAINER_KINDS)).toBe("gcds-tabs");
    expect(drawnBaseOf({ type: "gcds-date" }, KINDS)).toBe("date");
    expect(drawnBaseOf({ type: "tabs", children: {} }, { tabs: "fieldset" })).toBe("tabs");
  });

  it("validates the same with the map as without it, in the browser stage and the kernel", async () => {
    const browserCodes = async (definition: FormDefinition) => {
      const runtime = new FormRuntime(definition, { submissionModes: modes(), validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
      runtime.setValue("born", "2026-02-30");
      return codes(await runtime.validate());
    };
    const { kinds: _kinds, ...bare } = TABBED_DEFINITION;
    expect(await browserCodes(TABBED_DEFINITION)).toEqual(["born:date", "name:required"]);
    expect(await browserCodes(TABBED_DEFINITION)).toEqual(await browserCodes(bare));
    const kernelCodes = (kinds?: Record<string, string>) =>
      codes(run({ formId: "f", values: { born: "2026-02-30", stray: "kept as before" }, locale: "en", form: TABBED, ...(kinds ? { kinds } : {}) }).errors);
    expect(kernelCodes({ ...CONTAINER_KINDS })).toEqual(kernelCodes(undefined));
    expect(kernelCodes({ ...CONTAINER_KINDS })).toEqual(["born:date", "name:required"]);
  });

  it("folds as its container base in the presentation tree, its declared tabs in order", async () => {
    const runtime = new FormRuntime(TABBED_DEFINITION, { submissionModes: modes(), validationPipeline: new ValidationPipeline([]) });
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    const tree = foldPresentation(output, { locale: "en", kinds: TABBED_DEFINITION.kinds });
    const [tabs, box, stray] = tree.nodes;
    expect(tabs).toMatchObject({ kind: "tabs", id: "sections", type: "gcds-tabs", base: "tabs" });
    expect(tabs?.kind === "tabs" ? tabs.tabs.map((tab) => [tab.slotId, tab.label]) : []).toEqual([["you", "You"], ["when", "When"]]);
    expect(box).toMatchObject({ kind: "group", id: "box", type: "gcds-fieldset", base: "fieldset", legend: "Box" });
    expect(stray).toMatchObject({ kind: "field", id: "stray", type: "gcds-tabs", base: "gcds-tabs" });
    expect(tree.unknownContainers).toEqual([]);
    // Without the map the same containers are unknown to the engine, reported, and still drawn whole.
    const bare = foldPresentation(output, { locale: "en" });
    expect(bare.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual(["group:sections", "group:box", "field:stray"]);
    expect(bare.unknownContainers.map((entry) => entry.componentId)).toEqual(["sections", "box"]);
  });

  it("prints as its container base in the PDF model when it holds children", () => {
    const compiled = compilePdfDefinition(TABBED, undefined, undefined, { kinds: { ...CONTAINER_KINDS }, formulaErrors: "warn" });
    expect(compiled.root.children!.content!.map((node) => node.type)).toEqual(["tabs", "fieldset", "gcds-tabs"]);
    expect(TABBED.children!.content![0]!.type).toBe("gcds-tabs");
  });
});
