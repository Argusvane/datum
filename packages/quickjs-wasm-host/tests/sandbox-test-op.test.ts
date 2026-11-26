import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WASM_ABI_VERSION,
  stableStringify,
  type DefinitionInspectResponse,
  type FormDefinition,
  type WasmPlugin,
  type WasmPluginModule,
  type WasmValidatorInstance
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, buildSandboxProgram, createQuickJsValidationHost, toSourcePlugin } from "../src/index.js";

/**
 * The `test` op through the real sandbox (`__datum_inspect`)
 * against the in-process adapter: a form's tests answer byte-identical canonical JSON over the
 * form-tests fixture (the main form with its journey, data source, layouts and messages in two
 * languages; the clock form), with and without a plugin wired, and the refusals agree too. The
 * engine's own suite (`engine/tests/form-tests/kernel-test-op.test.ts`) holds the op to the kernel
 * driver; this one holds QuickJS to the in-process kernel.
 */

// The engine's form-tests fixture (`engine/tests/form-tests/fixtures/form-tests-fixture.ts`), spelled out for
// this package: its `tsc` holds the tests to this package's root, and the engine exports only `tests/fixtures/*`.
// Keep the two in step; the engine's `kernel-test-op.test.ts` holds the op to the kernel driver over the original.
type FormTestStatus = "passed" | "failed" | "skipped" | "error";

const FORM_TESTS_FIXTURE: FormDefinition = {
  id: "form-tests-fixture",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
  root: {
    id: "form",
    type: "form",
    configuration: { label: "Form tests fixture" },
    children: {
      content: [
        { id: "applicant_name", type: "text", configuration: { label: "Name", required: true } },
        { id: "age", type: "number", configuration: { label: "Age", min: 18, max: 120 } },
        { id: "age_next_year", type: "number", configuration: { label: "Age next year" }, rules: { value: "age + 1" } },
        { id: "wants_details", type: "checkbox", configuration: { label: "Tell us more" } },
        {
          id: "nickname",
          type: "text",
          configuration: { label: "Nickname" },
          rules: { enabledWhen: "wants_details = true", readonlyWhen: 'applicant_name = "Locked"' }
        },
        {
          id: "contact_method",
          type: "select",
          configuration: { label: "How to reach you", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] }
        },
        { id: "email", type: "text", configuration: { label: "Email" }, rules: { requiredWhen: 'contact_method = "email"' } },
        {
          id: "phone",
          type: "text",
          configuration: { label: "Phone" },
          rules: { visibleWhen: 'contact_method = "phone"' }
        },
        {
          id: "confirm_email",
          type: "text",
          configuration: {
            label: "Confirm email",
            messages: { rule: "The two emails must match." }
          },
          rules: { validWhen: "confirm_email = email" }
        },
        { id: "province", type: "select", configuration: { label: "Province", data: { sourceId: "provinces" } } },
        { id: "stop_code", type: "text", configuration: { label: "Code" } },
        {
          id: "topics",
          type: "checkboxes",
          configuration: {
            label: "Topics",
            options: [{ value: "news", label: "News" }, { value: "offers", label: "Offers" }, { value: "events", label: "Events" }]
          }
        },
        { id: "has_pet", type: "checkbox", configuration: { label: "I have a pet" } },
        { id: "pet_name", type: "text", configuration: { label: "Pet name", hiddenValueBehavior: "retain" }, rules: { visibleWhen: "has_pet = true" } },
        {
          id: "items",
          type: "repeatingSection",
          configuration: { label: "Items" },
          collection: { itemFields: ["qty"] },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity" } }] }
        },
        { id: "role_note", type: "text", configuration: { label: "Admin note" }, rules: { visibleWhen: 'host.role = "admin"' } },
        {
          id: "ref_number",
          type: "text",
          configuration: { label: "Reference", messages: { rule: "That reference is not ours." } },
          rules: { validWhen: { formula: 'ref_number != "BAD"', run: "server" } }
        }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "main",
        validation: { continue: "page" },
        pages: [
          { id: "intro", components: ["applicant_name", "age", "age_next_year", "wants_details", "nickname"] },
          {
            id: "contact",
            components: ["contact_method", "email", "phone", "confirm_email", "province", "stop_code"],
            routes: [
              { when: 'stop_code = "STOP"', to: "stop" },
              { when: "not(wants_details = true)", to: "review" }
            ]
          },
          { id: "details", components: ["topics", "has_pet", "pet_name"] },
          { id: "review", components: ["items", "role_note", "ref_number"], routes: [{ to: "$end" }] },
          { id: "stop", kind: "exit", title: "Not eligible", components: [] }
        ]
      }
    ]
  },
  pdf: {
    layouts: [
      {
        id: "standard",
        kind: "generated",
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      },
      {
        id: "pets",
        kind: "generated",
        when: "has_pet = true",
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      }
    ],
    defaultLayoutId: "standard"
  },
  // The French label and rule message: texts are strings, their translations live here.
  translations: {
    fr: {
      components: {
        applicant_name: { label: { text: "Nom", source: "4el6o6" } },
        confirm_email: { messages: { rule: { text: "Les deux courriels doivent correspondre.", source: "1f23inx" } } }
      }
    }
  }
} as unknown as FormDefinition;

/** A form whose rule reads the clock: a scenario on it must name the day (`given today`). */
const FORM_TESTS_CLOCK_FIXTURE: FormDefinition = {
  id: "form-tests-clock",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "event_date",
          type: "date",
          configuration: { label: "Event date", messages: { rule: "The event cannot be in the past." } },
          rules: { validWhen: "event_date >= today()" }
        }
      ]
    }
  }
} as unknown as FormDefinition;

/** Which side a status is expected on: the browser runtime's driver, the validation kernel's. */
interface FormTestsFixtureExpected {
  runtime: FormTestStatus;
  kernel: FormTestStatus;
}

interface FormTestsFixtureScenario {
  name: string;
  /** One `test` block, as a definition's `tests.scenarios[].source` holds it. */
  source: string;
  /** Which fixture form the scenario runs on. */
  form: "main" | "clock";
  expected: FormTestsFixtureExpected;
  /** The scenario's `reason` where a status carries one (a skip's, an error's code). */
  reason?: Partial<Record<keyof FormTestsFixtureExpected, string>>;
}

function block(name: string, lines: string[]): string {
  return [`test "${name}"`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function scenario(
  name: string,
  lines: string[],
  expected: FormTestsFixtureExpected = { runtime: "passed", kernel: "passed" },
  extra: { form?: "main" | "clock"; reason?: FormTestsFixtureScenario["reason"] } = {}
): FormTestsFixtureScenario {
  return {
    name,
    source: block(name, lines),
    form: extra.form ?? "main",
    expected,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {})
  };
}

/** The name of the scenario that fails on purpose (its one step, on line 2, expects the required name optional). */
const FORM_TESTS_FAILING_SCENARIO = "a deliberate failure: the name is not optional";

const FORM_TESTS_FIXTURE_SCENARIOS: FormTestsFixtureScenario[] = [
  scenario("intro holds until a name is given", [
    "expect page = intro",
    "expect applicant_name visible",
    "expect applicant_name required",
    "expect applicant_name enabled",
    "expect applicant_name editable",
    "expect applicant_name empty",
    "continue",
    "expect page = intro",
    "expect error on applicant_name",
    "expect error on applicant_name: required",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "expect applicant_name not empty",
    "continue",
    "expect page = contact",
    "expect no error on applicant_name"
  ]),
  scenario("the age bounds and the calculation", [
    "set applicant_name = \"Ada\"",
    "set age = 15",
    "expect age = 15",
    "expect age != 16",
    "expect age_next_year = 16",
    "expect age_next_year = age + 1",
    "check",
    "expect refused",
    "expect error on age: number.min",
    "set age = 30",
    "check",
    "expect accepted",
    "expect no errors"
  ]),
  scenario("the nickname follows the details box", [
    "expect nickname disabled",
    "set wants_details = true",
    "expect nickname enabled",
    "set applicant_name = \"Locked\"",
    "expect nickname readonly",
    "set applicant_name = \"Ada\"",
    "expect nickname editable"
  ]),
  scenario("email is required when it is the way to reach you", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "expect page = contact",
    "expect email optional",
    "set contact_method = \"email\"",
    "expect email required",
    "continue",
    "expect page = contact",
    "expect error on email: required"
  ]),
  scenario("the confirmation must match the email", [
    "given journey = none",
    "set email = \"a@example.com\"",
    "set confirm_email = \"b@example.com\"",
    "check",
    "expect refused",
    "expect error on confirm_email: rule",
    "expect message on confirm_email = \"The two emails must match.\"",
    "set confirm_email = \"a@example.com\"",
    "check",
    "expect no error on confirm_email"
  ]),
  scenario("the confirmation message in French", [
    "given journey = none",
    "given locale = \"fr\"",
    "set email = \"a@example.com\"",
    "set confirm_email = \"b@example.com\"",
    "check",
    "expect error on confirm_email: rule",
    "expect message on confirm_email = \"Les deux courriels doivent correspondre.\""
  ]),
  scenario("a hidden phone is withheld, a hidden pet name is kept", [
    "given journey = none",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set contact_method = \"phone\"",
    "set phone = \"555-0100\"",
    "expect phone visible",
    "set contact_method = \"email\"",
    "set email = \"a@example.com\"",
    "set confirm_email = \"a@example.com\"",
    "expect phone hidden",
    "set has_pet = false",
    "set pet_name = \"Rex\"",
    "expect pet_name hidden",
    "submit",
    "expect accepted",
    "expect phone withheld",
    "expect submitted pet_name = \"Rex\"",
    "expect submitted applicant_name = \"Ada\""
  ]),
  scenario("STOP routes to the exit page", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "set stop_code = \"STOP\"",
    "continue",
    "expect page = stop",
    "expect path = (intro, contact, stop)",
    "expect path ends at stop",
    "expect review off path"
  ]),
  scenario("the details page is skipped unless asked for", [
    "expect details off path",
    "expect path = (intro, contact, review)",
    "expect path ends",
    "set wants_details = true",
    "expect details on path",
    "expect path = (intro, contact, details, review)"
  ]),
  scenario("an answer on a skipped page is withheld", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set wants_details = true",
    "set has_pet = true",
    "set wants_details = false",
    "submit",
    "expect accepted",
    "expect has_pet withheld"
  ]),
  scenario("Back and a jump move between pages", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "expect page = contact",
    "back",
    "expect page = intro",
    "go to contact",
    "expect page = contact"
  ]),
  scenario("rows are added, answered and removed", [
    "given journey = none",
    "expect rows of items = 0",
    "add row to items with qty = 2",
    "add row to items",
    "expect rows of items = 2",
    "expect items[0].qty = 2",
    "set items[1].qty = 5",
    "expect items[1].qty = 5",
    "remove row 0 of items",
    "expect rows of items = 1",
    "expect items[0].qty = 5"
  ]),
  scenario("the pets layout when there is a pet", [
    "given journey = none",
    "expect layout = standard",
    "set has_pet = true",
    "expect layout = pets"
  ]),
  scenario("topics read through a formula", [
    "given journey = none",
    "expect topics empty",
    "set topics = (\"news\", \"events\")",
    "expect topics not empty",
    "expect count(selected(topics)) = 2",
    "set topics = ()",
    "expect topics empty"
  ]),
  scenario("a province from the given options", [
    "given journey = none",
    "given options for province = (\"ON\", \"QC\")",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set province = \"QC\"",
    "submit",
    "expect accepted",
    "expect submitted province = \"QC\""
  ]),
  scenario("an admin sees the role note", ["given journey = none", "given host.role = \"admin\"", "expect role_note visible"]),
  scenario("anyone else does not see the role note", ["given journey = none", "given host.role = \"user\"", "expect role_note hidden"]),
  scenario("a server-only check is not the browser's to judge", ["given journey = none", "set ref_number = \"BAD\"", "check", "expect error on ref_number: rule"], {
    runtime: "skipped",
    kernel: "passed"
  }, { reason: { runtime: "unreplayable.server" } }),
  scenario(FORM_TESTS_FAILING_SCENARIO, ["expect applicant_name optional"], { runtime: "failed", kernel: "failed" }),
  scenario("a scenario kept for later", ["skip \"waiting on the address rules\"", "expect applicant_name visible"], { runtime: "skipped", kernel: "skipped" }, {
    reason: { runtime: "waiting on the address rules", kernel: "waiting on the address rules" }
  }),
  scenario("a journey the form does not have", ["given journey = elsewhere", "expect applicant_name visible"], { runtime: "error", kernel: "error" }, {
    reason: { runtime: "scenario.unknownJourney", kernel: "scenario.unknownJourney" }
  }),
  scenario(
    "an event must not be in the past",
    [
      "given today = @\"2026-03-01\"",
      "set event_date = @\"2026-02-01\"",
      "check",
      "expect refused",
      "expect error on event_date: rule",
      "set event_date = \"2026-04-01\"",
      "check",
      "expect accepted"
    ],
    { runtime: "passed", kernel: "passed" },
    { form: "clock" }
  ),
  scenario("the clock must be given", ["set event_date = \"2026-04-01\"", "expect event_date visible"], { runtime: "error", kernel: "error" }, {
    form: "clock",
    reason: { runtime: "scenario.clockUnset", kernel: "scenario.clockUnset" }
  })
];

/** The fixture forms with their scenarios embedded under `tests`, as a definition stores them. */
function fixtureWithTests(form: "main" | "clock"): FormDefinition {
  const base = form === "main" ? FORM_TESTS_FIXTURE : FORM_TESTS_CLOCK_FIXTURE;
  const scenarios = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form).map((entry, index) => ({
    id: `${form}-${index + 1}`,
    source: entry.source
  }));
  return { ...base, tests: { scenarios } };
}

interface Pair {
  inProcess: WasmValidatorInstance;
  quickJs: WasmValidatorInstance;
}

/** A plugin of one formula function and one validator, closure-free so it travels as source. */
function probePlugin(): WasmPlugin {
  return {
    id: "probe-plugin",
    version: "1",
    functions: {
      double: function (args: unknown[]): unknown {
        return typeof args[0] === "number" ? args[0] * 2 : null;
      }
    },
    validators: [
      {
        id: "no-bob",
        version: "1",
        validate: function (context: { values?: Record<string, unknown> }) {
          const bob = context.values !== undefined && context.values.name === "Bob";
          return { valid: !bob, errors: bob ? [{ code: "noBob", componentId: "name", path: "name", stage: "custom", severity: "error" }] : [] };
        }
      }
    ]
  } as unknown as WasmPlugin;
}

async function instantiate(plugins: readonly WasmPluginModule[]): Promise<Pair> {
  const abi = new JsonWasmAbi();
  const inProcess = new InProcessWasmHostAdapter().instantiate(plugins, abi);
  // An explicit budget: the default inspect budget (250 ms plus 1 ms per KB) is a request's for a
  // one-shot question, and a suite of 21 scenarios takes about 300 ms in QuickJS.
  const quickJs = await new QuickJsWasmHostAdapter({ maxEvalMs: 30_000 }).instantiate(
    plugins.map((plugin) => ("source" in plugin ? plugin : toSourcePlugin(plugin as WasmPlugin))),
    abi
  );
  return { inProcess, quickJs };
}

function request(definition: FormDefinition, extra: Record<string, unknown> = {}): string {
  return stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition, ...extra });
}

async function both(pair: Pair, serialized: string): Promise<{ text: string; answer: DefinitionInspectResponse }> {
  const fromKernel = await pair.inProcess.inspect!(serialized);
  const fromSandbox = await pair.quickJs.inspect!(serialized);
  expect(fromSandbox).toBe(fromKernel);
  return { text: fromKernel, answer: JSON.parse(fromKernel) as DefinitionInspectResponse };
}

function corpus(form: "main" | "clock"): string {
  return FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form)
    .map((entry) => entry.source)
    .join("\n\n");
}

const pluginForm = {
  id: "plugin-probe",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: {} },
        { id: "n", type: "number", configuration: {} },
        { id: "twice", type: "number", configuration: {}, rules: { value: "double(n)" } }
      ]
    }
  }
} as unknown as FormDefinition;

describe("sandbox test op: QuickJS and the in-process kernel answer the same bytes", () => {
  let bare: Pair;
  let wired: Pair;

  beforeAll(async () => {
    bare = await instantiate([]);
    wired = await instantiate([probePlugin()]);
  });

  afterAll(() => {
    bare.quickJs.dispose?.();
    wired.quickJs.dispose?.();
  });

  it("declares the op's functions in the program, each once", () => {
    const program = buildSandboxProgram();
    for (const name of ["kernelFormTestOp", "kernelFormTestOpScenario", "kernelFormTestServerIndex", "kernelParseFormTests", "kernelFormTestJudge", "kernelFormTestOpMessagesEn"]) {
      expect(program.split(`function ${name}(`).length - 1, name).toBe(1);
    }
  });

  it("the main form's corpus as sidecar text, every status, the same bytes wired or not", async () => {
    const { text, answer } = await both(bare, request(FORM_TESTS_FIXTURE, { tests: corpus("main") }));
    expect(answer).toMatchObject({ ok: true, op: "test" });
    if (!answer.ok || answer.op !== "test") {
      throw new Error("not a test answer");
    }
    expect(answer.report.problems).toEqual([]);
    expect(answer.report.scenarios.map((scenario) => [scenario.name, scenario.status])).toEqual(
      FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main").map((entry) => [entry.name, entry.expected.kernel])
    );
    expect(new Set(answer.report.scenarios.map((scenario) => scenario.status)).size).toBe(4);
    // A plugin no rule calls changes nothing.
    expect((await both(wired, request(FORM_TESTS_FIXTURE, { tests: corpus("main") }))).text).toBe(text);
  });

  it("host givens are the runs' host context: a dotted name nests, a calculation reads it, none given leaves the rules unjudged", async () => {
    const hostForm = {
      id: "host-probe",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "unit_note", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.org.unit = "tax"' } },
            { id: "who", type: "text", configuration: {}, rules: { value: 'coalesce(host.role, "nobody")' } }
          ]
        }
      }
    } as unknown as FormDefinition;
    const tests = [
      'test "given"\n  given host.org.unit = "tax"\n  given host.role = "clerk"\n  expect unit_note visible\n  expect who = "clerk"\n  submit\n  expect refused',
      'test "another key"\n  given host.role = "clerk"\n  expect unit_note hidden\n  submit\n  expect accepted',
      'test "none"\n  expect unit_note hidden\n  submit\n  expect accepted'
    ].join("\n\n");
    const { answer } = await both(bare, request(hostForm, { tests }));
    if (!answer.ok || answer.op !== "test") {
      throw new Error("not a test answer");
    }
    expect(answer.report.scenarios.map((scenario) => [scenario.name, scenario.status, scenario.reason])).toEqual([
      ["given", "passed", undefined],
      ["another key", "passed", undefined],
      ["none", "skipped", "unreplayable.host"]
    ]);
  });

  it("the definition's own entries, the clock given or not", async () => {
    const { answer } = await both(bare, request(fixtureWithTests("clock")));
    if (!answer.ok || answer.op !== "test") {
      throw new Error("not a test answer");
    }
    expect(answer.report.scenarios.map((scenario) => [scenario.id, scenario.status, scenario.reason])).toEqual([
      ["clock-1", "passed", undefined],
      ["clock-2", "error", "scenario.clockUnset"]
    ]);
    await both(bare, request(FORM_TESTS_CLOCK_FIXTURE, { tests: corpus("clock") }));
  });

  it("parse problems and refusals alike: a problem, the caps, an ABI too new", async () => {
    const problem = await both(bare, request(FORM_TESTS_FIXTURE, { tests: 'test "a"\n  frobnicate' }));
    expect(problem.answer).toMatchObject({ ok: true, op: "test", report: { scenarios: [], problems: [{ code: "unknownStatement", line: 2 }] } });
    const notText = await both(bare, request(FORM_TESTS_FIXTURE, { tests: 7 }));
    expect(notText.answer).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const many = Array.from({ length: 201 }, (_, at) => `test "t${at}"\n  expect age visible`).join("\n");
    expect((await both(bare, request(FORM_TESTS_FIXTURE, { tests: many }))).answer).toMatchObject({ ok: false, error: { code: "invalid_request", limit: 200 } });
    const long = 'test "long"\n' + "  expect age visible\n".repeat(1001);
    expect((await both(bare, request(FORM_TESTS_FIXTURE, { tests: long }))).answer).toMatchObject({ ok: false, error: { code: "invalid_request", limit: 1000 } });
    const newer = await both(bare, stableStringify({ abi: "5.0.0", op: "test", definition: FORM_TESTS_FIXTURE }));
    expect(newer.answer).toMatchObject({ ok: false, error: { code: "abi_mismatch" } });
  });

  // The structure size gate `check` runs first (H4b-10): a definition past a cap is refused before any scenario runs.
  it("a definition past a size cap: the same invalid_request at definition, the cap as limit, nothing run", async () => {
    const options = (count: number) => Array.from({ length: count }, (_, at) => ({ value: `o${at}`, label: `O${at}` }));
    const withSelect = (count: number) =>
      ({
        ...pluginForm,
        root: {
          ...pluginForm.root,
          children: { content: [...(pluginForm.root.children?.content ?? []), { id: "s", type: "select", configuration: { options: options(count) } }] }
        }
      }) as unknown as FormDefinition;
    const tests = ['test "plugin"', "  set n = 4", "  expect twice = 8", '  set name = "Bob"', "  submit", "  expect refused"].join("\n");
    const over = await both(wired, request(withSelect(2001), { tests }));
    expect(over.answer).toMatchObject({ ok: false, error: { code: "invalid_request", where: "definition", limit: 2000 } });
    expect((over.answer as { error: { message: string } }).error.message).toContain("option.tooMany");
    expect(over.text).not.toContain('"report"');
    const many = Array.from({ length: 10_001 }, (_, at) => ({ id: `f${at}`, type: "text", configuration: {} }));
    const crowded = { ...pluginForm, root: { ...pluginForm.root, children: { content: many } }, tests: { scenarios: [{ id: "a", source: tests }] } } as unknown as FormDefinition;
    expect((await both(wired, request(crowded))).answer).toMatchObject({ ok: false, error: { code: "invalid_request", where: "definition", limit: 10_000 } });
    // At the cap the suite runs, and the plugin reaches it.
    expect((await both(wired, request(withSelect(2000), { tests }))).answer).toMatchObject({ ok: true, op: "test", report: { summary: { passed: 1 } } });
  });

  it("is deterministic: the same request twice, the same bytes", async () => {
    const serialized = request(fixtureWithTests("main"));
    const first = await both(bare, serialized);
    expect((await both(bare, serialized)).text).toBe(first.text);
  });

  // `__datum_inspect` hands the op `__datum_functions` and `__datum_validators` as a run gets them.
  it("a plugin's function and validator reach the op, as a run gets them", async () => {
    const tests = ['test "plugin"', "  set n = 4", "  expect twice = 8", '  set name = "Bob"', "  submit", "  expect refused", "  expect error on name: noBob"].join("\n");
    const { answer } = await both(wired, request(pluginForm, { tests }));
    expect(answer).toMatchObject({ ok: true, op: "test", report: { summary: { passed: 1 } } });
  });

  it("runs under the host's limits: the default memory, stack and budget answer a short suite through WasmValidationHost.inspect", async () => {
    const host = await createQuickJsValidationHost();
    try {
      const short = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === "main")
        .slice(0, 3)
        .map((entry) => entry.source)
        .join("\n\n");
      const answer = await host.inspect({ op: "test", definition: FORM_TESTS_FIXTURE, tests: short });
      expect(answer).toMatchObject({ ok: true, op: "test", report: { summary: { total: 3, passed: 3 } } });
    } finally {
      host.dispose();
    }
  });

  it("gives a test request the cap by default: the whole corpus passes with no maxEvalMs set", async () => {
    // 21 scenarios take 260 to 300 ms in QuickJS, past the 250 ms plus 1 ms per KB an inspect gets otherwise.
    const host = await createQuickJsValidationHost();
    try {
      const answer = await host.inspect({ op: "test", definition: FORM_TESTS_FIXTURE, tests: corpus("main") });
      expect(answer).toMatchObject({ ok: true, op: "test", report: { summary: { total: 21 } } });
    } finally {
      host.dispose();
    }
  });

  it("runs the whole corpus within the adapter's scaled cap (5,000 ms) and the default memory limit", async () => {
    const adapter = new QuickJsWasmHostAdapter({ maxEvalMs: 5_000 });
    const instance = await adapter.instantiate([], new JsonWasmAbi());
    try {
      const answer = JSON.parse(await instance.inspect!(request(FORM_TESTS_FIXTURE, { tests: corpus("main") }))) as DefinitionInspectResponse;
      expect(answer).toMatchObject({ ok: true, op: "test", report: { summary: { total: 21 } } });
    } finally {
      instance.dispose?.();
    }
  });
});

describe("sandbox test op and run: the built program words messages from the definition's map", () => {
  // The engine's canonical translations fixture, read from the engine's tests (the package exports only its .ts fixtures).
  const intake = JSON.parse(readFileSync(new URL("../../../engine/tests/fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;
  let pair: Pair;

  beforeAll(async () => {
    pair = await instantiate([]);
  });

  afterAll(() => {
    pair.quickJs.dispose?.();
  });

  it("carries the resolver and its own isSafeSegment copy, each once", () => {
    const program = buildSandboxProgram();
    for (const name of ["kernelResolveText", "kernelIsSafeSegment", "kernelTranslationLocaleKey", "kernelTranslationText", "kernelFormTestOpCatalogsFor"]) {
      expect(program.split(`function ${name}(`).length - 1, name).toBe(1);
    }
  });

  it("the test op words the engine's own message from the definition's `texts` translations, else the English", async () => {
    const engineWorded = {
      id: "engine-worded",
      version: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
      root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "age", type: "number", configuration: { label: "Age", min: 18 } }] } },
      translations: { fr: { texts: { messages: { "number.min": { text: "Au moins {min}", source: "x" } } } } }
    } as unknown as FormDefinition;
    for (const [locale, expected] of [
      ["fr", "Au moins 18"],
      ["en", "Enter a number of 18 or more"]
    ] as const) {
      const tests = `test "min in ${locale}"\n  given locale = "${locale}"\n  set age = 3\n  check\n  expect error on age: number.min\n  expect message on age = "${expected}"`;
      const { answer } = await both(pair, request(engineWorded, { tests }));
      if (!answer.ok || answer.op !== "test") {
        throw new Error("not a test answer");
      }
      expect(answer.report.scenarios.map((scenario) => [scenario.name, scenario.status]), locale).toEqual([[`min in ${locale}`, "passed"]]);
    }
  });

  it("the test op words required on fullName in en, fr-CA and es (es falling back to the default)", async () => {
    for (const [locale, expected] of [
      ["en", "Enter your full name."],
      ["fr-CA", "Entrez votre nom complet."],
      ["es", "Enter your full name."]
    ] as const) {
      const tests = `test "required in ${locale}"\n  given locale = "${locale}"\n  check\n  expect error on fullName: required\n  expect message on fullName = "${expected}"`;
      const { answer } = await both(pair, request(intake, { tests }));
      if (!answer.ok || answer.op !== "test") {
        throw new Error("not a test answer");
      }
      expect(answer.report.scenarios.map((scenario) => [scenario.name, scenario.status]), locale).toEqual([[`required in ${locale}`, "passed"]]);
    }
  });

  it("a run words a failed pattern's message from the translations its context carries, the same bytes as the kernel", async () => {
    const abi = new JsonWasmAbi();
    const messageIn = async (locale: string): Promise<unknown> => {
      const context = abi.serializeContext(
        { formId: intake.id, form: intake.root, values: { fullName: "Ada", newsletterEmail: "nope" }, locale, ...(intake.translations !== undefined ? { translations: intake.translations } : {}) },
        { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false }
      );
      const fromKernel = await pair.inProcess.run(context);
      const fromSandbox = await pair.quickJs.run(context);
      expect(fromSandbox).toBe(fromKernel);
      const outcome = JSON.parse(fromSandbox) as { errors: Array<{ code: string; parameters?: { message?: unknown } }> };
      return outcome.errors.find((error) => error.code === "pattern")?.parameters?.message;
    };
    expect(await messageIn("fr-CA")).toBe("Entrez une adresse courriel.");
    expect(await messageIn("es")).toBe("Enter an email address.");
    expect(await messageIn("en")).toBe("Enter an email address.");
  });
});
