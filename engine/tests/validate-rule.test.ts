import { describe, expect, it } from "vitest";

import { kernelCompileRules, publicDefinition } from "../form-engine/core/expressions/compile.js";
import { kernelInspectAbi as kernelInspectAbiValue } from "../form-engine/core/expressions/inspect.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import {
  DEFAULT_VALIDATION_MESSAGES,
  ENGINE_VALIDATION_CODES,
  readValidationMessages,
  resolveValidationMessage
} from "../form-engine/core/localization/validation-messages.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime, FormulaError } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage, validationCodesRaisedBy } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost, type WasmSubmissionContext } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";

/**
 * The Validate rule kind. `rules.validWhen` (true = the answer is acceptable) on the
 * field it checks, `configuration.messages.rule` its words, the code `rule`, read by the shared
 * fold on both sides so the browser, the sandbox and a server reach one verdict.
 */

const ENVELOPE = {
  form: { id: "checks", version: "1.0.0" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
};

function formRoot(children: ComponentNode[], configuration: Record<string, unknown> = {}): ComponentNode {
  return { id: "root", type: "form", configuration, children: { content: children } };
}

function definitionOf(children: ComponentNode[], configuration: Record<string, unknown> = {}): FormDefinition {
  return { id: "checks", version: "1.0.0", schemaVersion: "1.0.0", root: formRoot(children, configuration) };
}

function codes(errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
}

function modes(): SubmissionModeRegistry {
  const registry = new SubmissionModeRegistry();
  registry.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  registry.register({ id: "send", validate: false, sign: false, serverValidation: false });
  return registry;
}

/** A browser: the field-constraints stage, and, with `sandboxed`, the in-process kernel as its sandbox. */
function browser(form: FormDefinition, options: { sandboxed?: boolean; formulaErrors?: "warn" | "fail"; hostContext?: Record<string, unknown> } = {}): FormRuntime {
  return new FormRuntime(form, {
    submissionModes: modes(),
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    ...(options.sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {}),
    ...(options.formulaErrors ? { formulaErrors: options.formulaErrors } : {}),
    ...(options.hostContext ? { hostContext: options.hostContext } : {})
  });
}

const DATES: FormDefinition = {
  ...definitionOf([
    { id: "start_date", type: "date", configuration: { label: "Start" } },
    {
      id: "end_date",
      type: "date",
      configuration: { label: "End", messages: { rule: "The end is on or after the start." } },
      rules: { validWhen: "end_date >= start_date" }
    }
  ]),
  // The rule message in French lives in the definition's map.
  translations: { fr: { components: { end_date: { messages: { rule: { text: "La fin suit le début.", source: "17kde8i" } } } } } }
};

/** The fixture matrix: one form, several checks, each kind of answer. */
const MATRIX_FORM = definitionOf([
  { id: "start_date", type: "date", configuration: { label: "Start" } },
  { id: "end_date", type: "date", configuration: { label: "End" }, rules: { validWhen: "end_date >= start_date" } },
  { id: "share_a", type: "number", configuration: { label: "Share A" } },
  { id: "share_b", type: "number", configuration: { label: "Share B" }, rules: { validWhen: "share_a + share_b = 100" } },
  { id: "email", type: "text", configuration: { label: "Email" } },
  {
    id: "confirm",
    type: "text",
    // A pattern beside the check: the pattern speaks first, one error per field.
    configuration: { label: "Confirm", pattern: "[^ ]+" },
    rules: { validWhen: { formula: "confirm = email", run: "both" } }
  },
  { id: "show_extra", type: "checkbox", configuration: { label: "More" } },
  {
    id: "extra",
    type: "text",
    configuration: { label: "Extra" },
    rules: { visibleWhen: "show_extra = true", validWhen: "extra = \"ok\"" }
  }
]);

const MATRIX: Array<{ name: string; answers: Record<string, unknown>; expected: string[] }> = [
  { name: "nothing answered", answers: {}, expected: [] },
  { name: "all good", answers: { start_date: "2026-01-01", end_date: "2026-01-02", share_a: 40, share_b: 60, email: "a@b.c", confirm: "a@b.c" }, expected: [] },
  { name: "the same day holds", answers: { start_date: "2026-01-01", end_date: "2026-01-01" }, expected: [] },
  { name: "end before start", answers: { start_date: "2026-01-05", end_date: "2026-01-02" }, expected: ["end_date:rule"] },
  { name: "end without a start", answers: { end_date: "2026-01-02" }, expected: ["end_date:rule"] },
  { name: "shares off", answers: { share_a: 40, share_b: 50 }, expected: ["share_b:rule"] },
  { name: "shares as numerals", answers: { share_a: "40", share_b: "60" }, expected: [] },
  { name: "confirmation differs", answers: { email: "a@b.c", confirm: "a@b.d" }, expected: ["confirm:rule"] },
  { name: "the pattern speaks first", answers: { email: "a b", confirm: "x y" }, expected: ["confirm:pattern"] },
  { name: "the kind speaks first", answers: { start_date: "2026-01-05", end_date: "2026-02-31" }, expected: ["end_date:date"] },
  { name: "a hidden check is not read", answers: { show_extra: false, extra: "nope" }, expected: [] },
  { name: "a shown check is", answers: { show_extra: true, extra: "nope" }, expected: ["extra:rule"] },
  { name: "every check at once", answers: { start_date: "2026-01-05", end_date: "2026-01-02", share_a: 1, share_b: 1, email: "a@b.c", confirm: "c@d.e", show_extra: true, extra: "x" }, expected: ["confirm:rule", "end_date:rule", "extra:rule", "share_b:rule"] }
];

describe("the rule's shape", () => {
  const signatures = formulaFunctionSignatures();
  const compile = (rules: Record<string, unknown>): { compiled: Record<string, unknown>; problems: FormulaProblem[] } => {
    const problems: FormulaProblem[] = [];
    return { compiled: kernelCompileRules(rules, "rules:f", true, kernelParseFormula, signatures, problems), problems };
  };

  it("accepts a formula and the object form, a server scope included, and refuses a tree as never holding", () => {
    const tree = { kind: "binary", operator: "gt", left: { kind: "path", path: "component" }, right: { kind: "literal", value: 1 } };
    expect(compile({ validWhen: "component > 1" })).toEqual({ compiled: { validWhen: tree }, problems: [] });
    expect(compile({ validWhen: { formula: "component > 1", run: "server-secret" } })).toEqual({
      compiled: { validWhen: { expression: tree, run: "server-secret" } },
      problems: []
    });
    const written = compile({ validWhen: tree });
    expect(written.problems.map((problem) => [problem.code, problem.params])).toEqual([["invalidRule", { key: "validWhen", got: "tree" }]]);
    expect(written.compiled.validWhen).toEqual({ expression: { kind: "literal", value: false } });
  });

  it("refuses a value of none of the shapes, and fails closed on it and on a formula that does not parse", () => {
    const shaped = compile({ validWhen: 5 });
    expect(shaped.problems.map((problem) => problem.code)).toEqual(["invalidRule"]);
    expect(shaped.compiled.validWhen).toEqual({ expression: { kind: "literal", value: false } });
    const unparsed = compile({ validWhen: { formula: "end_date >=", run: "server" } });
    expect(unparsed.problems).toHaveLength(1);
    expect(unparsed.compiled.validWhen).toEqual({ expression: { kind: "literal", value: false }, run: "server" });
    // Any other key that does not parse is still dropped, and a blank check is no check.
    expect(compile({ requiredWhen: "end_date >=" }).compiled).toEqual({});
    expect(compile({ validWhen: null }).compiled).toEqual({});
  });

  it("names the code for the builder: the engine's codes, the field's codes and the default wording", () => {
    expect(ENGINE_VALIDATION_CODES.some((entry) => entry.code === "rule")).toBe(true);
    expect(validationCodesRaisedBy(DATES.root)).toEqual(["date", "dateIncomplete", "rule"]);
    expect(DEFAULT_VALIDATION_MESSAGES.rule).toBe("Check this answer");
  });

  it("is sandbox ABI 1.0.0, and inspect answers the same", () => {
    expect(WASM_ABI_VERSION).toBe("1.0.0");
    expect(kernelInspectAbiValue()).toBe(WASM_ABI_VERSION);
  });
});

describe("the browser runtime", () => {
  it("refuses an answer the check does not accept, and clears it once the answer is fixed", async () => {
    const runtime = browser(DATES);
    runtime.setValue("start_date", "2026-01-10");
    runtime.setValue("end_date", "2026-01-05");
    const refused = await runtime.validate();
    expect(codes(refused)).toEqual(["end_date:rule"]);
    expect(refused[0]).toMatchObject({ code: "rule", componentId: "end_date", stage: "field-constraints", source: "client" });
    // The stage's own error, before the store: the field's path, no parameters.
    const stage = createFieldConstraintsStage(DATES.root);
    const raw = stage.validate({ formId: "f", values: { start_date: "2026-01-10", end_date: "2026-01-05" }, locale: "en", invalidComponents: { end_date: true } } as Parameters<typeof stage.validate>[0]);
    expect(raw).toEqual({ errors: [{ code: "rule", componentId: "end_date", path: "end_date", stage: "field-constraints", source: "client" }] });
    // Without the map (a host running the stage outside FormRuntime), no rule: the sandbox still holds it.
    expect(stage.validate({ formId: "f", values: { end_date: "2026-01-05" }, locale: "en" })).toEqual({ errors: [] });
    runtime.setValue("end_date", "2026-01-20");
    expect(await runtime.validate()).toEqual([]);
  });

  it("never checks an empty answer: whether one is needed is Required's question", async () => {
    const runtime = browser(DATES);
    runtime.setValue("start_date", "2026-01-10");
    expect(await runtime.validate()).toEqual([]);
    runtime.setValue("end_date", "");
    expect(await runtime.validate()).toEqual([]);
  });

  it("words the error from the field's messages.rule, else the engine's wording", () => {
    const field = DATES.root.children!.content![1]!;
    const catalogIn = (locale: string) => readValidationMessages(field.configuration, { ownerId: field.id, locale, sources: { translations: DATES.translations } });
    expect(resolveValidationMessage({ code: "rule" }, catalogIn("en"), "en")).toBe("The end is on or after the start.");
    expect(resolveValidationMessage({ code: "rule" }, catalogIn("fr"), "fr")).toBe("La fin suit le début.");
    expect(resolveValidationMessage({ code: "rule" }, undefined, "en")).toBe("Check this answer");
    // The engine words only English; a form's `texts` translations word it in another language.
    expect(resolveValidationMessage({ code: "rule" }, undefined, "fr-CA")).toBe("Check this answer");
    const words = { translations: { fr: { texts: { messages: { rule: { text: "Vérifiez cette réponse", source: "x" } } } } } };
    expect(resolveValidationMessage({ code: "rule" }, undefined, "fr-CA", words)).toBe("Vérifiez cette réponse");
  });

  it("blocks a submit, the in-process sandbox agreeing", async () => {
    for (const sandboxed of [false, true]) {
      const runtime = browser(DATES, { sandboxed });
      runtime.setValue("start_date", "2026-01-10");
      runtime.setValue("end_date", "2026-01-05");
      const refused = await runtime.submit("submit", ENVELOPE);
      expect(refused.accepted).toBe(false);
      expect(codes(refused.errors)).toEqual(["end_date:rule"]);
    }
  });

  it("reads the check where requiredWhen is read: not on a group, not on a row field", async () => {
    const form = definitionOf([
      {
        id: "group",
        type: "fieldset",
        configuration: {},
        rules: { validWhen: "false" },
        children: { content: [{ id: "inside", type: "text", configuration: {} }] }
      },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: {}, rules: { validWhen: "false" } }] }
      }
    ] as ComponentNode[]);
    const runtime = browser(form);
    runtime.setValue("inside", "x");
    runtime.setValue("items[0].sku", "x");
    expect(await runtime.validate()).toEqual([]);
    expect(runKernel({ formId: "checks", values: { inside: "x", "items[0].sku": "x" }, locale: "en", form: form.root }, []).errors).toEqual([]);
  });

  it("works the check out in the builder's preview runtime too (Try it's fold)", () => {
    const preview = new BuilderPreviewRuntime(DATES.root, { locale: "en" });
    preview.setValue("start_date", "2026-01-10");
    preview.setValue("end_date", "2026-01-05");
    expect(preview.invalidMap()).toEqual({ end_date: true });
    preview.setValue("end_date", "2026-01-11");
    expect(preview.invalidMap()).toEqual({});
  });
});

describe("browser and server parity over a fixture matrix", () => {
  const abi = new JsonWasmAbi();

  for (const entry of MATRIX) {
    it(entry.name, async () => {
      // The browser alone, its stage over the fold's `invalid`.
      const alone = browser(MATRIX_FORM);
      for (const [key, value] of Object.entries(entry.answers)) {
        alone.setValue(key, value);
      }
      const browserErrors = codes(await alone.validate());
      expect(browserErrors).toEqual(entry.expected);

      // The kernel over the answers directly, and across the JSON ABI as a sandbox host runs it.
      const context = { formId: "checks", values: entry.answers, locale: "en", form: MATRIX_FORM.root };
      const direct = runKernel(context, []);
      expect(codes(direct.errors)).toEqual(entry.expected);
      const crossed = abi.deserializeOutcome(
        new InProcessWasmHostAdapter().instantiate([], abi).run(abi.serializeContext(context, WasmValidationHost.STRICT_POLICY)) as string
      );
      expect(codes(crossed.errors)).toEqual(entry.expected);
      expect(direct.errors.filter((error) => error.code === "rule").every((error) => error.source === "wasm" && error.stage === "field-constraints")).toBe(true);

      // The browser with its sandbox, submitting: the same verdict, nothing extra from the server.
      const sandboxed = browser(MATRIX_FORM, { sandboxed: true });
      for (const [key, value] of Object.entries(entry.answers)) {
        sandboxed.setValue(key, value);
      }
      const submitted = await sandboxed.submit("submit", ENVELOPE);
      expect(codes(submitted.errors)).toEqual(entry.expected);
      expect(submitted.accepted).toBe(entry.expected.length === 0);
    });
  }

  it("never hands the sandbox the browser's invalidComponents", () => {
    const context = { formId: "f", values: {}, form: DATES.root, invalidComponents: { end_date: true } } as WasmSubmissionContext;
    expect(JSON.parse(abi.serializeContext(context, WasmValidationHost.STRICT_POLICY))).toEqual({ formId: "f", values: {}, form: JSON.parse(JSON.stringify(DATES.root)) });
  });
});

describe("run scopes and what the server cannot replay", () => {
  const scoped = (run: "server" | "browser"): FormDefinition =>
    definitionOf([{ id: "code", type: "text", configuration: {}, rules: { validWhen: { formula: "code = \"A\"", run } } }]);

  it("a server rule is the server's alone, a browser rule the browser's", async () => {
    const server = scoped("server");
    const runtime = browser(server);
    runtime.setValue("code", "B");
    expect(await runtime.validate()).toEqual([]);
    expect(codes(runKernel({ formId: "checks", values: { code: "B" }, locale: "en", form: server.root }, []).errors)).toEqual(["code:rule"]);

    const local = scoped("browser");
    const own = browser(local);
    own.setValue("code", "B");
    expect(codes(await own.validate())).toEqual(["code:rule"]);
    expect(runKernel({ formId: "checks", values: { code: "B" }, locale: "en", form: local.root }, []).errors).toEqual([]);
  });

  it("a secret check is the server's and is stripped from the definition a browser is served", () => {
    const secret = definitionOf([{ id: "code", type: "text", configuration: {}, rules: { validWhen: { formula: "code = \"A\"", run: "server-secret" } } }]);
    const served = publicDefinition(secret);
    expect(served.root.children!.content![0]!.rules).toEqual({});
    expect(codes(runKernel({ formId: "checks", values: { code: "B" }, locale: "en", form: secret.root }, []).errors)).toEqual(["code:rule"]);
  });

  it("a check reading host. holds on the server, which has no host to read", async () => {
    const form = definitionOf([{ id: "code", type: "text", configuration: {}, rules: { validWhen: "code = host.expected" } }]);
    const runtime = browser(form, { hostContext: { expected: "A" } });
    runtime.setValue("code", "B");
    expect(codes(await runtime.validate())).toEqual(["code:rule"]);
    expect(runKernel({ formId: "checks", values: { code: "B" }, locale: "en", form: form.root }, []).errors).toEqual([]);
  });
});

describe("a check that cannot be read fails closed", () => {
  const broken = definitionOf([{ id: "code", type: "text", configuration: {}, rules: { validWhen: "code = " } }]);

  it("under fail, the browser refuses to open the form and the server refuses the submission", () => {
    expect(() => browser(broken)).toThrow(FormulaError);
    const outcome = runKernel({ formId: "checks", values: { code: "A" }, locale: "en", form: broken.root }, []);
    expect(codes(outcome.errors)).toEqual(["-:formula.invalid"]);
  });

  it("under warn, every non-empty answer is refused on both sides; an empty one is not checked", async () => {
    const runtime = browser(broken, { formulaErrors: "warn" });
    runtime.setValue("code", "A");
    expect(codes(await runtime.validate())).toEqual(["code:rule"]);
    runtime.setValue("code", "");
    expect(await runtime.validate()).toEqual([]);
    const outcome = runKernel({ formId: "checks", values: { code: "A" }, locale: "en", form: broken.root, formulaErrors: "warn" }, []);
    expect(codes(outcome.errors)).toEqual(["code:rule"]);
    expect(runKernel({ formId: "checks", values: {}, locale: "en", form: broken.root, formulaErrors: "warn" }, []).errors).toEqual([]);
  });

  it("a check that comes to no yes-or-no does not hold", async () => {
    const form = definitionOf([{ id: "code", type: "text", configuration: {}, rules: { validWhen: "code" } }]);
    const runtime = browser(form);
    runtime.setValue("code", "A");
    expect(codes(await runtime.validate())).toEqual(["code:rule"]);
    expect(codes(runKernel({ formId: "checks", values: { code: "A" }, locale: "en", form: form.root }, []).errors)).toEqual(["code:rule"]);
  });
});
