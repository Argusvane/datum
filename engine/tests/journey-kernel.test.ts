import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { validateJourneyShape } from "../form-engine/core/schema/journey.js";
import {
  kernelErrorPassesFold,
  kernelFoldSubmission,
  kernelIsJourney,
  runKernel as kernelRun,
  PORTABLE_KERNEL_FUNCTIONS,
  type KernelValidator
} from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { InProcessWasmHostAdapter } from "../form-engine/validation/wasm/in-process-host.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { kernelCompileJourney } from "../form-engine/core/expressions/compile.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import type { FormulaProblem } from "../form-engine/core/expressions/formula-types.js";
import { APPLY_ABOVE, APPLY_BELOW, applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

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
 * The validation kernel over a journey: the server works the path out from the
 * values alone, and judges only what the person was shown.
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean | null): Expression => ({
  kind: "binary",
  operator: "eq",
  left: path(name),
  right: literal(value)
});

/** An eligibility form: a residency question, two branches on employment, contact details, a
 * note on no page, and an exit message. */
const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] } },
      { id: "employed", type: "checkbox", configuration: {} },
      { id: "business_name", type: "text", configuration: { required: true, minLength: 3 } },
      { id: "employer", type: "text", configuration: { required: true } },
      {
        id: "contact",
        type: "container",
        configuration: {},
        children: {
          content: [
            { id: "email", type: "text", configuration: { required: true, pattern: "[^@]+@[^@]+" } },
            { id: "phone", type: "text", configuration: {} }
          ]
        }
      },
      { id: "notes", type: "textarea", configuration: { minLength: 10 } },
      { id: "exit_message", type: "html", configuration: {} }
    ]
  }
};

const journey: Journey = {
  id: "apply",
  pages: [
    { id: "residency", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "ineligible" }] },
    { id: "work", components: ["employed"], routes: [{ when: eq("employed", true), to: "employment" }] },
    { id: "self", components: ["business_name"], routes: [{ to: "details" }] },
    { id: "employment", components: ["employer"] },
    { id: "details", components: ["contact"], routes: [{ to: "$end" }] },
    { id: "ineligible", kind: "exit", components: ["exit_message"] }
  ]
};

function run(values: Record<string, unknown>, extra: Record<string, unknown> = {}, validators: readonly KernelValidator[] = []) {
  return runKernel({ formId: "f", values, locale: "en", form: root, journey, ...extra }, validators);
}

function codes(errors: ReadonlyArray<{ code: string; componentId?: string }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
}

describe("journey kernel: the path from the values", () => {
  it("takes the branch the answers choose, and works it out again from the submitted view", () => {
    const employed = kernelFoldSubmission(root, { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" }, journey);
    expect(employed.trace?.pages).toEqual(["residency", "work", "employment", "details"]);
    expect(employed.trace?.end).toBe("end");
    expect(employed.placements).toMatchObject({ resident: "on", employer: "on", business_name: "off", exit_message: "off", notes: "unassigned" });
    // The container's children come with it.
    expect(employed.placements).toMatchObject({ contact: "on", email: "on", phone: "on" });

    const selfEmployed = kernelFoldSubmission(root, { resident: "yes", business_name: "Shop", "contact.email": "a@b.co" }, journey);
    expect(selfEmployed.trace?.pages).toEqual(["residency", "work", "self", "details"]);
    expect(selfEmployed.trace?.decisions).toContainEqual({ kind: "route", pageId: "self", routeIndex: 0, to: "details" });
    // The fold's own fixpoint: what it submits folds to itself.
    const again = kernelFoldSubmission(root, selfEmployed.submittable, journey);
    expect(again.submittable).toEqual(selfEmployed.submittable);
    expect(again.passes).toBe(1);
  });

  it("does not require a field on a page the path skips, and does not submit its answer", () => {
    const outcome = run({ resident: "yes", employed: true, employer: "ACME", business_name: "x", "contact.email": "a@b.co" });
    // business_name is required and too short, but its page is off the path.
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" });

    // The same answers judged as a whole form: the untaken branch blocks.
    const whole = runKernel({ formId: "f", values: { resident: "yes", employed: true, employer: "ACME", business_name: "x", "contact.email": "a@b.co" }, locale: "en", form: root }, []);
    expect(codes(whole.errors)).toEqual(["business_name:minLength"]);
  });

  it("requires what is on the path", () => {
    const outcome = run({ resident: "yes" });
    expect(codes(outcome.errors)).toEqual(["business_name:required", "email:required"]);
    expect(outcome.values).toBeUndefined();
  });

  it("judges a component on no page as the whole form does: its answer kept and held to its format, required only if the form says so", () => {
    const outcome = run({ resident: "yes", business_name: "Shop", "contact.email": "a@b.co", notes: "a note long enough" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toMatchObject({ notes: "a note long enough" });

    // The form does not require the note, so leaving it empty passes on the journey as on the form.
    expect(run({ resident: "yes", business_name: "Shop", "contact.email": "a@b.co" }).errors).toEqual([]);
    // Answered, its shape counts: a field on no page is folded as the whole form folds it.
    const short = run({ resident: "yes", business_name: "Shop", "contact.email": "a@b.co", notes: "short" });
    expect(codes(short.errors)).toEqual(["notes:minLength"]);
    expect(short.values).toBeUndefined();
  });

  it("drops an off-path answer by the journey's offPathValues, a component's own behaviour winning", () => {
    const values = { resident: "yes", business_name: "Shop", employer: "ACME", "contact.email": "a@b.co" };
    const retained = runKernel({ formId: "f", values, locale: "en", form: root, journey: { ...journey, offPathValues: "retain" } }, []);
    expect(retained.values).toMatchObject({ employer: "ACME" });

    const ownRoot: ComponentNode = JSON.parse(JSON.stringify(root));
    const employer = ownRoot.children!.content!.find((node) => node.id === "employer")!;
    employer.configuration = { ...(employer.configuration as Record<string, unknown>), hiddenValueBehavior: "retain" };
    const own = runKernel({ formId: "f", values, locale: "en", form: ownRoot, journey }, []);
    expect(own.values).toMatchObject({ employer: "ACME" });
  });

  it("refuses a path that ends at an exit page", () => {
    const outcome = run({ resident: "no", "contact.email": "a@b.co" });
    expect(outcome.values).toBeUndefined();
    expect(outcome.errors).toEqual([
      { code: "journey.exit", stage: "journey", source: "wasm", parameters: { journey: "apply", page: "ineligible" } }
    ]);
  });

  it("still strips (and rejects) unknown fields with a journey", () => {
    const values = { resident: "yes", business_name: "Shop", "contact.email": "a@b.co", rogue: 1, "contact.zz": 2 };
    const stripped = run(values, { logLevel: "info" });
    expect(stripped.errors).toEqual([]);
    expect(stripped.values).toEqual({ resident: "yes", business_name: "Shop", "contact.email": "a@b.co" });
    expect(stripped.logs?.find((entry) => entry.message === "unknown fields stripped")?.data).toEqual({ fields: ["rogue", "contact.zz"] });

    const rejected = run(values, { unknownFields: "reject" });
    expect(rejected.errors.map((error) => error.code)).toEqual(["unknown_field", "unknown_field"]);
  });

  it("logs the path and what the fold withheld", () => {
    const outcome = run({ resident: "yes", employed: true, employer: "ACME", business_name: "Shop", "contact.email": "a@b.co" }, { logLevel: "debug" });
    const messages = outcome.logs?.map((entry) => `${entry.level}: ${entry.message}`) ?? [];
    expect(messages).toContain("debug: journey apply: 4 page(s) on the path, ends at end");
    expect(outcome.logs?.find((entry) => entry.message === "hidden values withheld")).toEqual({
      level: "info",
      message: "hidden values withheld",
      data: { fields: ["business_name"] }
    });
    // What the constraints left alone, and why nothing was said about it. `notes`, on no page,
    // is validated as the whole form would validate it, so it is not listed here.
    expect(outcome.logs?.find((entry) => entry.message.startsWith("field constraints"))?.data).toEqual({
      notValidated: ["business_name", "exit_message"]
    });

    // A form with nothing hidden and nothing withheld logs what it always did.
    const plain = runKernel({ formId: "f", values: { resident: "yes" }, locale: "en", form: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "resident", type: "select", configuration: { options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] } }] } }, logLevel: "debug" }, []);
    expect(plain.logs?.map((entry) => entry.message)).toEqual([
      "run: schema form, unknown fields strip",
      "no unknown fields",
      "field constraints: 0 error(s)",
      "accepted: 0 error(s), 1 value(s)"
    ]);
  });

  it("fails closed on a context journey that is not a journey", () => {
    const outcome = runKernel({ formId: "f", values: { resident: "yes" }, locale: "en", form: root, journey: { id: "apply" } as never }, []);
    expect(outcome.values).toBeUndefined();
    expect(outcome.errors[0]).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
  });
});

describe("journey kernel: context journeys the browser would drop", () => {
  const judge = (candidate: unknown) => runKernel({ formId: "f", values: { resident: "yes" }, locale: "en", form: root, journey: candidate as Journey }, []);
  const withPage = (page: Record<string, unknown>): unknown => ({
    ...journey,
    pages: journey.pages.map((entry) => (entry.id === "self" ? { ...entry, ...page } : entry))
  });

  it("fails closed on each malformed shape rather than skipping or emptying the page", () => {
    // A page or route `when` the compile cannot read is in the describe below: it is reported
    // as a formula problem first, on both sides, and the shape is checked on the compiled copy.
    const malformed: Array<[string, unknown]> = [
      ["components that are not a list", withPage({ components: "business_name" })],
      ["a component id that is not a string", withPage({ components: ["business_name", 7] })],
      ["a route that is not an object", withPage({ routes: [null] })],
      ["a route with no target", withPage({ routes: [{ to: "" }] })],
      ["routes that are not a list", withPage({ routes: { to: "details" } })],
      ["an unknown page kind", withPage({ kind: "summary" })],
      ["a page with an empty id", withPage({ id: "" })],
      ["a page validation that is not an object", withPage({ validation: "page" })],
      ["a page validation with an end", withPage({ validation: { end: "server" } })],
      ["an unknown offPathValues", { ...journey, offPathValues: "bogus" }],
      ["an unknown progress", { ...journey, progress: "bar" }],
      ["an unknown journey end check", { ...journey, validation: { end: "later" } }],
      ["an empty id", { ...journey, id: "" }],
      ["two pages sharing an id", { ...journey, pages: [...journey.pages, { ...journey.pages[0]!, components: [] }] }]
    ];
    for (const [label, candidate] of malformed) {
      expect(validateJourneyShape(candidate).length, label).toBeGreaterThan(0);
      const outcome = judge(candidate);
      expect(outcome.errors[0], label).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
      expect(outcome.values, label).toBeUndefined();
    }
    // The well-formed journey still judges the page: business_name is on the path and required.
    expect(codes(judge(journey).errors)).toEqual(["business_name:required", "email:required"]);
  });

  it("accepts exactly what validateJourneyShape accepts", () => {
    const corpus: unknown[] = [
      journey,
      { id: "j", pages: [] },
      { id: "j", pages: [{ id: "p" }] },
      { id: "j", pages: [{ id: "p", kind: "exit", components: [], routes: [], when: { kind: "literal", value: true } }] },
      { id: "j", pages: [{ id: "p", routes: [{ to: "$end", when: { kind: "path", path: "a" } }], validation: { continue: "defer", server: true, onUnavailable: "continue" } }] },
      { id: "j", pages: [{ id: "p" }], offPathValues: "retain", progress: "count", validation: { end: "server", continue: "page" } },
      null,
      [],
      "apply",
      { id: "j" },
      { id: 3, pages: [] },
      { id: "j", pages: {} },
      { id: "j", pages: [null] },
      { id: "j", pages: [[]] },
      { id: "j", pages: [{ id: 4 }] },
      { id: "j", pages: [{ id: "p", kind: "questions", components: [null] }] },
      { id: "j", pages: [{ id: "p", when: [] }] },
      { id: "j", pages: [{ id: "p", when: { kind: 1 } }] },
      { id: "j", pages: [{ id: "p", routes: [{}] }] },
      { id: "j", pages: [{ id: "p", routes: [[]] }] },
      { id: "j", pages: [{ id: "p", validation: { server: "yes" } }] },
      { id: "j", pages: [{ id: "p", validation: { onUnavailable: "retry" } }] },
      { id: "j", pages: [{ id: "p", validation: { continue: "skip" } }] },
      { id: "j", pages: [], offPathValues: "clear" },
      { id: "j", pages: [], offPathValues: "exclude-from-submission" },
      { id: "j", pages: [], validation: null },
      { id: "j", pages: [], validation: { end: "client" } },
      // A page may hold nodes the presentation owns; the table of
      // their shapes, well-formed and not, is in journey-schema.test.ts.
      applyJourney(),
      publicVariant(),
      { id: "j", pages: [{ id: "p", components: ["a", { id: "own", type: "text" }] }] },
      { id: "j", pages: [{ id: "p", components: [{ type: "journey-field", configuration: { componentId: "a" } }] }] },
      { id: "j", pages: [{ id: "p", components: [{ id: "own" }] }] },
      { id: "j", pages: [{ id: "p", components: [{ type: "journey-field" }] }] },
      { id: "j", pages: [{ id: "p", components: [{ id: "w", type: "journey-value", configuration: { to: "a" } }] }] },
      { id: "j", pages: [{ id: "p", components: [{ id: "box", type: "fieldset", children: { content: ["a"] } }] }] }
    ];
    for (const candidate of corpus) {
      expect(kernelIsJourney(candidate), JSON.stringify(candidate)).toBe(validateJourneyShape(candidate).length === 0);
    }
  });
});

/**
 * The kernel compiles the context's journey before it checks its shape, as the
 * browser's `readJourneys` reads the compiled definition. A page or route `when` that is not
 * a formula, a tree or the object form, or a formula that does not parse, is the compile's
 * problem under the formula policy on both sides: dropped and reported under `warn`, refused
 * with `formula.invalid` under `fail`. `journey.invalid` is kept for the shapes the compile
 * leaves as it found them (the describe above).
 */
describe("journey kernel: a malformed when is the compile's problem, not journey.invalid", () => {
  const withSelf = (page: Record<string, unknown>): unknown => ({
    ...journey,
    pages: journey.pages.map((entry) => (entry.id === "self" ? { ...entry, ...page } : entry))
  });
  // These cases pin what the warn opt-in does; the default is fail,
  // judged by `judgeDefault` and the fail cases below.
  const judge = (candidate: unknown, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values: { resident: "yes" }, locale: "en", form: root, journey: candidate as Journey, formulaErrors: "warn", ...extra }, [], undefined, formulaFunctionSignatures());
  const judgeDefault = (candidate: unknown) =>
    runKernel({ formId: "f", values: { resident: "yes" }, locale: "en", form: root, journey: candidate as Journey }, [], undefined, formulaFunctionSignatures());
  const compiledOf = (candidate: unknown): { journey: unknown; where: string[] } => {
    const problems: FormulaProblem[] = [];
    const compiled = kernelCompileJourney({ journeys: [candidate] }, kernelParseFormula, formulaFunctionSignatures(), problems) as { journeys: unknown[] };
    return { journey: compiled.journeys[0], where: problems.map((problem) => problem.where) };
  };
  const warnedWhere = (outcome: { logs?: Array<{ level: string; message: string }> }): string[] =>
    (outcome.logs ?? [])
      .filter((entry) => entry.level === "warn" && entry.message.startsWith("formula invalid: "))
      .map((entry) => entry.message.split(": ")[1] as string);
  /** A `when` that does not parse: reported, and dropped from the copy, which both sides then accept. */
  const unparsed: Array<[string, unknown, string]> = [
    ["a route when that does not parse", withSelf({ routes: [{ to: "details", when: { formula: "bad formula (" } }] }), "journey:apply:page:self:route:0"]
  ];
  /** A `when` of no shape at all: reported as `invalidRule` and kept as written, which both sides then refuse. */
  const noShape: Array<[string, unknown, string]> = [
    ["a route when that is true", withSelf({ routes: [{ to: "details", when: true }] }), "journey:apply:page:self:route:0"]
  ];

  it("drops a when that does not parse, as the browser does: the journey is accepted, the page judged without its condition, the problem warned about where the compile found it", () => {
    for (const [label, candidate, where] of unparsed) {
      // The browser reads the same compiled copy, which validateJourneyShape passes.
      const compiled = compiledOf(candidate);
      expect(validateJourneyShape(compiled.journey), label).toEqual([]);
      expect(kernelIsJourney(compiled.journey), label).toBe(true);
      expect(compiled.where, label).toEqual([where]);
      const outcome = judge(candidate);
      expect(outcome.errors.map((error) => error.code), label).not.toContain("journey.invalid");
      expect(outcome.errors.map((error) => error.code), label).not.toContain("formula.invalid");
      // Without its condition the page is on the path (or its route unconditional, as it was): the form's rules hold.
      expect(codes(outcome.errors), label).toEqual(["business_name:required", "email:required"]);
      expect(outcome.values, label).toBeUndefined();
      expect(warnedWhere(outcome), label).toEqual([where]);
      // Nothing said by the host or the form: fail.
      expect(judgeDefault(candidate).errors.map((error) => error.code), label).toEqual(["formula.invalid"]);
    }
  });

  it("keeps a when of no shape as written, reported as invalidRule, so the shape check refuses the copy on both sides: journey.invalid here, the journey dropped in the browser", () => {
    for (const [label, candidate, where] of noShape) {
      const compiled = compiledOf(candidate);
      expect(validateJourneyShape(compiled.journey).length, label).toBeGreaterThan(0);
      expect(kernelIsJourney(compiled.journey), label).toBe(false);
      expect(compiled.where, label).toEqual([where]);
      const outcome = judge(candidate);
      expect(outcome.errors[0], label).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
      expect(outcome.values, label).toBeUndefined();
      expect(warnedWhere(outcome), label).toEqual([where]);
      expect(judgeDefault(candidate).errors.map((error) => error.code), label).toEqual(["formula.invalid"]);
    }
  });

  it("refuses the journey under fail with one formula.invalid at the same place, judging nothing else", () => {
    for (const [label, candidate, where] of [...unparsed, ...noShape]) {
      const outcome = judge(candidate, { formulaErrors: "fail" });
      expect(outcome.errors.map((error) => error.code), label).toEqual(["formula.invalid"]);
      expect(outcome.errors[0]?.parameters?.where, label).toBe(where);
      expect(outcome.values, label).toBeUndefined();
    }
  });

  it("refuses a page carrying a when of its own as journey.invalid, under warn and fail alike: the compile leaves it alone, so no formula problem names it", () => {
    for (const when of ['resident = "yes"', "bad formula (", 7, {}, [], { kind: "literal", value: true }]) {
      const candidate = withSelf({ when });
      const compiled = compiledOf(candidate);
      expect(compiled.where, JSON.stringify(when)).toEqual([]);
      expect(validateJourneyShape(compiled.journey), JSON.stringify(when)).toEqual([
        'journey "apply" page 3 has a when, but a page has no condition of its own; branch with a route on the page before it'
      ]);
      expect(kernelIsJourney(compiled.journey), JSON.stringify(when)).toBe(false);
      for (const outcome of [judge(candidate), judge(candidate, { formulaErrors: "fail" }), judgeDefault(candidate)]) {
        expect(outcome.errors[0], JSON.stringify(when)).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
        expect(outcome.errors.map((error) => error.code), JSON.stringify(when)).not.toContain("formula.invalid");
        expect(outcome.values).toBeUndefined();
      }
    }
  });

  it("answers journey.invalid exactly where validateJourneyShape refuses the compiled copy", () => {
    const corpus: unknown[] = [
      ...unparsed.map(([, candidate]) => candidate),
      ...noShape.map(([, candidate]) => candidate),
      { id: "apply" },
      "apply",
      [],
      { id: "", pages: [] },
      withSelf({ components: "business_name" }),
      withSelf({ routes: [{ to: "", when: 7 }] }),
      withSelf({ kind: "summary", when: "bad formula (" }),
      withSelf({ when: 'resident = "yes"' })
    ];
    for (const candidate of corpus) {
      const refused = validateJourneyShape(compiledOf(candidate).journey).length > 0;
      const outcome = judge(candidate);
      expect(outcome.errors.some((error) => error.code === "journey.invalid"), JSON.stringify(candidate)).toBe(refused);
    }
  });
});

describe("journey kernel: a hidden answer that is still submitted keeps its format", () => {
  const byEmail: Expression = eq("by_email", true);
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "by_email", type: "checkbox", configuration: {} },
        { id: "email", type: "text", configuration: { required: true, maxLength: 20, pattern: "[^@]+@[^@]+", hiddenValueBehavior: "retain" }, rules: { visibleWhen: byEmail } },
        { id: "upload", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf", hiddenValueBehavior: "retain" }, rules: { visibleWhen: byEmail } },
        {
          id: "cleared",
          type: "text",
          configuration: { maxLength: 3, hiddenValueBehavior: "clear" },
          rules: { visibleWhen: byEmail }
        },
        {
          id: "excluded",
          type: "text",
          configuration: { maxLength: 3, hiddenValueBehavior: "exclude-from-submission" },
          rules: { visibleWhen: byEmail }
        }
      ]
    }
  };
  const forged = {
    by_email: false,
    email: "x".repeat(5000),
    upload: { storage: "inline", name: "evil.exe", type: "application/x-msdownload", size: 999999999 },
    cleared: "far too long",
    excluded: "far too long"
  };

  it("checks length, pattern, file size and type on a hidden, retained answer, never required", () => {
    const outcome = runKernel({ formId: "f", values: forged, locale: "en", form }, []);
    // The retained ones only: a cleared or excluded answer is not submitted, so has no shape.
    expect(codes(outcome.errors)).toEqual(["email:maxLength", "upload:maxFileSize"]);
    expect(outcome.values).toBeUndefined();

    const badPattern = runKernel({ formId: "f", values: { by_email: false, email: "no-at-sign" }, locale: "en", form }, []);
    expect(codes(badPattern.errors)).toEqual(["email:pattern"]);
    const wrongType = runKernel({ formId: "f", values: { by_email: false, upload: { storage: "inline", name: "a.exe", type: "x/y", size: 10 } }, locale: "en", form }, []);
    expect(codes(wrongType.errors)).toEqual(["upload:fileType"]);

    // Empty and hidden: required is relaxed, as before.
    const empty = runKernel({ formId: "f", values: { by_email: false }, locale: "en", form }, []);
    expect(empty.errors).toEqual([]);
    expect(empty.values).toEqual({ by_email: false });
  });

  it("lets a validator's shape errors through on such a component, and nothing else", () => {
    const fold = kernelFoldSubmission(form, forged, undefined);
    const shape = (componentId: string, code: string, stage = "field-constraints") => kernelErrorPassesFold({ code, componentId, stage, source: "custom" }, fold.effective);
    expect(shape("email", "maxLength")).toBe(true);
    expect(shape("upload", "fileType")).toBe(true);
    expect(shape("email", "required")).toBe(false);
    expect(shape("email", "custom.checked")).toBe(false);
    expect(shape("email", "maxLength", "plugin")).toBe(false);
    expect(shape("cleared", "maxLength")).toBe(false);
    expect(shape("excluded", "maxLength")).toBe(false);
  });
});

describe("journey kernel: calculations worked out again", () => {
  const minus = (left: Expression, right: Expression): Expression => ({ kind: "arithmetic", operator: "subtract", left, right });
  const lessThan = (name: string, value: number): Expression => ({ kind: "binary", operator: "lt", left: path(name), right: literal(value) });
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "birth_year", type: "number", configuration: { required: true } },
        { id: "age", type: "number", configuration: {}, rules: { value: minus(literal(2026), path("birth_year")) } },
        { id: "minor", type: "checkbox", configuration: {}, rules: { value: lessThan("age", 18) } },
        { id: "guardian", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("minor", true) } },
        { id: "seeded", type: "number", configuration: {}, rules: { value: path("host.limit") } },
        { id: "nickname", type: "text", configuration: {} },
        { id: "greeting", type: "text", configuration: {}, rules: { value: { kind: "call", name: "concat", args: [literal("Hi "), path("nickname")] } } },
        { id: "start", type: "number", configuration: {}, rules: { defaultValue: literal(1) } }
      ]
    }
  };

  it("folds over its own result, so a forged or missing calculated answer cannot hide a required field", () => {
    const forged = runKernel({ formId: "f", values: { birth_year: 2015, age: 40, minor: false }, locale: "en", form, logLevel: "info" }, []);
    expect(codes(forged.errors)).toEqual(["guardian:required"]);
    // `greeting` is listed too: `nickname` is an optional input that can
    // never be withheld, so its absence is the person's and `greeting` is worked out over it.
    expect(forged.logs?.find((entry) => entry.message === "calculations recomputed")?.data).toEqual({ fields: ["age", "minor", "greeting"] });

    const omitted = runKernel({ formId: "f", values: { birth_year: 2015 }, locale: "en", form }, []);
    expect(codes(omitted.errors)).toEqual(["guardian:required"]);
  });

  it("returns its own results, and an honest submission exactly as it was sent", () => {
    // `greeting` is what the browser works out with `nickname` empty: the honest submission carries it.
    const honest = { birth_year: 2015, age: 11, minor: true, guardian: "Grace", greeting: "Hi " };
    const accepted = runKernel({ formId: "f", values: honest, locale: "en", form, logLevel: "debug" }, []);
    expect(accepted.errors).toEqual([]);
    expect(accepted.values).toEqual(honest);
    expect(accepted.logs?.some((entry) => entry.message === "calculations recomputed")).toBe(false);

    const adult = runKernel({ formId: "f", values: { birth_year: 1990, age: 7, minor: true }, locale: "en", form }, []);
    expect(adult.errors).toEqual([]);
    expect(adult.values).toEqual({ birth_year: 1990, age: 36, minor: false, greeting: "Hi " });
  });

  it("keeps the submitted value of a calculation it cannot reproduce, and never recomputes a default", () => {
    // host.: the server has no host context. (An unanswered input is worked out over, unless
    // the browser may have read an answer it never sent: hidden and excluded.)
    const outcome = runKernel({ formId: "f", values: { birth_year: 1990, seeded: 5, greeting: "Hello there", start: 9 }, locale: "en", form }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toMatchObject({ seeded: 5, greeting: "Hi ", start: 9 });

    const answered = runKernel({ formId: "f", values: { birth_year: 1990, nickname: "Ada", greeting: "forged" }, locale: "en", form }, []);
    expect(answered.values).toMatchObject({ greeting: "Hi Ada" });

    // An entry's calculation is worked out entry by entry: a forged `lines[0].double`
    // is replaced by `row.qty * 2`, and nothing lands outside the collection.
    const rows: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "lines",
            type: "repeatingSection",
            configuration: {},
            collection: { itemFields: ["qty", "double"] },
            children: {
              content: [
                { id: "qty", type: "number", configuration: {} },
                { id: "double", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "multiply", left: path("row.qty"), right: literal(2) } } }
              ]
            }
          }
        ]
      }
    };
    const entries = runKernel({ formId: "f", values: { "lines[0].qty": 2, "lines[0].double": 5 }, locale: "en", form: rows }, []);
    expect(entries.values).toEqual({ "lines[0].qty": 2, "lines[0].double": 4 });
    // An entry the person did not send the input of is taken on trust, as a top-level calculation is.
    const lacking = runKernel({ formId: "f", values: { "lines[0].double": 5 }, locale: "en", form: rows }, []);
    expect(lacking.values).toEqual({ "lines[0].double": 5 });
    expect(lacking.clientDerived).toEqual(["lines[0].double"]);
  });

  it("works a route on a calculated answer out from the server's own result", () => {
    const onNoPage: Journey = {
      id: "age-check",
      pages: [
        { id: "you", components: ["birth_year"], routes: [{ when: { kind: "binary", operator: "gte", left: path("age"), right: literal(18) }, to: "done" }] },
        { id: "guardian-page", components: ["guardian"] },
        { id: "done", components: ["nickname"] }
      ]
    };
    const forged = runKernel({ formId: "f", values: { birth_year: 2015, age: 40 }, locale: "en", form: { ...form, children: { content: form.children!.content!.filter((node) => node.id !== "guardian").concat([{ id: "guardian", type: "text", configuration: { required: true } }]) } }, journey: onNoPage }, []);
    expect(codes(forged.errors)).toEqual(["guardian:required"]);
  });
});

describe("journey kernel: a repeating section's entries at its own collection path", () => {
  const section = (collectionPath?: string, extra: Partial<ComponentNode> = {}): ComponentNode => ({
    id: "items",
    type: "repeatingSection",
    configuration: {},
    collection: { itemFields: ["sku"], ...(collectionPath !== undefined ? { collectionPath } : {}) },
    children: { content: [{ id: "sku", type: "text", configuration: {} }] },
    ...extra
  });
  const pick: Journey = {
    id: "order",
    pages: [
      { id: "start", components: ["kind"], routes: [{ when: { ...eq("kind", "full"), operator: "neq" } as Expression, to: "$end" }] },
      { id: "full", components: ["items"] }
    ]
  };
  const formWith = (...nodes: ComponentNode[]): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: {},
    children: { content: [{ id: "kind", type: "select", configuration: { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] } }, ...nodes] }
  });

  it("leaves an abandoned branch's entries out, wherever the section keeps them", () => {
    const explicit = runKernel({ formId: "f", values: { kind: "short", "order_lines[0].sku": "abandoned", order_lines: [{ sku: "abandoned" }] }, locale: "en", form: formWith(section("order_lines")), journey: pick }, []);
    expect(explicit.values).toEqual({ kind: "short" });

    const dotted = formWith({
      id: "order",
      type: "container",
      configuration: {},
      children: { content: [{ ...section("order.items"), id: "order_items" }] }
    });
    const nested = runKernel({ formId: "f", values: { kind: "short", "order.items[0].sku": "abandoned" }, locale: "en", form: dotted, journey: { ...pick, pages: [pick.pages[0]!, { ...pick.pages[1]!, components: ["order_items"] }] } }, []);
    expect(nested.values).toEqual({ kind: "short" });

    const taken = runKernel({ formId: "f", values: { kind: "full", "order_lines[0].sku": "kept" }, locale: "en", form: formWith(section("order_lines")), journey: pick }, []);
    expect(taken.values).toEqual({ kind: "full", "order_lines[0].sku": "kept" });
  });

  it("judges the entries by the section's own rule and value behaviour, with no journey", () => {
    const hidden = formWith(section("order_lines", { configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: eq("kind", "full") } }));
    expect(runKernel({ formId: "f", values: { kind: "short", "order_lines[0].sku": "abandoned" }, locale: "en", form: hidden }, []).values).toEqual({ kind: "short" });
    expect(runKernel({ formId: "f", values: { kind: "full", "order_lines[0].sku": "kept" }, locale: "en", form: hidden }, []).values).toEqual({ kind: "full", "order_lines[0].sku": "kept" });
  });
});

describe("journey kernel: a fold that does not settle", () => {
  it("refuses with the form-level fold.unsettled the browser raises", () => {
    // a shows while b is unanswered; b shows while a is answered; each hides and drops the other.
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          // empty() keeps each rule a real yes or no: a condition holds only for true (strict truthiness).
          { id: "a", type: "text", configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { kind: "call", name: "empty", args: [path("b")] } } },
          { id: "b", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { kind: "unary", operator: "not", operand: { kind: "call", name: "empty", args: [path("a")] } } } }
        ]
      }
    };
    const outcome = runKernel({ formId: "f", values: { a: "x", b: "y" }, locale: "en", form }, []);
    expect(outcome.errors).toContainEqual({ code: "fold.unsettled", stage: "state", source: "wasm" });
    expect(outcome.values).toBeUndefined();
    expect(outcome.logs?.find((entry) => entry.level === "error")?.message).toBe("fold did not settle after 10 passes; the submission is refused");

    // What a browser that settled would send settles here too.
    expect(runKernel({ formId: "f", values: { a: "x" }, locale: "en", form }, []).errors).toEqual([]);
  });
});

describe("journey kernel: plugin validators", () => {
  it("see the submittable values, and their errors on components the fold does not validate are dropped", () => {
    const seen: string[][] = [];
    const validator: KernelValidator = (context) => {
      seen.push(Object.keys(context.values).sort());
      return {
        errors: [
          { code: "custom.checked", componentId: "employer", stage: "plugin", source: "custom" },
          { code: "custom.checked", componentId: "email", stage: "plugin", source: "custom" },
          { code: "custom.required", componentId: "notes", stage: "plugin", source: "custom" },
          { code: "custom.form", stage: "plugin", source: "custom" }
        ]
      };
    };
    const outcome = run({ resident: "yes", business_name: "Shop", employer: "ACME", "contact.email": "a@b.co" }, { logLevel: "debug" }, [validator]);
    expect(seen).toEqual([["business_name", "contact.email", "resident"]]);
    // employer is off the path: not validated. notes is on no page, and a field on no page is
    // validated as the whole form validates it, so the
    // validator's error on it stands, with the one naming no component and the one on the path.
    expect(codes(outcome.errors)).toEqual(["-:custom.form", "email:custom.checked", "notes:custom.required"]);
    expect(outcome.logs?.find((entry) => entry.message.startsWith("validator 1"))?.message).toBe(
      "validator 1: 3 error(s), 1 on hidden components dropped"
    );
  });
});

describe("journey kernel: rules the server cannot evaluate", () => {
  it("treats a visibility rule that reads host. as visible, and still folds the others", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "role_note", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("host.role", "admin") } },
          {
            id: "mixed",
            type: "text",
            configuration: { required: true },
            rules: { visibleWhen: { kind: "logical", operator: "and", left: eq("host.role", "admin"), right: literal(false) } }
          },
          { id: "wants_more", type: "checkbox", configuration: {} },
          { id: "more", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("wants_more", true) } }
        ]
      }
    };
    const outcome = runKernel({ formId: "f", values: {}, locale: "en", form }, []);
    // The host rules are left unevaluated and read as hidden for requiredness, so neither field
    // is asked for, and the outcome lists the skips; `more` is hidden by its own rule, and so
    // not required on the server either.
    expect(codes(outcome.errors)).toEqual([]);
    expect(outcome.visibilitySkipped).toEqual(["role_note", "mixed"]);

    const fold = kernelFoldSubmission(form, { wants_more: true }, undefined);
    expect(fold.effective.more?.visible).toBe(true);
    expect(fold.effective.role_note?.visible).toBe(true);
  });

  it("stops requiring a field hidden by its own rule — a verdict change for forms without a journey", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "has_pet", type: "checkbox", configuration: {} },
          { id: "pet_name", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("has_pet", true) } },
          {
            id: "pet_details",
            type: "container",
            configuration: { hiddenValueBehavior: "exclude-from-submission" },
            rules: { visibleWhen: eq("has_pet", true) },
            children: { content: [{ id: "species", type: "text", configuration: { required: true } }] }
          }
        ]
      }
    };
    const hidden = runKernel({ formId: "f", values: { has_pet: false, pet_name: "stale", "pet_details.species": "cat" }, locale: "en", form }, []);
    expect(hidden.errors).toEqual([]);
    // pet_name's own behaviour is the default (left out); the container's policy is its own, not
    // its children's, but species' default leaves a stale answer out too — the browser's reading.
    expect(hidden.values).toEqual({ has_pet: false });

    const shown = runKernel({ formId: "f", values: { has_pet: true }, locale: "en", form }, []);
    expect(codes(shown.errors)).toEqual(["pet_name:required", "species:required"]);
  });
});

describe("journey kernel: ids named after Object.prototype members", () => {
  it("works the path out over pages and components called constructor, toString and __proto__, through the ABI too", () => {
    const named: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "constructor", type: "select", configuration: { required: true, options: [{ value: "c", label: "c" }, { value: "skip", label: "skip" }, { value: "out", label: "out" }, { value: "in", label: "in" }] } },
          { id: "toString", type: "text", configuration: { required: true } },
          { id: "valueOf", type: "html", configuration: {} }
        ]
      }
    };
    const odd: Journey = {
      id: "__proto__",
      pages: [
        { id: "constructor", components: ["constructor"], routes: [{ when: eq("constructor", "out"), to: "hasOwnProperty" }, { when: eq("constructor", "skip"), to: "$end" }] },
        { id: "toString", components: ["toString"], routes: [{ to: "$end" }] },
        { id: "hasOwnProperty", kind: "exit", components: ["valueOf"] }
      ]
    };
    const judge = (values: Record<string, unknown>) =>
      runKernel({ formId: "f", values, locale: "en", form: named, journey: odd }, []).errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);
    expect(judge({ constructor: "in" })).toEqual(["toString:required"]);
    // The route to $end skips the page that holds toString: it is neither required nor submitted.
    expect(judge({ constructor: "skip" })).toEqual([]);
    expect(runKernel({ formId: "f", values: { constructor: "skip", toString: "t" }, locale: "en", form: named, journey: odd }, []).values).toEqual({ constructor: "skip" });
    expect(judge({ constructor: "out" })).toEqual(["-:journey.exit"]);
    expect(judge({})).toEqual(["constructor:required", "toString:required"]);

    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext({ formId: "f", values: { constructor: "out" }, locale: "en", form: named, journey: odd }, WasmValidationHost.STRICT_POLICY);
    expect(abi.deserializeOutcome(instance.run(payload) as string).errors).toEqual([
      { code: "journey.exit", stage: "journey", source: "wasm", parameters: { journey: "__proto__", page: "hasOwnProperty" } }
    ]);
  });
});

describe("journey kernel: the ABI", () => {
  it("is 4.1.0, and carries the journey through the serialized context", () => {
    expect(WASM_ABI_VERSION).toBe("1.0.0");
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext(
      { formId: "f", values: { resident: "no" }, locale: "en", form: root, journey },
      WasmValidationHost.STRICT_POLICY
    );
    const outcome = abi.deserializeOutcome(instance.run(payload) as string);
    expect(outcome.errors.map((error) => error.code)).toEqual(["journey.exit"]);
  });
});

describe("journey kernel: composition", () => {
  it("names every spliced function uniquely, with a prefix that cannot collide in the sandbox program", () => {
    const names = PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    // runKernel is the program's entry point by name; computeEffectiveNodeState is the
    // engine's own name for the effective-state fold, spliced as it is (renaming it would
    // touch every importer for no gain: nothing else in the program is called that).
    const allowed = new Set(["runKernel", "computeEffectiveNodeState"]);
    for (const name of names) {
      expect(name.startsWith("kernel") || name.startsWith("journey") || allowed.has(name), name).toBe(true);
    }
    for (const fn of PORTABLE_KERNEL_FUNCTIONS) {
      expect(fn.toString().trimStart().startsWith("function "), fn.name).toBe(true);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "kernelEvaluateExpression",
        "kernelBaseSemanticState",
        "kernelFoldSubmittable",
        "kernelFoldRequired",
        "kernelFoldHoldsOwnAnswer",
        "kernelResolveSemanticState",
        "kernelRuleContext",
        "kernelRuleRequired",
        "journeyPath",
        "journeyOwnership",
        "computeEffectiveNodeState",
        // The shape of an own node, what the presentation places, and what it reports.
        "kernelIsPresentationNode",
        "kernelClientDerived",
        "kernelPageComponentIds",
        "journeyOwnNodeRule",
        "journeyOwnNodeUsable",
        "journeyFormKeys",
        "journeyTargetUsable",
        "journeyHoldsOwnAnswer",
        // The data grid normalizer and its row bounds.
        "kernelNormalizeDataGrids",
        "kernelNormalizeDataGrid",
        "kernelDataGridRowBounds",
        // The formula parser, the definition compiler, the compiled-rule readers.
        "kernelParseFormula",
        "kernelCompileDefinition",
        "kernelFormulaPolicy",
        "kernelRuleRunsOn",
        "kernelCompiledRule",
        "kernelRuleSkipped",
        "journeyRuleTree"
      ])
    );
  });
});

/**
 * Formulas in a journey: a page's or a route's `when` may be a formula
 * string or the object form; the kernel compiles the context's journey into a copy and reads
 * the copy, with the context's day for `today()`.
 */
describe("journey kernel: formulas in a journey's conditions", () => {
  const signatures = formulaFunctionSignatures();
  const judge = (candidate: Journey, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values, locale: "en", form: root, journey: candidate, ...extra }, [], undefined, signatures);

  it("accepts a string when as a usable journey, and reads it as its tree", () => {
    const formulas: Journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: 'resident = "no"', to: "ineligible" }] },
        { id: "work", components: ["employed"], routes: [{ when: { formula: "employed = true" }, to: "employment" }] },
        { id: "self", components: ["business_name"], routes: [{ to: "details" }] },
        { id: "employment", components: ["employer"] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] },
        { id: "ineligible", kind: "exit", components: ["exit_message"] }
      ]
    };
    expect(kernelIsJourney(formulas)).toBe(true);
    const before = JSON.stringify(formulas);
    const employed = judge(formulas, { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" });
    expect(employed.errors).toEqual([]);
    expect(employed.values).toEqual({ resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" });
    expect(codes(judge(formulas, { resident: "no" }).errors)).toEqual(["-:journey.exit"]);
    // The context's journey is read, never changed.
    expect(JSON.stringify(formulas)).toBe(before);
  });

  it("reads a route when on today() by the context's day, and refuses the run when no day was given", () => {
    const dated: Journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: 'today() < "2026-07-01"', to: "details" }] },
        { id: "late", components: ["notes"] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    };
    // The fields on no page keep the form's own rules, so they are answered here.
    const placed = { resident: "yes", business_name: "Shop", employer: "ACME", "contact.email": "a@b.co" };
    const values = { ...placed, notes: "short" };
    // After the day: the page is on the path and notes is held to its minLength.
    expect(codes(judge(dated, values, { today: "2026-10-07" }).errors)).toEqual(["notes:minLength"]);
    // Before the day: the route passes the page by, and its answer is withheld.
    const early = judge(dated, values, { today: "2026-01-01" });
    expect(early.errors).toEqual([]);
    expect(early.values).toEqual(placed);
    // No day: the server cannot replay the condition, so the run is refused, whatever the answers
    // (the route's page is still listed as clock-dependent when a day is given).
    const noDay = judge(dated, values);
    // The refusal comes first; the walk then falls through the route it cannot read, so the page it
    // would have passed by adds its own error. Both are pinned: nothing else is said.
    expect(codes(noDay.errors)).toEqual(["-:journey.clockDependent", "notes:minLength"]);
    expect(noDay.values).toBeUndefined();
    expect(noDay.errors.find((error) => error.code === "journey.clockDependent")?.parameters).toEqual({ journey: "apply", page: "residency" });
    expect(codes(judge(dated, { ...placed, notes: "long enough note" }).errors)).toEqual(["-:journey.clockDependent"]);
    expect(judge(dated, { ...placed, notes: "long enough note" }, { today: "2026-10-07" }).clockDependent).toEqual(["residency"]);
  });

  it("refuses a route on today(), and one that passes an exit page by, when no day was given, and runs both with one", () => {
    const routed: Journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: 'today() == "2026-10-07"', to: "details" }] },
        { id: "late", components: ["notes"] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    };
    const answers = { resident: "yes", business_name: "Shop", employer: "ACME", "contact.email": "a@b.co" };
    expect(codes(judge(routed, answers).errors)).toEqual(["-:journey.clockDependent"]);
    expect(judge(routed, answers, { today: "2026-10-07" }).errors).toEqual([]);
    const exit: Journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: 'today() <= "2026-12-31"', to: "details" }] },
        { id: "closed", kind: "exit" },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    };
    // The route cannot be read, so the walk falls through into the exit page: refused, and the
    // exit said after the refusal.
    expect(codes(judge(exit, answers).errors)).toEqual(["-:journey.clockDependent", "-:journey.exit"]);
    expect(judge(exit, answers, { today: "2026-10-07" }).errors).toEqual([]);
  });

  it("drops a route condition that does not parse, under warn, and refuses the run under fail", () => {
    const broken: Journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: "resident = ", to: "details" }] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    };
    const answers = { resident: "yes", business_name: "Shop", employer: "ACME", "contact.email": "a@b.co" };
    const warned = judge(broken, answers, { formulaErrors: "warn" });
    expect(warned.errors).toEqual([]);
    expect(warned.logs?.map((entry) => entry.level + ": " + entry.message)).toEqual([
      expect.stringMatching(/^warn: formula invalid: journey:apply:page:residency:route:0: /)
    ]);
    // Nothing said by the host or the form: fail.
    expect(judge(broken, answers).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const refused = judge(broken, answers, { formulaErrors: "fail" });
    expect(refused.errors).toEqual([
      { code: "formula.invalid", stage: "definition", source: "wasm", parameters: { where: "journey:apply:page:residency:route:0", message: expect.any(String) } }
    ]);
    expect(refused.values).toBeUndefined();
  });
});

/**
 * Presentations: a journey's pages may hold nodes of their own. The kernel
 * places the form fields they reference, fill or work out on those pages, and knows nothing
 * else of them.
 */
describe("journey kernel: a presentation's own nodes place the form's fields", () => {
  const form = presentationRoot();
  const apply = applyJourney();
  const variant = publicVariant();
  const judge = (values: Record<string, unknown>, extra: Record<string, unknown> = {}, validators: readonly KernelValidator[] = []) =>
    runKernel({ formId: "presentation", values, locale: "en", form, journey: apply, ...extra }, validators);

  it("asks for the field an alias fills on the alias's page, and for the one a worked-out value sets on that node's page", () => {
    const fold = kernelFoldSubmission(form, APPLY_BELOW, apply);
    expect(fold.trace?.pages).toEqual(["details", "income"]);
    // Only the form's components are placed: no own node's id is in the fold.
    expect({ ...fold.placements }).toEqual({ email: "on", name: "unassigned", annual_income: "on", approved_amount: "off" });
    expect(Object.keys(fold.effective)).toEqual(["form", "email", "name", "money", "annual_income", "approved_amount"]);
    // `money`, the fieldset the target sits in, is on no page and holds a placed field: never folded.
    expect(fold.placements?.money).toBeUndefined();
    expect(fold.effective.annual_income).toMatchObject({ visible: true, requiredApplies: true, runValidation: true });

    expect(codes(judge({}).errors)).toEqual(["annual_income:required", "email:required"]);
    expect(codes(judge({ email: "a@b.co" }).errors)).toEqual(["annual_income:required"]);
    const accepted = judge(APPLY_BELOW);
    expect(accepted.errors).toEqual([]);
    expect(accepted.values).toEqual(APPLY_BELOW);
  });

  it("walks the path by the worked-out field: past the threshold the next page is asked, below it the journey ends", () => {
    const above = judge(APPLY_ABOVE, { logLevel: "debug" });
    expect(above.errors).toEqual([]);
    expect(above.values).toEqual(APPLY_ABOVE);
    expect(above.logs?.find((entry) => entry.message.startsWith("journey apply"))?.data).toEqual({ pages: ["details", "income", "assist"] });
    // Below it `assist` is off the path: an answer left there is withheld.
    const below = judge({ ...APPLY_BELOW, approved_amount: 500 }, { logLevel: "info" });
    expect(below.values).toEqual(APPLY_BELOW);
    expect(below.logs?.find((entry) => entry.message === "hidden values withheld")?.data).toEqual({ fields: ["approved_amount"] });
  });

  it("holds the worked-out field to the form's own rules, and says it was worked out in the browser", () => {
    // The ceiling is the field's own declared `max`, enforced by the kernel (`number.max`), with no
    // plugin validator needed.
    const over = judge({ email: "a@b.co", annual_income: 1000001 });
    expect(codes(over.errors)).toEqual(["annual_income:number.max"]);
    expect(over.values).toBeUndefined();
    expect(over.clientDerived).toEqual(["annual_income"]);
    const under = judge({ email: "a@b.co", annual_income: 1000000 });
    expect(under.errors).toEqual([]);
    expect(under.clientDerived).toEqual(["annual_income"]);
    // Through the variant nothing is worked out: the same answer is the person's own.
    expect(runKernel({ formId: "presentation", values: { email: "a@b.co", annual_income: 5 }, locale: "en", form, journey: variant }, []).clientDerived).toBeUndefined();
  });

  it("places what an own layout references, and judges what the variant leaves out as the whole form does", () => {
    const fold = kernelFoldSubmission(form, { email: "a@b.co", name: "Ada" }, variant);
    expect(fold.trace?.pages).toEqual(["all"]);
    expect({ ...fold.placements }).toEqual({ email: "on", name: "on", money: "unassigned", annual_income: "unassigned", approved_amount: "unassigned" });
    // Form rules always hold: the variant does not ask for the income the form requires.
    const through = runKernel({ formId: "presentation", values: { email: "a@b.co", name: "Ada" }, locale: "en", form, journey: variant }, []);
    expect(codes(through.errors)).toEqual(["annual_income:required"]);
    const prefilled = runKernel({ formId: "presentation", values: { email: "a@b.co", annual_income: 5, approved_amount: 1 }, locale: "en", form, journey: variant }, []);
    expect(prefilled.errors).toEqual([]);
    expect(prefilled.values).toEqual({ email: "a@b.co", annual_income: 5, approved_amount: 1 });
  });

  it("reads none of an own node's rules and no worked-out value's expression: change them, and nothing here changes", () => {
    const rewritten: Journey = JSON.parse(JSON.stringify(apply)) as Journey;
    for (const page of rewritten.pages) {
      for (const entry of page.components ?? []) {
        if (typeof entry === "string") {
          continue;
        }
        (entry as { rules?: unknown }).rules = { visibleWhen: literal(false), requiredWhen: literal(true), value: path("host.boom"), enabledWhen: path("m1") };
        if (entry.type === "journey-value") {
          // A different expression, reading other fields, a page condition's worth of nonsense.
          entry.configuration = { ...entry.configuration, value: { kind: "call", name: "coalesce", args: [path("host.x"), path("@apply.m1")] }, label: "Other" };
        } else {
          entry.configuration = { ...entry.configuration, required: true, hidden: true, pattern: "[", minLength: 99, hiddenValueBehavior: "clear" };
        }
      }
    }
    for (const values of [APPLY_BELOW, APPLY_ABOVE, {}, { email: "a@b.co" }, { ...APPLY_BELOW, approved_amount: 9 }]) {
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        const before = judge(values, { unknownFields, logLevel: "debug" });
        const after = runKernel({ formId: "presentation", values, locale: "en", form, journey: rewritten, unknownFields, logLevel: "debug" }, []);
        expect(after, `${unknownFields}: ${JSON.stringify(values)}`).toEqual(before);
      }
    }
  });

  it("treats a key an own answer would travel under as any unknown field: stripped, kept unread, or rejected", () => {
    const forged = { ...APPLY_BELOW, "@apply.m1": 12000, "@apply.work_email": "x", m1: 1, work_email: "y", income_total: 3 };
    const stripped = judge(forged, { logLevel: "info" });
    expect(stripped.errors).toEqual([]);
    expect(stripped.values).toEqual(APPLY_BELOW);
    expect(stripped.logs?.find((entry) => entry.message === "unknown fields stripped")?.data).toEqual({ fields: ["@apply.m1", "@apply.work_email", "m1", "work_email", "income_total"] });
    const kept = judge(forged, { unknownFields: "keep" });
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual(forged);
    const rejected = judge(forged, { unknownFields: "reject" });
    expect(rejected.values).toBeUndefined();
    expect(rejected.errors).toEqual(
      ["@apply.m1", "@apply.work_email", "m1", "work_email", "income_total"].map((field) => ({ code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field } }))
    );
    // Kept, they steer nothing: the path and the verdict are the ones the form values give.
    expect(kernelFoldSubmission(form, forged, apply).trace).toEqual(kernelFoldSubmission(form, APPLY_BELOW, apply).trace);
  });

  it("never answers journey.invalid for a node that clashes or points nowhere: it is ignored, and the form's rules hold", () => {
    const broken: Journey = {
      id: "apply",
      pages: [
        {
          id: "details",
          components: [
            { id: "email", type: "text", configuration: { fills: "name" } }, // rule A: a form component's id
            { id: "upload", type: "file" }, // rule B
            { id: "keyed", type: "text", configuration: { dataKey: "k" } }, // rule C
            { type: "journey-field", configuration: { componentId: "ghost" } }, // rule D
            { id: "to_section", type: "text", configuration: { fills: "money" } }, // rule E
            { id: "note", type: "html", configuration: { fills: "name" } }, // rule F
            { id: "work_email", type: "text", configuration: { fills: "email" } },
            "annual_income",
            { id: "again", type: "journey-value", configuration: { to: "annual_income", value: literal(1) } } // rule G
          ]
        }
      ]
    };
    expect(validateJourneyShape(broken)).toEqual([]);
    expect(kernelIsJourney(broken)).toBe(true);
    const outcome = runKernel({ formId: "presentation", values: { email: "a@b.co", annual_income: 5 }, locale: "en", form, journey: broken, logLevel: "debug" }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ email: "a@b.co", annual_income: 5 });
    // Nothing worked it out here: the ignored node places and reports nothing.
    expect(outcome.clientDerived).toBeUndefined();
    const fold = kernelFoldSubmission(form, { email: "a@b.co", annual_income: 5 }, broken);
    expect({ ...fold.placements }).toEqual({ email: "on", name: "unassigned", annual_income: "on", approved_amount: "unassigned" });
    expect(codes(runKernel({ formId: "presentation", values: {}, locale: "en", form, journey: broken }, []).errors)).toEqual(["annual_income:required", "email:required"]);
  });

  it("carries a journey with own nodes through the serialized context, with context.page answered", () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext({ formId: "presentation", values: APPLY_ABOVE, locale: "en", form, journey: apply, page: "income" }, WasmValidationHost.STRICT_POLICY);
    expect(abi.deserializeOutcome(instance.run(payload) as string)).toEqual({
      errors: [],
      values: APPLY_ABOVE,
      // The value index of the same values, in their serialized key order.
      index: [
        { path: "annual_income", delta: "", value: 60000 },
        { path: "approved_amount", delta: "", value: 500 },
        { path: "email", delta: "", value: "ada@example.org" }
      ],
      clientDerived: ["annual_income"],
      pageComponentIds: ["annual_income"]
    });
  });
});
