import { describe, expect, it } from "vitest";

import { kernelRuleExpression } from "../../form-engine/core/expressions/compile.js";
import { isEvaluableExpression } from "../../form-engine/core/expressions/condition-shape.js";
import { kernelParseFormula } from "../../form-engine/core/expressions/formula.js";
import { FORMULA_FUNCTION_NAMES, formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { kernelStructureCheck } from "../../form-engine/core/expressions/definition-structure.js";
import { kernelInspectSizeGate, type DefinitionInspectResponse } from "../../form-engine/core/expressions/inspect.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenario } from "../../form-engine/core/form-tests/form-test-run.js";
import {
  FORM_TEST_MAX_STEPS,
  type FormTestOpReport,
  type FormTestScenario,
  type FormTestScenarioResult
} from "../../form-engine/core/form-tests/form-test-types.js";
import {
  DEFAULT_VALIDATION_MESSAGES,
  ENGINE_VALIDATION_CODES,
  defaultValidationMessage,
  layerValidationMessages,
  readValidationMessages,
  resolveValidationMessage
} from "../../form-engine/core/localization/validation-messages.js";
import type { FormTranslations } from "../../form-engine/core/localization/translations.js";
import { validatePdfLayout } from "../../form-engine/core/schema/pdf-layout-read.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import { createFormTestKernelDriver } from "../../form-engine/validation/wasm/form-test-kernel-driver.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import {
  PORTABLE_KERNEL_FUNCTIONS,
  kernelFormTestOpCatalogs,
  kernelFormTestOpDefaultMessage,
  kernelFormTestOpEngineCodes,
  kernelFormTestOpEvaluable,
  kernelFormTestOpLayoutUsable,
  kernelFormTestOpMaxBytes,
  kernelFormTestOpMaxScenarios,
  kernelFormTestOpMaxSteps,
  kernelFormTestOpMessage,
  kernelFormTestOpMessagesEn,
  kernelFormTestOpUtf8Bytes
} from "../../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, stableStringify, type WasmPlugin } from "../../form-engine/validation/wasm/wasm-validation-host.js";
import {
  FORM_TESTS_CLOCK_FIXTURE,
  FORM_TESTS_FIXTURE,
  FORM_TESTS_FIXTURE_SCENARIOS,
  fixtureWithTests
} from "./fixtures/form-tests-fixture.js";

/**
 * The sandbox's `test` op over the in-process adapter: the
 * form's tests run on the kernel's reading and answered as a report. The op is the kernel
 * driver with the host round trip taken out, so every scenario must come to the very steps the
 * driver reaches through `runFormTestScenario`; the fixture corpus (the main form with its
 * journey, the clock form) and a few probes of this file's own hold the two together.
 */

const abi = new JsonWasmAbi();

function adapter(plugins: WasmPlugin[] = []) {
  return new InProcessWasmHostAdapter().instantiate(plugins, abi);
}

const bare = adapter();

/** The op's answer as the instance serialises it, and parsed. */
function ask(request: Record<string, unknown>, instance = bare): { text: string; answer: DefinitionInspectResponse } {
  const text = instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", ...request })) as string;
  return { text, answer: JSON.parse(text) as DefinitionInspectResponse };
}

function report(request: Record<string, unknown>, instance = bare): FormTestOpReport {
  const { answer } = ask(request, instance);
  if (!answer.ok || answer.op !== "test") {
    throw new Error("not a test answer: " + JSON.stringify(answer));
  }
  return answer.report;
}

/** What the kernel driver reaches for each block of `source`, through the runner. */
async function driverResults(definition: FormDefinition, source: string, plugins: WasmPlugin[] = []): Promise<FormTestScenarioResult[]> {
  const functions: Record<string, (args: unknown[]) => unknown> = {};
  for (const plugin of plugins) {
    Object.assign(functions, plugin.functions ?? {});
  }
  const signatures = [...formulaFunctionSignatures(), ...Object.keys(functions).map((name) => ({ name, min: 0, max: Number.POSITIVE_INFINITY }))];
  const parsed = kernelParseFormTests(source, signatures);
  expect(parsed.problems).toEqual([]);
  const host = createInProcessWasmValidationHost(plugins);
  const results: FormTestScenarioResult[] = [];
  for (const scenario of parsed.scenarios) {
    results.push(
      await runFormTestScenario(
        scenario as FormTestScenario,
        createFormTestKernelDriver(definition, plugins.length > 0 ? { host, functions, signatures } : { host })
      )
    );
  }
  return results;
}

/** The op's scenarios without what the runner does not report (the entry's id, the header line). */
function asResults(found: FormTestOpReport): FormTestScenarioResult[] {
  return found.scenarios.map(({ id: _id, line: _line, ...result }) => result);
}

async function expectParity(definition: FormDefinition, source: string, plugins: WasmPlugin[] = []): Promise<FormTestOpReport> {
  const instance = plugins.length > 0 ? adapter(plugins) : bare;
  const found = report({ definition, tests: source }, instance);
  expect(found.problems).toEqual([]);
  expect(stableStringify(asResults(found))).toBe(stableStringify(await driverResults(definition, source, plugins)));
  return found;
}

function formOf(content: unknown[], extra: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "probe",
    version: "1",
    schemaVersion: "1",
    root: { id: "form", type: "form", configuration: {}, children: { content } },
    ...extra
  } as unknown as FormDefinition;
}

describe("the test op: the fixture corpus comes to the kernel driver's steps", () => {
  for (const form of ["main", "clock"] as const) {
    it(`every ${form} scenario, step for step, with the fixture's kernel statuses`, async () => {
      const entries = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form);
      const definition = form === "main" ? FORM_TESTS_FIXTURE : FORM_TESTS_CLOCK_FIXTURE;
      const found = await expectParity(definition, entries.map((entry) => entry.source).join("\n\n"));
      expect(found.scenarios.map((scenario) => [scenario.name, scenario.status, scenario.reason])).toEqual(
        entries.map((entry) => [entry.name, entry.expected.kernel, entry.reason?.kernel])
      );
    });
  }

  it("reports every status, and the summary counts them", () => {
    const found = report({ definition: FORM_TESTS_FIXTURE, tests: FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main").map((entry) => entry.source).join("\n") });
    const statuses = new Set(found.scenarios.map((scenario) => scenario.status));
    expect([...statuses].sort()).toEqual(["error", "failed", "passed", "skipped"]);
    const count = (status: string) => found.scenarios.filter((scenario) => scenario.status === status).length;
    expect(found.summary).toEqual({ total: found.scenarios.length, passed: count("passed"), failed: count("failed"), skipped: count("skipped"), error: count("error") });
  });
});

describe("the test op: probes of the kernel's reading", () => {
  const grid = formOf([
    {
      id: "deps",
      type: "dataGrid",
      configuration: { label: "Deps", initialRows: 1 },
      collection: { collectionPath: "deps" },
      rules: { maxRows: "cap" },
      children: { content: [{ id: "dep_name", type: "text", configuration: { label: "Name", required: true } }] }
    },
    { id: "cap", type: "number", configuration: { label: "Cap" } }
  ]);

  it("a grid's formula bound refuses a row (action.refused), and its required cell refuses the submit", async () => {
    const found = await expectParity(
      grid,
      [
        'test "the bound"',
        "  set cap = 1",
        "  expect rows of deps = 1",
        "  add row to deps",
        'test "the cell"',
        "  submit",
        "  expect refused",
        "  expect error on deps[0].dep_name: required",
        '  expect message on deps[0].dep_name = "This field is required"'
      ].join("\n")
    );
    expect(found.scenarios[0]).toMatchObject({ status: "error", steps: [{ status: "ran" }, { status: "passed" }, { status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", max: 1 } }] });
    expect(found.scenarios[1]?.status).toBe("passed");
  });

  it("the judge's additions reach the report: params.sent on a withheld miss, actual.last on a path end", async () => {
    const found = await expectParity(
      FORM_TESTS_FIXTURE,
      [
        'test "sent"',
        "  given journey = none",
        '  set applicant_name = "Ada"',
        "  set age = 30",
        '  set has_pet = false',
        '  set pet_name = "Rex"',
        "  submit",
        "  expect pet_name withheld",
        'test "the end"',
        '  set stop_code = "STOP"',
        "  expect path ends"
      ].join("\n")
    );
    expect(found.scenarios[0]?.steps.at(-1)).toMatchObject({ code: "expect.withheld", params: { path: "pet_name", sent: "Rex" } });
    expect(found.scenarios[1]?.steps.at(-1)).toMatchObject({ code: "expect.pathEnd", actual: { end: "exit", last: "stop" } });
  });

  it("a type the definition's `kinds` map gives a base is read as that base, by the op and by the driver alike", async () => {
    const mapped = formOf([{ id: "born", type: "gcds-date", configuration: { label: "Born", min: "1900-01-01" } }], { kinds: { "gcds-date": "date" } });
    const found = await expectParity(
      mapped,
      ['test "mapped date"', '  set born = "1800-01-01"', "  check", "  expect error on born: date.min"].join("\n")
    );
    expect(found.scenarios.map((scenario) => scenario.status)).toEqual(["passed"]);
    // Without the map the type is unknown and no date bound applies.
    const unmapped = formOf([{ id: "born", type: "gcds-date", configuration: { label: "Born", min: "1900-01-01" } }]);
    const bare2 = report({ definition: unmapped, tests: ['test "mapped date"', '  set born = "1800-01-01"', "  check", "  expect error on born: date.min"].join("\n") });
    expect(bare2.scenarios.map((scenario) => scenario.status)).toEqual(["failed"]);
  });

  it("a choice outside the given options is refused with the engine's wording, in French from the form's `texts` translations", async () => {
    // The engine words only English: the French is the definition's `texts › messages` entry.
    const fixture = FORM_TESTS_FIXTURE.translations ?? {};
    const french: FormDefinition = {
      ...FORM_TESTS_FIXTURE,
      translations: {
        ...fixture,
        fr: { ...fixture.fr, texts: { messages: { "option.notAllowed": { text: "Choisissez l’une des options proposées", source: "x" } } } }
      }
    };
    await expectParity(
      french,
      [
        'test "province"',
        "  given journey = none",
        '  given options for province = ("ON")',
        '  given locale = "fr"',
        '  set province = "XX"',
        "  check",
        "  expect error on province: option.notAllowed",
        '  expect message on province = "Choisissez l’une des options proposées"'
      ].join("\n")
    );
  });

  it("bad givens and a definition that does not compile end as the driver ends them", async () => {
    const typo = formOf([{ id: "a", type: "text", configuration: {}, rules: { visibleWhen: "nosuch(" } }]);
    const found = await expectParity(typo, ['test "typo"', "  expect a visible"].join("\n"));
    expect(found.scenarios[0]).toMatchObject({ status: "error", reason: "scenario.formulaInvalid" });
    const givens = await expectParity(
      FORM_TESTS_FIXTURE,
      ['test "locale"', '  given locale = "de"', "  expect applicant_name visible", 'test "options"', '  given options for age = ("1")', "  expect age visible"].join("\n")
    );
    expect(givens.scenarios.map((scenario) => [scenario.reason, scenario.params])).toEqual([
      ["scenario.badGiven", { given: "locale", locale: "de" }],
      ["scenario.badGiven", { given: "options", path: "age", reason: "noSource" }]
    ]);
  });

  it("a plugin's function and validator reach the op, as a run gets them", async () => {
    const plugin: WasmPlugin = {
      id: "probe-plugin",
      version: "1",
      functions: { double: (args: unknown[]) => (typeof args[0] === "number" ? args[0] * 2 : null) },
      validators: [
        {
          id: "no-bob",
          version: "1",
          validate: (context: { values?: Record<string, unknown> }) => ({
            valid: context.values?.name !== "Bob",
            errors: context.values?.name === "Bob" ? [{ code: "noBob", componentId: "name", path: "name", stage: "custom", severity: "error" }] : []
          })
        }
      ]
    } as unknown as WasmPlugin;
    const form = formOf([
      { id: "name", type: "text", configuration: {} },
      { id: "n", type: "number", configuration: {} },
      { id: "twice", type: "number", configuration: {}, rules: { value: "double(n)" } }
    ]);
    const found = await expectParity(
      form,
      ['test "plugin"', "  set n = 4", "  expect twice = 8", '  set name = "Bob"', "  submit", "  expect refused", "  expect error on name: noBob"].join("\n"),
      [plugin]
    );
    expect(found.scenarios[0]?.status).toBe("passed");
  });
});

describe("the test op: sources", () => {
  it("absent tests: the definition's own entries, one block each, with their ids and header lines", () => {
    const found = report({ definition: fixtureWithTests("clock") });
    expect(found.problems).toEqual([]);
    expect(found.scenarios.map((scenario) => [scenario.id, scenario.line, scenario.status])).toEqual([
      ["clock-1", 1, "passed"],
      ["clock-2", 1, "error"]
    ]);
    expect(report({ definition: fixtureWithTests("clock"), tests: null }).scenarios).toHaveLength(2);
  });

  it("a sidecar text replaces the definition's own and carries no ids", () => {
    const found = report({ definition: fixtureWithTests("main"), tests: 'test "one"\n  expect applicant_name visible\n\ntest "two"\n  expect age visible' });
    expect(found.scenarios.map((scenario) => [scenario.id, scenario.name, scenario.line, scenario.status])).toEqual([
      [undefined, "one", 1, "passed"],
      [undefined, "two", 4, "passed"]
    ]);
  });

  it("a sidecar parse problem runs nothing and is reported without an id", () => {
    const found = report({ definition: FORM_TESTS_FIXTURE, tests: 'test "a"\n  expect applicant_name visible\n  frobnicate\ntest "b"\n  expect age visible' });
    expect(found.scenarios).toEqual([]);
    expect(found.problems).toEqual([expect.objectContaining({ code: "unknownStatement", line: 3 })]);
    expect(found.problems[0]).not.toHaveProperty("id");
    expect(found.summary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, error: 0 });
  });

  it("definition entries are read as the panel reads them: problems by entry, an empty entry, a second block, a repeated name", () => {
    const definition = {
      ...FORM_TESTS_FIXTURE,
      tests: {
        scenarios: [
          { id: "a", source: 'test "same"\n  expect applicant_name visible' },
          { id: "b", source: 'test "broken"\n  frobnicate' },
          { id: "c", source: "# nothing yet" },
          { id: "d", source: 'test "first"\n  expect age visible\ntest "second"\n  expect age visible' },
          { id: "e", source: 'test "same"\n  expect age visible' },
          { id: "a", source: 'test "dropped"\n  expect age visible' },
          { id: "", source: 'test "no id"\n  expect age visible' },
          { id: "f" }
        ]
      }
    } as unknown as FormDefinition;
    const found = report({ definition });
    expect(found.scenarios.map((scenario) => [scenario.id, scenario.name, scenario.status])).toEqual([
      ["a", "same", "passed"],
      ["e", "same", "passed"]
    ]);
    expect(found.problems.map((problem) => [problem.id, problem.code, problem.line])).toEqual([
      ["b", "unknownStatement", 2],
      ["c", "expectedName", 1],
      ["d", "stepOutsideTest", 3],
      ["e", "duplicateName", 1]
    ]);
    expect(found.problems[3]).toMatchObject({ params: { name: "same" } });
  });
});

describe("the test op: caps and refusals", () => {
  const expectRefused = (request: Record<string, unknown>, code: string, limit?: number) => {
    const { answer } = ask(request);
    expect(answer).toMatchObject({ ok: false, error: { code } });
    if (limit !== undefined) {
      expect(answer).toMatchObject({ error: { limit } });
    }
  };

  it("pins the caps: 256 KiB of text, 200 scenarios, the runner's statement bound", () => {
    expect(kernelFormTestOpMaxBytes()).toBe(256 * 1024);
    expect(kernelFormTestOpMaxScenarios()).toBe(200);
    expect(kernelFormTestOpMaxSteps()).toBe(FORM_TEST_MAX_STEPS);
  });

  it("counts UTF-8 bytes, a surrogate pair as four and a lone surrogate as three", () => {
    for (const text of ["", "abc", "é", "€", "😀", "a😀b", "\ud800", "\udc00x", "Québec ’ ☃"]) {
      const lone = /[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
      expect(kernelFormTestOpUtf8Bytes(text), text).toBe(lone ? Buffer.byteLength(text.replace(/[\ud800-\udfff]/g, "�")) : Buffer.byteLength(text));
    }
  });

  it("tests that are not text", () => {
    expectRefused({ definition: FORM_TESTS_FIXTURE, tests: 42 }, "invalid_request");
    expectRefused({ definition: FORM_TESTS_FIXTURE, tests: ["test"] }, "invalid_request");
  });

  it("more than 256 KiB of text, sidecar or entries together", () => {
    const padding = "# " + "x".repeat(1024) + "\n";
    const big = 'test "a"\n  expect age visible\n' + padding.repeat(256);
    expect(kernelFormTestOpUtf8Bytes(big)).toBeGreaterThan(kernelFormTestOpMaxBytes());
    expectRefused({ definition: FORM_TESTS_FIXTURE, tests: big }, "invalid_request", kernelFormTestOpMaxBytes());
    const half = 'test "a"\n  expect age visible\n' + padding.repeat(130);
    const entries = { ...FORM_TESTS_FIXTURE, tests: { scenarios: [{ id: "a", source: half }, { id: "b", source: half.replace('"a"', '"b"') }] } };
    expectRefused({ definition: entries }, "invalid_request", kernelFormTestOpMaxBytes());
    // Just under the cap runs.
    expect(report({ definition: FORM_TESTS_FIXTURE, tests: 'test "a"\n  expect age visible\n' + padding.repeat(150) }).summary.passed).toBe(1);
  });

  it("more than 200 scenarios", () => {
    const many = (count: number) => Array.from({ length: count }, (_, at) => `test "t${at}"\n  expect age visible`).join("\n");
    expectRefused({ definition: FORM_TESTS_FIXTURE, tests: many(201) }, "invalid_request", 200);
    expect(report({ definition: FORM_TESTS_CLOCK_FIXTURE, tests: many(3).replace(/age/g, "event_date").replace(/expect/g, 'given today = @"2026-01-01"\n  expect') }).summary.passed).toBe(3);
  });

  it("a scenario of more than the runner's statements", () => {
    const long = (count: number) => 'test "long"\n' + "  expect age visible\n".repeat(count);
    expectRefused({ definition: FORM_TESTS_FIXTURE, tests: long(FORM_TEST_MAX_STEPS + 1) }, "invalid_request", FORM_TEST_MAX_STEPS);
  });

  describe("a definition past a size cap (the gate check runs first)", () => {
    const select = (id: string, count: number) => ({
      id,
      type: "select",
      configuration: { options: Array.from({ length: count }, (_, at) => ({ value: `o${at}`, label: `O${at}` })) }
    });
    const tests = ['test "a"', '  set name = "Bob"', "  submit", "  expect refused"].join("\n");
    /** An instance whose plugin counts what reaches it: a function call or a validator run is a scenario that ran. */
    const counted = () => {
      const calls = { validate: 0, fn: 0 };
      const plugin = {
        id: "counter",
        version: "1",
        functions: {
          tally: () => {
            calls.fn += 1;
            return 1;
          }
        },
        validators: [
          {
            id: "count",
            version: "1",
            validate: () => {
              calls.validate += 1;
              return { valid: true, errors: [] };
            }
          }
        ]
      } as unknown as WasmPlugin;
      return { calls, instance: adapter([plugin]) };
    };
    const fields = (extra: unknown[]) => [
      { id: "name", type: "text", configuration: {} },
      { id: "t", type: "number", configuration: {}, rules: { value: "tally()" } },
      ...extra
    ];

    it("too many options on one component: invalid_request at definition, the cap as limit, nothing runs", () => {
      const { calls, instance } = counted();
      const { answer } = ask({ definition: formOf(fields([select("s", 2001)])), tests }, instance);
      expect(answer).toEqual({
        ok: false,
        error: {
          code: "invalid_request",
          where: "definition",
          limit: 2000,
          message: expect.stringContaining("option.tooMany") as unknown as string
        }
      });
      expect(calls).toEqual({ validate: 0, fn: 0 });
      // The same definition under `check` is the size gate's answer, so the two ops agree on the cap.
      const checked = JSON.parse(instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "check", definition: formOf(fields([select("s", 2001)])) })) as string);
      expect(checked).toMatchObject({ ok: true, op: "check", verdict: "fail", structure: [{ code: "option.tooMany", limit: 2000 }] });
    });

    it("more components than the cap, the definition's own entries too: refused the same way", () => {
      const { calls, instance } = counted();
      const many = Array.from({ length: 10_001 }, (_, at) => ({ id: `f${at}`, type: "text", configuration: {} }));
      const definition = { ...formOf(fields(many)), tests: { scenarios: [{ id: "a", source: tests }] } };
      const { answer } = ask({ definition }, instance);
      expect(answer).toMatchObject({ ok: false, error: { code: "invalid_request", where: "definition", limit: 10_000 } });
      expect((answer as { error: { message: string } }).error.message).toContain("definition.tooManyComponents");
      expect(calls).toEqual({ validate: 0, fn: 0 });
    });

    it("at the cap the tests run, and the plugin sees them", () => {
      const { calls, instance } = counted();
      const { answer } = ask({ definition: formOf(fields([select("s", 2000)])), tests }, instance);
      expect(answer).toMatchObject({ ok: true, op: "test", report: { summary: { total: 1 } } });
      expect(calls.validate + calls.fn).toBeGreaterThan(0);
    });

    it("the ABI, shape and depth checks still come first", () => {
      const over = formOf(fields([select("s", 2001)]));
      expect(ask({ definition: over, tests, abi: "2.17.0" }).answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
      expect(ask({ definition: { ...over, root: "no" }, tests }).answer).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("root component") as unknown as string } });
      let deep: Record<string, unknown> = select("s", 2001);
      for (let level = 0; level < 200; level += 1) {
        deep = { id: `g${level}`, type: "group", configuration: {}, children: { content: [deep] } };
      }
      expect(ask({ definition: formOf([deep]), tests }).answer).toMatchObject({ ok: false, error: { code: "definition.tooDeep" } });
    });

    it("tests that are not text over a gated definition: the gate answers first, the text is never read", () => {
      expect(ask({ definition: formOf(fields([select("s", 2001)])), tests: 42 }).answer).toMatchObject({ ok: false, error: { code: "invalid_request", where: "definition" } });
    });

    it("the size pass alone finds what the whole structure check finds for a gated definition, and nothing under the caps", () => {
      const many = Array.from({ length: 10_001 }, (_, at) => ({ id: `f${at}`, type: "text", configuration: {} }));
      const gated = [
        formOf(fields([select("s", 2001)])),
        formOf(fields([select("s", 2001), select("u", 2500)])),
        formOf(fields(many)),
        formOf(fields([select("s", 2001)]), { journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["name"] }] }] } })
      ];
      for (const definition of gated) {
        const whole = kernelStructureCheck(definition as unknown as Record<string, unknown>, undefined);
        expect(whole.sizeGate).toBe(true);
        expect(kernelInspectSizeGate(definition as unknown as Record<string, unknown>)).toEqual(whole.structure);
      }
      const under = formOf(fields([select("s", 2000), { id: "x", type: "nope", configuration: {} }]));
      expect(kernelStructureCheck(under as unknown as Record<string, unknown>, undefined).sizeGate).toBe(false);
      // A problem of another kind (an unknown type is rule 18's, a bad id the node pass's) is not the op's to refuse.
      expect(kernelInspectSizeGate(under as unknown as Record<string, unknown>)).toBeUndefined();
      expect(kernelInspectSizeGate({ ...under, root: { id: "", type: "form", configuration: {} } } as unknown as Record<string, unknown>)).toBeUndefined();
    });
  });

  it("abi_mismatch for a newer minor, a definition of no shape, an op it does not know", () => {
    expect(ask({ definition: FORM_TESTS_FIXTURE, abi: "2.17.0" }).answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    expect(ask({ definition: FORM_TESTS_FIXTURE, abi: "5.0.0" }).answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    expect(ask({ definition: FORM_TESTS_FIXTURE, abi: "4.2.0" }).answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
    expect(ask({ definition: { root: "no" } }).answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const unknown = JSON.parse(bare.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "tests", definition: FORM_TESTS_FIXTURE })) as string);
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(unknown.error.message).toContain('"test"');
  });
});

describe("the test op: determinism and the clock", () => {
  it("two calls answer the same bytes, and the definition handed in is not changed", () => {
    const definition = fixtureWithTests("main");
    const before = JSON.stringify(definition);
    const first = ask({ definition }).text;
    expect(ask({ definition }).text).toBe(first);
    expect(createInProcessWasmValidationHost().inspect).toBeDefined();
    expect(JSON.stringify(definition)).toBe(before);
  });

  it("given today runs a clock-reading form; without it the scenario is scenario.clockUnset", () => {
    const found = report({
      definition: FORM_TESTS_CLOCK_FIXTURE,
      tests: 'test "dated"\n  given today = @"2026-03-01"\n  set event_date = "2026-02-01"\n  check\n  expect refused\ntest "undated"\n  set event_date = "2026-02-01"\n  check\n  expect refused'
    });
    expect(found.scenarios.map((scenario) => [scenario.name, scenario.status, scenario.reason])).toEqual([
      ["dated", "passed", undefined],
      ["undated", "error", "scenario.clockUnset"]
    ]);
  });

  it("the host's formulaErrors word reaches the start check", () => {
    const typo = formOf([{ id: "a", type: "text", configuration: {}, rules: { visibleWhen: "nosuch(" } }]);
    (typo.root as { configuration: Record<string, unknown> }).configuration = { formulaErrors: "warn" };
    // The form's own `warn` keeps it; the host's `fail` refuses it.
    expect(report({ definition: typo, tests: 'test "t"\n  expect a visible' }).scenarios[0]?.reason).not.toBe("scenario.formulaInvalid");
    expect(report({ definition: typo, tests: 'test "t"\n  expect a visible', formulaErrors: "fail" }).scenarios[0]?.reason).toBe("scenario.formulaInvalid");
  });
});

describe("the test op: the copies the kernel carries match their originals", () => {
  const locales = ["en", "fr", "fr-CA", "FR_ca", " fr ", "de", "", "frx"];

  it("the default message tables and the engine's codes", () => {
    expect(kernelFormTestOpMessagesEn()).toEqual(DEFAULT_VALIDATION_MESSAGES);
    expect(kernelFormTestOpEngineCodes()).toEqual(ENGINE_VALIDATION_CODES.map((entry) => entry.code));
    // The definition's `texts` translations over the English, as the browser reads them.
    const translations = JSON.parse(`{
      "fr": { "texts": { "messages": { "required": { "text": "Obligatoire", "source": "x" }, "date": { "text": "", "source": "x" }, "nosuch": { "text": "Rien", "source": "x" } } } },
      "fr-CA": { "texts": { "messages": { "number": { "text": "Un nombre", "source": "x" } } } },
      "__proto__": { "texts": { "messages": { "required": { "text": "Polluted", "source": "x" } } } }
    }`) as FormTranslations;
    for (const code of [...Object.keys(DEFAULT_VALIDATION_MESSAGES), "nosuch", "constructor"]) {
      for (const locale of locales) {
        expect(kernelFormTestOpDefaultMessage(code, locale), `${code} ${locale}`).toBe(defaultValidationMessage(code, locale));
        expect(kernelFormTestOpDefaultMessage(code, locale, translations), `${code} ${locale} translated`).toBe(defaultValidationMessage(code, locale, { translations }));
      }
    }
    expect(kernelFormTestOpDefaultMessage("required", "fr-CA", translations)).toBe("Obligatoire");
    expect(kernelFormTestOpDefaultMessage("number", "fr-CA", translations)).toBe("Un nombre");
    expect(kernelFormTestOpDefaultMessage("date", "fr", translations)).toBe(DEFAULT_VALIDATION_MESSAGES.date);
  });

  it("resolveValidationMessage over layered catalogs worded through the definition's map, every precedence", () => {
    // Every message is a string in the default language; its other languages are in
    // the map, at form › messages › code on the root and components › id › messages › code (or
    // › patternMessage) below it. An old `{ default, locales }` entry is no message on either side.
    const form = {
      id: "form",
      type: "form",
      configuration: { messages: { required: "Form says required", custom: "Form custom", old: { default: "Old", locales: { fr: "Vieux" } } } },
      children: {
        content: [
          {
            id: "group",
            type: "group",
            configuration: { messages: { minLength: "Group min {minLength}", "": "blank", bad: 3 } },
            children: {
              content: [
                { id: "a", type: "text", configuration: { messages: { rule: "Rule A", "number.min": "At least {min}" }, patternMessage: "Pattern A" } },
                { id: "b", type: "text", configuration: { messages: { pattern: "", rule: "Rule B", constructor: "Built" } } }
              ]
            }
          }
        ]
      }
    } as unknown as ComponentNode;
    // Parsed, so the unsafe keys are own keys as a document read off the wire has them: each is
    // ignored, never followed and never thrown on. One entry's source is stale: it still resolves.
    const translations = JSON.parse(`{
      "fr": {
        "form": { "messages": { "required": { "text": "Le formulaire", "source": "10vl4ae" }, "custom": { "text": "", "source": "2gf2pa" } } },
        "components": {
          "group": { "messages": { "minLength": { "text": "Groupe min {minLength}", "source": "bvpdb6" } } },
          "a": {
            "messages": { "rule": { "text": "Règle", "source": "1mimshk" }, "number.min": { "text": "Au moins {min}", "source": "stale" } },
            "patternMessage": { "text": "Motif A", "source": "4g3j26" }
          },
          "b": { "messages": { "rule": { "text": "", "source": "1ncllkh" }, "constructor": { "text": "Construit", "source": "x" } } },
          "__proto__": { "messages": { "required": { "text": "Polluted", "source": "x" } } }
        }
      },
      "fr-CA": {
        "components": { "a": { "messages": { "rule": { "text": "Règle CA", "source": "1mimshk" } } } },
        "texts": { "messages": { "option.notAllowed": { "text": "Choisissez une option", "source": "x" }, "maxLength": { "text": "Au plus {maxLength}", "source": "x" }, "number.min": { "text": "Au moins {min} (moteur)", "source": "x" } } }
      },
      "__proto__": { "form": { "messages": { "required": { "text": "Polluted", "source": "x" } } } },
      "de": "not a locale"
    }`) as FormTranslations;
    const sources = { translations };
    const errors = [
      { code: "required", componentId: "a", stage: "pipeline" },
      { code: "required", componentId: "a", stage: "pipeline", message: "Server said" },
      { code: "minLength", componentId: "b", stage: "pipeline", parameters: { minLength: 3 } },
      { code: "minLength", componentId: "x", stage: "pipeline" },
      { code: "maxLength", componentId: "x", stage: "pipeline", parameters: { maxLength: 9 } },
      { code: "maxLength", componentId: "x", stage: "pipeline", message: "Too long, says the host" },
      { code: "pattern", componentId: "a", stage: "pipeline" },
      { code: "pattern", componentId: "b", stage: "pipeline" },
      { code: "rule", componentId: "a", stage: "rules" },
      { code: "rule", componentId: "b", stage: "rules" },
      { code: "number.min", componentId: "a", stage: "pipeline", parameters: { min: 18 } },
      { code: "number.min", componentId: "x", stage: "pipeline", parameters: { min: 18 } },
      { code: "number.min", componentId: "x", stage: "pipeline", message: "Raised elsewhere" },
      { code: "rows.max", componentId: "x", stage: "pipeline", parameters: { max: "two", count: { n: 3 } } },
      { code: "custom", componentId: "a", stage: "custom" },
      { code: "custom2", componentId: "a", stage: "custom", message: "Plugin {thing}", parameters: { thing: "says" } },
      { code: "custom3", componentId: "a", stage: "custom" },
      { code: "constructor", componentId: "b", stage: "custom" },
      { code: "old", componentId: "a", stage: "custom" },
      { code: "option.notAllowed", componentId: "a", stage: "pipeline" }
    ];
    for (const locale of locales) {
      const catalogs = kernelFormTestOpCatalogs(form, locale, translations);
      const expected = new Map<string, ReturnType<typeof readValidationMessages>>();
      const walk = (node: ComponentNode, inherited: ReturnType<typeof readValidationMessages>) => {
        const own = readValidationMessages(node.configuration, { ownerId: node === form ? undefined : node.id, locale, sources });
        const layered = layerValidationMessages(own, inherited);
        expected.set(node.id, layered);
        for (const children of Object.values(node.children ?? {})) {
          for (const child of children) {
            walk(child, layered);
          }
        }
      };
      walk(form, undefined);
      for (const [id, catalog] of expected) {
        expect(catalogs[id] === undefined ? undefined : { ...catalogs[id] }, `${id} ${locale}`).toEqual(catalog);
      }
      for (const error of errors) {
        const catalog = (error.componentId !== undefined ? expected.get(error.componentId) : undefined) ?? readValidationMessages(form.configuration, { locale, sources });
        const owned = catalogs[error.componentId];
        expect(
          kernelFormTestOpMessage(error as never, owned !== undefined ? owned : catalogs.form, locale, translations),
          `${error.code} ${error.message ?? ""} ${locale}`
        ).toBe(resolveValidationMessage(error, catalog, locale, sources));
      }
    }
    // The words the map gives, spelled out: a dotted code, a primary subtag serving a region, the
    // region's own beating it, an empty text and an unsafe code falling through to the default.
    const fr = kernelFormTestOpCatalogs(form, "fr-CA", translations);
    expect(kernelFormTestOpMessage({ code: "number.min", componentId: "a", stage: "pipeline", parameters: { min: 18 } } as never, fr.a, "fr-CA")).toBe("Au moins 18");
    expect(kernelFormTestOpMessage({ code: "required", componentId: "a", stage: "pipeline" } as never, fr.a, "fr-CA")).toBe("Le formulaire");
    expect(kernelFormTestOpMessage({ code: "rule", componentId: "a", stage: "rules" } as never, fr.a, "fr-CA")).toBe("Règle CA");
    expect(kernelFormTestOpMessage({ code: "pattern", componentId: "a", stage: "pipeline" } as never, fr.a, "fr-CA")).toBe("Motif A");
    expect(kernelFormTestOpMessage({ code: "rule", componentId: "b", stage: "rules" } as never, fr.b, "fr-CA")).toBe("Rule B");
    expect(kernelFormTestOpMessage({ code: "constructor", componentId: "b", stage: "custom" } as never, fr.b, "fr-CA")).toBe("Built");
    expect(kernelFormTestOpMessage({ code: "old", componentId: "a", stage: "custom" } as never, fr.a, "fr-CA")).toBe("old");
    // The engine's own sentence from the `texts` translations, under every authored message.
    expect(kernelFormTestOpMessage({ code: "option.notAllowed", componentId: "a", stage: "pipeline" } as never, fr.a, "fr-CA", translations)).toBe("Choisissez une option");
    expect(kernelFormTestOpMessage({ code: "maxLength", componentId: "x", stage: "pipeline", parameters: { maxLength: 9 } } as never, undefined, "fr-CA", translations)).toBe("Au plus 9");
    expect(kernelFormTestOpMessage({ code: "number.min", componentId: "a", stage: "pipeline", parameters: { min: 18 } } as never, fr.a, "fr-CA", translations)).toBe("Au moins 18");
  });

  it("a layout is usable where validatePdfLayout finds nothing wrong with its kind, root, template, fields and areas", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    const layouts: unknown[] = [
      null,
      "x",
      { id: "", kind: "generated", root: { id: "d", type: "pdf-document" } },
      { id: "  ", kind: "generated", root: { id: "d", type: "pdf-document" } },
      { id: "g", kind: "generated", root: { id: "d", type: "pdf-document" } },
      { id: "g", kind: "generated", root: { id: "d", type: "text" } },
      { id: "g", kind: "generated", root: { id: 1, type: "pdf-document" } },
      { id: "g", kind: "generated", root: { id: "d", type: "pdf-document" }, renditionDefaults: [] },
      { id: "g", kind: "generated", root: { id: "d", type: "pdf-document" }, renditionDefaults: { text: "plain" } },
      { id: "g", kind: "other" },
      { id: "t", kind: "template", template: { storage: "base64", data: "AA==" }, fields: [] },
      { id: "t", kind: "template", template: { storage: "base64" }, fields: [] },
      { id: "t", kind: "template", template: { storage: "" }, fields: [] },
      { id: "t", kind: "template", template: { storage: "url" } },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [{ pdfField: "", source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [{ pdfField: "A", source: { kind: 1 } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [{ pdfField: "A", source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: {} },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect, source: { kind: "answer" } }, { id: "a", page: 1, rect, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 0, rect, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1.5, rect, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect: { ...rect, width: 0 }, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect: { ...rect, x: Infinity }, source: { kind: "answer" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect, source: { kind: "answer" }, field: "x" }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect, source: { kind: "answer" }, field: { name: "a..b" } }] },
      { id: "t", kind: "template", template: { storage: "url" }, fields: [], areas: [{ id: "a", page: 1, rect, source: { kind: "answer" }, field: { name: "ok" } }] }
    ];
    for (const layout of layouts) {
      expect(kernelFormTestOpLayoutUsable(layout), JSON.stringify(layout)).toBe(validatePdfLayout(layout).length === 0);
    }
  });

  it("a layout condition is evaluable where isEvaluableExpression says so, a plugin's call masked", () => {
    const signatures = [...formulaFunctionSignatures(), { name: "double", min: 0, max: Number.POSITIVE_INFINITY }];
    const builtins = [...FORMULA_FUNCTION_NAMES];
    for (const formula of ["a = 1", "not(a)", 'if a then "x" else "y"', "double(a) > 2", "double(nosuch_a) > 2", "upper(a) = \"X\"", "a + 1 > b", "a and (b or c)"]) {
      const expression = kernelRuleExpression(formula, kernelParseFormula, signatures);
      expect(expression, formula).toBeDefined();
      expect(kernelFormTestOpEvaluable(expression, builtins, ["double"]), formula).toBe(true);
      expect(kernelFormTestOpEvaluable(expression, builtins, []), formula).toBe(isEvaluableExpression(expression));
    }
    for (const shape of [null, { kind: "literal", value: {} }, { kind: "path", path: "" }, { kind: "unary", operator: "minus", operand: { kind: "literal", value: 1 } }, { kind: "binary", operator: "in", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 1 } }, { kind: "if", cases: [null] }, { kind: "call", name: "nosuch", args: [] }, { kind: "other" }]) {
      expect(kernelFormTestOpEvaluable(shape, builtins, []), JSON.stringify(shape)).toBe(isEvaluableExpression(shape));
    }
  });

  it("the op's functions are spliced, each declared once", () => {
    const names = PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name);
    expect(names).toEqual(expect.arrayContaining(["kernelFormTestOp", "kernelFormTestOpScenario", "kernelFormTestServerIndex", "kernelParseFormTests", "kernelFormTestJudge"]));
    expect(new Set(names).size).toBe(names.length);
  });
});
