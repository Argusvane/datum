import { describe, expect, it } from "vitest";

import {
  coreDeterministicValidator,
  coreValidationRoot,
  coreValidationStage,
  coreValidationVectors,
  createBrowserAdapter,
  createFieldConstraintsStage,
  createServerAdapter,
  createWasmAdapter,
  FormRuntime,
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  kernelFlattenRows,
  kernelNormalizeDataGrids,
  PORTABLE_KERNEL_FUNCTIONS,
  runParity,
  ServerValidationRunner,
  SubmissionModeRegistry,
  ValidationPipeline,
  WasmValidationHost,
  type ComponentNode,
  type Expression,
  type FormDefinition,
  type FormulaErrorPolicy,
  type Journey,
  type WasmPlugin
} from "@argusvane/datum-engine";

import { WASM_ABI_VERSION, kernelIsJourney, validateJourneyShape } from "@argusvane/datum-engine";
import {
  APPLY_ABOVE,
  APPLY_BELOW,
  applyJourney,
  presentationRoot,
  publicVariant
} from "@argusvane/datum-engine/tests/fixtures/presentation-form";

import { QuickJsWasmHostAdapter, buildSandboxProgram, toSourcePlugin } from "../src/index.js";
import {
  FORMULA_CLOCK_DEPENDENT,
  FORMULA_NEXT_YEAR,
  FORMULA_SERVER_RULES,
  FORMULA_TODAY,
  FORMULA_TYPO,
  formulaAnswerSets,
  formulaHonestAnswers,
  formulaJourney,
  formulaPlugin,
  formulaRoot,
  formulaRootWithTypo,
  formulaStaleAnswers
} from "./fixtures/formula-form.js";

/** The same validator, once as a hosted function and once as derived portable source. */
const corePlugin: WasmPlugin = {
  id: "core",
  version: "1.0.0",
  validators: [{ id: "core", version: "1.0.0", validate: coreDeterministicValidator }]
};

const constraintRoot: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "email", type: "text", configuration: { required: true, pattern: "[^@]+@[^@]+" } },
      {
        id: "applicant",
        type: "container",
        configuration: {},
        children: { content: [{ id: "firstName", type: "text", configuration: { required: true } }] }
      }
    ]
  }
};

describe("QuickJS vs in-process kernel parity (two genuinely different JS engines)", () => {
  it("produces byte-identical serialized outcomes for every core vector", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([corePlugin], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(corePlugin)], abi);

    for (const vector of coreValidationVectors) {
      const payload = abi.serializeContext(
        { ...vector.context, form: coreValidationRoot },
        WasmValidationHost.STRICT_POLICY
      );
      const inProcessResult = inProcess.run(payload);
      const quickJsResult = await quickJs.run(payload);
      expect(quickJsResult, `vector ${vector.id}`).toBe(inProcessResult);
    }
    quickJs.dispose?.();
  });

  it("produces byte-identical outcomes for sanitization and constraint cases", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);

    const cases: Array<Record<string, unknown>> = [
      {},
      { email: "a@b.co", "applicant.firstName": "Ada" },
      { email: "not-an-email", "applicant.firstName": "Ada" },
      { email: "a@b.co", "applicant.firstName": "Ada", rogue: "x", "applicant.zz": 1 },
      { email: "  ", "applicant.firstName": "" }
    ];
    const modes = [undefined, "strip", "keep", "reject"] as const;

    for (const values of cases) {
      for (const unknownFields of modes) {
        const payload = abi.serializeContext(
          {
            formId: "f",
            values,
            locale: "en",
            form: constraintRoot,
            ...(unknownFields !== undefined ? { unknownFields } : {})
          },
          WasmValidationHost.STRICT_POLICY
        );
        expect(await quickJs.run(payload), `${unknownFields ?? "default"}: ${JSON.stringify(values)}`).toBe(
          inProcess.run(payload)
        );
      }
    }
    quickJs.dispose?.();
  });

  it("reads data keys and repeating sections identically", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const keyedRoot: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "billing_address",
            type: "container",
            configuration: { dataKey: "billing" },
            children: { content: [{ id: "billing_street", type: "text", configuration: { dataKey: "street", required: true, minLength: 3 } }] }
          },
          {
            id: "order",
            type: "container",
            configuration: {},
            children: {
              content: [
                {
                  id: "order_items",
                  type: "panel",
                  configuration: {},
                  collection: { collectionPath: "order.items" },
                  children: { content: [{ id: "item_name", type: "text", configuration: { dataKey: "name" } }] }
                }
              ]
            }
          },
          { id: "unusable", type: "text", configuration: { dataKey: "no good" } }
        ]
      }
    };
    const cases: Array<Record<string, unknown>> = [
      {},
      { "billing.street": "Main", "order.items[0].name": "Widget", unusable: "kept" },
      { "billing.street": "ab", billing_street: "dropped", "items[0].name": "dropped", "order.order_items.item_name": "dropped" }
    ];
    for (const values of cases) {
      for (const unknownFields of [undefined, "reject"] as const) {
        const payload = abi.serializeContext(
          { formId: "f", values, locale: "en", form: keyedRoot, ...(unknownFields !== undefined ? { unknownFields } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        expect(await quickJs.run(payload), `${unknownFields ?? "default"}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
      }
    }
    // And what both say: keyed answers kept, id-built paths dropped.
    const kept = JSON.parse(
      await quickJs.run(abi.serializeContext({ formId: "f", values: cases[1]!, locale: "en", form: keyedRoot }, WasmValidationHost.STRICT_POLICY))
    ) as { values?: Record<string, unknown> };
    expect(kept.values).toEqual({ "billing.street": "Main", "order.items[0].name": "Widget", unusable: "kept" });
    quickJs.dispose?.();
  });

  it("produces byte-identical run logs at every level, the rules' own entries included", async () => {
    const abi = new JsonWasmAbi();
    const chatty: WasmPlugin = {
      id: "chatty",
      version: "1.0.0",
      validators: [
        {
          id: "chatty",
          version: "1.0.0",
          validate: (context) => {
            context.log?.debug("rule saw", { keys: Object.keys(context.values) });
            context.log?.info("rule done");
            return { errors: [] };
          }
        }
      ]
    };
    const inProcess = new InProcessWasmHostAdapter().instantiate([chatty], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(chatty)], abi);

    for (const logLevel of ["off", "error", "warn", "info", "debug"] as const) {
      const payload = abi.serializeContext(
        { formId: "f", values: { email: "a@b.co", "applicant.firstName": "Ada", rogue: 1 }, locale: "en", form: constraintRoot, logLevel },
        WasmValidationHost.STRICT_POLICY
      );
      const fromQuickJs = await quickJs.run(payload);
      expect(fromQuickJs, logLevel).toBe(inProcess.run(payload));
      const outcome = abi.deserializeOutcome(fromQuickJs);
      if (logLevel === "debug") {
        // The ABI serializes the context with sorted keys, so that is the order the rule saw — on both engines.
        expect(outcome.logs?.find((entry) => entry.message === "rule saw")?.data).toEqual({ keys: ["applicant.firstName", "email"] });
        expect(outcome.logs?.map((entry) => entry.message)).toContain("unknown fields stripped");
      } else if (logLevel === "info") {
        expect(outcome.logs?.map((entry) => entry.message)).toEqual(["unknown fields stripped", "rule done", "accepted: 0 error(s), 2 value(s)"]);
      } else {
        expect(outcome.logs).toBeUndefined();
      }
    }
    quickJs.dispose?.();
  });

  it("recomputes calculations, judges entries by their section, checks a context journey's shape, keeps a hidden answer's format and refuses an unsettled fold identically", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const path = (name: string): Expression => ({ kind: "path", path: name });
    const literal = (value: string | number | boolean): Expression => ({ kind: "literal", value });
    const isFull: Expression = { kind: "binary", operator: "eq", left: path("kind"), right: literal("full") };
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "kind", type: "select", configuration: { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] } },
          { id: "birth_year", type: "number", configuration: {} },
          { id: "age", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "subtract", left: literal(2026), right: path("birth_year") } } },
          { id: "minor", type: "checkbox", configuration: {}, rules: { value: { kind: "binary", operator: "lt", left: path("age"), right: literal(18) } } },
          { id: "guardian", type: "text", configuration: { required: true }, rules: { visibleWhen: { kind: "binary", operator: "eq", left: path("minor"), right: literal(true) } } },
          // Retained: the subject is that a hidden answer is still sent, so its format still holds.
          { id: "note", type: "text", configuration: { maxLength: 4, pattern: "[a-z]+", hiddenValueBehavior: "retain" }, rules: { visibleWhen: isFull } },
          {
            id: "items",
            type: "repeatingSection",
            configuration: {},
            collection: { itemFields: ["sku"], collectionPath: "order_lines" },
            children: { content: [{ id: "sku", type: "text", configuration: {} }] }
          },
          // empty() keeps each rule a real yes or no: a condition holds only for true (strict truthiness).
          { id: "a", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { kind: "call", name: "empty", args: [path("b")] } } },
          { id: "b", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { kind: "unary", operator: "not", operand: { kind: "call", name: "empty", args: [path("a")] } } } }
        ]
      }
    };
    const journey: Journey = {
      id: "order",
      pages: [
        { id: "start", components: ["kind", "birth_year", "guardian", "note", "a", "b"], routes: [{ when: { kind: "unary", operator: "not", operand: isFull }, to: "$end" }] },
        { id: "full", components: ["items"] }
      ]
    };
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ kind: "short", birth_year: 2015, age: 40, minor: false }, journey],
      [{ kind: "short", birth_year: 1990, age: 36, minor: false, "order_lines[0].sku": "abandoned" }, journey],
      [{ kind: "full", birth_year: 1990, "order_lines[0].sku": "kept" }, journey],
      [{ kind: "short", birth_year: 1990, note: "WAY TOO LONG" }, undefined],
      [{ kind: "short", birth_year: 1990, a: "x", b: "y" }, undefined],
      [{ kind: "short" }, { ...journey, pages: [{ ...journey.pages[0]!, routes: [{ to: "$end", when: 7 }] }] }],
      [{ kind: "short" }, { ...journey, offPathValues: "bogus" }],
      [{ kind: "short" }, { ...journey, pages: [journey.pages[0]!, { ...journey.pages[1]!, id: "start" }] }]
    ];
    for (const [values, candidate] of cases) {
      const payload = abi.serializeContext(
        { formId: "f", values, locale: "en", form, logLevel: "debug", ...(candidate !== undefined ? { journey: candidate as never } : {}) },
        WasmValidationHost.STRICT_POLICY
      );
      expect(await quickJs.run(payload), JSON.stringify(values)).toBe(inProcess.run(payload));
    }
    const codesOf = async (index: number): Promise<string[]> => {
      const [values, candidate] = cases[index]!;
      // Warn opt-in: the default is fail, which
      // would answer formula.invalid for the malformed `when` before the shape check.
      const payload = abi.serializeContext({ formId: "f", values, locale: "en", form, formulaErrors: "warn", ...(candidate !== undefined ? { journey: candidate as never } : {}) }, WasmValidationHost.STRICT_POLICY);
      return abi.deserializeOutcome(await quickJs.run(payload)).errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);
    };
    expect(await codesOf(0)).toEqual(["guardian:required"]);
    expect(abi.deserializeOutcome(await quickJs.run(abi.serializeContext({ formId: "f", values: cases[1]![0], locale: "en", form, journey }, WasmValidationHost.STRICT_POLICY))).values).toEqual({
      kind: "short",
      birth_year: 1990,
      age: 36,
      minor: false
    });
    expect(await codesOf(3)).toEqual(["note:maxLength"]);
    expect(await codesOf(4)).toEqual(["-:fold.unsettled"]);
    expect(await codesOf(5)).toEqual(["-:journey.invalid"]);
    expect(await codesOf(6)).toEqual(["-:journey.invalid"]);
    expect(await codesOf(7)).toEqual(["-:journey.invalid"]);
    quickJs.dispose?.();
  });

  it("writes unsorted, unicode and odd-keyed outcomes byte-identically, with and without a validator", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "zeta", type: "text", configuration: { dataKey: "\u00e9t\u00e9" } },
          { id: "alpha", type: "text", configuration: {} },
          { id: "Beta", type: "text", configuration: {} },
          { id: "rows", type: "repeating-section", configuration: { collectionPath: "rows" }, children: { content: [{ id: "name", type: "text", configuration: {} }, { id: "amt", type: "number", configuration: {} }] } }
        ]
      }
    };
    const values = {
      zeta: "\u4e2d\ud83d\ude00",
      alpha: "a\"b\\c\u2028",
      Beta: "",
      "rows[1].name": "second",
      "rows[0].amt": 1e21,
      "rows[0].name": "first",
      "rows[01].name": "bad",
      stray: { b: 1, a: [2, { z: 1, y: 2 }] }
    };
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const payload = abi.serializeContext({ formId: "f", values, locale: "en", form, unknownFields, logLevel: "debug" }, WasmValidationHost.STRICT_POLICY);
      expect(await quickJs.run(payload), unknownFields).toBe(inProcess.run(payload));
    }
    quickJs.dispose?.();
  });

  it("declares every spliced function once, and each import namespace the kernel's cross-module calls read", () => {
    const program = buildSandboxProgram();
    for (const fn of PORTABLE_KERNEL_FUNCTIONS) {
      expect(program.split(`function ${fn.name}(`).length - 1, fn.name).toBe(1);
    }
    // Under vitest the engine's sources go through Vite's SSR transform, so the fold's call to
    // journeyPath reads a namespace; the program must declare every one it reads.
    const read = new Set(program.match(/\b__vite_ssr_import_\d+__(?=\.)/g) ?? []);
    expect(read.size).toBeGreaterThan(0);
    for (const name of read) {
      expect(program, name).toContain(`var ${name} = __datum_kernel_scope;`);
    }
  });

  it("splices no clock, locale or randomness into the sandbox: no Date, Intl or Math.random in any kernel function", () => {
    // The sandbox disables Date and Math.random and has no Intl; a kernel function reaching for
    // one would throw there and run here, the one drift this suite exists to rule out. The
    // day the rules read is `context.today`, never the clock.
    const forbidden = /\bDate\b|\bIntl\b|Math\.random/;
    // Vite's transform keeps the sources' comments, which may name a Date in prose: only code counts.
    const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|(?<![:"'`])\/\/.*$/gm, "");
    for (const fn of PORTABLE_KERNEL_FUNCTIONS) {
      expect(withoutComments(fn.toString()), fn.name).not.toMatch(forbidden);
    }
  });

  it("folds visibility and works a journey's path out identically", async () => {
    const abi = new JsonWasmAbi();
    // A validator that flags every answer it sees, and one it does not: the kernel drops what
    // lands on a component the fold does not validate, on both engines.
    const flagging: WasmPlugin = {
      id: "flagging",
      version: "1.0.0",
      validators: [
        {
          id: "flagging",
          version: "1.0.0",
          validate: (context) => ({
            errors: Object.keys(context.values)
              .concat(["employer"])
              .map((key) => ({ code: "custom.seen", componentId: key.split(".").pop() as string, stage: "plugin", source: "custom" as const }))
          })
        }
      ]
    };
    const inProcess = new InProcessWasmHostAdapter().instantiate([flagging], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(flagging)], abi);
    const eq = (path: string, value: string | boolean) => ({
      kind: "binary" as const,
      operator: "eq" as const,
      left: { kind: "path" as const, path },
      right: { kind: "literal" as const, value }
    });
    const form: ComponentNode = {
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
            children: { content: [{ id: "email", type: "text", configuration: { required: true } }] }
          },
          { id: "admin_note", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("host.role", "admin") } },
          { id: "pet", type: "text", configuration: { required: true }, rules: { visibleWhen: eq("employed", true) } },
          { id: "notes", type: "textarea", configuration: { minLength: 10 } },
          { id: "exit_message", type: "html", configuration: {} }
        ]
      }
    };
    const journey = {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "ineligible" }] },
        { id: "work", components: ["employed", "pet", "admin_note"], routes: [{ when: eq("employed", true), to: "employment" }] },
        { id: "self", components: ["business_name"], routes: [{ to: "details" }] },
        { id: "employment", components: ["employer"] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] },
        { id: "ineligible", kind: "exit" as const, components: ["exit_message"] }
      ]
    };
    const cases: Array<Record<string, unknown>> = [
      {},
      { resident: "yes", employed: true, employer: "ACME", business_name: "x", pet: "Rex", admin_note: "n", "contact.email": "a@b.co" },
      { resident: "yes", business_name: "Shop", employer: "stale", pet: "stale", admin_note: "n", "contact.email": "a@b.co", notes: "short", rogue: 1 },
      { resident: "no", "contact.email": "a@b.co" }
    ];
    for (const values of cases) {
      for (const withJourney of [true, false]) {
        const payload = abi.serializeContext(
          { formId: "f", values, locale: "en", form, logLevel: "debug", ...(withJourney ? { journey } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        expect(await quickJs.run(payload), `${withJourney ? "journey" : "form"}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
      }
    }
    // And what both say for the self-employed branch: the employment page's answer is gone,
    // the note on no page kept and judged as the whole form judges it (held to its
    // length, and the validator's error on it stands), the
    // host-ruled field still required, the validator's errors on hidden components dropped.
    const outcome = abi.deserializeOutcome(
      await quickJs.run(abi.serializeContext({ formId: "f", values: cases[2]!, locale: "en", form, journey }, WasmValidationHost.STRICT_POLICY))
    );
    expect(outcome.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort()).toEqual(
      ["admin_note:custom.seen", "business_name:custom.seen", "email:custom.seen", "notes:custom.seen", "notes:minLength", "resident:custom.seen"].sort()
    );
    const exit = abi.deserializeOutcome(
      await quickJs.run(abi.serializeContext({ formId: "f", values: cases[3]!, locale: "en", form, journey }, WasmValidationHost.STRICT_POLICY))
    );
    expect(exit.errors.map((error) => error.code)).toContain("journey.exit");
    quickJs.dispose?.();
  });

  it("treats ids and keys named after Object.prototype members as data, identically on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const eq = (path: string, value: string) => ({
      kind: "binary" as const,
      operator: "eq" as const,
      left: { kind: "path" as const, path },
      right: { kind: "literal" as const, value }
    });
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "constructor", type: "select", configuration: { required: true, options: [{ value: "c", label: "c" }, { value: "skip", label: "skip" }, { value: "out", label: "out" }, { value: "in", label: "in" }] } },
          { id: "toString", type: "text", configuration: { required: true, minLength: 3 } },
          { id: "valueOf", type: "text", configuration: { dataKey: "__proto__", required: true } }
        ]
      }
    };
    const journey = {
      id: "__proto__",
      pages: [
        { id: "constructor", components: ["constructor", "valueOf"], routes: [{ when: eq("constructor", "skip"), to: "$end" }] },
        { id: "toString", components: ["toString"] }
      ]
    };
    const cases = [
      "{}",
      '{"constructor": "in", "toString": "to", "__proto__": "p"}',
      '{"constructor": "skip", "toString": "stale", "__proto__": "p", "hasOwnProperty": "h"}',
      '{"constructor": "in", "toString": "long", "__proto__": "p", "isPrototypeOf": 1}'
    ];
    for (const text of cases) {
      const values = JSON.parse(text) as Record<string, unknown>;
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        for (const withJourney of [true, false]) {
          const payload = abi.serializeContext(
            { formId: "f", values, locale: "en", form, unknownFields, logLevel: "debug", ...(withJourney ? { journey } : {}) },
            WasmValidationHost.STRICT_POLICY
          );
          expect(await quickJs.run(payload), `${unknownFields}, ${withJourney ? "journey" : "form"}: ${text}`).toBe(inProcess.run(payload));
        }
      }
    }
    // What both say when the route skips toString's page and the host keeps unknown keys.
    const kept = abi.deserializeOutcome(
      await quickJs.run(
        abi.serializeContext(
          { formId: "f", values: JSON.parse(cases[2]!) as Record<string, unknown>, locale: "en", form, unknownFields: "keep", journey },
          WasmValidationHost.STRICT_POLICY
        )
      )
    );
    expect(kept.errors).toEqual([]);
    expect(Object.keys(kept.values ?? {}).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty"]);
    quickJs.dispose?.();
  });

  it("calls a required calculation with no answer unanswered and keeps a data grid's rows in strip mode: the browser with QuickJS as its sandbox, QuickJS over the envelope and the in-process kernel agree", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const path = (name: string): Expression => ({ kind: "path", path: name });
    const envelope = { form: { id: "f", version: "1" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } };
    const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>) => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
    const definitionOf = (content: ComponentNode[]): FormDefinition => ({ id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content } } });
    /** A runtime the person answers in: QuickJS as its sandbox, or the client pipeline alone. */
    const runtimeOf = async (definition: FormDefinition, sandboxed: boolean) => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const host = sandboxed ? await WasmValidationHost.create([], { adapter: new QuickJsWasmHostAdapter() }) : undefined;
      const runtime = new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        ...(host ? { wasmValidationHost: host } : {})
      });
      return { runtime, dispose: () => host?.dispose() };
    };
    /** Both engines over the same envelope values, byte for byte; what QuickJS said. */
    const judge = async (definition: FormDefinition, values: Record<string, unknown>, unknownFields: "strip" | "keep" | "reject") => {
      const payload = abi.serializeContext({ formId: "f", values, locale: "en", form: definition.root, unknownFields }, WasmValidationHost.STRICT_POLICY);
      const text = await quickJs.run(payload);
      expect(text, `${unknownFields}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
      return abi.deserializeOutcome(text);
    };

    // A required ratio that divides by an empty household, and a fee over it: arithmetic over
    // a missing operand or by zero is no answer (DMN FEEL), so the browser stores nothing and
    // the wire carries no key; never NaN, never null.
    const household = definitionOf([
      { id: "income", type: "number", configuration: { required: true } },
      { id: "members", type: "number", configuration: {} },
      { id: "ratio", type: "number", configuration: { required: true }, rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } },
      { id: "fee", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "multiply", left: path("members"), right: { kind: "literal", value: 2 } } } }
    ]);
    for (const members of [undefined, 0]) {
      for (const sandboxed of [true, false]) {
        const label = `members ${String(members)}, ${sandboxed ? "QuickJS sandbox" : "client alone"}`;
        const { runtime, dispose } = await runtimeOf(household, sandboxed);
        runtime.setValue("income", 1200);
        if (members !== undefined) {
          runtime.setValue("members", members);
        }
        expect(runtime.state().values.ratio, label).toBeUndefined();
        const submitted = await runtime.submit("submit", envelope);
        expect({ accepted: submitted.accepted, errors: codes(submitted.errors) }, label).toEqual({ accepted: false, errors: ["ratio:required"] });
        const sent = await runtime.submit("send", envelope);
        const values = sent.canonicalSubmission!.submission.values;
        expect(values, label).toStrictEqual(members === undefined ? { income: 1200 } : { income: 1200, members: 0, fee: 0 });
        expect(codes((await judge(household, values, "strip")).errors), label).toEqual(["ratio:required"]);
        // A forged ratio over a zero household is worked out again by both engines: no answer.
        if (members === 0) {
          const forged = await judge(household, { ...values, ratio: 7 }, "strip");
          expect(codes(forged.errors), label).toEqual(["ratio:required"]);
        }
        dispose();
      }
    }
    // Answered, the ratio is a number on every side.
    {
      const { runtime, dispose } = await runtimeOf(household, true);
      runtime.setValue("income", 1200);
      runtime.setValue("members", 3);
      const submitted = await runtime.submit("submit", envelope);
      expect(submitted.accepted).toBe(true);
      const values = submitted.canonicalSubmission!.submission.values;
      expect(values).toStrictEqual({ income: 1200, members: 3, ratio: 400, fee: 6 });
      expect((await judge(household, values, "strip")).values).toEqual(values);
      dispose();
    }

    // A data grid's first row decides whether `rush` is asked; its rows are keys the schema defines.
    const bigOrder: Expression = { kind: "binary", operator: "gt", left: path("orders[0].qty"), right: { kind: "literal", value: 5 } };
    const ordering = definitionOf([
      {
        id: "orders_grid",
        type: "dataGrid",
        // No opening rows (`initialRows: 0`), so the browser holds exactly the row the test adds.
        configuration: { initialRows: 0 },
        collection: { collectionPath: "orders" },
        children: {
          content: [
            { id: "qty", type: "number", configuration: {} },
            { id: "sku", type: "text", configuration: {} }
          ]
        }
      },
      { id: "rush", type: "text", configuration: { required: true }, rules: { visibleWhen: bigOrder } }
    ]);
    for (const qty of [10, 2]) {
      for (const sandboxed of [true, false]) {
        const label = `qty ${qty}, ${sandboxed ? "QuickJS sandbox" : "client alone"}`;
        const { runtime, dispose } = await runtimeOf(ordering, sandboxed);
        runtime.addRow("orders", { qty, sku: "A1" });
        const unanswered = await runtime.submit("submit", envelope);
        expect(codes(unanswered.errors), label).toEqual(qty > 5 ? ["rush:required"] : []);
        runtime.setValue("rush", "today");
        const submitted = await runtime.submit("submit", envelope);
        expect(submitted.accepted, label).toBe(true);
        const values = submitted.canonicalSubmission!.submission.values;
        // The rows travel in the envelope, the sandbox's own strip mode included (a hidden `rush`
        // is left out, the default, so it is sent only when the first row asks for it): one list
        // at the collection path, which both kernels read as the flat keys
        // they return.
        const rush = qty > 5 ? { rush: "today" } : {};
        expect(values, label).toStrictEqual({ orders: [{ qty, sku: "A1" }], ...rush });
        const flattened = { ...kernelFlattenRows(values, kernelNormalizeDataGrids(ordering.root)).values };
        expect(flattened, label).toStrictEqual({ "orders[0].qty": qty, "orders[0].sku": "A1", ...rush });
        for (const unknownFields of ["strip", "keep", "reject"] as const) {
          const outcome = await judge(ordering, values, unknownFields);
          expect(outcome.errors, `${label}, ${unknownFields}`).toEqual([]);
          expect(outcome.values, `${label}, ${unknownFields}`).toEqual(flattened);
        }
        // Unanswered on the server too: the cell asks for `rush` there as well.
        const withoutRush = { "orders[0].qty": qty, "orders[0].sku": "A1" };
        expect(codes((await judge(ordering, withoutRush, "strip")).errors), label).toEqual(qty > 5 ? ["rush:required"] : []);
        dispose();
      }
    }
    quickJs.dispose?.();
  });

  it("holds a field to its Required-when rule identically: QuickJS over the envelope, the in-process kernel, and the browser with QuickJS as its sandbox", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const path = (name: string): Expression => ({ kind: "path", path: name });
    const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
    const eq = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: path(name), right: literal(value) });
    const ratioKnown: Expression = { kind: "binary", operator: "neq", left: path("ratio"), right: literal(null) };
    const envelope = { form: { id: "reach", version: "1" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } };
    const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>) => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
    const field = (id: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({ id, type: "text", configuration, ...extra });
    // The engine's parity fixture (engine/tests/journey-kernel-parity.test.ts), spelled out for this package.
    const journey: Journey = {
      id: "reach",
      pages: [
        { id: "how", components: ["contact", "phone", "gate", "secret", "echo", "branch"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("branch", "x") }, to: "finish" }] },
        { id: "detailed", components: ["detail"] },
        { id: "finish", components: ["extra", "billing", "staff_note", "both", "income", "members", "ratio", "per_head"], routes: [{ to: "$end" }] }
      ]
    };
    const definition: FormDefinition = {
      id: "reach",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            field("contact", {}, { type: "radio" }),
            field("phone", {}, { rules: { requiredWhen: eq("contact", "phone") } }),
            field("gate", {}, { type: "checkbox" }),
            field("secret", { hiddenValueBehavior: "exclude-from-submission" }, { rules: { visibleWhen: eq("gate", true) } }),
            field("echo", {}, { rules: { requiredWhen: eq("secret", "open") } }),
            field("branch", {}, { type: "select" }),
            field("detail"),
            field("extra", {}, { rules: { requiredWhen: eq("detail", "yes") } }),
            { id: "billing", type: "container", configuration: {}, children: { content: [field("postcode", { dataKey: "code" }, { rules: { requiredWhen: eq("contact", "post") } })] } },
            field("staff_note", {}, { rules: { requiredWhen: eq("host.role", "staff") } }),
            field("both", { required: true }, { rules: { requiredWhen: eq("contact", "never") } }),
            field("income", {}, { type: "number" }),
            field("members", {}, { type: "number" }),
            field("ratio", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } }),
            field("per_head", {}, { rules: { requiredWhen: ratioKnown } })
          ]
        }
      },
      journey: { journeys: [journey] }
    };
    // As the browser's envelope carries them: the ticked field filled, no rule holding, and the
    // calculation over the missing household has no answer, so no key: a missing answer and null
    // are the same nothing under `neq(ratio, null)`, on both sides.
    const REACHABLE = { contact: "email", both: "yes" };
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ ...REACHABLE, contact: "phone" }, ["phone:required"]],
      [{ ...REACHABLE, contact: "phone", phone: "555 0100" }, []],
      [REACHABLE, []],
      [{ contact: "email" }, ["both:required"]],
      [{ ...REACHABLE, gate: false, secret: "open" }, []],
      [{ ...REACHABLE, gate: true, secret: "open" }, ["echo:required"]],
      [{ ...REACHABLE, branch: "y", detail: "yes" }, []],
      [{ ...REACHABLE, branch: "x", detail: "yes" }, ["extra:required"]],
      [{ ...REACHABLE, contact: "post" }, ["postcode:required"]],
      [{ ...REACHABLE, contact: "post", "billing.code": "K1A 0B1" }, []],
      [{ ...REACHABLE, income: 1200 }, []],
      [{ ...REACHABLE, income: 1200, members: 0 }, []],
      [{ ...REACHABLE, income: 1200, members: 3 }, ["per_head:required"]]
    ];
    for (const [values, expected] of cases) {
      const label = JSON.stringify(values);
      for (const withJourney of [true, false]) {
        const payload = abi.serializeContext(
          { formId: "reach", values, locale: "en", form: definition.root, logLevel: "debug", externalData: { role: "staff" }, ...(withJourney ? { journey } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        const text = await quickJs.run(payload);
        expect(text, `${withJourney ? "journey" : "form"}: ${label}`).toBe(inProcess.run(payload));
        if (withJourney) {
          expect(codes(abi.deserializeOutcome(text).errors), label).toEqual(expected);
        }
      }
    }
    // The whole form has no skipped page: the stale detail then holds `extra` to its rule.
    const whole = abi.deserializeOutcome(
      await quickJs.run(abi.serializeContext({ formId: "reach", values: { ...REACHABLE, branch: "y", detail: "yes" }, locale: "en", form: definition.root }, WasmValidationHost.STRICT_POLICY))
    );
    expect(codes(whole.errors)).toEqual(["extra:required"]);

    // The browser with QuickJS as its sandbox reaches the same verdicts as the client pipeline alone.
    const runtimeOf = async (sandboxed: boolean, hostContext?: Record<string, unknown>) => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const host = sandboxed ? await WasmValidationHost.create([], { adapter: new QuickJsWasmHostAdapter() }) : undefined;
      const runtime = new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        ...(host ? { wasmValidationHost: host } : {}),
        ...(hostContext ? { hostContext } : {})
      });
      return { runtime, dispose: () => host?.dispose() };
    };
    for (const sandboxed of [true, false]) {
      const label = sandboxed ? "QuickJS sandbox" : "client alone";
      const { runtime, dispose } = await runtimeOf(sandboxed);
      runtime.setValue("contact", "phone");
      runtime.setValue("both", "yes");
      const blocked = await runtime.submit("submit", envelope);
      expect({ accepted: blocked.accepted, errors: codes(blocked.errors) }, label).toEqual({ accepted: false, errors: ["phone:required"] });
      expect(codes(await runtime.validate({ page: "how" })), label).toEqual(["phone:required"]);
      runtime.setValue("phone", "555 0100");
      const accepted = await runtime.submit("submit", envelope);
      expect(accepted.accepted, label).toBe(true);
      expect(accepted.canonicalSubmission!.submission.values, label).toStrictEqual({ contact: "phone", phone: "555 0100", both: "yes" });
      dispose();
    }
    // A rule reading host.: the browser with a host context refuses, QuickJS over its envelope accepts.
    const { runtime: hosted, dispose } = await runtimeOf(true, { role: "staff" });
    hosted.setValue("contact", "email");
    hosted.setValue("both", "yes");
    const refused = await hosted.submit("submit", envelope);
    expect(codes(refused.errors)).toEqual(["staff_note:required"]);
    const sent = await hosted.submit("send", envelope);
    const values = sent.canonicalSubmission!.submission.values;
    const server = abi.deserializeOutcome(
      await quickJs.run(abi.serializeContext({ formId: "reach", values, locale: "en", form: definition.root, journey, externalData: { role: "staff" } }, WasmValidationHost.STRICT_POLICY))
    );
    expect(server.errors).toEqual([]);
    expect(server.values).toEqual(values);
    dispose();
    quickJs.dispose?.();
  });

  it("reads a hand-written null rules block or null requiredWhen as no rule, identically on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    // A definition the 2.5 program accepted: a 2.6 program accepts it too, rather than throwing
    // inside the fold and refusing every submission with an execution error.
    const lenient = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "ticked", type: "text", configuration: { required: true }, rules: null },
          { id: "a", type: "text", configuration: {}, rules: null },
          { id: "b", type: "text", configuration: {}, rules: { requiredWhen: null } }
        ]
      }
    } as unknown as ComponentNode;
    for (const values of [{ ticked: "x" }, { ticked: "x", a: "", b: "" }, {}]) {
      const payload = abi.serializeContext({ formId: "n", values, locale: "en", form: lenient, logLevel: "debug" }, WasmValidationHost.STRICT_POLICY);
      const text = await quickJs.run(payload);
      expect(text, JSON.stringify(values)).toBe(inProcess.run(payload));
      const outcome = abi.deserializeOutcome(text);
      expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`), JSON.stringify(values)).toEqual(
        "ticked" in values ? [] : ["ticked:required"]
      );
    }
    quickJs.dispose?.();
  });

  it("judges a form field a journey places on no page as the whole form judges it, identically: QuickJS over the envelope, the in-process kernel, and the browser with QuickJS as its sandbox", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const path = (name: string): Expression => ({ kind: "path", path: name });
    const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
    const eq = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: path(name), right: literal(value) });
    const staff = eq("host.role", "staff");
    const envelope = { form: { id: "short", version: "1" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } };
    const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>) => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
    const field = (id: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode => ({ id, type: "text", configuration, ...extra });
    // The engine's parity fixture (engine/tests/journey-kernel-parity.test.ts `leftOut`), spelled out for this package:
    // a two-page journey leaves most of the form off every page.
    const journey: Journey = {
      id: "short",
      pages: [
        { id: "start", components: ["resident"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("resident", "yes") }, to: "$end" }] },
        { id: "more", components: ["extra"] }
      ]
    };
    const definition: FormDefinition = {
      id: "short",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            field("resident", { required: true }, { type: "select" }),
            field("extra", { required: true }),
            field("ref", { required: true }),
            field("secret", { required: true, hiddenValueBehavior: "exclude-from-submission" }, { rules: { visibleWhen: eq("resident", "never") } }),
            field("staff_ref", { required: true }, { rules: { visibleWhen: staff } }),
            { id: "staff_box", type: "fieldset", configuration: {}, rules: { visibleWhen: staff }, children: { content: [field("nested_ref", { required: true })] } },
            field("opt_in", { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }),
            field("cost", {}, { type: "number" }),
            field("total", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "multiply", left: path("cost"), right: literal(2) } } }),
            field("code", { pattern: "[A-Z]{3}" })
          ]
        }
      },
      journey: { journeys: [journey] }
    };
    const FILLED = { resident: "no", ref: "R-1", opt_in: "O-1", staff_ref: "S-1", nested_ref: "N-1" };
    /** Answers and the errors every side gives for them along the journey. */
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ resident: "no" }, ["opt_in:required", "ref:required"]],
      [FILLED, []],
      [{ ...FILLED, secret: "x" }, []],
      // The host-bound ones keep the lenient fold on no page: not asked, whatever the host context says.
      [{ resident: "no", ref: "R-1", opt_in: "O-1" }, []],
      [{ ...FILLED, cost: 5 }, []],
      [{ ...FILLED, code: "abc" }, ["code:pattern"]],
      [{ ...FILLED, code: "ABC" }, []],
      [{ ...FILLED, extra: "stale" }, []],
      [{ ...FILLED, resident: "yes" }, ["extra:required"]]
    ];
    for (const [values, expected] of cases) {
      const label = JSON.stringify(values);
      for (const withJourney of [true, false]) {
        const payload = abi.serializeContext(
          { formId: "short", values, locale: "en", form: definition.root, logLevel: "debug", externalData: { role: "staff" }, ...(withJourney ? { journey } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        const text = await quickJs.run(payload);
        expect(text, `${withJourney ? "journey" : "form"}: ${label}`).toBe(inProcess.run(payload));
        if (withJourney) {
          expect(codes(abi.deserializeOutcome(text).errors), label).toEqual(expected);
        }
      }
    }
    // What both say: the self-hidden answer excluded, the skipped page's withheld, the
    // host-bound ones kept unasked, the calculation worked out, the code kept.
    const everything = abi.deserializeOutcome(
      await quickJs.run(
        abi.serializeContext(
          { formId: "short", values: { ...FILLED, secret: "x", cost: 5, code: "ABC", extra: "stale" }, locale: "en", form: definition.root, journey, externalData: { role: "staff" } },
          WasmValidationHost.STRICT_POLICY
        )
      )
    );
    expect(everything.errors).toEqual([]);
    expect(everything.values).toEqual({ ...FILLED, cost: 5, total: 10, code: "ABC" });
    // The whole form asks for the skipped field too. It does not ask for the host-bound ones,
    // whose rule a server leaves unevaluated: such a
    // visibility is read as hidden for requiredness, so the whole form is as lax as the journey there.
    const whole = abi.deserializeOutcome(
      await quickJs.run(abi.serializeContext({ formId: "short", values: { resident: "no", ref: "R-1", opt_in: "O-1" }, locale: "en", form: definition.root, externalData: { role: "staff" } }, WasmValidationHost.STRICT_POLICY))
    );
    expect(codes(whole.errors)).toEqual(["extra:required"]);

    // The browser with QuickJS as its sandbox reaches the same verdicts as the client pipeline alone.
    const runtimeOf = async (sandboxed: boolean, hostContext?: Record<string, unknown>) => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const host = sandboxed ? await WasmValidationHost.create([], { adapter: new QuickJsWasmHostAdapter() }) : undefined;
      const runtime = new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        ...(host ? { wasmValidationHost: host } : {}),
        ...(hostContext ? { hostContext } : {})
      });
      return { runtime, dispose: () => host?.dispose() };
    };
    for (const sandboxed of [true, false]) {
      const label = sandboxed ? "QuickJS sandbox" : "client alone";
      const { runtime, dispose } = await runtimeOf(sandboxed);
      runtime.setValue("resident", "no");
      const blocked = await runtime.submit("submit", envelope);
      expect({ accepted: blocked.accepted, errors: codes(blocked.errors) }, label).toEqual({
        accepted: false,
        errors: ["opt_in:required", "ref:required"]
      });
      for (const [key, value] of Object.entries(FILLED)) {
        runtime.setValue(key, value);
      }
      runtime.setValue("code", "abc");
      expect(codes((await runtime.submit("submit", envelope)).errors), label).toEqual(["code:pattern"]);
      runtime.setValue("code", "ABC");
      const accepted = await runtime.submit("submit", envelope);
      expect(accepted.accepted, label).toBe(true);
      // The calculation on no page has no answer (`cost` is unanswered), so no key rides along.
      expect(accepted.canonicalSubmission!.submission.values, label).toStrictEqual({ ...FILLED, code: "ABC" });
      dispose();
    }
    // A host-bound field on no page: the browser told it is staff (which would show and require
    // it on the whole form) and QuickJS over its envelope agree — neither asks, since the fold
    // keeps the lenient reading for it on both sides.
    const { runtime: hosted, dispose } = await runtimeOf(true, { role: "staff" });
    hosted.setValue("resident", "no");
    hosted.setValue("ref", "R-1");
    hosted.setValue("opt_in", "O-1");
    expect(hosted.effectiveState("staff_ref")).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
    expect(hosted.effectiveState("nested_ref")).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
    const unasked = await hosted.submit("submit", envelope);
    expect({ accepted: unasked.accepted, errors: codes(unasked.errors) }).toEqual({ accepted: true, errors: [] });
    expect(unasked.canonicalSubmission!.submission.values).toStrictEqual({ resident: "no", ref: "R-1", opt_in: "O-1" });
    hosted.setValue("staff_ref", "S-1");
    hosted.setValue("nested_ref", "N-1");
    const sent = await hosted.submit("submit", envelope);
    expect({ accepted: sent.accepted, errors: codes(sent.errors) }).toEqual({ accepted: true, errors: [] });
    const values = sent.canonicalSubmission!.submission.values;
    expect(values).toStrictEqual({ ...FILLED });
    for (const answers of [values, unasked.canonicalSubmission!.submission.values]) {
      const server = abi.deserializeOutcome(
        await quickJs.run(abi.serializeContext({ formId: "short", values: answers, locale: "en", form: definition.root, journey, externalData: { role: "staff" } }, WasmValidationHost.STRICT_POLICY))
      );
      expect(server.errors).toEqual([]);
      expect(server.values).toEqual(answers);
    }
    dispose();
    quickJs.dispose?.();
  });

  it("reads no Required-when rule reading host. on a field a journey places on no page, identically: QuickJS and the in-process kernel byte for byte, and the browser told it is staff with QuickJS as its sandbox", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const staff: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "host.role" }, right: { kind: "literal", value: "staff" } };
    const envelope = { form: { id: "short", version: "1" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } };
    const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>) => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
    // `ruled` is on no page, `listed` on the one page; both are required when the host says staff.
    const journey: Journey = { id: "short", pages: [{ id: "start", components: ["resident", "listed"] }] };
    const definition: FormDefinition = {
      id: "short",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] } },
            { id: "ruled", type: "text", configuration: {}, rules: { requiredWhen: staff } },
            { id: "listed", type: "text", configuration: {}, rules: { requiredWhen: staff } }
          ]
        }
      },
      journey: { journeys: [journey] }
    };
    // The server never reads a rule reading host., whatever `externalData` says: both engines, byte for byte.
    for (const values of [{ resident: "no" }, { resident: "no", listed: "L-1" }, { resident: "no", ruled: "R-1", listed: "L-1" }]) {
      for (const externalData of [undefined, { role: "staff" }]) {
        const payload = abi.serializeContext(
          { formId: "short", values, locale: "en", form: definition.root, journey, logLevel: "debug", ...(externalData ? { externalData } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        const text = await quickJs.run(payload);
        expect(text, JSON.stringify(values)).toBe(inProcess.run(payload));
        const outcome = abi.deserializeOutcome(text);
        expect(outcome.errors, JSON.stringify(values)).toEqual([]);
        expect(outcome.values, JSON.stringify(values)).toEqual(values);
      }
    }
    // The browser, told it is staff, reads the rule on the page and not on the field no page
    // shows — so it never refuses what the server over its envelope accepts for a field nobody
    // can fill.
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const host = await WasmValidationHost.create([], { adapter: new QuickJsWasmHostAdapter() });
    const runtime = new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      wasmValidationHost: host,
      hostContext: { role: "staff" }
    });
    runtime.setValue("resident", "no");
    expect(runtime.isRequired("ruled")).toBe(false);
    expect(runtime.isRequired("listed")).toBe(true);
    const refused = await runtime.submit("submit", envelope);
    expect({ accepted: refused.accepted, errors: codes(refused.errors) }).toEqual({ accepted: false, errors: ["listed:required"] });
    runtime.setValue("listed", "L-1");
    const accepted = await runtime.submit("submit", envelope);
    expect({ accepted: accepted.accepted, errors: codes(accepted.errors) }).toEqual({ accepted: true, errors: [] });
    expect(accepted.canonicalSubmission!.submission.values).toStrictEqual({ resident: "no", listed: "L-1" });
    host.dispose();
    quickJs.dispose?.();
  });

  it("passes the three-way parity harness with the QuickJS sandbox as the wasm runtime", async () => {
    const browser = createBrowserAdapter(new ValidationPipeline([coreValidationStage]));
    const quickJsHost = await WasmValidationHost.create([toSourcePlugin(corePlugin)], {
      adapter: new QuickJsWasmHostAdapter()
    });
    const wasm = createWasmAdapter(quickJsHost, coreValidationRoot);
    const server = createServerAdapter(
      new ServerValidationRunner([
        {
          id: "core",
          version: "1.0.0",
          validate: async (ctx) => coreDeterministicValidator(ctx.validationContext)
        }
      ])
    );

    const report = await runParity(coreValidationVectors, [browser, wasm, server]);
    expect(report.mismatches).toEqual([]);
    expect(report.matched).toBe(report.checked);
    quickJsHost.dispose();
  });
});

/**
 * Presentations: the engine's shared fixture
 * (`engine/tests/fixtures/presentation-form.ts`) — a journey that asks the form through an
 * alias and a worked-out value, and a one-page variant holding references in an own layout —
 * judged in QuickJS and in-process, byte for byte.
 */
describe("QuickJS vs in-process kernel parity: presentations", () => {
  // The ceiling is the field's own declared `max` (`number.max`), so the plugin carries no validator.
  const plugin: WasmPlugin = { id: "income-ceiling", version: "1.0.0", validators: [] };
  const form = presentationRoot();
  const apply = applyJourney();
  const variant = publicVariant();
  const eq = (path: string, value: string): Expression => ({ kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } });
  /** Every usability rule broken once (A–G), beside nodes in use: ignored alike on both engines. */
  const broken: Journey = {
    id: "apply",
    pages: [
      {
        id: "details",
        components: [
          { id: "email", type: "text", configuration: { fills: "name" } },
          { id: "upload", type: "file" },
          { id: "keyed", type: "text", configuration: { dataKey: "k" } },
          { id: "box", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "ghost" } }, { type: "journey-field", configuration: { componentId: "name" } }] } },
          { id: "to_section", type: "number", configuration: { fills: "money" } },
          { id: "note", type: "html", configuration: { fills: "name" } },
          { id: "work_email", type: "text", configuration: { fills: "email" } },
          { id: "first_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "m1" } } },
          { id: "second_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "m1" } } }
        ],
        routes: [{ when: { kind: "unary", operator: "not", operand: eq("name", "more") }, to: "$end" }]
      },
      { id: "assist", components: ["approved_amount"] }
    ]
  };
  /** Shapes neither side may run: `journey.invalid` from both. */
  const malformed: unknown[] = [
    { id: "apply", pages: [{ id: "details", components: [{ id: "own" }] }] },
    { id: "apply", pages: [{ id: "details", components: [{ type: "journey-field", configuration: {} }] }] },
    { id: "apply", pages: [{ id: "details", components: [{ id: "w", type: "journey-value", configuration: { to: "annual_income" } }] }] },
    { id: "apply", pages: [{ id: "details", components: [{ id: "box", type: "fieldset", children: { content: ["email"] } }] }] }
  ];
  const answers: Array<Record<string, unknown>> = [
    {},
    APPLY_BELOW,
    APPLY_ABOVE,
    { email: "ada@example.org" },
    { email: "ada@example.org", name: "Ada" },
    { email: "ada@example.org", name: "more", annual_income: 5, approved_amount: 9 },
    { ...APPLY_BELOW, approved_amount: 500 },
    { email: "ada@example.org", annual_income: 1000001 },
    // What a browser stores and never sends: own answers, and keys spelled like own ids.
    { ...APPLY_BELOW, "@apply.m1": 12000, "@apply.m2": 12000, "@apply.m3": 12000, m1: 1, work_email: "x", income_total: 2 }
  ];

  it("runs at ABI 1.0.0, with the presentation, formula and data grid functions in the program", () => {
    expect(WASM_ABI_VERSION).toBe("1.0.0");
    expect(new QuickJsWasmHostAdapter().abiVersion).toBe("1.0.0");
    const program = buildSandboxProgram();
    for (const name of [
      "journeyOwnNodeRule",
      "journeyOwnNodeUsable",
      "journeyFormKeys",
      "journeyTargetUsable",
      "journeyHoldsOwnAnswer",
      // The data grid normalizer and its row bounds.
      "kernelNormalizeDataGrids",
      "kernelDataGridRowBounds",
      "kernelIsPresentationNode",
      "kernelClientDerived",
      "kernelPageComponentIds",
      // the parser, the compiler, the policy, the evaluator's dispatch and the groups.
      "kernelParseFormula",
      "kernelCompileDefinition",
      "kernelFormulaPolicy",
      "kernelExprCall",
      "kernelExprReadsClock",
      "kernelTextCall",
      "kernelNumberCall",
      "kernelListCall",
      "kernelDateCall"
    ]) {
      expect(program.split(`function ${name}(`).length - 1, name).toBe(1);
    }
  });

  it("judges the fixture byte for byte in strip, keep and reject: placement, the path, clientDerived and a page's components", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    let compared = 0;
    for (const journey of [apply, variant, broken, undefined]) {
      for (const values of answers) {
        for (const unknownFields of ["strip", "keep", "reject"] as const) {
          for (const page of [undefined, "details", "income", "assist", "all", "nowhere"]) {
            const payload = abi.serializeContext(
              { formId: "presentation", values, locale: "en", form, unknownFields, logLevel: "debug", ...(journey ? { journey } : {}), ...(page !== undefined ? { page } : {}) },
              WasmValidationHost.STRICT_POLICY
            );
            expect(await quickJs.run(payload), `${journey?.id ?? "form"}, ${unknownFields}, ${page ?? "no page"}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(4 * answers.length * 3 * 6);
    quickJs.dispose?.();
  }, 30_000);

  it("keeps an unknown key unread in `keep`: a forged key steers no calculation, in QuickJS as in-process", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    const read = (source: string): Expression => ({ kind: "path", path: source });
    const unlessFifty = (total: string): Expression => ({ kind: "unary", operator: "not", operand: { kind: "binary", operator: "gte", left: read(total), right: { kind: "literal", value: 50 } } }) as unknown as Expression;
    const calculated = (source: string, total: string, proof: string) => [
      { id: total, type: "number", configuration: {}, rules: { value: read(source) } },
      { id: proof, type: "text", configuration: { required: true }, rules: { visibleWhen: unlessFifty(total) } }
    ];
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "email", type: "text", configuration: {} },
          ...calculated("@apply.m1", "total_at", "proof_at"),
          ...calculated("m1", "total_id", "proof_id"),
          { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "inside", type: "text", configuration: {} }] } },
          ...calculated("box", "total_box", "proof_box")
        ]
      }
    } as typeof form;
    const journey: Journey = { id: "apply", pages: [{ id: "p1", components: ["email", "total_at", "proof_at", "total_id", "proof_id", "box", "total_box", "proof_box", { id: "m1", type: "number" }] }] };
    const forged = { email: "a@b.co", "@apply.m1": 99, m1: 99, box: 99 };
    const answered = { ...forged, proof_at: "a", proof_id: "b", proof_box: "c" };
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      for (const values of [{ email: "a@b.co" }, forged, answered]) {
        const payload = abi.serializeContext({ formId: "keep", values, locale: "en", form: root, unknownFields, logLevel: "debug", journey }, WasmValidationHost.STRICT_POLICY);
        const inQuickJs = await quickJs.run(payload);
        expect(inQuickJs, `${unknownFields}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
        const outcome = abi.deserializeOutcome(inQuickJs as string);
        if (values !== answered) {
          // Every proof asked: nothing worked out from a forged key.
          expect(outcome.errors.filter((error) => error.code === "required").map((error) => error.componentId).sort(), unknownFields).toEqual(["proof_at", "proof_box", "proof_id"]);
        }
      }
    }
    const kept = abi.deserializeOutcome(
      (await quickJs.run(abi.serializeContext({ formId: "keep", values: answered, locale: "en", form: root, unknownFields: "keep", journey }, WasmValidationHost.STRICT_POLICY))) as string
    );
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual(answered);
    quickJs.dispose?.();
  });

  it("ignores alike an own entry of a journey whose id is outside the grammar (rule H), or whose answer would live at a key the form defines (rule I)", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    // I: the form keeps a section's entries at `@apply.m1`, where the own field `m1` would live.
    const keyedForm = presentationRoot();
    keyedForm.children!.content!.push({ id: "sec", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@apply.m1" }, children: { content: [{ id: "row_f", type: "text", configuration: {} }] } });
    const withoutM1: Journey = { ...apply, pages: apply.pages.map((page) => (page.id === "income" ? { ...page, components: (page.components ?? []).filter((entry) => typeof entry === "string" || entry.id !== "m1") } : page)) };
    const spaced: Journey = { ...apply, id: "apply now" };
    const spacedIdsOnly: Journey = { ...spaced, pages: spaced.pages.map((page) => ({ ...page, components: (page.components ?? []).filter((entry) => typeof entry === "string") })) };
    const cases: Array<[string, typeof form, Journey, Journey]> = [
      ["H", form, spaced, spacedIdsOnly],
      ["I", keyedForm, apply, withoutM1]
    ];
    for (const [rule, root, journey, without] of cases) {
      for (const values of [...answers, { email: "a@b.co", annual_income: 60000, "@apply.m1": "note", "@apply_now.m1": 3 }]) {
        for (const unknownFields of ["strip", "keep", "reject"] as const) {
          for (const page of [undefined, "details", "income"]) {
            const context = (judged: Journey) =>
              abi.serializeContext({ formId: "presentation", values, locale: "en", form: root, unknownFields, logLevel: "debug", journey: judged, ...(page !== undefined ? { page } : {}) }, WasmValidationHost.STRICT_POLICY);
            const label = `${rule}, ${unknownFields}, ${page ?? "no page"}: ${JSON.stringify(values)}`;
            const inQuickJs = await quickJs.run(context(journey));
            expect(inQuickJs, label).toBe(inProcess.run(context(journey)));
            // As if the entry were not there.
            expect(inQuickJs, label).toBe(inProcess.run(context(without)));
          }
        }
      }
    }
    quickJs.dispose?.();
  });

  it("says what the in-process kernel says: the alias's field asked, the worked-out field held to the form's rules and listed, own keys unknown", async () => {
    const abi = new JsonWasmAbi();
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    const judge = async (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      abi.deserializeOutcome(await quickJs.run(abi.serializeContext({ formId: "presentation", values, locale: "en", form, journey: apply, ...extra }, WasmValidationHost.STRICT_POLICY)));
    const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined; parameters?: Record<string, unknown> | undefined }>) =>
      errors.map((error) => `${error.componentId ?? error.parameters?.field ?? "-"}:${error.code}`).sort();

    expect(codes((await judge({})).errors)).toEqual(["annual_income:required", "email:required"]);
    const indexOf = (values: Record<string, unknown>) =>
      Object.keys(values)
        .sort()
        .map((key) => ({ path: key, delta: "", value: values[key] }));
    expect(await judge(APPLY_BELOW, { page: "income" })).toEqual({
      errors: [],
      values: APPLY_BELOW,
      index: indexOf(APPLY_BELOW),
      clientDerived: ["annual_income"],
      pageComponentIds: ["annual_income"]
    });
    expect(await judge(APPLY_ABOVE, { page: "details" })).toEqual({
      errors: [],
      values: APPLY_ABOVE,
      index: indexOf(APPLY_ABOVE),
      clientDerived: ["annual_income"],
      pageComponentIds: ["email"]
    });
    // Below the threshold `assist` is off the path: its answer is withheld.
    expect((await judge({ ...APPLY_BELOW, approved_amount: 500 })).values).toEqual(APPLY_BELOW);
    // The form's own ceiling refuses the figure the browser worked out, on the form field.
    const over = await judge({ email: "ada@example.org", annual_income: 1000001 });
    expect(codes(over.errors)).toEqual(["annual_income:number.max"]);
    expect(over.clientDerived).toEqual(["annual_income"]);
    // No special case for the keys own answers live under: unknown fields, like any other.
    const forged = { ...APPLY_BELOW, "@apply.m1": 12000 };
    expect((await judge(forged)).values).toEqual(APPLY_BELOW);
    expect((await judge(forged, { unknownFields: "keep" })).values).toEqual(forged);
    expect(codes((await judge(forged, { unknownFields: "reject" })).errors)).toEqual(["@apply.m1:unknown_field"]);
    // The variant leaves out a field the form requires: form rules always hold.
    const through = await judge({ email: "ada@example.org", name: "Ada" }, { journey: variant, page: "all" });
    expect(codes(through.errors)).toEqual(["annual_income:required"]);
    expect(through.pageComponentIds).toEqual(["email", "name"]);
    // Every broken node ignored: what is left asks for the alias's field and the first worked-out value's.
    const ignored = await judge({}, { journey: broken, page: "details" });
    expect(codes(ignored.errors)).toEqual(["annual_income:required", "email:required"]);
    expect(ignored.pageComponentIds).toEqual(["email", "name", "annual_income"]);
    quickJs.dispose?.();
  });

  it("refuses the same malformed own nodes as the browser's shape check: journey.invalid on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    for (const candidate of malformed) {
      expect(validateJourneyShape(candidate).length, JSON.stringify(candidate)).toBeGreaterThan(0);
      expect(kernelIsJourney(candidate), JSON.stringify(candidate)).toBe(false);
      const payload = abi.serializeContext({ formId: "presentation", values: APPLY_BELOW, locale: "en", form, journey: candidate as Journey, logLevel: "debug" }, WasmValidationHost.STRICT_POLICY);
      const text = await quickJs.run(payload);
      expect(text, JSON.stringify(candidate)).toBe(inProcess.run(payload));
      expect(abi.deserializeOutcome(text).errors[0], JSON.stringify(candidate)).toEqual({ code: "journey.invalid", stage: "journey", source: "wasm" });
    }
    // Own layouts nested as deep as a definition may go (32 levels, the component-depth limit): the
    // shape check and the placement walk with stacks of their own. Deeper is refused before any
    // walk.
    const layers = (count: number): Record<string, unknown> => {
      let deep: Record<string, unknown> = { id: "bottom", type: "text", configuration: { fills: "email" } };
      for (let depth = 0; depth < count; depth += 1) {
        deep = { id: `layer_${depth}`, type: "fieldset", children: { content: [deep] } };
      }
      return deep;
    };
    const nest = (count: number) =>
      abi.serializeContext(
        { formId: "presentation", values: { annual_income: 5 }, locale: "en", form, journey: { id: "deep", pages: [{ id: "p", components: [layers(count), "annual_income"] }] } as unknown as Journey, page: "p" },
        WasmValidationHost.STRICT_POLICY
      );
    const nested = nest(31);
    const fromQuickJs = await quickJs.run(nested);
    expect(fromQuickJs).toBe(inProcess.run(nested));
    const outcome = abi.deserializeOutcome(fromQuickJs);
    // The alias at the bottom of the thirty-one layouts places its field on the page.
    expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["email:required"]);
    expect(outcome.pageComponentIds).toEqual(["email", "annual_income"]);
    const tooDeep = nest(100);
    const refused = await quickJs.run(tooDeep);
    expect(refused).toBe(inProcess.run(tooDeep));
    expect(abi.deserializeOutcome(refused).errors.map((error) => error.code)).toEqual(["definition.tooDeep"]);
    quickJs.dispose?.();
  });

  it("no longer knows a key spelled like a node that holds no data, and no longer submits an excluded grid's rows, identically", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const tree: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "kind", type: "select", configuration: { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] } },
          { id: "go", type: "button", configuration: {} },
          { id: "banner", type: "html", configuration: {}, rules: { value: { kind: "literal", value: "worked out" } } },
          { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "inside", type: "text", configuration: {} }] } },
          {
            id: "orders_grid",
            type: "dataGrid",
            configuration: { hiddenValueBehavior: "exclude-from-submission" },
            collection: { collectionPath: "orders" },
            children: { content: [{ id: "qty", type: "number", configuration: {} }] },
            rules: { visibleWhen: eq("kind", "full") }
          }
        ]
      }
    };
    const cases: Array<Record<string, unknown>> = [
      { kind: "short", go: "clicked", banner: "sent", box: 1, inside: "kept", "orders[0].qty": 3, orders: [{ qty: 3 }] },
      { kind: "full", "orders[0].qty": 3 },
      { kind: "short", "orders[0].qty": 3 }
    ];
    for (const values of cases) {
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        const payload = abi.serializeContext({ formId: "f", values, locale: "en", form: tree, unknownFields, logLevel: "debug" }, WasmValidationHost.STRICT_POLICY);
        expect(await quickJs.run(payload), `${unknownFields}: ${JSON.stringify(values)}`).toBe(inProcess.run(payload));
      }
    }
    const run = async (values: Record<string, unknown>, unknownFields: "strip" | "keep" | "reject") =>
      abi.deserializeOutcome(await quickJs.run(abi.serializeContext({ formId: "f", values, locale: "en", form: tree, unknownFields }, WasmValidationHost.STRICT_POLICY)));
    expect((await run(cases[0]!, "strip")).values).toEqual({ kind: "short", inside: "kept" });
    expect((await run(cases[0]!, "keep")).values).toEqual({ kind: "short", go: "clicked", banner: "sent", box: 1, inside: "kept" });
    expect((await run(cases[0]!, "reject")).errors.map((error) => error.parameters?.field)).toEqual(["banner", "box", "go"]);
    expect((await run(cases[1]!, "strip")).values).toEqual({ kind: "full", "orders[0].qty": 3 });
    expect((await run(cases[2]!, "reject")).values).toEqual({ kind: "short" });
    quickJs.dispose?.();
  });
});

/**
 * The browser's side of the presentation cases with QuickJS as its sandbox: a
 * `FormRuntime` that holds own answers, fills form fields through aliases and works values out,
 * submits through the QuickJS program; then the program, and the in-process kernel byte for
 * byte, judge exactly what that browser would send. Every error on a form field, the verdict
 * and the values must agree; errors on the presentation's own nodes are the browser's alone.
 */
describe("the browser with QuickJS as its sandbox: presentations", () => {
  // The ceiling is the field's own declared `max` (`number.max`), so the plugin carries no validator.
  const plugin: WasmPlugin = { id: "income-ceiling", version: "1.0.0", validators: [] };
  const envelope = {
    form: { id: "presentation", version: "1.0.0" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
  };
  const eq = (path: string, value: string): Expression => ({ kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } });
  type Steps = (runtime: FormRuntime) => void;
  const all = (...steps: Steps[]): Steps => (runtime) => steps.forEach((step) => step(runtime));
  const set = (path: string, value: unknown): Steps => (runtime) => runtime.setValue(path, value);
  const fill = (aliasId: string, value: unknown): Steps => (runtime) => runtime.setValue(runtime.presentationValuePathOf(aliasId) as string, value);
  const months = (each: number): Steps => all(set("@apply.m1", each), set("@apply.m2", each), set("@apply.m3", each));
  const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
  const definitionOf = (journey: Journey, root: ComponentNode = presentationRoot()): FormDefinition => ({
    id: "presentation",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root,
    journey: { journeys: [journey] }
  });
  const applyWith = (changes: Record<string, Record<string, unknown>>): Journey => {
    const journey = applyJourney();
    return { ...journey, pages: journey.pages.map((page) => ({ ...page, ...(changes[page.id] ?? {}) })) };
  };
  const rootWith = (change: (root: ComponentNode) => void): ComponentNode => {
    const root = presentationRoot();
    change(root);
    return root;
  };

  interface Side {
    accepted: boolean;
    errors: string[];
    own: string[];
    values: Record<string, unknown>;
    path: string[] | undefined;
    pageId: string | undefined;
    hosts: Record<string, string>;
    asked: unknown[];
    clientDerived: string[] | undefined;
  }

  async function judge(definition: FormDefinition, steps: Steps, unknownFields?: "strip" | "keep" | "reject"): Promise<Side> {
    const journey = definition.journey?.journeys?.[0] as Journey;
    const abi = new JsonWasmAbi();
    const hosts: WasmValidationHost[] = [];
    const make = async (): Promise<FormRuntime> => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const host = await WasmValidationHost.create([toSourcePlugin(plugin)], { adapter: new QuickJsWasmHostAdapter() });
      hosts.push(host);
      const runtime = new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        wasmValidationHost: host,
        ...(unknownFields !== undefined ? { wasmUnknownFields: unknownFields } : {})
      });
      steps(runtime);
      return runtime;
    };
    const runtime = await make();
    const asked: unknown[] = [];
    runtime.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => asked.push((event.data as { requestValues: unknown }).requestValues));
    const path = runtime.journeyView()?.path;
    const submitted = await runtime.submit("submit", envelope);
    const kinds = runtime.presentationIndex()?.kindOf;
    const isOwn = (error: { componentId?: string | undefined }): boolean => error.componentId !== undefined && kinds !== undefined && Object.hasOwn(kinds, error.componentId);
    const values =
      submitted.accepted && submitted.canonicalSubmission
        ? submitted.canonicalSubmission.submission.values
        : ((await (await make()).submit("send", envelope)).canonicalSubmission?.submission.values as Record<string, unknown>);
    const side: Side = {
      accepted: submitted.accepted,
      errors: codes(submitted.errors.filter((error) => !isOwn(error))),
      own: codes(submitted.errors.filter(isOwn)),
      values,
      path,
      pageId: runtime.journeyView()?.pageId,
      hosts: { ...(runtime.journeyView()?.hosts ?? {}) },
      asked,
      clientDerived: undefined
    };
    hosts.forEach((host) => host.dispose());

    // What the browser sends holds no own answer, and both engines judge it alike, byte for byte.
    expect(Object.keys(values).filter((key) => key.startsWith("@"))).toEqual([]);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    const inProcess = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const payload = abi.serializeContext(
      { formId: definition.id, values, locale: "en", form: definition.root, journey, logLevel: "debug", ...(unknownFields !== undefined ? { unknownFields } : {}) },
      WasmValidationHost.STRICT_POLICY
    );
    const raw = await quickJs.run(payload);
    expect(raw).toBe(inProcess.run(payload));
    quickJs.dispose?.();
    const outcome = abi.deserializeOutcome(raw as string);
    const blocked = outcome.errors.some((error) => (error.severity ?? "error") === "error");
    expect(codes(outcome.errors)).toEqual(side.errors);
    if (side.own.length === 0) {
      expect(!blocked && outcome.values !== undefined).toBe(side.accepted);
    } else {
      expect(side.accepted).toBe(false);
    }
    if (!blocked) {
      expect(outcome.values).toEqual(values);
    }
    if (path !== undefined) {
      // The server's path, from its own run log, is the one the browser was on.
      const walked = outcome.logs?.find((entry) => entry.message.startsWith(`journey ${journey.id}: `));
      expect(walked?.data).toMatchObject({ pages: path });
    }
    side.clientDerived = outcome.clientDerived;
    return side;
  }

  // These run the real kernel in QuickJS and the in-process kernel side by side, which takes
  // seconds when the machine is busy: the 30 s ceiling is set on them rather than left at 5 s.
  it("an alias, a worked-out value, a skipped page and a field in a section no page lists", async () => {
    const form = definitionOf(applyJourney());
    expect(await judge(form, months(12000))).toMatchObject({ accepted: false, errors: ["email:required"], own: ["work_email:required"], pageId: "details", hosts: { email: "work_email" }, asked: [] });
    expect(await judge(form, all(fill("work_email", "ada@example.org"), months(12000)))).toMatchObject({
      accepted: true,
      values: APPLY_BELOW,
      path: ["details", "income"],
      asked: [APPLY_BELOW],
      clientDerived: ["annual_income"]
    });
    const optional = definitionOf(applyJourney(), rootWith((root) => void ((root.children!.content![0] as ComponentNode).configuration = { label: "Email" })));
    expect(await judge(optional, months(12000))).toMatchObject({ accepted: false, errors: [], own: ["work_email:required"] });
    expect(await judge(form, all(fill("work_email", "ada@example.org"), months(20000), set("approved_amount", 500)))).toMatchObject({
      accepted: true,
      values: APPLY_ABOVE,
      path: ["details", "income", "assist"],
      clientDerived: ["annual_income"]
    });
    expect(await judge(form, all(fill("work_email", "a@b.co"), set("@apply.m1", 1000001)))).toMatchObject({
      accepted: false,
      errors: ["annual_income:number.max"],
      own: [],
      pageId: "income",
      hosts: { annual_income: "income_total" },
      // The browser's own stage refuses the ceiling now, so the sandbox is never asked.
      asked: [],
      clientDerived: ["annual_income"]
    });
    const conditional = definitionOf(applyWith({ details: { routes: [{ when: { kind: "unary", operator: "not", operand: eq("name", "ask") }, to: "assist" }] } }));
    expect(await judge(conditional, all(fill("work_email", "a@b.co"), set("name", "skip"), set("annual_income", 36000), months(12000)))).toMatchObject({
      accepted: true,
      values: { email: "a@b.co", name: "skip" },
      path: ["details", "assist"],
      clientDerived: undefined
    });
    expect(await judge(conditional, all(fill("work_email", "a@b.co"), set("name", "ask")))).toMatchObject({ accepted: false, errors: ["annual_income:required"], hosts: { annual_income: "income_total" } });
    expect(await judge(form, fill("work_email", "a@b.co"))).toMatchObject({ accepted: false, errors: ["annual_income:required"], own: [], pageId: "income" });
    expect(await judge(definitionOf(publicVariant()), all(set("email", "a@b.co"), set("name", "Ada")))).toMatchObject({ accepted: false, errors: ["annual_income:required"], path: ["all"], hosts: {} });
  }, 30_000);

  it("emptiness, own keys, ignored nodes, a calculation reading an own answer, and two aliases of one field", async () => {
    // no page is passed over: the alias's page stays on the path, showing nothing, while its target hides.
    const hiding = definitionOf(applyJourney(), rootWith((root) => void ((root.children!.content![0] as ComponentNode).rules = { visibleWhen: eq("name", "show") })));
    expect(await judge(hiding, all(set("name", "hide"), months(12000)))).toMatchObject({ accepted: true, path: ["details", "income"], values: { name: "hide", annual_income: 36000 } });
    expect(await judge(hiding, all(set("name", "show"), months(12000)))).toMatchObject({ accepted: false, errors: ["email:required"], own: ["work_email:required"], path: ["details", "income"] });

    // an honest browser passes reject as it passes strip and keep — no own key reaches the program.
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const sent = await judge(
        definitionOf(applyJourney()),
        all(fill("work_email", "ada@example.org"), months(12000), set("@public.note", "left by another presentation"), set("@apply.stray", 1)),
        unknownFields
      );
      expect(sent, unknownFields).toMatchObject({ accepted: true, errors: [], values: APPLY_BELOW, asked: [APPLY_BELOW] });
    }

    // every usability rule broken once, beside nodes in use: the browser runs what is left.
    const broken: Journey = {
      id: "apply",
      pages: [
        {
          id: "details",
          components: [
            { id: "email", type: "text", configuration: { fills: "name" } },
            { id: "upload", type: "file" },
            { id: "keyed", type: "text", configuration: { dataKey: "k" } },
            { id: "box", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "ghost" } }, { type: "journey-field", configuration: { componentId: "name" } }] } },
            { id: "to_section", type: "number", configuration: { fills: "money" } },
            { id: "note", type: "html", configuration: { fills: "name" } },
            { id: "work_email", type: "text", configuration: { fills: "email" } },
            { id: "first_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "to_section" } } },
            { id: "second_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "to_section" } } }
          ],
          routes: [{ when: { kind: "unary", operator: "not", operand: eq("name", "more") }, to: "$end" }]
        },
        { id: "assist", components: ["approved_amount"] }
      ]
    };
    expect(await judge(definitionOf(broken), () => undefined)).toMatchObject({ accepted: false, errors: ["annual_income:required", "email:required"], own: [], path: ["details"], hosts: { email: "work_email", annual_income: "first_total" } });
    const ran = await judge(definitionOf(broken), all(fill("work_email", "a@b.co"), set("@apply.to_section", 7), set("name", "more"), set("approved_amount", 9), set("@apply.keyed", "x")));
    expect(ran).toMatchObject({ accepted: true, values: { email: "a@b.co", name: "more", annual_income: 7, approved_amount: 9 }, path: ["details", "assist"], clientDerived: ["annual_income"] });

    // a form calculation reading an own answer reads nothing on either side.
    const reading = rootWith((root) => void root.children!.content!.push({ id: "first_month", type: "number", configuration: {}, rules: { value: { kind: "call", name: "sum", args: [{ kind: "path", path: "@apply.m1" }] } } }));
    expect(await judge(definitionOf(applyJourney(), reading), all(fill("work_email", "ada@example.org"), months(12000)))).toMatchObject({
      accepted: true,
      values: { ...APPLY_BELOW, first_month: 0 },
      clientDerived: ["annual_income", "first_month"]
    });

    // two aliases on branches that exclude each other.
    const branches: Journey = {
      id: "branches",
      pages: [
        { id: "which", components: ["name", "annual_income"], routes: [{ when: eq("name", "home"), to: "home" }, { when: eq("name", "work"), to: "work" }, { to: "$end" }] },
        { id: "home", components: [{ id: "home_email", type: "text", configuration: { fills: "email" } }], routes: [{ to: "$end" }] },
        { id: "work", components: [{ id: "office_email", type: "text", configuration: { fills: "email" } }] }
      ]
    };
    expect(await judge(definitionOf(branches), all(set("name", "work"), set("annual_income", 1)))).toMatchObject({ accepted: false, errors: ["email:required"], pageId: "work", hosts: { email: "office_email" } });
    expect(await judge(definitionOf(branches), all(set("name", "home"), set("annual_income", 1), fill("home_email", "a@b.co")))).toMatchObject({ accepted: true, values: { name: "home", annual_income: 1, email: "a@b.co" }, path: ["which", "home"] });
    expect(await judge(definitionOf(branches), all(set("name", "other"), set("annual_income", 1), set("email", "left@example.org")))).toMatchObject({ accepted: true, values: { name: "other", annual_income: 1 }, path: ["which"] });
  }, 30_000);
});

describe("QuickJS vs in-process kernel parity: formulas", () => {
  const abi = new JsonWasmAbi();
  const todays = [FORMULA_TODAY, FORMULA_NEXT_YEAR, undefined] as const;
  type Outcome = ReturnType<JsonWasmAbi["deserializeOutcome"]>;
  type Extra = { journey?: Journey; page?: string; unknownFields?: "strip" | "keep" | "reject"; formulaErrors?: FormulaErrorPolicy };

  /** Both engines over the same plugin: function-backed in-process, its derived source in QuickJS. */
  async function engines() {
    const plugin = formulaPlugin();
    const inProcess = new InProcessWasmHostAdapter().instantiate([plugin], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin)], abi);
    return { inProcess, quickJs };
  }

  function payload(form: ComponentNode, values: Record<string, unknown>, today: string | undefined, extra: Extra = {}): string {
    return abi.serializeContext(
      { formId: "formulas", values, locale: "en", form, logLevel: "debug", ...(today !== undefined ? { today } : {}), ...extra },
      WasmValidationHost.STRICT_POLICY
    );
  }

  /** The pages a run walked, from the fold's own log line. */
  function pathOf(outcome: Outcome, journey: Journey): string[] | undefined {
    const walked = outcome.logs?.find((entry) => entry.message.startsWith(`journey ${journey.id}: `));
    return (walked?.data as { pages?: string[] } | undefined)?.pages;
  }

  it("judges the formula fixture byte for byte for every today, journey, page and unknown-fields mode, and leaves the definition as written", async () => {
    const { inProcess, quickJs } = await engines();
    const form = formulaRoot();
    const journey = formulaJourney();
    const before = JSON.stringify({ form, journey });
    const sets = formulaAnswerSets();
    let compared = 0;
    for (const withJourney of [true, false]) {
      for (const { label, values } of sets) {
        for (const today of todays) {
          for (const unknownFields of ["strip", "keep", "reject"] as const) {
            for (const page of [undefined, "start", "next_year", "rest"]) {
              const extra: Extra = { unknownFields };
              if (withJourney) {
                extra.journey = journey;
              }
              if (page !== undefined) {
                extra.page = page;
              }
              const crossing = payload(form, values, today, extra);
              const theirs = await quickJs.run(crossing);
              expect(theirs, `${withJourney ? "journey" : "form"}, today ${today ?? "absent"}, ${unknownFields}, ${page ?? "no page"}: ${label}`).toBe(inProcess.run(crossing));
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(2 * sets.length * todays.length * 3 * 4);
    expect(JSON.stringify({ form, journey })).toBe(before);
    quickJs.dispose?.();
    // The sweep is a few thousand synchronous sandbox runs (about 25 s alone), so it names its own
    // budget as its neighbours do: Vitest 5 holds a test to the default 5 s by the clock even when
    // the body never yields, where Vitest 2's timer could not fire inside a synchronous loop.
  }, 120_000);

  it("reports clockDependent, serverRules, clientDerived and the recalculated values identically, and the day changes the verdict", async () => {
    const { inProcess, quickJs } = await engines();
    const form = formulaRoot();
    const journey = formulaJourney();
    async function judge(values: Record<string, unknown>, today: string | undefined, withJourney = true): Promise<Outcome> {
      const crossing = payload(form, values, today, withJourney ? { journey } : {});
      const theirs = await quickJs.run(crossing);
      expect(theirs, `today ${today ?? "absent"}: ${JSON.stringify(values)}`).toBe(inProcess.run(crossing));
      return abi.deserializeOutcome(theirs);
    }
    const codes = (outcome: Outcome): string[] => outcome.errors.map((error) => `${error.code}:${error.componentId ?? "-"}`);

    // The honest answers on the fixture's day.
    // With the journey, the page whose `when` reads the clock is named by its id beside the components.
    const honest = await judge(formulaHonestAnswers(), FORMULA_TODAY);
    expect(honest.clockDependent).toEqual([...FORMULA_CLOCK_DEPENDENT, "start"]);
    expect(honest.serverRules).toEqual([...FORMULA_SERVER_RULES]);
    expect(honest.clientDerived).toContain("local_note");
    const values = honest.values ?? {};
    expect(values).toMatchObject({
      // The cases pinned here: a flags object's selected keys, their count, the else-less if,
      // dateAdd's clamp to the end of the month, the clock's month, a date comparison, the
      // server-only calculation, the browser-only one kept as sent, empty over a string.
      picked_count: 2,
      picked_first: "a",
      picked_all: false,
      tag_count: 2,
      bonus: 150,
      tier: "gold",
      deadline: "2026-02-28",
      month_start: "2026-10-01",
      month_end: "2026-10-31",
      overdue: true,
      in_window: true,
      age_years: 17,
      size: "large",
      local_note: "COUNTESS",
      email_ok: true,
      fallback: "countess"
    });
    expect(codes(honest)).not.toContain("required:big_reason");

    // The secret required rule holds on the server: the reason is asked for above 1000.
    const unexplained = formulaHonestAnswers();
    delete unexplained.big_reason;
    const secret = await judge(unexplained, FORMULA_TODAY);
    expect(secret.errors.find((error) => error.componentId === "big_reason")).toMatchObject({ code: "required", source: "wasm" });
    expect(secret.serverRules).toEqual([...FORMULA_SERVER_RULES]);

    // Below the thresholds: no bonus at all (the if has no else), the small size, no reason asked.
    const small = formulaAnswerSets().find((set) => set.label === "small amount")?.values ?? {};
    const low = await judge(small, FORMULA_TODAY);
    expect(codes(low)).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(low.values ?? {}, "bonus")).toBe(false);
    expect(low.values).toMatchObject({ size: "small", tier: "bronze", fallback: "A" });
    expect(codes(low)).not.toContain("required:big_reason");

    // Stale browser answers for every calculation: worked out again, the server-only one
    // overwritten, the browser-only one taken as sent.
    const stale = await judge(formulaStaleAnswers(), FORMULA_TODAY);
    expect(codes(stale)).toEqual([]);
    const recomputed = (stale.logs?.find((entry) => entry.message === "calculations recomputed")?.data as { fields?: string[] } | undefined)?.fields ?? [];
    expect(recomputed).toContain("size");
    expect(recomputed).toContain("total");
    expect(recomputed).toContain("deadline");
    expect(recomputed).not.toContain("local_note");
    expect(stale.values).toMatchObject({ size: "large", deadline: "2026-02-28", local_note: "COUNTESS" });
    expect(stale.values?.total).not.toBe("stale total");

    // The journey's page on the clock: off the path on the fixture's day, on it next year;
    // the person is 17 then 18 while the answers never change.
    expect(pathOf(honest, journey)).toEqual(["start", "rest"]);
    const nextYear = await judge(formulaHonestAnswers(), FORMULA_NEXT_YEAR);
    expect(pathOf(nextYear, journey)).toEqual(["start", "next_year", "rest"]);
    expect(nextYear.values?.age_years).toBe(18);
    expect(nextYear.values?.month_start).toBe("2027-01-01");
    expect(nextYear.clockDependent).toEqual([...FORMULA_CLOCK_DEPENDENT, "start"]);
    // Still a minor next year: the route to the page holds, and its only field is hidden by the
    // age rule; the page is on the path all the same, showing nothing (no page is passed over).
    const minor = await judge({ ...formulaHonestAnswers(), dob: "2010-01-01" }, FORMULA_NEXT_YEAR);
    expect(pathOf(minor, journey)).toEqual(["start", "next_year", "rest"]);
    expect(minor.values?.age_years).toBe(17);

    // No day at all, with the journey: the page's condition reads the clock, so the run is refused
    // alike in both engines.
    const refused = await judge(formulaHonestAnswers(), undefined);
    expect(codes(refused)).toContain("journey.clockDependent:-");
    expect(refused.values).toBeUndefined();
    // No day at all, no journey: the clock-reading rules are left alone, the sent answers kept
    // (still held to the field's own checks, so a date stays a date) and listed as the browser's,
    // the clock-dependent components still named.
    const undated = await judge({ ...formulaHonestAnswers(), month_start: "2000-01-01", age_years: 99, overdue: false, size: "small" }, undefined, false);
    expect(codes(undated)).toEqual([]);
    expect(undated.clockDependent).toEqual([...FORMULA_CLOCK_DEPENDENT]);
    expect(undated.serverRules).toEqual([...FORMULA_SERVER_RULES]);
    expect(undated.values).toMatchObject({ month_start: "2000-01-01", age_years: 99, overdue: false, size: "large" });
    expect(undated.clientDerived).toEqual(expect.arrayContaining(["month_start", "age_years", "overdue", "local_note"]));
    quickJs.dispose?.();
  });

  it("fails alike under formulaErrors fail for a formula with a typo and judges nothing else; warns under warn, and reads a word that is neither as no word", async () => {
    const { inProcess, quickJs } = await engines();
    const typo = formulaRootWithTypo();
    async function judge(form: ComponentNode, policy: FormulaErrorPolicy | undefined, values: Record<string, unknown> = {}): Promise<Outcome> {
      const crossing = payload(form, values, FORMULA_TODAY, policy === undefined ? {} : { formulaErrors: policy });
      const theirs = await quickJs.run(crossing);
      expect(theirs, `policy ${policy ?? "the form's own"}`).toBe(inProcess.run(crossing));
      return abi.deserializeOutcome(theirs);
    }
    const warnings = (outcome: Outcome): string[] =>
      (outcome.logs ?? []).filter((entry) => entry.level === "warn" && entry.message.startsWith("formula invalid")).map((entry) => entry.message);

    // The form says fail: one error naming the site, and nothing else judged (email is required).
    const refused = await judge(typo, undefined);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatchObject({ code: "formula.invalid", stage: "definition", source: "wasm", parameters: { where: "rules:total:value" } });
    expect(refused.errors[0]?.componentId).toBeUndefined();
    expect(refused.errors.map((error) => error.code)).not.toContain("required");
    expect((refused.logs ?? []).some((entry) => entry.level === "error" && entry.message.includes("rules:total:value"))).toBe(true);
    expect(await judge(typo, "fail")).toEqual(refused);

    // The host says warn: the typo's rule reads as absent, a warn line names the site, the rest
    // judged (nothing answered: email is asked for; the honest answers: worked out and accepted).
    const warned = await judge(typo, "warn");
    expect(warned.errors.map((error) => error.code)).not.toContain("formula.invalid");
    expect(warned.errors.find((error) => error.componentId === "email")).toMatchObject({ code: "required" });
    expect(warnings(warned)).toHaveLength(1);
    expect(warnings(warned)[0]).toContain("rules:total:value");
    const warnedHonest = await judge(typo, "warn", formulaHonestAnswers());
    expect(warnedHonest.errors).toEqual([]);
    expect(warnedHonest.values?.deadline).toBe("2026-02-28");
    expect(Object.prototype.hasOwnProperty.call(warnedHonest.values ?? {}, "total")).toBe(false);

    // A word that is neither is no word: the default refuses.
    const unknownWord = await judge(typo, "ignore" as never);
    expect(unknownWord.errors.map((error) => error.code)).toContain("formula.invalid");

    // A clean form under fail: nothing to refuse, the total worked out.
    const clean = await judge(formulaRoot(), "fail", formulaHonestAnswers());
    expect(clean.errors).toEqual([]);
    expect(clean.values).toMatchObject({ deadline: "2026-02-28", total: 112.5 });

    // The typo itself, as the author wrote it, is what the problem is about.
    expect(typo.children?.content?.find((node) => node.id === "total")?.rules?.value).toBe(FORMULA_TYPO);
    quickJs.dispose?.();
  });
});

describe("QuickJS vs in-process kernel parity: a field pattern that does not compile", () => {
  const patternRoot = (pattern: string): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: {},
    children: { content: [{ id: "code", type: "text", configuration: { pattern, patternMessage: "bad shape" } }] }
  });

  async function runBoth(root: ComponentNode, values: Record<string, unknown>, formulaErrors?: FormulaErrorPolicy): Promise<{ inProcess: string; quickJs: string }> {
    const abi = new JsonWasmAbi();
    const inProcess = await new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      const serialized = abi.serializeContext(
        { formId: "c7", values, locale: "en", form: root, ...(formulaErrors !== undefined ? { formulaErrors } : {}) },
        WasmValidationHost.STRICT_POLICY
      );
      return { inProcess: await inProcess.run(serialized), quickJs: await quick.run(serialized) };
    } finally {
      quick.dispose?.();
      inProcess.dispose?.();
    }
  }

  it.each(["(", "[", "*", "\\d+\\-\\d+", "(?<n>a)(?<n>b)", "a{2,1}", "\\p{Nope}"])(
    "%s: both engines refuse to compile it, log the same warning, and judge alike under every policy",
    async (pattern) => {
      const root = patternRoot(pattern);
      // The default is fail: a non-empty answer fails the check closed.
      const byDefault = await runBoth(root, { code: "anything" });
      expect(byDefault.quickJs).toBe(byDefault.inProcess);
      expect((JSON.parse(byDefault.quickJs) as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toEqual(["pattern"]);
      const warn = await runBoth(root, { code: "anything" }, "warn");
      expect(warn.quickJs).toBe(warn.inProcess);
      expect(JSON.parse(warn.quickJs)).toMatchObject({
        errors: [],
        values: { code: "anything" },
        logs: [{ level: "warn", message: "pattern does not compile: code", data: { componentId: "code", pattern } }]
      });
      const fail = await runBoth(root, { code: "anything" }, "fail");
      expect(fail.quickJs).toBe(fail.inProcess);
      expect((JSON.parse(fail.quickJs) as { errors: Array<{ code: string; parameters?: Record<string, unknown> }> }).errors).toMatchObject([
        { code: "pattern", parameters: { pattern, invalid: true, message: "bad shape" } }
      ]);
      // A word that is neither is no word: the default fails the check closed.
      const unknownWord = await runBoth(root, { code: "anything" }, "ignore" as never);
      expect(unknownWord.quickJs).toBe(unknownWord.inProcess);
      expect((JSON.parse(unknownWord.quickJs) as { errors: unknown[] }).errors).toEqual((JSON.parse(fail.quickJs) as { errors: unknown[] }).errors);
    }
  );
});

/**
 * The gate gaps: a text that is not a string, the declared
 * bounds of a number and a date, a file's shape and count, the fields and calculations of a
 * repeating section entry by entry, and a choice whose source the snapshot lacks — each judged by
 * QuickJS and the in-process kernel byte for byte, then read for the verdict they must share.
 */
describe("QuickJS vs in-process kernel parity: the gate gaps", () => {
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "code", type: "text", configuration: { maxLength: 3, pattern: "[A-Z]+" } },
        { id: "note", type: "textarea", configuration: { required: true } },
        { id: "age", type: "number", configuration: { min: 18, max: 120 } },
        { id: "when", type: "date", configuration: { min: "2024-01-01", max: "2024-12-31" } },
        { id: "doc", type: "file", configuration: { accept: ".png", maxFileSizeMb: 1 } },
        { id: "photos", type: "file", configuration: { multiple: true, maxFiles: 2 } },
        { id: "city", type: "select", configuration: { data: { sourceId: "cities" } } },
        // Answers declared free: the snapshot is not consulted for it.
        { id: "town", type: "select", configuration: { data: { sourceId: "towns", answersFree: true } } },
        {
          id: "lines",
          type: "repeatingSection",
          configuration: {},
          collection: { itemFields: ["sku", "qty", "price", "total", "place"] },
          children: {
            content: [
              { id: "sku", type: "text", configuration: { required: true, maxLength: 4 } },
              { id: "qty", type: "number", configuration: { max: 50 } },
              { id: "price", type: "number", configuration: {} },
              { id: "total", type: "number", configuration: {}, rules: { value: "row.qty * row.price" } },
              { id: "place", type: "number", configuration: {}, rules: { value: "rowIndex()" } }
            ]
          }
        }
      ]
    }
  };
  const png = (name: string, size = 10) => ({ storage: "inline", name, type: "image/png", size });
  const base = { note: "n" };
  const vectors: Array<[string, Record<string, unknown>]> = [
    ["a clean submission", { ...base, code: "ABC", age: 30, when: "2024-06-01", doc: png("a.png"), city: "ott" }],
    ["a number, an object, a list, an empty list and a boolean for text", { note: { a: 1 }, code: 12 }],
    ["a list for text", { note: "n", code: ["ABC"] }],
    ["an empty list for a textarea", { note: [] }],
    ["bounds broken", { ...base, age: 17, when: "2023-12-31" }],
    ["bounds on the edge", { ...base, age: 120, when: "2024-12-31" }],
    ["bounds broken from the far side", { ...base, age: "1e999", when: "2025-01-01" }],
    ["junk for files", { ...base, doc: "a.exe", photos: [png("a.png"), 7] }],
    ["too many files", { ...base, doc: [png("a.png"), png("b.png")], photos: [png("a.png"), png("b.png"), png("c.png")] }],
    ["files within the limits", { ...base, doc: png("a.png"), photos: [png("a.png"), png("b.png")] }],
    ["entries, one broken", { ...base, "lines[0].sku": "A1", "lines[0].qty": 2, "lines[0].price": 3, "lines[1].sku": "TOOLONG", "lines[1].qty": 99 }],
    ["entries, a forged calculation", { ...base, "lines[0].sku": "A", "lines[0].qty": 2, "lines[0].price": 3, "lines[0].total": 999, "lines[2].sku": "B", "lines[2].qty": 1 }],
    ["entries, a field missing in one", { ...base, "lines[0].qty": 1, "lines[1].sku": "B" }],
    ["entries posted whole", { ...base, lines: [{ sku: "A", qty: 2, price: 5 }, { sku: "BBBBB" }] }],
    ["a source the snapshot lacks", { ...base, city: "Atlantis" }],
    ["a source the snapshot has, a forged value", { ...base, city: "Atlantis" }],
    ["a free source, any text", { ...base, town: "Nowhere" }],
    ["a free source, the wrong shape", { ...base, town: 7 }]
  ];
  const snapshots: Array<Record<string, unknown> | undefined> = [undefined, {}, { cities: [{ value: "ott" }] }, { cities: "ott" }];

  it("judges every vector byte for byte", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    let compared = 0;
    for (const [label, values] of vectors) {
      for (const optionSnapshot of snapshots) {
        const payload = abi.serializeContext(
          { formId: "gate", values, locale: "en", form, logLevel: "debug", ...(optionSnapshot !== undefined ? { optionSnapshot: optionSnapshot as never } : {}) },
          WasmValidationHost.STRICT_POLICY
        );
        expect(await quickJs.run(payload), `${label}, ${JSON.stringify(optionSnapshot)}`).toBe(inProcess.run(payload));
        compared += 1;
      }
    }
    expect(compared).toBe(vectors.length * snapshots.length);
    quickJs.dispose?.();
  });

  it("holds the verdicts the two engines share", async () => {
    const abi = new JsonWasmAbi();
    const quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const judge = async (values: Record<string, unknown>, optionSnapshot?: Record<string, unknown>) =>
      JSON.parse(
        (await quickJs.run(
          abi.serializeContext({ formId: "gate", values, locale: "en", form, ...(optionSnapshot !== undefined ? { optionSnapshot: optionSnapshot as never } : {}) }, WasmValidationHost.STRICT_POLICY)
        )) as string
      ) as { errors: Array<{ code: string; path?: string; componentId?: string }>; values?: Record<string, unknown>; clientDerived?: string[] };
    const where = (outcome: { errors: Array<{ code: string; path?: string }> }) => outcome.errors.map((error) => `${error.code}@${error.path}`);

    expect(where(await judge({ note: { a: 1 }, code: 12 }))).toEqual(["text@code", "text@note"]);
    expect(where(await judge({ note: [] }))).toEqual(["text@note"]);
    expect(where(await judge({ ...base, age: 17, when: "2025-01-01" }))).toEqual(["number.min@age", "date.max@when"]);
    expect(where(await judge({ ...base, age: 120, when: "2024-01-01" }))).toEqual([]);
    expect(where(await judge({ ...base, doc: "a.exe", photos: [png("a.png"), png("b.png"), png("c.png")] }))).toEqual(["file@doc", "fileCount@photos"]);
    expect(where(await judge({ ...base, "lines[0].sku": "A", "lines[1].sku": "TOOLONG", "lines[1].qty": 99 }))).toEqual([
      "maxLength@lines[1].sku",
      "number.max@lines[1].qty"
    ]);
    expect(where(await judge({ ...base, "lines[0].qty": 1, "lines[1].sku": "B" }))).toEqual(["required@lines[0].sku"]);
    const forged = await judge({ ...base, "lines[0].sku": "A", "lines[0].qty": 2, "lines[0].price": 3, "lines[0].total": 999 });
    expect(forged.errors).toEqual([]);
    expect(forged.values).toMatchObject({ "lines[0].total": 6, "lines[0].place": 1 });
    expect(where(await judge({ ...base, city: "Atlantis" }))).toEqual(["option.sourceUnavailable@city"]);
    expect(where(await judge({ ...base, city: "Atlantis" }, { cities: [{ value: "ott" }] }))).toEqual(["option.notAllowed@city"]);
    // A source whose answers are free: no snapshot, or a snapshot without the list, still takes any text; the shape is still held.
    expect(where(await judge({ ...base, town: "Nowhere" }))).toEqual([]);
    expect(where(await judge({ ...base, town: "Nowhere" }, { towns: [{ value: "x" }] }))).toEqual([]);
    expect(where(await judge({ ...base, town: 7 }))).toEqual(["option.notAllowed@town"]);
    quickJs.dispose?.();
  });
});

/**
 * Fail closed on the gate: a rule that throws, a plugin
 * validator that cannot answer, a severity nobody defined, a function the server lacks, an
 * omitted optional input and a visibility the server cannot replay — each judged by QuickJS and
 * the in-process kernel, byte for byte where there is a verdict, and by the same failure where
 * there is none.
 */
describe("QuickJS vs in-process kernel parity: fail closed on the gate", () => {
  const text = (id: string, configuration: Record<string, unknown> = {}, rules?: Record<string, unknown>): ComponentNode =>
    ({ id, type: "text", configuration, ...(rules !== undefined ? { rules } : {}) }) as ComponentNode;
  const rootOf = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const throwing: WasmPlugin = {
    id: "boomer",
    version: "1.0.0",
    validators: [],
    functions: {
      boom: () => {
        throw new Error("boom");
      }
    }
  };

  async function both(root: ComponentNode, values: Record<string, unknown>, context: Record<string, unknown> = {}, plugin?: WasmPlugin, source?: { id: string; version: string; source: string }) {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate(plugin !== undefined ? [plugin] : [], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate(source !== undefined ? [source] : plugin !== undefined ? [toSourcePlugin(plugin)] : [], abi);
    try {
      const payload = abi.serializeContext({ formId: "fc", values, locale: "en", form: root, logLevel: "debug", ...context }, WasmValidationHost.STRICT_POLICY);
      return { quickJs: await quick.run(payload), inProcess: inProcess.run(payload), payload, quick, local: inProcess };
    } finally {
      quick.dispose?.();
    }
  }
  const parsed = (serialized: string) => JSON.parse(serialized) as { errors: Array<{ code: string; componentId?: string; parameters?: Record<string, unknown> }>; values?: Record<string, unknown>; visibilitySkipped?: string[]; clientDerived?: string[]; logs?: Array<{ level: string; message: string }> };

  it("refuses a throwing rule under fail, warns under warn, identically", async () => {
    const root = rootOf(text("a"), text("b", { required: true }, { visibleWhen: "boom()" }));
    const failed = await both(root, { a: "x", b: "" }, { formulaErrors: "fail" }, throwing);
    expect(failed.quickJs).toBe(failed.inProcess);
    expect(parsed(failed.quickJs).errors).toEqual([
      { code: "formula.invalid", stage: "definition", source: "wasm", parameters: { where: "rules:b:visibleWhen", message: 'function "boom" threw: boom', function: "boom" } }
    ]);
    // Fail is the default; the warn opt-in is the explicit word.
    const byDefault = await both(root, { a: "x", b: "" }, {}, throwing);
    expect(byDefault.quickJs).toBe(byDefault.inProcess);
    expect(parsed(byDefault.quickJs).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const warned = await both(root, { a: "x", b: "" }, { formulaErrors: "warn" }, throwing);
    expect(warned.quickJs).toBe(warned.inProcess);
    expect(parsed(warned.quickJs).errors).toEqual([]);
    expect(parsed(warned.quickJs).logs?.some((entry) => entry.level === "warn" && entry.message === 'formula function threw: rules:b:visibleWhen: function "boom" threw: boom')).toBe(true);
  });

  it("writes one warn log line per condition.notBoolean warning, byte for byte alike, and refuses nothing", async () => {
    const root = rootOf(text("a"), text("b", {}, { visibleWhen: "len(a) + 1" }));
    for (const formulaErrors of ["fail", "warn"] as const) {
      const run = await both(root, { a: "x", b: "y" }, { formulaErrors });
      expect(run.quickJs).toBe(run.inProcess);
      expect(parsed(run.quickJs).errors).toEqual([]);
      const lines = (parsed(run.quickJs).logs ?? []).filter((entry) => entry.message.startsWith("formula warning: "));
      expect(lines.map((entry) => entry.level)).toEqual(["warn"]);
      expect(lines[0]?.message).toContain("rules:b:visibleWhen");
    }
  });

  it("refuses a server rule calling a function the server lacks, and keeps the policy for a browser-only one", async () => {
    const server = await both(rootOf(text("a"), text("b", {}, { requiredWhen: "regionOk(a)" })), { a: "bc" });
    expect(server.quickJs).toBe(server.inProcess);
    expect(parsed(server.quickJs).errors).toMatchObject([{ code: "formula.invalid", parameters: { where: "rules:b:requiredWhen", function: "regionOk" } }]);
    // Under warn too (the one problem warn still refuses).
    for (const formulaErrors of ["warn"]) {
      const warnedServer = await both(rootOf(text("a"), text("b", {}, { requiredWhen: "regionOk(a)" })), { a: "bc" }, { formulaErrors });
      expect(warnedServer.quickJs, formulaErrors).toBe(warnedServer.inProcess);
      expect(parsed(warnedServer.quickJs).errors, formulaErrors).toMatchObject([{ code: "formula.invalid", parameters: { function: "regionOk" } }]);
    }
    const browserOnlyRoot = rootOf(text("a"), text("b", {}, { requiredWhen: { formula: "regionOk(a)", run: "browser" } }));
    const browserFails = await both(browserOnlyRoot, { a: "bc" });
    expect(browserFails.quickJs).toBe(browserFails.inProcess);
    expect(parsed(browserFails.quickJs).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const browserOnly = await both(browserOnlyRoot, { a: "bc" }, { formulaErrors: "warn" });
    expect(browserOnly.quickJs).toBe(browserOnly.inProcess);
    expect(parsed(browserOnly.quickJs).errors).toEqual([]);
  });

  it("lists a calculation that does not parse in clientDerived, keeping the sent value", async () => {
    const root = rootOf(text("a"), { id: "b", type: "number", configuration: {}, rules: { value: 'a = "' } } as ComponentNode);
    const run = await both(root, { a: "x", b: 999 }, { formulaErrors: "warn" });
    expect(run.quickJs).toBe(run.inProcess);
    expect(parsed(run.quickJs).errors).toEqual([]);
    expect(parsed(run.quickJs).values).toEqual({ a: "x", b: 999 });
    expect(parsed(run.quickJs).clientDerived).toEqual(["b"]);
  });

  it("does not ask for a field whose visibility it cannot replay, and lists the skip", async () => {
    const root = rootOf(text("a"), text("b", { required: true }, { visibleWhen: 'host.role = "admin"' }), text("c", { required: true }, { visibleWhen: "year(today()) < 2000" }));
    for (const context of [{}, { today: "2026-10-08" }]) {
      const run = await both(root, { a: "x" }, context);
      expect(run.quickJs).toBe(run.inProcess);
    }
    const noDay = parsed((await both(root, { a: "x" })).quickJs);
    expect(noDay.errors).toEqual([]);
    expect(noDay.visibilitySkipped).toEqual(["b", "c"]);
    const withDay = parsed((await both(root, { a: "x" }, { today: "2026-10-08" })).quickJs);
    expect(withDay.errors).toEqual([]);
    expect(withDay.visibilitySkipped).toEqual(["b"]);
  });

  it("reports the fold's results when asked (reportFold), identically, and nothing when not asked", async () => {
    const hidden = (id: string, configuration: Record<string, unknown>): ComponentNode =>
      text(id, configuration, { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: "show" } } });
    const root = rootOf(
      text("a"),
      hidden("hid", { required: true, hiddenValueBehavior: "exclude-from-submission" }),
      hidden("wiped", { hiddenValueBehavior: "clear" }),
      text("must", { required: true })
    );
    const values = { a: "hide", hid: "s", wiped: "w", stray: 1, must: "" };
    const plain = await both(root, values);
    expect(plain.quickJs).toBe(plain.inProcess);
    expect(parsed(plain.quickJs)).not.toHaveProperty("withheld");
    for (const unknownFields of ["strip", "keep"]) {
      const asked = await both(root, values, { reportFold: true, unknownFields });
      expect(asked.quickJs, unknownFields).toBe(asked.inProcess);
      const outcome = parsed(asked.quickJs) as unknown as { withheld: string[]; effectiveState: Record<string, unknown>; submittable: Record<string, unknown> };
      expect(outcome.withheld, unknownFields).toEqual(["hid", "wiped"]);
      expect(Object.keys(outcome.effectiveState).sort()).toEqual(["hid", "wiped"]);
      expect(outcome.submittable).toBeDefined();
    }
    const accepted = parsed((await both(root, { a: "show", hid: "s", must: "x" }, { reportFold: true })).quickJs) as unknown as { withheld: string[]; submittable?: unknown };
    expect(accepted.withheld).toEqual([]);
    expect(accepted.submittable).toBeUndefined();
  });

  it("leaves a hidden answer out by default and returns it with retain, byte for byte on both engines", async () => {
    const hiddenWhen = { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: "show" } } } as const;
    const values = { a: "hide", secret: "s", other: "o" };
    // Nothing set: the default is exclude-from-submission, so the answer is not in the returned values.
    const plain = rootOf(text("a"), text("secret", {}, hiddenWhen), text("other"));
    const dropped = await both(plain, values);
    expect(dropped.quickJs).toBe(dropped.inProcess);
    expect(parsed(dropped.quickJs).values).toEqual({ a: "hide", other: "o" });
    // Retain: the same hidden answer is still sent.
    const kept = rootOf(text("a"), text("secret", { hiddenValueBehavior: "retain" }, hiddenWhen), text("other"));
    const sent = await both(kept, values);
    expect(sent.quickJs).toBe(sent.inProcess);
    expect(parsed(sent.quickJs).values).toEqual({ a: "hide", secret: "s", other: "o" });
  });

  it("works a calculation out over an omitted optional input, and trusts one that may have been withheld", async () => {
    const plain = rootOf({ id: "a", type: "number", configuration: {} } as ComponentNode, { id: "b", type: "number", configuration: {} } as ComponentNode, { id: "total", type: "number", configuration: {}, rules: { value: "a * b" } } as ComponentNode);
    const recomputed = await both(plain, { a: 10, total: 999 });
    expect(recomputed.quickJs).toBe(recomputed.inProcess);
    expect(parsed(recomputed.quickJs).values).toEqual({ a: 10 });
    expect(parsed(recomputed.quickJs).clientDerived).toBeUndefined();
    const withheld = rootOf(
      { id: "a", type: "number", configuration: {} } as ComponentNode,
      { id: "b", type: "number", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: "a > 5" } } as ComponentNode,
      { id: "total", type: "number", configuration: {}, rules: { value: "a * b" } } as ComponentNode
    );
    const trusted = await both(withheld, { a: 10, total: 999 });
    expect(trusted.quickJs).toBe(trusted.inProcess);
    expect(parsed(trusted.quickJs).clientDerived).toEqual(["total"]);
  });

  describe("plugin validators", () => {
    const root = rootOf(text("a"));
    const hosted = (validate: (context: never) => unknown): WasmPlugin => ({ id: "p", version: "1", validators: [{ id: "v", version: "1", validate: validate as never }] });
    const sourced = (body: string) => ({ id: "p", version: "1", source: `({ validators: [ function (context) { ${body} } ] })` });

    it.each([
      ["undefined", () => undefined, "return undefined;", "returned undefined"],
      ["null", () => null, "return null;", "returned null"],
      ["no errors list", () => ({}), "return {};", "returned no { errors } list"],
      ["a promise", () => Promise.resolve({ errors: [] }), "return Promise.resolve({ errors: [] });", "returned a promise"],
      ["a code-less entry", () => ({ errors: [{}] }), "return { errors: [{}] };", "without a string code"]
    ])("fails the run in both engines for a validator returning %s", async (_label, validate, body, message) => {
      const abi = new JsonWasmAbi();
      const inProcess = new InProcessWasmHostAdapter().instantiate([hosted(validate)], abi);
      const quick = await new QuickJsWasmHostAdapter().instantiate([sourced(body)], abi);
      try {
        const payload = abi.serializeContext({ formId: "fc", values: { a: "x" }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY);
        expect(() => inProcess.run(payload)).toThrow(message);
        await expect(Promise.resolve().then(() => quick.run(payload))).rejects.toThrow(message);
      } finally {
        quick.dispose?.();
      }
    });

    it("blocks a severity nobody defined in both engines, byte for byte", async () => {
      const run = await both(root, { a: "x" }, {}, hosted(() => ({ errors: [{ code: "x.bad", stage: "validation", source: "wasm", severity: "fatal" }] })), sourced("return { errors: [{ code: 'x.bad', stage: 'validation', source: 'wasm', severity: 'fatal' }] };"));
      expect(run.quickJs).toBe(run.inProcess);
      expect(parsed(run.quickJs).errors).toEqual([{ code: "x.bad", stage: "validation", source: "wasm", severity: "error" }]);
      expect(parsed(run.quickJs).values).toBeUndefined();
    });

    it("never lets a validator change what is stored", async () => {
      const mutate = "context.values.a = 'HACKED'; context.values.injected = 1; return { errors: [] };";
      const run = await both(
        root,
        { a: "x" },
        {},
        hosted(new Function("context", mutate) as never),
        sourced(mutate)
      );
      const outcome = parsed(run.quickJs);
      // Sloppy or strict, the answers the run stores are the fold's.
      expect(outcome.values === undefined ? outcome.errors.map((error) => error.code) : outcome.values).toEqual(outcome.values === undefined ? ["validator.failed"] : { a: "x" });
      expect(JSON.stringify(outcome)).not.toContain("HACKED");
      expect(parsed(await run.inProcess).values).toEqual({ a: "x" });
    });
  });
});

/**
 * Parser refusals: a number past the double range, an
 * interval written with three dots and a literal date unit that is not one. QuickJS and the
 * in-process kernel answer byte for byte, and under the default policy the rule refuses.
 */
describe("QuickJS vs in-process kernel parity: formula parse refusals", () => {
  const rootOf = (value: string): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "text", configuration: {} },
        { id: "b", type: "text", configuration: {}, rules: { value } }
      ]
    } as never
  });

  it.each([
    ["numberTooLarge", "if a = 1e999 then 1"],
    ["numberTooLarge", "-1e999"],
    ["intervalDots", "a in [1...2]"],
    ["badUnit", 'dateAdd(@"2026-01-31", 1, "day")'],
    ["badUnit", 'dateDiff(@"2026-01-31", @"2026-02-01", "Years")']
  ])("%s: %s refuses alike in both engines", async (code, formula) => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      const payload = abi.serializeContext({ formId: "e2", values: { a: "x" }, locale: "en", form: rootOf(formula) }, WasmValidationHost.STRICT_POLICY);
      const theirs = await quick.run(payload);
      expect(theirs).toBe(await inProcess.run(payload));
      const errors = (JSON.parse(theirs) as { errors: Array<{ code: string; parameters?: { where?: string; message?: string } }> }).errors;
      expect(errors.map((error) => error.code)).toEqual(["formula.invalid"]);
      expect(errors[0]?.parameters?.where).toBe("rules:b:value");
      expect(code.length).toBeGreaterThan(0);
    } finally {
      quick.dispose?.();
    }
  });
});

describe("QuickJS vs in-process kernel parity: the evaluator and the function library", () => {
  const field = (id: string, rules?: Record<string, unknown>): ComponentNode =>
    ({ id, type: "anyx", configuration: {}, ...(rules !== undefined ? { rules } : {}) }) as ComponentNode;
  const rootOf = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const parsed = (serialized: string) =>
    JSON.parse(serialized) as {
      errors: Array<{ code: string; parameters?: Record<string, unknown> }>;
      values?: Record<string, unknown>;
      logs?: Array<{ level: string; message: string }>;
    };
  const functionsPlugin: WasmPlugin = {
    id: "odd-results",
    version: "1.0.0",
    validators: [],
    functions: {
      nan: () => Number.NaN,
      later: () => Promise.resolve(1),
      fn: () => () => 1,
      inst: () => new (class Money {})(),
      plain: () => ({ cents: 5 })
    }
  };

  /** Every vector: the formula for `b`, the answers sent, and the value `b` comes to (absent: no answer). */
  const vectors: Array<[string, string, Record<string, unknown>, unknown]> = [
    // The chains the stack could not hold.
    ["20,000-term sum", Array.from({ length: 20000 }, () => "a").join(" + "), { a: 1 }, 20000],
    ["20,000-term and", Array.from({ length: 20000 }, () => "a = 1").join(" and "), { a: 1 }, true],
    ["20,000-term or", Array.from({ length: 20000 }, () => "a = 2").join(" or "), { a: 1 }, false],
    ["mixed chain", Array.from({ length: 6000 }, (_, i) => (i % 2 === 0 ? "a" : "- a")).join(" + ").replace(/\+ -/g, "-"), { a: 2 }, 0],
    // A list past what a spread can carry: lists are held to 10,000 items; 150,000 gives no answer.
    ["max of 10,000", "max(l)", { a: 1, l: Array.from({ length: 10000 }, (_, i) => i) }, 9999],
    ["max of 150,000", "max(l)", { a: 1, l: Array.from({ length: 150000 }, (_, i) => i) }, undefined],
    ["min of 10,000", "min(l)", { a: 1, l: Array.from({ length: 10000 }, (_, i) => 10000 - i) }, 1],
    // Dates and numbers.
    ["dateAdd huge weeks", 'dateAdd("2024-02-29", 1e308, "weeks")', { a: 1 }, undefined],
    ["roundTo tiny", "roundTo(0.0000001, 2)", { a: 1 }, 0],
    ["roundUp tiny", "roundUp(0.0000001, 2)", { a: 1 }, 0.01],
    ["dateDiff clamp", 'dateDiff("2024-01-31", "2024-02-29", "months")', { a: 1 }, 1],
    ["leap day birthday", 'dateDiff("2000-02-29", "2001-02-28", "years")', { a: 1 }, 1],
    ["age of a future date", 'age("2030-01-01")', { a: 1 }, undefined],
    ["negative zero", "round(-0.4) + 0 * -5", { a: 1 }, 0],
    ["modulo is truncated", "modulo(-7, 3)", { a: 1 }, -1],
    // Numeric text.
    ["hex text is not a number", '"0x10" * 1', { a: 1 }, undefined],
    ["binary text is not a number", "number(a)", { a: "0b11" }, undefined],
    ["exponent text is", '"1e3" * 1', { a: 1 }, 1000],
    // Text.
    ["matches unbalanced", 'matches("xyzb", "a)|(b")', { a: 1 }, undefined],
    ["upper of an empty answer", "upper(m)", { a: 1, m: null }, undefined],
    ["concat of a list", "concat(a, l)", { a: "x", l: [1] }, undefined],
    ["contains an empty needle", 'contains("undefined", m)', { a: 1, m: null }, undefined],
    ["substring by code point", "substring(a, 1, 1)", { a: "\u{1F600}a" }, "\u{1F600}"],
    ["len by code point", "len(a)", { a: "\u{1F600}" }, 1],
    ["indexOf by code point", 'indexOf(a, "a")', { a: "\u{1F600}a" }, 2],
    // Lists: 10,000 items is the cap; 50,000 gives no list, so count is 0.
    ["distinct", "count(distinct(l))", { a: 1, l: Array.from({ length: 10000 }, (_, i) => i % 7) }, 7],
    ["distinct past the cap", "count(distinct(l))", { a: 1, l: Array.from({ length: 50000 }, (_, i) => i % 7) }, 0],
    // Plugin results that are not data.
    ["plugin NaN", "nan()", { a: 1 }, undefined],
    ["plugin promise", "later()", { a: 1 }, undefined],
    ["plugin function", "fn()", { a: 1 }, undefined],
    ["plugin class instance", "inst()", { a: 1 }, undefined],
    ["plugin plain object", "plain()", { a: 1 }, { cents: 5 }]
  ];

  it("evaluates every vector byte for byte alike and to the value it should", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([functionsPlugin], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([toSourcePlugin(functionsPlugin)], abi);
    try {
      for (const [label, formula, values, expected] of vectors) {
        const root = rootOf(field("a"), field("l"), field("m"), field("b", { value: formula }));
        const sent = { ...values, b: "stale" };
        const payload = abi.serializeContext({ formId: "e1", values: sent, locale: "en", form: root, formulaErrors: "warn", logLevel: "warn", today: "2026-10-08" }, WasmValidationHost.STRICT_POLICY);
        const theirs = await quick.run(payload);
        expect(theirs, label).toBe(await inProcess.run(payload));
        const outcome = parsed(theirs);
        expect(outcome.errors.filter((error) => error.code === "formula.invalid"), label).toEqual([]);
        expect(outcome.values?.b, label).toEqual(expected);
      }
    } finally {
      quick.dispose?.();
    }
  }, 300_000);

  it("refuses calculations that never settle, naming them, alike on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      for (const [values, root] of [
        [{ a: 0 }, rootOf(field("a", { value: "a + 1" }))],
        [{ p: 0, q: 0 }, rootOf(field("p", { value: "q + 1" }), field("q", { value: "p + 1" }))]
      ] as const) {
        for (const formulaErrors of ["fail", "warn"] as const) {
          const payload = abi.serializeContext({ formId: "e1", values: { ...values }, locale: "en", form: root, formulaErrors }, WasmValidationHost.STRICT_POLICY);
          const theirs = await quick.run(payload);
          expect(theirs).toBe(await inProcess.run(payload));
          const errors = parsed(theirs).errors;
          expect(errors.map((error) => error.code)).toEqual(["formula.invalid"]);
          expect(String(errors[0]?.parameters?.message)).toMatch(/^the calculations do not settle: /);
        }
      }
    } finally {
      quick.dispose?.();
    }
  });

  // The kernel works calculations out sources first, as the browser does (post-order
  // over what each reads), and settles a calculation that returns a fresh list.
  it("settles a 400-link chain declared sources-last, and a fresh list, byte for byte alike", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([], abi);
    try {
      const links = Array.from({ length: 400 }, (_, i) => field(`k${i}`, { value: i === 399 ? "x + 1" : `k${i + 1} + 1` }));
      const root = rootOf(field("x"), field("t"), field("parts", { value: 'split(t, ",")' }), ...links);
      const payload = abi.serializeContext({ formId: "e1", values: { x: 1, t: "a,b" }, locale: "en", form: root, formulaErrors: "warn", logLevel: "warn" }, WasmValidationHost.STRICT_POLICY);
      const theirs = await quick.run(payload);
      expect(theirs).toBe(await inProcess.run(payload));
      const outcome = parsed(theirs);
      expect(outcome.errors.filter((error) => error.code === "formula.invalid")).toEqual([]);
      expect(outcome.values?.k0).toBe(401);
      expect(outcome.values?.parts).toEqual(["a", "b"]);
    } finally {
      quick.dispose?.();
    }
  }, 120_000);

  // The list item cap is the same on both engines, one warn line.
  it("holds a list function to the 10,000 item cap alike on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    // The cap's answer is what this compares, not the run budget: a 10,001 item answer kept in
    // the values costs QuickJS 150 to 250 ms on a busy machine, the default budget's edge.
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([], abi);
    try {
      const root = rootOf(field("a"), field("b", { value: "sum(a)" }), field("c", { value: "len(a)" }));
      const list = Array.from({ length: 10001 }, () => 1);
      const payload = abi.serializeContext({ formId: "e1", values: { a: list, b: 1, c: 0 }, locale: "en", form: root, logLevel: "warn" }, WasmValidationHost.STRICT_POLICY);
      const theirs = await quick.run(payload);
      expect(theirs).toBe(await inProcess.run(payload));
      const warns = (parsed(theirs).logs ?? []).filter((entry) => entry.level === "warn").map((entry) => entry.message);
      expect(warns).toContain("formula function: sum: the list is over the 10000 item cap; no answer");
    } finally {
      quick.dispose?.();
    }
  }, 120_000);

  it("logs a plugin result that is not data and a size cap once, identically", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([functionsPlugin], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(functionsPlugin)], abi);
    try {
      const root = rootOf(field("a"), field("b", { value: "nan()" }), field("c", { value: 'padStart(a, 20000, "z")' }));
      const payload = abi.serializeContext({ formId: "e1", values: { a: "x", b: 1, c: "y" }, locale: "en", form: root, logLevel: "warn" }, WasmValidationHost.STRICT_POLICY);
      const theirs = await quick.run(payload);
      expect(theirs).toBe(await inProcess.run(payload));
      const warns = (parsed(theirs).logs ?? []).filter((entry) => entry.level === "warn").map((entry) => entry.message);
      expect(warns.filter((message) => message.includes('"nan"'))).toHaveLength(1);
      expect(warns).toContain("formula function: padStart: the length is clamped to the 10,000 character cap (text.truncated)");
    } finally {
      quick.dispose?.();
    }
  });
});

// A condition holds only for the boolean true, and two
// texts order by UTF-16 code unit.
describe("QuickJS vs in-process kernel parity: strict truthiness and text ordering", () => {
  const field = (id: string, rules?: Record<string, unknown>, configuration: Record<string, unknown> = {}): ComponentNode =>
    ({ id, type: "anyx", configuration, ...(rules !== undefined ? { rules } : {}) }) as ComponentNode;
  const rootOf = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const parsed = (serialized: string) => JSON.parse(serialized) as { errors: Array<{ code: string }>; values?: Record<string, unknown> };

  /** The formula for `b`, the answers sent, and the value `b` comes to (absent: no answer). */
  const vectors: Array<[string, string, Record<string, unknown>, unknown]> = [
    // The text "false", an empty list and an unticked group are no yes.
    ["not of the text false", "not t", { t: "false" }, true],
    ["if over the text false", "if t then 1 else 2", { t: "false" }, 2],
    ["if over true", "if t then 1 else 2", { t: true }, 1],
    ["if over an empty list", "if l then 1 else 2", { l: [] }, 2],
    ["if over an unticked group", "if g then 1 else 2", { g: { a: false } }, 2],
    ["not of an empty list", "not l", { l: [] }, true],
    ["text or zero", '"x" or 0', {}, false],
    ["one and two", "1 and 2", {}, false],
    ["true and true", "t and t", { t: true }, true],
    ["and over a number", "t and n", { t: true, n: 1 }, false],
    ["or over a number", "f or n", { f: false, n: 1 }, false],
    ["else-less if", "if n then 1", { n: 1 }, undefined],
    // Text orders by code unit.
    ["equal texts, <=", '"abc" <= "abc"', {}, true],
    ["equal texts, >=", '"abc" >= "abc"', {}, true],
    ["b above a", '"b" > "a"', {}, true],
    ["capital below lower case", '"Z" < "a"', {}, true],
    ["accent above z", '"é" > "z"', {}, true],
    ["two numerals order as numbers", '"10" > "9"', {}, true],
    ["numeral below, by number", '"10" < "9"', {}, false],
    ["non-numeral texts keep code units", '"10a" < "9a"', {}, true],
    ["number() orders numerals", 'number("10") > number("9")', {}, true],
    ["unpadded day is a text", 'd3 > d', { d: "2026-01-05", d3: "2026-1-5" }, true],
    ["invalid day is a text", 'd2 > d', { d: "2026-01-01", d2: "2026-02-30" }, true],
    ["valid days keep the day rule", 'd < d2', { d: "2026-01-05", d2: "2026-02-01" }, true],
    ["text against a number never orders", '"abc" > 5', {}, false],
    ["numeral text against a number", '"10" > 9', {}, true],
    ["missing never orders", "u <= \"a\"", {}, false]
  ];

  it("evaluates every vector byte for byte alike and to the value it should", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([], abi);
    try {
      for (const [label, formula, values, expected] of vectors) {
        const root = rootOf(field("t"), field("n"), field("f"), field("l"), field("g"), field("d"), field("d2"), field("d3"), field("u"), field("b", { value: formula }));
        const payload = abi.serializeContext({ formId: "c1", values: { ...values, b: "stale" }, locale: "en", form: root, formulaErrors: "warn", logLevel: "warn", today: "2026-10-08" }, WasmValidationHost.STRICT_POLICY);
        const theirs = await quick.run(payload);
        expect(theirs, label).toBe(await inProcess.run(payload));
        const outcome = parsed(theirs);
        expect(outcome.errors.filter((error) => error.code === "formula.invalid"), label).toEqual([]);
        expect(outcome.values?.b, label).toEqual(expected);
      }
    } finally {
      quick.dispose?.();
    }
  }, 300_000);

  it("reads a rule verdict as holding for true alone, on every rule that hides or requires, alike on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([], abi);
    try {
      const answers: Array<[string, unknown]> = [["true", true], ["false", false], ["text", "yes"], ["number", 1], ["list", ["a"]], ["empty list", []], ["group", { a: true }], ["none", null]];
      for (const [label, answer] of answers) {
        // `shown` is dropped when hidden; `needed` is refused while empty when required (a refused run has no values, so the two are asked apart).
        const hiding = rootOf(
          field("flag"),
          field("shown", { visibleWhen: "flag" }, { hiddenValueBehavior: "exclude-from-submission" }),
          field("sized", { visibleWhen: "len(flag)" }, { hiddenValueBehavior: "exclude-from-submission" })
        );
        const requiring = rootOf(field("flag"), field("needed", { requiredWhen: "flag" }));
        const holds = answer === true;
        for (const [root, values] of [
          [hiding, { flag: answer, shown: "kept", sized: "kept" }],
          [requiring, { flag: answer }]
        ] as const) {
          const payload = abi.serializeContext({ formId: "c1", values: { ...values }, locale: "en", form: root, formulaErrors: "warn" }, WasmValidationHost.STRICT_POLICY);
          const theirs = await quick.run(payload);
          expect(theirs, label).toBe(await inProcess.run(payload));
          const outcome = parsed(theirs);
          if (root === hiding) {
            expect(outcome.values?.shown === "kept", `${label}: shown`).toBe(holds);
            // A condition that is no yes-or-no (len) never holds, so `sized` is always dropped.
            expect(outcome.values?.sized, `${label}: sized`).toBeUndefined();
          } else {
            expect(outcome.errors.some((error) => error.code === "required"), `${label}: required`).toBe(holds);
          }
        }
      }
    } finally {
      quick.dispose?.();
    }
  }, 120_000);
});

// A pattern of a catastrophic shape is refused at compile and in field constraints
// unless the host allows it (`riskyPatterns`).
describe("QuickJS vs in-process kernel parity: the riskyPatterns policy", () => {
  const text = (id: string, configuration: Record<string, unknown> = {}, rules?: Record<string, unknown>): ComponentNode =>
    ({ id, type: "text", configuration, ...(rules !== undefined ? { rules } : {}) }) as ComponentNode;
  const rootOf = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  type Outcome = { errors: Array<{ code: string; componentId?: string; parameters?: Record<string, unknown> }>; values?: Record<string, unknown>; logs?: Array<{ level: string; message: string }> };

  async function both(root: ComponentNode, values: Record<string, unknown>, context: Record<string, unknown> = {}, maxEvalMs = 60_000): Promise<{ quickJs: string; inProcess: string }> {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs }).instantiate([], abi);
    try {
      const payload = abi.serializeContext({ formId: "c3", values, locale: "en", form: root, logLevel: "debug", ...context }, WasmValidationHost.STRICT_POLICY);
      return { quickJs: await quick.run(payload), inProcess: await inProcess.run(payload) };
    } finally {
      quick.dispose?.();
    }
  }
  const outcomeOf = (serialized: string): Outcome => JSON.parse(serialized) as Outcome;
  const hostile = "a".repeat(40) + "!";

  it("refuses a literal risky matches pattern under fail, drops the rule under warn, and runs it when allowed, alike on both engines", async () => {
    const root = rootOf(text("code"), text("note", {}, { visibleWhen: 'matches(code, "(a+)+$")' }));
    const failed = await both(root, { code: hostile });
    expect(failed.quickJs).toBe(failed.inProcess);
    expect(outcomeOf(failed.quickJs).errors).toMatchObject([{ code: "formula.invalid", parameters: { where: "rules:note:visibleWhen" } }]);
    expect(String(outcomeOf(failed.quickJs).errors[0]?.parameters?.message)).toContain("(a+)+$");
    const warned = await both(root, { code: hostile }, { formulaErrors: "warn" });
    expect(warned.quickJs).toBe(warned.inProcess);
    expect(outcomeOf(warned.quickJs).errors).toEqual([]);
    const allowed = await both(root, { code: "aaa" }, { riskyPatterns: "allow" });
    expect(allowed.quickJs).toBe(allowed.inProcess);
    expect(outcomeOf(allowed.quickJs).errors).toEqual([]);
    expect((outcomeOf(allowed.quickJs).logs ?? []).filter((entry) => entry.level === "warn")).toEqual([]);
  }, 120_000);

  it("treats a risky field pattern as a definition problem, alike on both engines: logged and skipped under warn, failed closed under fail", async () => {
    const root = rootOf(text("code", { pattern: "(a+)+$", patternMessage: "bad shape" }));
    const warned = await both(root, { code: hostile }, { formulaErrors: "warn" });
    expect(warned.quickJs).toBe(warned.inProcess);
    expect(outcomeOf(warned.quickJs).errors).toEqual([]);
    expect((outcomeOf(warned.quickJs).logs ?? []).filter((entry) => entry.level === "warn")).toEqual([{ level: "warn", message: "pattern is risky: code", data: { componentId: "code", pattern: "(a+)+$" } }]);
    const failed = await both(root, { code: hostile }, { formulaErrors: "fail" });
    expect(failed.quickJs).toBe(failed.inProcess);
    expect(outcomeOf(failed.quickJs).errors).toMatchObject([{ code: "pattern", componentId: "code", parameters: { invalid: true, risky: true, pattern: "(a+)+$" } }]);
    const allowed = await both(root, { code: "aaa" }, { formulaErrors: "fail", riskyPatterns: "allow" });
    expect(allowed.quickJs).toBe(allowed.inProcess);
    expect(outcomeOf(allowed.quickJs).errors).toEqual([]);
  }, 120_000);

  it("keeps an interrupt inside an allowed catastrophic pattern a run failure: the deadline is uncatchable and the host cannot tell which function was running", async () => {
    const root = rootOf(text("code", { pattern: "(a+)+$" }));
    const abi = new JsonWasmAbi();
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 300 }).instantiate([], abi);
    try {
      const payload = abi.serializeContext({ formId: "c3", values: { code: hostile }, locale: "en", form: root, formulaErrors: "fail", riskyPatterns: "allow" }, WasmValidationHost.STRICT_POLICY);
      await expect(Promise.resolve().then(() => quick.run(payload))).rejects.toThrow(/interrupt/i);
    } finally {
      quick.dispose?.();
    }
  }, 60_000);
});

// Evaluator fast paths: a cache of compiled `matches` patterns on the run's
// context, a character-code date check, a walk of a path's dotted prefixes for keyed reads, the
// operator and call-argument fast paths, and the fold's first pass that skips its second look when
// the hidden-value policy changed nothing. Same source on both engines, so byte for byte alike,
// and to the value the uncached, scanning, pattern-based readings gave.
describe("QuickJS vs in-process kernel parity: the evaluator fast paths", () => {
  const field = (id: string, rules?: Record<string, unknown>, configuration: Record<string, unknown> = {}): ComponentNode =>
    ({ id, type: "anyx", configuration, ...(rules !== undefined ? { rules } : {}) }) as ComponentNode;
  const rootOf = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const parsed = (serialized: string) =>
    JSON.parse(serialized) as { errors: Array<{ code: string }>; values?: Record<string, unknown>; logs?: Array<{ level: string; message: string }> };
  const none = (call: string): string => `coalesce(${call}, "none")`;
  const twice = (call: string): string => `concat(${none(call)}, ${none(call)})`;

  /** [label, formula for b, the answers sent, what b comes to]. */
  const vectors: Array<[string, string, Record<string, unknown>, unknown]> = [
    // A pattern compiled once per run, answered as when it compiled every call.
    ["a postal pattern used twice", twice("matches(a, m)"), { a: "K1A 0B1", m: "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d" }, "truetrue"],
    ["the whole text, never part of it", twice("matches(a, m)"), { a: "aa", m: "a" }, "falsefalse"],
    ["a pattern valid only inside the anchors", twice("matches(a, m)"), { a: "b", m: "a)|(b" }, "nonenone"],
    ["a stray close parenthesis", twice("matches(a, m)"), { a: "a", m: "a)" }, "nonenone"],
    ["an open parenthesis", twice("matches(a, m)"), { a: "a", m: "(" }, "nonenone"],
    ["a lone backslash", twice("matches(a, m)"), { a: "a", m: "\\" }, "nonenone"],
    ["a group opened and a group closed", twice("matches(a, m)"), { a: "xy", m: "x)(?:y" }, "nonenone"],
    ["a pattern named after an object member", twice("matches(a, m)"), { a: "__proto__", m: "__proto__" }, "truetrue"],
    ["a pattern named constructor", twice("matches(a, m)"), { a: "constructor", m: "constructor" }, "truetrue"],
    ["a unicode class", twice("matches(a, m)"), { a: "Ünï", m: "\\p{L}+" }, "truetrue"],
    ["two patterns taking turns", `concat(matches(a, m), matches(a, "b"), matches(a, m))`, { a: "a", m: "a" }, "truefalsetrue"],
    ["an empty pattern", twice("matches(a, m)"), { a: "", m: "" }, "truetrue"],
    // A date by character codes.
    ["a leap day", "isDate(a)", { a: "2024-02-29" }, true],
    ["a century that is no leap year", "isDate(a)", { a: "1900-02-29" }, false],
    ["a century that is one", "isDate(a)", { a: "2000-02-29" }, true],
    ["the first day there is", "isDate(a)", { a: "0001-01-01" }, true],
    ["year zero", "isDate(a)", { a: "0000-01-01" }, false],
    ["a month of thirty days", "isDate(a)", { a: "2024-04-31" }, false],
    ["the last day of the last month", "isDate(a)", { a: "9999-12-31" }, true],
    ["digits of another script", "isDate(a)", { a: "٢٠٢٤-٠٢-٠١" }, false],
    ["full-width digits", "isDate(a)", { a: "２０２４-０２-０１" }, false],
    ["a trailing newline", "isDate(a)", { a: "2024-02-29\n" }, false],
    ["slashes", "isDate(a)", { a: "2024/02/29" }, false],
    ["the year of the first day", "year(a)", { a: "0001-01-01" }, 1],
    ["days between a leap day and the next day", 'dateDiff(a, "2024-03-01", "days")', { a: "2024-02-29" }, 1],
    ["the age of a leap-day birthday", "age(a)", { a: "2000-02-29" }, 26],
    ["a date added across a leap year", 'dateAdd(a, 1, "years")', { a: "2024-02-29" }, "2025-02-28"],
    // A list function over the cap, and one that is not.
    ["a list over the cap for a list function", "sum(l)", { l: Array.from({ length: 10001 }, () => 1) }, undefined],
    ["a list over the cap for a function that reads its length", "len(l)", { l: Array.from({ length: 10001 }, () => 1) }, 10001],
    ["a list at the cap", "sum(l)", { l: Array.from({ length: 10000 }, () => 1) }, 10000],
    ["no list among the arguments", 'concat(a, "-", m)', { a: "x", m: "y" }, "x-y"],
    // One operator over two operands, nested operators, call arguments in order.
    ["one comparison", "a = 1", { a: 1 }, true],
    ["one comparison of texts", "a < m", { a: "apple", m: "banana" }, true],
    ["and, its left not holding", "a = 2 and m = 1", { a: 1, m: 1 }, false],
    ["or, its left holding", "a = 1 or m = 2", { a: 1, m: 1 }, true],
    ["a negation as a left operand", "not (a = 2) and m = 1", { a: 1, m: 1 }, true],
    ["a call as a left operand", "len(m) = 3", { m: "abc" }, true],
    ["parentheses on both sides", "(a + 1) * (m + 2)", { a: 2, m: 1 }, 9],
    ["arithmetic over no answer", "a / 0", { a: 4 }, undefined],
    ["a call over several arguments", 'concat(a, "/", m, "/", a)', { a: "x", m: "y" }, "x/y/x"],
    ["a call over nothing", "today()", {}, "2026-10-08"]
  ];

  it("evaluates every vector byte for byte alike and to the value it should", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter({ maxEvalMs: 60_000 }).instantiate([], abi);
    try {
      for (const [label, formula, values, expected] of vectors) {
        const root = rootOf(field("a"), field("l"), field("m"), field("b", { value: formula }));
        const sent = { ...values, b: "stale" };
        const payload = abi.serializeContext({ formId: "perf", values: sent, locale: "en", form: root, formulaErrors: "warn", logLevel: "warn", today: "2026-10-08" }, WasmValidationHost.STRICT_POLICY);
        const theirs = await quick.run(payload);
        expect(theirs, label).toBe(await inProcess.run(payload));
        const outcome = parsed(theirs);
        expect(outcome.errors.filter((error) => error.code === "formula.invalid"), label).toEqual([]);
        expect(outcome.values?.b, label).toEqual(expected);
      }
    } finally {
      quick.dispose?.();
    }
  }, 300_000);

  it("reads a row's answers under a data-keyed container as the scan did, and an entry without one stays unanswered", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    const keyedLines: ComponentNode = {
      id: "lines",
      type: "repeatingSection",
      configuration: {},
      collection: { itemFields: ["sku", "addr.city", "label", "plain"] },
      children: {
        content: [
          { id: "sku", type: "text", configuration: {} },
          { id: "addr", type: "container", configuration: { dataKey: "addr" }, children: { content: [{ id: "city", type: "text", configuration: { dataKey: "city" } }] } },
          { id: "label", type: "text", configuration: {}, rules: { value: 'concat(row.sku, ":", row.addr.city)' } },
          { id: "plain", type: "text", configuration: {}, rules: { value: "concat(row.sku, row.sku)" } }
        ]
      }
    };
    try {
      const root = rootOf(keyedLines);
      const values = { "lines[0].sku": "A", "lines[0].addr.city": "Paris", "lines[1].sku": "B", "lines[1].addr.city": "Lyon", "lines[2].sku": "C" };
      const payload = abi.serializeContext({ formId: "perf", values, locale: "en", form: root, formulaErrors: "warn", logLevel: "warn" }, WasmValidationHost.STRICT_POLICY);
      const theirs = await quick.run(payload);
      expect(theirs).toBe(await inProcess.run(payload));
      const outcome = parsed(theirs);
      expect(outcome.errors.filter((error) => error.code === "formula.invalid")).toEqual([]);
      expect(outcome.values).toMatchObject({
        "lines[0].label": "A:Paris",
        "lines[1].label": "B:Lyon",
        "lines[0].plain": "AA",
        "lines[1].plain": "BB",
        "lines[2].plain": "CC"
      });
      // The entry with no city leaves the calculation reading it unanswered, as it always did.
      expect(outcome.values?.["lines[2].label"]).toBeUndefined();
    } finally {
      quick.dispose?.();
    }
  }, 120_000);

  it("folds a hidden field whose answer is kept in one pass and one whose answer is dropped in two, alike on both engines", async () => {
    const abi = new JsonWasmAbi();
    const inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    try {
      const root = rootOf(
        field("mode"),
        field("kept", { visibleWhen: 'mode = "detailed"' }, { hiddenValueBehavior: "retain" }),
        field("dropped", { visibleWhen: 'mode = "detailed"' }, { hiddenValueBehavior: "exclude-from-submission" }),
        field("follow", { visibleWhen: "not (empty(dropped))" }, { hiddenValueBehavior: "exclude-from-submission" }),
        field("plain")
      );
      const cases: Array<[string, Record<string, unknown>]> = [
        ["nothing hidden", { mode: "detailed", kept: "k", dropped: "d", follow: "f", plain: "p" }],
        ["hidden, one kept and one dropped", { mode: "simple", kept: "k", dropped: "d", follow: "f", plain: "p" }],
        ["hidden and empty", { mode: "simple" }],
        ["an undefined answer among them", { mode: "simple", kept: "k", plain: null }],
        ["nothing answered", {}]
      ];
      for (const [label, values] of cases) {
        for (const unknownFields of ["strip", "keep"] as const) {
          const payload = abi.serializeContext({ formId: "perf", values, locale: "en", form: root, unknownFields, logLevel: "debug" }, WasmValidationHost.STRICT_POLICY);
          expect(await quick.run(payload), `${label}, ${unknownFields}`).toBe(await inProcess.run(payload));
        }
      }
      const outcome = parsed(
        await quick.run(abi.serializeContext({ formId: "perf", values: { mode: "simple", kept: "k", dropped: "d", follow: "f", plain: "p" }, locale: "en", form: root }, WasmValidationHost.STRICT_POLICY))
      );
      expect(outcome.values).toEqual({ mode: "simple", kept: "k", plain: "p" });
    } finally {
      quick.dispose?.();
    }
  }, 120_000);
});
