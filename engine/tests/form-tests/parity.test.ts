import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../../form-engine/core/form-tests/form-test-run.js";
import type {
  FormTestScenario,
  FormTestScenarioResult,
  FormTestStepResult
} from "../../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import {
  createFormTestRuntimeDriver,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "../../form-engine/runtime/browser/form-test-runtime-driver.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import { createFormTestKernelDriver } from "../../form-engine/validation/wasm/form-test-kernel-driver.js";
import {
  FORM_TESTS_CLOCK_FIXTURE,
  FORM_TESTS_FIXTURE,
  FORM_TESTS_FIXTURE_SCENARIOS,
  type FormTestsFixtureScenario
} from "./fixtures/form-tests-fixture.js";

// Parity between the two drivers of form tests: the browser runtime's
// and the validation kernel's read one scenario text and must come to the same verdict on every
// step. The design exists to catch the day they do not, so this test plays the shared fixture
// corpus on both and compares step by step. The only differences allowed are the known ones,
// each listed below with its reason; anything else is a finding, never a row to add to
// the table.

const makeRuntime: FormTestRuntimeFactory = (definition: FormDefinition, givens: FormTestRuntimeGivens) => {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...givens
  });
};

const kernelHost = createInProcessWasmValidationHost();

function scenarioOf(source: string): FormTestScenario {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  expect(parsed.scenarios).toHaveLength(1);
  return parsed.scenarios[0]!;
}

interface Pair {
  browser: FormTestScenarioResult;
  kernel: FormTestScenarioResult;
}

/** One scenario text played on a driver of each side, over the same form. */
async function runBoth(definition: FormDefinition, source: string): Promise<Pair> {
  const scenario = scenarioOf(source);
  const [browser] = await runFormTestScenarios([scenario], () => createFormTestRuntimeDriver(definition, { makeRuntime }));
  const [kernel] = await runFormTestScenarios([scenario], () => createFormTestKernelDriver(definition, { host: kernelHost }));
  return { browser: browser!, kernel: kernel! };
}

function formOf(entry: FormTestsFixtureScenario): FormDefinition {
  return entry.form === "main" ? FORM_TESTS_FIXTURE : FORM_TESTS_CLOCK_FIXTURE;
}

/**
 * The differences allowed, by scenario name. `lines` are the source lines (1 is the
 * `test` header) on which the two sides may differ; every other line must agree. `browser` and
 * `kernel` say what the scenario as a whole comes to on each side, and `why` is the reason.
 */
interface AllowedDifference {
  why: string;
  browser: { status: FormTestScenarioResult["status"]; reason?: string };
  kernel: { status: FormTestScenarioResult["status"]; reason?: string };
  lines: number[];
}

const ALLOWED: Record<string, AllowedDifference> = {
  // A component with a `host.` rule and no `host.` given has no entry here: the browser reads an
  // empty host and judges, the kernel runs with no host context and skips every expectation on
  // the component (`unreplayable.host`, kernel-driver.test.ts and sandbox-test-op.test.ts play it).
  // With a given (the role note's two scenarios) the givens are the kernel's host context too
  // and the two sides agree.
  // A `run: "server"` rule: the kernel is the server and applies it, the browser never runs it
  // and skips the expectation on the component.
  "a server-only check is not the browser's to judge": {
    why: 'run: "server" rule: kernel judges, browser skips unreplayable.server',
    browser: { status: "skipped", reason: "unreplayable.server" },
    kernel: { status: "passed" },
    lines: [5]
  },
  // The missing day is not here: a clock-reading form with no `given today` is a start error on
  // both sides, and the two agree on it.
};

function statusOf(step: FormTestStepResult | undefined): string {
  return step === undefined ? "(none)" : step.status;
}

function cell(step: FormTestStepResult | undefined): string {
  if (step === undefined) return "(none)";
  const parts: string[] = [step.status];
  if (step.code !== undefined) parts.push(step.code);
  if (step.actual !== undefined) parts.push(`actual=${JSON.stringify(step.actual)}`);
  return parts.join(" ");
}

/** A compact table of the lines where the two sides disagree, for the assertion message. */
function diffTable(name: string, pair: Pair): string {
  const lines = new Set<number>([...pair.browser.steps.map((step) => step.line), ...pair.kernel.steps.map((step) => step.line)]);
  const rows: string[] = [`scenario "${name}" (browser ${pair.browser.status} ${pair.browser.reason ?? ""}, kernel ${pair.kernel.status} ${pair.kernel.reason ?? ""})`];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const browser = pair.browser.steps.find((step) => step.line === line);
    const kernel = pair.kernel.steps.find((step) => step.line === line);
    if (statusOf(browser) === statusOf(kernel) && browser?.code === kernel?.code) continue;
    rows.push(`  line ${line}: browser [${cell(browser)}] | kernel [${cell(kernel)}]`);
  }
  return rows.join("\n");
}

/** The lines on which the sides' step status or code differ. */
function differingLines(pair: Pair): number[] {
  const lines = new Set<number>([...pair.browser.steps.map((step) => step.line), ...pair.kernel.steps.map((step) => step.line)]);
  const out: number[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const browser = pair.browser.steps.find((step) => step.line === line);
    const kernel = pair.kernel.steps.find((step) => step.line === line);
    // A skipped step on one side carries its unreplayable code; a pass carries none. The status
    // must agree always; the code and the actual value where both sides failed or errored.
    if (statusOf(browser) !== statusOf(kernel)) {
      out.push(line);
    } else if (
      (browser?.status === "failed" || browser?.status === "error") &&
      (browser.code !== kernel?.code || JSON.stringify(browser.actual) !== JSON.stringify(kernel?.actual))
    ) {
      // Two sides that both fail must fail the same way: the same code and the same actual, so a
      // diagnosis in the builder never depends on which side ran.
      out.push(line);
    }
  }
  return out;
}

/**
 * Scenarios the two sides disagree on beyond the table. Each is a recorded disagreement;
 * its test is `it.fails` until the disagreement is resolved, so a fix flips it red and the entry
 * gets removed.
 */
const FINDINGS: Record<string, string> = {
  // No finding stands: the judge compares a list literal
  // with a flags record as the set of its true keys, and the kernel driver stores one boolean per
  // option as the runtime does, so the two probes on a group agree.
};

describe("the two drivers agree on the fixture corpus", () => {
  for (const entry of FORM_TESTS_FIXTURE_SCENARIOS) {
    const finding = FINDINGS[entry.name];
    const run = finding === undefined ? it : it.fails;
    run(`${entry.name}${finding === undefined ? "" : ` [${finding}]`}`, async () => {
      const pair = await runBoth(formOf(entry), entry.source);
      const allowed = ALLOWED[entry.name];
      const differing = differingLines(pair);
      const message = diffTable(entry.name, pair);

      // The fixture's own word on the kernel side is checked here, the one place the corpus is
      // played on the kernel driver: the runtime side is checked by runtime-driver.test.ts.
      expect(pair.kernel.status, `${message}\n(fixture expects kernel ${entry.expected.kernel})`).toBe(entry.expected.kernel);
      expect(pair.kernel.reason, message).toBe(entry.reason?.kernel);

      if (allowed === undefined) {
        // No difference is allowed: every step agrees and so does the scenario as a whole.
        expect(differing, message).toEqual([]);
        expect(pair.browser.status, message).toBe(pair.kernel.status);
        expect(pair.browser.reason, message).toBe(pair.kernel.reason);
        return;
      }
      expect(differing, `${message}\n(allowed: ${allowed.why})`).toEqual(allowed.lines);
      expect({ status: pair.browser.status, reason: pair.browser.reason }, message).toEqual({
        status: allowed.browser.status,
        reason: allowed.browser.reason
      });
      expect({ status: pair.kernel.status, reason: pair.kernel.reason }, message).toEqual({
        status: allowed.kernel.status,
        reason: allowed.kernel.reason
      });
    });
  }

  it("the table and the findings name only scenarios that exist", () => {
    const names = new Set([...FORM_TESTS_FIXTURE_SCENARIOS.map((entry) => entry.name), ...PROBES.map((probe) => probe.name)]);
    for (const name of [...Object.keys(ALLOWED), ...Object.keys(FINDINGS), ...Object.keys(PROBE_STATUS)]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

// Scenarios of this file's own, aimed where the two readings are likeliest to drift: lists on a
// checkbox group, the submitted record, the engine's wording, moves off the frontier, a reroute,
// the last page and rows in the submission. They play on the fixture form like the corpus and
// follow the same rule: no difference is allowed unless the table above names it.
const PROBES: Array<{ name: string; lines: string[] }> = [
  {
    name: "a checkbox group read back as a list",
    lines: ["given journey = none", 'set topics = ("news", "events")', 'expect topics = ("news", "events")']
  },
  {
    name: "a checkbox group in the submitted record",
    lines: [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      'set topics = ("news")',
      "submit",
      "expect accepted",
      'expect submitted topics = ("news")'
    ]
  },
  {
    name: "the engine's wording of a missing answer, in both locales",
    lines: [
      "given journey = none",
      "check",
      "expect refused",
      "expect error on applicant_name: required",
      "expect message on applicant_name = \"This field is required\""
    ]
  },
  {
    name: "a message in French",
    lines: [
      "given journey = none",
      'given locale = "fr"',
      "check",
      "expect error on applicant_name: required",
      "expect message on applicant_name = \"Ce champ est obligatoire\""
    ]
  },
  {
    name: "an age above the maximum",
    lines: ["given journey = none", "set age = 121", "check", "expect error on age: number.max", "set age = 120", "check", "expect no error on age"]
  },
  {
    name: "rows reach the submitted record",
    lines: [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      "add row to items with qty = 3",
      "submit",
      "expect accepted",
      "expect submitted items[0].qty = 3"
    ]
  },
  {
    name: "a reroute after the exit code is changed",
    lines: [
      'set applicant_name = "Ada"',
      "set age = 30",
      "continue",
      'set stop_code = "STOP"',
      "continue",
      "expect page = stop",
      'set stop_code = "OK"',
      // The page left the path, so the journey lands on the last page before it in journey order.
      "expect page = review",
      "expect review on path"
    ]
  },
  {
    name: "continue on the last page stays and the path ends",
    lines: [
      'set applicant_name = "Ada"',
      "set age = 30",
      "continue",
      "continue",
      "expect page = review",
      "continue",
      "expect page = review",
      "expect path ends"
    ]
  },
  {
    name: "a jump past the frontier does not move",
    lines: ["go to review", "expect page = intro"]
  },
  {
    name: "a page check refuses on its own page only",
    lines: ["check", "expect refused", "expect error on applicant_name: required", "expect no error on email"]
  },
  {
    name: "a whole submit with the journey refuses a missing name",
    lines: ["submit", "expect refused", "expect error on applicant_name: required"]
  },
  {
    name: "a hidden answer on an off-path page is withheld and not submitted",
    lines: [
      'set applicant_name = "Ada"',
      "set age = 30",
      "set wants_details = true",
      'set topics = ("news")',
      "set wants_details = false",
      "submit",
      "expect accepted",
      "expect topics withheld"
    ]
  },
  {
    name: "an unknown field fails on both sides",
    lines: ["expect nowhere visible"]
  },
  {
    name: "a calculation follows its inputs",
    lines: ["given journey = none", "expect age_next_year empty", "set age = 40", "expect age_next_year = 41", "expect age_next_year not empty"]
  },
  {
    name: "the calculation is in the submitted record",
    lines: [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      "submit",
      "expect accepted",
      "expect submitted age_next_year = 31"
    ]
  },
  {
    name: "the engine's wording of an age below the minimum",
    lines: ["given journey = none", "set age = 5", "check", 'expect message on age = "Enter a number of 18 or more"']
  },
  {
    name: "a rule makes the email required, and the submit refuses until it is given",
    lines: [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      "expect email optional",
      'set contact_method = "email"',
      "expect email required",
      "submit",
      "expect refused",
      "expect error on email: required",
      'set email = "a@example.com"',
      'set confirm_email = "a@example.com"',
      "submit",
      "expect accepted"
    ]
  },
  {
    name: "go to a page behind the frontier once it was visited",
    lines: [
      'set applicant_name = "Ada"',
      "set age = 30",
      "continue",
      "go to intro",
      "expect page = intro",
      "go to contact",
      "expect page = contact",
      "go to review",
      "expect page = contact"
    ]
  },
  {
    name: "back from the first page stays",
    lines: ["back", "expect page = intro"]
  },
  {
    name: "a row removed past the end fails the same way",
    lines: ["given journey = none", "add row to items", "remove row 3 of items"]
  },
  {
    name: "a required answer given then cleared",
    lines: ["given journey = none", 'set applicant_name = "Ada"', "check", "expect no error on applicant_name", "set applicant_name = \"\"", "check", "expect error on applicant_name: required"]
  },
  {
    // The browser's check runs the sandbox too (`FormRuntime.checkValues`), so an answer
    // outside the options a source was given is refused by a check on both sides, not only at submit.
    name: "a check refuses an answer outside the given options",
    lines: [
      "given journey = none",
      'given options for province = ("ON", "QC")',
      'set applicant_name = "Ada"',
      "set age = 30",
      'set province = "XX"',
      "check",
      "expect refused",
      // The sandbox's own error is on show after the check, on both sides, and gone after
      // the next check that has none.
      "expect error on province: option.notAllowed",
      'set province = "QC"',
      "check",
      "expect accepted",
      "expect no error on province"
    ]
  },
  {
    name: "Continue stays on a page holding an answer outside the given options",
    lines: [
      'given options for province = ("ON", "QC")',
      'set applicant_name = "Ada"',
      "set age = 30",
      "continue",
      'set province = "XX"',
      "continue",
      "expect page = contact",
      "expect error on province: option.notAllowed",
      'set province = "ON"',
      "continue",
      "expect page = review",
      "expect no error on province"
    ]
  },
  {
    // A hidden answer that is kept is still held to its kind: a text field holding
    // a number is refused on the sandbox's `text` error, which the browser's hidden policy keeps
    // as it keeps the kernel's own.
    name: "a hidden, retained text holding a number is refused with text on both sides",
    lines: [
      "given journey = none",
      'set applicant_name = "Ada"',
      "set age = 30",
      "set has_pet = true",
      "set pet_name = 5",
      "set has_pet = false",
      "expect pet_name hidden",
      "submit",
      "expect refused",
      "expect error on pet_name: text"
    ]
  },
  {
    // A row field named without its index is no field of the form.
    name: "a row field's bare key is an unknown field on both sides",
    lines: [
      "given journey = none",
      'set applicant_name = "A"',
      "set age = 30",
      'add row to items with qty = "abc"',
      "submit",
      "expect refused",
      "expect error on items[0].qty: number",
      "expect no error on qty"
    ]
  }
];

// What each probe is meant to come to on both sides. Two sides that fail alike agree, so
// agreement alone would let a bug both share (a wrong verdict on a row, say) pass this suite:
// each probe says what it should come to, and `passed` is the default.
const PROBE_STATUS: Record<string, FormTestScenarioResult["status"]> = {
  "an unknown field fails on both sides": "failed",
  "a row field's bare key is an unknown field on both sides": "failed",
  "a row removed past the end fails the same way": "error"
};

describe("probes aimed at the likely drifts between the drivers", () => {
  for (const probe of PROBES) {
    const finding = FINDINGS[probe.name];
    const run = finding === undefined ? it : it.fails;
    run(`${probe.name}${finding === undefined ? "" : ` [${finding}]`}`, async () => {
      const source = [`test "${probe.name}"`, ...probe.lines.map((line) => `  ${line}`)].join("\n");
      const pair = await runBoth(FORM_TESTS_FIXTURE, source);
      const message = `${diffTable(probe.name, pair)}\n${JSON.stringify(pair)}`;
      expect(differingLines(pair), message).toEqual([]);
      expect(pair.browser.status, message).toBe(pair.kernel.status);
      expect(pair.browser.reason, message).toBe(pair.kernel.reason);
      const meant = PROBE_STATUS[probe.name] ?? "passed";
      expect(pair.browser.status, message).toBe(meant);
      expect(pair.kernel.status, message).toBe(meant);
    });
  }
});

// A calculation that divides by an empty answer comes out as NaN in the formula engine; the
// settled view reads it as null, the same on the server, so `expect ratio = null`
// holds on both sides and a number never reads as NaN.
const RATIO_FORM = {
  id: "ratio-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "total", type: "number", configuration: { label: "Total" } },
        { id: "count", type: "number", configuration: { label: "Count" } },
        { id: "ratio", type: "number", configuration: { label: "Ratio" }, rules: { value: "total / count" } }
      ]
    }
  }
} as unknown as FormDefinition;

describe("a calculation dividing by an empty answer reads null on both sides", () => {
  it("expect ratio = null passes on both, as a value check and as a formula", async () => {
    const pair = await runBoth(
      RATIO_FORM,
      [
        'test "no count"',
        "  set total = 10",
        "  expect ratio = null",
        "  expect ratio = null and total = 10"
      ].join("\n")
    );
    expect(pair.browser.steps.map((step) => step.status), JSON.stringify(pair.browser)).toEqual(["ran", "passed", "passed"]);
    expect(pair.kernel.steps.map((step) => step.status), JSON.stringify(pair.kernel)).toEqual(["ran", "passed", "passed"]);
    expect(pair.browser.status).toBe("passed");
    expect(pair.kernel.status).toBe("passed");
  });

  it("once the count is given the ratio is a number on both sides", async () => {
    const pair = await runBoth(
      RATIO_FORM,
      ['test "with a count"', "  set total = 10", "  set count = 4", "  expect ratio = 2.5", "  expect ratio != null"].join("\n")
    );
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel.status, JSON.stringify(pair.kernel)).toBe("passed");
  });

  it("a value that is not null fails on both sides, so the pass above is not empty", async () => {
    const pair = await runBoth(RATIO_FORM, ['test "wrong"', "  set total = 10", "  expect ratio = 0"].join("\n"));
    expect(pair.browser.status).toBe("failed");
    expect(pair.kernel.status).toBe("failed");
  });
});

// The two skip reasons the kernel driver has: a rule the form
// runs only in the browser, and a calculation the server keeps as sent. The browser's driver
// judges both; the kernel's skips the expectation on them with a reason of its own.
const REASONS_FORM = {
  id: "reasons-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "base", type: "number", configuration: { label: "Base" } },
        { id: "flag", type: "checkbox", configuration: { label: "Flag" } },
        {
          id: "maybe",
          type: "number",
          configuration: { label: "Maybe", hiddenValueBehavior: "exclude-from-submission" },
          rules: { visibleWhen: "flag = true" }
        },
        { id: "doubled", type: "number", configuration: { label: "Doubled" }, rules: { value: "maybe * 2" } },
        { id: "browser_note", type: "text", configuration: { label: "Note" }, rules: { visibleWhen: { formula: "base = 1", run: "browser" } } }
      ]
    }
  }
} as unknown as FormDefinition;

describe("the browser-only and client-derived skip reasons", () => {
  it("a browser-scoped rule: the browser judges it, the kernel skips with unreplayable.browser", async () => {
    const pair = await runBoth(REASONS_FORM, ['test "browser rule"', "  given journey = none", "  set base = 1", "  expect browser_note visible"].join("\n"));
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel).toMatchObject({ status: "skipped", reason: "unreplayable.browser" });
    expect(differingLines(pair)).toEqual([4]);
  });

  it("a calculation kept as sent: the browser works it out, the kernel skips with unreplayable.clientDerived", async () => {
    const pair = await runBoth(
      REASONS_FORM,
      ['test "derived"', "  given journey = none", "  set doubled = 10", "  submit", "  expect doubled = null"].join("\n")
    );
    expect(pair.browser.status, JSON.stringify(pair.browser)).toBe("passed");
    expect(pair.kernel).toMatchObject({ status: "skipped", reason: "unreplayable.clientDerived" });
    expect(differingLines(pair)).toEqual([5]);
  });
});

// A hidden answer that is still submitted (the default `retain`) is held to its format alone:
// its kind, length and pattern, never a bound. The browser's hidden policy drops a
// `number.max`; the kernel's shape-only reading must drop it too, or a server would refuse what the
// browser accepts. `check` and `submit` agree on both sides.
// Each hideable field retains its answer explicitly: the hidden default leaves it out, and these probes are
// about the format checks on a hidden answer the form still submits.
const HIDDEN_FORM = {
  id: "hidden-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "show", type: "checkbox", configuration: { label: "Show" } },
        { id: "b", type: "number", configuration: { label: "B", max: 10, hiddenValueBehavior: "retain" }, rules: { visibleWhen: "show = true" } },
        { id: "code", type: "text", configuration: { label: "Code", maxLength: 3, hiddenValueBehavior: "retain" }, rules: { visibleWhen: "show = true" } },
        { id: "doc", type: "file", configuration: { label: "Doc", hiddenValueBehavior: "retain" }, rules: { visibleWhen: "show = true" } }
      ]
    }
  }
} as unknown as FormDefinition;

describe("a hidden, retained answer is held to its format only, on both sides", () => {
  const scenarios: Array<{ name: string; lines: string[]; meant: FormTestScenarioResult["status"] }> = [
    {
      name: "a hidden number above its maximum is accepted by check and submit",
      lines: [
        "set show = true",
        "set b = 50",
        "set show = false",
        "expect b hidden",
        "check",
        "expect accepted",
        "expect no error on b",
        "submit",
        "expect accepted",
        "expect submitted b = 50"
      ],
      meant: "passed"
    },
    {
      name: "the same number shown is refused by check and submit",
      lines: ["set show = true", "set b = 50", "check", "expect refused", "expect error on b: number.max", "submit", "expect refused", "expect error on b: number.max"],
      meant: "passed"
    },
    {
      name: "a hidden number that is not one is still refused with number",
      lines: [
        "set show = true",
        'set b = "abc"',
        "set show = false",
        "check",
        "expect refused",
        "expect error on b: number",
        "submit",
        "expect refused",
        "expect error on b: number"
      ],
      meant: "passed"
    },
    {
      name: "a hidden text past its length is still refused with maxLength",
      lines: [
        "set show = true",
        'set code = "ABCDEF"',
        "set show = false",
        "check",
        "expect refused",
        "expect error on code: maxLength",
        "submit",
        "expect refused",
        "expect error on code: maxLength"
      ],
      meant: "passed"
    },
    {
      // The kernel's kind checks for a hidden, retained answer reach the browser's too.
      name: "a hidden text holding a number is still refused with text",
      lines: ["set show = true", "set code = 5", "set show = false", "check", "expect refused", "expect error on code: text", "submit", "expect refused", "expect error on code: text"],
      meant: "passed"
    },
    {
      name: "a hidden file field holding junk is still refused with file",
      lines: ["set show = true", 'set doc = "junk"', "set show = false", "check", "expect refused", "expect error on doc: file", "submit", "expect refused", "expect error on doc: file"],
      meant: "passed"
    }
  ];
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const source = [`test "${scenario.name}"`, ...scenario.lines.map((line) => `  ${line}`)].join("\n");
      const pair = await runBoth(HIDDEN_FORM, source);
      const message = `${diffTable(scenario.name, pair)}\n${JSON.stringify(pair)}`;
      expect(differingLines(pair), message).toEqual([]);
      expect(pair.browser.status, message).toBe(scenario.meant);
      expect(pair.kernel.status, message).toBe(scenario.meant);
    });
  }
});

// Coded refusals, start errors and the stricter expectations. Each probe must come to the same
// steps on both sides, code and params included, not only the same statuses: the words of a report are made from them.
describe("coded refusals, start errors and unknown names agree on both sides", () => {
  const probes: Array<{ name: string; lines: string[]; status: FormTestScenarioResult["status"]; reason?: string }> = [
    { name: "a row removed past the end is refused with its reason", lines: ["given journey = none", "add row to items", "remove row 3 of items"], status: "error" },
    { name: "a row added to a field is refused as no collection", lines: ["given journey = none", "add row to applicant_name"], status: "error" },
    { name: "a page the journey lacks is unknown, not off the path", lines: ["expect details off path", "expect detailz off path"], status: "failed" },
    { name: "a row past the count is unknown, not empty", lines: ["given journey = none", "add row to items with qty = 2", "expect items[0].qty = 2", "expect items[1].qty empty"], status: "failed" },
    { name: "a formula over a missing field fails", lines: ["given journey = none", "set age = 30", "expect age > 18 and nosuchfield = null"], status: "failed" },
    { name: "TRUE is the literal on a checkbox", lines: ["given journey = none", "set wants_details = true", "expect wants_details = TRUE"], status: "passed" },
    { name: "the first bad given wins, journey first", lines: ["given journey = elsewhere", 'given options for applicant_name = ("a")'], status: "error", reason: "scenario.unknownJourney" },
    { name: "the first bad given wins, options first", lines: ['given options for applicant_name = ("a")', "given journey = elsewhere"], status: "error", reason: "scenario.badGiven" }
  ];
  for (const probe of probes) {
    it(probe.name, async () => {
      const source = [`test "${probe.name}"`, ...probe.lines.map((line) => `  ${line}`)].join("\n");
      const pair = await runBoth(FORM_TESTS_FIXTURE, source);
      const message = `${diffTable(probe.name, pair)}\n${JSON.stringify(pair)}`;
      expect(pair.kernel.steps, message).toEqual(pair.browser.steps);
      expect(pair.kernel.params, message).toEqual(pair.browser.params);
      expect(pair.browser.status, message).toBe(probe.status);
      expect(pair.kernel.status, message).toBe(probe.status);
      expect(pair.kernel.reason, message).toBe(pair.browser.reason);
      if (probe.reason !== undefined) {
        expect(pair.browser.reason, message).toBe(probe.reason);
      }
    });
  }

  it("a refused row removal carries the same reason on both sides", async () => {
    const pair = await runBoth(FORM_TESTS_FIXTURE, ['test "r"', "  given journey = none", "  add row to items", "  remove row 3 of items"].join("\n"));
    expect(pair.browser.steps.at(-1)).toEqual({
      line: 4,
      status: "error",
      code: "action.refused",
      params: { action: "removeRow", reason: "rowOutOfRange", path: "items", index: 3, count: 1 }
    });
    expect(pair.kernel.steps.at(-1)).toEqual(pair.browser.steps.at(-1));
  });

  it("a definition whose formulas do not compile ends at start on both sides, with the same problems", async () => {
    const broken = {
      ...FORM_TESTS_FIXTURE,
      root: {
        ...FORM_TESTS_FIXTURE.root,
        children: {
          content: [
            ...(FORM_TESTS_FIXTURE.root.children?.content ?? []),
            { id: "broken_calc", type: "number", configuration: { label: "Broken" }, rules: { value: "nosuch(age)" } }
          ]
        }
      }
    } as unknown as FormDefinition;
    const pair = await runBoth(broken, ['test "broken"', "  given journey = none", "  expect age empty"].join("\n"));
    for (const result of [pair.browser, pair.kernel]) {
      expect(result).toMatchObject({ status: "error", reason: "scenario.formulaInvalid", steps: [] });
    }
    expect(pair.kernel.params).toEqual(pair.browser.params);
    expect((pair.browser.params as { problems: Array<{ where: string }> }).problems[0]?.where).toBe("rules:broken_calc:value");
  });
});

// A data grid whose maximum is a formula. The browser's add reads the resolved
// bound (`dataGridRowBounds`), and the kernel driver resolves the grid's `rules.maxRows` over the
// current answers as `checkRows` does, so the refusal lands on the same add on both sides.
const FORMULA_GRID_FORM = {
  id: "formula-grid-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "limit", type: "number", configuration: { label: "Limit" } },
        {
          id: "lines",
          type: "dataGrid",
          configuration: { label: "Lines", initialRows: 0 },
          rules: { maxRows: "limit" },
          collection: { collectionPath: "lines" },
          children: { content: [{ id: "amt", type: "number", configuration: { label: "Amount" } }] }
        },
        {
          id: "fixed",
          type: "dataGrid",
          configuration: { label: "Fixed", initialRows: 0 },
          rules: { maxRows: "1" },
          collection: { collectionPath: "fixed" },
          children: { content: [{ id: "amt2", type: "number", configuration: { label: "Amount" } }] }
        }
      ]
    }
  }
} as unknown as FormDefinition;

describe("a grid whose maximum is a formula refuses the same add on both sides", () => {
  it("a constant formula bound", async () => {
    const pair = await runBoth(FORMULA_GRID_FORM, ['test "fixed"', "  given journey = none", "  add row to fixed", "  add row to fixed", "  expect rows of fixed = 2"].join("\n"));
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
    expect(pair.browser.status, JSON.stringify(pair)).toBe("error");
    expect(pair.browser.steps.at(-1)).toEqual({
      line: 4,
      status: "error",
      code: "action.refused",
      params: { action: "addRow", reason: "rows.max", path: "fixed", max: 1 }
    });
    expect(pair.kernel.status).toBe("error");
  });

  it("a bound that follows an answer", async () => {
    const pair = await runBoth(
      FORMULA_GRID_FORM,
      ['test "follows"', "  given journey = none", "  set limit = 2", "  add row to lines", "  add row to lines", "  add row to lines"].join("\n")
    );
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
    expect(pair.browser.steps.map((step) => step.status)).toEqual(["ran", "ran", "ran", "error"]);
    expect(pair.browser.steps.at(-1)).toMatchObject({ code: "action.refused", params: { reason: "rows.max", max: 2 } });
  });

  it("a bound that moves with the answer lets the next add in", async () => {
    const pair = await runBoth(
      FORMULA_GRID_FORM,
      ['test "moves"', "  given journey = none", "  set limit = 1", "  add row to lines", "  set limit = 2", "  add row to lines", "  expect rows of lines = 2"].join("\n")
    );
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
    expect(pair.browser.status, JSON.stringify(pair)).toBe("passed");
    expect(pair.kernel.status, JSON.stringify(pair)).toBe("passed");
  });
});

describe("the canonical translations fixture: both drivers word a message from the map alike", () => {
  const intake = JSON.parse(readFileSync(new URL("../fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;
  const cases: Array<[string, string]> = [
    ["en", "Enter your full name."],
    ["fr-CA", "Entrez votre nom complet."],
    // The map has no Spanish words for the message: the default.
    ["es", "Enter your full name."]
  ];

  for (const [locale, expected] of cases) {
    it(`required on fullName in ${locale}`, async () => {
      const pair = await runBoth(
        intake,
        [`test "required in ${locale}"`, `  given locale = "${locale}"`, "  check", "  expect error on fullName: required", `  expect message on fullName = "${expected}"`].join("\n")
      );
      expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
      expect(pair.browser.status, JSON.stringify(pair)).toBe("passed");
      expect(pair.kernel.status, JSON.stringify(pair)).toBe("passed");
    });
  }

  it("the pattern message, worded at components › newsletterEmail › patternMessage", async () => {
    const pair = await runBoth(
      intake,
      [
        'test "pattern in fr-CA"',
        '  given locale = "fr-CA"',
        '  set fullName = "Ada"',
        '  set newsletterEmail = "nope"',
        "  check",
        "  expect error on newsletterEmail: pattern",
        '  expect message on newsletterEmail = "Entrez une adresse courriel."'
      ].join("\n")
    );
    expect(pair.kernel.steps, JSON.stringify(pair)).toEqual(pair.browser.steps);
    expect(pair.browser.status, JSON.stringify(pair)).toBe("passed");
    expect(pair.kernel.status, JSON.stringify(pair)).toBe("passed");
  });
});

// A Check answers page: the walk ends at it, it counts as a page of the path, and a
// send refused there stays there on both sides (the runtime's revealErrorPage, the kernel's copy).
const REVIEW_FORM = {
  id: "review-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        { id: "notes", type: "text", configuration: { label: "Notes", required: true } }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "apply",
        pages: [
          { id: "about", components: ["name"] },
          { id: "more", components: ["notes"] },
          { id: "check", kind: "review", title: "Check your answers" }
        ]
      }
    ]
  }
} as unknown as FormDefinition;

describe("a Check answers page: the two drivers agree", () => {
  it("walks to it last, and a send refused there stays there", async () => {
    const pair = await runBoth(
      REVIEW_FORM,
      `test "Refused on the check page"
  set name = "Ada"
  continue
  expect page = more
  continue
  expect page = check
  expect path = (about, more, check)
  expect path ends
  submit
  expect refused
  expect error on notes: required
  expect page = check
  go to more
  expect page = more
  set notes = "Fine"
  continue
  expect page = check
  submit
  expect accepted`
    );
    const message = JSON.stringify(pair);
    expect(differingLines(pair), message).toEqual([]);
    expect(pair.browser.status, message).toBe("passed");
    expect(pair.kernel.status, message).toBe("passed");
  });
});
