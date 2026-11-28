import { describe, expect, it } from "vitest";

import {
  ANSWER_KIND_FUNCTIONS,
  kernelAnswerKindCode,
  kernelIsDateAnswer,
  kernelIsNumberAnswer,
  type FieldInputState
} from "../form-engine/core/schema/answer-kinds.js";
import { DEFAULT_VALIDATION_MESSAGES, resolveValidationMessage } from "../form-engine/core/localization/validation-messages.js";
import type { ValidationContext } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage, validationCodesRaisedBy } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import {
  PORTABLE_KERNEL_FUNCTIONS,
  kernelRunFieldConstraints,
  runKernel as kernelRun,
  type KernelOutcome
} from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WasmValidationHost, type WasmSubmissionContext } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { APPLY_BELOW, applyJourney, presentationRoot } from "./fixtures/presentation-form.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

// A host hands the kernel the function table's signatures, as the in-process and sandbox hosts
// do: a tree's calls are checked against them like a formula's. These runs do the same.
const runKernel = (
  context: Parameters<typeof kernelRun>[0],
  validators: Parameters<typeof kernelRun>[1],
  functions?: Parameters<typeof kernelRun>[2],
  signatures: Parameters<typeof kernelRun>[3] = formulaFunctionSignatures(),
  cache?: Parameters<typeof kernelRun>[4]
): ReturnType<typeof kernelRun> => kernelRun(context, validators, functions, signatures, cache);

/**
 * A number component's answer is a number and a date component's a real date, on
 * every side — the browser's field-constraints stage and the validation kernel through one
 * predicate — and what only a control knows (a date typed in part, a number box the browser
 * could not read) is said in the browser alone, in place of `required`.
 */

// --- The predicates, and the stage and the kernel over them -------------------------------------

/**
 * The rounding midpoint above the largest double, as a 309-digit numeral: V8 reads it as
 * `Infinity`, QuickJS as the largest finite double. Judged by its spelling, it passes everywhere.
 */
const MIDPOINT =
  "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";

/** [value, passes] for a number component: finite numbers and decimal numerals (spaces around allowed) pass; NaN, the infinities, other spellings, booleans, lists and objects do not. */
const NUMBERS: Array<[unknown, boolean]> = [
  [12, true],
  [-3.5, true],
  ["12", true],
  [" 7 ", true],
  ["1e3", true],
  [".5", true],
  ["-0", true],
  ["+4.", true],
  // Spelling alone decides: a numeral too large for a double is still a numeral.
  ["1e999", true],
  [MIDPOINT, true],
  [`-${MIDPOINT}`, true],
  ["abc", false],
  ["1,000", false],
  ["12 kg", false],
  ["0x10", false],
  ["0b11", false],
  ["1_000", false],
  ["Infinity", false],
  ["", false],
  ["  ", false],
  [Number.NaN, false],
  [Number.POSITIVE_INFINITY, false],
  [true, false],
  [[], false],
  [{}, false]
];

/** [value, passes] for a date component. */
const DATES: Array<[unknown, boolean]> = [
  ["2024-02-29", true],
  ["2000-02-29", true],
  ["0005-01-01", true],
  ["9999-12-31", true],
  ["2023-02-29", false],
  ["1900-02-29", false],
  ["2026-02-31", false],
  ["2026-02-45", false],
  ["2026-04-31", false],
  ["2026-13-01", false],
  ["2026-00-10", false],
  ["2026-01-00", false],
  ["2026-abc-12", false],
  ["2026-2-3", false],
  ["0000-01-01", false],
  ["2026-02-03T00:00:00Z", false],
  [" 2026-02-03", false],
  [20260203, false],
  [null, false],
  [{}, false]
];

describe("the number and date predicates", () => {
  it("reads a number answer by the number rule", () => {
    expect(MIDPOINT).toHaveLength(309);
    for (const [value, passes] of NUMBERS) {
      expect(kernelIsNumberAnswer(value), JSON.stringify(value) ?? String(value)).toBe(passes);
    }
  });

  it("judges a numeral by its spelling, never by what this engine parses it to", () => {
    // V8 reads the midpoint as Infinity; the verdict does not follow it (QuickJS reads it finite).
    expect(Number.isFinite(Number(MIDPOINT))).toBe(false);
    expect(kernelIsNumberAnswer(MIDPOINT)).toBe(true);
    // A stored JS number must still be finite.
    expect(kernelIsNumberAnswer(Number(MIDPOINT))).toBe(false);
  });

  it("reads a date answer as a real YYYY-MM-DD calendar date, Gregorian leap years and all", () => {
    for (const [value, passes] of DATES) {
      expect(kernelIsDateAnswer(value), JSON.stringify(value)).toBe(passes);
    }
  });

  it("checks the built-in number and date types only, by their own code", () => {
    expect(kernelAnswerKindCode("number", "abc")).toBe("number");
    expect(kernelAnswerKindCode("number", "12")).toBeNull();
    expect(kernelAnswerKindCode("date", "2026-02-31")).toBe("date");
    expect(kernelAnswerKindCode("date", "2026-02-28")).toBeNull();
    // A plugin's type (a GCDS input, say) is nobody's to check here; a text is a string.
    expect(kernelAnswerKindCode("gcds-input", "abc")).toBeNull();
    expect(kernelAnswerKindCode("gcds-input", 12)).toBeNull();
    expect(kernelAnswerKindCode("text", "abc")).toBeNull();
    expect(kernelAnswerKindCode("text", 12)).toBe("text");
    expect(kernelAnswerKindCode("textarea", { a: 1 })).toBe("text");
    // `undefined` is never an answer: what says whether a type is checked at all.
    expect(kernelAnswerKindCode("number", undefined)).toBe("number");
    expect(kernelAnswerKindCode("date", undefined)).toBe("date");
    expect(kernelAnswerKindCode("textarea", undefined)).toBe("text");
    expect(kernelAnswerKindCode("checkbox", undefined)).toBeNull();
  });

  it("is spliced into the sandbox program: every predicate is a top-level kernel function the kernel lists", () => {
    for (const fn of ANSWER_KIND_FUNCTIONS) {
      expect(PORTABLE_KERNEL_FUNCTIONS).toContain(fn);
      expect(fn.name.startsWith("kernel")).toBe(true);
      expect(fn.toString().startsWith("function ")).toBe(true);
    }
  });

  it("gives the stage and the kernel one verdict on every value of both tables, empties to required alone", () => {
    const root: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "amount", type: "number", configuration: { required: true } },
          { id: "when", type: "date", configuration: { required: true } }
        ]
      }
    };
    const stage = createFieldConstraintsStage(root);
    const clientCodes = (values: Record<string, unknown>): string[] =>
      (stage.validate({ formId: "f", values, locale: "en" }) as { errors: Array<{ componentId?: string; code: string }> }).errors.map(
        (error) => `${error.componentId}:${error.code}`
      );
    const kernelCodes = (values: Record<string, unknown>): string[] =>
      kernelRunFieldConstraints(root, values, "en").map((error) => `${error.componentId}:${error.code}`);
    for (const [value, passes] of NUMBERS) {
      const values = { amount: value, when: "2026-02-03" };
      const label = `number ${JSON.stringify(value) ?? String(value)}`;
      expect(clientCodes(values), label).toEqual(kernelCodes(values));
      const empty = value === "" || value === "  " || (typeof value === "number" && !Number.isFinite(value)) || (Array.isArray(value) && value.length === 0);
      expect(clientCodes(values), label).toEqual(passes ? [] : empty ? ["amount:required"] : ["amount:number"]);
    }
    for (const [value, passes] of DATES) {
      const values = { amount: 1, when: value };
      const label = `date ${JSON.stringify(value)}`;
      expect(clientCodes(values), label).toEqual(kernelCodes(values));
      expect(clientCodes(values), label).toEqual(passes ? [] : value === null ? ["when:required"] : ["when:date"]);
    }
  });

  it("tells a number that is not one before its length or its pattern, on both sides", () => {
    const root: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "code", type: "number", configuration: { maxLength: 2, pattern: "[0-9]+" } }] }
    };
    const stage = createFieldConstraintsStage(root);
    for (const [value, code] of [["abcdef", "number"], ["123", "maxLength"], ["1.", "pattern"], ["12", undefined]] as const) {
      const client = (stage.validate({ formId: "f", values: { code: value }, locale: "en" }) as { errors: Array<{ code: string }> }).errors;
      const kernel = kernelRunFieldConstraints(root, { code: value }, "en");
      expect(client.map((error) => error.code), value).toEqual(code === undefined ? [] : [code]);
      expect(kernel.map((error) => error.code), value).toEqual(code === undefined ? [] : [code]);
    }
  });
});

// --- The stage: what it raises, and what it says in place of required ------------------------

function formRoot(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

type StageError = { code: string; componentId?: string; path?: string; stage: string; source: string; parameters?: Record<string, unknown> };

function stageErrors(root: ComponentNode, values: Record<string, unknown>, inputStates?: ValidationContext["inputStates"]): StageError[] {
  const context: ValidationContext = { formId: "f", values, locale: "en", ...(inputStates !== undefined ? { inputStates } : {}) };
  return (createFieldConstraintsStage(root).validate(context) as { errors: StageError[] }).errors;
}

describe("the field-constraints stage: number, date and dateIncomplete", () => {
  const root = formRoot([
    { id: "age", type: "number", configuration: { label: "Age" } },
    { id: "born", type: "date", configuration: { label: "Born", required: true } },
    { id: "count", type: "number", configuration: { required: true } }
  ]);

  it("raises number and date for answers that are not one, as the client, and clears them once they are", () => {
    expect(stageErrors(root, { age: "abc", born: "2026-02-31", count: 3 })).toEqual([
      { code: "number", componentId: "age", path: "age", stage: "field-constraints", source: "client" },
      { code: "date", componentId: "born", path: "born", stage: "field-constraints", source: "client" }
    ]);
    expect(stageErrors(root, { age: "12", born: "2026-02-28", count: 3 })).toEqual([]);
  });

  it("collects every number and date component, constraints or none", () => {
    expect(stageErrors(formRoot([{ id: "plain", type: "number", configuration: {} }]), { plain: "x" }).map((error) => error.code)).toEqual(["number"]);
  });

  it("says number, marked badInput, for a number box the browser could not read — in place of required, with or without it", () => {
    const states = { age: { badInput: true }, count: { badInput: true } } as const;
    expect(stageErrors(root, { age: "", born: "2026-02-28" }, states)).toEqual([
      { code: "number", componentId: "age", path: "age", stage: "field-constraints", source: "client", parameters: { badInput: true } },
      { code: "number", componentId: "count", path: "count", stage: "field-constraints", source: "client", parameters: { badInput: true } }
    ]);
    // An answer there after all: the state says nothing, the answer is judged.
    expect(stageErrors(root, { age: 4, born: "2026-02-28", count: 2 }, states)).toEqual([]);
    // A badInput state on a date (the browser's date box typed in part) says date, marked the same way.
    expect(stageErrors(root, { born: "" }, { born: { badInput: true } }).map((error) => [error.code, error.parameters])).toEqual([
      ["date", { badInput: true }],
      ["required", undefined]
    ]);
  });

  it("says dateIncomplete, naming the parts left in day-month-year order, in place of required — or of nothing", () => {
    const cases: Array<[Array<"day" | "month" | "year">, string, string, string[]]> = [
      [["day"], "day", "day", ["day"]],
      [["month"], "month", "month", ["month"]],
      [["year"], "year", "year", ["year"]],
      [["month", "day"], "day and month", "day-month", ["day", "month"]],
      [["year", "day"], "day and year", "day-year", ["day", "year"]],
      [["year", "month", "month"], "month and year", "month-year", ["month", "year"]]
    ];
    for (const [missing, phrase, key, parts] of cases) {
      const errors = stageErrors(root, { born: "", count: 1 }, { born: { incomplete: { missing } } });
      expect(errors, key).toEqual([
        {
          code: "dateIncomplete",
          componentId: "born",
          path: "born",
          stage: "field-constraints",
          source: "client",
          parameters: { missing: phrase, missingKey: key, missingParts: parts }
        }
      ]);
    }
    // An optional date typed in part is told too.
    const optional = formRoot([{ id: "when", type: "date", configuration: {} }]);
    expect(stageErrors(optional, {}, { when: { incomplete: { missing: ["year"] } } }).map((error) => error.code)).toEqual(["dateIncomplete"]);
    // Every part missing is simply empty; none missing, or not a date, says nothing more.
    expect(stageErrors(root, { count: 1 }, { born: { incomplete: { missing: ["day", "month", "year"] } } }).map((error) => error.code)).toEqual(["required"]);
    expect(stageErrors(root, { count: 1 }, { born: { incomplete: { missing: [] } } }).map((error) => error.code)).toEqual(["required"]);
    expect(stageErrors(root, { born: "2026-01-01" }, { count: { incomplete: { missing: ["year"] } } }).map((error) => error.code)).toEqual(["required"]);
  });

  it("reads the input states by their own keys only", () => {
    const named = formRoot([{ id: "constructor", type: "date", configuration: { required: true } }]);
    const inherited = Object.create({ constructor: { incomplete: { missing: ["year"] } } }) as ValidationContext["inputStates"];
    expect(stageErrors(named, {}, inherited).map((error) => error.code)).toEqual(["required"]);
    expect(stageErrors(named, {}, { constructor: { incomplete: { missing: ["year" as const] } } }).map((error) => error.code)).toEqual(["dateIncomplete"]);
  });

  it("reads a field of a repeating section entry by entry: the browser and the kernel at each entry's key, a bare key by neither", () => {
    const section = formRoot([
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["qty", "sku"], collectionPath: "items" },
        children: {
          content: [
            { id: "qty", type: "number", configuration: {} },
            { id: "sku", type: "text", configuration: { pattern: "[A-Z]+" } }
          ]
        }
      }
    ]);
    const where = (errors: ReadonlyArray<{ componentId?: string | undefined; code: string; path?: string | undefined }>) =>
      errors.map((error) => `${error.componentId}:${error.code}@${error.path}`);
    // An entry's answers are held to the field's checks at the entry's own key.
    const entries = { "items[0].qty": "abc", "items[0].sku": "abc", "items[1].qty": "12", "items[1].sku": "ABC" };
    const expected = ["qty:number@items[0].qty", "sku:pattern@items[0].sku"];
    expect(where(stageErrors(section, entries))).toEqual(expected);
    expect(where(kernelRunFieldConstraints(section, entries, "en"))).toEqual(expected);
    expect(where(runKernel({ formId: "f", values: entries, locale: "en", form: section }, []).errors)).toEqual(expected);
    // The bare keys are no keys the form defines for a section's entries: the kernel strips them (and
    // accepts) or refuses them as unknown, before any check; the browser's stage does not read them.
    const bare = { qty: "abc", sku: "abc" };
    expect(stageErrors(section, bare)).toEqual([]);
    const context = { formId: "f", values: bare, locale: "en", form: section };
    expect(runKernel(context, [])).toEqual({ errors: [], values: {}, index: [] });
    expect(codes(runKernel({ ...context, unknownFields: "reject" as const }, []).errors)).toEqual(["-:unknown_field", "-:unknown_field"]);
    expect(runKernel({ ...context, unknownFields: "reject" as const }, []).errors.map((error) => error.parameters?.field)).toEqual(["qty", "sku"]);
    // Rows posted whole are the same entries.
    const whole = { items: [{ qty: "abc", sku: "abc" }] };
    expect(where(runKernel({ ...context, values: whole }, []).errors)).toEqual(expected);
  });

  it("lists number for a number, date, dateIncomplete and date.year for a date, for the messages editor", () => {
    expect(validationCodesRaisedBy({ id: "n", type: "number", configuration: {} })).toEqual(["number"]);
    expect(validationCodesRaisedBy({ id: "n", type: "number", configuration: { required: true } })).toEqual(["required", "number"]);
    expect(validationCodesRaisedBy({ id: "d", type: "date", configuration: {} })).toEqual(["date", "dateIncomplete", "date.year"]);
    expect(validationCodesRaisedBy(root)).toEqual(["required", "number", "date", "dateIncomplete", "date.year"]);
    expect(validationCodesRaisedBy({ id: "t", type: "text", configuration: {} })).toEqual([]);
  });

  it("words each code in English when nothing else does, dateIncomplete's phrase within reach", () => {
    expect(DEFAULT_VALIDATION_MESSAGES.number).toBe("Enter a number");
    expect(DEFAULT_VALIDATION_MESSAGES.date).toBe("Enter a real date");
    expect(DEFAULT_VALIDATION_MESSAGES.dateIncomplete).toBe("Enter a complete date");
    expect(resolveValidationMessage({ code: "number" }, undefined, "en")).toBe("Enter a number");
    expect(resolveValidationMessage({ code: "dateIncomplete", parameters: { missing: "year" } }, { dateIncomplete: "The date must include a {missing}" }, "en")).toBe(
      "The date must include a year"
    );
    // `required` has a sentence of its own, so no core code shows bare.
    expect(resolveValidationMessage({ code: "required" }, undefined, "en")).toBe(DEFAULT_VALIDATION_MESSAGES.required);
  });
});

// --- The runtime: the input states it keeps, and where they never go --------------------------

const ENVELOPE = {
  form: { id: "validity", version: "1.0.0" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
};

function definitionOf(children: ComponentNode[], journey?: FormDefinition["journey"]): FormDefinition {
  return { id: "validity", version: "1.0.0", schemaVersion: "1.0.0", root: formRoot(children), ...(journey ? { journey } : {}) };
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

/** A browser: the field-constraints stage, and — with `sandboxed` — the in-process kernel as its sandbox. */
function browser(form: FormDefinition, sandboxed: boolean, spy?: (context: ValidationContext) => void): FormRuntime {
  return new FormRuntime(form, {
    submissionModes: modes(),
    validationPipeline: new ValidationPipeline([
      createFieldConstraintsStage(form.root),
      ...(spy ? [{ id: "spy", version: "1", validate: (context: ValidationContext) => (spy(context), { errors: [] }) }] : [])
    ]),
    ...(sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {})
  });
}

const MIXED = definitionOf([
  { id: "age", type: "number", configuration: { label: "Age", required: true } },
  { id: "born", type: "date", configuration: { label: "Born", required: true } },
  { id: "note", type: "text", configuration: { label: "Note" } }
]);

describe("FormRuntime input states", () => {
  it("keeps a state by value path until any answer, empty included, is written there", () => {
    const runtime = browser(MIXED, false);
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["year"] } });
    // Another path's answer leaves it alone.
    runtime.setValue("note", "x");
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["year"] } });
    // An answer at its own path forgets it — the empty one too: a host that clears the field
    // replaces what the control said. (A control records its state after its own write.)
    runtime.setValue("born", "");
    expect(runtime.inputState("born")).toBeUndefined();
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    runtime.setValue("born", "2026-01-02");
    expect(runtime.inputState("born")).toBeUndefined();
    runtime.setInputState("age", { badInput: true });
    runtime.setValue("age", "");
    expect(runtime.inputState("age")).toBeUndefined();
    // `undefined`, or a state that says nothing, forgets it too.
    runtime.setInputState("age", { badInput: true });
    runtime.setInputState("age", undefined);
    expect(runtime.inputState("age")).toBeUndefined();
    runtime.setInputState("age", {});
    expect(runtime.inputState("age")).toBeUndefined();
  });

  it("hands the states to its stages as the context's inputStates, and to nothing it sends", async () => {
    const seen: ValidationContext[] = [];
    const runtime = browser(MIXED, false, (context) => seen.push(context));
    await runtime.validate();
    expect(seen[0]).not.toHaveProperty("inputStates");
    runtime.setInputState("born", { incomplete: { missing: ["month", "year"] } });
    runtime.setInputState("age", { badInput: true });
    const errors = await runtime.validate();
    expect(seen[1]?.inputStates).toEqual({ born: { incomplete: { missing: ["month", "year"] } }, age: { badInput: true } });
    expect(codes(errors)).toEqual(["age:number", "born:dateIncomplete"]);
    // Neither a draft's values nor the envelope carries them.
    const sent = await runtime.submit("send", ENVELOPE);
    expect(JSON.stringify(sent.canonicalSubmission)).not.toContain("incomplete");
    expect(JSON.stringify(sent.canonicalSubmission)).not.toContain("badInput");
  });

  it("never lets a state cross into the sandbox: the ABI drops it by name, as it drops requiredComponents", async () => {
    const abi = new JsonWasmAbi();
    const context = {
      formId: "f",
      values: {},
      form: MIXED.root,
      requiredComponents: { age: true },
      inputStates: { born: { incomplete: { missing: ["year"] } } }
    } as WasmSubmissionContext;
    expect(JSON.parse(abi.serializeContext(context, WasmValidationHost.STRICT_POLICY))).toEqual({ formId: "f", values: {}, form: JSON.parse(JSON.stringify(MIXED.root)) });

    // And the sandbox a browser runs is handed none: its verdict is the envelope's.
    const requests: string[] = [];
    const inner = new InProcessWasmHostAdapter().instantiate([], abi);
    const runtime = new FormRuntime(MIXED, {
      submissionModes: modes(),
      validationPipeline: new ValidationPipeline([]),
      wasmValidationHost: new WasmValidationHost([], {
        instance: { abiVersion: inner.abiVersion, run: (payload: string) => (requests.push(payload), inner.run(payload)) }
      })
    });
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    runtime.setValue("age", 3);
    const refused = await runtime.submit("submit", ENVELOPE);
    expect(codes(refused.errors)).toEqual(["born:required"]);
    expect(requests.length).toBe(1);
    expect(requests[0]).not.toContain("incomplete");
  });

  it("forgets every state when a draft is loaded, and when a journey is left or another started", async () => {
    const journeyed = definitionOf(MIXED.root.children!.content!, {
      journeys: [
        { id: "one", pages: [{ id: "p1", components: ["age", "born", "note"] }] },
        { id: "two", pages: [{ id: "q1", components: ["age", "born", "note"] }] }
      ]
    });
    const runtime = browser(journeyed, false);
    expect(runtime.journeyView()?.journeyId).toBe("one");
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    runtime.leaveJourney();
    expect(runtime.inputState("born")).toBeUndefined();

    runtime.startJourney("one");
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    runtime.startJourney("two");
    expect(runtime.inputState("born")).toBeUndefined();

    runtime.setInputState("age", { badInput: true });
    await runtime.hydrateFromDraft({
      id: "d",
      formId: "validity",
      formVersion: "1.0.0",
      runtime: { schemaVersion: "1.0.0", rendererVersion: "0.1.0" },
      values: { age: 4 },
      locale: "en",
      state: { touched: [], dirty: [] },
      updatedAt: 0
    });
    expect(runtime.inputState("age")).toBeUndefined();
  });

  it("drops what a control says about a hidden field's empty answer, but keeps a hidden answer's format checks", async () => {
    const byEmail = { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "shown" }, right: { kind: "literal", value: true } } } as const;
    const form = definitionOf([
      { id: "shown", type: "checkbox", configuration: {} },
      { id: "age", type: "number", configuration: { required: true, hiddenValueBehavior: "retain" }, rules: byEmail },
      { id: "born", type: "date", configuration: { hiddenValueBehavior: "retain" }, rules: byEmail }
    ]);
    // Hidden, the answers retained (explicitly: the hidden default leaves them out) and submitted: a number that is not one still refuses.
    const misshapen = browser(form, true);
    misshapen.setValue("shown", false);
    misshapen.setValue("age", "abc");
    misshapen.setValue("born", "2026-02-31");
    const refused = await misshapen.submit("submit", ENVELOPE);
    expect(codes(refused.errors)).toEqual(["age:number", "born:date"]);
    const server = runKernel({ formId: "validity", values: { shown: false, age: "abc", born: "2026-02-31" }, locale: "en", form: form.root }, []);
    expect(codes(server.errors)).toEqual(["age:number", "born:date"]);

    // Hidden and empty, whatever its control said: nothing to hold to a shape.
    const empty = browser(form, true);
    empty.setValue("shown", false);
    empty.setInputState("age", { badInput: true });
    empty.setInputState("born", { incomplete: { missing: ["year"] } });
    expect((await empty.submit("submit", ENVELOPE)).accepted).toBe(true);
    // Shown, the same states speak.
    empty.setValue("shown", true);
    expect(codes(await empty.validate())).toEqual(["age:number", "born:dateIncomplete"]);
  });

  it("drops them for a hidden field its policy still validates, as the server hears nothing of them", async () => {
    const shown = { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "shown" }, right: { kind: "literal", value: true } } } as const;
    const validated = { required: true, hiddenValidationBehavior: "validate" };
    const form = definitionOf([
      { id: "shown", type: "checkbox", configuration: {} },
      { id: "age", type: "number", configuration: validated, rules: shown },
      { id: "born", type: "date", configuration: validated, rules: shown }
    ]);
    const runtime = browser(form, true);
    // Typed into while they showed; then the answer that hides them.
    runtime.setValue("shown", true);
    runtime.setInputState("age", { badInput: true });
    runtime.setInputState("born", { incomplete: { missing: ["year"] } });
    expect(codes(await runtime.validate())).toEqual(["age:number", "born:dateIncomplete"]);
    runtime.setValue("shown", false);
    expect(runtime.inputState("born")).toBeDefined();
    const submitted = await runtime.submit("submit", ENVELOPE);
    expect(codes(submitted.errors)).toEqual([]);
    expect(submitted.accepted).toBe(true);
    // The server's verdict over what was sent is the same.
    const server = runKernel({ formId: "validity", values: submitted.canonicalSubmission?.submission.values ?? {}, locale: "en", form: form.root }, []);
    expect(server.errors).toEqual([]);
  });
});

// --- Parity: the browser alone, with its sandbox, and a server holding the envelope -------------

interface Verdict {
  accepted: boolean;
  errors: string[];
}

/**
 * Every side over one person's answers: the browser alone and with its in-process sandbox, then
 * the kernel over what that browser sends (or, refused, what the same answers send
 * unvalidated) — directly, across the JSON ABI, and over the answers as stored. Returns the
 * browser's verdict, the server's, and what was sent.
 */
async function everySide(
  form: FormDefinition,
  answers: Record<string, unknown>,
  states: Record<string, FieldInputState> = {}
): Promise<{ alone: Verdict; sandboxed: Verdict; server: Verdict; sent: Record<string, unknown>; outcome: KernelOutcome }> {
  const run = async (sandboxed: boolean, mode: "submit" | "send") => {
    const runtime = browser(form, sandboxed);
    for (const [key, value] of Object.entries(answers)) {
      runtime.setValue(key, value);
    }
    for (const [path, state] of Object.entries(states)) {
      runtime.setInputState(path, state);
    }
    return runtime.submit(mode, ENVELOPE);
  };
  const alone = await run(false, "submit");
  const sandboxed = await run(true, "submit");
  const sent = (sandboxed.accepted ? sandboxed : await run(true, "send")).canonicalSubmission?.submission.values as Record<string, unknown>;
  const context = { formId: form.id, values: sent, locale: "en", form: form.root };
  const outcome = runKernel(context, []);
  const abi = new JsonWasmAbi();
  const crossed = abi.deserializeOutcome(new InProcessWasmHostAdapter().instantiate([], abi).run(abi.serializeContext(context, WasmValidationHost.STRICT_POLICY)) as string);
  expect(crossed).toEqual(JSON.parse(JSON.stringify(outcome)));
  const raw = runKernel({ ...context, values: answers }, []);
  expect(codes(raw.errors)).toEqual(codes(outcome.errors));
  const blocked = outcome.errors.some((error) => (error.severity ?? "error") === "error");
  return {
    alone: { accepted: alone.accepted, errors: codes(alone.errors) },
    sandboxed: { accepted: sandboxed.accepted, errors: codes(sandboxed.errors) },
    server: { accepted: !blocked && outcome.values !== undefined, errors: codes(outcome.errors) },
    sent,
    outcome
  };
}

describe("number and date parity on every side", () => {
  it("refuses text on a number field and an impossible date everywhere, with the same codes", async () => {
    const sides = await everySide(MIXED, { age: "abc", born: "2026-02-31" });
    const refused = { accepted: false, errors: ["age:number", "born:date"] };
    expect(sides.alone).toEqual(refused);
    expect(sides.sandboxed).toEqual(refused);
    expect(sides.server).toEqual(refused);
    expect(sides.outcome.errors.every((error) => error.source === "wasm" && error.stage === "field-constraints")).toBe(true);
  });

  it("accepts numeric strings and real dates everywhere, unchanged", async () => {
    for (const age of ["12", " 7 ", "1e3", 42]) {
      const sides = await everySide(MIXED, { age, born: "2024-02-29" });
      const accepted = { accepted: true, errors: [] };
      expect(sides.alone, String(age)).toEqual(accepted);
      expect(sides.sandboxed, String(age)).toEqual(accepted);
      expect(sides.server, String(age)).toEqual(accepted);
      // Validation only: the answer is sent as it was given.
      expect(sides.sent.age).toEqual(age);
      expect(sides.outcome.values?.age).toEqual(age);
    }
  });

  it("the client-only states: the browser says more, the server over the same envelope says required or nothing", async () => {
    const states: Record<string, FieldInputState> = { age: { badInput: true }, born: { incomplete: { missing: ["day"] } } };
    const sides = await everySide(MIXED, {}, states);
    expect(sides.alone).toEqual({ accepted: false, errors: ["age:number", "born:dateIncomplete"] });
    expect(sides.sandboxed).toEqual(sides.alone);
    expect(sides.server).toEqual({ accepted: false, errors: ["age:required", "born:required"] });

    // Optional fields: the browser still refuses the part-typed date; the server accepts.
    const optional = definitionOf([
      { id: "age", type: "number", configuration: {} },
      { id: "born", type: "date", configuration: {} }
    ]);
    const lenient = await everySide(optional, {}, states);
    expect(lenient.alone).toEqual({ accepted: false, errors: ["age:number", "born:dateIncomplete"] });
    expect(lenient.server).toEqual({ accepted: true, errors: [] });
  });

  it("refuses a forged non-numeric worked-out total at the server: a filled form field is an ordinary form field", () => {
    const root = presentationRoot();
    const journey = applyJourney();
    const honest = runKernel({ formId: "presentation", values: APPLY_BELOW, locale: "en", form: root, journey }, []);
    expect(honest.errors).toEqual([]);
    const forged = runKernel({ formId: "presentation", values: { ...APPLY_BELOW, annual_income: "lots" }, locale: "en", form: root, journey }, []);
    expect(forged.errors).toEqual([{ code: "number", componentId: "annual_income", path: "annual_income", stage: "field-constraints", source: "wasm" }]);
    expect(forged.values).toBeUndefined();
    // Still listed as worked out in the browser: judged, not reproduced.
    expect(forged.clientDerived).toEqual(["annual_income"]);
    // A numeric string passes as the number it spells.
    expect(runKernel({ formId: "presentation", values: { ...APPLY_BELOW, annual_income: "36000" }, locale: "en", form: root, journey }, []).errors).toEqual([]);
  });

  it("holds a presentation's own number field to its kind in the browser's own-field stage", async () => {
    const form: FormDefinition = { id: "presentation", version: "1.0.0", schemaVersion: "1.0.0", root: presentationRoot(), journey: { journeys: [applyJourney()] } };
    const runtime = browser(form, false);
    runtime.setValue(runtime.presentationValuePathOf("work_email") as string, "ada@example.org");
    runtime.setValue("@apply.m1", "12 kg");
    runtime.setValue("@apply.m2", 1);
    runtime.setInputState("@apply.m3", { badInput: true });
    await runtime.nextPage();
    const errors = await runtime.validate({ page: "income" });
    expect(codes(errors.filter((error) => error.stage === "presentation-fields"))).toEqual(["m1:number", "m3:number"]);
  });
});

// --- kernelIsDateAnswer by character codes ------------------------------------------

/** The reading the character-code version replaced: a pattern with captures and a table of month lengths. */
function patternIsDateAnswer(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number);
}

describe("kernelIsDateAnswer by character codes", () => {
  const years = ["0000", "0001", "0004", "0100", "0400", "1900", "2000", "2023", "2024", "2100", "9999", "٢٠٢٤", "２０２４", "20e4", "２024", "202", "20240"];
  const months = ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "1", "١٢", "-1", " 1", "1 ", "0a"];
  const days = ["00", "01", "28", "29", "30", "31", "32", "3", "٠١", "1 ", "+1", "0x"];

  it("accepts and refuses exactly what the pattern did, over years, months, days and separators", () => {
    let checked = 0;
    for (const year of years) {
      for (const month of months) {
        for (const day of days) {
          for (const separator of ["-", "/", "–", ".", ""]) {
            const value = `${year}${separator}${month}${separator}${day}`;
            expect(kernelIsDateAnswer(value), JSON.stringify(value)).toBe(patternIsDateAnswer(value));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it("agrees on every day of every month of the leap-year edge years", () => {
    for (const year of ["0001", "0004", "0100", "0400", "1900", "2000", "2023", "2024", "2100", "9999"]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          expect(kernelIsDateAnswer(value), value).toBe(patternIsDateAnswer(value));
        }
      }
    }
    expect(kernelIsDateAnswer("2024-02-29")).toBe(true);
    expect(kernelIsDateAnswer("2100-02-29")).toBe(false);
    expect(kernelIsDateAnswer("0001-01-01")).toBe(true);
    expect(kernelIsDateAnswer("0000-12-31")).toBe(false);
  });

  it("refuses digits of other scripts, stray whitespace, a trailing newline and anything but a text", () => {
    for (const value of ["٢٠٢٤-٠٢-٠١", "２０２４-０２-０１", "2024-02-01\n", "\n2024-02-01", "2024-02-01 ", "2024-02-0１", "2024-02-01\u0000"]) {
      expect(kernelIsDateAnswer(value), JSON.stringify(value)).toBe(false);
      expect(patternIsDateAnswer(value), JSON.stringify(value)).toBe(false);
    }
    for (const value of [undefined, null, 20240201, true, [], ["2024-02-01"], new String("2024-02-01")]) {
      expect(kernelIsDateAnswer(value)).toBe(false);
    }
  });
});
